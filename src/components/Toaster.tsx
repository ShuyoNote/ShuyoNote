import { useToast } from "../store/toast";
import { inlineMd } from "../lib/inlineMd";

const ICON: Record<string, string> = {
  success: "✓",
  error: "✕",
  info: "ℹ",
};

export function Toaster() {
  const toasts = useToast((s) => s.toasts);
  const dismiss = useToast((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          role="status"
          onClick={() => dismiss(t.id)}
        >
          <span className="toast-icon">{ICON[t.kind]}</span>
          {/* 后端文案是 Markdown 行内写法（`**明文**`…）⇒ 过 `inlineMd` 渲染成 <b>，
              别让用户在界面上看到两个星号（与空间隐私面板同一处实现）。 */}
          <span className="toast-msg">{inlineMd(t.message)}</span>
        </div>
      ))}
    </div>
  );
}
