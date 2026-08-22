import { useEffect, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $cloneWithProperties, $getNodeByKey, $getRoot } from "lexical";
import { useBlockSelection } from "../../store/blockSelection";
import { toast } from "../../store/toast";

function syncHighlight(editor: ReturnType<typeof useLexicalComposerContext>[0], keys: string[]) {
  const set = new Set(keys);
  editor.getEditorState().read(() => {
    for (const child of $getRoot().getChildren()) {
      const el = editor.getElementByKey(child.getKey());
      if (el) el.classList.toggle("block-selected", set.has(child.getKey()));
    }
  });
}

// Multi-select toolbar + highlight + keyboard for selected top-level blocks.
export function BlockSelectionPlugin() {
  const [editor] = useLexicalComposerContext();
  const keys = useBlockSelection((s) => s.keys);
  const [barPos, setBarPos] = useState<{ top: number; left: number }>({ top: 12, left: 12 });

  // Position the action bar near the first selected block.
  useEffect(() => {
    if (keys.length === 0) return;
    const el = editor.getElementByKey(keys[0]);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = 200;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    let top = r.top - 8;
    if (top < 8) top = r.bottom + 8;
    setBarPos({ top, left });
  }, [keys, editor]);

  useEffect(() => {
    syncHighlight(editor, keys);
  }, [keys, editor]);

  // Re-apply highlights after any editor update (e.g. typing, reorder).
  useEffect(() => {
    return editor.registerUpdateListener(() =>
      syncHighlight(editor, useBlockSelection.getState().keys),
    );
  }, [editor]);

  // Clear the selection when clicking inside the editor content (not a handle/button).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".block-handle, .block-selection-bar")) return;
      if (t.closest(".editor-content")) useBlockSelection.getState().clear();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, []);

  // Delete/Backspace remove the selected blocks; Escape clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useBlockSelection.getState();
      if (s.keys.length === 0) return;
      if (e.key === "Escape") {
        s.clear();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        editor.update(() => {
          for (const k of s.keys) {
            const node = $getNodeByKey(k);
            if (node) node.remove();
          }
        });
        s.clear();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [editor]);

  if (keys.length === 0) return null;

  const copy = () => {
    editor.update(() => {
      let last = null as ReturnType<typeof $cloneWithProperties> | null;
      for (const k of keys) {
        const node = $getNodeByKey(k);
        if (!node) continue;
        const clone = $cloneWithProperties(node);
        if (last) last.insertAfter(clone);
        else node.insertAfter(clone);
        last = clone;
      }
    });
    toast(`已复制 ${keys.length} 块`, "success");
  };

  const del = () => {
    editor.update(() => {
      for (const k of keys) {
        const node = $getNodeByKey(k);
        if (node) node.remove();
      }
    });
    useBlockSelection.getState().clear();
  };

  return (
    <div className="block-selection-bar" style={{ top: barPos.top, left: barPos.left }}>
      <span className="block-selection-count">已选 {keys.length} 块</span>
      <button onClick={copy}>⧉ 复制</button>
      <button className="danger" onClick={del}>
        🗑 删除
      </button>
      <button
        className="block-selection-close"
        onClick={() => useBlockSelection.getState().clear()}
        title="取消选择"
      >
        ×
      </button>
    </div>
  );
}
