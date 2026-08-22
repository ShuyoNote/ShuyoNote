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

// Multi-select of top-level blocks: box-select / handle selects and highlights,
// and a right-click context menu (copy/delete/cancel) pops on the selected blocks.
export function BlockSelectionPlugin() {
  const [editor] = useLexicalComposerContext();
  const keys = useBlockSelection((s) => s.keys);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    syncHighlight(editor, keys);
  }, [keys, editor]);

  // Re-apply highlights after any update (typing, reorder).
  useEffect(() => {
    return editor.registerUpdateListener(() =>
      syncHighlight(editor, useBlockSelection.getState().keys),
    );
  }, [editor]);

  // Clear selection on any mousedown that isn't a handle/button or a right-click
  // (right-click opens the context menu, so the selection must persist).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.button === 2) return;
      const t = e.target as HTMLElement;
      if (t.closest(".block-handle, .block-context-menu")) return;
      useBlockSelection.getState().clear();
      setMenu(null);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, []);

  // Right-click a selected block → show the context menu at the cursor.
  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      const s = useBlockSelection.getState();
      if (s.keys.length === 0) return;
      // Only when the right-click is inside the editor while blocks are selected.
      // (Kept broad — not tied to the .block-selected highlight class — so the
      // menu reliably appears even if highlight timing/class application lags.)
      const target = e.target as HTMLElement;
      if (!target.closest(".editor-content, .editor-shell")) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY });
    };
    document.addEventListener("contextmenu", onContext, true);
    return () => document.removeEventListener("contextmenu", onContext, true);
  }, []);

  // Delete/Backspace remove selected blocks; Escape clears.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useBlockSelection.getState();
      if (s.keys.length === 0) return;
      if (e.key === "Escape") {
        s.clear();
        setMenu(null);
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
        setMenu(null);
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
    setMenu(null);
  };

  if (!menu) return null;
  return (
    <div
      className="block-context-menu"
      style={{ position: "fixed", top: menu.y + 4, left: menu.x, zIndex: 50 }}
    >
      <div className="block-context-count">已选 {keys.length} 块</div>
      <button onClick={() => { copy(); setMenu(null); }}>⧉ 复制</button>
      <button className="danger" onClick={() => { del(); setMenu(null); }}>
        🗑 删除
      </button>
    </div>
  );
}
