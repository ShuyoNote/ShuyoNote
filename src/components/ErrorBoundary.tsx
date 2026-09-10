import { Component, type ReactNode } from "react";

/**
 * 渲染期错误的边界。
 *
 * 为什么这件事在本项目里格外重要（1.85.1 的教训）：`CommandPalette` 里一个 hooks 越界
 * 让**整个界面变成白屏**——因为组件挂在 App 根部、上面没有任何边界，React 找不到边界就
 * 卸载整棵树。有了边界，崩溃被限制在一个组件/浮层的范围里，其余界面继续可用。
 *
 * `fallback` 传函数时能拿到错误对象，用于把「出了什么事」摊给用户看（排查白屏时，
 * 一句错误文本比一张白图有用得多）。
 */
interface Props {
  // `children` 可选：组件用 JSX 写时必填，而测试里走 React.createElement(Comp, props, child)
  // 这种写法在 props 里不带 children——React 18 的类型对「props 里 children 必填」不能这样调。
  children?: ReactNode;
  fallback?: ReactNode | ((error: Error | null) => ReactNode);
  /** 日志前缀（`[ShuyoNote] {label} error:`），用来分辨是谁崩了。 */
  label?: string;
}

interface State {
  hasError: boolean;
  error?: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    // 错误在这里就存下来（而不是等 componentDidCatch 里的 setState）：兜底屏**第一次**
    // 渲染就能显示真正的错误文本，否则用户可能先看到一版「未知错误」并照着它反馈。
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    // 只负责记录；状态已由 getDerivedStateFromError 设好。
    console.error(`[ShuyoNote] ${this.props.label ?? "editor"} error:`, error);
  }

  render() {
    if (this.state.hasError) {
      const fallback = this.props.fallback;
      if (typeof fallback === "function") return fallback(this.state.error ?? null);
      return (
        fallback ?? (
          <div className="editor-error">
            编辑器加载失败，请切换到其他页面。
            <div className="editor-error-detail">{String(this.state.error?.message || this.state.error || "")}</div>
          </div>
        )
      );
    }
    return this.props.children;
  }
}

