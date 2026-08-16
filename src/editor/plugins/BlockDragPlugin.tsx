import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $cloneWithProperties, $getNearestNodeFromDOMNode, $getNodeByKey, $getRoot } from "lexical";
import { $findTableNode } from "@lexical/table";

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
const HANDLE_OFFSET = 30; // handle spans [contentLeft - 30, contentLeft]

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
  const [handle, setHandle] = useState<HandleState | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<HandleState | null>(null);
  const [ghostTop, setGhostTop] = useState(0);
  const [dropLine, setDropLine] = useState<DropLine | null>(null);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const ghostLeftRef = useRef(0);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
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
      const target = e.target as Node;

      if (handleRef.current && handleRef.current.contains(target)) {
        clearHide();
        return;
      }

      const key = getTopLevelKey(editor, target);
      if (!key) {
        if (hideTimerRef.current === null) {
          hideTimerRef.current = window.setTimeout(() => setHandle(null), 120);
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
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
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
        // A click (no movement): open the block menu.
        setMenu({ top: h.top, left: h.left, key: h.key });
        setHandle(null);
      }
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  };

  const deleteBlock = (key: string) => {
    editor.update(() => {
      const node = $getNodeByKey(key);
      if (node) node.remove();
    });
    setMenu(null);
  };

  const duplicateBlock = (key: string) => {
    editor.update(() => {
      const node = $getNodeByKey(key);
      if (!node) return;
      const clone = $cloneWithProperties(node);
      node.insertAfter(clone);
      clone.selectStart();
    });
    setMenu(null);
  };

  return (
    <>
      {handle && !dragKey && (
        <div
          ref={handleRef}
          className="block-handle"
          style={{ top: handle.top, left: handle.left }}
          onMouseDown={onHandleMouseDown}
          title="点击菜单 · 按住拖动排序"
        >
          ⋮⋮
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

      {menu && (
        <div
          ref={menuRef}
          className="block-menu"
          style={{ top: menu.top, left: menu.left + 24 }}
        >
          <button onClick={() => duplicateBlock(menu.key)}>⧉ 复制块</button>
          <button className="danger" onClick={() => deleteBlock(menu.key)}>
            🗑 删除块
          </button>
          <div className="block-menu-hint">按住 ⋮⋮ 拖动可排序</div>
        </div>
      )}
    </>
  );
}
