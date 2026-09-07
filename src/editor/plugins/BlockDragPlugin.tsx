import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNearestNodeFromDOMNode, $getNodeByKey, $getRoot, $getSelection, $isRangeSelection } from "lexical";
import { $findTableNode } from "@lexical/table";
import { useBlockSelection } from "../../store/blockSelection";
import { $deepCloneBlock, isEmptyBlock } from "../blockUtils";
import { TrashIcon } from "../../components/icons";

// Notion-style block drag handle: a "⋮⋮" grip appears to the left of the
// top-level block under the cursor. Clicking it opens a small menu
// (duplicate / delete); holding and dragging reorders the block.
//
// Implementation notes:
// 1. We avoid HTML5 drag-and-drop (WebView2 / contenteditable interferes) and
//    do a manual mousedown → mousemove → mouseup drag.
// 2. The handle sits in the left gutter OUTSIDE the contenteditable, so hover
//    detection runs on `document` (not the editor root) and the handle's hit
//    area reaches the content edge with no gap.
// 3. Target detection during drag walks the top-level blocks directly via
//    `$getRoot().getChildren()` + `getElementByKey()` and compares
//    `getBoundingClientRect()`.
// 4. We distinguish click vs drag by a movement threshold so a simple click
//    never calls `setEditable(false)` (which could otherwise leave the editor
//    non-editable if the drag did not complete).

function getTopLevelKey(
  editor: ReturnType<typeof useLexicalComposerContext>[0],
  dom: Node | null
): string | null {
  let el = dom instanceof HTMLElement ? dom : dom?.parentElement ?? null;
  if (!el) return null;
  let key: string | null = null;
  editor.read(() => {
    const node = $getNearestNodeFromDOMNode(el);
    if (!node) return;
    const table = $findTableNode(node);
    if (table) {
      // Hovering anywhere inside a table targets the table as a whole: show a
      // single handle on the table (not a per-cell handle).
      key = table.getKey();
      return;
    }
    const top = node.getTopLevelElement();
    key = top ? top.getKey() : null;
  });
  return key;
}

type BlockRef = { key: string; el: HTMLElement; rect: DOMRect };
type DropLine = { top: number; left: number; width: number };
type HandleState = { top: number; left: number; key: string };
const HANDLE_OFFSET = 48; // matches the visible handle width (flush against content)
const HIDE_DELAY = 400; // ms — linger long enough to grab the handle

function getTopLevelBlocks(
  editor: ReturnType<typeof useLexicalComposerContext>[0]
): BlockRef[] {
  const result: BlockRef[] = [];
  editor.read(() => {
    for (const child of $getRoot().getChildren()) {
      const el = editor.getElementByKey(child.getKey());
      if (el) result.push({ key: child.getKey(), el, rect: el.getBoundingClientRect() });
    }
  });
  return result;
}

function findTargetBlock(
  blocks: BlockRef[],
  excludeKey: string | null,
  clientY: number
): (BlockRef & { after: boolean }) | null {
  let best: BlockRef | null = null;
  let bestDist = Infinity;
  for (const b of blocks) {
    if (b.key === excludeKey) continue;
    const center = b.rect.top + b.rect.height / 2;
    const dist = Math.abs(clientY - center);
    if (dist < bestDist) {
      bestDist = dist;
      best = b;
    }
  }
  if (!best) return null;
  const after = clientY > best.rect.top + best.rect.height / 2;
  return { ...best, after };
}

export function BlockDragPlugin() {
  const [editor] = useLexicalComposerContext();
  const selectMode = useBlockSelection((s) => s.selectMode);
  const [handle, setHandle] = useState<HandleState | null>(null);
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [ghostTop, setGhostTop] = useState(0);
  const [dropLine, setDropLine] = useState<DropLine | null>(null);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const ghostLeftRef = useRef(0);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  // Show the handle for the top-level block under the cursor.
  useEffect(() => {
    const clearHide = () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };

    const onMove = (e: MouseEvent) => {
      if (draggingRef.current) return;
      if (useBlockSelection.getState().selectMode) {
        // In 多选模式, block selection is driven by clicks, so no grip.
        setHandle(null);
        return;
      }
      const target = e.target as Node;

      if (handleRef.current && handleRef.current.contains(target)) {
        clearHide();
        return;
      }

      const key = getTopLevelKey(editor, target);
      if (!key) {
        if (hideTimerRef.current === null) {
          hideTimerRef.current = window.setTimeout(() => setHandle(null), HIDE_DELAY);
        }
        return;
      }

      // The inline "+" insert affordance owns the gutter of empty blocks; don't
      // also show the ⋮⋮ drag grip there (Feishu-style).
      const isEmpty = editor.getEditorState().read(() => isEmptyBlock($getNodeByKey(key)));
      if (isEmpty) {
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
      }    };

    document.addEventListener("mousemove", onMove, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      clearHide();
    };
  }, [editor]);

  // 文字选中优先：一旦编辑器存在非折叠的 RangeSelection（用户正在拖选/已选中
  // 一段文字），立即隐藏块手柄，避免它在沟槽里出现造成干扰或误把后续按下当块选。
  useEffect(() => {
    const hide = () => {
      setHandle(null);
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
    return editor.registerUpdateListener(() => {
      let active = false;
      editor.getEditorState().read(() => {
        const sel = $getSelection();
        if ($isRangeSelection(sel)) active = !sel.isCollapsed();
      });
      if (active) hide();
    });
  }, [editor]);

  // Manual drag.
  useEffect(() => {
    if (!dragKey) return;
    document.body.classList.add("is-dragging-block");

    const onMove = (e: MouseEvent) => {
      e.preventDefault();
      setGhostTop(e.clientY);

      const blocks = getTopLevelBlocks(editor);
      const target = findTargetBlock(blocks, dragKey, e.clientY);
      if (!target) {
        setDropLine(null);
        return;
      }
      setDropLine({
        top: target.after ? target.rect.bottom : target.rect.top,
        left: target.rect.left,
        width: target.rect.width,
      });
    };

    const onUp = (e: MouseEvent) => {
      const srcKey = dragKey;
      const blocks = getTopLevelBlocks(editor);
      const target = findTargetBlock(blocks, srcKey, e.clientY);

      if (target) {
        const after = target.after;
        editor.update(() => {
          const children = $getRoot().getChildren();
          const src = children.find((c) => c.getKey() === srcKey);
          const dst = children.find((c) => c.getKey() === target.key);
          if (!src || !dst) return;
          src.remove();
          if (after) {
            dst.insertAfter(src);
          } else {
            dst.insertBefore(src);
          }
        });
      }

      draggingRef.current = false;
      setDragKey(null);
      setDropLine(null);
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      document.body.classList.remove("is-dragging-block");
      editor.setEditable(true);
      draggingRef.current = false;
    };
  }, [dragKey, editor]);

  // Close the block menu when clicking elsewhere.
  // Close the block grip menu when clicking elsewhere.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".block-grip-menu") || t.closest(".block-handle")) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  const beginDrag = (h: HandleState, clientY: number) => {
    draggingRef.current = true;
    ghostLeftRef.current = h.left;
    editor.setEditable(false);
    setDragKey(h.key);
    setGhostTop(clientY);
    setHandle(null);
    setMenu(null);
  };

  const onHandleMouseDown = (e: ReactMouseEvent) => {
    if (!handle) return;
    e.preventDefault();
    e.stopPropagation();
    const h = handle;
    downRef.current = { x: e.clientX, y: e.clientY };
    movedRef.current = false;

    const onMove = (ev: MouseEvent) => {
      if (movedRef.current) return;
      const dx = ev.clientX - downRef.current!.x;
      const dy = ev.clientY - downRef.current!.y;
      if (dx * dx + dy * dy > 25) {
        movedRef.current = true;
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
        beginDrag(h, ev.clientY);
      }
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      if (!movedRef.current) {
        // A click (no movement): select the block. Shift+click selects the
        // contiguous range from the anchor to this block.
        const sel = useBlockSelection.getState();
        if (e.shiftKey && sel.anchor) {
          const all: string[] = [];
          editor.getEditorState().read(() => {
            for (const c of $getRoot().getChildren()) all.push(c.getKey());
          });
          const a = all.indexOf(sel.anchor);
          const b = all.indexOf(h.key);
          if (a !== -1 && b !== -1) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            sel.setKeys(all.slice(lo, hi + 1));
          }
        } else {
          sel.setAnchor(h.key);
          sel.setKeys([h.key]);
          // Single click on the grip → open the block's action menu near the grip.
          const mx = Math.max(8, Math.min(h.left + HANDLE_OFFSET - 6, window.innerWidth - 150));
          const my = Math.max(8, h.top + 30);
          setMenu({ key: h.key, x: mx, y: my });
        }
        setHandle(null);
      }
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  };

  const copyMenu = () => {
    const s = useBlockSelection.getState();
    editor.update(() => {
      let last = null as ReturnType<typeof $deepCloneBlock> | null;
      for (const k of s.keys) {
        const node = $getNodeByKey(k);
        if (!node) continue;
        const clone = $deepCloneBlock(node);
        if (last) last.insertAfter(clone);
        else node.insertAfter(clone);
        last = clone;
      }
    });
    setMenu(null);
  };

  const delMenu = () => {
    const s = useBlockSelection.getState();
    editor.update(() => {
      for (const k of s.keys) {
        const n = $getNodeByKey(k);
        if (n) n.remove();
      }
    });
    useBlockSelection.getState().clear();
    setMenu(null);
  };

  const clearMenu = () => {
    useBlockSelection.getState().clear();
    setMenu(null);
  };

  return (
    <>
      {handle && !dragKey && !selectMode && (
        <div
          ref={handleRef}
          className="block-handle"
          style={{ top: handle.top, left: handle.left }}
          onMouseDown={onHandleMouseDown}
          title="点击打开菜单 · Shift+点击多选 · 按住拖动排序"
        >
          ⋮⋮
        </div>
      )}

      {menu && (
        <div
          className="block-grip-menu"
          style={{ position: "fixed", top: menu.y, left: menu.x }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div className="block-grip-menu-head">
            <span className="block-grip-menu-title">块操作</span>
          </div>
          <button className="block-grip-item" onClick={copyMenu}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="12" height="12" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            <span>复制</span>
          </button>
          <button className="block-grip-item danger" onClick={delMenu}>
            <TrashIcon width={16} height={16} />
            <span>删除</span>
          </button>
          <div className="block-grip-menu-sep" />
          <button className="block-grip-item" onClick={clearMenu}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
            <span>清空选择</span>
          </button>
        </div>
      )}

      {dragKey && (
        <div
          className="block-handle block-handle--dragging"
          style={{ top: ghostTop - 12, left: ghostLeftRef.current }}
        >
          ⋮⋮
        </div>
      )}

      {dropLine && (
        <div
          className="block-drop-line"
          style={{ top: dropLine.top, left: dropLine.left, width: dropLine.width }}
        />
      )}
    </>
  );
}
