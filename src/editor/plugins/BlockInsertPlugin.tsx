import { useEffect, useMemo, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNearestNodeFromDOMNode, $getNodeByKey, $getRoot, $createParagraphNode } from "lexical";
import { $findTableNode } from "@lexical/table";
import { makeOptions, type SlashOption } from "./SlashMenuPlugin";
import { isEmptyBlock } from "../blockUtils";

// Feishu-style inline "+": when the cursor is over an EMPTY top-level block, show
// a "+" in the left gutter instead of the ⋮⋮ grip. Clicking it opens the grouped
// insert-block panel; picking an item inserts that block at the empty block.
//
// Layout follows the reference Feishu screenshot (grouped icon + name rows under
// section headers), and it reuses the SAME block options/insert logic as the "/"
// slash menu (makeOptions) so behavior stays consistent.

const HANDLE_OFFSET = 48; // same gutter as the drag grip; flush against content
const HIDE_DELAY = 400;
const PANEL_W = 300;

type PanelState = { top: number; left: number };

function getTopLevelKey(
  editor: ReturnType<typeof useLexicalComposerContext>[0],
  dom: Node | null,
): string | null {
  let el = dom instanceof HTMLElement ? dom : dom?.parentElement ?? null;
  if (!el) return null;
  let key: string | null = null;
  editor.read(() => {
    const node = $getNearestNodeFromDOMNode(el);
    if (!node) return;
    const table = $findTableNode(node);
    if (table) {
      key = table.getKey();
      return;
    }
    const top = node.getTopLevelElement();
    key = top ? top.getKey() : null;
  });
  return key;
}

function isEmptyAtKey(
  editor: ReturnType<typeof useLexicalComposerContext>[0],
  key: string | null,
): boolean {
  if (!key) return false;
  return editor.getEditorState().read(() => isEmptyBlock($getNodeByKey(key)));
}

// Place a collapsed selection inside the target block so the shared insert helpers
// ($replaceBlock / $insertBlockNode) act on it, then run the option.
function runAtBlock(
  editor: ReturnType<typeof useLexicalComposerContext>[0],
  option: SlashOption,
  key: string | null,
) {
  editor.update(() => {
    const node = key ? $getNodeByKey(key) : null;
    let target = node;
    if (!target || !target.isAttached()) {
      // No valid target: fall back to the last top-level paragraph (or create one).
      const root = $getRoot();
      let last = root.getLastChild();
      if (!last) {
        last = $createParagraphNode();
        root.append(last);
      }
      target = last;
    }
    target.selectEnd();
  });
  option.run(editor);
  editor.focus();
}

const GROUP_ORDER = ["基础", "列表", "媒体", "嵌入", "引用"];

export function BlockInsertPlugin({ pageId }: { pageId: string }) {
  const [editor] = useLexicalComposerContext();
  const options = useMemo(() => makeOptions(pageId), [pageId]);
  const [handle, setHandle] = useState<{ top: number; left: number; key: string } | null>(null);
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const activeKeyRef = useRef<string | null>(null);

  const clearHide = () => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  // Show the "+" for the empty top-level block under the cursor.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (panel) return; // keep panel open while interacting
      const target = e.target as Node;
      if (handleRef.current && handleRef.current.contains(target)) {
        clearHide();
        return;
      }
      const key = getTopLevelKey(editor, target);
      if (!key || !isEmptyAtKey(editor, key)) {
        if (hideTimerRef.current === null) {
          hideTimerRef.current = window.setTimeout(() => setHandle(null), HIDE_DELAY);
        }
        return;
      }
      clearHide();
      const el = editor.getElementByKey(key);
      if (el) {
        const rect = el.getBoundingClientRect();
        setHandle({ top: rect.top, left: rect.left - HANDLE_OFFSET, key });
      }
    };
    document.addEventListener("mousemove", onMove, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      clearHide();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, panel]);

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

  const openPanel = (h: { top: number; left: number; key: string }) => {
    activeKeyRef.current = h.key;
    setQuery("");
    // Clamp the panel within the viewport.
    const left = Math.max(8, Math.min(h.left, window.innerWidth - PANEL_W - 8));
    const top = Math.max(8, h.top - 4);
    setPanel({ top, left });
  };

  const select = (option: SlashOption) => {
    setPanel(null);
    setHandle(null);
    runAtBlock(editor, option, activeKeyRef.current);
    activeKeyRef.current = null;
  };

  useEffect(() => {
    if (!panel) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setPanel(null);
        setQuery("");
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPanel(null);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [panel]);

  // Cleanup pending timer on unmount.
  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    };
  }, []);

  return (
    <>
      {handle && !panel && (
        <div
          ref={handleRef}
          className="block-insert-plus"
          style={{ top: handle.top, left: handle.left }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => openPanel(handle)}
          title="插入块"
        >
          ＋
        </div>
      )}

      {panel && (
        <div ref={boxRef} className="block-insert-popover" style={{ top: panel.top, left: panel.left }}>
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
    </>
  );
}
