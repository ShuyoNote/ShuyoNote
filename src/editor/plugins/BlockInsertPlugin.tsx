import { useEffect, useMemo, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNearestNodeFromDOMNode, $getNodeByKey, $getRoot, $createParagraphNode } from "lexical";
import { $findTableNode } from "@lexical/table";
import { useEditorStore } from "../../store/editor";
import { makeOptions, type SlashOption } from "./SlashMenuPlugin";
import { $createColumnsBlockNode, EMPTY_COLUMN_JSON } from "../nodes/ColumnsBlockNode";
import { isEmptyBlock } from "../blockUtils";

// Feishu-style inline "+": when the cursor is over an EMPTY top-level block, show a
// "+" in the left gutter. Hovering / clicking the "+" auto-opens an insert panel that
// matches Feishu's layout: a pinned "AI 帮我写" entry on top, then grouped sections
// (基础 / 常用 / 多维表格) of icon + name rows. Only blocks ShuyoNote actually supports
// are shown (unimplemented Feishu blocks are omitted), reusing makeOptions so the
// insert logic matches the "/" slash menu.

const HANDLE_OFFSET = 48; // same as the ⋮⋮ block drag handle: 48px gutter width
const CLOSE_DELAY = 260; // linger so the cursor can travel onto the panel
const HIDE_DELAY_MS = 400;
const SHOW_DELAY_MS = 220; // dwell on an empty block before the "+" appears (less eager)

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
  clientY?: number,
): string | null {
  let el = dom instanceof HTMLElement ? dom : dom?.parentElement ?? null;
  if (!el) return null;
  let key: string | null = null;
  editor.read(() => {
    const node = $getNearestNodeFromDOMNode(el);
    if (node) {
      const table = $findTableNode(node);
      if (table) {
        key = table.getKey();
        return;
      }
      const top = node.getTopLevelElement();
      if (top) {
        key = top.getKey();
        return;
      }
    }
    // Fallback: the cursor is in an empty zone of the editor (e.g. the empty area
    // below a thin empty paragraph — a column is ~44px tall but its empty <p> only
    // ~4px). Resolve the top-level block whose box is nearest vertically, so the "+"
    // stays put while the cursor is anywhere over that column's empty line instead of
    // flashing and disappearing. Only do this for DOM that belongs to THIS editor
    // (a nested column editor must not steal a sibling column's hover).
    if (typeof clientY !== "number") return;
    const rootEl = editor.getRootElement();
    if (!rootEl || !rootEl.contains(el)) return;
    let best: { key: string; dist: number } | null = null;
    for (const child of $getRoot().getChildren()) {
      const elChild = editor.getElementByKey(child.getKey());
      if (!elChild) continue;
      const r = elChild.getBoundingClientRect();
      const dist = clientY >= r.top && clientY <= r.bottom
        ? 0
        : Math.min(Math.abs(clientY - r.top), Math.abs(clientY - r.bottom));
      if (!best || dist < best.dist) best = { key: child.getKey(), dist };
    }
    if (best) key = best.key;
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

export function BlockInsertPlugin({ pageId, gutterOffset = HANDLE_OFFSET }: { pageId: string; gutterOffset?: number }) {
  const [editor] = useLexicalComposerContext();
  const options = useMemo(() => makeOptions(pageId), [pageId]);
  const [handle, setHandle] = useState<{ top: number; left: number; key: string } | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelAbove, setPanelAbove] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [columnsSubPos, setColumnsSubPos] = useState<{ top: number; left: number } | null>(null);
  const [columnsHover, setColumnsHover] = useState(2); // 1-based count under the cursor
  const [query, setQuery] = useState("");
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const columnsBtnRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const columnsCloseTimerRef = useRef<number | null>(null);
  const activeKeyRef = useRef<string | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const pendingRef = useRef<{ top: number; left: number; key: string } | null>(null);

  const clearHide = () => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };
  const clearShow = () => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    pendingRef.current = null;
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
      const key = getTopLevelKey(editor, target, e.clientY);
      if (!key || !isEmptyAtKey(editor, key)) {
        clearShow();
        if (hideTimerRef.current === null) {
          hideTimerRef.current = window.setTimeout(() => setHandle(null), HIDE_DELAY_MS);
        }
        return;
      }
      clearHide();
      // Show the "+" only after the cursor dwells on the empty block for a moment
      // (SHOW_DELAY_MS), so a quick sweep across the block doesn't flash it eagerly.
      if (showTimerRef.current !== null) return; // already pending
      const el = editor.getElementByKey(key);
      if (el) {
        const rect = el.getBoundingClientRect();
        // Unify the "+" across ALL columns: place it at the content's own left edge
        // (where the first character / caret sits), not in the page gutter. This keeps
        // every column's "+" in the same consistent spot and — because that spot is
        // inside the column, not the inter-column gap — it never overlaps the col-resize
        // divider handle either (the "+" is z-index 25, above the handle's 6).
        const ownCol = el.closest(".editor-column");
        const left = ownCol ? rect.left : Math.max(4, rect.left - gutterOffset);
        pendingRef.current = { top: rect.top, left, key };
        showTimerRef.current = window.setTimeout(() => {
          showTimerRef.current = null;
          if (pendingRef.current) {
            setHandle(pendingRef.current);
            pendingRef.current = null;
          }
        }, SHOW_DELAY_MS);
      }
    };
    document.addEventListener("mousemove", onMove, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      clearHide();
      clearShow();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, panelOpen]);

  // Auto-open the panel when the cursor enters the "+" handle; close it after the
  // cursor leaves the whole anchor (handle + panel), with a short linger.
  const openPanel = (h: { top: number; left: number; key: string }) => {
    clearClose();
    activeKeyRef.current = h.key;
    setQuery("");
    // Feishu anchors the panel near the "+"; flip above if there isn't enough room.
    const above = window.innerHeight - h.top < 440;
    setPanelAbove(above);
    // Open to the LEFT of the "+" button (the anchor spans anchorLeft..anchorLeft+48).
    // Clamp so the panel never overflows the viewport's left edge.
    const MENU_W = 300;
    const MENU_H = 560;
    const anchorRight = h.left + 48;
    const left = Math.max(8, Math.min(anchorRight - MENU_W - 6, window.innerWidth - MENU_W - 8));
    const top = above ? Math.max(8, h.top - MENU_H) : h.top;
    setMenuPos({ top, left });
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

  // Close only the columns submenu after a short linger so the cursor can travel
  // from the 分栏 row to the submenu without it flickering shut.
  const scheduleColumnsClose = () => {
    if (columnsCloseTimerRef.current !== null) window.clearTimeout(columnsCloseTimerRef.current);
    columnsCloseTimerRef.current = window.setTimeout(() => setColumnsOpen(false), CLOSE_DELAY);
  };
  const cancelColumnsClose = () => {
    if (columnsCloseTimerRef.current !== null) {
      window.clearTimeout(columnsCloseTimerRef.current);
      columnsCloseTimerRef.current = null;
    }
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

  // Insert a columns block with a chosen column count directly (no post-insert
  // picker): place the caret in the target block, then replace it with $createColumnsNode(count).
  const insertColumns = (count: number) => {
    const key = activeKeyRef.current;
    setPanelOpen(false);
    setColumnsOpen(false);
    setHandle(null);
    activeKeyRef.current = null;
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
      // Place a collapsed selection inside the target so the replace targets it.
      target.selectEnd();
      // Replace it with the columns block (new Route-B node) with `count` empty columns.
      const topLevel = target.getTopLevelElement();
      if (topLevel) {
        topLevel.replace($createColumnsBlockNode(new Array(count).fill(EMPTY_COLUMN_JSON)));
      }
    });
    editor.focus();
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
      if (columnsCloseTimerRef.current !== null) window.clearTimeout(columnsCloseTimerRef.current);
      if (showTimerRef.current !== null) window.clearTimeout(showTimerRef.current);
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
          <div className="block-insert-plus" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </div>

          {panelOpen && menuPos && (
            <div
              className="block-insert-popover"
              ref={popoverRef}
              data-above={panelAbove ? "1" : "0"}
              style={{ top: menuPos.top, left: menuPos.left }}
            >
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
                        <div className="insert-rows">
                          {items.map((o) =>
                            o.key === "columns" ? (
                              <button
                                key={o.key}
                                ref={(el) => { if (el) columnsBtnRef.current = el; }}
                                className={`insert-item ${columnsOpen ? "active" : ""}`}
                                onMouseEnter={() => {
                                  cancelColumnsClose();
                                  const el = columnsBtnRef.current;
                                  const pop = popoverRef.current;
                                  if (!el || !pop) return;
                                  const rowRect = el.getBoundingClientRect();
                                  const popRect = pop.getBoundingClientRect();
                                  const subW = 150;
                                  // Anchor to the HOST menu's right edge + 2 so the
                                  // submenu opens tight beside it (no overlap, small gap).
                                  const x = Math.min(popRect.right + 2, window.innerWidth - subW - 8);
                                  const y = Math.max(8, Math.min(rowRect.top - 8, window.innerHeight - 120));
                                  setColumnsSubPos({ top: y, left: x });
                                  setColumnsOpen(true);
                                }}
                                onMouseLeave={scheduleColumnsClose}
                                title="选择栏数"
                              >
                                <span className="insert-icon">{o.badge}</span>
                                <span className="insert-name">{o.title}</span>
                                <span className="insert-caret">›</span>
                              </button>
                            ) : (
                              <button key={o.key} className="insert-item" onClick={() => select(o)}>
                                <span className="insert-icon">{o.badge}</span>
                                <span className="insert-name">{o.title}</span>
                                {o.shortcut && <span className="insert-shortcut">{o.shortcut}</span>}
                              </button>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Second-level submenu (分栏 count picker), rendered as a FIXED sibling
              of the popover so popover's overflow:hidden can't clip it. Opens to
              the RIGHT of the 分栏 row. */}
          {columnsOpen && columnsSubPos && (
            <div
              className="insert-columns-sub"
              style={{ top: columnsSubPos.top, left: columnsSubPos.left }}
              onMouseEnter={cancelColumnsClose}
              onMouseLeave={scheduleColumnsClose}
            >
              <div className="insert-columns-label">选择栏数</div>
              <div
                className="insert-columns-track"
                role="radiogroup"
                onMouseLeave={() => setColumnsHover(2)}
              >
                {[1, 2, 3, 4, 5].map((idx) => (
                  <span
                    key={idx}
                    className={`insert-columns-cell ${idx <= columnsHover ? "on" : ""}`}
                    onMouseEnter={() => setColumnsHover(idx)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertColumns(idx)}
                    title={`${idx} 栏`}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
