import { useRef, useEffect, useState, useMemo } from 'react';
import { usePlayer } from '@/contexts/PlayerContext';
import { getBeatState } from '@/lib/beatBus';

interface Props {
  mode: 'bars' | 'particles' | 'circular' | 'cover2d' | 'wave' | 'customBg';
  primaryColor: string;
  secondaryColor: string;
  sensitivity: number;
  targetFps?: number;
  quality?: 'low' | 'mid' | 'high' | 'native';
  coverUrl?: string;
  cover2dScale?: number;
  cover2dGlow?: number;
  coverBeatSensitivity?: number;
}

export default function VisualizerCanvas({ mode, primaryColor, secondaryColor, sensitivity, targetFps = 0, quality = 'high', coverUrl, cover2dScale = 1, cover2dGlow = 1, coverBeatSensitivity = 0.25 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const lastFrameTimeRef = useRef<number>(0);
  const { getFrequencyData, isPlaying } = usePlayer();

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

  const coverImgRef = useRef<HTMLImageElement | null>(null);
  const coverLoadedRef = useRef(false);
  const coverParticlesRef = useRef<Array<{ angle: number; radius: number; speed: number; size: number; alpha: number; orbitOffset: number }>>([]);
  const rippleRingsRef = useRef<Array<{ radius: number; alpha: number; speed: number }>>([]);
  const particlesRef = useRef<Array<{ x: number; y: number; vx: number; vy: number; size: number; alpha: number; life: number; maxLife: number; angle?: number; radius?: number; speed?: number }>>([]);
  const timeRef = useRef(0);
  const smoothedFreqRef = useRef<Float32Array | null>(null);
  const barGradCacheRef = useRef<{ grad: CanvasGradient | null; primary: string; secondary: string; centerY: number; maxH: number }>({ grad: null, primary: '', secondary: '', centerY: 0, maxH: 0 });

  useEffect(() => {
    if (!coverUrl) { coverLoadedRef.current = false; coverImgRef.current = null; return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let cancelled = false;
    img.onload = () => { if (cancelled) return; coverImgRef.current = img; coverLoadedRef.current = true; };
    img.onerror = () => { if (cancelled) return; coverLoadedRef.current = false; coverImgRef.current = null; };
    img.src = coverUrl;
    return () => { cancelled = true; img.onload = null; img.onerror = null; };
  }, [coverUrl]);

  useEffect(() => {
    if (smoothedFreqRef.current) smoothedFreqRef.current.fill(0);
    barGradCacheRef.current.primary = '';
  }, [mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let width = 0, height = 0, dpr = 1;
    const MAX_DPR = 2;
    const MAX_PIXEL_WIDTH = 2560;

    const initParticles = () => {
      const maxParticles = 200;
      const count = Math.min(maxParticles, Math.floor((width * height) / 15000));
      const particles: typeof particlesRef.current = [];
      for (let i = 0; i < count; i++) {
        particles.push({ x: Math.random() * width, y: Math.random() * height, vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3, size: Math.random() * 2 + 1, alpha: Math.random() * 0.5 + 0.2, life: 0, maxLife: Math.random() * 200 + 100, angle: Math.random() * Math.PI * 2, radius: Math.random() * Math.min(width, height) * 0.4 + Math.min(width, height) * 0.1, speed: (Math.random() - 0.5) * 0.005 + 0.002 });
      }
      particlesRef.current = particles;
    };

    const initCoverParticles = () => {
      const count = Math.min(120, Math.floor(Math.min(width, height) / 6));
      const particles: typeof coverParticlesRef.current = [];
      const minR = Math.min(width, height) * 0.18;
      const maxR = Math.min(width, height) * 0.45;
      for (let i = 0; i < count; i++) {
        particles.push({ angle: Math.random() * Math.PI * 2, radius: minR + Math.random() * (maxR - minR), speed: (Math.random() - 0.5) * 0.004 + 0.0015, size: Math.random() * 2.5 + 1, alpha: Math.random() * 0.6 + 0.2, orbitOffset: Math.random() * Math.PI * 2 });
      }
      coverParticlesRef.current = particles;
    };

    const resize = () => {
      const nativeDpr = window.devicePixelRatio || 1;
      const q = qualityRef.current;
      const qualityDprMap: Record<string, number> = { low: 0.5, mid: 0.75, high: 1.0, native: 1.0 };
      const dprScale = qualityDprMap[q] ?? 1.0;
      dpr = Math.min(MAX_DPR, nativeDpr * dprScale);
      const rect = canvas.getBoundingClientRect();
      width = rect.width; height = rect.height;
      let effectiveDpr = dpr;
      if (width * effectiveDpr > MAX_PIXEL_WIDTH) effectiveDpr = MAX_PIXEL_WIDTH / width;
      canvas.width = Math.max(1, Math.floor(width * effectiveDpr));
      canvas.height = Math.max(1, Math.floor(height * effectiveDpr));
      ctx.setTransform(effectiveDpr, 0, 0, effectiveDpr, 0, 0);
      barGradCacheRef.current.primary = '';
      initParticles();
      initCoverParticles();
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let visible = !document.hidden;
    const onVisibilityChange = () => {
      const willShow = !document.hidden;
      if (willShow && !visible) { visible = true; lastFrameTimeRef.current = 0; rafRef.current = requestAnimationFrame(draw); }
      else if (!willShow && visible) { visible = false; cancelAnimationFrame(rafRef.current); }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const draw = () => {
      if (!visible) return;
      const tFps = targetFpsRef.current;
      const now = performance.now();
      if (tFps > 0) {
        const frameInterval = 1000 / tFps;
        if (now - lastFrameTimeRef.current < frameInterval) { rafRef.current = requestAnimationFrame(draw); return; }
      }
      lastFrameTimeRef.current = now;
      timeRef.current += 1;
      const rawFreq = getFrequencyData();
      if (!smoothedFreqRef.current || (rawFreq && smoothedFreqRef.current.length !== rawFreq.length)) {
        smoothedFreqRef.current = new Float32Array(rawFreq ? rawFreq.length : 64);
      }
      const smoothed = smoothedFreqRef.current;
      const playing = isPlayingRef.current;
      const decay = playing ? 0.75 : 0.92;
      if (rawFreq && rawFreq.length > 0 && playing) {
        for (let i = 0; i < smoothed.length; i++) smoothed[i] = smoothed[i] * decay + (rawFreq[i] || 0) * (1 - decay);
      } else {
        for (let i = 0; i < smoothed.length; i++) { smoothed[i] *= decay; if (smoothed[i] < 0.5) smoothed[i] = 0; }
      }
      const freq = smoothed;
      const sens = 0.5 + sensitivityRef.current / 100;
      const prim = primaryColorRef.current;
      const sec = secondaryColorRef.current;
      const m = modeRef.current;
      ctx.fillStyle = 'rgba(5, 10, 20, 0.15)';
      ctx.fillRect(0, 0, width, height);
      switch (m) {
        case 'customBg': ctx.fillStyle = 'rgba(5, 10, 20, 0.05)'; ctx.fillRect(0, 0, width, height); drawBottomSpectrumLine(ctx, freq, width, height, prim, sens); break;
        case 'bars': drawBars(ctx, freq, width, height, prim, sec, sens, barGradCacheRef); break;
        case 'particles': drawParticles(ctx, freq, width, height, prim, sec, sens, timeRef.current, particlesRef.current); break;
        case 'circular': drawCircular(ctx, freq, width, height, prim, sec, sens, timeRef.current); break;
        case 'wave': drawWave(ctx, freq, width, height, prim, sec, sens); break;
        case 'cover2d': drawCover2D(ctx, freq, width, height, prim, sec, sens, timeRef.current, coverImgRef.current, coverLoadedRef.current, coverParticlesRef.current, rippleRingsRef.current, cover2dScaleRef.current, cover2dGlowRef.current, coverBeatSensitivityRef.current); break;
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(rafRef.current); ro.disconnect(); document.removeEventListener('visibilitychange', onVisibilityChange); };
  }, [getFrequencyData]);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" style={{ display: 'block' }} />;
}

function drawBars(ctx: CanvasRenderingContext2D, freq: Float32Array, w: number, h: number, primary: string, secondary: string, sens: number, gradCacheRef?: { current: { grad: CanvasGradient | null; primary: string; secondary: string; centerY: number; maxH: number } }) {
  const barCount = Math.min(freq.length, 64);
  const barWidth = w / barCount * 0.7;
  const gap = w / barCount * 0.3;
  const centerY = h / 2;
  const maxBarHeight = h * 0.3 * sens;
  let grad: CanvasGradient | null = null;
  if (gradCacheRef) {
    const cache = gradCacheRef.current;
    if (cache.grad && cache.primary === primary && cache.secondary === secondary && cache.centerY === centerY && cache.maxH === maxBarHeight) { grad = cache.grad; }
    else {
      const g = ctx.createLinearGradient(0, centerY - maxBarHeight, 0, centerY + maxBarHeight);
      g.addColorStop(0, primary); g.addColorStop(0.5, secondary); g.addColorStop(1, primary);
      gradCacheRef.current = { grad: g, primary, secondary, centerY, maxH: maxBarHeight };
      grad = g;
    }
  } else {
    const g = ctx.createLinearGradient(0, centerY - maxBarHeight, 0, centerY + maxBarHeight);
    g.addColorStop(0, primary); g.addColorStop(0.5, secondary); g.addColorStop(1, primary);
    grad = g;
  }
  for (let i = 0; i < barCount; i++) {
    const value = freq[i] / 255;
    const barHeight = Math.max(0, value * maxBarHeight);
    const x = i * (barWidth + gap) + gap / 2;
    ctx.fillStyle = grad;
    ctx.shadowColor = primary;
    ctx.shadowBlur = 6;
    const r = barWidth / 2;
    if (barHeight > 0.5) {
      ctx.beginPath(); ctx.roundRect(x, centerY - barHeight, barWidth, barHeight, [r, r, 0, 0]); ctx.fill();
      ctx.beginPath(); ctx.roundRect(x, centerY, barWidth, barHeight, [0, 0, r, r]); ctx.fill();
    }
  }
  ctx.shadowBlur = 0;
  ctx.strokeStyle = primary + '40';
  ctx.lineWidth = 1;
  ctx.shadowBlur = 0;
  ctx.beginPath(); ctx.moveTo(0, centerY); ctx.lineTo(w, centerY); ctx.stroke();
}

type Particle = { x: number; y: number; vx: number; vy: number; size: number; alpha: number; life: number; maxLife: number; angle?: number; radius?: number; speed?: number };

function drawParticles(ctx: CanvasRenderingContext2D, freq: Float32Array, w: number, h: number, primary: string, secondary: string, sens: number, time: number, particles: Particle[]) {
  if (particles.length === 0) return;
  let lowFreq = 0;
  const lowCount = Math.floor(freq.length * 0.2);
  for (let i = 0; i < lowCount; i++) lowFreq += freq[i];
  lowFreq = lowFreq / lowCount / 255;
  let highFreq = 0;
  const highStart = Math.floor(freq.length * 0.6);
  for (let i = highStart; i < freq.length; i++) highFreq += freq[i];
  highFreq = highFreq / (freq.length - highStart) / 255;
  const cx = w / 2, cy = h / 2;
  const connectDist = 100 + lowFreq * 50;
  const cellSize = connectDist;
  const cols = Math.ceil(w / cellSize) || 1;
  const rows = Math.ceil(h / cellSize) || 1;
  const grid: number[][] = new Array(cols * rows);
  for (let i = 0; i < grid.length; i++) grid[i] = [];
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const cx2 = Math.min(cols - 1, Math.max(0, Math.floor(p.x / cellSize)));
    const cy2 = Math.min(rows - 1, Math.max(0, Math.floor(p.y / cellSize)));
    grid[cy2 * cols + cx2].push(i);
  }
  ctx.strokeStyle = primary + '20';
  ctx.lineWidth = 0.5;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const cell = grid[gy * cols + gx];
      if (cell.length === 0) continue;
      const neighbors = [cell, grid[gy * cols + (gx + 1)] || [], grid[(gy + 1) * cols + gx] || [], grid[(gy + 1) * cols + (gx + 1)] || [], grid[(gy + 1) * cols + (gx - 1)] || []];
      for (let i = 0; i < cell.length; i++) {
        const pi = cell[i];
        const p = particles[pi];
        for (let nb = 0; nb < neighbors.length; nb++) {
          const neighbor = neighbors[nb];
          const startJ = nb === 0 ? i + 1 : 0;
          for (let j = startJ; j < neighbor.length; j++) {
            const pj = neighbor[j];
            if (pi === pj) continue;
            const other = particles[pj];
            const dx = p.x - other.x, dy = p.y - other.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < connectDist * connectDist) {
              const dist = Math.sqrt(distSq);
              ctx.globalAlpha = (1 - dist / 150) * 0.3;
              ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(other.x, other.y); ctx.stroke();
            }
          }
        }
      }
    }
  }
  ctx.globalAlpha = 1;
  for (const p of particles) {
    const dx = p.x - cx, dy = p.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const force = lowFreq * sens * 2;
    p.x += (dx / dist) * force + Math.sin(time * 0.01 + p.angle!) * highFreq * 2;
    p.y += (dy / dist) * force + Math.cos(time * 0.01 + p.angle!) * highFreq * 2;
    p.x += (cx - p.x) * 0.005;
    p.y += (cy - p.y) * 0.005;
    p.x += p.vx; p.y += p.vy;
    if (p.x < -10) p.x = w + 10;
    if (p.x > w + 10) p.x = -10;
    if (p.y < -10) p.y = h + 10;
    if (p.y > h + 10) p.y = -10;
    const size = p.size * (1 + highFreq * sens * 2);
    const alpha = p.alpha * (0.6 + highFreq * 0.8 + lowFreq * 0.4);
    ctx.beginPath();
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, size * 3);
    grad.addColorStop(0, primary); grad.addColorStop(0.3, secondary + 'aa'); grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.globalAlpha = alpha;
    ctx.arc(p.x, p.y, size * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath(); ctx.fillStyle = '#ffffff'; ctx.globalAlpha = alpha * 0.9;
    ctx.arc(p.x, p.y, size * 0.6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  const glowSize = 20 + lowFreq * 80 * sens;
  const centerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowSize);
  centerGrad.addColorStop(0, primary + '60'); centerGrad.addColorStop(0.5, secondary + '30'); centerGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = centerGrad;
  ctx.beginPath(); ctx.arc(cx, cy, glowSize, 0, Math.PI * 2); ctx.fill();
}

function drawCircular(ctx: CanvasRenderingContext2D, freq: Float32Array, w: number, h: number, primary: string, secondary: string, sens: number, time: number) {
  const cx = w / 2, cy = h / 2;
  const baseRadius = Math.min(w, h) * 0.28;
  const maxAmp = baseRadius * 0.22 * sens;
  const points = 180;
  const freqLen = Math.min(freq.length, 64);
  const getSampledValue = (t: number): number => {
    const idx = t * (freqLen - 1);
    const i0 = Math.floor(idx), i1 = Math.min(freqLen - 1, i0 + 1);
    const f = idx - i0;
    return freq[i0] * (1 - f) + freq[i1] * f;
  };
  const radii = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const t = i / points;
    let val: number;
    if (t < 0.5) val = getSampledValue(t * 2);
    else val = getSampledValue((1 - t) * 2);
    const norm = val / 255;
    radii[i] = baseRadius + norm * maxAmp;
  }
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(time * 0.0015);
  const innerGrad = ctx.createRadialGradient(0, 0, baseRadius * 0.2, 0, 0, baseRadius * 1.1);
  innerGrad.addColorStop(0, primary + '25'); innerGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = innerGrad;
  ctx.beginPath(); ctx.arc(0, 0, baseRadius * 1.1, 0, Math.PI * 2); ctx.fill();
  const grad = ctx.createLinearGradient(-baseRadius, -baseRadius, baseRadius, baseRadius);
  grad.addColorStop(0, secondary); grad.addColorStop(0.5, primary); grad.addColorStop(1, secondary);
  ctx.strokeStyle = grad; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = primary; ctx.shadowBlur = 12;
  ctx.beginPath();
  for (let i = 0; i <= points; i++) {
    const i0 = i % points, i1 = (i + 1) % points;
    const a0 = (i0 / points) * Math.PI * 2, a1 = (i1 / points) * Math.PI * 2;
    const r0 = radii[i0], r1 = radii[i1];
    const x0 = Math.cos(a0) * r0, y0 = Math.sin(a0) * r0;
    const x1 = Math.cos(a1) * r1, y1 = Math.sin(a1) * r1;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    if (i === 0) ctx.moveTo(mx, my);
    else ctx.quadraticCurveTo(x0, y0, mx, my);
  }
  ctx.closePath(); ctx.stroke();
  ctx.strokeStyle = primary + '50'; ctx.lineWidth = 1; ctx.shadowBlur = 4;
  ctx.beginPath(); ctx.arc(0, 0, baseRadius * 0.72, 0, Math.PI * 2); ctx.stroke();
  ctx.restore(); ctx.shadowBlur = 0;
}

type CoverParticle = { angle: number; radius: number; speed: number; size: number; alpha: number; orbitOffset: number };
type RippleRing = { radius: number; alpha: number; speed: number };

function drawCover2D(ctx: CanvasRenderingContext2D, freq: Float32Array, w: number, h: number, primary: string, secondary: string, sens: number, time: number, coverImg: HTMLImageElement | null, coverLoaded: boolean, particles: CoverParticle[], rippleRings: RippleRing[], coverScale = 1, glowIntensity = 1, beatThreshold = 0.25) {
  const cx = w / 2, cy = h / 2;
  const minDim = Math.min(w, h);
  const baseCoverRadius = minDim * 0.16;
  const coverRadius = baseCoverRadius * coverScale;
  const beat = getBeatState();
  const kickPunch = Math.min(1.2, beat.kickEnvelope * 1.4);
  const bassBase = beat.lowPeak * 0.35;
  const bassLevel = Math.min(1, kickPunch + bassBase);
  const avgEnergy = beat.rms;
  let trebleSum = 0;
  const trebleStart = Math.floor(freq.length * 0.5);
  const trebleCount = freq.length - trebleStart;
  for (let i = trebleStart; i < freq.length; i++) trebleSum += freq[i];
  const trebleLevel = trebleSum / Math.max(1, trebleCount) / 255;
  const pulseScale = 1 + bassLevel * 0.08 * sens;
  const coverR = coverRadius * pulseScale;
  ctx.save();
  ctx.translate(cx, cy);
  const bgGlow = ctx.createRadialGradient(0, 0, coverR * 0.5, 0, 0, minDim * 0.7 * coverScale);
  bgGlow.addColorStop(0, primary + Math.floor(24 * glowIntensity).toString(16).padStart(2, '0'));
  bgGlow.addColorStop(0.4, secondary + Math.floor(12 * glowIntensity).toString(16).padStart(2, '0'));
  bgGlow.addColorStop(1, 'transparent');
  ctx.fillStyle = bgGlow;
  ctx.beginPath(); ctx.arc(0, 0, minDim * 0.7 * coverScale, 0, Math.PI * 2); ctx.fill();
  if (beat.justKicked && rippleRings.length < 6) {
    rippleRings.push({ radius: coverR * 1.05, alpha: 0.5, speed: 1.5 + avgEnergy * 2 });
  }
  for (let i = rippleRings.length - 1; i >= 0; i--) {
    const ring = rippleRings[i];
    ring.radius += ring.speed; ring.alpha -= 0.006;
    if (ring.alpha <= 0 || ring.radius > minDim * 0.6) { rippleRings.splice(i, 1); continue; }
    const ringGrad = ctx.createRadialGradient(0, 0, ring.radius - 2, 0, 0, ring.radius + 2);
    ringGrad.addColorStop(0, 'transparent');
    ringGrad.addColorStop(0.5, primary + Math.floor(ring.alpha * 255 * glowIntensity).toString(16).padStart(2, '0'));
    ringGrad.addColorStop(1, 'transparent');
    ctx.strokeStyle = ringGrad; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, ring.radius, 0, Math.PI * 2); ctx.stroke();
  }
  for (const p of particles) {
    p.angle += p.speed * (1 + avgEnergy * sens);
    const energyIdx = Math.floor(((p.angle / (Math.PI * 2)) + 1) % 1 * Math.min(freq.length, 64));
    const freqVal = freq[energyIdx] / 255 || 0;
    const dynamicR = p.radius + freqVal * coverR * 0.4 * sens;
    const px = Math.cos(p.angle) * dynamicR, py = Math.sin(p.angle) * dynamicR;
    const twinkle = 0.6 + Math.sin(time * 0.05 + p.orbitOffset) * 0.4;
    const size = p.size * (1 + freqVal * 1.5 * sens);
    const alpha = p.alpha * twinkle * (0.7 + trebleLevel * 0.6) * glowIntensity;
    const pGrad = ctx.createRadialGradient(px, py, 0, px, py, size * 3);
    pGrad.addColorStop(0, primary); pGrad.addColorStop(0.4, secondary + '99'); pGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = pGrad; ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.arc(px, py, size * 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.globalAlpha = alpha * 0.9;
    ctx.beginPath(); ctx.arc(px, py, size * 0.6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  const barCount = 72;
  const barInnerR = coverR * 1.15;
  const barMaxLen = coverR * 0.55 * sens;
  ctx.rotate(time * 0.0008);
  for (let i = 0; i < barCount; i++) {
    const angle = (i / barCount) * Math.PI * 2;
    const freqIdx = Math.floor((i / barCount) * Math.min(freq.length, 64));
    const val = freq[freqIdx] / 255 || 0;
    const barLen = val * barMaxLen;
    if (barLen < 0.5) continue;
    const x1 = Math.cos(angle) * barInnerR, y1 = Math.sin(angle) * barInnerR;
    const x2 = Math.cos(angle) * (barInnerR + barLen), y2 = Math.sin(angle) * (barInnerR + barLen);
    const barGrad = ctx.createLinearGradient(x1, y1, x2, y2);
    barGrad.addColorStop(0, primary); barGrad.addColorStop(1, secondary);
    ctx.strokeStyle = barGrad; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.shadowColor = primary; ctx.shadowBlur = 8 * glowIntensity;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.rotate(-time * 0.0008);
  ctx.beginPath(); ctx.arc(0, 0, coverR, 0, Math.PI * 2); ctx.closePath();
  if (coverLoaded && coverImg) {
    ctx.save(); ctx.clip();
    const imgW = coverImg.width, imgH = coverImg.height;
    const scale = Math.max((coverR * 2) / imgW, (coverR * 2) / imgH);
    const dw = imgW * scale, dh = imgH * scale;
    ctx.drawImage(coverImg, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  } else {
    const placeholderGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, coverR);
    placeholderGrad.addColorStop(0, secondary); placeholderGrad.addColorStop(1, primary);
    ctx.fillStyle = placeholderGrad; ctx.fill();
  }
  const borderWidth = 3 + bassLevel * 4 * sens;
  ctx.strokeStyle = primary; ctx.lineWidth = borderWidth;
  ctx.shadowColor = primary; ctx.shadowBlur = (15 + bassLevel * 20 * sens) * glowIntensity;
  ctx.beginPath(); ctx.arc(0, 0, coverR + borderWidth / 2, 0, Math.PI * 2); ctx.stroke();
  ctx.shadowBlur = 0;
  const innerShadow = ctx.createRadialGradient(0, 0, coverR * 0.8, 0, 0, coverR);
  innerShadow.addColorStop(0, 'transparent'); innerShadow.addColorStop(1, 'rgba(0,0,0,0.4)');
  ctx.fillStyle = innerShadow;
  ctx.beginPath(); ctx.arc(0, 0, coverR, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawWave(ctx: CanvasRenderingContext2D, freq: Float32Array, w: number, h: number, primary: string, secondary: string, sens: number) {
  const centerY = h / 2;
  const samples = Math.min(freq.length, 128);
  const step = w / samples;
  ctx.beginPath(); ctx.moveTo(0, centerY);
  for (let i = 0; i < samples; i++) {
    const value = freq[i] / 255;
    const amplitude = value * h * 0.35 * sens;
    const x = i * step;
    const y = centerY + Math.sin(i * 0.3 + value * Math.PI) * amplitude * 0.5;
    if (i === 0) ctx.moveTo(x, y);
    else {
      const prevX = (i - 1) * step;
      const prevVal = freq[i - 1] / 255;
      const prevAmp = prevVal * h * 0.35 * sens;
      const prevY = centerY + Math.sin((i - 1) * 0.3 + prevVal * Math.PI) * prevAmp * 0.5;
      const cpx = (prevX + x) / 2;
      ctx.quadraticCurveTo(prevX, prevY, cpx, (prevY + y) / 2);
    }
  }
  ctx.lineTo(w, centerY);
  ctx.strokeStyle = primary; ctx.lineWidth = 2;
  ctx.shadowColor = primary; ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < samples; i++) {
    const value = freq[Math.min(i + 20, freq.length - 1)] / 255;
    const amplitude = value * h * 0.25 * sens;
    const x = i * step;
    const y = centerY - Math.sin(i * 0.25 + value * Math.PI) * amplitude * 0.5;
    if (i === 0) ctx.moveTo(x, y);
    else {
      const prevX = (i - 1) * step;
      const prevVal = freq[Math.min(i + 19, freq.length - 1)] / 255;
      const prevAmp = prevVal * h * 0.25 * sens;
      const prevY = centerY - Math.sin((i - 1) * 0.25 + prevVal * Math.PI) * prevAmp * 0.5;
      const cpx = (prevX + x) / 2;
      ctx.quadraticCurveTo(prevX, prevY, cpx, (prevY + y) / 2);
    }
  }
  ctx.strokeStyle = secondary; ctx.lineWidth = 1.5;
  ctx.shadowColor = secondary; ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = primary + '20'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, centerY); ctx.lineTo(w, centerY); ctx.stroke();
}

function drawBottomSpectrumLine(ctx: CanvasRenderingContext2D, freq: Float32Array, w: number, h: number, primary: string, sensitivity: number) {
  const barCount = 64;
  const barWidth = w / barCount;
  const maxBarH = h * 0.12;
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
    grad.addColorStop(0, primary + '00'); grad.addColorStop(0.5, primary + '60'); grad.addColorStop(1, primary + 'aa');
    ctx.fillStyle = grad;
    ctx.fillRect(x + 1, y, barWidth - 2, barH);
  }
  ctx.restore();
}
