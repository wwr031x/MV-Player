import { useCallback, useState, useEffect, memo } from 'react';
import { toast } from 'sonner';
import { AlertCircle, RefreshCw, Disc3 } from 'lucide-react';
import { logger } from '@lark-apaas/client-toolkit-lite';
import { usePlayer } from '@/contexts/PlayerContext';
import { getCoverUrl } from '@/lib/netease';
import type { IVisualizerSettings } from '@/types';
import VisualizerCanvas from '@/components/VisualizerCanvas';
import { checkWebGLSupport, getWebGLStatus, resetWebGLStatus, loadThree } from '@/lib/visualizerManager';
import { Image } from '@/components/ui/image';

type Mode = IVisualizerSettings['mode'];

 interface VisualizerLayerProps {
   mode: Mode;
   primaryColor: string;
   secondaryColor: string;
   sensitivity: number;
   vizScale: number;
   vizOffsetX: number;
   vizOffsetY: number;
   targetFps: number;
   quality: IVisualizerSettings['quality'];
   coverParticleCount: number;
   coverBrightness: number;
   coverParticleSize: number;
   coverDensity: number;
    coverOpacity: number;
     coverTwist: number;
    coverScatter: number;
    coverSpeed: number;
    coverColorBoost: number;
    coverEdgeEnabled: boolean;
    coverPreset: number;
    coverIntensity: number;
    coverDepth: number;
    coverBloomStrength: number;
    coverStarRiver: boolean;
    coverBgFade: number;
    cover2dScale: number;
    cover2dGlow: number;
     coverBeatSensitivity: number;
     /** 歌词行数组 */
     lyricLines?: { time: number; text: string; translation?: string }[];
     /** 当前歌词句索引 */
     currentLyricIndex?: number;
     /** 歌词高亮色 */
     lyricColor?: string;
      isRecording: boolean;
     /** 用户自定义背景图/视频 URL（DataURL 或本地 URL），空串表示未设置 */
     bgImageUrl?: string;
     /** 背景类型：图片或视频 */
     bgImageType?: 'image' | 'video';
    /** 新手教程封面步专用：是否在无封面时显示白色半透明占位框 */
     showCoverPlaceholder?: boolean;
    on3DError?: (reason: string, detail: string) => void;
  }

function VisualizerLayer({
  mode,
  primaryColor,
  secondaryColor,
  sensitivity,
  vizScale,
  vizOffsetX,
  vizOffsetY,
  targetFps,
   quality,
   coverParticleCount,
   coverBrightness,
   coverParticleSize,
   coverDensity,
    coverOpacity,
     coverTwist,
    coverScatter,
    coverSpeed,
     coverColorBoost,
     coverEdgeEnabled,
     coverPreset,
     coverIntensity,
     coverDepth,
     coverBloomStrength,
     coverStarRiver,
     coverBgFade,
     cover2dScale,
     cover2dGlow,
     coverBeatSensitivity,
       lyricLines,
      currentLyricIndex,
      lyricColor,
      isRecording,
      bgImageUrl = '',
      bgImageType = 'image',
      showCoverPlaceholder = false,
    on3DError,
  }: VisualizerLayerProps) {
  const is3DMode = mode === 'galaxy3d' || mode === 'sphere3d' || mode === 'ring3d' || mode === 'cover3d';
  const { currentTrack } = usePlayer();
  const coverUrl = getCoverUrl(currentTrack) || '';

  // 模式名称映射（用于 toast 反馈）
  const modeLabel: Record<string, string> = {
    bars: '频谱柱',
     particles: '粒子星河',
     circular: '环形波形',
     cover2d: '封面粒子',
     galaxy3d: '3D星河',
    sphere3d: '3D粒子球',
    ring3d: '3D频谱环',
    cover3d: '专辑封面',
  };
  const [webglFailed, setWebglFailed] = useState(false);
  const [failReason, setFailReason] = useState<string>('');
  const [failDetail, setFailDetail] = useState<string>('');
  const [forceAttempt, setForceAttempt] = useState(false);
  const [ThreeVisualizer, setThreeVisualizer] = useState<React.ComponentType<any> | null>(null);
  const [threeLoading, setThreeLoading] = useState(false);

  // 2D 模式映射：3D 模式降级时对应一个 2D 模式
  const mode2D: 'bars' | 'particles' | 'circular' | 'cover2d' | 'wave' | 'customBg' =
    mode === 'cover2d' ? 'cover2d' :
    mode === 'wave' ? 'wave' :
    mode === 'customBg' ? 'customBg' :
    mode === 'galaxy3d' ? 'particles' :
    mode === 'sphere3d' ? 'circular' :
    mode === 'ring3d' ? 'circular' :
    mode === 'cover3d' ? 'cover2d' :
    mode;

  const handle3DFallback = useCallback((reason = '3D 渲染异常', detail = '') => {
    if (webglFailed) return;
    setWebglFailed(true);
    setFailReason(reason);
    setFailDetail(detail);
    const finalDetail = detail || '已自动降级为 2D 模式';
    toast.error(`${reason}，已降级为 2D 模式`);
    logger.warn('3D visualizer fallback to 2D:', reason, detail);
    on3DError?.(reason, finalDetail);
  }, [webglFailed, on3DError]);

  // 检查 WebGL 状态并在失败时记录原因
  useEffect(() => {
    if (!is3DMode) return;
    if (webglFailed || forceAttempt) return;
    const status = getWebGLStatus();
    if (!status.supported) {
      const reasonMap: Record<string, string> = {
        disabled: 'WebGL 被浏览器禁用',
        'context-create-failed': 'WebGL 上下文创建失败',
        exception: 'WebGL 检测异常',
      };
      handle3DFallback(reasonMap[status.reason] || 'WebGL 不可用', status.message);
    }
  }, [is3DMode, webglFailed, forceAttempt, handle3DFallback]);

  const handleForceAttempt = () => {
    resetWebGLStatus();
    setWebglFailed(false);
    setFailReason('');
    setFailDetail('');
    setThreeVisualizer(null);
    setForceAttempt(true);
    toast.info('正在强制尝试 3D 模式...');
  };

  // 3D 模式且 WebGL 支持时，懒加载 ThreeVisualizer
  useEffect(() => {
    const canRun3D = forceAttempt || checkWebGLSupport();
    if (!is3DMode || webglFailed || !canRun3D) {
      return;
    }
    if (ThreeVisualizer) return;

    let cancelled = false;
    setThreeLoading(true);

    // 超时兜底：8 秒还没加载完也关掉遮罩，避免永久卡在加载中
    const timeoutId = window.setTimeout(() => {
      if (!cancelled) {
        setThreeLoading(false);
        logger.warn('3D visualizer loading timeout, hiding spinner');
      }
    }, 8000);

    (async () => {
      try {
        // 先确保 three.js 可用
        await loadThree();
        // 动态 import 组件
        const mod = await import('@/components/ThreeVisualizer');
        if (!cancelled) {
          setThreeVisualizer(() => mod.default);
          // 注意：threeLoading 不由这里关闭，等 ThreeVisualizer onReady 回调
          // （组件内部还要初始化 WebGL / shader / 场景，这段时间遮罩应保留）
        }
       } catch (e) {
         logger.error('Failed to load 3D visualizer:', String(e));
         if (!cancelled) {
           setThreeLoading(false);
           const msg = String(e);
           if (msg.includes('shader') || msg.includes('Shader')) {
             handle3DFallback('着色器编译失败', msg);
           } else if (msg.includes('three') || msg.includes('module') || msg.includes('import')) {
             handle3DFallback('three 模块加载失败', msg);
           } else {
             handle3DFallback('3D 初始化失败', msg);
           }
         }
       }
    })();

     return () => {
       cancelled = true;
       window.clearTimeout(timeoutId);
     };
    }, [is3DMode, webglFailed, ThreeVisualizer, handle3DFallback, forceAttempt, mode]);

  // 3D 组件就绪回调：内部 WebGL / shader / 场景都初始化完了再关闭遮罩
  const handle3DReady = () => {
    setThreeLoading(false);
  };

  // 切换模式时重置 3D 失败状态，确保新模式干净加载
  useEffect(() => {
    if (is3DMode) {
      setWebglFailed(false);
      setFailReason('');
      setFailDetail('');
      setForceAttempt(false);
      toast.success(`已切换：${modeLabel[mode] || mode}`);
    }
     
  }, [mode]);

  // 计算可视化层的 transform（缩放 + 位移）
  const vizTransform = `translate(${vizOffsetX}%, ${vizOffsetY}%) scale(${vizScale})`;

  // 录制状态边框
  const recordingBorderClass = isRecording
    ? 'ring-2 ring-secondary/60 animate-pulse'
    : 'ring-1 ring-white/5';

  return (
    <div className="absolute inset-0 z-0 overflow-hidden">
      {/* 用户自定义背景（图片/视频）：object-contain 保持原比例，四周用感光毛玻璃放大版补全黑边 */}
      {bgImageUrl && (
        <>
          {/* 底层 1：超大强模糊放大层 —— 1.8 倍放大 + blur-3xl，填充四周并提取画面色彩晕染 */}
          {bgImageType === 'image' ? (
            <Image
              src={bgImageUrl}
              alt="bg-blur-strong"
              className="absolute inset-0 w-full h-full object-cover scale-[1.8] blur-3xl opacity-90"
              aria-hidden="true"
            />
          ) : (
            <video
              src={bgImageUrl}
              className="absolute inset-0 w-full h-full object-cover scale-[1.8] blur-3xl opacity-90"
              autoPlay
              loop
              muted
              playsInline
              aria-hidden="true"
            />
          )}
          {/* 底层 2：中等模糊放大层 —— 1.3 倍 + blur-xl，叠加增强层次与通透感 */}
          {bgImageType === 'image' ? (
            <Image
              src={bgImageUrl}
              alt="bg-blur-mid"
              className="absolute inset-0 w-full h-full object-cover scale-130 blur-xl opacity-70"
              aria-hidden="true"
            />
          ) : (
            <video
              src={bgImageUrl}
              className="absolute inset-0 w-full h-full object-cover scale-130 blur-xl opacity-70"
              autoPlay
              loop
              muted
              playsInline
              aria-hidden="true"
            />
          )}
          {/* 底层 3：全局压暗层 —— 把模糊层整体压暗 60%，形成深色玻璃质感，避免四周过亮抢主体 */}
          <div
            className="absolute inset-0 bg-black/60 pointer-events-none"
            aria-hidden="true"
          />
          {/* 中间层：径向暗角遮罩 —— 中心保留较多细节、四周进一步压暗，强化感光边框与氛围感 */}
          <div
            className="absolute inset-0 z-[1] pointer-events-none"
            style={{
              background:
                'radial-gradient(ellipse at center, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.5) 55%, rgba(0,0,0,0.75) 100%)',
            }}
            aria-hidden="true"
          />
          {/* 顶层：原始比例显示，不变形拉伸 + 细边框 + 投影强化主体轮廓 */}
          {bgImageType === 'image' ? (
            <div className="absolute inset-0 z-[2] flex items-center justify-center p-1 pointer-events-none">
              <Image
                src={bgImageUrl}
                alt="user-bg"
                className="max-w-full max-h-full object-contain rounded-sm shadow-[0_0_80px_rgba(0_0_0_0.6),0_0_40px_rgba(0_0_0_0.4)] ring-1 ring-white/10"
              />
            </div>
          ) : (
            <div className="absolute inset-0 z-[2] flex items-center justify-center p-1 pointer-events-none">
              <video
                src={bgImageUrl}
                className="max-w-full max-h-full object-contain rounded-sm shadow-[0_0_80px_rgba(0_0_0_0.6),0_0_40px_rgba(0_0_0_0.4)] ring-1 ring-white/10"
                autoPlay
                loop
                muted
                playsInline
              />
            </div>
          )}
        </>
      )}

      {/* 2D 画布始终挂载 —— 作为底层兜底，3D 模式下它也在下面（被 3D 盖住或透明时可见） */}
      <div
        className={`absolute inset-0 ${recordingBorderClass} transition-all duration-300`}
        style={{ transform: vizTransform, transformOrigin: 'center' }}
      >
        <VisualizerCanvas
          mode={mode2D}
          primaryColor={primaryColor}
          secondaryColor={secondaryColor}
          sensitivity={sensitivity}
          targetFps={targetFps}
          quality={quality}
          coverUrl={coverUrl}
          cover2dScale={cover2dScale}
          cover2dGlow={cover2dGlow}
          coverBeatSensitivity={coverBeatSensitivity}
        />
      </div>

       {/* 3D 画布 —— 仅 3D 模式且未失败（或强制尝试中）且组件加载成功时叠加 */}
       {is3DMode && !webglFailed && (forceAttempt || checkWebGLSupport()) && ThreeVisualizer && (
          <div
            className={`absolute inset-0 ${mode === 'cover3d' ? '' : 'pointer-events-none'}`}
            style={{ transform: vizTransform, transformOrigin: 'center' }}
            data-tour="cover-area"
          >
             <ThreeVisualizer
                key={`${mode}-coverpc-${coverParticleCount}`}
                mode={mode}
                primaryColor={primaryColor}
                secondaryColor={secondaryColor}
                sensitivity={sensitivity}
                coverParticleCount={coverParticleCount}
                coverBrightness={coverBrightness}
                coverParticleSize={coverParticleSize}
                coverDensity={coverDensity}
                coverOpacity={coverOpacity}
                coverTwist={coverTwist}
                coverScatter={coverScatter}
                coverSpeed={coverSpeed}
                coverColorBoost={coverColorBoost}
                coverEdgeEnabled={coverEdgeEnabled}
                coverPreset={coverPreset}
                coverIntensity={coverIntensity}
                coverDepth={coverDepth}
                coverBloomStrength={coverBloomStrength}
                coverStarRiver={coverStarRiver}
                coverBgFade={coverBgFade}
                lyricLines={lyricLines}
                currentLyricIndex={currentLyricIndex}
                lyricColor={lyricColor}
                onFallback={(reason?: string, detail?: string) => handle3DFallback(reason || '3D 渲染异常', detail || '')}
                onReady={handle3DReady}
              />
             {/* 新手教程封面步专用：无封面时显示白色半透明占位框，提示封面位置 */}
             {showCoverPlaceholder && mode === 'cover3d' && (
               <CoverPlaceholder />
             )}
         </div>
       )}

      {/* 3D 失败提示 */}
      {is3DMode && webglFailed && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10 p-6">
          <div className="max-w-sm w-full rounded-xl border border-red-500/30 bg-red-950/40 backdrop-blur-xl p-5 text-center space-y-4">
            <div className="flex items-center justify-center gap-2 text-red-400">
              <AlertCircle className="w-5 h-5" />
              <span className="font-medium">3D 模式不可用</span>
            </div>
            <div className="text-sm text-white/80">{failReason || '未知原因'}</div>
            {failDetail && (
              <div className="text-xs text-white/50 font-mono bg-black/30 rounded px-3 py-2 text-left break-all">
                {failDetail}
              </div>
            )}
            <div className="text-xs text-white/50">已自动降级为 2D 模式</div>
            <button
              onClick={handleForceAttempt}
              className="w-full py-2 rounded-lg bg-cyan-500/20 text-cyan-300 text-sm font-medium hover:bg-cyan-500/30 transition-colors border border-cyan-500/30 flex items-center justify-center gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              强制尝试 3D
            </button>
          </div>
        </div>
      )}

      {/* 3D 加载中遮罩 */}
      {is3DMode && !webglFailed && (forceAttempt || checkWebGLSupport()) && threeLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-10">
          <div className="text-white/60 text-sm">3D 模式加载中...</div>
        </div>
      )}
    </div>
  );
}

/**
 * CoverPlaceholder —— 新手教程专用封面占位框
 * - 仅当 showCoverPlaceholder=true 且 无封面时显示
 * - 居中白色半透明圆角正方形，带轻描边 + 提示文字
 * - 不影响封面粒子与其它 3D 渲染（z-index 高于 Three 但低于教程遮罩）
 */
function CoverPlaceholder() {
  // 依赖 usePlayer 判断当前曲目的封面是否存在
  const { currentTrack } = usePlayer();
  const hasCover = !!getCoverUrl(currentTrack);

  // 有真实封面时不显示占位框
  if (hasCover) return null;

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-[1]">
      <div className="relative">
        {/* 占位方形：白色半透明描边 + 极淡填充 */}
        <div className="w-48 h-48 md:w-64 md:h-64 rounded-2xl border-2 border-white/30 bg-white/5 backdrop-blur-sm flex items-center justify-center shadow-[0_0_40px_rgba(255_255_255_0.08)]">
          <Disc3 className="w-16 h-16 md:w-20 md:h-20 text-white/25" strokeWidth={1} />
        </div>
        {/* 下方提示文字 */}
        <div className="absolute -bottom-10 left-1/2 -translate-x-1/2 whitespace-nowrap text-sm text-white/60 font-medium">
          登录后专辑封面将显示在这里
        </div>
      </div>
    </div>
  );
}

export default memo(VisualizerLayer);
