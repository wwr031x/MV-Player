import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logger } from '@lark-apaas/client-toolkit-lite';

interface Props {
  children: ReactNode;
  /** 分区名称，错误时展示 */
  sectionName?: string;
  /** 自定义 fallback 渲染 */
  fallback?: (error: Error) => ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * 分区级错误边界
 * 单个分区出错只在该分区显示"该模块异常"，不允许整个应用白屏
 */
export default class SectionErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error(`[SectionErrorBoundary] ${this.props.sectionName || 'unknown'}:`, {
      error: String(error),
      info: String(errorInfo.componentStack).slice(0, 500),
    });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error);
      }
      const name = this.props.sectionName || '该模块';
      return (
        <div
          className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-center space-y-2"
          role="alert"
        >
          <div className="text-sm text-red-400 font-medium">{name} 异常</div>
          <div className="text-[11px] text-red-400/60 font-mono break-all line-clamp-3">
            {this.state.error.message}
          </div>
          <button
            onClick={this.handleReset}
            className="text-[11px] text-red-400 underline underline-offset-2 hover:text-red-300 transition-colors"
          >
            重新加载
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
