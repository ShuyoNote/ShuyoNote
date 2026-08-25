import { useCallback, useEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection, $isTextNode, COMMAND_PRIORITY_EDITOR, KEY_DOWN_COMMAND } from "lexical";
import { useNotes } from "../../store/notes";
import { suggestPageLinks } from "../../lib/mention";

// M19.3 — "链接建议增强": type `[[` and a menu of matching page titles appears
// (sorted by match/relevance); Enter or click inserts `[[标题]]`.
export function PageLinkSuggestPlugin() {
  const [editor] = useLexicalComposerContext();
  const notes = useNotes();
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [sel, setSel] = useState(0);

  const matches = suggestPageLinks(query, notes.pages.map((p) => ({ id: p.id, title: p.title, updated_at: p.updated_at })));

  // Detect an unclosed `[[query` at the caret → show suggestions + position.
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          setOpen(false);
          return;
        }
        const node = selection.anchor.getNode();
        if (!$isTextNode(node)) {
          setOpen(false);
          return;
        }
        const text = node.getTextContent();
        const before = text.slice(0, selection.anchor.offset);
        const m = before.match(/(?:^|\s)(\[\[([^\]]*))$/);
        if (!m) {
          setOpen(false);
          return;
        }
        setQuery(m[2]);
        setSel(0);
        const dom = editor.getElementByKey(node.getKey());
        if (dom) {
          const r = dom.getBoundingClientRect();
          setPos({ top: r.bottom + 4, left: r.left });
        }
        setOpen(true);
      });
    });
  }, [editor]);

  const select = useCallback(
    (title: string) => {
      setOpen(false);
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const node = selection.anchor.getNode();
        if (!$isTextNode(node)) return;
        const text = node.getTextContent();
        const offset = selection.anchor.offset;
        const m = text.slice(0, offset).match(/(\[\[)([^\]]*)$/);
        if (!m) return;
        const start = m.index as number;
        node.spliceText(start, offset, `[[${title}]]`);
      });
    },
    [editor],
  );
  const selectRef = useRef(select);
  selectRef.current = select;

  // Keyboard nav (Enter / Arrow keys / Escape).
  useEffect(() => {
    if (!open) return;
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (e: KeyboardEvent) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSel((v) => Math.min(v + 1, matches.length - 1));
          return true;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSel((v) => Math.max(v - 1, 0));
          return true;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const t = matches[sel];
          if (t) selectRef.current(t);
          return true;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setOpen(false);
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [open, editor, matches, sel]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!open || matches.length === 0) return null;

  return (
    <div ref={menuRef} className="page-link-suggest" style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 70 }}>
      {matches.map((t, i) => (
        <button
          key={t}
          className={`page-link-suggest-item ${i === sel ? "active" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            select(t);
          }}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
