// 统一音频帧数据总线（Audio Frame Bus）
// —— 所有小工具（频谱 / 电平 / 波形 / BPM）的统一数据源
//
// 设计目标：
//   1. 单例：在播放器顶层常驻，与组件挂载、面板开关、横竖屏旋转无关
//   2. 推送：每帧推一次完整数据（频谱 + 波形 + 电平 + 节拍），所有订阅者同时拿到
//   3. 看门狗：检测数据冻结/断流，自动标记健康状态，必要时触发重建
//   4. 页面可见性：后台暂停 RAF 节流，回前台自动恢复
//
// 写入方：PlayerContext 顶层（每帧 getByteFrequencyData / getByteTimeDomainData）
// 读取方：实时频谱组件、电平表、波形、BPM 小工具、ThreeVisualizer 等
//
// 注意：beatBus 仍然存在（节拍检测的结果写入它），
// 但 audioFrameBus 是更高层的"每帧全量数据"总线，订阅者只需要订阅这里。

import { getBeatState, type BeatState } from './beatBus';
import { getDiagnosticService } from './diagnosticService';

export interface AudioFrameData {
  /** 频谱数据（频域，Uint8Array 0-255） */
  frequency: Uint8Array;
  /** 波形数据（时域，Uint8Array 0-255） */
  timeDomain: Uint8Array;
  /** RMS 电平 0-1 */
  rms: number;
  /** 峰值电平 0-1 */
  peak: number;
  /** 节拍状态（来自 beatBus 的只读快照） */
  beat: Readonly<BeatState>;
  /** 帧序号（自增） */
  frame: number;
  /** 时间戳（performance.now） */
  timestamp: number;
  /** 是否为模拟/无信号数据（analyser 未连接或静音时） */
  simulated: boolean;
}

type FrameSubscriber = (data: AudioFrameData) => void;
type HealthSubscriber = (health: AudioFrameHealth) => void;

export interface AudioFrameHealth {
  /** 是否实时有新数据（最近 N 帧内有更新） */
  alive: boolean;
  /** 最后一次收到数据的时间戳（ms） */
  lastFrameTime: number;
  /** 连续多少帧没收到新数据（看门狗计数） */
  stallFrames: number;
  /** 总帧率估算（最近 1s 内帧数） */
  fps: number;
  /** analyser 是否已连接到音频源 */
  analyserConnected: boolean;
  /** 最近一次错误信息 */
  lastError?: string;
}

// ===== 模块级单例 =====
const FFT_SIZE = 256;
const WATCHDOG_THRESHOLD = 60; // 60 帧（约 1s）没新数据视为冻结
const FPS_WINDOW_MS = 1000;

interface ServiceState {
  running: boolean;
  raf: number | null;
  // 数据源函数：生产端注册
  getFrequencyData: (() => Uint8Array | null) | null;
  getTimeDomainData: (() => Uint8Array | null) | null;
  analyserConnected: boolean;
  // 帧数据缓冲（复用数组，避免每帧分配）
  freqBuffer: Uint8Array;
  timeBuffer: Uint8Array;
  // 订阅者
  frameSubscribers: Set<FrameSubscriber>;
  healthSubscribers: Set<HealthSubscriber>;
  // 健康状态
  health: AudioFrameHealth;
  frame: number;
  // FPS 计算
  fpsTimestamps: number[];
  // 上一次看到的 frameCount（来自 beatBus，用于判断 beat service 是否也冻结）
  lastBeatFrameCount: number;
  lastBeatStallFrames: number;
  // 页面可见性
  visibilityHandlerInstalled: boolean;
}

const state: ServiceState = {
  running: false,
  raf: null,
  getFrequencyData: null,
  getTimeDomainData: null,
  analyserConnected: false,
  freqBuffer: new Uint8Array(FFT_SIZE),
  timeBuffer: new Uint8Array(FFT_SIZE),
  frameSubscribers: new Set(),
  healthSubscribers: new Set(),
  health: {
    alive: false,
    lastFrameTime: 0,
    stallFrames: 0,
    fps: 0,
    analyserConnected: false,
  },
  frame: 0,
  fpsTimestamps: [],
  lastBeatFrameCount: 0,
  lastBeatStallFrames: 0,
  visibilityHandlerInstalled: false,
};

// 每帧数据对象（复用，避免每帧分配新对象）
const frameData: AudioFrameData = {
  frequency: state.freqBuffer,
  timeDomain: state.timeBuffer,
  rms: 0,
  peak: 0,
  beat: {} as Readonly<BeatState>,
  frame: 0,
  timestamp: 0,
  simulated: true,
};

// ===== 公共 API =====

/** 注册频谱数据源（生产端） */
export function setFrequencyDataSource(fn: () => Uint8Array | null) {
  state.getFrequencyData = fn;
  state.analyserConnected = !!fn;
  state.health.analyserConnected = state.analyserConnected;
  notifyHealth();
}

/** 注册波形数据源（生产端） */
export function setTimeDomainDataSource(fn: () => Uint8Array | null) {
  state.getTimeDomainData = fn;
}

/** 标记 analyser 是否已连接到音频源 */
export function setAnalyserConnected(connected: boolean) {
  state.analyserConnected = connected;
  state.health.analyserConnected = connected;
  notifyHealth();
}

/** 订阅每帧数据（消费端）。返回取消订阅函数。 */
export function subscribeFrames(cb: FrameSubscriber): () => void {
  state.frameSubscribers.add(cb);
  ensureRunning();
  return () => {
    state.frameSubscribers.delete(cb);
    checkShouldStop();
  };
}

/** 订阅健康状态变化 */
export function subscribeHealth(cb: HealthSubscriber): () => void {
  state.healthSubscribers.add(cb);
  // 立即推送一次当前状态
  cb(state.health);
  return () => state.healthSubscribers.delete(cb);
}

/** 获取当前健康快照 */
export function getAudioFrameHealth(): AudioFrameHealth {
  return { ...state.health };
}

/** 强制触发一次重连（由生产端实现，这里仅通知健康状态变化） */
export function triggerReconnectAttempt() {
  state.health.stallFrames = 0;
  state.health.alive = true;
  state.health.lastFrameTime = performance.now();
  notifyHealth();
  try {
    const diag = getDiagnosticService();
    diag.addLog('warn', 'audioFrameBus', '看门狗触发：请求重建音频分析器连接');
  } catch { /* ignore */ }
}

// ===== 内部实现 =====

function ensureRunning() {
  if (state.running) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  state.running = true;
  state.raf = requestAnimationFrame(tick);
  installVisibilityHandler();
  try {
    const diag = getDiagnosticService();
    diag.setField('frameBusRunning', true);
    diag.addLog('info', 'audioFrameBus', '帧总线循环启动');
  } catch { /* ignore */ }
}

function checkShouldStop() {
  if (state.frameSubscribers.size === 0 && state.healthSubscribers.size === 0) {
    // 没有任何订阅者也不停止：
    // 原因：PlayerContext 生产端可能还在注册，组件卸载后再挂载需要立即有数据
    // 实际上，如果完全没有订阅者，循环继续跑代价很小（只读取 analyser 但不分发）
    // 为了稳定性，保持运行，只在后台/卸载时停止
  }
}

function stopLoop() {
  if (!state.running) return;
  state.running = false;
  if (state.raf !== null) {
    cancelAnimationFrame(state.raf);
    state.raf = null;
  }
  try {
    const diag = getDiagnosticService();
    diag.setField('frameBusRunning', false);
  } catch { /* ignore */ }
}

function installVisibilityHandler() {
  if (state.visibilityHandlerInstalled) return;
  if (typeof document === 'undefined') return;
  state.visibilityHandlerInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // 后台标签页：暂停帧循环（节省 CPU）
      stopLoop();
    } else {
      // 回前台：恢复
      if (state.frameSubscribers.size > 0 || state.healthSubscribers.size > 0) {
        state.fpsTimestamps = [];
        state.health.stallFrames = 0;
        ensureRunning();
      }
    }
  });
}

function tick() {
  if (!state.running) return;

  const now = performance.now();
  state.frame += 1;

  // 采集频谱
  let freqData: Uint8Array | null = null;
  let timeData: Uint8Array | null = null;
  let hasData = false;

  try {
    if (state.getFrequencyData) {
      const raw = state.getFrequencyData();
      if (raw && raw.length > 0) {
        // 拷贝到缓冲（避免外部修改）
        const len = Math.min(raw.length, state.freqBuffer.length);
        for (let i = 0; i < len; i++) state.freqBuffer[i] = raw[i];
        // 如果 FFT 比 buffer 大，取平均采样
        if (raw.length > state.freqBuffer.length) {
          const step = raw.length / state.freqBuffer.length;
          for (let i = 0; i < state.freqBuffer.length; i++) {
            state.freqBuffer[i] = raw[Math.floor(i * step)];
          }
        }
        freqData = state.freqBuffer;
      }
    }
    if (state.getTimeDomainData) {
      const raw = state.getTimeDomainData();
      if (raw && raw.length > 0) {
        const len = Math.min(raw.length, state.timeBuffer.length);
        for (let i = 0; i < len; i++) state.timeBuffer[i] = raw[i];
        if (raw.length > state.timeBuffer.length) {
          const step = raw.length / state.timeBuffer.length;
          for (let i = 0; i < state.timeBuffer.length; i++) {
            state.timeBuffer[i] = raw[Math.floor(i * step)];
          }
        }
        timeData = state.timeBuffer;
      }
    }
    hasData = !!(freqData && freqData[0] !== undefined);
  } catch (e) {
    state.health.lastError = String(e);
    hasData = false;
  }

  // 计算 RMS / Peak
  let rms = 0;
  let peak = 0;
  if (freqData && freqData.length > 0) {
    let sumSq = 0;
    for (let i = 0; i < freqData.length; i++) {
      const v = freqData[i] || 0;
      sumSq += v * v;
      if (v > peak) peak = v;
    }
    rms = Math.sqrt(sumSq / freqData.length) / 255;
    peak = peak / 255;
  }

  // 看门狗：检测数据是否冻结
  // 策略：有数据源 + peak > 0 时有新数据；没数据源但 beatBus 在跑也算活着
  const beatState = getBeatState();
  const beatActive = beatState.frameCount !== state.lastBeatFrameCount;
  if (beatActive) {
    state.lastBeatFrameCount = beatState.frameCount;
    state.lastBeatStallFrames = 0;
  } else {
    state.lastBeatStallFrames += 1;
  }

  const hadActivity = hasData && peak > 0.001;
  if (hadActivity || beatActive) {
    state.health.lastFrameTime = now;
    state.health.stallFrames = 0;
    if (!state.health.alive) {
      state.health.alive = true;
      notifyHealth();
    }
  } else {
    state.health.stallFrames += 1;
    if (state.health.alive && state.health.stallFrames > WATCHDOG_THRESHOLD) {
      state.health.alive = false;
      state.health.lastError = `看门狗触发：${WATCHDOG_THRESHOLD}帧无新数据`;
      notifyHealth();
      try {
        const diag = getDiagnosticService();
        diag.addLog('warn', 'audioFrameBus', `看门狗触发：${state.health.stallFrames}帧无新数据，analyserConnected=${state.analyserConnected}`);
      } catch { /* ignore */ }
    }
  }

  // FPS 计算
  state.fpsTimestamps.push(now);
  while (state.fpsTimestamps.length > 0 && now - state.fpsTimestamps[0] > FPS_WINDOW_MS) {
    state.fpsTimestamps.shift();
  }
  const fps = state.fpsTimestamps.length; // 过去 1s 的帧数 ≈ fps
  if (Math.abs(fps - state.health.fps) >= 2) {
    state.health.fps = fps;
    notifyHealth();
  } else if (state.health.fps !== fps) {
    state.health.fps = fps;
  }

  // 组装帧数据（复用对象）
  frameData.frequency = state.freqBuffer;
  frameData.timeDomain = state.timeBuffer;
  frameData.rms = rms;
  frameData.peak = peak;
  frameData.beat = beatState;
  frameData.frame = state.frame;
  frameData.timestamp = now;
  frameData.simulated = !hasData || peak < 0.001;

  // 推送订阅者（使用安全 try-catch，单个订阅者异常不影响其他）
  state.frameSubscribers.forEach((cb) => {
    try {
      cb(frameData);
    } catch (e) {
      // 不中断其他订阅者
      state.health.lastError = `subscriber error: ${String(e)}`;
    }
  });

  // 同步到诊断服务（每帧太频繁，只每 10 帧同步一次）
  if (state.frame % 10 === 0) {
    try {
      const diag = getDiagnosticService();
      diag.setFields({
        frameBusRunning: state.running,
        frameBusAlive: state.health.alive,
        frameBusFps: state.health.fps,
        frameBusStallFrames: state.health.stallFrames,
        frameBusSubscribers: state.frameSubscribers.size,
        frameBusAnalyserConnected: state.health.analyserConnected,
        frameBusLastError: state.health.lastError || '',
      });
    } catch { /* ignore */ }
  }

  state.raf = requestAnimationFrame(tick);
}

function notifyHealth() {
  state.healthSubscribers.forEach((cb) => {
    try { cb(state.health); } catch { /* ignore */ }
  });
}

// ===== 全局暴露（方便动态模块/调试时访问）=====
declare global {
  interface Window {
    __audioFrameBus?: {
      subscribeFrames: typeof subscribeFrames;
      subscribeHealth: typeof subscribeHealth;
      getAudioFrameHealth: typeof getAudioFrameHealth;
      triggerReconnectAttempt: typeof triggerReconnectAttempt;
      setFrequencyDataSource: typeof setFrequencyDataSource;
      setTimeDomainDataSource: typeof setTimeDomainDataSource;
      setAnalyserConnected: typeof setAnalyserConnected;
    };
  }
}

if (typeof window !== 'undefined') {
  window.__audioFrameBus = {
    subscribeFrames,
    subscribeHealth,
    getAudioFrameHealth,
    triggerReconnectAttempt,
    setFrequencyDataSource,
    setTimeDomainDataSource,
    setAnalyserConnected,
  };
}
