import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getRoot,
} from "lexical";
import { useBlockSelection } from "../../store/blockSelection";
import { toast } from "../../store/toast";
import { $deepCloneBlock } from "../blockUtils";

function syncHighlight(editor: ReturnType<typeof useLexicalComposerContext>[0], keys: string[]) {
  const set = new Set(keys);
  editor.getEditorState().read(() => {
    for (const child of $getRoot().getChildren()) {
      const el = editor.getElementByKey(child.getKey());
      if (el) el.classList.toggle("block-selected", set.has(child.getKey()));
    }
  });
}

function topLevelKeyFromTarget(
  editor: ReturnType<typeof useLexicalComposerContext>[0],
  target: EventTarget | null,
): string | null {
  if (!(target instanceof Node)) return null;
  const el = target instanceof HTMLElement ? target : target.parentElement;
  if (!el) return null;
  let key: string | null = null;
  editor.getEditorState().read(() => {
    const node = $getNearestNodeFromDOMNode(el);
    if (!node) return;
    const top = node.getTopLevelElement();
    key = top ? top.getKey() : null;
  });
  return key;
}

// Block multi-selection (A grip + B select-mode + C box-select).
//
// Text selection is always a priority: block-select gestures live either on an
// isolated grip (A) or behind an explicit "多选模式" switch (B) or a blank-area
// box-select (C). In normal mode, a mousedown on text/blank just clears the
// block selection and lets the browser do text selection.
export function BlockSelectionPlugin() {
  const [editor] = useLexicalComposerContext();
  const keys = useBlockSelection((s) => s.keys);
  const selectMode = useBlockSelection((s) => s.selectMode);

  useEffect(() => {
    syncHighlight(editor, keys);
  }, [keys, editor]);

  // Re-apply highlights after any update (typing, reorder).
  useEffect(() => {
    return editor.registerUpdateListener(() =>
      syncHighlight(editor, useBlockSelection.getState().keys),
    );
  }, [editor]);

  // mousedown: in select-mode, clicking a block toggles it / clicking blank clears;
  // otherwise, pressing anywhere (except a block handle/bar) drops the block selection
  // so the browser can do normal text selection.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.button === 2) return;
      const t = e.target as HTMLElement;
      if (t.closest(".block-handle, .block-grip-menu, .block-selection-bar, .block-select-mode-btn, .selection-toolbar")) return;
      const s = useBlockSelection.getState();
      if (s.selectMode) {
        const key = topLevelKeyFromTarget(editor, e.target);
        if (key) {
          e.preventDefault();
          if (s.keys.length === 0) s.setAnchor(key);
          s.toggleKey(key);
        } else {
          s.clear();
        }
        return;
      }
      if (t.closest(".block-handle")) return;
      s.clear();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [editor]);

  // Escape clears (and exits select-mode); Delete/Backspace remove selected blocks.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useBlockSelection.getState();
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        s.setSelectMode(!s.selectMode);
        return;
      }
      if (e.key === "Escape") {
        if (s.selectMode) s.setSelectMode(false);
        s.clear();
        return;
      }
      if (s.keys.length === 0) return;
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

  const toggleMode = () => useBlockSelection.getState().setSelectMode(!selectMode);

  const copy = () => {
    editor.update(() => {
      let last = null as ReturnType<typeof $deepCloneBlock> | null;
      for (const k of keys) {
        const node = $getNodeByKey(k);
        if (!node) continue;
        const clone = $deepCloneBlock(node);
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

  const clear = () => {
    useBlockSelection.getState().clear();
  };

  if (keys.length === 0 && !selectMode) return null;

  return (
    <div
      className={`block-selection-bar${selectMode ? " is-select-mode" : ""}`}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <span className="block-selection-count">
        {selectMode ? "多选模式" : `已选 ${keys.length} 块`}
      </span>
      {selectMode && keys.length > 0 && <span className="block-selection-count">已选 {keys.length} 块</span>}
      <button className="block-select-mode-btn" onClick={toggleMode} title="多选模式下点击块即可加入/移出选择（Mod+Shift+M）">
        {selectMode ? "退出多选" : "多选模式"}
      </button>
      {keys.length > 0 && (
        <>
          <button onClick={copy}>⧉ 复制</button>
          <button className="danger" onClick={del}>🗑 删除</button>
          <button className="block-selection-close" onClick={clear}>✕ 清空</button>
        </>
      )}
      {selectMode && <span className="block-select-hint">点块加入/移出 · Esc 退出</span>}
    </div>
  );
}
