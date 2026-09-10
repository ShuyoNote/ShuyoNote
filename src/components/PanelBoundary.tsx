import type { ReactNode } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

/**
 * 根部浮层（命令面板 / 插件面板 / 各种对话框）的**独立**边界。
 *
 * 为什么要有它（1.85.1 的教训）：这些浮层都挂在 App 根部，而根部原先只有编辑器那一处边界。
 * 于是任何一个浮层在渲染期抛错，React 都会一路往上找到根、把**整棵树**卸载掉——用户看到的
 * 是白屏，而且看不出发生了什么。真实风险不小：命令面板、插件视图、插件管理渲染的都是
 * **插件声明的数据**（manifest 里的列、设置、查询），一个畸形声明就足以让它们抛错。
 *
 * 有了它：崩的那个浮层消失并**就地留下可见的错误文本**（不是静默吞掉），其余界面照常可用。
 * 顶层还另有一道 `AppCrashScreen`（见 `main.tsx`）兜"连 App 自身都挂了"的情况。
 */
export function PanelBoundary({ name, children }: { name: string; children?: ReactNode }) {
  return (
    <ErrorBoundary
      label={name}
      fallback={(error) => (
        <div className="panel-error" role="alert">
          <span className="panel-error-title">「{name}」出错，已单独停用它</span>
          <span className="panel-error-detail">{String(error?.message || error || "未知错误")}</span>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
