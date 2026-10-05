// 全局节拍检测服务（beat service）
// 设计目标：把 onset/BPM/beatBus 的"生产端"从 BpmDetector 组件中抽离，
// 做成跟随播放器生命周期的全局单例服务，只要在播放、analyser 可用就持续运行，
// 与任何 UI 组件是否挂载、横竖屏、面板开关都无关。
//
// 写入方：本服务（每帧 RAF）
// 读取方：cover3d 可视化、BPM 小工具、HUD 等
//
// 使用方法：
//   const { bpm, confidence, pulse } = useBeatService({ getFrequencyData, sensitivity });
//   // 只需读取展示，启动/停止由 hook 内部管理
//
// 注意：
//   - 后台标签页（document.hidden）时自动暂停 RAF，节省资源
//   - 多次调用 hook 安全，内部只维持一个 RAF 循环（基于模块级单例）
//   - sensitivity 变化时实时生效（不需要重启）

import { useEffect, useRef, useState, useCallback } from 'react';
import { updateBeatLevel, triggerOnset, setBpm as writeBpmToBus, resetBeatBus, getBeatState, writeRmsPeak } from './beatBus';
import { getDiagnosticService } from './diagnosticService';

/**
 * 切歌时调用：平滑重置 BPM 检测状态与节拍总线
 * 保留 beatServiceRunning 状态（RAF 循环继续跑），仅清空历史数据
 */
export function resetBeatDetection() {
  resetBeatBus();
  lowHistory = 0;
  lowSmoothFast = 0;
  lowSmoothSlow = 0;
  cooldown = 0;
  lastFrameTime = 0;
  onsets = [];
  stableBpm = 0;
  stableSince = 0;
  lastBeatTime = 0;
  // 多线索检测新增状态
  prevLowAvg = 0;
  prevLowAvg2 = 0;
  fluxSmoothFast = 0;
  fluxSmoothSlow = 0;
  midLowSmoothFast = 0;
  midLowSmoothSlow = 0;
  adaptiveThresholdMean = 0.5;
  adaptiveThresholdVar = 0.1;
  onsetStrengths.length = 0;
  // 清空频谱缓存
  for (let i = 0; i < prevSpectrum.length; i++) prevSpectrum[i] = 0;
  try {
    const diag = getDiagnosticService();
    diag.setFields({
      beatServiceBpm: 0,
      beatServiceConfidence: 0,
    });
    diag.addLog('info', 'beatService', '切歌：BPM 检测与节拍总线已重置');
  } catch { /* ignore */ }
}

type GetFreqFn = () => Uint8Array | null;

// ===== 模块级单例状态 =====
// 保证多个 hook 调用共享同一个检测循环、同一份 BPM 结果
interface ServiceState {
  raf: number | null;
  running: boolean;
  getFrequencyData: GetFreqFn | null;
  sensitivity: number;
  // 回调订阅（用于驱动 React 状态更新，避免每帧 setState）
  subscribers: Set<(state: { bpm: number; confidence: number }) => void>;
  // 脉冲订阅（onset 触发时通知，用于小工具数字跳动等）
  pulseSubscribers: Set<() => void>;
}

const service: ServiceState = {
  raf: null,
  running: false,
  getFrequencyData: null,
  sensitivity: 100,
  subscribers: new Set(),
  pulseSubscribers: new Set(),
};

// 检测算法内部状态（闭包变量，跟随 RAF）
let lowHistory = 0;
let lowSmoothFast = 0;   // 快速跟踪的低频平滑（用于捕捉瞬态上升）
let lowSmoothSlow = 0;   // 慢速基线（用于对比）
let cooldown = 0;
let lastFrameTime = 0;
const WINDOW_MS = 10000;
let onsets: number[] = [];
let stableBpm = 0;
let stableSince = 0;
let lastBeatTime = 0;

// ====== 多线索 onset 检测增强（2025-09 重写） ======
// 低频上一帧值（用于帧间差分，捕捉快速上升）
let prevLowAvg = 0;
let prevLowAvg2 = 0;  // 上上帧
// 频谱通量（全频段正变化量之和）的 EMA，作为 onset 强度的通用指标
let fluxSmoothFast = 0;
let fluxSmoothSlow = 0;
// 中低频段（20-60% 频段）能量，用于辅助判断（底鼓只在低频时不一定够，军鼓/通鼓也有中低频能量）
let midLowSmoothFast = 0;
let midLowSmoothSlow = 0;
// 自适应阈值：基于最近 N 帧瞬态强度的均值+标准差动态设定
// 避免固定阈值在不同音乐风格下漏检或误检
let adaptiveThresholdMean = 0.5;
let adaptiveThresholdVar = 0.1;
// 最近的 onset 强度列表，用于统计自适应阈值
const onsetStrengths: number[] = [];
// 强拍越权：低频峰值显著超基线时即使接近冷却也触发
// 最小间隔分两档：普通 150ms，强拍越权 100ms（~400 BPM 上限）
// 上一帧频谱缓存（用于频谱通量计算）
let prevSpectrum: Uint8Array = new Uint8Array(1024);

// 倍频归整：映射到 [70, 180]
function octaveNormalize(bpm: number): number {
  if (bpm <= 0) return 0;
  let b = bpm;
  while (b < 70) b *= 2;
  while (b > 180) b /= 2;
  return b;
}

// 直方图 BPM 估计
function estimateBpm(times: number[]): { bpm: number; confidence: number } {
  if (times.length < 4) return { bpm: 0, confidence: 0 };
  const intervals: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const iv = times[i] - times[i - 1];
    if (iv >= 200 && iv <= 1500) intervals.push(iv);
  }
  if (intervals.length < 3) return { bpm: 0, confidence: 0 };

  const BUCKET_MS = 20;
  const buckets = new Map<number, number>();
  for (const iv of intervals) {
    const key = Math.round(iv / BUCKET_MS) * BUCKET_MS;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  let bestKey = 0;
  let bestCount = 0;
  for (const [key, cnt] of buckets) {
    if (cnt > bestCount) { bestCount = cnt; bestKey = key; }
  }
  if (bestCount < 2) return { bpm: 0, confidence: 0 };

  let sumIv = 0;
  let sumCnt = 0;
  for (const [key, cnt] of buckets) {
    if (Math.abs(key - bestKey) <= BUCKET_MS) {
      sumIv += key * cnt;
      sumCnt += cnt;
    }
  }
  if (sumCnt === 0) return { bpm: 0, confidence: 0 };

  const avgInterval = sumIv / sumCnt;
  const rawBpm = 60000 / avgInterval;
  const normalizedBpm = octaveNormalize(rawBpm);
  const consistency = sumCnt / intervals.length;
  const density = Math.min(1, times.length / 12);
  const conf = consistency * 0.7 + density * 0.3;

  return { bpm: Math.round(normalizedBpm), confidence: Math.min(1, conf) };
}

function detect() {
  if (!service.running || !service.getFrequencyData) {
    service.raf = requestAnimationFrame(detect);
    return;
  }

  const data = service.getFrequencyData();
  if (!data || data.length === 0) {
    service.raf = requestAnimationFrame(detect);
    return;
  }

  const sens = service.sensitivity / 100;

  // 全频段 RMS / 峰值计算（用于诊断 + 可视化基准）
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] || 0;
    sumSq += v * v;
    if (v > peak) peak = v;
  }
  const rms = Math.sqrt(sumSq / data.length) / 255;
  const peakNorm = peak / 255;

  // 低频段能量（取前 15% 频点，对应约 0~1.3kHz，覆盖底鼓 fundamental + 低次谐波）
  const bassEnd = Math.max(3, Math.floor(data.length * 0.15));
  // 中低频段（15%~35%）：覆盖军鼓低频分量、通鼓、bass 高次谐波
  const midLowEnd = Math.max(bassEnd + 2, Math.floor(data.length * 0.35));
  let lowPeak = 0;
  let lowSum = 0;
  let midLowSum = 0;
  for (let i = 0; i < bassEnd; i++) {
    const v = data[i] || 0;
    if (v > lowPeak) lowPeak = v;
    lowSum += v;
  }
  for (let i = bassEnd; i < midLowEnd; i++) {
    midLowSum += data[i] || 0;
  }
  const lowAvg = (lowSum / bassEnd) / 255;      // 低频平均能量 0-1
  const lowPeakNorm = (lowPeak / 255) * sens;  // 低频峰值（灵敏度加权）
  const midLowAvg = (midLowSum / Math.max(1, midLowEnd - bassEnd)) / 255 * sens;

  // ====== 频谱通量（spectral flux）：全频段正变化量之和 ======
  // 这是 onset 检测的通用指标，任何频段的能量上升都能捕捉到，
  // 弥补单纯靠低频判断时军鼓/hi-hat/cymbal 漏检的问题。
  let flux = 0;
  const fluxEnd = Math.floor(data.length * 0.7); // 取前 70% 频段，极高音噪声多
  for (let i = 0; i < fluxEnd; i++) {
    const diff = (data[i] || 0) - (prevSpectrum[i] || 0);
    if (diff > 0) flux += diff;
  }
  flux = flux / 255 / fluxEnd; // 归一化到 0-1 左右
  // 更新上一帧频谱缓存（只更新用到的频段）
  for (let i = 0; i < fluxEnd; i++) prevSpectrum[i] = data[i] || 0;

  // 通量双时间常数平滑
  const fluxFast = flux > fluxSmoothFast
    ? fluxSmoothFast * 0.1 + flux * 0.9
    : fluxSmoothFast * 0.6 + flux * 0.4;
  const fluxSlow = flux > fluxSmoothSlow
    ? fluxSmoothSlow * 0.92 + flux * 0.08
    : fluxSmoothSlow * 0.98 + flux * 0.02;
  fluxSmoothFast = fluxFast;
  fluxSmoothSlow = fluxSlow;
  const fluxRatio = fluxSlow > 0.002 ? fluxFast / fluxSlow : 1;

  // 双时间常数平滑：快跟踪 + 慢基线（低频）
  // fast: attack 快 release 中，快速跟随鼓点上升
  // slow: attack 慢 release 极慢，作为"最近平均水平"的基线
  const fastAttack = 0.85, fastRelease = 0.25;   // 快速包络
  const slowAttack = 0.06, slowRelease = 0.012;  // 慢速基线（比之前更慢，基线更稳）
  const lowAvgSens = lowAvg * sens;
  if (lowAvgSens > lowSmoothFast) {
    lowSmoothFast = lowSmoothFast * (1 - fastAttack) + lowAvgSens * fastAttack;
  } else {
    lowSmoothFast = lowSmoothFast * (1 - fastRelease) + lowAvgSens * fastRelease;
  }
  if (lowAvgSens > lowSmoothSlow) {
    lowSmoothSlow = lowSmoothSlow * (1 - slowAttack) + lowAvgSens * slowAttack;
  } else {
    lowSmoothSlow = lowSmoothSlow * (1 - slowRelease) + lowAvgSens * slowRelease;
  }

  // 中低频段双时间常数（辅助线索）
  if (midLowAvg > midLowSmoothFast) {
    midLowSmoothFast = midLowSmoothFast * 0.6 + midLowAvg * 0.4;
  } else {
    midLowSmoothFast = midLowSmoothFast * 0.85 + midLowAvg * 0.15;
  }
  if (midLowAvg > midLowSmoothSlow) {
    midLowSmoothSlow = midLowSmoothSlow * 0.95 + midLowAvg * 0.05;
  } else {
    midLowSmoothSlow = midLowSmoothSlow * 0.99 + midLowAvg * 0.01;
  }
  const midLowRatio = midLowSmoothSlow > 0.01 ? midLowSmoothFast / midLowSmoothSlow : 1;

  // 帧间差分发（2 帧差分）：快速上升的瞬态会有很大的正值
  const lowDelta = lowAvgSens - prevLowAvg;
  const lowDelta2 = lowAvgSens - prevLowAvg2;  // 相对两帧前的增量
  prevLowAvg2 = prevLowAvg;
  prevLowAvg = lowAvgSens;

  // 长时平均（保留用于诊断显示，不作为触发主依据）
  lowHistory = lowHistory * 0.97 + lowPeakNorm * 0.03;
  cooldown = Math.max(0, cooldown - 1 / 60);

  const now = performance.now();
  const delta = lastFrameTime ? Math.min(0.1, (now - lastFrameTime) / 1000) : 0.016;
  lastFrameTime = now;

  // 写入 beatBus：每帧更新低频峰值 + kick 包络衰减
  updateBeatLevel(lowPeakNorm, delta);
  // 同时写入总频段 RMS/峰值，供电平小工具与看门狗使用
  writeRmsPeak(rms, peakNorm);

  // ===== Onset 检测（多线索融合 + 自适应阈值）=====
  // 线索 A：低频瞬态比值法 —— 快速包络相对慢速基线的比值
  // 线索 B：低频绝对强度 + 快速上升（帧间差分）
  // 线索 C：频谱通量比值法 —— 全频段正变化量的突然增加（捕捉军鼓/镲等高频瞬态）
  // 线索 D：中低频段比值法 —— 军鼓/通鼓在中低频有明显能量上升
  // 多线索任一达到强阈值即触发；或多线索同时达弱阈值也触发（提高召回率）

  const baseLine = Math.max(0.012, lowSmoothSlow);
  const ratio = lowSmoothFast / baseLine;

  // ---- 自适应阈值 ----
  // 用最近 onset 强度的均值 + 标准差动态计算触发阈值
  // 音乐越激烈（瞬态多），阈值自动抬高减少误检；
  // 音乐越柔和（瞬态少），阈值自动降低避免漏检。
  // 基础比值阈值：自适应均值 × 0.7，或固定 1.12，取较低者（保证最低灵敏度）
  let ratioThreshold = Math.min(1.12, Math.max(1.04, adaptiveThresholdMean * 0.65));
  // 绝对强度阈值：低频平均 > 0.3 且增量 > 0.06 也触发（比之前更宽松）
  const absLowTrigger = lowAvgSens > 0.30 && lowDelta > 0.06 && lowDelta2 > 0.04;
  // 通量比值阈值
  const fluxThreshold = Math.min(1.5, Math.max(1.2, adaptiveThresholdMean * 0.9));
  const fluxTrigger = fluxRatio > fluxThreshold && fluxFast > 0.015;
  // 中低频辅助触发（只有当低频也有一定反应时才计入，避免纯高频误触发）
  const midLowTrigger = midLowRatio > 1.15 && ratio > 1.06 && lowPeakNorm > 0.08;
  // 强拍越权：低频峰值非常大且快速上升，直接判定为强拍
  const strongKick = lowPeakNorm > 0.6 && lowDelta > 0.10 && lowDelta2 > 0.06;

  // 普通最小间隔 150ms（~400 BPM），比之前 180ms 更短，覆盖快鼓点
  const minInterval = 150;
  // 强拍越权最小间隔 90ms（~666 BPM），极端快鼓点也能触发
  const strongMinInterval = 90;
  const timeSinceLast = now - lastBeatTime;

  // ---- 融合判断 ----
  // 主触发：比值 > 阈值 或 绝对强度触发 或 强拍越权
  const primaryTrigger = ratio > ratioThreshold || absLowTrigger || strongKick;
  // 辅助触发：通量触发 + （中低频或低频有一定反应）—— 作为补充提高召回
  const secondaryTrigger = fluxTrigger && (ratio > 1.04 || midLowTrigger);
  // 联合触发：多线索弱信号同时出现（比值+通量+中低频都有点反应但都没到阈值）
  const combinedTrigger = ratio > 1.06 && fluxRatio > 1.25 && midLowRatio > 1.08 && lowPeakNorm > 0.1;

  let isOnset = false;
  let isStrong = false;

  if (primaryTrigger || secondaryTrigger || combinedTrigger) {
    // 时间间隔检查
    if (strongKick) {
      // 强拍越权：间隔较短也触发
      isOnset = timeSinceLast > strongMinInterval && cooldown <= 0;
      isStrong = true;
    } else {
      // 普通触发：正常最小间隔
      if (timeSinceLast > minInterval && cooldown <= 0) {
        // 但如果只是 secondary（通量单独触发且低频很弱），额外加一道门限
        // 防止纯高频噪声误判为鼓点
        if (secondaryTrigger && !primaryTrigger && !combinedTrigger) {
          // 次级触发要求低频至少有轻微上升，避免纯 hi-hat 噪音也触发大脉冲
          if (ratio > 1.03 && lowPeakNorm > 0.05) {
            isOnset = true;
          }
        } else {
          isOnset = true;
        }
      }
    }
  }

  // 最低能量兜底：低频峰值太小一律不触发（噪声防护）
  if (lowPeakNorm < 0.03 && !strongKick) isOnset = false;

  if (isOnset) {
    lastBeatTime = now;
    onsets.push(now);
    cooldown = isStrong ? 0.08 : 0.10;  // cooldown 更短（之前 0.12），快鼓点不易被吞
    // 脉冲强度：以 ratio 偏离量 + 绝对强度 + 通量综合计算，0.4 ~ 2.0 范围
    const ratioBoost = Math.max(0, Math.min(1.2, (ratio - 1) * 1.5));
    const absBoost = Math.min(0.6, lowPeakNorm * 0.8);
    const fluxBoost = Math.min(0.4, Math.max(0, (fluxRatio - 1) * 0.5));
    const strongBoost = isStrong ? 0.3 : 0;
    const kickStrength = Math.min(2.0, 0.4 + ratioBoost + absBoost + fluxBoost + strongBoost);
    triggerOnset(kickStrength);

    // ---- 更新自适应阈值 ----
    // 用 ratio 作为瞬态强度指标，滑动窗口统计均值和方差
    onsetStrengths.push(ratio);
    if (onsetStrengths.length > 20) onsetStrengths.shift();
    if (onsetStrengths.length >= 3) {
      let m = 0;
      for (let i = 0; i < onsetStrengths.length; i++) m += onsetStrengths[i];
      m /= onsetStrengths.length;
      let v = 0;
      for (let i = 0; i < onsetStrengths.length; i++) {
        const d = onsetStrengths[i] - m;
        v += d * d;
      }
      v = Math.sqrt(v / onsetStrengths.length);
      adaptiveThresholdMean = m;
      adaptiveThresholdVar = v;
    }

    // 通知所有脉冲订阅者（小工具的 pulse 动画等）
    service.pulseSubscribers.forEach(cb => cb());
  }

  // 清理窗口外 onset
  while (onsets.length > 0 && now - onsets[0] > WINDOW_MS) {
    onsets.shift();
  }

  // BPM 估计
  const est = estimateBpm(onsets);
  let bpmChanged = false;
  let confChanged = false;

  if (est.bpm > 0 && est.confidence > 0.35) {
    if (stableBpm === 0) {
      stableBpm = est.bpm;
      stableSince = now;
      bpmChanged = true;
      confChanged = true;
      writeBpmToBus(stableBpm, est.confidence);
    } else {
      const diff = Math.abs(est.bpm - stableBpm);
      if (diff <= 5) {
        const newBpm = Math.round(stableBpm * 0.9 + est.bpm * 0.1);
        if (newBpm !== stableBpm) { stableBpm = newBpm; bpmChanged = true; }
        stableSince = now;
        confChanged = true;
        writeBpmToBus(stableBpm, Math.min(1, est.confidence + 0.05));
      } else {
        if (est.confidence > 0.6 && now - stableSince > 3000) {
          stableBpm = est.bpm;
          stableSince = now;
          bpmChanged = true;
          confChanged = true;
          writeBpmToBus(stableBpm, est.confidence);
        }
      }
    }
  } else {
    if (now - lastBeatTime > 4000) {
      writeBpmToBus(stableBpm, Math.max(0, 1 - 0.008));
      confChanged = true;
    }
    if (now - lastBeatTime > 10000) {
      if (stableBpm !== 0) {
        stableBpm = 0;
        bpmChanged = true;
        confChanged = true;
      }
      writeBpmToBus(0, 0);
    }
  }

   // 通知订阅者（仅在 BPM/置信度有实际变化时）
  if (bpmChanged || confChanged) {
    service.subscribers.forEach(cb => cb({ bpm: stableBpm, confidence: est.confidence }));
    // 同步到诊断服务
    try {
      const diag = getDiagnosticService();
      diag.setFields({
        beatServiceRunning: true,
        beatServiceBpm: stableBpm,
        beatServiceConfidence: est.confidence,
        beatServiceSubscribers: service.subscribers.size,
      });
    } catch { /* ignore */ }
  }

  // 每帧同步 analyser + 节拍检测实时诊断
  try {
    const diag = getDiagnosticService();
    diag.setFields({
      analyserRms: rms,
      analyserPeak: peakNorm,
      analyserHasData: peakNorm > 0.01,
      beatLowPeak: lowPeakNorm,
      beatLowAvg: lowAvg * sens,
      beatLowFast: lowSmoothFast,
      beatLowSlow: lowSmoothSlow,
      beatOnsetRatio: ratio,
      beatBusKick: getBeatState().kickEnvelope,
    });
  } catch { /* ignore */ }

  service.raf = requestAnimationFrame(detect);
}

// 启动/停止检测循环（基于订阅者数量 + 页面可见性）
function ensureRunning() {
  if (service.running) return;
  if (document.hidden) return; // 后台标签页不启动
  service.running = true;
  lastFrameTime = 0;
  service.raf = requestAnimationFrame(detect);
  try {
    const diag = getDiagnosticService();
    diag.setField('beatServiceRunning', true);
    diag.addLog('info', 'beatService', '检测循环启动');
  } catch { /* ignore */ }
}

function ensureStopped() {
  if (!service.running) return;
  service.running = false;
  if (service.raf !== null) {
    cancelAnimationFrame(service.raf);
    service.raf = null;
  }
  try {
    const diag = getDiagnosticService();
    diag.setField('beatServiceRunning', false);
    diag.addLog('info', 'beatService', '检测循环暂停');
  } catch { /* ignore */ }
}

// 页面可见性变化：后台暂停、前台恢复
let visibilityHandlerInstalled = false;
function installVisibilityHandler() {
  if (visibilityHandlerInstalled) return;
  visibilityHandlerInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // 切后台：暂停检测循环（节省 CPU + 避免 RAF 被节流导致时间错乱）
      ensureStopped();
    } else {
      // 切回前台：如果还有订阅者，恢复
      if (service.subscribers.size > 0 && service.getFrequencyData) {
        ensureRunning();
      }
    }
  });
}

// ===== React Hook =====
// 用法一（生产端 / 顶层）：传 getFrequencyData + sensitivity，启动检测循环
// 用法二（消费端 / 小工具）：不传参，仅订阅读取 BPM/脉冲
// 只要有至少一个生产端注册了数据源，所有订阅者都能收到数据
export function useBeatService(
  params?: {
    getFrequencyData?: GetFreqFn;
    sensitivity?: number;
  }
) {
  const [bpm, setBpmState] = useState(0);
  const [confidence, setConfidenceState] = useState(0);
  const [pulse, setPulse] = useState(false);
  const pulseTimerRef = useRef<number | null>(null);
  const isProducer = !!(params?.getFrequencyData);

  // 订阅回调
  const onStateChange = useCallback((s: { bpm: number; confidence: number }) => {
    setBpmState(s.bpm);
    setConfidenceState(s.confidence);
  }, []);

  const onPulse = useCallback(() => {
    setPulse(true);
    if (pulseTimerRef.current) window.clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = window.setTimeout(() => setPulse(false), 120);
  }, []);

  // 生产端：注册数据源和灵敏度
  useEffect(() => {
    if (!isProducer || !params?.getFrequencyData) return;
    service.getFrequencyData = params.getFrequencyData;
    service.sensitivity = params.sensitivity ?? 100;
    return () => {
      // 如果生产端卸载，清除数据源（其他订阅者仍在，但数据会为 0）
      if (service.getFrequencyData === params.getFrequencyData) {
        service.getFrequencyData = null;
      }
    };
  }, [isProducer, params?.getFrequencyData, params?.sensitivity]);

  useEffect(() => {
    installVisibilityHandler();

    // 仅生产端挂载时重置 beatBus，避免消费端挂载也重置
    if (isProducer) {
      resetBeatDetection();
    }

    // 订阅
    service.subscribers.add(onStateChange);
    service.pulseSubscribers.add(onPulse);
    // 新订阅者立即推送一次当前值（避免首次挂载显示 0/-- 直到下次 BPM 变化）
    // BPM 小工具、工程菜单等动态挂载的组件需要立即看到当前状态
    if (stableBpm > 0 || getBeatState().confidence > 0) {
      try {
        onStateChange({ bpm: stableBpm, confidence: getBeatState().confidence });
      } catch { /* ignore */ }
    }
    try {
      getDiagnosticService().setField('beatServiceSubscribers', service.subscribers.size);
    } catch { /* ignore */ }

    // 如果是生产端，或已有数据源在运行，启动循环
    if (isProducer || service.getFrequencyData) {
      ensureRunning();
    }

    return () => {
      service.subscribers.delete(onStateChange);
      service.pulseSubscribers.delete(onPulse);
      try {
        getDiagnosticService().setField('beatServiceSubscribers', service.subscribers.size);
      } catch { /* ignore */ }

      // 没有订阅者了就停掉
      if (service.subscribers.size === 0) {
        ensureStopped();
      }
    };
  }, [onStateChange, onPulse, isProducer]);

  return { bpm, confidence, pulse };
}
