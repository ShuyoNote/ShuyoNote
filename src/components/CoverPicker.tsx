import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { COVER_PRESETS } from "../lib/covers";

// M25/页面封面 — a small gallery to pick a built-in cover (or clear / custom).
export function CoverPicker({ onClose, onPick, current }: { onClose: () => void; onPick: (css: string) => void; current?: string }) {
  const [custom, setCustom] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="cover-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cover-picker">
        <div className="cover-picker-head">
          <span className="cover-picker-title">选择题头图</span>
          <span className="cover-picker-sub">内置封面</span>
        </div>
        <div className="cover-picker-grid">
          {COVER_PRESETS.map((p) => (
            <button
              key={p.id}
              className={`cover-swatch ${current === p.css ? "active" : ""}`}
              style={{ background: p.css }}
              title={p.name}
              onClick={() => onPick(p.css)}
            />
          ))}
        </div>
        <div className="cover-picker-custom">
          <input
            ref={inputRef}
            className="cover-picker-input"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && custom.trim()) {
                onPick(custom.trim());
              }
            }}
            placeholder="自定义 CSS 渐变，如 linear-gradient(135deg, #667eea, #764ba2)；回车应用"
            spellCheck={false}
          />
        </div>
        <div className="cover-picker-actions">
          <button className="cover-picker-clear" onClick={() => onPick("")}>
            清除
          </button>
          <button className="cover-picker-btn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
