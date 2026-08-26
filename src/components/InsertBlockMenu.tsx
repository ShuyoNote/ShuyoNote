import { useEffect, useMemo, useRef, useState } from "react";
import { type LexicalEditor, $getRoot, $getSelection, $isRangeSelection, $createParagraphNode } from "lexical";
import { useEditorStore } from "../store/editor";
import { makeOptions, type SlashOption } from "../editor/plugins/SlashMenuPlugin";
import { PlusIcon } from "./icons";

// Ensure a valid (collapsed) range selection exists before running a block's insert
// command. The toolbar button is clicked outside the editor, so Lexical may hold a
// null/root selection; without it, the insert helpers ($replaceBlock/$insertBlockNode)
// bail out silently. We fall back to the end of the last paragraph (or create one).
function ensureSelection(editor: LexicalEditor) {
  editor.update(() => {
    if ($isRangeSelection($getSelection())) return;
    const root = $getRoot();
    let last = root.getLastChild();
    if (!last) {
      last = $createParagraphNode();
      root.append(last);
    }
    last.selectEnd();
  });
}

const GROUP_ORDER = ["基础", "列表", "媒体", "嵌入", "引用"];

export function InsertBlockMenu({ pageId }: { pageId: string }) {
  const editor = useEditorStore((s) => s.editor);
  const options = useMemo(() => makeOptions(pageId), [pageId]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? options.filter(
          (o) =>
            o.title.toLowerCase().includes(q) ||
            (o.pinyin && o.pinyin.includes(q)) ||
            (o.key && o.key.toLowerCase().includes(q)),
        )
      : options;
    const byGroup = new Map<string, SlashOption[]>();
    for (const o of filtered) {
      const list = byGroup.get(o.group) ?? [];
      list.push(o);
      byGroup.set(o.group, list);
    }
    const order = q ? Array.from(byGroup.keys()) : GROUP_ORDER.filter((g) => byGroup.has(g));
    return order.map((g) => ({ group: g, items: byGroup.get(g)! }));
  }, [options, query]);

  const select = (option: SlashOption) => {
    if (!editor) return;
    setOpen(false);
    setQuery("");
    ensureSelection(editor);
    option.run(editor);
    editor.focus();
  };

  // Close when clicking outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div ref={boxRef} className="insert-block-menu">
      <button
        className={`toolbar-btn ${open ? "active" : ""}`}
        onClick={() => {
          setOpen((v) => !v);
          if (open) setQuery("");
        }}
        title="插入块"
      >
        <PlusIcon />
      </button>
      {open && (
        <div className="insert-block-popover">
          <input
            className="insert-block-search"
            placeholder="搜索插入内容…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <div className="insert-block-scroll">
            {grouped.length === 0 ? (
              <div className="insert-block-empty">无匹配块</div>
            ) : (
              grouped.map(({ group, items }) => (
                <div key={group} className="insert-group">
                  <div className="insert-group-title">{group}</div>
                  {items.map((o) => (
                    <button key={o.key} className="insert-item" onClick={() => select(o)}>
                      <span className="insert-icon">{o.badge}</span>
                      <span className="insert-name">{o.title}</span>
                      {o.shortcut && <span className="insert-shortcut">{o.shortcut}</span>}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
