/**
 * Sonic 独立 DOM 调试层（根本性改造版）
 *  - 模块加载时就创建面板（不依赖 React/Three，任何崩溃都可见）
 *  - 生命周期探针 + 错误实时显示 + 包围盒/相机/NDC 数据
 *  - 触发条件：URL ?debug=sonic 或 localStorage.sonicDebug=1
 *  - 任何阶段出错 → 强制显示面板（即使用户没开 debug）
 */

import { scopedStorage, logger } from '@lark-apaas/client-toolkit-lite';

let layerEl: HTMLDivElement | null = null;
let preEl: HTMLPreElement | null = null;
let errorEl: HTMLPreElement | null = null;
let visible = false;

// 生命周期阶段状态
type StageStatus = 'pending' | 'running' | 'done' | 'failed';
interface StageInfo {
  status: StageStatus;
  timeMs?: number;   // 完成/失败时的耗时
  detail?: string;   // 附加说明或错误信息
}

const STAGE_ORDER = [
  'moduleInit',
  'ensureLayer',
  'loadThree',
  'createRenderer',
  'createTopography',
  'applyLayout',
  'computeBounds',
  'fitCamera',
  'firstFrame',
  'everyFrame',
  'shaderCompile',
] as const;

type StageName = (typeof STAGE_ORDER)[number];

const stages: Record<StageName, StageInfo> = STAGE_ORDER.reduce(
  (acc, s) => {
    acc[s] = { status: 'pending' };
    return acc;
  },
  {} as Record<StageName, StageInfo>,
);

let startTimes: Partial<Record<StageName, number>> = {};
let extraLines: string[] = [];

function isDebugEnabled(): boolean {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('debug') === 'sonic') return true;
    if (url.searchParams.get('mode') === 'sonic' && url.searchParams.get('debug') === 'sonic') return true;
    // HashRouter 下参数可能在 hash 里，如 #/?mode=sonic&debug=sonic
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    if (qIdx >= 0) {
      const hashQuery = hash.slice(qIdx + 1);
      const params = new URLSearchParams(hashQuery);
      if (params.get('debug') === 'sonic') return true;
    }
  } catch { /* ignore */ }
  try {
    if (scopedStorage.getItem('sonicDebug') === '1') return true;
  } catch { /* ignore */ }
  // localStorage 兜底（scopedStorage 可能在某些场景不可用）
  try {
    if (localStorage.getItem('sonicDebug') === '1') return true;
  } catch { /* ignore */ }
  return false;
}

function createLayer(): void {
  if (layerEl) return;
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  const layer = document.createElement('div');
  layer.style.cssText = [
    'position: fixed',
    'top: 8px',
    'left: 8px',
    'z-index: 2147483647',
    'max-width: 480px',
    'max-height: 88vh',
    'overflow: auto',
    'background: rgba(5, 8, 16, 0.94)',
    'border: 1px solid rgba(0, 220, 255, 0.4)',
    'border-radius: 8px',
    'padding: 10px 12px',
    'font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    'font-size: 11px',
    'line-height: 1.5',
    'color: #a5f3fc',
    'pointer-events: auto',
    'user-select: text',
    'backdrop-filter: blur(8px)',
    'box-shadow: 0 8px 32px rgba(0, 0, 0, 0.7)',
  ].join('; ');
  layer.id = 'sonic-debug-layer';

  const title = document.createElement('div');
  title.textContent = '═ SONIC DEBUG LAYER ═';
  title.style.cssText = 'color: #22d3ee; font-weight: bold; margin-bottom: 6px; letter-spacing: 0.5px; font-size: 12px;';

  const pre = document.createElement('pre');
  pre.style.cssText = 'margin: 0; white-space: pre-wrap; word-break: break-all; color: #a5f3fc;';
  preEl = pre;

  const err = document.createElement('pre');
  err.style.cssText = 'margin: 8px 0 0; white-space: pre-wrap; word-break: break-all; color: #ff6b6b; display: none; background: rgba(255,0,0,0.06); padding: 6px 8px; border-radius: 4px; border-left: 3px solid #ff6b6b;';
  errorEl = err;

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '[ 关闭 ]';
  closeBtn.style.cssText = 'margin-top: 8px; background: none; border: none; color: #22d3ee; cursor: pointer; font-family: inherit; font-size: 10px; padding: 0; opacity: 0.7;';
  closeBtn.addEventListener('click', () => {
    if (layerEl) layerEl.style.display = 'none';
  });

  layer.appendChild(title);
  layer.appendChild(pre);
  layer.appendChild(err);
  layer.appendChild(closeBtn);
  document.body.appendChild(layer);
  layerEl = layer;
  visible = true;
}

export function ensureSonicDebugLayer(force = false): void {
  if (!force && !isDebugEnabled()) return;
  if (!layerEl) {
    createLayer();
    setStageDone('ensureLayer');
    render();
  } else if (!visible) {
    layerEl.style.display = 'block';
    visible = true;
    render();
  }
}

export function stageStart(name: StageName): void {
  stages[name].status = 'running';
  startTimes[name] = performance.now();
  if (!visible) return;
  render();
}

export function setStageDone(name: StageName, detail?: string): void {
  const t0 = startTimes[name];
  stages[name].status = 'done';
  stages[name].timeMs = t0 ? Math.round(performance.now() - t0) : undefined;
  stages[name].detail = detail;
  if (!visible) return;
  render();
}

export function setStageFailed(name: StageName, error: unknown): void {
  // 错误时强制显示调试层，即使用户没开 debug=sonic
  if (!visible) {
    try { ensureSonicDebugLayer(true); } catch { /* ignore */ }
  }
  if (!visible) return;
  const t0 = startTimes[name];
  stages[name].status = 'failed';
  stages[name].timeMs = t0 ? Math.round(performance.now() - t0) : undefined;
  const msg = error instanceof Error ? error.message : String(error);
  stages[name].detail = msg.slice(0, 200);
  // 同步到错误面板
  if (errorEl) {
    errorEl.style.display = 'block';
    const stack = error instanceof Error ? error.stack || '' : '';
    const stackLines = stack.split('\n').slice(0, 8).join('\n');
    const prev = errorEl.textContent || '';
    errorEl.textContent = `${prev ? prev + '\n\n' : ''}✖ ERROR [${name}]\n${msg}\n${stackLines}`;
  }
  render();
}

export function setExtra(lines: string[]): void {
  extraLines = lines;
  if (!visible) return;
  render();
}

export function reportError(tag: string, error: unknown): void {
  // 错误时强制显示调试层
  if (!visible) {
    try { ensureSonicDebugLayer(true); } catch { /* ignore */ }
  }
  if (!visible) return;
  if (errorEl) {
    errorEl.style.display = 'block';
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack || '' : '';
    const stackLines = stack.split('\n').slice(0, 8).join('\n');
    const prev = errorEl.textContent || '';
    errorEl.textContent = `${prev ? prev + '\n\n' : ''}✖ ERROR [${tag}]\n${msg}\n${stackLines}`;
  }
}

function statusIcon(s: StageStatus): string {
  switch (s) {
    case 'pending': return '·';
    case 'running': return '◐';
    case 'done': return '✓';
    case 'failed': return '✖';
  }
}

function render(): void {
  if (!visible || !preEl) return;
  const lines: string[] = [];
  lines.push('── Lifecycle ──');
  for (const name of STAGE_ORDER) {
    const s = stages[name];
    const icon = statusIcon(s.status);
    const t = s.timeMs !== undefined ? ` ${s.timeMs}ms` : '';
    const d = s.detail ? ` — ${s.detail}` : '';
    lines.push(`${icon} ${name}${t}${d}`);
  }
  if (extraLines.length > 0) {
    lines.push('');
    for (const l of extraLines) lines.push(l);
  }
  preEl.textContent = lines.join('\n');
}

export function __forceShow(): void {
  visible = true;
  if (!layerEl) createLayer();
  if (layerEl) layerEl.style.display = 'block';
  render();
}

export function hideSonicDebugLayer(): void {
  visible = false;
  if (layerEl) {
    layerEl.style.display = 'none';
  }
}

export function resetSonicDebugStages(): void {
  for (const name of STAGE_ORDER) {
    stages[name] = { status: 'pending' };
  }
  startTimes = {};
  extraLines = [];
  if (errorEl) {
    errorEl.style.display = 'none';
    errorEl.textContent = '';
  }
  if (visible) render();
}

// ===== 模块级初始化：只要 URL 有 debug=sonic，模块被 import 时就立即创建面板 =====
// 这保证了面板在任何 React/Three 代码执行之前就已经挂在 DOM 上
// 即使后续初始化完全崩溃，用户也能看到面板和错误信息
(function moduleInit() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // 标记模块初始化阶段（用于探针显示）
  stages['moduleInit'].status = 'done';
  stages['moduleInit'].detail = `ts=${Date.now()}`;

  // 如果 URL 里有 debug=sonic，立即创建面板
  // （不依赖 React 组件挂载，保证最早可见）
  if (isDebugEnabled()) {
    try {
      // DOMContentLoaded 之前 document.body 可能不存在，做个保护
      if (document.body) {
        createLayer();
        setStageDone('ensureLayer', 'module-level init');
        render();
      } else {
        // body 还没准备好，等 DOMContentLoaded
        document.addEventListener('DOMContentLoaded', () => {
          createLayer();
          setStageDone('ensureLayer', 'module-level init (post-DOM)');
          render();
        });
      }
    } catch (e) {
      // 极端情况：连创建面板都失败（基本不可能），用 logger 兜底
      logger.warn('[sonic-debug] failed to create debug layer:', String(e));
    }
  }
})();

// 暴露到 window 方便调试
if (typeof window !== 'undefined') {
  (window as any).__sonicDebug = {
    show: () => __forceShow(),
    hide: () => hideSonicDebugLayer(),
    getStages: () => ({ ...stages }),
  };
}
