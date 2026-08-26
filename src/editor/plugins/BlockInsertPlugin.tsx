import { useEffect, useMemo, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNearestNodeFromDOMNode, $getNodeByKey, $getRoot, $createParagraphNode } from "lexical";
import { $findTableNode } from "@lexical/table";
import { useEditorStore } from "../../store/editor";
import { makeOptions, type SlashOption } from "./SlashMenuPlugin";
import { isEmptyBlock } from "../blockUtils";

// Feishu-style inline "+": when the cursor is over an EMPTY top-level block, show a
// "+" in the left gutter. Hovering / clicking the "+" auto-opens an insert panel that
// matches Feishu's layout: a pinned "AI 帮我写" entry on top, then grouped sections
// (基础 / 常用 / 多维表格) of icon + name rows. Only blocks ShuyoNote actually supports
// are shown (unimplemented Feishu blocks are omitted), reusing makeOptions so the
// insert logic matches the "/" slash menu.

const HANDLE_OFFSET = 48; // same gutter as the drag grip; flush against content
const CLOSE_DELAY = 260; // linger so the cursor can travel onto the panel
const HIDE_DELAY_MS = 400;

// Map each supported block key to a Feishu-style section. Keys not listed are
// placed in 常用 by default. "多维表格" only appears if any key maps to it.
const SECTION_OF: Record<string, string> = {
  h1: "基础", h2: "基础", h3: "基础", p: "基础", quote: "基础",
  code: "基础", hr: "基础", todo: "基础", ul: "基础", ol: "基础", link: "基础",
  // 常用
  image: "常用", drawing: "常用", mermaid: "常用", aidraw: "常用", video: "常用",
  attachment: "常用", fileref: "常用", webbookmark: "常用", callout: "常用", table: "常用",
  blockref: "常用", blockembed: "常用",
};
const SECTION_ORDER = ["基础", "常用", "多维表格"];

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

// Open the inline AI draft bar ("AI 帮我写") anchored at the target block, exactly
// like the Space-on-blank-line trigger (AiSpaceTriggerPlugin).
function openAiDraft(editor: ReturnType<typeof useLexicalComposerContext>[0], key: string | null) {
  if (!key) return;
  const st = useEditorStore.getState();
  let pos: { top: number; left: number } | null = null;
  editor.getEditorState().read(() => {
    const node = $getNodeByKey(key);
    if (!node) return;
    const top = node.getTopLevelElement();
    if (!top) return;
    st.setAiBarAnchorKey(top.getKey());
    const dom = editor.getElementByKey(top.getKey());
    if (dom) {
      const r = dom.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      const popTop = below < 340 ? Math.max(8, r.top - 360) : r.bottom + 6;
      const popW = Math.min(780, window.innerWidth - 24);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - popW - 8));
      pos = { top: popTop, left };
    }
  });
  if (pos) st.setAiBarPos(pos);
  st.setAiBarOpen(true);
  editor.focus();
}

export function BlockInsertPlugin({ pageId }: { pageId: string }) {
  const [editor] = useLexicalComposerContext();
  const options = useMemo(() => makeOptions(pageId), [pageId]);
  const [handle, setHandle] = useState<{ top: number; left: number; key: string } | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelAbove, setPanelAbove] = useState(false);
  const [query, setQuery] = useState("");
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const activeKeyRef = useRef<string | null>(null);

  const clearHide = () => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };
  const clearClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  // Show the "+" for the empty top-level block under the cursor.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (panelOpen) return; // freeze while the panel is open
      const target = e.target as Node;
      if (anchorRef.current && anchorRef.current.contains(target)) {
        clearHide();
        return;
      }
      const key = getTopLevelKey(editor, target);
      if (!key || !isEmptyAtKey(editor, key)) {
        if (hideTimerRef.current === null) {
          hideTimerRef.current = window.setTimeout(() => setHandle(null), HIDE_DELAY_MS);
        }
        return;
      }
      clearHide();
      const el = editor.getElementByKey(key);
      if (el) {
        const rect = el.getBoundingClientRect();
        // Anchor the "+" to the document column's LEFT EDGE (the editor root), not the
        // block's own box, so it sits in the clear left gutter (between the sidebar and
        // the content column) instead of overlapping the content. Clamp so it never goes
        // off the viewport or under the column.
        const rootEl = editor.getRootElement();
        const colLeft = rootEl ? rootEl.getBoundingClientRect().left : rect.left;
        const gutterLeft = Math.max(4, Math.min(colLeft - HANDLE_OFFSET, rect.left - HANDLE_OFFSET));
        setHandle({ top: rect.top, left: gutterLeft, key });
      }
    };
    document.addEventListener("mousemove", onMove, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      clearHide();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, panelOpen]);

  // Auto-open the panel when the cursor enters the "+" handle; close it after the
  // cursor leaves the whole anchor (handle + panel), with a short linger.
  const openPanel = (h: { top: number; left: number; key: string }) => {
    clearClose();
    activeKeyRef.current = h.key;
    setQuery("");
    // Feishu anchors the panel near the "+"; flip above if there isn't room below.
    setPanelAbove(window.innerHeight - h.top < 420);
    setPanelOpen(true);
  };

  const scheduleClose = () => {
    clearClose();
    closeTimerRef.current = window.setTimeout(() => {
      setPanelOpen(false);
      setHandle(null);
      setQuery("");
    }, CLOSE_DELAY);
  };

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
    const bySection = new Map<string, SlashOption[]>();
    for (const o of filtered) {
      const sec = SECTION_OF[o.key] ?? "常用";
      const list = bySection.get(sec) ?? [];
      list.push(o);
      bySection.set(sec, list);
    }
    const order = q ? Array.from(bySection.keys()) : SECTION_ORDER.filter((s) => bySection.has(s));
    return order.map((s) => ({ section: s, items: bySection.get(s)! }));
  }, [options, query]);

  const select = (option: SlashOption) => {
    setPanelOpen(false);
    setHandle(null);
    runAtBlock(editor, option, activeKeyRef.current);
    activeKeyRef.current = null;
  };

  const aiHelp = () => {
    const key = activeKeyRef.current;
    setPanelOpen(false);
    setHandle(null);
    activeKeyRef.current = null;
    openAiDraft(editor, key);
  };

  // Close on Escape / click outside.
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPanelOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen]);

  // Cleanup timers on unmount.
  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  return (
    <>
      {handle && (
        <div
          ref={anchorRef}
          className="block-insert-anchor"
          style={{ top: handle.top, left: handle.left }}
          onMouseEnter={() => openPanel(handle)}
          onMouseLeave={scheduleClose}
        >
          <div className="block-insert-plus">＋</div>

          {panelOpen && (
            <div className="block-insert-popover" data-above={panelAbove ? "1" : "0"}>
              <button className="insert-ai-entry" onClick={aiHelp}>
                <span className="insert-ai-icon">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
                  </svg>
                </span>
                <span className="insert-ai-name">AI 帮我写</span>
              </button>

              <input
                className="insert-block-search"
                placeholder="搜索插入内容…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />

              <div className="insert-block-scroll">
                {grouped.length === 0 ? (
                  <div className="insert-block-empty">无匹配块</div>
                ) : (
                  grouped.map(({ section, items }) => (
                    <div key={section} className="insert-group">
                      <div className="insert-group-title">{section}</div>
                      {/* 基础 blocks lay out like Feishu's horizontal icon tiles
                          (2-col grid); other sections keep vertical rows. */}
                      {section === "基础" ? (
                        <div className="insert-basic-grid">
                          {items.map((o) => (
                            <button key={o.key} className="insert-basic-item" onClick={() => select(o)} title={o.title}>
                              <span className="insert-basic-icon">{o.badge}</span>
                              <span className="insert-basic-name">{o.title}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        items.map((o) => (
                          <button key={o.key} className="insert-item" onClick={() => select(o)}>
                            <span className="insert-icon">{o.badge}</span>
                            <span className="insert-name">{o.title}</span>
                            {o.shortcut && <span className="insert-shortcut">{o.shortcut}</span>}
                          </button>
                        ))
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
