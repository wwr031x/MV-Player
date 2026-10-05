import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { AppContainer, logger } from '@lark-apaas/client-toolkit-lite';
import App from "./app";
import "./index.css";
import RootErrorBoundary from "./components/RootErrorBoundary";
import { Toaster } from 'sonner';

// 标记 JS 模块加载成功（内联看门狗用来判断卡在哪一步）
if (typeof (window as any).__bootJsLoaded === 'function') {
  (window as any).__bootJsLoaded();
}

// 8 秒渲染超时看门狗（内联脚本里也有一份纯内联的，这是 JS 侧的备份日志）
// 真正的硬超时由 index.html 内联脚本负责，这里只做日志记录
const RENDER_WATCHDOG_MS = 8000;
const renderWatchdogTimer = setTimeout(() => {
  const booted = document.body.getAttribute('data-booted') === 'true';
  if (!booted) {
    logger.error('[Watchdog] React render timeout after ' + RENDER_WATCHDOG_MS + 'ms');
    // 显示 boot-error 兜底界面（内联脚本定义的 __bootShowError 如果存在的话）
    const errorEl = document.getElementById('boot-error');
    const loadingEl = document.getElementById('boot-loading');
    const errorDetailEl = document.getElementById('boot-error-detail');
    if (errorEl && loadingEl) {
      loadingEl.style.display = 'none';
      errorEl.classList.add('visible');
      if (errorDetailEl) {
        errorDetailEl.textContent = '首屏渲染超时（>8s），React 可能挂起或报错';
      }
    }
  }
}, RENDER_WATCHDOG_MS);

// 暴露给 App 组件调用：首屏真正渲染完成后再隐藏 loading
(window as any).__markBooted = function markBooted() {
  clearTimeout(renderWatchdogTimer);
  if (typeof (window as any).__bootSuccess === 'function') {
    (window as any).__bootSuccess();
  } else {
    document.body.setAttribute('data-booted', 'true');
  }
};

// 全局错误监听（仅日志，不展示调试UI）
window.addEventListener('error', (e) => {
  try {
    logger.warn("[Global Error]", e.message || String(e.error || 'unknown'));
  } catch { /* ignore */ }
}, true);

window.addEventListener('unhandledrejection', (e) => {
  try {
    logger.warn("[Unhandled Promise]", String(e.reason?.message || e.reason || ''));
  } catch { /* ignore */ }
});

// React 挂载
try {
  createRoot(document.getElementById("root")!).render(
    <RootErrorBoundary>
      <HashRouter>
        <AppContainer>
          <App />
        </AppContainer>
      </HashRouter>
      <Toaster
        position="top-center"
        toastOptions={{
          style: {
            background: 'rgba(15, 23, 42, 0.95)',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '10px',
            backdropFilter: 'blur(10px)',
          },
          duration: 2500,
        }}
      />
    </RootErrorBoundary>,
  );
} catch (err) {
  // 最极端兜底：React 同步挂载完全失败
  logger.error("[Fatal] React mount failed:", String(err));
  const root = document.getElementById("root");
  if (root) {
    root.innerHTML = `
      <div style="position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#ff5522;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;gap:16px;z-index:999999;padding:32px;overflow:auto;">
        <div style="font-size:64px;">!</div>
        <div style="font-size:24px;font-weight:700;">界面出错了</div>
        <div style="font-size:14px;opacity:0.9;text-align:center;max-width:320px;">
          M V Player 无法启动<br>请刷新页面重试
        </div>
        <div style="font-size:12px;opacity:0.7;background:rgba(0,0,0,0.2);border-radius:8px;padding:10px;max-width:320px;width:100%;word-break:break-all;">
          ${String(err).slice(0, 200)}
        </div>
        <button onclick="location.reload()" style="margin-top:8px;padding:12px 28px;border-radius:10px;background:#fff;color:#ff5522;border:none;font-size:15px;font-weight:700;cursor:pointer;">
          刷新重试
        </button>
      </div>
    `;
  }
}
