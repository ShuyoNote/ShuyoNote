import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { toast } from "../../store/toast";

const LANGS = [
  "plain", "javascript", "typescript", "python", "java", "c", "cpp", "csharp",
  "go", "rust", "json", "html", "css", "sql", "bash", "markdown", "yaml", "xml",
];

interface Item {
  key: string;
  el: HTMLElement;
  left: number;
  top: number;
  width: number;
  height: number;
  lines: number;
  lang: string;
  lineHeight: number; /* px, from computed style */
  padTop: number;
}

// Code-block overlay: line numbers + language/copy toolbar rendered OUTSIDE the
// Lexical-owned <code> DOM (which Lexical rewrites on update, clearing anything
// injected inside). Positions from getBoundingClientRect and re-syncs on update /
// scroll / resize, so it survives and never breaks the editor.
export function CodeBlockToolbar() {
  const [editor] = useLexicalComposerContext();
  const [items, setItems] = useState<Item[]>([]);
  const itemsRef = useRef<Item[]>([]);
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  const recompute = () => {
    const root = editor.getRootElement();
    if (!root) return;
    const out: Item[] = [];
    root.querySelectorAll(".editor-codeblock").forEach((el, i) => {
      if (!(el instanceof HTMLElement)) return;
      const rect = el.getBoundingClientRect();
      const text = el.innerText ?? el.textContent ?? "";
      // 空内容(仅换行/空白)算 1 行；否则按换行数。
      const lines = text.trim() === "" ? 1 : (text.match(/\n/g)?.length ?? 0) + 1;
      const lang = el.getAttribute("data-language") || "javascript";
      const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
      const lineHeight = parseFloat(cs?.lineHeight ?? "0") || 0;
      const padTop = parseFloat(cs?.paddingTop ?? "0") || 12;
      out.push({ key: `${i}`, el, left: rect.left, top: rect.top, width: rect.width, height: rect.height, lines, lang, lineHeight, padTop });
    });
    itemsRef.current = out;
    setItems(out);
  };

  useEffect(() => {
    recompute();
    const unreg = editor.registerUpdateListener(() => recompute());
    const onScroll = () => recompute();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      unreg();
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [editor]);

  // hover 代码块时显示右上角工具条，离开隐藏。
  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return;
    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest?.(".editor-codeblock") as HTMLElement | null;
      if (el) {
        const it = itemsRef.current.find((i) => i.el === el);
        setHoverKey(it ? it.key : null);
      } else {
        setHoverKey(null);
      }
    };
    root.addEventListener("mouseover", onOver);
    return () => root.removeEventListener("mouseover", onOver);
  }, [editor]);

  if (items.length === 0) return null;

  return createPortal(
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 40 }}>
      {items.map((it) => {
        const lh = it.lineHeight || (it.lines > 0 ? it.height / it.lines : 24);
        return (
          <div
            key={it.key}
            style={{ position: "absolute", left: it.left, top: it.top, width: it.width, height: it.height, pointerEvents: "none" }}
          >
            {/* 行号 */}
            <div
              style={{
                position: "absolute", left: 8, top: it.padTop, width: 28, textAlign: "right",
                color: "var(--text-faint)", fontSize: "0.85em", lineHeight: `${lh}px`,
                userSelect: "none", whiteSpace: "pre",
              }}
            >
              {Array.from({ length: it.lines }, (_, i) => i + 1).join("\n")}
            </div>
            {/* 工具条 */}
            <div
              style={{
                position: "absolute", right: 8, top: 4, display: "flex", gap: 6,
                opacity: it.key === hoverKey ? 1 : 0,
                pointerEvents: it.key === hoverKey ? "auto" : "none",
                transition: "opacity 0.12s ease",
              }}
            >
              <select
                className="editor-code-lang"
                value={it.lang}
                style={{ background: "var(--block)", color: "var(--text-dim)", border: "1px solid var(--border)", fontSize: 11, borderRadius: 4, padding: "2px 4px", outline: "none" }}
                title="切换语言"
                onChange={(e) => {
                  editor.update(() => {
                    const map = (editor.getEditorState() as any)?._nodeMap as Map<string, any> | undefined;
                    if (!map) return;
                    for (const n of map.values()) {
                      if (n && n.getType && n.getType() === "code") {
                        const dom = editor.getElementByKey(n.getKey());
                        if (dom === it.el && typeof n.setLanguage === "function") {
                          n.setLanguage(e.target.value);
                          break;
                        }
                      }
                    }
                  });
                }}
              >
                {LANGS.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
              <button
                className="editor-code-copy"
                style={{ background: "var(--block)", color: "var(--text-dim)", border: "1px solid var(--border)", fontSize: 11, borderRadius: 4, padding: "2px 6px", cursor: "pointer" }}
                onClick={() => {
                  const txt = it.el.querySelector("code")?.textContent ?? it.el.textContent ?? "";
                  navigator.clipboard
                    .writeText(txt)
                    .then(() => toast("已复制代码", "success"))
                    .catch(() => toast("复制失败", "error"));
                }}
              >
                复制
              </button>
            </div>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
