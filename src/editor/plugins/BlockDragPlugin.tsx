import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNearestNodeFromDOMNode, $getRoot } from "lexical";

// Notion-style block drag handle: a "⋮⋮" grip appears to the left of the
// top-level block under the cursor; dragging it reorders blocks.
//
// Implementation notes:
// 1. We avoid HTML5 drag-and-drop (WebView2 / contenteditable interferes) and
//    do a manual mousedown → mousemove → mouseup drag.
// 2. The handle sits in the left gutter OUTSIDE the contenteditable, so hover
//    detection runs on `document` (not the editor root) and the handle's hit
//    area reaches the content edge with no gap.
// 3. Target detection during drag walks the top-level blocks directly via
//    `$getRoot().getChildren()` + `getElementByKey()` and compares
//    `getBoundingClientRect()` — it does NOT rely on `$getNearestNodeFromDOMNode`
//    / `elementFromPoint`, which can fail while the editor is mid-reconcile
//    after `setEditable(false)`.

function getTopLevelKey(
  editor: ReturnType<typeof useLexicalComposerContext>[0],
  dom: Node | null
): string | null {
  let el = dom instanceof HTMLElement ? dom : dom?.parentElement ?? null;
  if (!el) return null;
  let key: string | null = null;
  editor.read(() => {
    const node = $getNearestNodeFromDOMNode(el);
    const top = node?.getTopLevelElement();
    key = top ? top.getKey() : null;
  });
  return key;
}

type BlockRef = { key: string; el: HTMLElement; rect: DOMRect };
type DropLine = { top: number; left: number; width: number };
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
  const [handle, setHandle] = useState<{ top: number; left: number; key: string } | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [ghostTop, setGhostTop] = useState(0);
  const [dropLine, setDropLine] = useState<DropLine | null>(null);
  const draggingRef = useRef(false);
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

  const startDrag = (e: ReactMouseEvent) => {
    if (!handle) return;
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    ghostLeftRef.current = handle.left;
    editor.setEditable(false);
    setDragKey(handle.key);
    setGhostTop(e.clientY);
    setHandle(null);
  };

  return (
    <>
      {handle && !dragKey && (
        <div
          ref={handleRef}
          className="block-handle"
          style={{ top: handle.top, left: handle.left }}
          onMouseDown={startDrag}
          title="拖拽排序"
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
    </>
  );
}
