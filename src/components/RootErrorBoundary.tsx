import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logger } from '@lark-apaas/client-toolkit-lite';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * 最外层错误边界 - 包在 HashRouter 和 AppContainer 外面
 * Fallback 保证醒目不透明，绝不能是纯黑/透明
 */
export default class RootErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    logger.error('[RootErrorBoundary]', { error, errorInfo });
  }

  handleGoHome = () => {
    // HashRouter 下首页路径为 #/
    window.location.hash = '/';
    // 强制重载清除错误状态
    window.location.reload();
  };

  handleRefresh = () => {
    window.location.reload();
  };

  handleClearCache = () => {
    try {
      localStorage.clear();
    } catch { /* ignore */ }
    try {
      sessionStorage.clear();
    } catch { /* ignore */ }
    // 强制无缓存重载
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      const err = this.state.error;
      const stack = this.state.errorInfo?.componentStack || err?.stack || '';
      const stackLines = stack.split('\n').filter(Boolean).slice(0, 8).join('\n');

      return (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'linear-gradient(135deg, #1a0800 0%, #2d1000 50%, #1a0505 100%)',
              color: '#fff',
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
              padding: '24px',
              zIndex: 99999,
              overflow: 'auto',
            }}
          >
          <div
            style={{
              width: '64px',
              height: '64px',
              borderRadius: '16px',
              background: 'linear-gradient(135deg, #ff6b35, #ff3d7f)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '28px',
              fontWeight: 700,
              color: '#fff',
              marginBottom: '20px',
              boxShadow: '0 0 50px rgba(255,107,53,0.6)',
            }}
          >
            M
          </div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, margin: 0, marginBottom: '10px', color: '#fff' }}>
            界面渲染出错
          </h1>
          <p style={{ fontSize: '14px', color: '#ffd4b8', margin: 0, marginBottom: '18px', textAlign: 'center', lineHeight: 1.6 }}>
            M V Player 首屏渲染出现异常<br/>请刷新重试
          </p>

          {err && (
            <div
              style={{
                background: 'rgba(255,107,53,0.12)',
                border: '1px solid rgba(255,107,53,0.4)',
                borderRadius: '10px',
                padding: '12px',
                maxWidth: '360px',
                width: '100%',
                marginBottom: '16px',
                fontSize: '12px',
                color: '#ffd4b8',
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                lineHeight: 1.5,
              }}
            >
              <div style={{ color: '#ff6b35', fontWeight: 700, marginBottom: '8px', fontSize: '13px' }}>
                {err.name}: {err.message}
              </div>
              {stackLines && <div style={{ opacity: 0.7, fontSize: '11px' }}>{stackLines}</div>}
            </div>
          )}

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center', marginBottom: '16px' }}>
            <button
              onClick={this.handleGoHome}
              style={{
                padding: '10px 24px',
                borderRadius: '8px',
                background: 'rgba(255,255,255,0.08)',
                color: '#ffd4b8',
                border: '1px solid rgba(255,255,255,0.2)',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              返回首页
            </button>
            <button
              onClick={this.handleRefresh}
              style={{
                padding: '10px 24px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #ff6b35, #ff3d7f)',
                color: '#fff',
                border: 'none',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer',
                boxShadow: '0 4px 20px rgba(255,107,53,0.5)',
              }}
            >
              刷新重试
            </button>
            <button
              onClick={this.handleClearCache}
              style={{
                padding: '10px 24px',
                borderRadius: '8px',
                background: 'rgba(255,255,255,0.05)',
                color: '#ffd4b8',
                border: '1px solid rgba(255,255,255,0.15)',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              清除缓存并重置
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
