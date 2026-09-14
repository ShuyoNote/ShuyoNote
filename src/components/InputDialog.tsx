import { useEffect, useRef } from "react";
import { useInputStore } from "../store/input";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { useOverlayLayer } from "../hooks/useOverlayLayer";

// In-app text-input dialog, centered in the app window (reuses the confirm-box
// visual language). Enter submits, Escape cancels.
export function InputDialog() {
  const options = useInputStore((s) => s.options);
  const close = useInputStore((s) => s.close);
  const inputRef = useRef<HTMLInputElement>(null);
  useOverlayScrollLock(!!options);
  // Android 返回键：优先关掉最上层浮层（见 lib/overlayStack.ts）。
  useOverlayLayer("input", !!options, () => useInputStore.getState().close());

  useEffect(() => {
    if (options) {
      // Focus + select default value on open.
      const t = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(t);
    }
  }, [options]);

  if (!options) return null;

  const submit = () => {
    const v = inputRef.current?.value.trim() ?? "";
    if (v) options.onSubmit?.(v);
    close();
  };

  return (
    <div className="confirm-overlay" onClick={close}>
      <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
        {options.title && (
          <div className="confirm-head">
            <span className="confirm-icon">✎</span>
            <span className="confirm-title">{options.title}</span>
          </div>
        )}
        <input
          ref={inputRef}
          className="input-dialog-field"
          placeholder={options.placeholder ?? ""}
          defaultValue={options.defaultValue ?? ""}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              close();
            }
          }}
        />
        <div className="confirm-actions">
          <button className="confirm-cancel" onClick={close}>
            {options.cancelLabel ?? "取消"}
          </button>
          <button className="confirm-ok" onClick={submit}>
            {options.okLabel ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}
