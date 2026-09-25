import { useEffect, useRef } from "react";
import { useInputStore } from "../store/input";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { useOverlayLayer } from "../hooks/useOverlayLayer";

// In-app text-input dialog, centered in the app window (reuses the confirm-box
// visual language). Enter submits, Escape cancels.
//
// ★ 另有一个**单选模式**（`chooser !== null`，owner 2026-09-25 拍板 A1 的落点）：
// 同一个盒子、同一套浮层登记，只是把输入框换成一排按钮 —— 用在"建空间时选个人/团队"那种
// **开启时二选一**上。两个模式**互斥**（同一个 `input` 浮层槽位，同时只会有一个）。
export function InputDialog() {
  const options = useInputStore((s) => s.options);
  const chooser = useInputStore((s) => s.chooser);
  const close = useInputStore((s) => s.close);
  const closeChoice = useInputStore((s) => s.closeChoice);
  const inputRef = useRef<HTMLInputElement>(null);
  const open = !!options || !!chooser;
  useOverlayScrollLock(open);
  // Android 返回键：优先关掉最上层浮层（见 lib/overlayStack.ts）。
  // ⚠️ 取消**必须**走 `closeChoice(null)`（那一支要兑现 promise，不能只把盒子藏起来）。
  useOverlayLayer("input", open, () => {
    if (useInputStore.getState().chooser) useInputStore.getState().closeChoice(null);
    else useInputStore.getState().close();
  });

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

  if (chooser) {
    return (
      <div className="confirm-overlay" onClick={() => closeChoice(null)}>
        <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
          {chooser.title && (
            <div className="confirm-head">
              <span className="confirm-icon">?</span>
              <span className="confirm-title">{chooser.title}</span>
            </div>
          )}
          <div className="input-choice-list">
            {chooser.choices.map((c) => (
              <button
                key={c.value}
                className="input-choice"
                onClick={() => closeChoice(c.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") closeChoice(null);
                }}
              >
                <span className="input-choice-label">{c.label}</span>
                {c.hint && <span className="input-choice-hint">{c.hint}</span>}
              </button>
            ))}
          </div>
          <div className="confirm-actions">
            <button className="confirm-cancel" onClick={() => closeChoice(null)}>
              {chooser.cancelLabel ?? "取消"}
            </button>
          </div>
        </div>
      </div>
    );
  }

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
