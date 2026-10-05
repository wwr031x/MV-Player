import React, { useState, useEffect, useRef } from 'react';
import { X, RefreshCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { getDiagnosticService, type IDiagnosticSnapshot, type IDiagnosticLogEntry } from '@/lib/diagnosticService';

export default function EngineeringMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<IDiagnosticSnapshot | null>(null);
  const [logs, setLogs] = useState<IDiagnosticLogEntry[]>([]);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!open) return;
    const svc = getDiagnosticService();

    // 实时刷新（60fps，诊断面板不做性能优化）
    const tick = () => {
      setSnapshot(svc.getSnapshot());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    // 日志变更订阅（日志变化不频繁，用事件驱动）
    const unsub = svc.subscribe(() => {
      setLogs(svc.getLogs());
    });
    setLogs(svc.getLogs());

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      unsub();
    };
  }, [open]);

  const fmtBytes = (n: number) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  };

  const fmt = (n: number, d = 3) => (typeof n === 'number' ? n.toFixed(d) : '-');

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="max-w-[92vw] md:max-w-2xl max-h-[85vh] p-0 gap-0 bg-[#0a0f1a]/95 backdrop-blur-xl border border-cyan-400/30 text-white font-mono z-[100]"
      >
        <DialogHeader className="px-5 py-3 border-b border-cyan-400/20 flex items-center">
          <DialogTitle className="text-sm text-cyan-400 font-bold tracking-wide">
            ⚙ 工程菜单 · ENGINEERING MENU
          </DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="absolute right-3 top-3 text-white/60 hover:text-white h-7 w-7"
            aria-label="关闭工程菜单"
          >
            <X className="w-4 h-4" />
          </Button>
        </DialogHeader>

        <div className="overflow-y-auto p-5 space-y-5 max-h-[calc(85vh-60px)]">
          {/* 版本信息 */}
          <section className="space-y-2">
            <div className="text-[11px] text-cyan-400/70 uppercase tracking-widest">Build Info</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <div className="text-white/50">版本号</div>
              <div className="text-cyan-300">{snapshot?.appVersion || '-'}</div>
              <div className="text-white/50">构建号</div>
              <div className="text-cyan-300 text-[11px] font-mono break-all">{snapshot?.buildNumber || '-'}</div>
              <div className="text-white/50">构建时间</div>
              <div className="text-white/80 text-[11px]">{snapshot?.buildTime || '-'}</div>
              <div className="text-white/50">UserAgent</div>
              <div className="text-white/60 text-[11px] break-all">{snapshot?.userAgent || '-'}</div>
            </div>
          </section>

          {/* 运行诊断 */}
          <section className="space-y-2">
            <div className="text-[11px] text-cyan-400/70 uppercase tracking-widest">Runtime</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <div className="text-white/50">WebGL</div>
              <div className={snapshot?.webgl === 'available' ? 'text-emerald-400' : 'text-red-400'}>
                {snapshot?.webgl || '-'}
                {snapshot?.webglError && <span className="block text-[10px] text-red-400/70">{snapshot.webglError}</span>}
              </div>
              <div className="text-white/50">节拍服务</div>
              <div className={snapshot?.beatServiceRunning ? 'text-emerald-400' : 'text-yellow-400'}>
                {snapshot?.beatServiceRunning ? '运行中' : '未启动'}
                <span className="text-white/40 ml-2">订阅者 {snapshot?.beatServiceSubscribers || 0}</span>
              </div>
              <div className="text-white/50">BPM / 置信度</div>
              <div className="text-white/80">
                <span className="text-cyan-300 font-bold text-sm">{snapshot?.beatServiceBpm || '--'}</span>
                <span className="text-white/40 ml-2">
                  置信 {Math.round((snapshot?.beatServiceConfidence || 0) * 100)}%
                </span>
              </div>
              <div className="text-white/50">busKick</div>
              <div className="text-yellow-300 font-bold text-sm tabular-nums">{fmt(snapshot?.beatBusKick || 0)}</div>
              <div className="text-white/50">低频 峰值 / 平均</div>
              <div className="text-white/80 tabular-nums">
                <span className="text-yellow-300">{(snapshot?.beatLowPeak || 0).toFixed(3)}</span>
                <span className="text-white/40 mx-1">/</span>
                <span className="text-cyan-300">{(snapshot?.beatLowAvg || 0).toFixed(3)}</span>
              </div>
              <div className="text-white/50">低频快包 / 慢基线</div>
              <div className="text-white/80 tabular-nums">
                <span className="text-orange-300">{(snapshot?.beatLowFast || 0).toFixed(3)}</span>
                <span className="text-white/40 mx-1">/</span>
                <span className="text-blue-300">{(snapshot?.beatLowSlow || 0).toFixed(3)}</span>
              </div>
              <div className="text-white/50">瞬态比值 (onset ratio)</div>
              <div className="text-white/80 tabular-nums">
                <span className={(snapshot?.beatOnsetRatio || 0) >= 1.18 ? 'text-emerald-400 font-bold' : 'text-white/60'}>
                  {(snapshot?.beatOnsetRatio || 0).toFixed(2)}x
                </span>
                <span className="text-white/40 ml-2">阈值 1.18</span>
              </div>
              <div className="text-white/50">AudioContext</div>
              <div>
                <span className={
                  snapshot?.audioContextState === 'running' ? 'text-emerald-400' :
                  snapshot?.audioContextState === 'suspended' ? 'text-yellow-400' :
                  snapshot?.audioContextState === 'not-created' ? 'text-white/40' :
                  'text-white/80'
                }>
                  {snapshot?.audioContextState === 'running' ? '运行中 (running)' :
                   snapshot?.audioContextState === 'suspended' ? '已挂起 (suspended)' :
                   snapshot?.audioContextState === 'not-created' ? '未创建' :
                   snapshot?.audioContextState === 'unsupported' ? '浏览器不支持' :
                   snapshot?.audioContextState || '-'}
                </span>
              </div>
              <div className="text-white/50">音频源连接</div>
              <div className={snapshot?.analyserSourceConnected ? 'text-emerald-400' : 'text-red-400'}>
                {snapshot?.analyserSourceConnected ? '已连接 (source→analyser)' : '未连接'}
              </div>
              <div className="text-white/50">Analyser 电平</div>
              <div className="text-white/80 tabular-nums">
                <span className="text-cyan-300">RMS {(snapshot?.analyserRms || 0).toFixed(3)}</span>
                <span className="text-white/40 mx-2">·</span>
                <span className="text-yellow-300">峰值 {(snapshot?.analyserPeak || 0).toFixed(3)}</span>
              </div>
              <div className="text-white/50">Analyser 数据</div>
              <div className={snapshot?.analyserHasData ? 'text-emerald-400' : 'text-white/50'}>
                {snapshot?.analyserHasData ? '有非零数据' : '全零/未就绪'}
              </div>
              <div className="text-white/50">性能档位 / 帧率</div>
              <div className="text-white/80">
                {snapshot?.qualityTier ?? '-'} · {snapshot?.targetFps === 0 ? '不限' : (snapshot?.targetFps ? `${snapshot.targetFps}fps` : '-')}
              </div>
              <div className="text-white/50">本地存储</div>
              <div className="text-white/80">{fmtBytes(snapshot?.storageBytes || 0)}</div>
              <div className="text-white/50">帧总线状态</div>
              <div className={snapshot?.frameBusAlive ? 'text-emerald-400' : snapshot?.frameBusRunning ? 'text-yellow-400' : 'text-white/40'}>
                {snapshot?.frameBusAlive ? '实时' : snapshot?.frameBusRunning ? '运行中(无数据)' : '未启动'}
                <span className="text-white/40 ml-2">FPS {snapshot?.frameBusFps || 0}</span>
              </div>
              <div className="text-white/50">帧总线订阅者</div>
              <div className="text-white/80">
                {snapshot?.frameBusSubscribers || 0} 个
                {snapshot?.frameBusAnalyserConnected ? (
                  <span className="text-emerald-400 ml-2">✓ analyser</span>
                ) : (
                  <span className="text-red-400 ml-2">✗ analyser</span>
                )}
              </div>
              <div className="text-white/50">帧总线看门狗</div>
              <div className={snapshot?.frameBusStallFrames && snapshot.frameBusStallFrames > 10 ? 'text-red-400' : 'text-white/60'}>
                停滞 {snapshot?.frameBusStallFrames || 0} 帧
                {snapshot?.frameBusLastError && (
                  <span className="block text-[10px] text-red-400/70">{snapshot.frameBusLastError}</span>
                )}
              </div>
            </div>
          </section>

          {/* 封面状态 */}
          <section className="space-y-2">
            <div className="text-[11px] text-cyan-400/70 uppercase tracking-widest">Cover3D</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <div className="text-white/50">封面加载</div>
              <div className={snapshot?.coverLoaded ? 'text-emerald-400' : 'text-yellow-400'}>
                {snapshot?.coverLoaded ? '已加载' : '未加载'}
              </div>
              <div className="text-white/50">粒子数</div>
              <div className="text-white/80 tabular-nums">{snapshot?.coverParticleCount || 0}</div>
              <div className="text-white/50">Geometry ID</div>
              <div className="text-white/60 text-[11px]">{snapshot?.coverGeometryId || '-'}</div>
              <div className="text-white/50">PS ID</div>
              <div className="text-white/60 text-[11px]">{snapshot?.coverParticleSystemId || '-'}</div>
              <div className="text-white/50">Intro 进度</div>
              <div className="text-white/80">{fmt(snapshot?.coverIntroProgress || 0, 2)}</div>
              <div className="text-white/50">beatBus kick</div>
              <div className={snapshot?.busKick && snapshot.busKick > 0.1 ? 'text-yellow-300 font-bold' : 'text-white/40'}>
                {fmt(snapshot?.busKick || 0, 3)}
              </div>
              <div className="text-white/50">封面 uBeat</div>
              <div className={snapshot?.coverKickEnvelope && snapshot.coverKickEnvelope > 0.1 ? 'text-cyan-300 font-bold' : 'text-white/40'}>
                {fmt(snapshot?.coverKickEnvelope || 0, 3)}
                <span className="text-white/40 ml-1">{snapshot?.coverIsKick ? '●踢' : '○静'}</span>
              </div>
              <div className="text-white/50">封面低频/峰值</div>
              <div className="text-white/80 tabular-nums">
                <span className="text-yellow-300">{fmt(snapshot?.coverLowLevel || 0, 3)}</span>
                <span className="text-white/40 mx-1">/</span>
                <span className="text-cyan-300">{fmt(snapshot?.coverPeakLevel || 0, 3)}</span>
              </div>
            </div>
          </section>

          {/* 3D 渲染健康 */}
          <section className="space-y-2">
            <div className="text-[11px] text-cyan-400/70 uppercase tracking-widest">3D Render Health</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <div className="text-white/50">渲染状态</div>
              <div className={snapshot?.renderRunning ? 'text-emerald-400' : 'text-yellow-400'}>
                {snapshot?.renderRunning ? '运行中' : '未运行'}
                <span className="text-white/40 ml-2">{snapshot?.renderMode || ''}</span>
              </div>
              <div className="text-white/50">帧率</div>
              <div className="text-cyan-300 font-bold text-sm tabular-nums">
                {snapshot?.renderFps || 0} fps
              </div>
              <div className="text-white/50">总帧数</div>
              <div className="text-white/80 tabular-nums">{snapshot?.renderTotalFrames || 0}</div>
              <div className="text-white/50">WebGL Context</div>
              <div className={
                snapshot?.renderContextState === 'ok' ? 'text-emerald-400' :
                snapshot?.renderContextState === 'lost' ? 'text-red-400' :
                'text-white/40'
              }>
                {snapshot?.renderContextState === 'ok' ? '正常' :
                 snapshot?.renderContextState === 'lost' ? '已丢失' :
                 '未知'}
              </div>
              <div className="text-white/50">错误计数</div>
              <div className={snapshot?.renderErrorCount ? 'text-red-400' : 'text-emerald-400'}>
                {Math.round(snapshot?.renderErrorCount || 0)} 次
              </div>
              <div className="text-white/50">停滞帧数</div>
              <div className="text-white/80 tabular-nums">{snapshot?.renderStallFrames || 0}</div>
              {snapshot?.renderLastError && (
                <div className="col-span-2">
                  <div className="text-white/50">最近错误</div>
                  <div className="text-red-400/80 text-[10px] break-all mt-0.5">{snapshot.renderLastError}</div>
                </div>
              )}
            </div>
          </section>

          {/* 错误日志 */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[11px] text-cyan-400/70 uppercase tracking-widest">
                Error Logs ({logs.length})
              </div>
              <button
                onClick={() => {
                  const svc = getDiagnosticService();
                  svc.addLog('info', 'diagnostic', '手动刷新诊断');
                  setSnapshot(svc.getSnapshot());
                  setLogs(svc.getLogs());
                }}
                className="text-[10px] text-white/50 hover:text-white flex items-center gap-1"
              >
                <RefreshCcw className="w-3 h-3" /> 刷新
              </button>
            </div>
            <div className="max-h-56 overflow-y-auto bg-black/60 rounded-md border border-white/10 p-2 space-y-1">
              {logs.length === 0 ? (
                <div className="text-[11px] text-white/30 text-center py-4">暂无错误日志</div>
              ) : (
                logs.slice().reverse().map(entry => (
                  <div key={entry.id} className="text-[10px] leading-snug break-all">
                    <span className="text-white/30 mr-1">{entry.time}</span>
                    <span className={`${
                      entry.level === 'error' ? 'text-red-400' :
                      entry.level === 'warn' ? 'text-yellow-400' : 'text-emerald-400'
                    } mr-1 uppercase`}>
                      [{entry.level}]
                    </span>
                    <span className="text-cyan-400/70 mr-1">{entry.source}:</span>
                    <span className="text-white/70">{entry.message}</span>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* 关闭按钮 */}
          <Button
            variant="outline"
            onClick={onClose}
            className="w-full border-white/15 text-white/60 hover:text-white hover:bg-white/10"
          >
            关闭工程菜单
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
