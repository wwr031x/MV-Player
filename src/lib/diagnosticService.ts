// 全局诊断/工程菜单服务
// - 收集实时运行状态（WebGL、节拍服务、AudioContext、封面状态、性能等）
// - 收集错误日志（window error / unhandledrejection / 封面初始化错误等）
// - 单例模式，任何组件都能 getDiagnosticService() 拿到同一个实例

import { logger } from '@lark-apaas/client-toolkit-lite';
import { buildInfo } from './buildInfo';

export interface IDiagnosticLogEntry {
  id: number;
  time: string;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

export interface IDiagnosticSnapshot {
  appVersion: string;
  buildNumber: string;
  buildTime: string;
  webgl: string;
  webglError?: string;
  beatServiceRunning: boolean;
  beatServiceBpm: number;
  beatServiceConfidence: number;
  beatServiceSubscribers: number;
  audioContextState: string;
  analyserSourceConnected: boolean;
  analyserRms: number;
  analyserPeak: number;
  analyserHasData: boolean;
  coverLoaded: boolean;
  coverParticleCount: number;
  coverGeometryId: string;
  coverParticleSystemId: string;
   coverIntroProgress: number;
   busKick: number;
   coverKickEnvelope: number;
   coverIsKick: boolean;
   coverLowLevel: number;
   coverPeakLevel: number;
  beatLowPeak: number;      // 低频峰值 0-1（灵敏度加权）
  beatLowAvg: number;       // 低频平均 0-1（灵敏度加权）
  beatLowFast: number;      // 低频快速包络 0-1
  beatLowSlow: number;      // 慢速基线 0-1
  beatOnsetRatio: number;   // 瞬态比值（fast/slow）
  beatBusKick: number;      // 从 beatBus 直接读的 kickEnvelope
   qualityTier: string;
   targetFps: number;
   storageBytes: number;
   userAgent: string;
   // ===== 帧总线健康 =====
   frameBusRunning: boolean;
   frameBusAlive: boolean;
   frameBusFps: number;
   frameBusStallFrames: number;
   frameBusSubscribers: number;
   frameBusAnalyserConnected: boolean;
   frameBusLastError: string;
   // ===== 3D 渲染健康 =====
   renderRunning: boolean;
   renderFps: number;
   renderStallFrames: number;
   renderTotalFrames: number;
   renderErrorCount: number;
   renderContextState: 'ok' | 'lost' | 'unknown';
   renderLastError: string;
   renderMode: string;
 }

const MAX_LOGS = 100;

class DiagnosticService {
  private logs: IDiagnosticLogEntry[] = [];
  private logId = 0;
  private listeners: Set<() => void> = new Set();
  private snapshot: Partial<IDiagnosticSnapshot> = {};
  private installed = false;

  constructor() {
    this.snapshot.appVersion = buildInfo.appVersion;
    this.snapshot.buildNumber = buildInfo.buildNumber;
    this.snapshot.buildTime = buildInfo.buildTime;
    this.snapshot.beatServiceRunning = false;
    this.snapshot.beatServiceBpm = 0;
    this.snapshot.beatServiceConfidence = 0;
    this.snapshot.beatServiceSubscribers = 0;
    this.snapshot.audioContextState = 'unknown';
    this.snapshot.analyserSourceConnected = false;
    this.snapshot.analyserRms = 0;
    this.snapshot.analyserPeak = 0;
    this.snapshot.analyserHasData = false;
    this.snapshot.coverLoaded = false;
    this.snapshot.coverParticleCount = 0;
    this.snapshot.coverGeometryId = '-';
    this.snapshot.coverParticleSystemId = '-';
     this.snapshot.coverIntroProgress = 0;
     this.snapshot.busKick = 0;
     this.snapshot.coverKickEnvelope = 0;
     this.snapshot.coverIsKick = false;
     this.snapshot.coverLowLevel = 0;
     this.snapshot.coverPeakLevel = 0;
    this.snapshot.beatLowPeak = 0;
    this.snapshot.beatLowAvg = 0;
    this.snapshot.beatLowFast = 0;
    this.snapshot.beatLowSlow = 0;
    this.snapshot.beatOnsetRatio = 0;
    this.snapshot.beatBusKick = 0;
    this.snapshot.qualityTier = 'mid';
     this.snapshot.targetFps = 0;
     this.snapshot.storageBytes = 0;
     this.snapshot.userAgent = typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 120) : '';
     this.snapshot.frameBusRunning = false;
     this.snapshot.frameBusAlive = false;
     this.snapshot.frameBusFps = 0;
     this.snapshot.frameBusStallFrames = 0;
     this.snapshot.frameBusSubscribers = 0;
     this.snapshot.frameBusAnalyserConnected = false;
     this.snapshot.frameBusLastError = '';
     this.snapshot.renderRunning = false;
     this.snapshot.renderFps = 0;
     this.snapshot.renderStallFrames = 0;
     this.snapshot.renderTotalFrames = 0;
     this.snapshot.renderErrorCount = 0;
     this.snapshot.renderContextState = 'unknown';
     this.snapshot.renderLastError = '';
     this.snapshot.renderMode = '';
  }

  installGlobalErrorHandler() {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;

    window.addEventListener('error', (ev) => {
      const msg = ev.error?.stack || ev.message || String(ev.error || '未知错误');
      this.addLog('error', 'window.error', `${ev.filename}:${ev.lineno}:${ev.colno} — ${msg.slice(0, 500)}`);
    });

    window.addEventListener('unhandledrejection', (ev) => {
      const reason = ev.reason;
      const msg = reason?.stack || String(reason || '未处理的 Promise 拒绝');
      this.addLog('error', 'unhandledrejection', msg.slice(0, 500));
    });

    this.addLog('info', 'diagnostic', '全局错误捕获已启动');
  }

  addLog(level: IDiagnosticLogEntry['level'], source: string, message: string) {
    const now = new Date();
    const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
    const entry: IDiagnosticLogEntry = {
      id: ++this.logId,
      time,
      level,
      source,
      message,
    };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.shift();
    this.notify();
    // 同步到 logger
    if (level === 'error') logger.error(`[diag:${source}] ${message}`);
    else if (level === 'warn') logger.warn(`[diag:${source}] ${message}`);
    else logger.info(`[diag:${source}] ${message}`);
  }

  setField<K extends keyof IDiagnosticSnapshot>(key: K, value: IDiagnosticSnapshot[K]) {
    this.snapshot[key] = value;
    this.notify();
  }

  setFields(fields: Partial<IDiagnosticSnapshot>) {
    Object.assign(this.snapshot, fields);
    this.notify();
  }

  getSnapshot(): IDiagnosticSnapshot {
    // storage 动态计算
    let storageBytes = 0;
    try {
      let total = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        const v = localStorage.getItem(k) || '';
        total += k.length + v.length;
      }
      storageBytes = total * 2; // UTF-16 大致估算
    } catch { /* ignore */ }
    return {
      ...this.snapshot,
      storageBytes,
    } as IDiagnosticSnapshot;
  }

  getLogs(): IDiagnosticLogEntry[] {
    return this.logs.slice();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach(fn => {
      try { fn(); } catch { /* ignore */ }
    });
  }
}

let instance: DiagnosticService | null = null;

export function getDiagnosticService(): DiagnosticService {
  if (!instance) {
    instance = new DiagnosticService();
    instance.installGlobalErrorHandler();
  }
  return instance;
}
