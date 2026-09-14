import { useConfirmStore } from "../store/confirm";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";

// In-app confirmation modal, centered in the app window.
export function ConfirmDialog() {
  const options = useConfirmStore((s) => s.options);
  const close = useConfirmStore((s) => s.close);
  // 浮层打开时锁住内容区滚动（锁的是 `.note-scroll`，不是 body——见 hook 里的说明）。
  useOverlayScrollLock(!!options);
  if (!options) return null;
  return (
    <div className="confirm-overlay" onClick={() => close(false)}>
      <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
        {options.title && (
          <div className="confirm-head">
            <span className={`confirm-icon ${options.danger ? "confirm-icon-danger" : ""}`}>
              {options.danger ? "!" : "✓"}
            </span>
            <span className="confirm-title">{options.title}</span>
          </div>
        )}
        <div className="confirm-message">{options.message}</div>
        <div className="confirm-actions">
          <button className="confirm-cancel" onClick={() => close(false)}>
            {options.cancelLabel ?? "取消"}
          </button>
          <button
            className={`confirm-ok ${options.danger ? "confirm-ok-danger" : ""}`}
            onClick={() => close(true)}
          >
            {options.okLabel ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}
