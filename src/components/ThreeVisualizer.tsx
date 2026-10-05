import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePlayer } from '@/contexts/PlayerContext';
import { toast } from 'sonner';
import { logger, scopedStorage } from '@lark-apaas/client-toolkit-lite';
import { getDiagnosticService } from '@/lib/diagnosticService';
import {
   checkWebGLSupport,
   loadThree,
   getPerformanceTier,
   getParticleCountForTier,
   type Visualizer3DMode,
 } from '@/lib/visualizerManager';
 import { getCoverUrl } from '@/lib/netease';
import { getBeatState } from '@/lib/beatBus';
import { createCover3DShader } from '@/lib/mrCoverParticles';
import { createSonicTopographyMR, DEFAULT_SONIC_MR_PARAMS } from '@/lib/sonicTopographyMR';
import {
  ensureSonicDebugLayer,
  stageStart,
  setStageDone,
  setStageFailed,
  setExtra,
  reportError,
} from '@/lib/sonicDebugLayer';

 interface Props {
   mode: Visualizer3DMode;
   primaryColor: string;
   secondaryColor: string;
   sensitivity: number;
   /** 封面模式粒子数（清晰度），仅 cover3d 生效 */
   coverParticleCount?: number;
   /** 封面亮度（0.3-2） */
   coverBrightness?: number;
   /** 封面粒子大小倍率（0.5-3） */
   coverParticleSize?: number;
   /** 封面粒子密度倍率（0.3-1.5） */
   coverDensity?: number;
    /** 封面粒子不透明度（0.3-1） */
    coverOpacity?: number;
     /** 封面粒子扭曲强度（0-3） */
    coverTwist?: number;
    /** 封面粒子散布强度（0-3） */
    coverScatter?: number;
    /** 封面动画速度倍率（0.3-2） */
    coverSpeed?: number;
    /** 封面颜色饱和度增强（0.5-2.5） */
    coverColorBoost?: number;
    /** 封面边缘提亮开关 */
    coverEdgeEnabled?: boolean;
    /** 封面粒子预设（0=SILK 等） */
    coverPreset?: number;
    /** 封面律动强度 */
    coverIntensity?: number;
    /** 封面深度强度 */
    coverDepth?: number;
    /** 封面 bloom 发光强度 */
    coverBloomStrength?: number;
    /** 背景星河开关 */
    coverStarRiver?: boolean;
    /** 背景淡出强度 */
    coverBgFade?: number;
    /** 音域回响（燃料棒）参数 */
    sonicSettings?: {
      amplitude: number;
      motionSpeed: number;
      density: number;
      range: number;
      lower: number;
      depth: number;
      autoRotate: number;
      glow: number;
      colorMode: string;
      baseColor: string;
      coolColor: string;
      warmColor: string;
      accentColor: string;
      floatingEnabled: boolean;
      floatingIntensity: number;
      floatingMinSize: number;
      floatingMaxSize: number;
      floatingSpeed: number;
      floatingCount: number;
      eq: [number, number, number, number, number, number, number, number];
    };
    /** 歌词行数组 */
    lyricLines?: { time: number; text: string; translation?: string }[];
    /** 当前歌词句索引 */
    currentLyricIndex?: number;
    /** 歌词涟漪效果开关 */
    lyricRippleEnabled?: boolean;
    /** 歌词涟漪强度 0-2 */
    lyricRippleIntensity?: number;
    /** 歌词涟漪颜色模式 */
    lyricRippleColorMode?: 'accent' | 'lyric' | 'warm';
    /** 歌词高亮色（用于涟漪颜色） */
    lyricColor?: string;
    onFallback?: (reason?: string, detail?: string) => void; // 降级到 2D 的回调
    onReady?: () => void; // 内部初始化完成（成功或失败都触发），用于外层关闭 loading 遮罩
  }

/**
 * 3D 可视化组件 —— 纯 three.js 命令式实现
 * - 动态懒加载 three.js（不进首屏 bundle）
 * - 每帧 try/catch 包住，连续报错自动降级
 * - Bloom 后处理失败时退化为加色混合发光粒子
 * - 正确释放 WebGL 资源
 * - 支持专辑封面粒子（cover3d）模式
 */
export default function ThreeVisualizer({ mode, primaryColor, secondaryColor, sensitivity, coverParticleCount, coverBrightness, coverParticleSize, coverDensity, coverOpacity, coverTwist, coverScatter, coverSpeed, coverColorBoost, coverEdgeEnabled, coverPreset, coverIntensity, coverDepth, coverBloomStrength, coverStarRiver, coverBgFade, sonicSettings, lyricLines, currentLyricIndex, lyricRippleEnabled, lyricRippleIntensity, lyricRippleColorMode, lyricColor, onFallback, onReady }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
   const [loading, setLoading] = useState(true);
   const [loadError, setLoadError] = useState(false);
   const [coverErr, setCoverErr] = useState<string>('');
   const sceneRef = useRef<any>(null); // three 相关对象用 any，避免静态 import 进 bundle
   const rafRef = useRef<number>(0);
   const errorCountRef = useRef(0);
   const hasFallbackRef = useRef(false);
   const sonicDebugRef = useRef<(() => any) | null>(null); // 调试数据获取函数
   const [sonicDebugText, setSonicDebugText] = useState<string>('');
   const [showSonicDebug, setShowSonicDebug] = useState(false);
   const { getFrequencyData, isPlaying, currentTrack } = usePlayer();

   // 检测 URL ?debug=sonic 或存储中 sonicDebug=1，开启屏幕内调试层
   const [searchParams] = useSearchParams();
   useEffect(() => {
     const fromUrl = searchParams.get('debug') === 'sonic';
     let fromStorage = false;
     try { fromStorage = scopedStorage.getItem('sonicDebug') === '1'; } catch { /* ignore */ }
     setShowSonicDebug(fromUrl || fromStorage);
   }, [searchParams, mode]);

   // 当前歌曲的封面 URL（统一来源，与左下角缩略图完全一致）
   const currentCoverUrl = getCoverUrl(currentTrack);

   // 封面粒子专用：封面 URL 变化时重建粒子系统
   const coverUrlRef = useRef<string>('');
   const coverLoadedRef = useRef<boolean>(false); // 封面是否已尝试加载过（用于场景就绪后的补加载）

  useEffect(() => {
    let disposed = false;
    const container = containerRef.current;
    if (!container) return;

    // 调试层：sonic 模式下最早时机创建（DOM 直接挂 body，不依赖 React/Three）
    if (mode === 'sonic') {
      try { ensureSonicDebugLayer(); } catch { /* ignore */ }
      stageStart('loadThree');
    }

    // 1. WebGL 能力检测
    if (!checkWebGLSupport()) {
      logger.warn('WebGL not supported, falling back to 2D');
      if (mode === 'sonic') {
        try {
          setStageFailed('createRenderer', new Error('WebGL not supported - checkWebGLSupport returned false'));
        } catch { /* ignore */ }
      }
      try {
        const diag = getDiagnosticService();
        diag.setField('webgl', 'unsupported');
        diag.addLog('error', 'webgl', 'WebGL 不可用');
      } catch { /* ignore */ }
     setLoadError(true);
        setLoading(false);
        onReady?.();
        toast.info('设备不支持 WebGL，已切换为 2D 可视化');
        onFallback?.('WebGL 不可用', '浏览器或设备不支持 WebGL 上下文');
        return;
     }

     // WebGL 可用 → 写入诊断
     try {
       const diag = getDiagnosticService();
       diag.setField('webgl', 'available');
     } catch { /* ignore */ }

     // 2. 动态 import three
    let three: any = null;
    let bloomPass: any = null;
    let effectComposer: any = null;
    let renderScene: any = null;

    loadThree()
      .then(async (THREE) => {
        if (disposed) return null;
        three = THREE;
        if (mode === 'sonic') setStageDone('loadThree', `rev=${THREE.REVISION ?? '?'}`);
          let sceneObj: any = null;
          try {
            sceneObj = await initScene(THREE, container, mode, primaryColor, secondaryColor, currentTrack, currentCoverUrl, coverParticleCount, coverDensity, sonicSettings);
          } catch (initErr: any) {
            setCoverErr(String(initErr));
            throw initErr;
          }
          if (disposed || !sceneObj) return null;
          // cover3d 模式：场景就绪后立即、同步发起一次封面加载
          if (mode === 'cover3d' && typeof sceneObj.rebuildCover === 'function') {
            const coverUrl = currentCoverUrl || '';
            try {
              sceneObj.rebuildCover(coverUrl, currentTrack);
              coverLoadedRef.current = true;
              coverUrlRef.current = coverUrl;
            } catch (syncErr: any) {
              setCoverErr(String(syncErr));
            }
          }
         return { THREE, sceneObj };
      })
       .then(async (result) => {
        if (disposed || !result) return null;
        const { THREE, sceneObj } = result;
        sceneRef.current = sceneObj;
        renderScene = sceneObj;
        setLoading(false);
        onReady?.();

        // Bloom 后处理：默认关闭（对齐 MR 原版，只用 Additive 混合发光层，避免过曝发白）
        // 如需增强发光，调节 coverBloomStrength 滑块控制 Additive 层强度即可
        sceneObj.hasBloom = false;

         // 尝试加载 OrbitControls
         try {
           const controlsMod = await import('three/examples/jsm/controls/OrbitControls.js');
           const { OrbitControls } = controlsMod;
           const controls = new OrbitControls(sceneObj.camera, container);
           controls.enableDamping = true;
           controls.dampingFactor = 0.05;
           controls.enableZoom = false;
           controls.autoRotate = mode !== 'cover3d';
           controls.autoRotateSpeed = 0.3;
           // 统一保存到 sceneObj，dispose 时统一释放
           sceneObj.controls = controls;
           // 封面模式下允许用户旋转查看
           if (mode === 'cover3d') {
             controls.enableZoom = true;
             controls.minDistance = 3;
             controls.maxDistance = 15;
             controls.enablePan = false;     // 禁止平移，只围绕封面旋转
             controls.rotateSpeed = 0.8;     // 触屏/鼠标旋转灵敏度
             controls.dampingFactor = 0.08;  // 更强的阻尼惯性，松手顺滑收尾
             // 双击画面 → 视角平滑回到正前方、默认距离
             const onDoubleClick = () => {
               // 取消上一个回正动画，防止快速双击叠加
               if ((sceneObj as any)._resetRafId) {
                 cancelAnimationFrame((sceneObj as any)._resetRafId);
                 (sceneObj as any)._resetRafId = 0;
               }
               // 用动画平滑回正
               const cam = sceneObj.camera;
               const startPos = cam.position.clone();
               const startTarget = controls.target.clone();
               const endPos = new THREE.Vector3(0, 0, 8);
               const endTarget = new THREE.Vector3(0, 0, 0);
               const duration = 400; // ms
               const startTime = performance.now();
               const animateReset = () => {
                 const t = Math.min(1, (performance.now() - startTime) / duration);
                 // easeOutCubic
                 const e = 1 - Math.pow(1 - t, 3);
                 cam.position.lerpVectors(startPos, endPos, e);
                 controls.target.lerpVectors(startTarget, endTarget, e);
                 controls.update();
                 if (t < 1) {
                   (sceneObj as any)._resetRafId = requestAnimationFrame(animateReset);
                 } else {
                   (sceneObj as any)._resetRafId = 0;
                 }
               };
               (sceneObj as any)._resetRafId = requestAnimationFrame(animateReset);
             };
             container.addEventListener('dblclick', onDoubleClick);
             // 保存解绑函数，卸载时清理
             (sceneObj as any)._cleanupControls = () => {
               container.removeEventListener('dblclick', onDoubleClick);
               if ((sceneObj as any)._resetRafId) {
                 cancelAnimationFrame((sceneObj as any)._resetRafId);
                 (sceneObj as any)._resetRafId = 0;
               }
             };
           }
           // sonic 模式：将 controls.target 设为地形包围盒中心，确保 autoRotate 绕地形中心旋转
           if (mode === 'sonic') {
             try {
               const root = sceneObj.particleSystem;
               if (root) {
                 root.updateMatrixWorld(true);
                 const box = new THREE.Box3();
                 const tmpVec = new THREE.Vector3();
                 const m = new THREE.Matrix4();
                 const worldM = new THREE.Matrix4();
                 const geoBox = new THREE.Box3();
                 root.traverse((obj: any) => {
                   if (!obj.visible) return;
                   if (obj.isInstancedMesh) {
                     const geo = obj.geometry;
                     if (!geo) return;
                     if (!geo.boundingBox) geo.computeBoundingBox();
                     if (!geo.boundingBox) return;
                     for (let i = 0; i < obj.count; i++) {
                       obj.getMatrixAt(i, m);
                       worldM.multiplyMatrices(obj.matrixWorld, m);
                       geoBox.copy(geo.boundingBox);
                       geoBox.applyMatrix4(worldM);
                       box.union(geoBox);
                     }
                   } else if (obj.isMesh && obj.geometry) {
                     const geo = obj.geometry;
                     if (!geo.boundingBox) geo.computeBoundingBox();
                     if (geo.boundingBox) {
                       const bb = geo.boundingBox.clone();
                       bb.applyMatrix4(obj.matrixWorld);
                       box.union(bb);
                     }
                   }
                 });
                 if (!box.isEmpty()) {
                   const center = box.getCenter(new THREE.Vector3());
                   controls.target.copy(center);
                   controls.update();
                 }
               }
             } catch (ce) {
               logger.warn('[Sonic] Failed to set controls.target:', String(ce));
             }
             controls.enablePan = false;
             controls.enableZoom = false;
           }

           sceneObj.controls = controls;
           } catch (e) {
             logger.warn('OrbitControls load failed:', String(e));
             sceneObj.controls = null;
           }

        // 3. 启动渲染循环
        let lastTime = performance.now();
        let simulatedTime = 0;
        const simulatedFreq = new Uint8Array(64);
        // 渲染健康状态
        let renderFrameCount = 0;
        let shaderCheckBypassFrames = 0;
        let renderFpsTimestamps: number[] = [];
        let renderStallFrames = 0;
        let lastRenderSuccessTime = 0;

        // WebGL context lost 处理：丢失时暂停渲染并释放，恢复时尝试重建
        const canvasEl = sceneObj.renderer?.domElement;
        if (canvasEl) {
          const onContextLost = (ev: Event) => {
            ev.preventDefault();
            // 主动释放上下文（dispose 流程）不触发降级
            if (disposed) return;
            logger.warn('WebGL context lost');
            try {
              const diag = getDiagnosticService();
              diag.setFields({
                renderContextState: 'lost',
                renderLastError: 'WebGL context lost',
              });
              diag.addLog('warn', 'webgl', 'WebGL 上下文丢失，立即降级到 2D');
            } catch { /* ignore */ }
            // 暂停 RAF 渲染
            if (rafRef.current) {
              cancelAnimationFrame(rafRef.current);
              rafRef.current = 0;
            }
            // 立即降级到 2D，避免页面黑屏卡死（多数浏览器 WebGL 丢失后不会恢复）
            if (!hasFallbackRef.current) {
              hasFallbackRef.current = true;
              toast.error('WebGL 上下文丢失，已切换为 2D 可视化');
              onFallback?.('context lost', 'WebGL 上下文丢失');
            }
          };
          const onContextRestored = () => {
            if (disposed) return;
            logger.info('WebGL context restored');
            try {
              const diag = getDiagnosticService();
              diag.setField('renderContextState', 'ok');
              diag.addLog('info', 'webgl', 'WebGL 上下文已恢复');
            } catch { /* ignore */ }
          };
          canvasEl.addEventListener('webglcontextlost', onContextLost);
          canvasEl.addEventListener('webglcontextrestored', onContextRestored);
          sceneObj._onContextLost = onContextLost;
          sceneObj._onContextRestored = onContextRestored;
          sceneObj._contextCanvas = canvasEl;
        }

        const animate = (time: number) => {
          if (disposed) return;
          rafRef.current = requestAnimationFrame(animate);

          try {
            const delta = Math.min((time - lastTime) / 1000, 0.1);
            lastTime = time;
            simulatedTime += delta;

            // 获取频谱或模拟
            let freq = getFrequencyData();
            let isSimulated = false;
            if (!freq || freq.length === 0 || !isPlaying) {
              isSimulated = true;
              if (mode === 'sonic') {
                // 音域回响模式：暂停/未播放时传空频谱，让柱子平滑回落
                // 自转仍在 update 内持续运行，画面不会死
                if (!freq || freq.length === 0) {
                  freq = new Uint8Array(64);
                } else {
                  freq.fill(0);
                }
              } else {
                // 其他模式：用模拟假数据做占位动画
                for (let i = 0; i < simulatedFreq.length; i++) {
                  const base = Math.sin(simulatedTime * 2 + i * 0.3) * 20 + 30;
                  const noise = Math.sin(simulatedTime * 5 + i * 0.7) * 10;
                  const decay = Math.exp(-i / simulatedFreq.length * 2);
                  simulatedFreq[i] = Math.max(0, Math.min(255, (base + noise) * decay));
                }
                freq = simulatedFreq;
              }
            }

            const sens = 0.5 + sensitivity / 100;

            // ========== 频谱数据诊断（sonic 模式每 60 帧输出一次）==========
            // 确认：数据从 getFrequencyData() 拿到 → 传入 renderScene.update → 到达 sonicTopography
            if (mode === 'sonic' && renderFrameCount % 60 === 0) {
              const freqLen = freq.length;
              let maxVal = 0;
              let sum = 0;
              let nonZeroBins = 0;
              for (let i = 0; i < freqLen; i++) {
                const v = freq[i] || 0;
                if (v > maxVal) maxVal = v;
                sum += v;
                if (v > 5) nonZeroBins++;
              }
              const avg = freqLen > 0 ? sum / freqLen : 0;
              // 8 频段粗分（与 sonicTopography 对应），方便定位问题频段
              const bandEdges = [
                0,
                Math.max(1, Math.floor(freqLen * 0.04)),
                Math.max(2, Math.floor(freqLen * 0.10)),
                Math.max(3, Math.floor(freqLen * 0.20)),
                Math.max(4, Math.floor(freqLen * 0.35)),
                Math.max(5, Math.floor(freqLen * 0.55)),
                Math.max(6, Math.floor(freqLen * 0.75)),
                Math.max(7, Math.floor(freqLen * 0.90)),
                freqLen,
              ];
              const bandAvgs: number[] = [];
              for (let b = 0; b < 8; b++) {
                const s = bandEdges[b];
                const e = bandEdges[b + 1];
                let bs = 0;
                let bc = 0;
                for (let i = s; i < e && i < freqLen; i++) {
                  bs += freq[i] || 0;
                  bc++;
                }
                bandAvgs.push(bc > 0 ? Math.round(bs / bc) : 0);
              }
              // 估算柱高范围（对应 sonicTopography 的 bandH 公式近似值）
              const amp = sonicSettings?.amplitude ?? 50;
              const ampBase = 0.5 + (amp / 100) * 8;
              const lowBandVal = bandAvgs[0] / 255 * sens * 1.4 * 1.0; // band0 近似
              const midBandVal = bandAvgs[3] / 255 * sens * 1.12 * 1.15; // band3 近似
              const highBandVal = bandAvgs[7] / 255 * sens * 0.9 * 1.35; // band7 近似
              const lowH = Math.round(lowBandVal * ampBase * 100) / 100;
              const midH = Math.round(midBandVal * ampBase * 100) / 100;
              const highH = Math.round(highBandVal * ampBase * 100) / 100;
              logger.info(
                `[Sonic] freq len=${freqLen} sim=${isSimulated} playing=${isPlaying} | max=${Math.round(maxVal)} avg=${Math.round(avg)} nonZero=${nonZeroBins} | 8-band=[${bandAvgs.join(',')}] | estHeights low=${lowH} mid=${midH} high=${highH} ampBase=${ampBase.toFixed(1)} sens=${sens.toFixed(2)}`,
              );
            }

            // 更新场景
            if (renderScene && renderScene.update) {
              renderScene.update(freq, delta, sens, isSimulated);
            }

            // 控制器更新
            if (sceneObj.controls) {
              sceneObj.controls.update();
            }

            // 渲染
            if (effectComposer && sceneObj.hasBloom) {
              effectComposer.render();
            } else if (sceneObj.renderer) {
              sceneObj.renderer.render(sceneObj.scene, sceneObj.camera);
            }

             // 重置错误计数
             if (errorCountRef.current > 0) {
               errorCountRef.current = Math.max(0, errorCountRef.current - 0.1);
             }

             // 渲染成功：更新健康指标
             renderFrameCount += 1;
             lastRenderSuccessTime = time;
             renderStallFrames = 0;
             renderFpsTimestamps.push(time);
             while (renderFpsTimestamps.length > 0 && time - renderFpsTimestamps[0] > 1000) {
               renderFpsTimestamps.shift();
             }
               // sonic 模式：首帧标记
               if (mode === 'sonic' && renderFrameCount === 1) {
                 try { setStageDone('firstFrame', `${time.toFixed(0)}ms`); } catch { /* ignore */ }
                 // 重置涟漪失败兜底标志（每次进入 sonic 都是全新实例，之前的失效状态不应该继承）
                 try { delete (window as any).__sonicRippleDisabled; } catch { /* ignore */ }
               }
              if (mode === 'sonic' && renderFrameCount === 2) {
                try { stageStart('everyFrame'); setStageDone('everyFrame', 'running'); } catch { /* ignore */ }
              }

              // ===== sonic 黑屏自愈机制 =====
              // 第 3/8/20 帧用 readPixels 检测画面亮度，过低则分级自愈
              if (mode === 'sonic' && sceneObj.renderer && sceneObj.camera && sceneObj.scene) {
                const checkFrames = [3, 8, 20];
                if (checkFrames.includes(renderFrameCount)) {
                  try {
                     // 先检查 shader 编译状态
                     try {
                       const rdr = sceneObj.renderer;
                       const info = rdr.info;
                       const progCount = info?.memory?.programs ?? 0;
                       const dbg = (window as any).__sonicDebugExtra || ((window as any).__sonicDebugExtra = {});
                       dbg.shaderStatus = `programs=${progCount}, calls=${info?.render?.calls ?? 0}, triangles=${info?.render?.triangles ?? 0}`;
                        // 检查地形材质是否有 program —— ShaderMaterial 编译失败时 Three.js 静默跳过（不抛异常）
                        const root = sceneObj.particleSystem;
                        if (root && root.traverse) {
                          // 涟漪关闭后的几帧内跳过失败检测（新材质需要时间编译）
                          if (shaderCheckBypassFrames > 0) {
                            shaderCheckBypassFrames--;
                          } else {
                         let shaderMats = 0, progMats = 0;
                         let failedMats: string[] = [];
                         root.traverse((o: any) => {
                           if (o.material && o.material.type === 'ShaderMaterial') {
                             shaderMats++;
                             if (o.material.program) {
                               progMats++;
                             } else {
                               // 尝试获取编译错误信息
                               const mat = o.material;
                               const prog = mat.__maxAnisotropy ? null : null; // noop
                               const gl = rdr.getContext?.() || rdr.__gl || null;
                               let errInfo = '';
                               if (gl && mat.vertexShader && mat.fragmentShader) {
                                 // 用 WebGL 直接验证编译结果
                                 try {
                                   const vShader = gl.createShader(gl.VERTEX_SHADER);
                                   if (vShader) {
                                     gl.shaderSource(vShader, mat.vertexShader);
                                     gl.compileShader(vShader);
                                     if (!gl.getShaderParameter(vShader, gl.COMPILE_STATUS)) {
                                       const log = gl.getShaderInfoLog(vShader) || '';
                                       errInfo += `VS: ${log.substring(0, 200)} `;
                                     }
                                     gl.deleteShader(vShader);
                                   }
                                   const fShader = gl.createShader(gl.FRAGMENT_SHADER);
                                   if (fShader) {
                                     gl.shaderSource(fShader, mat.fragmentShader);
                                     gl.compileShader(fShader);
                                     if (!gl.getShaderParameter(fShader, gl.COMPILE_STATUS)) {
                                       const log = gl.getShaderInfoLog(fShader) || '';
                                       errInfo += `FS: ${log.substring(0, 200)}`;
                                     }
                                     gl.deleteShader(fShader);
                                   }
                                 } catch (_e) { /* ignore */ }
                               }
                               failedMats.push(`${o.name || o.type}${errInfo ? ': ' + errInfo : ''}`);
                             }
                           }
                         });
                         dbg.shaderStatus += ` (shaderMats=${shaderMats}, withProgram=${progMats})`;
                         // ShaderMaterial 编译失败检测：第3帧了还是没有 program，说明 shader 编译挂了
                          if (renderFrameCount >= 3 && shaderMats > 0 && progMats === 0) {
                            const errMsg = failedMats.length > 0
                              ? `Shader 编译失败：${failedMats.join('; ')}`
                              : 'Shader 编译失败：所有 ShaderMaterial 均无 program';
                            logger.error('[Sonic] Shader compile failure detected:', errMsg);
                            reportError('shaderCompile', new Error(errMsg));
                            setStageFailed('shaderCompile', new Error(errMsg));
                            // 立即触发自愈第3级（保底相机）并标记 shader 失败
                            const dbg2 = (window as any).__sonicDebugExtra || ((window as any).__sonicDebugExtra = {});
                            dbg2.recoveryStage = 90;
                             dbg2.recoveryAction = 'SHADER COMPILE FAILED — check debug log';
                             // === 歌词涟漪 shader 失败兜底 ===
                             // 涟漪 shader 是附加特效，先尝试关闭涟漪再观察几帧；地形 shader 本身没问题的话应该能恢复
                             // 避免整个 sonic 模式因为涟漪出错就被降级
                             const rippleDisabled = (window as any).__sonicRippleDisabled;
                             if (!rippleDisabled && typeof root.setLyricRippleEnabled === 'function') {
                               try {
                                 root.setLyricRippleEnabled(false);
                                 logger.info('[Sonic] Shader compile error — attempting ripple disable fallback');
                                 dbg2.rippleFallback = true;
                                 (window as any).__sonicRippleDisabled = true;
                                 // 重置帧计数，给 5 帧观察是否恢复再决定是否降级
                                 shaderCheckBypassFrames = 5;
                                 errorCountRef.current = Math.max(0, errorCountRef.current - 5);
                               } catch (_e) { /* ignore */ }
                             } else {
                               // 涟漪已经关了或没有涟漪函数，还是失败 → 真正降级
                               if (typeof onFallback === 'function') {
                                 try {
                                   onFallback('shaderCompile', errMsg);
                                 } catch (_e) { /* ignore */ }
                               }
                             }
                              // ===============================
                           }
                          } // end bypassFrames else
                        }
                     } catch (se) {
                       const dbg = (window as any).__sonicDebugExtra || ((window as any).__sonicDebugExtra = {});
                       dbg.shaderStatus = `check error: ${String(se)}`;
                     }

                    const rdr = sceneObj.renderer;
                    const gl = rdr.getContext?.() || rdr.__gl || null;
                    if (gl && typeof gl.readPixels === 'function') {
                      const pw = Math.min(rdr.domElement.width, 64);
                      const ph = Math.min(rdr.domElement.height, 64);
                      const px = Math.floor((rdr.domElement.width - pw) / 2);
                      const py = Math.floor((rdr.domElement.height - ph) / 2);
                      const pixels = new Uint8Array(pw * ph * 4);
                      gl.readPixels(px, py, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                      let sum = 0, nonZero = 0;
                      for (let i = 0; i < pixels.length; i += 4) {
                        const l = 0.299 * pixels[i] + 0.587 * pixels[i+1] + 0.114 * pixels[i+2];
                        sum += l;
                        if (l > 2) nonZero++;
                      }
                      const totalPx = pw * ph;
                      const avgBrightness = sum / totalPx; // 0-255
                      const nonBlackRatio = nonZero / totalPx;

                      // 记录到调试层
                      try {
                        const dbg = (window as any).__sonicDebugExtra || ((window as any).__sonicDebugExtra = {});
                        dbg.frameBrightness = avgBrightness.toFixed(1);
                        dbg.nonBlackRatio = (nonBlackRatio * 100).toFixed(1) + '%';
                        dbg.recoveryStage = dbg.recoveryStage || 0;
                      } catch { /* ignore */ }

                      // 判定黑屏：平均亮度 < 3 且非黑像素 < 5%
                      if (avgBrightness < 3 && nonBlackRatio < 0.05) {
                        logger.warn(`[Sonic] Black screen detected at frame ${renderFrameCount}: brightness=${avgBrightness.toFixed(1)}, nonBlack=${(nonBlackRatio*100).toFixed(1)}%`);

                        // 分级自愈
                        const dbg = (window as any).__sonicDebugExtra || ((window as any).__sonicDebugExtra = {});
                        dbg.recoveryStage = (dbg.recoveryStage || 0) + 1;
                        const stage = dbg.recoveryStage;

                        if (stage === 1) {
                          // 第 1 级：增大 fov 到 70° + 相机后退 30%
                          sceneObj.camera.fov = 70;
                          sceneObj.camera.aspect = rdr.domElement.width / rdr.domElement.height;
                          sceneObj.camera.updateProjectionMatrix();
                          const dir = new THREE.Vector3();
                          sceneObj.camera.getWorldDirection(dir);
                          sceneObj.camera.position.addScaledVector(dir, -sceneObj.camera.position.length() * 0.3);
                          sceneObj.camera.updateMatrixWorld(true);
                          if (sceneObj.controls) {
                            sceneObj.controls.update();
                          }
                          dbg.recoveryAction = 'stage1: fov→70 + zoom-out 30%';
                          logger.warn('[Sonic] Recovery stage 1: wider fov + zoom out');
                        } else if (stage === 2) {
                          // 第 2 级：进一步扩大 fov 到 90°，相机再退
                          sceneObj.camera.fov = 90;
                          sceneObj.camera.updateProjectionMatrix();
                          const dir = new THREE.Vector3();
                          sceneObj.camera.getWorldDirection(dir);
                          sceneObj.camera.position.addScaledVector(dir, -sceneObj.camera.position.length() * 0.5);
                          sceneObj.camera.updateMatrixWorld(true);
                          if (sceneObj.controls) sceneObj.controls.update();
                          dbg.recoveryAction = 'stage2: fov→90 + zoom-out 50%';
                          logger.warn('[Sonic] Recovery stage 2: extreme wide fov');
                        } else if (stage >= 3) {
                          // 第 3 级：保底相机（原点、固定位置）
                          const root = sceneObj.particleSystem;
                          if (root && root.isObject3D) {
                            root.scale.set(1, 1, 1);
                            root.position.set(0, 0, 0);
                            root.rotation.set(0, 0, 0);
                            root.visible = true;
                            root.traverse((o: any) => { if (o.isMesh || o.isInstancedMesh) { o.visible = true; o.frustumCulled = false; } });
                          }
                          sceneObj.camera.fov = 60;
                          sceneObj.camera.aspect = rdr.domElement.width / rdr.domElement.height;
                          sceneObj.camera.updateProjectionMatrix();
                          sceneObj.camera.position.set(0, 8, 20);
                          sceneObj.camera.lookAt(0, 0, 0);
                          sceneObj.camera.updateMatrixWorld(true);
                          if (sceneObj.controls) {
                            sceneObj.controls.target.set(0, 0, 0);
                            sceneObj.controls.update();
                          }
                          dbg.recoveryAction = 'stage3: FALLBACK CAMERA (0,8,20)';
                          dbg.recoveryStage = 99; // 停止再尝试
                          logger.warn('[Sonic] Recovery stage 3: FALLBACK CAMERA ACTIVATED');
                        }
                      } else {
                        // 画面非黑，自愈结束
                        const dbg = (window as any).__sonicDebugExtra || ((window as any).__sonicDebugExtra = {});
                        dbg.recoveryStage = dbg.recoveryStage || 0;
                        if (!dbg.recoverySucceeded && dbg.recoveryStage > 0) {
                          dbg.recoverySucceeded = true;
                          dbg.finalBrightness = avgBrightness.toFixed(1);
                          logger.info(`[Sonic] Recovery success at stage ${dbg.recoveryStage}, brightness=${avgBrightness.toFixed(1)}`);
                        }
                      }
                    }
                  } catch (e) {
                    logger.warn('[Sonic] Black screen check failed:', String(e));
                  }
                }
              }
              // 每 30 帧同步一次诊断（避免每帧 setState 开销）
              if (renderFrameCount % 30 === 0) {
                try {
                  const diag = getDiagnosticService();
                  diag.setFields({
                    renderRunning: true,
                    renderFps: renderFpsTimestamps.length,
                    renderStallFrames: 0,
                    renderTotalFrames: renderFrameCount,
                    renderErrorCount: errorCountRef.current,
                    renderContextState: 'ok',
                    renderMode: mode,
                  });
                } catch { /* ignore */ }
              }

              // sonic 调试层：每 15 帧刷新一次 DOM 面板内容
              if (mode === 'sonic' && renderFrameCount % 15 === 0) {
                try {
                  const dbgFn = (window as any).__SONIC_DEBUG__;
                  if (typeof dbgFn === 'function') {
                    const d = dbgFn();
                    if (d) {
                      const lines: string[] = [];
                      lines.push('=== SONIC DEBUG ===');
                      lines.push(`camera: (${d.camera?.position?.join(', ')}) fov=${d.camera?.fov} aspect=${d.camera?.aspect}`);
                      lines.push(`lookAt: (${d.lookAtTarget?.join(', ')})`);
                      lines.push(`root pos: (${d.root?.worldPosition?.join(', ')}) scale=${d.root?.scale} vis=${d.root?.visible}`);
                      if (d.bbox) {
                        lines.push(`bbox min: (${d.bbox.min?.join(', ')})`);
                        lines.push(`bbox max: (${d.bbox.max?.join(', ')})`);
                        lines.push(`bbox size: (${d.bbox.size?.join(', ')})`);
                        lines.push(`bbox center: (${d.bbox.center?.join(', ')})`);
                      } else {
                        lines.push('bbox: (empty)');
                      }
                      lines.push(`ndc (x,y,z): (${d.ndc?.join(', ')})`);
                      lines.push(`terrain: vis=${d.terrain?.visible} fc=${d.terrain?.frustumCulled} grid=${d.terrain?.gridSize} avgH=${d.terrain?.avgHeightEst}`);
                      lines.push(`floating: vis=${d.floatingBlocks?.visible} fc=${d.floatingBlocks?.frustumCulled} count=${d.floatingBlocks?.count}`);
                      lines.push(`meteors: vis=${d.meteors?.visible} fc=${d.meteors?.frustumCulled}`);
                      lines.push(`trails: vis=${d.trails?.visible} fc=${d.trails?.frustumCulled}`);
                      lines.push(`bands: [${d.bands?.join(', ')}]`);
                      setSonicDebugText(lines.join('\n'));
                    }
                  }
                } catch (dbgErr) {
                  setSonicDebugText(`DEBUG ERROR: ${String(dbgErr)}`);
                }
              }
           } catch (e) {
            errorCountRef.current += 1;
            logger.error('Three render error:', String(e));
            if (errorCountRef.current > 10 && !hasFallbackRef.current) {
              hasFallbackRef.current = true;
              toast.error('3D 渲染异常，已切换为 2D 可视化');
              onFallback?.('渲染异常', String(e));
            }
          }
        };

         // 页面可见性：隐藏时暂停 RAF（节省 CPU/GPU，移动端尤其重要）
         const onVisibility = () => {
           if (document.hidden) {
             if (rafRef.current) {
               cancelAnimationFrame(rafRef.current);
               rafRef.current = 0;
             }
           } else {
             lastTime = performance.now();
             if (!rafRef.current && !disposed) {
               rafRef.current = requestAnimationFrame(animate);
             }
           }
         };
         document.addEventListener('visibilitychange', onVisibility);
         sceneObj._onVisibility = onVisibility;

         rafRef.current = requestAnimationFrame(animate);
       })
       .catch((e) => {
        if (disposed) return;
        logger.error('3D visualizer init failed:', String(e));
        setLoadError(true);
        setLoading(false);
        onReady?.();
        if (!hasFallbackRef.current) {
          hasFallbackRef.current = true;
          toast.info('3D 加载失败，已切换为 2D 可视化');
          onFallback?.('初始化失败', String(e));
        }
      });

    // resize
    const handleResize = () => {
      const obj = sceneRef.current;
      if (!obj || !three) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;

      obj.camera.aspect = w / h;
      obj.camera.updateProjectionMatrix();
      obj.renderer.setSize(w, h);
      if (effectComposer) {
        effectComposer.setSize(w, h);
      }
      if (bloomPass && bloomPass.resolution) {
        bloomPass.resolution.set(w, h);
      }
    };

     const ro = new ResizeObserver(handleResize);
     ro.observe(container);

     // visibility 暂停/恢复在 initScene 内部注册（需要访问 animate / lastTime）

      return () => {
        disposed = true;
        ro.disconnect();

        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }

       const obj = sceneRef.current;
       if (obj) {
         try {
           // 释放粒子几何体/材质
           if (obj.particleSystem) {
             if (obj.particleSystem.geometry) obj.particleSystem.geometry.dispose();
             if (obj.particleSystem.material) {
               if (Array.isArray(obj.particleSystem.material)) {
                 obj.particleSystem.material.forEach((m: any) => m.dispose());
               } else {
                 obj.particleSystem.material.dispose();
               }
             }
           }
           // 释放额外对象
           if (obj.extraObjects && obj.extraObjects.length) {
             obj.extraObjects.forEach((o: any) => {
               if (o.geometry) o.geometry.dispose();
               if (o.material) {
                 if (Array.isArray(o.material)) {
                   o.material.forEach((m: any) => m.dispose());
                 } else {
                   o.material.dispose();
                 }
               }
             });
           }

            // 彻底遍历场景，释放所有 geometry / material / texture（防止切换模式时 WebGL 上下文泄漏）
            if (obj.scene && obj.scene.traverse) {
              obj.scene.traverse((child: any) => {
                if (child.isMesh || child.isPoints || child.isLine) {
                  if (child.geometry && typeof child.geometry.dispose === 'function') {
                    try { child.geometry.dispose(); } catch { /* ignore */ }
                  }
                  if (child.material) {
                    const mats = Array.isArray(child.material) ? child.material : [child.material];
                    mats.forEach((mat: any) => {
                      if (!mat) return;
                      // 释放材质上所有纹理（map/normalMap/roughnessMap/alphaMap 等）
                      try {
                        for (const key of Object.keys(mat)) {
                          const val = (mat as any)[key];
                          if (val && typeof val === 'object' && val.isTexture && typeof val.dispose === 'function') {
                            val.dispose();
                          }
                        }
                      } catch { /* ignore */ }
                      if (typeof mat.dispose === 'function') {
                        try { mat.dispose(); } catch { /* ignore */ }
                      }
                    });
                  }
                }
              });
            }

            // 释放场景雾 / 背景纹理
            if (obj.scene && obj.scene.background && typeof obj.scene.background.dispose === 'function') {
              try { obj.scene.background.dispose(); } catch { /* ignore */ }
            }

           if (effectComposer && effectComposer.dispose) effectComposer.dispose();

           // 清理控件绑定的事件（双击回正等）
           if (typeof (obj as any)._cleanupControls === 'function') {
             try { (obj as any)._cleanupControls(); } catch { /* ignore */ }
           }
           // 释放 OrbitControls（内部有 wheel/touch/pointer 等多个事件监听，必须 dispose）
           if ((obj as any).controls && typeof (obj as any).controls.dispose === 'function') {
             try { (obj as any).controls.dispose(); } catch { /* ignore */ }
           }
           // 清理 visibility 监听
           if ((obj as any)._onVisibility) {
             document.removeEventListener('visibilitychange', (obj as any)._onVisibility);
           }

           if (obj.renderer) {
             // 0. 先移除 WebGL 上下文事件监听器（防止主动 loseContext 触发误降级）
             try {
               const canvasEl = (obj as any)._contextCanvas || obj.renderer.domElement;
               if (canvasEl) {
                 if ((obj as any)._onContextLost) {
                   canvasEl.removeEventListener('webglcontextlost', (obj as any)._onContextLost);
                 }
                 if ((obj as any)._onContextRestored) {
                   canvasEl.removeEventListener('webglcontextrestored', (obj as any)._onContextRestored);
                 }
               }
             } catch { /* ignore */ }
             // 1. 再 forceContextLoss，主动释放 GPU 上下文（防止浏览器 WebGL 上下文数达到上限后创建失败）
             try {
               const gl = obj.renderer.getContext();
               if (gl && typeof gl.getExtension === 'function') {
                 const loseCtx = gl.getExtension('WEBGL_lose_context');
                 if (loseCtx && typeof loseCtx.loseContext === 'function') {
                   loseCtx.loseContext();
                 }
               }
             } catch { /* ignore */ }
             // 2. dispose renderer 内部资源
             obj.renderer.dispose();
             // 3. 从 DOM 中移除 canvas
             const glCanvas = obj.renderer.domElement;
             if (glCanvas && glCanvas.parentNode) {
               glCanvas.parentNode.removeChild(glCanvas);
             }
           }
        } catch (e) {
          logger.warn('Three dispose error:', String(e));
        }
        sceneRef.current = null;
      }
    };
     
  }, [mode]);

   // 颜色变化时更新材质
   useEffect(() => {
     const obj = sceneRef.current;
     if (!obj || !obj.updateColors) return;
     try {
       obj.updateColors(primaryColor, secondaryColor);
     } catch (e) {
       logger.warn('Update colors failed:', String(e));
     }
   }, [primaryColor, secondaryColor]);

   // 封面模式：封面效果参数（亮度/大小/不透明度/波浪强度）变化时实时更新
   useEffect(() => {
     if (mode !== 'cover3d') return;
     const obj = sceneRef.current;
     if (!obj || typeof obj.setCoverEffect !== 'function') return;
     try {
        obj.setCoverEffect({
          preset: coverPreset ?? 0,
          intensity: coverIntensity ?? 0.85,
          depth: coverDepth ?? 0.2,
          bloomStrength: coverBloomStrength ?? 0.62,
          starRiver: coverStarRiver !== false,
          bgFade: coverBgFade ?? 0.20,
          brightness: coverBrightness ?? 1,
          particleSize: coverParticleSize ?? 1,
          opacity: coverOpacity ?? 0.95,
          twist: coverTwist ?? 0,
          scatter: coverScatter ?? 0,
          speed: coverSpeed ?? 1,
          colorBoost: coverColorBoost ?? 1,
          edgeEnabled: coverEdgeEnabled !== false,
        });
     } catch (e) {
       logger.warn('setCoverEffect failed:', String(e));
     }
   }, [mode, coverPreset, coverIntensity, coverDepth, coverBloomStrength, coverStarRiver, coverBgFade, coverBrightness, coverParticleSize, coverOpacity, coverTwist, coverScatter, coverSpeed, coverColorBoost, coverEdgeEnabled]);

   // 封面模式：粒子密度变化 → 重建场景（因为粒子总数要变）
   useEffect(() => {
     if (mode !== 'cover3d') return;
     const obj = sceneRef.current;
     if (!obj || typeof obj.rebuildWithDensity !== 'function') return;
     try {
       obj.rebuildWithDensity(coverDensity ?? 1);
     } catch (e) {
       logger.warn('rebuildWithDensity failed:', String(e));
     }
    }, [mode, coverDensity]);   

    // 音域回响模式：颜色/辉光实时更新
    useEffect(() => {
      if (mode !== 'sonic') return;
      const obj = sceneRef.current;
      if (!obj || !obj.particleSystem) return;
      const sys = obj.particleSystem as any;
      if (typeof sys.setSonicParams !== 'function') return;
      try {
          sys.setSonicParams({
            baseColor: sonicSettings?.baseColor,
            coolColor: sonicSettings?.coolColor,
            warmColor: sonicSettings?.warmColor,
            accentColor: sonicSettings?.accentColor,
            glow: sonicSettings?.glow,
            motionSpeed: sonicSettings?.motionSpeed,
            autoRotate: sonicSettings?.autoRotate,
            floatingEnabled: sonicSettings?.floatingEnabled,
            floatingIntensity: sonicSettings?.floatingIntensity,
            floatingSpeed: sonicSettings?.floatingSpeed,
            eq: sonicSettings?.eq,
          });
      } catch (e) {
        logger.warn('setSonicParams failed:', String(e));
      }
     }, [mode, sonicSettings?.baseColor, sonicSettings?.coolColor, sonicSettings?.warmColor, sonicSettings?.accentColor, sonicSettings?.glow, sonicSettings?.motionSpeed, sonicSettings?.autoRotate, sonicSettings?.floatingEnabled, sonicSettings?.floatingIntensity, sonicSettings?.floatingSpeed, sonicSettings?.eq]);

    // 歌词涟漪参数更新（颜色模式、颜色值）
    useEffect(() => {
      // 写入调试信息（不管是否 sonic 模式都更新，显示层自行判断）
      try {
        const dbg = (window as any).__sonicDebugExtra || ((window as any).__sonicDebugExtra = {});
        dbg.enabled = !!lyricRippleEnabled;
        dbg.intensity = (lyricRippleIntensity ?? 1).toFixed(1);
        dbg.colorMode = lyricRippleColorMode || 'accent';
      } catch { /* ignore */ }
      if (mode !== 'sonic') return;
      const obj = sceneRef.current;
      if (!obj || !obj.particleSystem) return;
      const sys = obj.particleSystem as any;
      if (typeof sys.setLyricRippleParams !== 'function') return;
      try {
        sys.setLyricRippleParams({
          colorMode: lyricRippleColorMode || 'accent',
          rippleColor: lyricColor,
        });
      } catch (e) {
        logger.warn('setLyricRippleParams failed:', String(e));
      }
    }, [mode, lyricRippleColorMode, lyricColor]);

    // 歌词句变化时触发涟漪
    const lastLyricIdxRef = useRef<number>(-1);
    useEffect(() => {
      if (mode !== 'sonic') return;
      if (!lyricRippleEnabled) return;
      if (currentLyricIndex == null || currentLyricIndex < 0) return;
      // 跳过首次挂载的 -1 → 0 变化（等真正唱到第一句再触发）
      if (lastLyricIdxRef.current === -1 && currentLyricIndex === 0) {
        lastLyricIdxRef.current = currentLyricIndex;
        return;
      }
      if (currentLyricIndex === lastLyricIdxRef.current) return;
      lastLyricIdxRef.current = currentLyricIndex;

      const obj = sceneRef.current;
      if (!obj || !obj.particleSystem) return;
      const sys = obj.particleSystem as any;
      if (typeof sys.triggerLyricRipple !== 'function') return;

      try {
        // 歌词行数：短句子1个涟漪，长句子2个
        const line = lyricLines?.[currentLyricIndex];
        const text = line?.text || '';
        const count = text.length > 8 ? 2 : 1;
        // 主歌用彩色涟漪，副歌/长句给一次白色高光
        const whiteRipple = text.length > 12 && currentLyricIndex % 4 === 0;
        sys.triggerLyricRipple(lyricRippleIntensity ?? 1, whiteRipple, count);
        // 更新调试计数
        try {
          const dbg = (window as any).__sonicDebugExtra || ((window as any).__sonicDebugExtra = {});
          dbg.lyricRippleCount = (dbg.lyricRippleCount || 0) + 1;
          dbg.lastLyricIdx = currentLyricIndex;
          dbg.lastLyricText = text;
        } catch { /* ignore */ }
      } catch (e) {
        logger.warn('triggerLyricRipple failed:', String(e));
      }
    }, [mode, currentLyricIndex, lyricRippleEnabled, lyricRippleIntensity, lyricLines]);

    // 音域回响模式：影响几何结构的参数变化 → 防抖重建场景
    const sonicRebuildTimerRef = useRef<number | null>(null);
    useEffect(() => {
      if (mode !== 'sonic') return;
      if (!sceneRef.current) return;
      const sys = sceneRef.current.particleSystem as any;
      if (!sys || typeof sys.rebuildSonic !== 'function') return;
      if (sonicRebuildTimerRef.current) {
        window.clearTimeout(sonicRebuildTimerRef.current);
      }
      sonicRebuildTimerRef.current = window.setTimeout(() => {
        try {
          sys.rebuildSonic({
            amplitude: sonicSettings?.amplitude ?? 50,
            motionSpeed: sonicSettings?.motionSpeed ?? 50,
            density: sonicSettings?.density ?? 46,
            range: sonicSettings?.range ?? 82,
            lower: sonicSettings?.lower ?? 68,
            depth: sonicSettings?.depth ?? 62,
            autoRotate: sonicSettings?.autoRotate ?? 50,
            glow: sonicSettings?.glow ?? 68,
            baseColor: sonicSettings?.baseColor ?? '#05070c',
            coolColor: sonicSettings?.coolColor ?? '#0066ff',
            warmColor: sonicSettings?.warmColor ?? '#ff3c19',
            accentColor: sonicSettings?.accentColor ?? '#33e6ff',
            floatingEnabled: sonicSettings?.floatingEnabled ?? true,
            floatingIntensity: sonicSettings?.floatingIntensity ?? 55,
            floatingMinSize: sonicSettings?.floatingMinSize ?? 9,
            floatingMaxSize: sonicSettings?.floatingMaxSize ?? 26,
            floatingSpeed: sonicSettings?.floatingSpeed ?? 77,
            floatingCount: sonicSettings?.floatingCount ?? 80,
            eq: sonicSettings?.eq ?? [90, 92, 50, 50, 50, 50, 50, 48],
          });
        } catch (e) {
          logger.warn('sonic rebuild failed:', String(e));
        }
      }, 250);
      return () => {
        if (sonicRebuildTimerRef.current) {
          window.clearTimeout(sonicRebuildTimerRef.current);
          sonicRebuildTimerRef.current = null;
        }
      };
     }, [
        mode,
        sonicSettings?.density,
        sonicSettings?.range,
        sonicSettings?.lower,
        sonicSettings?.depth,
        sonicSettings?.floatingCount,
        sonicSettings?.floatingMinSize,
        sonicSettings?.floatingMaxSize,
        sonicSettings?.amplitude,
      ]);

  // 封面模式下：URL 变化或进入封面模式时，自动（重新）加载封面
    // 依赖：mode + trackId + coverUrl 字符串，确保任何变化都能触发
    useEffect(() => {
      if (mode !== 'cover3d') return;
      const obj = sceneRef.current;
      // 场景还没初始化好 → 先记到 ref 里，等场景就绪后由下方轮询检查补加载
      coverUrlRef.current = currentCoverUrl;
     coverLoadedRef.current = false; // 每次 URL/歌曲/mode 变化都重置加载标记
       if (!obj || !obj.rebuildCover) return;
      coverLoadedRef.current = true; // 立即尝试了一次，标记已尝试
       try {
         obj.rebuildCover(currentCoverUrl, currentTrack);
         setCoverErr('');
       } catch (e) {
         logger.warn('Rebuild cover particles failed:', String(e));
         setCoverErr(String(e));
       }
    }, [mode, currentTrack?.id, currentCoverUrl]);  

 // 封面模式下：轮询检查场景是否已就绪 + 错误/调试信息同步
    // 作用：①场景刚创建但 URL 还没加载时的补加载；②异步采样后的状态同步
    useEffect(() => {
      if (mode !== 'cover3d') return;
      let timer: number | null = null;
      const startPolling = () => {
        if (timer) return;
        timer = window.setInterval(() => {
        const obj = sceneRef.current;
        // 场景刚就绪但封面还没加载 → 补加载（init 时 URL 为空或场景尚未创建）
        if (obj && typeof obj.rebuildCover === 'function' && !coverLoadedRef.current) {
          const url = coverUrlRef.current;
          if (url) {
            coverLoadedRef.current = true;
            try {
              obj.rebuildCover(url, currentTrack);
              setCoverErr('');
            } catch (e) {
              logger.warn('Polling rebuild cover failed:', String(e));
              setCoverErr(String(e));
            }
          } else {
            coverLoadedRef.current = true;
          }
        }
        if (obj && typeof obj.getCoverError === 'function') {
           const msg = obj.getCoverError();
           setCoverErr(msg);
         }
         // 同步封面音频指标到诊断（beat/kick/uBeat 健康检查）
         if (obj && typeof obj.getAudioMetrics === 'function') {
           try {
             const metrics = obj.getAudioMetrics();
             const diag = getDiagnosticService();
             diag.setFields({
               coverKickEnvelope: metrics.kickEnvelope || 0,
               coverIsKick: metrics.isKick || false,
               coverLowLevel: metrics.lowLevel || 0,
               coverPeakLevel: metrics.peakLevel || 0,
             });
           } catch { /* ignore */ }
         }
         // 同步封面调试信息
         if (obj && typeof obj.getDebugMetrics === 'function') {
           try {
             const dbg = obj.getDebugMetrics();
             const diag = getDiagnosticService();
             diag.setFields({
               coverLoaded: !!dbg.isLoaded,
               coverParticleCount: dbg.actualCount || 0,
               coverGeometryId: dbg.geometryId || '-',
               coverParticleSystemId: dbg.particleSystemId || '-',
               coverIntroProgress: dbg.introProgress || 0,
               busKick: dbg.kick || 0,
             });
           } catch { /* ignore */ }
         }
      }, 300);
      };
      const stopPolling = () => {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      };
      const onVis = () => {
        if (document.hidden) stopPolling();
        else startPolling();
      };
      startPolling();
      document.addEventListener('visibilitychange', onVis);
     return () => {
       stopPolling();
       document.removeEventListener('visibilitychange', onVis);
     };
   }, [mode]);  

  // cover3d 模式：轮询检查封面错误状态

  return (
     <div ref={containerRef} className="absolute inset-0 w-full h-full">
       {loading && (
         <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
           <div className="flex flex-col items-center gap-3 text-white/60">
             <div className="w-8 h-8 border-2 border-white/20 border-t-cyan-400 rounded-full animate-spin" />
             <span className="text-sm">3D 场景加载中...</span>
           </div>
         </div>
       )}

        {mode === 'cover3d' && coverErr && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
            <div className="px-3 py-1.5 rounded-md bg-black/60 backdrop-blur-sm border border-red-500/40 text-xs text-red-300 font-mono max-w-[90vw] text-center">
              封面加载失败：{coverErr}
            </div>
          </div>
        )}

        {/* Sonic 调试面板：URL ?debug=sonic 或 localStorage sonicDebug=1 时显示 */}
        {showSonicDebug && mode === 'sonic' && sonicDebugText && (
          <div className="absolute top-2 left-2 z-30 pointer-events-auto max-w-[420px] max-h-[80vh] overflow-auto bg-black/75 backdrop-blur-sm border border-cyan-500/30 rounded-md p-2 shadow-lg">
            <pre className="text-[10px] leading-tight font-mono text-cyan-200 whitespace-pre-wrap break-all">
              {sonicDebugText}
            </pre>
            <button
              onClick={() => setShowSonicDebug(false)}
              className="mt-1 text-[10px] text-cyan-400 hover:text-cyan-200 font-mono"
            >
              [关闭调试面板]
            </button>
          </div>
        )}

       </div>
     );
 }

// ===== 场景初始化工厂 =====
 async function initScene(
   THREE: any,
   container: HTMLElement,
   mode: Visualizer3DMode,
   primaryColor: string,
   secondaryColor: string,
   currentTrack: any,
   initialCoverUrl = '',
   coverParticleCount?: number,
   coverDensity = 1,
   sonicSettings?: Props['sonicSettings'],
 ): Promise<any> {
   const w = container.clientWidth || window.innerWidth;
   const h = container.clientHeight || window.innerHeight;
   const tier = getPerformanceTier();
   // 同步性能档位到诊断服务
   try {
     const diag = getDiagnosticService();
     diag.setField('qualityTier', tier);
   } catch { /* ignore */ }
   // 按性能档位自适应 DPR（移动端默认降，低端机更激进），上限 2（原已存在）
   const nativeDpr = window.devicePixelRatio || 1;
   const dpr = tier === 'low'
     ? Math.min(nativeDpr, 1.0)
     : tier === 'mid'
     ? Math.min(nativeDpr, 1.5)
     : Math.min(nativeDpr, 2);
   // 封面模式：粒子数 = 用户指定粒子数 × 密度倍率，按档位设上限
   // 移动端（low tier）上限 8k，中端 16k，高端 30k，防止超高粒子数导致 GPU 崩溃
   const autoCount = getParticleCountForTier(tier, mode);
   const coverMaxMap: Record<string, number> = { low: 8000, mid: 16000, high: 30000 };
   const coverMax = coverMaxMap[tier] ?? 30000;
   const baseCount = mode === 'cover3d' && coverParticleCount && coverParticleCount > 0
     ? Math.max(1000, Math.min(coverParticleCount, coverMax))
     : autoCount;
   const density = Math.max(0.3, Math.min(1.5, coverDensity || 1));
   const particleCount = Math.max(500, Math.floor(baseCount * density));

  // Scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020610);
  scene.fog = mode === 'sonic' ? null : new THREE.FogExp2(0x020610, mode === 'cover3d' ? 0.015 : 0.035);

  // Camera
  const camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 1000);
  camera.position.set(0, 0, mode === 'cover3d' ? 8 : 12);

   // Renderer —— 多级降级尝试，适配华为等浏览器的硬件加速差异
   // preserveDrawingBuffer 只在 sonic 模式开启（用于 readPixels 黑屏检测），
   // 其他模式关闭以节省显存并提升填充率（显存占用约减半）
   const needPreserve = mode === 'sonic';
   let renderer: any = null;
   let rendererError = '';
   const rendererConfigs = [
     { antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: needPreserve },
     { antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: needPreserve },
     { antialias: false, alpha: false, powerPreference: 'default', preserveDrawingBuffer: needPreserve },
     { antialias: false, alpha: true, powerPreference: 'default', preserveDrawingBuffer: false },
     { antialias: false, alpha: false, powerPreference: 'low-power', preserveDrawingBuffer: false },
   ];
  for (let i = 0; i < rendererConfigs.length; i++) {
    try {
      renderer = new THREE.WebGLRenderer(rendererConfigs[i]);
      // 简单验证：尝试获取上下文是否正常
      const gl = renderer.getContext();
      if (!gl) {
        renderer = null;
        continue;
      }
      logger.info(`3D renderer created with config index ${i}:`, JSON.stringify(rendererConfigs[i]));
      break;
    } catch (e) {
      rendererError = String(e);
      logger.warn(`3D renderer config ${i} failed:`, String(e));
      try { renderer?.dispose?.(); } catch { /* ignore */ }
      renderer = null;
    }
  }
  if (!renderer) {
    throw new Error(`WebGLRenderer 创建失败，已尝试 ${rendererConfigs.length} 种配置。最后错误：${rendererError || '未知'}`);
  }
   renderer.setPixelRatio(dpr);
   renderer.setSize(w, h);
   renderer.setClearColor(0x020610, 1);
   // 正确的 sRGB 输出颜色空间，确保封面等 sRGB 纹理颜色准确
   if (typeof THREE.SRGBColorSpace !== 'undefined') {
     renderer.outputColorSpace = THREE.SRGBColorSpace;
   }
   container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';

  // 环境光（微弱）
  const ambient = new THREE.AmbientLight(0xffffff, 0.15);
  scene.add(ambient);

   // 中心点光源（封面模式/音域回响模式不需要，粒子自发光足够）
    let pointLight: any = null;
    if (mode !== 'cover3d' && mode !== 'sonic') {
      pointLight = new THREE.PointLight(new THREE.Color(primaryColor), 1.2, 30);
      pointLight.position.set(0, 0, 0);
      scene.add(pointLight);
    }

  // 根据模式创建不同粒子系统
  let particleSystem: any = null;
  let extraObjects: any[] = [];
  let updateFn: ((freq: Uint8Array, delta: number, sens: number, simulated: boolean, kickEnvelope?: number) => void) | null = null;
  let rebuildCoverFn: ((url: string, track: any) => void) | null = null;

  if (mode === 'galaxy3d') {
    const result = createGalaxy3D(THREE, particleCount, primaryColor, secondaryColor);
    particleSystem = result.system;
    updateFn = result.update;
    scene.add(particleSystem);
  } else if (mode === 'sphere3d') {
    const result = createSphere3D(THREE, particleCount, primaryColor, secondaryColor);
    particleSystem = result.system;
    updateFn = result.update;
    extraObjects = result.extra || [];
    scene.add(particleSystem);
    extraObjects.forEach(o => scene.add(o));
  } else if (mode === 'ring3d') {
    const result = createRing3D(THREE, particleCount, primaryColor, secondaryColor);
    particleSystem = result.system;
    extraObjects = result.extra || [];
    updateFn = result.update;
    scene.add(particleSystem);
    extraObjects.forEach(o => scene.add(o));
   } else if (mode === 'cover3d') {
      const result = createCover3D(THREE, particleCount, primaryColor, secondaryColor, initialCoverUrl || (currentTrack?.coverUrl ?? ''));
      particleSystem = result.system;
      updateFn = result.update;
      rebuildCoverFn = result.rebuild || null;
      (particleSystem as any).getAudioMetrics = result.getAudioMetrics || (() => ({}));
      (particleSystem as any).setCoverEffect = result.setCoverEffect;
      (particleSystem as any).getDebugMetrics = result.getDebugMetrics || (() => ({}));
      // ===== 诊断：给 geometry 和 system 打唯一 ID 戳，验证 rebuild 后引用不变 =====
      const geo = (particleSystem as any).geometry;
      if (geo && !geo.__debugId) geo.__debugId = 'geo_' + Math.random().toString(36).slice(2, 8);
      if (!(particleSystem as any).__debugId) (particleSystem as any).__debugId = 'ps_' + Math.random().toString(36).slice(2, 8);
      scene.add(particleSystem);
     } else if (mode === 'sonic') {
        // ===== 音域回响模式：全链路 try/catch + 调试层探针 =====
        stageStart('createTopography');
        let sonicResult: any = null;
        let currentSonicResult: any = null;
        let fallbackMode = false;
        let lastFitInfo: { distance: number; iterations: number; allCornersInView: boolean } | null = null;

        try {
          const sonicParams = sonicSettings ? {
            amplitude: sonicSettings.amplitude,
            motionSpeed: sonicSettings.motionSpeed,
            density: sonicSettings.density,
            range: sonicSettings.range,
            lower: sonicSettings.lower,
            depth: sonicSettings.depth,
            autoRotate: sonicSettings.autoRotate,
            glow: sonicSettings.glow,
            baseColor: sonicSettings.baseColor,
            coolColor: sonicSettings.coolColor,
            warmColor: sonicSettings.warmColor,
            accentColor: sonicSettings.accentColor,
            floatingEnabled: sonicSettings.floatingEnabled,
            floatingIntensity: sonicSettings.floatingIntensity,
            floatingMinSize: sonicSettings.floatingMinSize,
            floatingMaxSize: sonicSettings.floatingMaxSize,
            floatingSpeed: sonicSettings.floatingSpeed,
            floatingCount: sonicSettings.floatingCount,
            eq: sonicSettings.eq,
          } : { ...DEFAULT_SONIC_MR_PARAMS };

          sonicResult = createSonicTopographyMR(THREE, sonicParams, 'balanced');
          (sonicResult as any)._setScene(scene);
          particleSystem = sonicResult.root;
          currentSonicResult = sonicResult;
          setStageDone('createTopography', `root=${sonicResult.root?.type ?? '?'}`);
        } catch (e) {
          setStageFailed('createTopography', e);
          logger.error('[Sonic] createTopography failed:', String(e));
          // 失败也要挂空 particleSystem，防止后续访问报错
          particleSystem = new THREE.Object3D();
          updateFn = () => {};
        }

        // ===== 计算世界包围盒（手动展开所有实例矩阵）=====
        const computeWorldBBox = (root: any) => {
          if (!root) return { box: new THREE.Box3(), corners: [] as any[] };
          root.updateMatrixWorld(true);
          const box = new THREE.Box3();
          const tmpVec = new THREE.Vector3();
          const m = new THREE.Matrix4();
          const worldM = new THREE.Matrix4();
          const geoBox = new THREE.Box3();

          root.traverse((obj: any) => {
            if (!obj.visible) return;
            if (obj.isInstancedMesh) {
              const geo = obj.geometry;
              if (!geo) return;
              // 确保 geometry 有 boundingBox
              if (!geo.boundingBox) geo.computeBoundingBox();
              if (!geo.boundingBox) return;
              for (let i = 0; i < obj.count; i++) {
                obj.getMatrixAt(i, m);
                worldM.multiplyMatrices(obj.matrixWorld, m);
                geoBox.copy(geo.boundingBox);
                geoBox.applyMatrix4(worldM);
                box.union(geoBox);
              }
            } else if (obj.isMesh && obj.geometry) {
              const geo = obj.geometry;
              if (!geo.boundingBox) geo.computeBoundingBox();
              if (geo.boundingBox) {
                const bb = geo.boundingBox.clone();
                bb.applyMatrix4(obj.matrixWorld);
                box.union(bb);
              }
            }
          });

          // 8 个角点
          const corners: any[] = [];
          if (!box.isEmpty()) {
            const { min, max } = box;
            const xs = [min.x, max.x];
            const ys = [min.y, max.y];
            const zs = [min.z, max.z];
            for (const x of xs) for (const y of ys) for (const z of zs) {
              corners.push(new THREE.Vector3(x, y, z));
            }
          }
          return { box, corners };
        };

        // ===== 相机 fit：基于包围盒 8 角点迭代直到全部入镜 =====
        const TARGET_PITCH = Math.PI / 4; // 45° 俯角
        const FIT_MARGIN = 0.15;
        const MAX_FIT_ITER = 8;

        const fitSonicCamera = (root: any) => {
          const { box, corners } = computeWorldBBox(root);
          if (box.isEmpty()) {
            throw new Error('computeWorldBBox returned empty box');
          }
          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());

          // 尺寸合理性检查
          if (!isFinite(size.x) || !isFinite(size.y) || !isFinite(size.z)) {
            throw new Error(`bbox size non-finite: ${size.x},${size.y},${size.z}`);
          }
          if (size.x < 0.001 && size.y < 0.001 && size.z < 0.001) {
            throw new Error(`bbox too small: ${size.x.toFixed(4)},${size.y.toFixed(4)},${size.z.toFixed(4)}`);
          }

          const fovRad = (camera.fov * Math.PI) / 180;
          const aspect = camera.aspect;
          const sinP = Math.sin(TARGET_PITCH);
          const cosP = Math.cos(TARGET_PITCH);

          // 初步估算：俯角下投影高度 = size.y*cos(pitch) + size.z*sin(pitch)
          const projVertical = size.y * cosP + size.z * sinP;
          let dVertical = (projVertical / 2) / Math.tan(fovRad / 2);
          const fovH = 2 * Math.atan(Math.tan(fovRad / 2) * aspect);
          let dHorizontal = (size.x / 2) / Math.tan(fovH / 2);
          let distance = Math.max(dVertical, dHorizontal) * (1 + FIT_MARGIN);

          let allInView = false;
          let iterations = 0;
          const tmpNdc = new THREE.Vector3();

          while (iterations < MAX_FIT_ITER) {
            iterations++;
            camera.position.set(
              center.x,
              center.y + distance * sinP,
              center.z + distance * cosP,
            );
            camera.lookAt(center);
            camera.updateMatrixWorld(true);

            // 检查 8 个角点 NDC
            allInView = true;
            let maxOut = 0;
            for (const c of corners) {
              tmpNdc.copy(c).project(camera);
              const outX = Math.max(0, Math.abs(tmpNdc.x) - 1);
              const outY = Math.max(0, Math.abs(tmpNdc.y) - 1);
              const outZ = tmpNdc.z < -1 || tmpNdc.z > 1 ? 1 : 0;
              if (outX > 0.001 || outY > 0.001 || outZ > 0) {
                allInView = false;
                maxOut = Math.max(maxOut, outX, outY);
              }
            }
            if (allInView) break;
            // 按超出比例放大距离
            const scale = 1 + Math.max(maxOut * 1.5, 0.15);
            distance *= scale;
          }

          lastFitInfo = { distance, iterations, allCornersInView: allInView };
          return { box, center, size, corners, distance, iterations, allInView };
        };

        const applyFallbackCamera = (root: any) => {
          // 保底：把 root 放到原点、缩小到可见尺寸，相机固定在(0,9,18)看原点
          fallbackMode = true;
          root.scale.set(1, 1, 1);
          root.position.set(0, 0, 0);
          root.rotation.set(0, 0, 0);
          camera.fov = 55;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          camera.position.set(0, 9, 18);
          camera.lookAt(0, 0, 0);
          camera.updateMatrixWorld(true);
          logger.warn('[Sonic] Entered fallback camera mode');
        };

        // ===== 主流程：applyLayout → computeBounds → fitCamera =====
        if (sonicResult && sonicResult.root) {
          try {
            stageStart('applyLayout');
            // 布局参数已由 createSonicTopographyMR 内部设置，这里触发一次更新矩阵
            sonicResult.root.updateMatrixWorld(true);
            setStageDone('applyLayout',
              `pos=(${sonicResult.root.position.x.toFixed(2)},${sonicResult.root.position.y.toFixed(2)},${sonicResult.root.position.z.toFixed(2)}) scale=${sonicResult.root.scale.x.toFixed(3)}`);
          } catch (e) {
            setStageFailed('applyLayout', e);
          }

          try {
            stageStart('computeBounds');
            const { box } = computeWorldBBox(sonicResult.root);
            if (box.isEmpty()) throw new Error('empty bbox');
            const size = box.getSize(new THREE.Vector3());
            const c = box.getCenter(new THREE.Vector3());
            setStageDone('computeBounds',
              `size=(${size.x.toFixed(2)},${size.y.toFixed(2)},${size.z.toFixed(2)}) center=(${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)})`);
          } catch (e) {
            setStageFailed('computeBounds', e);
            reportError('computeBounds', e);
          }

          camera.fov = 55;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();

          try {
            stageStart('fitCamera');
            const fitResult = fitSonicCamera(sonicResult.root);
            if (!fitResult.allInView) {
              throw new Error(`corners still out of view after ${fitResult.iterations} iterations`);
            }
            setStageDone('fitCamera',
              `dist=${fitResult.distance.toFixed(2)} iter=${fitResult.iterations}`);
          } catch (e) {
            setStageFailed('fitCamera', e);
            reportError('fitCamera', e);
            // 触发保底相机
            try {
              applyFallbackCamera(sonicResult.root);
            } catch (fe) {
              reportError('fallbackCamera', fe);
            }
          }

          scene.add(sonicResult.root);

          // MR 每帧 update
          updateFn = (freq, delta, sens) => {
            try {
              const sr = 44100;
              currentSonicResult?.update?.(freq, delta, sr, 2048);
            } catch (e) {
              reportError('update', e);
            }
          };

          // setSonicParams / rebuild
          (particleSystem as any).setSonicParams = (p: any) => {
            try { currentSonicResult?.updateParams?.(p); } catch (e) { reportError('setSonicParams', e); }
          };
          (particleSystem as any).triggerLyricRipple = (intensity?: number, whiteRipple?: boolean, count?: number) => {
            try { currentSonicResult?.triggerLyricRipple?.(intensity, whiteRipple, count); } catch (e) { reportError('triggerLyricRipple', e); }
          };
          (particleSystem as any).setLyricRippleParams = (params: any) => {
            try { currentSonicResult?.setLyricRippleParams?.(params); } catch (e) { reportError('setLyricRippleParams', e); }
          };
          (particleSystem as any)._sonicDispose = () => {
            try { currentSonicResult?.dispose?.(); } catch { /* ignore */ }
          };

          const doRebuildSonic = (params: any) => {
            try {
              try { currentSonicResult?.dispose?.(); } catch { /* ignore */ }
              if (currentSonicResult?.root?.parent) scene.remove(currentSonicResult.root);
              const newResult = createSonicTopographyMR(THREE, params, 'balanced');
              (newResult as any)._setScene(scene);
              currentSonicResult = newResult;
              particleSystem = newResult.root;
              fallbackMode = false;

              updateFn = (freq: Uint8Array, delta: number) => {
                try { newResult.update(freq, delta, 44100, 2048); } catch (e) { reportError('update', e); }
              };
              (particleSystem as any).setSonicParams = (p: any) => {
                try { newResult.updateParams(p); } catch (e) { reportError('setSonicParams', e); }
              };
              (particleSystem as any).triggerLyricRipple = (intensity?: number, whiteRipple?: boolean, count?: number) => {
                try { newResult.triggerLyricRipple?.(intensity, whiteRipple, count); } catch (e) { reportError('triggerLyricRipple', e); }
              };
              (particleSystem as any).setLyricRippleParams = (params: any) => {
                try { newResult.setLyricRippleParams?.(params); } catch (e) { reportError('setLyricRippleParams', e); }
              };
              (particleSystem as any)._sonicDispose = () => {
                try { newResult.dispose(); } catch { /* ignore */ }
              };
              (particleSystem as any).rebuildSonic = doRebuildSonic;

              scene.add(newResult.root);
              camera.fov = 55;
              camera.aspect = w / h;
              camera.updateProjectionMatrix();

              try {
                fitSonicCamera(newResult.root);
              } catch (e) {
                reportError('rebuildFitCamera', e);
                try { applyFallbackCamera(newResult.root); } catch (fe) { reportError('rebuildFallback', fe); }
              }
            } catch (e) {
              reportError('rebuildSonic', e);
            }
          };
          (particleSystem as any).rebuildSonic = doRebuildSonic;

          // ===== 调试数据：每帧写入 DOM 面板 =====
          const getDebugLines = () => {
            const lines: string[] = [];
            try {
              const root = currentSonicResult?.root;
              if (!root) return ['(no root)'];
              root.updateMatrixWorld(true);
              const { box, corners } = computeWorldBBox(root);
              const cam = camera;
              const worldPos = new THREE.Vector3();
              root.getWorldPosition(worldPos);

              lines.push('');
              lines.push('── Camera ──');
              lines.push(`pos: (${cam.position.x.toFixed(2)}, ${cam.position.y.toFixed(2)}, ${cam.position.z.toFixed(2)})`);
              lines.push(`fov: ${cam.fov.toFixed(1)}  aspect: ${cam.aspect.toFixed(2)}`);
              if (lastFitInfo) {
                lines.push(`fitDist: ${lastFitInfo.distance.toFixed(2)}  iter: ${lastFitInfo.iterations}`);
                lines.push(`cornersInView: ${lastFitInfo.allCornersInView}`);
              }
              if (fallbackMode) lines.push('⚠ FALLBACK CAMERA ACTIVE');

              lines.push('');
              lines.push('── Bounding Box (world) ──');
              if (box.isEmpty()) {
                lines.push('(empty)');
              } else {
                lines.push(`min: (${box.min.x.toFixed(2)}, ${box.min.y.toFixed(2)}, ${box.min.z.toFixed(2)})`);
                lines.push(`max: (${box.max.x.toFixed(2)}, ${box.max.y.toFixed(2)}, ${box.max.z.toFixed(2)})`);
                const c = box.getCenter(new THREE.Vector3());
                const s = box.getSize(new THREE.Vector3());
                lines.push(`center: (${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)})`);
                lines.push(`size: (${s.x.toFixed(2)}, ${s.y.toFixed(2)}, ${s.z.toFixed(2)})`);
                // NDC of center
                const ndcC = c.clone().project(cam);
                lines.push(`center NDC: (${ndcC.x.toFixed(3)}, ${ndcC.y.toFixed(3)}, ${ndcC.z.toFixed(3)})`);
                // 8 角点 NDC 范围
                if (corners.length === 8) {
                  let minXNDC = Infinity, maxXNDC = -Infinity;
                  let minYNDC = Infinity, maxYNDC = -Infinity;
                  let minZNDC = Infinity, maxZNDC = -Infinity;
                  const tmp = new THREE.Vector3();
                  for (const cc of corners) {
                    tmp.copy(cc).project(cam);
                    minXNDC = Math.min(minXNDC, tmp.x); maxXNDC = Math.max(maxXNDC, tmp.x);
                    minYNDC = Math.min(minYNDC, tmp.y); maxYNDC = Math.max(maxYNDC, tmp.y);
                    minZNDC = Math.min(minZNDC, tmp.z); maxZNDC = Math.max(maxZNDC, tmp.z);
                  }
                  lines.push(`8-corners NDC x: [${minXNDC.toFixed(3)}, ${maxXNDC.toFixed(3)}]`);
                  lines.push(`8-corners NDC y: [${minYNDC.toFixed(3)}, ${maxYNDC.toFixed(3)}]`);
                  lines.push(`8-corners NDC z: [${minZNDC.toFixed(3)}, ${maxZNDC.toFixed(3)}]`);
                }
              }

              lines.push('');
              lines.push('── Meshes ──');
              let terrainCount = 0, floatingCount = 0, meteorCount = 0, trailCount = 0;
              let terrainVisible: boolean | null = null, floatingVisible: boolean | null = null;
              let terrainFC: boolean | null = null, floatingFC: boolean | null = null;
              let terrainMat: any = null;
              root.traverse((obj: any) => {
                if (obj.isInstancedMesh) {
                  if (obj.count > 1000) { terrainCount = obj.count; terrainVisible = obj.visible; terrainFC = obj.frustumCulled; }
                  else if (obj.count > 50) { floatingCount = obj.count; floatingVisible = obj.visible; floatingFC = obj.frustumCulled; }
                  else if (meteorCount === 0) meteorCount = obj.count;
                  else trailCount = obj.count;
                }
                if (obj.material?.uniforms?.uGlowIntensity && !terrainMat) terrainMat = obj.material;
              });
              lines.push(`terrain: count=${terrainCount} vis=${terrainVisible} fc=${terrainFC}`);
              lines.push(`floating: count=${floatingCount} vis=${floatingVisible} fc=${floatingFC}`);
              lines.push(`meteors: count=${meteorCount}`);
              lines.push(`trails: count=${trailCount}`);

              if (terrainMat?.uniforms) {
                const u = terrainMat.uniforms;
                lines.push('');
                lines.push('── 8 Bands ──');
                const bandKeys = ['uSubBass', 'uBass', 'uLowMid', 'uMid', 'uHighMid', 'uPresence', 'uBrilliance', 'uAir'];
                const vals = bandKeys.map(k => Number(u[k]?.value ?? 0).toFixed(3));
                lines.push(`[${vals.join(', ')}]`);
                const avgH = 0.8 + (u.uSubBass?.value||0)*4 + (u.uBass?.value||0)*3 + (u.uLowMid?.value||0)*2;
                lines.push(`estAvgHeight: ${avgH.toFixed(2)}`);
              }

              // 黑屏自愈状态
              try {
                const dbg = (window as any).__sonicDebugExtra;
                if (dbg) {
                  lines.push('');
                  lines.push('── Black-Screen Recovery ──');
                  if (dbg.frameBrightness != null) lines.push(`brightness: ${dbg.frameBrightness}/255`);
                  if (dbg.nonBlackRatio != null) lines.push(`nonBlack: ${dbg.nonBlackRatio}`);
                  if (dbg.recoveryStage != null && dbg.recoveryStage > 0) {
                    lines.push(`recoveryStage: ${dbg.recoveryStage}`);
                  }
                  if (dbg.recoveryAction) lines.push(`action: ${dbg.recoveryAction}`);
                  if (dbg.recoverySucceeded) lines.push('✅ recovery SUCCESS');
                  if (dbg.shaderStatus) lines.push(`shader: ${dbg.shaderStatus}`);
                }
              } catch { /* ignore */ }

              // 歌词涟漪状态
              try {
                const ldb = (window as any).__sonicDebugExtra;
                lines.push('');
                lines.push('── Lyric Ripple ──');
                if (ldb?.enabled != null) lines.push(`enabled: ${ldb.enabled ? 'on' : 'off'}`);
                if (ldb?.intensity != null) lines.push(`intensity: ${ldb.intensity}`);
                if (ldb?.colorMode) lines.push(`colorMode: ${ldb.colorMode}`);
                if (ldb?.lyricRippleCount != null) lines.push(`triggered: ${ldb.lyricRippleCount}`);
                if (ldb?.lastLyricIdx != null) lines.push(`lastLyricIdx: ${ldb.lastLyricIdx}`);
              } catch { /* ignore */ }
            } catch (e) {
              lines.push(`debugRender error: ${String(e)}`);
            }
            return lines;
          };

          // 每帧调试面板更新（每 ~0.25s 一次节流）
          let lastDebugUpdate = 0;
          const originalUpdateFn = updateFn;
          updateFn = (freq, delta, sens, simulated, kick) => {
            originalUpdateFn?.(freq, delta, sens, simulated, kick);
            const now = performance.now();
            if (now - lastDebugUpdate > 250) {
              lastDebugUpdate = now;
              try { setExtra(getDebugLines()); } catch { /* ignore */ }
            }
          };

          // 暴露到全局
          (window as any).__SONIC_DEBUG__ = () => {
            const root = currentSonicResult?.root;
            if (!root) return null;
            const { box } = computeWorldBBox(root);
            const cam = camera;
            const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
            const ndc = c.clone().project(cam);
            return {
              camera: { position: [cam.position.x.toFixed(2), cam.position.y.toFixed(2), cam.position.z.toFixed(2)], fov: cam.fov, aspect: cam.aspect },
              bbox: box.isEmpty() ? null : {
                min: [box.min.x, box.min.y, box.min.z],
                max: [box.max.x, box.max.y, box.max.z],
                center: [c.x, c.y, c.z],
                size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z],
              },
              ndc: [ndc.x, ndc.y, ndc.z],
              fallbackMode,
              lastFitInfo,
            };
          };
        }

        // 音域回响 shader 输出线性颜色，保持 renderer 默认 sRGB 输出转换
        renderer.outputColorSpace = THREE.SRGBColorSpace;
     }

  // 中心光球（封面模式和音域回响不需要，粒子/柱体自发光足够）
   let glowSphere: any = null;
   if (mode !== 'cover3d' && mode !== 'sonic') {
     const glowGeo = new THREE.SphereGeometry(0.3, 32, 32);
     const glowMat2 = new THREE.MeshBasicMaterial({
       color: new THREE.Color(primaryColor),
       transparent: true,
       opacity: 0.8,
     });
     glowSphere = new THREE.Mesh(glowGeo, glowMat2);
     scene.add(glowSphere);
   }

  // 背景星尘（所有模式都加一点微弱远星，增加深度感）
  const bgStarsGeo = new THREE.BufferGeometry();
  const bgStarCount = Math.floor(particleCount * 0.3);
  const bgPositions = new Float32Array(bgStarCount * 3);
  for (let i = 0; i < bgStarCount; i++) {
    const i3 = i * 3;
    const r = 30 + Math.random() * 20;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    bgPositions[i3] = r * Math.sin(phi) * Math.cos(theta);
    bgPositions[i3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    bgPositions[i3 + 2] = r * Math.cos(phi);
  }
  bgStarsGeo.setAttribute('position', new THREE.BufferAttribute(bgPositions, 3));
  const bgStarsMat = new THREE.PointsMaterial({
    size: 0.03,
    color: 0x445566,
    transparent: true,
    opacity: 0.4,
    sizeAttenuation: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const bgStars = new THREE.Points(bgStarsGeo, bgStarsMat);
  scene.add(bgStars);
  extraObjects.push(bgStars);

  // 返回场景对象（先建立引用，便于 doRebuildSonic 等内部函数同步更新 particleSystem）
  const resultObj: any = {
    scene,
    camera,
    renderer,
    controls: null,
    hasBloom: false,
    pointLight,
    glowSphere,
    particleSystem,
    extraObjects,
    mode,
    tier,
    particleCount,
    bgStars,
    update: (freq: Uint8Array, delta: number, sens: number, simulated: boolean) => {
      if (updateFn) {
        // cover3d 模式：传入 beatBus kickEnvelope，让封面整体缩放与呼吸灯同源
        const kick = mode === 'cover3d' ? getBeatState().kickEnvelope : 0;
        updateFn(freq, delta, sens, simulated, kick);
      }
      // 背景星尘缓慢旋转
      bgStars.rotation.y += delta * 0.01;
      bgStars.rotation.x += delta * 0.005;
      // 中心光球随低频脉动（仅非封面/非 sonic 模式）
      if (glowSphere && pointLight) {
        const lowFreq = freq.length > 0 ? freq[0] / 255 : 0;
        const scale = 1 + lowFreq * sens * 1.5;
        glowSphere.scale.setScalar(scale);
        pointLight.intensity = 1.5 + lowFreq * sens * 3;
      }
    },
    updateColors: (prim: string, sec: string) => {
      if (pointLight) pointLight.color = new THREE.Color(prim);
      if (glowSphere && glowSphere.material) {
        glowSphere.material.color = new THREE.Color(prim);
      }
      // 更新粒子颜色（通过 uniform 或 material）
      if (particleSystem && particleSystem.material) {
        if (particleSystem.material.uniforms) {
          if (particleSystem.material.uniforms.color1) {
            particleSystem.material.uniforms.color1.value = new THREE.Color(prim);
          }
          if (particleSystem.material.uniforms.color2) {
            particleSystem.material.uniforms.color2.value = new THREE.Color(sec);
          }
        } else if (particleSystem.material.color) {
          particleSystem.material.color = new THREE.Color(prim);
        }
      }
      },
     rebuildCover: (url: string, track: any) => {
       if (rebuildCoverFn) rebuildCoverFn(url, track);
     },
      setCoverEffect: (params: any) => {
        if (particleSystem && typeof (particleSystem as any).setCoverEffect === 'function') {
          (particleSystem as any).setCoverEffect(params);
        }
      },
      getAudioMetrics: (): any => {
        if (particleSystem && typeof (particleSystem as any).getAudioMetrics === 'function') {
          return (particleSystem as any).getAudioMetrics();
        }
        return { lowLevel: 0, midLevel: 0, highLevel: 0, totalLevel: 0, kickEnvelope: 0, isKick: false, peakLevel: 0 };
      },
     fitSonicCamera: null as null | (() => void),
     getSonicDebugData: null as null | (() => any),
    };

  // sonic 模式：doRebuildSonic 需要同步更新 resultObj.particleSystem，
  // 否则 shader 检查遍历旧 root 会误判编译失败导致降级
  if (mode === 'sonic' && particleSystem && typeof (particleSystem as any).rebuildSonic === 'function') {
    const origRebuild = (particleSystem as any).rebuildSonic;
    (particleSystem as any).rebuildSonic = (params: any) => {
      origRebuild(params);
      // rebuild 后 particleSystem 局部变量已更新，同步到返回对象
      resultObj.particleSystem = particleSystem;
    };
  }

  return resultObj;
}

 // ===== 频谱分析辅助函数 =====
 function analyzeFrequency(freq: Uint8Array, out: any) {
   const len = freq.length;
   let lowSum = 0, midSum = 0, highSum = 0, totalSum = 0;
   const lowEnd = Math.floor(len * 0.15);
   const midEnd = Math.floor(len * 0.5);

   for (let i = 0; i < lowEnd; i++) lowSum += freq[i];
   for (let i = lowEnd; i < midEnd; i++) midSum += freq[i];
   for (let i = midEnd; i < len; i++) highSum += freq[i];
   for (let i = 0; i < len; i++) totalSum += freq[i];

   // 找峰值频率索引
   let peakIdx = 0;
   let peakVal = 0;
   for (let i = 0; i < len; i++) {
     if (freq[i] > peakVal) {
       peakVal = freq[i];
       peakIdx = i;
     }
   }

   out.low = lowSum / lowEnd / 255;
   out.mid = midSum / (midEnd - lowEnd) / 255;
   out.high = highSum / (len - midEnd) / 255;
   out.total = totalSum / len / 255;
   out.peak = peakVal / 255;
   out.peakIdx = peakIdx;
   out.peakFreqNorm = peakIdx / len;
   // 低频段峰值（用于鼓点检测，比平均值更灵敏）
   let lowPeakVal = 0;
   for (let i = 0; i < lowEnd; i++) {
     if (freq[i] > lowPeakVal) lowPeakVal = freq[i];
   }
   out.lowPeak = lowPeakVal / 255;
   return out;
 }

 // 单极平滑：攻击快、释放慢，用于减少频谱抖动
 function smoothFreq(current: number, smoothed: number, attack: number, release: number): number {
   if (current > smoothed) {
     return smoothed + (current - smoothed) * attack;
   }
   return smoothed + (current - smoothed) * release;
 }

// ===== 模式 1：3D 星河（旋臂结构）- 增强版 =====
function createGalaxy3D(THREE: any, count: number, primary: string, secondary: string) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const initialPositions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3); // 粒子速度（用于爆炸回弹物理）

  const primaryColor = new THREE.Color(primary);
  const secondaryColor = new THREE.Color(secondary);

  const arms = 4; // 旋臂数
  const armSpread = 0.6;

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const radius = Math.pow(Math.random(), 0.7) * 8 + 0.5; // 内密外疏
    const armAngle = (i % arms) / arms * Math.PI * 2;
    const spinAngle = radius * 0.35;
    const randomOffset = (Math.random() - 0.5) * armSpread * radius * 0.6;

    const angle = armAngle + spinAngle + randomOffset * 0.2;
    const ySpread = (Math.random() - 0.5) * 0.6 * (1 - radius / 10);

    const x = Math.cos(angle) * radius + (Math.random() - 0.5) * 0.6;
    const y = ySpread + (Math.random() - 0.5) * 0.25;
    const z = Math.sin(angle) * radius + (Math.random() - 0.5) * 0.6;

    positions[i3] = x;
    positions[i3 + 1] = y;
    positions[i3 + 2] = z;
    initialPositions[i3] = x;
    initialPositions[i3 + 1] = y;
    initialPositions[i3 + 2] = z;
    velocities[i3] = 0;
    velocities[i3 + 1] = 0;
    velocities[i3 + 2] = 0;

    // 颜色：内圈主色，外圈辅色，中间带白色高光
    const t = radius / 9;
    let r, g, b;
    if (t < 0.5) {
      const tt = t * 2;
      r = primaryColor.r * (1 - tt) + 1 * tt * 0.9;
      g = primaryColor.g * (1 - tt) + 1 * tt * 0.95;
      b = primaryColor.b * (1 - tt) + 1 * tt;
    } else {
      const tt = (t - 0.5) * 2;
      r = 0.9 * (1 - tt) + secondaryColor.r * tt;
      g = 0.95 * (1 - tt) + secondaryColor.g * tt;
      b = 1 * (1 - tt) + secondaryColor.b * tt;
    }
    colors[i3] = r;
    colors[i3 + 1] = g;
    colors[i3 + 2] = b;

    sizes[i] = Math.random() * 2.5 + 0.5;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.PointsMaterial({
    size: 0.07,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    sizeAttenuation: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

   const system = new THREE.Points(geometry, material);
   const positionsAttr = geometry.getAttribute('position');
   const sizesAttr = geometry.getAttribute('size');

   // 预生成粒子随机相位（用 sin 替代 Math.random，减少 GC + 更顺滑）
   const phases = new Float32Array(count);
   for (let i = 0; i < count; i++) phases[i] = Math.random() * Math.PI * 2;

   // 频谱分析复用对象（零分配）
   const freqOut: any = { low: 0, mid: 0, high: 0, total: 0, peak: 0, peakIdx: 0, peakFreqNorm: 0 };

   // 平滑频谱（攻击快、释放慢）
   let smLow = 0, smMid = 0, smHigh = 0, smTotal = 0;
   const ATTACK = 0.5;
   const RELEASE = 0.15;

   let prevLow = 0;
   let prevLow2 = 0; // 前前帧低频，用于连续上升确认

   const springForce = 8; // 弹簧劲度
   const damping = 4;   // 阻尼

   const update = (freq: Uint8Array, delta: number, sens: number, _simulated: boolean) => {
     // 缓慢自转（带摇摆感）
     system.rotation.y += delta * 0.12;
     system.rotation.x = Math.sin(performance.now() * 0.0001) * 0.1;

     analyzeFrequency(freq, freqOut);
     const lowFreq = freqOut.low;
     const midFreq = freqOut.mid;
     const total = freqOut.total;

     // 频谱平滑（用于视觉层，避免抖动）
     smLow = smoothFreq(lowFreq, smLow, ATTACK, RELEASE);
     smMid = smoothFreq(midFreq, smMid, ATTACK, RELEASE);
     smHigh = smoothFreq(freqOut.high, smHigh, ATTACK, RELEASE);
     smTotal = smoothFreq(total, smTotal, ATTACK, RELEASE);

     // 鼓点检测：低频连续两帧上升 + delta 超过阈值
     const lowDelta = Math.max(0, lowFreq - prevLow);
     const kick = (lowDelta > 0.12 && prevLow > prevLow2) ? lowDelta : 0;
     prevLow2 = prevLow;
     prevLow = lowFreq;

     const pos = positionsAttr.array as Float32Array;
     const vel = velocities;
     const sz = sizesAttr.array as Float32Array;

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const ox = initialPositions[i3];
      const oy = initialPositions[i3 + 1];
      const oz = initialPositions[i3 + 2];

      // 从原点到粒子的方向向量（单位）
      const dist = Math.sqrt(ox * ox + oy * oy + oz * oz) || 1;
      const nx = ox / dist;
      const ny = oy / dist;
      const nz = oz / dist;

      // 当前位移
      const cx = pos[i3] - ox;
      const cy = pos[i3 + 1] - oy;
      const cz = pos[i3 + 2] - oz;
      const currentExpansion = (cx * nx + cy * ny + cz * nz); // 沿法向的位移量

      // 弹簧加速度 F = -kx - dv
      const accel = -springForce * currentExpansion - damping * (vel[i3] * nx + vel[i3 + 1] * ny + vel[i3 + 2] * nz);

       // 鼓点冲击（用相位 + sin 替代 Math.random，更顺滑、零 GC）
       const impact = kick * sens * 20 * (0.8 + Math.sin(phases[i] * 3.7) * 0.2);
      vel[i3] += (accel * nx + impact * nx) * delta;
      vel[i3 + 1] += (accel * ny + impact * ny) * delta;
      vel[i3 + 2] += (accel * nz + impact * nz) * delta;

       // 中高频引起的微小抖动（让粒子有生命感）—— 用 sin 相位替代随机
       const jitter = smMid * sens * 0.02;
       vel[i3] += Math.sin(phases[i] + performance.now() * 0.005) * jitter;
       vel[i3 + 1] += Math.sin(phases[i] * 1.3 + performance.now() * 0.007) * jitter;
       vel[i3 + 2] += Math.cos(phases[i] * 0.7 + performance.now() * 0.004) * jitter;

      // 积分更新位置
      pos[i3] += vel[i3] * delta;
      pos[i3 + 1] += vel[i3 + 1] * delta;
      pos[i3 + 2] += vel[i3 + 2] * delta;

       // 粒子大小随总能量呼吸（相位化，避免噪点闪烁）
       sz[i] = (1.5 + Math.sin(phases[i] + performance.now() * 0.003) * 0.5) * (1 + smTotal * sens * 0.5);
     }
     positionsAttr.needsUpdate = true;
     sizesAttr.needsUpdate = true;
   };

  return { system, update };
}

// ===== 模式 2：3D 粒子球 - 增强版 =====
function createSphere3D(THREE: any, count: number, primary: string, secondary: string) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const basePositions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);

  const primaryColor = new THREE.Color(primary);
  const secondaryColor = new THREE.Color(secondary);

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    // 球面均匀分布（Fibonacci 球）
    const phi = Math.acos(1 - 2 * (i + 0.5) / count);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const baseRadius = 3 + Math.random() * 0.3;

    const x = baseRadius * Math.sin(phi) * Math.cos(theta);
    const y = baseRadius * Math.sin(phi) * Math.sin(theta);
    const z = baseRadius * Math.cos(phi);

    positions[i3] = x;
    positions[i3 + 1] = y;
    positions[i3 + 2] = z;
    basePositions[i3] = x;
    basePositions[i3 + 1] = y;
    basePositions[i3 + 2] = z;
    velocities[i3] = 0;
    velocities[i3 + 1] = 0;
    velocities[i3 + 2] = 0;

    // 颜色：上半球主色渐变到下半球辅色，赤道带高亮
    const t = (y / baseRadius + 1) / 2;
    const equator = 1 - Math.abs(t - 0.5) * 3; // 赤道附近更亮
    const eqBoost = Math.max(0, equator);
    let r = primaryColor.r * (1 - t) + secondaryColor.r * t;
    let g = primaryColor.g * (1 - t) + secondaryColor.g * t;
    let b = primaryColor.b * (1 - t) + secondaryColor.b * t;
    r += eqBoost * 0.3;
    g += eqBoost * 0.3;
    b += eqBoost * 0.3;
    colors[i3] = Math.min(1, r);
    colors[i3 + 1] = Math.min(1, g);
    colors[i3 + 2] = Math.min(1, b);
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 0.05,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    sizeAttenuation: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

   const system = new THREE.Points(geometry, material);
   const positionsAttr = geometry.getAttribute('position');

   // 预生成粒子相位
   const phases = new Float32Array(count);
   for (let i = 0; i < count; i++) phases[i] = Math.random() * Math.PI * 2;

   // 频谱分析复用对象
   const freqOut: any = { low: 0, mid: 0, high: 0, total: 0, peak: 0, peakIdx: 0, peakFreqNorm: 0 };
   let smLow = 0, smMid = 0, smHigh = 0, smTotal = 0;
   const ATTACK = 0.5;
   const RELEASE = 0.15;

   // 多层同心环（增加层次感）
   const rings: any[] = [];
   const ringColors = [secondary, primary, secondary];
   for (let r = 0; r < 3; r++) {
     const ringGeo = new THREE.TorusGeometry(4 + r * 1.0, 0.01, 8, 128);
     const ringMat = new THREE.MeshBasicMaterial({
       color: new THREE.Color(ringColors[r]),
       transparent: true,
       opacity: 0.25,
       blending: THREE.AdditiveBlending,
     });
     const ring = new THREE.Mesh(ringGeo, ringMat);
     ring.rotation.x = Math.PI / 2 + r * 0.4;
     ring.rotation.z = r * 0.6;
     rings.push(ring);
   }

   let prevLow = 0;
   let prevLow2 = 0;
   let pulseEnergy = 0;
   const springK = 10;
   const damping = 5;

   const update = (freq: Uint8Array, delta: number, sens: number, _simulated: boolean) => {
     system.rotation.y += delta * 0.12;
     system.rotation.x += delta * 0.03;

     analyzeFrequency(freq, freqOut);
     const lowFreq = freqOut.low;
     const midFreq = freqOut.mid;
     smLow = smoothFreq(lowFreq, smLow, ATTACK, RELEASE);
     smMid = smoothFreq(midFreq, smMid, ATTACK, RELEASE);
     smHigh = smoothFreq(freqOut.high, smHigh, ATTACK, RELEASE);
     smTotal = smoothFreq(freqOut.total, smTotal, ATTACK, RELEASE);

     // 鼓点检测（连续上升确认）
     const lowDelta = Math.max(0, lowFreq - prevLow);
     const kick = (lowDelta > 0.12 && prevLow > prevLow2) ? lowDelta : 0;
     prevLow2 = prevLow;
     prevLow = lowFreq;
     pulseEnergy += kick * sens * 2;
     pulseEnergy = Math.min(1.5, pulseEnergy);

    const pos = positionsAttr.array as Float32Array;
    const vel = velocities;

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const bx = basePositions[i3];
      const by = basePositions[i3 + 1];
      const bz = basePositions[i3 + 2];
      const dist = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
      const nx = bx / dist;
      const ny = by / dist;
      const nz = bz / dist;

      // 径向位移
      const cx = pos[i3] - bx;
      const cy = pos[i3 + 1] - by;
      const cz = pos[i3 + 2] - bz;
      const currentR = cx * nx + cy * ny + cz * nz;

       // 弹簧回弹
       const accel = -springK * currentR - damping * (vel[i3] * nx + vel[i3 + 1] * ny + vel[i3 + 2] * nz);
       const impact = kick * sens * 25 * (0.7 + Math.sin(phases[i] * 2.1) * 0.3);

       vel[i3] += (accel * nx + impact * nx) * delta;
       vel[i3 + 1] += (accel * ny + impact * ny) * delta;
       vel[i3 + 2] += (accel * nz + impact * nz) * delta;

       // 中高频引起的表面波动（沿切线方向，相位化更顺滑）
       const jitter = smMid * sens * 0.015;
       // 用一个伪随机切向量
       const tx = ny;
       const ty = nz;
       const tz = nx;
       const jv = Math.sin(phases[i] + performance.now() * 0.006) * jitter;
       vel[i3] += jv * tx;
       vel[i3 + 1] += jv * ty;
       vel[i3 + 2] += jv * tz;

      pos[i3] += vel[i3] * delta;
      pos[i3 + 1] += vel[i3 + 1] * delta;
      pos[i3 + 2] += vel[i3 + 2] * delta;
    }
    positionsAttr.needsUpdate = true;

     // 环的脉动与差速旋转（透明度 lerp 平滑）
     rings.forEach((ring, i) => {
       ring.rotation.x += delta * (0.15 + i * 0.08);
       ring.rotation.z += delta * (0.05 + i * 0.1);
       const ringScale = 1 + pulseEnergy * 0.3;
       ring.scale.setScalar(ringScale);
       const targetOpacity = 0.15 + smLow * sens * 0.4;
       ring.material.opacity += (targetOpacity - ring.material.opacity) * Math.min(1, delta * 5);
     });

    pulseEnergy *= Math.exp(-damping * delta);
  };

  return { system, extra: rings, update };
}

// ===== 模式 3：3D 频谱环 - 增强版 =====
function createRing3D(THREE: any, count: number, primary: string, secondary: string) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
   const baseHeights = new Float32Array(count);
   const angles = new Float32Array(count);
   const baseRadii = new Float32Array(count);

  const primaryColor = new THREE.Color(primary);
  const secondaryColor = new THREE.Color(secondary);

  const baseRadius = 3;
  const barCount = Math.min(count, 128);
  const barsPerRing = Math.floor(count / barCount);

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const barIdx = Math.floor(i / barsPerRing);
    const layerIdx = i % barsPerRing;

    const angle = (barIdx / barCount) * Math.PI * 2;
    const radius = baseRadius + layerIdx * 0.06;
    const height = 0;

    const x = Math.cos(angle) * radius;
    const y = height;
    const z = Math.sin(angle) * radius;

    positions[i3] = x;
    positions[i3 + 1] = y;
    positions[i3 + 2] = z;

    angles[i] = angle;
    baseRadii[i] = radius;
     baseHeights[i] = (Math.random() - 0.5) * 0.05;

    // 颜色：底部主色 → 顶部辅色渐变
    const t = layerIdx / barsPerRing;
    colors[i3] = primaryColor.r * (1 - t) + secondaryColor.r * t;
    colors[i3 + 1] = primaryColor.g * (1 - t) + secondaryColor.g * t;
    colors[i3 + 2] = primaryColor.b * (1 - t) + secondaryColor.b * t;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 0.06,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    sizeAttenuation: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const system = new THREE.Points(geometry, material);
  const positionsAttr = geometry.getAttribute('position');

  // 预生成粒子相位
  const phases = new Float32Array(count);
  for (let i = 0; i < count; i++) phases[i] = Math.random() * Math.PI * 2;

  // 频谱分析复用对象
  const freqOut: any = { low: 0, mid: 0, high: 0, total: 0, peak: 0, peakIdx: 0, peakFreqNorm: 0 };
  let smLow = 0, smMid = 0, smHigh = 0;
  const ATTACK = 0.5;
  const RELEASE = 0.15;

  // 中心地面圆盘 + 上方光晕环
  const discGeo = new THREE.RingGeometry(2.8, 3.2, 64);
  const discMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(primary),
    transparent: true,
    opacity: 0.2,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const disc = new THREE.Mesh(discGeo, discMat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = -0.5;

  // 顶部光晕环
  const haloGeo = new THREE.TorusGeometry(3.5, 0.02, 8, 128);
  const haloMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(secondary),
    transparent: true,
    opacity: 0.3,
    blending: THREE.AdditiveBlending,
  });
  const halo = new THREE.Mesh(haloGeo, haloMat);
  halo.rotation.x = Math.PI / 2;
  halo.position.y = 0.5;

   let prevLow = 0;
   let prevLow2 = 0;
   const smoothedFreq = new Float32Array(barCount);

   const update = (freq: Uint8Array, delta: number, sens: number, _simulated: boolean) => {
     system.rotation.y += delta * 0.15;
     disc.rotation.z += delta * 0.05;
     halo.rotation.z -= delta * 0.08;

     analyzeFrequency(freq, freqOut);
     const lowFreq = freqOut.low;
     smLow = smoothFreq(lowFreq, smLow, ATTACK, RELEASE);
     smMid = smoothFreq(freqOut.mid, smMid, ATTACK, RELEASE);
     smHigh = smoothFreq(freqOut.high, smHigh, ATTACK, RELEASE);

     // 鼓点检测（连续上升确认）
     const lowDelta = Math.max(0, lowFreq - prevLow);
     const kick = (lowDelta > 0.1 && prevLow > prevLow2) ? lowDelta : 0;
     prevLow2 = prevLow;
     prevLow = lowFreq;

    const pos = positionsAttr.array as Float32Array;
    const freqBinCount = Math.min(freq.length, barCount);

    // 频谱平滑（让柱状更柔和，不抖）
    for (let i = 0; i < barCount; i++) {
      const freqIdx = Math.min(i, freqBinCount - 1);
      const target = freq[freqIdx] / 255;
      // 攻击快、释放慢（包络跟随）
      if (target > smoothedFreq[i]) {
        smoothedFreq[i] += (target - smoothedFreq[i]) * Math.min(1, delta * 20);
      } else {
        smoothedFreq[i] += (target - smoothedFreq[i]) * Math.min(1, delta * 6);
      }
    }

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const barIdx = Math.floor(i / barsPerRing);
      const value = smoothedFreq[barIdx] || 0;
      const barHeight = value * 3.5 * sens + baseHeights[i];

      const angle = angles[i];
      const radius = baseRadii[i];

      // 上下对称延伸
      const yRatio = (i % barsPerRing) / barsPerRing - 0.5;
      const y = barHeight * yRatio * 2;

       // 鼓点冲击：粒子向外轻微扩散（相位化）
       const kickExpand = kick * sens * 0.5 * (0.8 + Math.sin(phases[i] * 2.9) * 0.2);
       const expandedR = radius * (1 + kickExpand);

      pos[i3] = Math.cos(angle) * expandedR;
      pos[i3 + 1] = y;
      pos[i3 + 2] = Math.sin(angle) * expandedR;
    }
    positionsAttr.needsUpdate = true;

     // 地面圆盘发光强度（lerp 平滑）
     const targetDiscOpacity = 0.12 + smLow * 0.5;
     discMat.opacity += (targetDiscOpacity - discMat.opacity) * Math.min(1, delta * 5);
     disc.scale.setScalar(1 + kick * sens * 0.3);
     const targetHaloOpacity = 0.2 + smMid * 0.4;
     haloMat.opacity += (targetHaloOpacity - haloMat.opacity) * Math.min(1, delta * 4);
     halo.scale.setScalar(1 + smHigh * 0.2);
  };

  return { system, extra: [disc, halo], update };
}

 // ===== 模式 4：专辑封面粒子（cover3d）=====
 // 密集粒子按封面图像素排列拼出整张封面，带 3D 波浪起伏，随音频律动
 function createCover3D(THREE: any, count: number, primary: string, secondary: string, initialCoverUrl: string) {
   // Mineradio 风格封面粒子 —— GPU Shader 实现
   // N×N 方格点云 + GLSL 顶点/片元着色器 + 双 Pass 自发光
   // 完全替换旧 CPU 逐粒子实现，外部契约保持不变
   return createCover3DShader(THREE, count, primary, secondary, initialCoverUrl);
 }
