import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditorStore } from "../store/editor";
import { shortcutGroups, shortcutSearch, type Shortcut } from "../lib/shortcuts";

// M25 — Keyboard-shortcuts overlay (global `?` / `Ctrl+/`). Reuses the modal
// backdrop pattern from AiSettingsDialog/CommandPalette and reads the single
// source of truth in `src/lib/shortcuts.ts`.
export function ShortcutsPanel() {
  const open = useEditorStore((s) => s.shortcutsOpen);
  const close = useEditorStore((s) => s.closeShortcuts);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      const t = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if ((e.ctrlKey || e.metaKey) && e.key === "/") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;
  const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform ?? "");
  const results = shortcutSearch(q);

  return createPortal(
    <div
      className="shortcuts-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="shortcuts">
        <div className="shortcuts-head">
          <span className="shortcuts-title">快捷键</span>
          <input
            ref={inputRef}
            className="shortcuts-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索快捷键…"
            spellCheck={false}
          />
        </div>
        <div className="shortcuts-body">
          {shortcutGroups().map((g) => {
            const list = results.filter((s) => s.group === g);
            if (list.length === 0) return null;
            return (
              <div key={g} className="shortcuts-group">
                <div className="shortcuts-group-title">{g}</div>
                {list.map((s: Shortcut) => (
                  <div key={s.key} className="shortcuts-row">
                    <span className="shortcuts-label">{s.label}</span>
                    <span className="shortcuts-keys">
                      {(isMac && s.macKeys ? s.macKeys : s.keys).map((k, i) => (
                        <kbd key={i}>{k}</kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
          {results.length === 0 && <div className="shortcuts-empty">未找到匹配的快捷键</div>}
        </div>
        <div className="shortcuts-foot">按 Esc 或再按 ⌘/Ctrl+/ 关闭</div>
      </div>
    </div>,
    document.body,
  );
}
