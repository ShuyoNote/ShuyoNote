import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
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

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error("[ShuyoNote] editor error:", error);
    this.setState({ error: error });
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
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
