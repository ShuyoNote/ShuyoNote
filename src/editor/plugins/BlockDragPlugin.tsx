import { useEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNearestNodeFromDOMNode, $getRoot } from "lexical";

// Notion-style block drag handle: a "⋮⋮" grip appears to the left of the
// top-level block under the cursor; dragging it reorders blocks.

function getTopLevelKey(editor: ReturnType<typeof useLexicalComposerContext>[0], dom: Node | null): string | null {
  let el = dom instanceof HTMLElement ? dom : dom?.parentElement ?? null;
  if (!el) return null;
  let key: string | null = null;
  editor.getEditorState().read(() => {
    const node = $getNearestNodeFromDOMNode(el);
    const top = node?.getTopLevelElement();
    key = top ? top.getKey() : null;
  });
  return key;
}

export function BlockDragPlugin() {
  const [editor] = useLexicalComposerContext();
  const [handle, setHandle] = useState<{ top: number; left: number } | null>(null);
  const dragKeyRef = useRef<string | null>(null);
  const hoverKeyRef = useRef<string | null>(null);

  // Show the handle for the top-level block under the cursor.
  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return;

    const onMove = (e: MouseEvent) => {
      const target = e.target as Node;
      const key = getTopLevelKey(editor, target);
      if (!key) {
        setHandle(null);
        return;
      }
      const el = editor.getElementByKey(key);
      if (el) {
        const rect = el.getBoundingClientRect();
        setHandle({ top: rect.top, left: rect.left - 28 });
        hoverKeyRef.current = key;
      }
    };

    const onLeave = () => setHandle(null);

    root.addEventListener("mousemove", onMove);
    root.addEventListener("mouseleave", onLeave);
    return () => {
      root.removeEventListener("mousemove", onMove);
      root.removeEventListener("mouseleave", onLeave);
    };
  }, [editor]);

  // Handle drop anywhere within the editor content.
  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return;

    const onDragOver = (e: DragEvent) => {
      if (!dragKeyRef.current) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    };

    const onDrop = (e: DragEvent) => {
      const srcKey = dragKeyRef.current;
      dragKeyRef.current = null;
      if (!srcKey) return;
      e.preventDefault();

      const targetKey = getTopLevelKey(editor, e.target as Node);
      if (!targetKey || targetKey === srcKey) return;

      const targetEl = editor.getElementByKey(targetKey);
      const after = targetEl
        ? e.clientY > targetEl.getBoundingClientRect().top + targetEl.getBoundingClientRect().height / 2
        : false;

      editor.update(() => {
        const children = $getRoot().getChildren();
        const src = children.find((c) => c.getKey() === srcKey);
        const target = children.find((c) => c.getKey() === targetKey);
        if (!src || !target) return;
        src.remove();
        if (after) {
          target.insertAfter(src);
        } else {
          target.insertBefore(src);
        }
      });
    };

    root.addEventListener("dragover", onDragOver);
    root.addEventListener("drop", onDrop);
    return () => {
      root.removeEventListener("dragover", onDragOver);
      root.removeEventListener("drop", onDrop);
    };
  }, [editor]);

  if (!handle) return null;

  return (
    <div
      className="block-handle"
      style={{ top: handle.top, left: handle.left }}
      draggable
      onDragStart={(e) => {
        dragKeyRef.current = hoverKeyRef.current;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", hoverKeyRef.current ?? "");
      }}
      onDragEnd={() => {
        dragKeyRef.current = null;
      }}
      title="拖拽排序"
    >
      ⋮⋮
    </div>
  );
}
