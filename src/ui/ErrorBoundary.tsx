import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Btn, Card } from './kit';

/**
 * 极简错误边界：把「整屏白」降级成「这一页没打开」。
 * 外壳级（main.tsx）兜住启动/渲染致命错误；页面级（AppMain）兜住
 * lazy chunk 加载失败，保证开单页不被其它页面的坏 chunk 连坐。
 *
 * 不引第三方库：只用 getDerivedStateFromError + componentDidCatch。
 */
export type ErrorFallback = ReactNode | ((error: Error, reset: () => void) => ReactNode);

export interface ErrorBoundaryProps {
  /** 兜底内容；需要「重试」能力时传渲染函数，参数里带 reset */
  fallback: ErrorFallback;
  /** 额外上报（默认已经 console.error） */
  onError?: (error: Error) => void;
  /**
   * 路由标识（tab/子页/单据 id）。变化时自动清掉错误态，
   * 否则某一页坏了以后，切到别的页面也一直停在兜底上。
   */
  resetKey?: string;
  children?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 摊位现场没有远程日志，至少留在控制台，方便连手机调试时看
    console.error('[ErrorBoundary] 页面渲染失败：', error, info.componentStack);
    this.props.onError?.(error);
  }

  /** 重置错误态 → 重新挂载子树（chunk 若已恢复缓存则能直接打开） */
  reset = () => this.setState({ error: null });

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.reset();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { fallback } = this.props;
    if (typeof fallback === 'function') return fallback(error, this.reset);
    return fallback ?? null;
  }
}

/** 外壳级兜底：连壳都没了，只能整体重开 */
export function ShellErrorFallback() {
  return (
    <div className="page-stack">
      <Card>
        <h2 className="section-title">页面没打开</h2>
        <p className="muted-text" style={{ marginTop: 'var(--yh-space-2)', marginBottom: 'var(--yh-space-4)' }}>
          可能是刚更新、缓存还没换过来。账本数据都存在本机，不会丢。
        </p>
        <Btn block onClick={() => window.location.reload()}>
          重新打开
        </Btn>
      </Card>
    </div>
  );
}

/** 页面级兜底：只坏了一页，重试本页即可，不影响开单 */
export function PageErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="page-stack" role="alert">
      <Card>
        <h2 className="section-title">这一页没打开</h2>
        <p className="muted-text" style={{ marginTop: 'var(--yh-space-2)' }}>
          页面文件没加载成功，弱网或刚更新时常见。其它页面照常能用。
        </p>
        {error.message ? (
          <p className="tiny-text" style={{ margin: 'var(--yh-space-1) 0 var(--yh-space-2)' }}>
            {error.message}
          </p>
        ) : null}
        <Btn block onClick={onRetry}>
          重试本页
        </Btn>
      </Card>
    </div>
  );
}