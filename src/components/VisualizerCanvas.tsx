import { useRef, useEffect, useState, useMemo } from 'react';
import { usePlayer } from '@/contexts/PlayerContext';
import { getBeatState } from '@/lib/beatBus';

interface Props {
  mode: 'bars' | 'particles' | 'circular' | 'cover2d' | 'wave' | 'customBg';
  primaryColor: string;
  secondaryColor: string;
  sensitivity: number;
  /** 目标帧率（0=不限） */
  targetFps?: number;
  /** 画质档位 */
  quality?: 'low' | 'mid' | 'high' | 'native';
  /** 封面图片 URL（cover2d 模式使用） */
  coverUrl?: string;
  /** 封面缩放倍率（cover2d） */
  cover2dScale?: number;
  /** 封面光晕亮度（cover2d） */
  cover2dGlow?: number;
  /** 封面节拍触发阈值（越低越灵敏，默认 0.25） */
  coverBeatSensitivity?: number;
}
 
export default function VisualizerCanvas({ mode, primaryColor, secondaryColor, sensitivity, targetFps = 0, quality = 'high', coverUrl, cover2dScale = 1, cover2dGlow = 1, coverBeatSensitivity = 0.25 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const lastFrameTimeRef = useRef<number>(0);
  const { getFrequencyData, isPlaying, currentTime, duration, currentTrack } = usePlayer();

  // ===== 可视化参数 refs：调参实时生效，不销毁重建 RAF 循环 =====
  const modeRef = useRef(mode);
  const primaryColorRef = useRef(primaryColor);
  const secondaryColorRef = useRef(secondaryColor);
  const sensitivityRef = useRef(sensitivity);
  const targetFpsRef = useRef(targetFps);
  const qualityRef = useRef(quality);
  const cover2dScaleRef = useRef(cover2dScale);
  const cover2dGlowRef = useRef(cover2dGlow);
  const coverBeatSensitivityRef = useRef(coverBeatSensitivity);
  const isPlayingRef = useRef(isPlaying);

  // 同步 props 到 ref（实时生效，不触发重建）
  modeRef.current = mode;
  primaryColorRef.current = primaryColor;
  secondaryColorRef.current = secondaryColor;
  sensitivityRef.current = sensitivity;
  targetFpsRef.current = targetFps;
  qualityRef.current = quality;
  cover2dScaleRef.current = cover2dScale;
  cover2dGlowRef.current = cover2dGlow;
  coverBeatSensitivityRef.current = coverBeatSensitivity;
  isPlayingRef.current = isPlaying;

  // 封面图片缓存（cover2d 模式）
  const coverImgRef = useRef<HTMLImageElement | null>(null);
  const coverLoadedRef = useRef(false);
  // 封面模式环绕粒子
  const coverParticlesRef = useRef<Array<{
    angle: number; radius: number; speed: number;
    size: number; alpha: number; orbitOffset: number;
  }>>([]);
  // 波纹环
  const rippleRingsRef = useRef<Array<{ radius: number; alpha: number; speed: number }>>([]);

   // 粒子模式状态
   const particlesRef = useRef<Array<{
     x: number; y: number; vx: number; vy: number;
     size: number; alpha: number; life: number; maxLife: number;
     angle?: number; radius?: number; speed?: number;
   }>>([]);
   const timeRef = useRef(0);

   // 平滑衰减后的频谱缓存（用于暂停时逐步归零，避免冻结波形）
   const smoothedFreqRef = useRef<Float32Array | null>(null);

   // 柱状图渐变缓存（避免每帧新建 CanvasGradient 造成 GC 压力）
   const barGradCacheRef = useRef<{ grad: CanvasGradient | null; primary: string; secondary: string; centerY: number; maxH: number }>({
     grad: null, primary: '', secondary: '', centerY: 0, maxH: 0,
    });

   // ===== 封面图片加载（独立 effect，只跟 coverUrl 走）=====
  useEffect(() => {
    if (!coverUrl) {
      coverLoadedRef.current = false;
      coverImgRef.current = null;
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let cancelled = false;
    img.onload = () => {
      if (cancelled) return;
      coverImgRef.current = img;
      coverLoadedRef.current = true;
    };
    img.onerror = () => {
      if (cancelled) return;
      coverLoadedRef.current = false;
      coverImgRef.current = null;
    };
    img.src = coverUrl;
    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [coverUrl]);

  // ===== 切模式时清空平滑缓存，避免跨模式残留 =====
  useEffect(() => {
    if (smoothedFreqRef.current) {
      smoothedFreqRef.current.fill(0);
    }
    // 清空柱状图渐变缓存，让下一帧重建
    barGradCacheRef.current.primary = '';
  }, [mode]);

  // ===== 主渲染循环：仅初始化一次，参数通过 ref 读取 =====
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 尺寸用闭包变量，resize 时更新
    let width = 0;
    let height = 0;
    let dpr = 1;

    // DPR 上限：防止高 DPR 设备像素量爆炸
    const MAX_DPR = 2;
    const MAX_PIXEL_WIDTH = 2560; // 最大渲染宽度（像素），超出按比例降

    const initParticles = () => {
      // 粒子数量上限：避免超大屏时粒子数过多
      const maxParticles = 200;
      const count = Math.min(maxParticles, Math.floor((width * height) / 15000));
      const particles: typeof particlesRef.current = [];
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.3,
          vy: (Math.random() - 0.5) * 0.3,
          size: Math.random() * 2 + 1,
          alpha: Math.random() * 0.5 + 0.2,
          life: 0,
          maxLife: Math.random() * 200 + 100,
          angle: Math.random() * Math.PI * 2,
          radius: Math.random() * Math.min(width, height) * 0.4 + Math.min(width, height) * 0.1,
          speed: (Math.random() - 0.5) * 0.005 + 0.002,
        });
      }
      particlesRef.current = particles;
    };

    const initCoverParticles = () => {
      // 封面环绕粒子数量随尺寸调整，上限 120
      const count = Math.min(120, Math.floor(Math.min(width, height) / 6));
      const particles: typeof coverParticlesRef.current = [];
      const minR = Math.min(width, height) * 0.18;
      const maxR = Math.min(width, height) * 0.45;
      for (let i = 0; i < count; i++) {
        particles.push({
          angle: Math.random() * Math.PI * 2,
          radius: minR + Math.random() * (maxR - minR),
          speed: (Math.random() - 0.5) * 0.004 + 0.0015,
          size: Math.random() * 2.5 + 1,
          alpha: Math.random() * 0.6 + 0.2,
          orbitOffset: Math.random() * Math.PI * 2,
        });
      }
      coverParticlesRef.current = particles;
    };

    const resize = () => {
      const nativeDpr = window.devicePixelRatio || 1;
      const q = qualityRef.current;
      const qualityDprMap: Record<string, number> = {
        low: 0.5,
        mid: 0.75,
        high: 1.0,
        native: 1.0,
      };
      const dprScale = qualityDprMap[q] ?? 1.0;
      dpr = Math.min(MAX_DPR, nativeDpr * dprScale);

      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;

      // 最大像素宽度限制：超出则降低 dpr，保证填充率可控
      let effectiveDpr = dpr;
      if (width * effectiveDpr > MAX_PIXEL_WIDTH) {
        effectiveDpr = MAX_PIXEL_WIDTH / width;
      }

      canvas.width = Math.max(1, Math.floor(width * effectiveDpr));
      canvas.height = Math.max(1, Math.floor(height * effectiveDpr));
      ctx.setTransform(effectiveDpr, 0, 0, effectiveDpr, 0, 0);

      // 清空渐变缓存，尺寸变了需要重建
      barGradCacheRef.current.primary = '';

      initParticles();
      initCoverParticles();
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // 页面可见性变化：后台暂停 RAF，前台恢复
    let visible = !document.hidden;
    const onVisibilityChange = () => {
      const willShow = !document.hidden;
      if (willShow && !visible) {
        visible = true;
        lastFrameTimeRef.current = 0;
        rafRef.current = requestAnimationFrame(draw);
      } else if (!willShow && visible) {
        visible = false;
        cancelAnimationFrame(rafRef.current);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const draw = () => {
      if (!visible) return;

      // 帧率控制：targetFps > 0 时节流
      const tFps = targetFpsRef.current;
      const now = performance.now();
      if (tFps > 0) {
        const frameInterval = 1000 / tFps;
        if (now - lastFrameTimeRef.current < frameInterval) {
          rafRef.current = requestAnimationFrame(draw);
          return;
        }
      }
      lastFrameTimeRef.current = now;

      timeRef.current += 1;

      // 获取频谱数据
      const rawFreq = getFrequencyData();

      // 初始化平滑缓存
      if (!smoothedFreqRef.current || (rawFreq && smoothedFreqRef.current.length !== rawFreq.length)) {
        smoothedFreqRef.current = new Float32Array(rawFreq ? rawFreq.length : 64);
      }
      const smoothed = smoothedFreqRef.current;

      // 衰减系数：播放时快速跟随，暂停时缓慢衰减到 0
      const playing = isPlayingRef.current;
      const decay = playing ? 0.75 : 0.92;
      if (rawFreq && rawFreq.length > 0 && playing) {
        for (let i = 0; i < smoothed.length; i++) {
          smoothed[i] = smoothed[i] * decay + (rawFreq[i] || 0) * (1 - decay);
        }
      } else {
        // 暂停/无数据：平滑衰减到 0
        for (let i = 0; i < smoothed.length; i++) {
          smoothed[i] *= decay;
          if (smoothed[i] < 0.5) smoothed[i] = 0;
        }
      }

      const freq = smoothed;
      const sens = 0.5 + sensitivityRef.current / 100;
      const prim = primaryColorRef.current;
      const sec = secondaryColorRef.current;
      const m = modeRef.current;

      // 半透明背景（拖尾效果）
      ctx.fillStyle = 'rgba(5, 10, 20, 0.15)';
      ctx.fillRect(0, 0, width, height);

      switch (m) {
        case 'customBg':
          // 自定义背景模式：画布几乎全透明，让 DOM 层的背景/感光玻璃完全透出来
          // 底部画一条极淡的频谱条作点缀，保留可视化感
          ctx.fillStyle = 'rgba(5, 10, 20, 0.05)';
          ctx.fillRect(0, 0, width, height);
          drawBottomSpectrumLine(ctx, freq, width, height, prim, sens);
          break;
        case 'bars':
          drawBars(ctx, freq, width, height, prim, sec, sens, barGradCacheRef);
          break;
        case 'particles':
          drawParticles(ctx, freq, width, height, prim, sec, sens, timeRef.current, particlesRef.current);
          break;
        case 'circular':
          drawCircular(ctx, freq, width, height, prim, sec, sens, timeRef.current);
          break;
        case 'wave':
          drawWave(ctx, freq, width, height, prim, sec, sens);
          break;
        case 'cover2d':
          drawCover2D(
            ctx, freq, width, height, prim, sec, sens,
            timeRef.current, coverImgRef.current, coverLoadedRef.current,
            coverParticlesRef.current, rippleRingsRef.current,
            cover2dScaleRef.current, cover2dGlowRef.current, coverBeatSensitivityRef.current,
          );
          break;
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [getFrequencyData]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{ display: 'block' }}
    />
  );
}

 // ===== 频谱柱状图 =====
function drawBars(
   ctx: CanvasRenderingContext2D,
   freq: Float32Array,
   w: number,
   h: number,
   primary: string,
   secondary: string,
   sens: number,
   gradCacheRef?: { current: { grad: CanvasGradient | null; primary: string; secondary: string; centerY: number; maxH: number } },
 ) {
   const barCount = Math.min(freq.length, 64);
   const barWidth = w / barCount * 0.7;
   const gap = w / barCount * 0.3;
   const centerY = h / 2;
   // 最大柱高占画布比例（降低高度，避免铺满屏幕）
   const maxBarHeight = h * 0.3 * sens;

   // 渐变：有缓存且颜色/尺寸未变则复用，避免每帧新建 CanvasGradient
   let grad: CanvasGradient | null = null;
   if (gradCacheRef) {
     const cache = gradCacheRef.current;
     if (cache.grad && cache.primary === primary && cache.secondary === secondary &&
         cache.centerY === centerY && cache.maxH === maxBarHeight) {
       grad = cache.grad;
     } else {
       const g = ctx.createLinearGradient(0, centerY - maxBarHeight, 0, centerY + maxBarHeight);
       g.addColorStop(0, primary);
       g.addColorStop(0.5, secondary);
       g.addColorStop(1, primary);
       gradCacheRef.current = { grad: g, primary, secondary, centerY, maxH: maxBarHeight };
       grad = g;
     }
   } else {
     const g = ctx.createLinearGradient(0, centerY - maxBarHeight, 0, centerY + maxBarHeight);
     g.addColorStop(0, primary);
     g.addColorStop(0.5, secondary);
     g.addColorStop(1, primary);
     grad = g;
   }

   for (let i = 0; i < barCount; i++) {
     const value = freq[i] / 255;
     const barHeight = Math.max(0, value * maxBarHeight);
     const x = i * (barWidth + gap) + gap / 2;

     ctx.fillStyle = grad;
     ctx.shadowColor = primary;
     ctx.shadowBlur = 6;
     // 上下对称
     const r = barWidth / 2;
     if (barHeight > 0.5) {
       // 上半
       ctx.beginPath();
       ctx.roundRect(x, centerY - barHeight, barWidth, barHeight, [r, r, 0, 0]);
       ctx.fill();
       // 下半
       ctx.beginPath();
       ctx.roundRect(x, centerY, barWidth, barHeight, [0, 0, r, r]);
       ctx.fill();
     }
   }
   ctx.shadowBlur = 0;

   // 中心基线（即使暂停柱高为 0，也有一条细线）
   ctx.strokeStyle = primary + '40';
   ctx.lineWidth = 1;
   ctx.shadowBlur = 0;
   ctx.beginPath();
   ctx.moveTo(0, centerY);
   ctx.lineTo(w, centerY);
   ctx.stroke();
 }

// ===== 粒子星河 =====
type Particle = {
  x: number; y: number; vx: number; vy: number;
  size: number; alpha: number; life: number; maxLife: number;
  angle?: number; radius?: number; speed?: number;
};

 function drawParticles(
   ctx: CanvasRenderingContext2D,
   freq: Float32Array,
  w: number,
  h: number,
  primary: string,
  secondary: string,
   sens: number,
   time: number,
   particles: Particle[],
 ) {
  if (particles.length === 0) return;

  // 计算低频能量（决定爆发强度）
  let lowFreq = 0;
  const lowCount = Math.floor(freq.length * 0.2);
  for (let i = 0; i < lowCount; i++) lowFreq += freq[i];
  lowFreq = lowFreq / lowCount / 255;

  // 高频能量（决定闪烁）
  let highFreq = 0;
  const highStart = Math.floor(freq.length * 0.6);
  for (let i = highStart; i < freq.length; i++) highFreq += freq[i];
  highFreq = highFreq / (freq.length - highStart) / 255;

  const cx = w / 2;
  const cy = h / 2;

  // 画连接线（空间网格优化，避免 O(n²) 全量配对）
  const connectDist = 100 + lowFreq * 50;
  const cellSize = connectDist;
  const cols = Math.ceil(w / cellSize) || 1;
  const rows = Math.ceil(h / cellSize) || 1;
  const grid: number[][] = new Array(cols * rows);
  for (let i = 0; i < grid.length; i++) grid[i] = [];

  // 将粒子分配到网格
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(p.x / cellSize)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(p.y / cellSize)));
    grid[cy * cols + cx].push(i);
  }

  ctx.strokeStyle = primary + '20';
  ctx.lineWidth = 0.5;
  // 只检查当前粒子所在格 + 右/下/右下 3 个邻居格（去重）
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const cellIdx = gy * cols + gx;
      const cell = grid[cellIdx];
      if (cell.length === 0) continue;
      // 检查 4 个邻居格（右、下、右下、左下），共 9 邻居只查一半避免重复
      const neighbors = [
        cell,                              // 当前格内配对
        grid[gy * cols + (gx + 1)] || [],  // 右
        grid[(gy + 1) * cols + gx] || [],  // 下
        grid[(gy + 1) * cols + (gx + 1)] || [], // 右下
        grid[(gy + 1) * cols + (gx - 1)] || [], // 左下
      ];
      for (let i = 0; i < cell.length; i++) {
        const pi = cell[i];
        const p = particles[pi];
        for (let nb = 0; nb < neighbors.length; nb++) {
          const neighbor = neighbors[nb];
          // 同格内从 i+1 开始避免重复
          const startJ = nb === 0 ? i + 1 : 0;
          for (let j = startJ; j < neighbor.length; j++) {
            const pj = neighbor[j];
            if (pi === pj) continue;
            const other = particles[pj];
            const dx = p.x - other.x;
            const dy = p.y - other.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < connectDist * connectDist) {
              const dist = Math.sqrt(distSq);
              ctx.globalAlpha = (1 - dist / 150) * 0.3;
              ctx.beginPath();
              ctx.moveTo(p.x, p.y);
              ctx.lineTo(other.x, other.y);
              ctx.stroke();
            }
          }
        }
      }
    }
  }
  ctx.globalAlpha = 1;

  // 画粒子
  for (const p of particles) {
    // 基于频谱更新位置：低频爆发时粒子向外扩散
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const force = lowFreq * sens * 2;

    p.x += (dx / dist) * force + Math.sin(time * 0.01 + p.angle!) * highFreq * 2;
    p.y += (dy / dist) * force + Math.cos(time * 0.01 + p.angle!) * highFreq * 2;

    // 慢慢拉回
    p.x += (cx - p.x) * 0.005;
    p.y += (cy - p.y) * 0.005;

    // 随机漂移
    p.x += p.vx;
    p.y += p.vy;

    // 边界回绕
    if (p.x < -10) p.x = w + 10;
    if (p.x > w + 10) p.x = -10;
    if (p.y < -10) p.y = h + 10;
    if (p.y > h + 10) p.y = -10;

    // 大小闪烁
    const size = p.size * (1 + highFreq * sens * 2);
    const alpha = p.alpha * (0.6 + highFreq * 0.8 + lowFreq * 0.4);

    // 发光
    ctx.beginPath();
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, size * 3);
    grad.addColorStop(0, primary);
    grad.addColorStop(0.3, secondary + 'aa');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.globalAlpha = alpha;
    ctx.arc(p.x, p.y, size * 3, 0, Math.PI * 2);
    ctx.fill();

    // 核心
    ctx.beginPath();
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = alpha * 0.9;
    ctx.arc(p.x, p.y, size * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 中心光晕
  const glowSize = 20 + lowFreq * 80 * sens;
  const centerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowSize);
  centerGrad.addColorStop(0, primary + '60');
  centerGrad.addColorStop(0.5, secondary + '30');
  centerGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = centerGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, glowSize, 0, Math.PI * 2);
  ctx.fill();
}

 // ===== 环形波形（连续闭合波浪圆环） =====
 function drawCircular(
   ctx: CanvasRenderingContext2D,
   freq: Float32Array,
   w: number,
   h: number,
   primary: string,
   secondary: string,
   sens: number,
   time: number,
 ) {
   const cx = w / 2;
   const cy = h / 2;
   const baseRadius = Math.min(w, h) * 0.28;
   // 最大起伏幅度（相对 baseRadius 的比例）
   const maxAmp = baseRadius * 0.22 * sens;

   // 用 N 个采样点构建闭合波形（点数越多越平滑）
   const points = 180;

   // 将频谱数据重采样到 points 个点，并做镜像+环绕保证闭合平滑
   // 取低频到中频段（更有节奏感），首尾镜像拼接形成闭合环
   const sampleCount = Math.floor(points / 2);
   const freqLen = Math.min(freq.length, 64);

   const getSampledValue = (t: number): number => {
     // t: 0..1，映射到频谱索引 0..freqLen-1
     const idx = t * (freqLen - 1);
     const i0 = Math.floor(idx);
     const i1 = Math.min(freqLen - 1, i0 + 1);
     const f = idx - i0;
     return freq[i0] * (1 - f) + freq[i1] * f;
   };

   // 构建半径数组：0 ~ 2π 完整一圈，用频谱前半 + 镜像后半，保证首尾值相同（闭合平滑）
   const radii = new Float32Array(points);
   for (let i = 0; i < points; i++) {
     const t = i / points; // 0..1
     // 前半用正序频谱，后半用逆序频谱（镜像），首尾都在 t=0 和 t=1 处取同一个值
     let val: number;
     if (t < 0.5) {
       val = getSampledValue(t * 2); // 0..1 覆盖整个频谱
     } else {
       val = getSampledValue((1 - t) * 2); // 镜像
     }
     const norm = val / 255; // 0..1
     radii[i] = baseRadius + norm * maxAmp;
   }

   ctx.save();
   ctx.translate(cx, cy);
   // 缓慢旋转
   ctx.rotate(time * 0.0015);

   // 内圈光晕
   const innerGrad = ctx.createRadialGradient(0, 0, baseRadius * 0.2, 0, 0, baseRadius * 1.1);
   innerGrad.addColorStop(0, primary + '25');
   innerGrad.addColorStop(1, 'transparent');
   ctx.fillStyle = innerGrad;
   ctx.beginPath();
   ctx.arc(0, 0, baseRadius * 1.1, 0, Math.PI * 2);
   ctx.fill();

   // 绘制连续闭合波浪圆环（用二次贝塞尔曲线平滑）
   const grad = ctx.createLinearGradient(-baseRadius, -baseRadius, baseRadius, baseRadius);
   grad.addColorStop(0, secondary);
   grad.addColorStop(0.5, primary);
   grad.addColorStop(1, secondary);

   ctx.strokeStyle = grad;
   ctx.lineWidth = 2;
   ctx.lineCap = 'round';
   ctx.lineJoin = 'round';
   ctx.shadowColor = primary;
   ctx.shadowBlur = 12;

   ctx.beginPath();
   // 用二次贝塞尔连接相邻点的中点，形成平滑曲线
   // 起点：第 0 点和最后一点的中点（因为闭合，最后一点就是第 0 点附近）
   // 标准做法：依次计算相邻两点中点作为路径锚点，顶点作为控制点

   for (let i = 0; i <= points; i++) {
     const i0 = i % points;
     const i1 = (i + 1) % points;
     const a0 = (i0 / points) * Math.PI * 2;
     const a1 = (i1 / points) * Math.PI * 2;

     const r0 = radii[i0];
     const r1 = radii[i1];

     const x0 = Math.cos(a0) * r0;
     const y0 = Math.sin(a0) * r0;
     const x1 = Math.cos(a1) * r1;
     const y1 = Math.sin(a1) * r1;

     // 中点作为曲线锚点
     const mx = (x0 + x1) / 2;
     const my = (y0 + y1) / 2;

     if (i === 0) {
       ctx.moveTo(mx, my);
     } else {
       // 以上一段的终点为当前锚点，以 x0,y0 为控制点
       ctx.quadraticCurveTo(x0, y0, mx, my);
     }
   }
   ctx.closePath();
   ctx.stroke();

   // 内层细圈（静止时也有一圈细线，参考网易云效果）
   ctx.strokeStyle = primary + '50';
   ctx.lineWidth = 1;
   ctx.shadowBlur = 4;
   ctx.beginPath();
   ctx.arc(0, 0, baseRadius * 0.72, 0, Math.PI * 2);
   ctx.stroke();

   ctx.restore();
   ctx.shadowBlur = 0;
 }

// ===== Avee Player 风格封面粒子（2D） =====
type CoverParticle = {
  angle: number; radius: number; speed: number;
  size: number; alpha: number; orbitOffset: number;
};
type RippleRing = { radius: number; alpha: number; speed: number };

function drawCover2D(
  ctx: CanvasRenderingContext2D,
  freq: Float32Array,
  w: number,
  h: number,
  primary: string,
  secondary: string,
  sens: number,
  time: number,
  coverImg: HTMLImageElement | null,
  coverLoaded: boolean,
  particles: CoverParticle[],
  rippleRings: RippleRing[],
  coverScale = 1,
  glowIntensity = 1,
  beatThreshold = 0.25,
) {
  const cx = w / 2;
  const cy = h / 2;
  const minDim = Math.min(w, h);
  const baseCoverRadius = minDim * 0.16;
  const coverRadius = baseCoverRadius * coverScale;

  // 从 beatBus 读取节拍信号（与呼吸灯同源，严格同步）
  const beat = getBeatState();
  const kickPunch = Math.min(1.2, beat.kickEnvelope * 1.4);
  const bassBase = beat.lowPeak * 0.35;
  const bassLevel = Math.min(1, kickPunch + bassBase);
  const avgEnergy = beat.rms;

  // 封面脉冲 = 重拍脉冲（kick 驱动） + 微幅呼吸（低频能量驱动，密集鼓点兜底）
  // 设计：封面整体只做小幅、均匀、平滑的等比例膨胀回落（MR 风格），粒子级动态由 shader 内部完成。
  // 默认最大膨胀约 4.2%，安全上限约 8%。
  const beatPulse = kickPunch * 0.042 * sens;   // 重拍：最大 ~4.2% 放大
  const microBreath = beat.lowPeak * 0.025 * sens; // 微幅呼吸：~2.5% 持续微动
  const pulseScale = Math.min(1.08, 1 + beatPulse + microBreath); // 安全上限 8%
  const coverR = coverRadius * pulseScale;

  // 中高频能量用 treble 区间估算（保持 trebleLevel 用于闪烁效果）
  let trebleSum = 0;
  const trebleStart = Math.floor(freq.length * 0.5);
  const trebleCount = freq.length - trebleStart;
  for (let i = trebleStart; i < freq.length; i++) trebleSum += freq[i];
  const trebleLevel = trebleSum / Math.max(1, trebleCount) / 255;

  ctx.save();
  ctx.translate(cx, cy);

  // ===== 第1层：背景径向光晕（呼吸灯）=====
  // 呼吸灯与封面脉冲同源：kickPunch 驱动重拍扩张，lowPeak 提供微幅呼吸（密集鼓点兜底）
  const glowPulse = 1 + kickPunch * 0.12 + beat.lowPeak * 0.06;
  const glowRadius = minDim * 0.7 * coverScale * glowPulse;
  const glowAlphaInner = Math.min(0.35, 0.18 + kickPunch * 0.12 + beat.lowPeak * 0.08);
  const glowAlphaMid = Math.min(0.18, 0.08 + kickPunch * 0.08 + beat.lowPeak * 0.05);
  const bgGlow = ctx.createRadialGradient(0, 0, coverR * 0.5, 0, 0, glowRadius);
  bgGlow.addColorStop(0, primary + Math.floor(glowAlphaInner * 255 * glowIntensity).toString(16).padStart(2, '0'));
  bgGlow.addColorStop(0.4, secondary + Math.floor(glowAlphaMid * 255 * glowIntensity).toString(16).padStart(2, '0'));
  bgGlow.addColorStop(1, 'transparent');
  ctx.fillStyle = bgGlow;
  ctx.beginPath();
  ctx.arc(0, 0, glowRadius, 0, Math.PI * 2);
  ctx.fill();

  // ===== 第2层：波纹环（低音触发扩散） =====
  // 每到一个低音峰值添加新波纹（用 beatBus.justKicked 判定，与呼吸灯同源）
  if (beat.justKicked && rippleRings.length < 6) {
    rippleRings.push({
      radius: coverR * 1.05,
      alpha: 0.5,
      speed: 1.5 + avgEnergy * 2,
    });
  }
  // 用 beat.justKicked 代替 lastBass 比较，无需缓存

  // 更新并绘制波纹
  for (let i = rippleRings.length - 1; i >= 0; i--) {
    const ring = rippleRings[i];
    ring.radius += ring.speed;
    ring.alpha -= 0.006;
    if (ring.alpha <= 0 || ring.radius > minDim * 0.6) {
      rippleRings.splice(i, 1);
      continue;
    }
    const ringGrad = ctx.createRadialGradient(0, 0, ring.radius - 2, 0, 0, ring.radius + 2);
    ringGrad.addColorStop(0, 'transparent');
    ringGrad.addColorStop(0.5, primary + Math.floor(ring.alpha * 255 * glowIntensity).toString(16).padStart(2, '0'));
    ringGrad.addColorStop(1, 'transparent');
    ctx.strokeStyle = ringGrad;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, ring.radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  // ===== 第3层：环绕粒子 =====
  for (const p of particles) {
    // 旋转
    p.angle += p.speed * (1 + avgEnergy * sens);

    // 半径随能量波动
    const energyIdx = Math.floor(((p.angle / (Math.PI * 2)) + 1) % 1 * Math.min(freq.length, 64));
    const freqVal = freq[energyIdx] / 255 || 0;
    const dynamicR = p.radius + freqVal * coverR * 0.4 * sens;

    const px = Math.cos(p.angle) * dynamicR;
    const py = Math.sin(p.angle) * dynamicR;

    const twinkle = 0.6 + Math.sin(time * 0.05 + p.orbitOffset) * 0.4;
    const size = p.size * (1 + freqVal * 1.5 * sens);
    const alpha = p.alpha * twinkle * (0.7 + trebleLevel * 0.6) * glowIntensity;

    // 发光粒子
    const pGrad = ctx.createRadialGradient(px, py, 0, px, py, size * 3);
    pGrad.addColorStop(0, primary);
    pGrad.addColorStop(0.4, secondary + '99');
    pGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = pGrad;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(px, py, size * 3, 0, Math.PI * 2);
    ctx.fill();

    // 粒子核心
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = alpha * 0.9;
    ctx.beginPath();
    ctx.arc(px, py, size * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // ===== 第4层：环形频谱条（封面周围） =====
  const barCount = 72;
  const barInnerR = coverR * 1.15;
  const barMaxLen = coverR * 0.55 * sens;

  ctx.rotate(time * 0.0008); // 缓慢旋转

  for (let i = 0; i < barCount; i++) {
    const angle = (i / barCount) * Math.PI * 2;
    const freqIdx = Math.floor((i / barCount) * Math.min(freq.length, 64));
    const val = freq[freqIdx] / 255 || 0;
    const barLen = val * barMaxLen;

    if (barLen < 0.5) continue;

    const x1 = Math.cos(angle) * barInnerR;
    const y1 = Math.sin(angle) * barInnerR;
    const x2 = Math.cos(angle) * (barInnerR + barLen);
    const y2 = Math.sin(angle) * (barInnerR + barLen);

    const barGrad = ctx.createLinearGradient(x1, y1, x2, y2);
    barGrad.addColorStop(0, primary);
    barGrad.addColorStop(1, secondary);

    ctx.strokeStyle = barGrad;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.shadowColor = primary;
    ctx.shadowBlur = 8 * glowIntensity;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.rotate(-time * 0.0008); // 恢复旋转

  // ===== 第5层：封面圆形 =====
  ctx.beginPath();
  ctx.arc(0, 0, coverR, 0, Math.PI * 2);
  ctx.closePath();

  if (coverLoaded && coverImg) {
    ctx.save();
    ctx.clip();
    // 绘制封面图片（保持比例，居中裁剪）
    const imgW = coverImg.width;
    const imgH = coverImg.height;
    const scale = Math.max((coverR * 2) / imgW, (coverR * 2) / imgH);
    const dw = imgW * scale;
    const dh = imgH * scale;
    ctx.drawImage(coverImg, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  } else {
    // 无封面时的占位渐变
    const placeholderGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, coverR);
    placeholderGrad.addColorStop(0, secondary);
    placeholderGrad.addColorStop(1, primary);
    ctx.fillStyle = placeholderGrad;
    ctx.fill();
  }

  // ===== 第6层：封面发光边框 =====
  const borderWidth = 3 + bassLevel * 4 * sens;
  ctx.strokeStyle = primary;
  ctx.lineWidth = borderWidth;
  ctx.shadowColor = primary;
  ctx.shadowBlur = (15 + bassLevel * 20 * sens) * glowIntensity;
  ctx.beginPath();
  ctx.arc(0, 0, coverR + borderWidth / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // ===== 第7层：内阴影（立体感） =====
  const innerShadow = ctx.createRadialGradient(0, 0, coverR * 0.8, 0, 0, coverR);
  innerShadow.addColorStop(0, 'transparent');
  innerShadow.addColorStop(1, 'rgba(0,0,0,0.4)');
  ctx.fillStyle = innerShadow;
  ctx.beginPath();
  ctx.arc(0, 0, coverR, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// ===== 波形图 =====
function drawWave(
  ctx: CanvasRenderingContext2D,
  freq: Float32Array,
  w: number,
  h: number,
  primary: string,
  secondary: string,
  sens: number,
) {
  const centerY = h / 2;
  const samples = Math.min(freq.length, 128);
  const step = w / samples;

  // 主波形
  ctx.beginPath();
  ctx.moveTo(0, centerY);

  for (let i = 0; i < samples; i++) {
    const value = freq[i] / 255;
    const amplitude = value * h * 0.35 * sens;
    const x = i * step;
    const y = centerY + Math.sin(i * 0.3 + value * Math.PI) * amplitude * 0.5;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      const prevX = (i - 1) * step;
      const prevVal = freq[i - 1] / 255;
      const prevAmp = prevVal * h * 0.35 * sens;
      const prevY = centerY + Math.sin((i - 1) * 0.3 + prevVal * Math.PI) * prevAmp * 0.5;
      const cpx = (prevX + x) / 2;
      ctx.quadraticCurveTo(prevX, prevY, cpx, (prevY + y) / 2);
    }
  }
  ctx.lineTo(w, centerY);

  // 发光描边
  ctx.strokeStyle = primary;
  ctx.lineWidth = 2;
  ctx.shadowColor = primary;
  ctx.shadowBlur = 12;
  ctx.stroke();

  // 下方镜像波形（淡一点）
  ctx.beginPath();
  for (let i = 0; i < samples; i++) {
    const value = freq[Math.min(i + 20, freq.length - 1)] / 255;
    const amplitude = value * h * 0.25 * sens;
    const x = i * step;
    const y = centerY - Math.sin(i * 0.25 + value * Math.PI) * amplitude * 0.5;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      const prevX = (i - 1) * step;
      const prevVal = freq[Math.min(i + 19, freq.length - 1)] / 255;
      const prevAmp = prevVal * h * 0.25 * sens;
      const prevY = centerY - Math.sin((i - 1) * 0.25 + prevVal * Math.PI) * prevAmp * 0.5;
      const cpx = (prevX + x) / 2;
      ctx.quadraticCurveTo(prevX, prevY, cpx, (prevY + y) / 2);
    }
  }
  ctx.strokeStyle = secondary;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = secondary;
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 中心基线
  ctx.strokeStyle = primary + '20';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(w, centerY);
  ctx.stroke();
}

// ===== customBg 模式：底部极细频谱点缀线 =====
function drawBottomSpectrumLine(
  ctx: CanvasRenderingContext2D,
  freq: Float32Array,
  w: number,
  h: number,
  primary: string,
  sensitivity: number
) {
  const barCount = 64;
  const barWidth = w / barCount;
  const maxBarH = h * 0.12; // 最高占高度 12%
  const sens = sensitivity / 50;

  ctx.save();
  ctx.globalAlpha = 0.4;

  for (let i = 0; i < barCount; i++) {
    const freqIdx = Math.floor((i / barCount) * 64);
    const val = freq[freqIdx] / 255;
    const barH = Math.min(maxBarH, val * maxBarH * sens);
    const x = i * barWidth;
    const y = h - barH;

    const grad = ctx.createLinearGradient(0, h, 0, y);
    grad.addColorStop(0, primary + '00');
    grad.addColorStop(0.5, primary + '60');
    grad.addColorStop(1, primary + 'aa');
    ctx.fillStyle = grad;
    ctx.fillRect(x + 1, y, barWidth - 2, barH);
  }
  ctx.restore();
}
