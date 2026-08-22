import { useCallback, useEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";

// In-editor find bar (Ctrl+F). Highlights all matches via the CSS Custom
// Highlight API (presentation-only, never mutates Lexical state), navigates
// through matches with Enter/Shift+Enter or buttons.

function collectRanges(root: HTMLElement, query: string): Range[] {
  const ranges: Range[] = [];
  const lower = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const text = node.nodeValue || "";
    if (!text) continue;
    const lowerText = text.toLowerCase();
    let idx = lowerText.indexOf(lower);
    while (idx !== -1) {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + query.length);
      ranges.push(range);
      idx = lowerText.indexOf(lower, idx + query.length);
    }
  }
  return ranges;
}

export function FindPlugin() {
  const [editor] = useLexicalComposerContext();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [count, setCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);

  const applyHighlights = useCallback((ranges: Range[], active: number) => {
    // @ts-ignore
    const Highlight = window.Highlight;
    // @ts-ignore
    if (typeof Highlight === "undefined" || !window.CSS?.highlights) return;
    if (ranges.length > 0) {
      // @ts-ignore
      const all = new Highlight(...ranges);
      // @ts-ignore
      window.CSS.highlights.set("shuyo-find", all);
      if (active >= 0 && active < ranges.length) {
        // @ts-ignore
        const cur = new Highlight(ranges[active]);
        // @ts-ignore
        window.CSS.highlights.set("shuyo-find-active", cur);
        const el = ranges[active].startContainer.parentElement;
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
      } else {
        // @ts-ignore
        window.CSS.highlights.delete("shuyo-find-active");
      }
    }
  }, []);

  const clearHighlights = useCallback(() => {
    // @ts-ignore
    window.CSS?.highlights?.delete?.("shuyo-find");
    // @ts-ignore
    window.CSS?.highlights?.delete?.("shuyo-find-active");
  }, []);

  // Ctrl+F toggles the find bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Re-run search when query changes.
  useEffect(() => {
    if (!open) {
      clearHighlights();
      return;
    }
    const root = editor.getRootElement();
    if (!root) return;
    const q = query.trim();
    if (!q) {
      clearHighlights();
      setCount(0);
      setIndex(0);
      rangesRef.current = [];
      return;
    }
    const t = setTimeout(() => {
      const ranges = collectRanges(root, q);
      rangesRef.current = ranges;
      setCount(ranges.length);
      const active = ranges.length > 0 ? 0 : -1;
      setIndex(active);
      applyHighlights(ranges, active);
    }, 80);
    return () => clearTimeout(t);
  }, [query, open, editor, applyHighlights, clearHighlights]);

  // Focus input when opened.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Close find bar when clicking outside it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = document.querySelector(".find-bar");
      if (el && !el.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
        clearHighlights();
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, clearHighlights]);

  const go = (dir: 1 | -1) => {
    const ranges = rangesRef.current;
    if (ranges.length === 0) return;
    const next = (index + dir + ranges.length) % ranges.length;
    setIndex(next);
    applyHighlights(ranges, next);
  };

  const close = () => {
    setOpen(false);
    setQuery("");
    clearHighlights();
  };

  if (!open) return null;

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        className="find-input"
        placeholder="查找…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="find-count">
        {query.trim() ? `${count === 0 ? 0 : index + 1} / ${count}` : ""}
      </span>
      <button className="find-btn" onClick={() => go(-1)} disabled={count === 0}>
        ↑
      </button>
      <button className="find-btn" onClick={() => go(1)} disabled={count === 0}>
        ↓
      </button>
      <button className="find-btn" onClick={close} title="关闭">
        ×
      </button>
    </div>
  );
}
