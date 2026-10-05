// 共享节拍信号总线（beat bus）—— 单一信号源
// BPM 检测器（已被验证稳定）负责写入 onset / kickEnvelope / bpm / confidence
// cover3d 等可视化模块每帧读取，确保"BPM 能数到的拍，可视化一定跳"
//
// 设计：模块级单例，无 React 依赖，避免重渲染开销
// 写入方：BpmDetector（每帧）
// 读取方：ThreeVisualizer cover3d 模式（每帧）
//
// 注意：这是一个"尽力而为"的总线——读取方自行处理取值时机，
// 不保证与渲染帧严格同步，但同一 RAF 阶段内读取足够准确。

export interface BeatState {
  /** 鼓点包络 0-1+（指数衰减脉冲） */
  kickEnvelope: number;
  /** 当前 BPM（稳定值，0 表示未锁定） */
  bpm: number;
  /** 置信度 0-1 */
  confidence: number;
  /** 是否刚触发 onset（本帧为 true，下一帧即 false，用于一次性事件） */
  justKicked: boolean;
  /** 低频峰值 0-1（用于辅助呼吸等） */
  lowPeak: number;
  /** 上一次 onset 时间戳（ms） */
  lastOnsetTime: number;
  /** 上一次 updateBeatLevel 写入时间戳（ms），用于看门狗判断数据是否冻结 */
  lastUpdateTime: number;
  /** 帧序号（每帧自增，订阅者可据此判断是否有新帧） */
  frameCount: number;
  /** RMS 电平 0-1（总频段），用于小工具电平显示 */
  rms: number;
  /** 峰值电平 0-1（总频段） */
  peak: number;
}

const state: BeatState = {
  kickEnvelope: 0,
  bpm: 0,
  confidence: 0,
  justKicked: false,
  lowPeak: 0,
  lastOnsetTime: 0,
  lastUpdateTime: 0,
  frameCount: 0,
  rms: 0,
  peak: 0,
};

// 衰减系数（按 60fps 估算，实际写入方按 delta 补偿）
// DECAY_PER_SEC = 6 表示每秒乘 exp(-6) ≈ 0.0025，
// 即约 167ms 衰减到 37%、330ms 基本归零，脉冲更尖锐、跟拍更准。
// 之前是 4/s（约 250ms 半衰），脉冲太拖泥带水。
const DECAY_PER_SEC = 6; // kickEnvelope 每秒乘 exp(-DECAY)

export function getBeatState(): Readonly<BeatState> {
  return state;
}

/**
 * 写入方调用：每帧更新 kick 包络 + 低频峰值
 * @param lowPeak 低频峰值 0-1
 * @param deltaSeconds 距上一帧秒数
 */
export function updateBeatLevel(lowPeak: number, deltaSeconds: number) {
  state.lowPeak = lowPeak;
  // 指数衰减 kickEnvelope
  if (state.kickEnvelope > 0.001) {
    state.kickEnvelope *= Math.exp(-DECAY_PER_SEC * deltaSeconds);
  } else {
    state.kickEnvelope = 0;
  }
  state.justKicked = false;
  state.lastUpdateTime = performance.now();
  state.frameCount += 1;
}

/**
 * 写入方调用：每帧写入总频段 RMS / 峰值电平（用于小工具电平显示与看门狗）
 */
export function writeRmsPeak(rms: number, peak: number) {
  state.rms = rms;
  state.peak = peak;
}

/**
 * 写入方调用：触发一次 onset（鼓点）
 * @param strength 脉冲强度 0-1+，会叠加到 kickEnvelope 上
 */
export function triggerOnset(strength = 1) {
  state.kickEnvelope = Math.min(3, state.kickEnvelope + strength);
  state.justKicked = true;
  state.lastOnsetTime = performance.now();
}

/**
 * 写入方调用：更新 BPM 稳定值与置信度
 */
export function setBpm(bpm: number, confidence: number) {
  state.bpm = bpm;
  state.confidence = confidence;
}

/**
 * 重置（切歌时调用）
 */
export function resetBeatBus() {
  state.kickEnvelope = 0;
  state.bpm = 0;
  state.confidence = 0;
  state.justKicked = false;
  state.lowPeak = 0;
  state.lastOnsetTime = 0;
}

// ===== 全局暴露（供 GPU Shader 模式 / 动态 import 模块读取）=====
// cover3d shader 模块通过 lazy import 获取 beatBus 可能有 bundler 循环依赖问题，
// 因此同时挂到 window.__beatBus，保证任何模块都能在运行时拿到同一单例。
interface BeatBusGlobal {
  getBeatState: typeof getBeatState;
  triggerOnset: typeof triggerOnset;
  updateBeatLevel: typeof updateBeatLevel;
  setBpm: typeof setBpm;
  resetBeatBus: typeof resetBeatBus;
  writeRmsPeak: typeof writeRmsPeak;
}

declare global {
  interface Window {
    __beatBus?: BeatBusGlobal;
  }
}

if (typeof window !== 'undefined') {
  window.__beatBus = {
    getBeatState,
    triggerOnset,
    updateBeatLevel,
    setBpm,
    resetBeatBus,
    writeRmsPeak,
  };
}
