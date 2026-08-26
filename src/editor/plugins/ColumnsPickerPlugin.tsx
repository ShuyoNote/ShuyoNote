import { useEffect, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection } from "lexical";
import { $isColumnsNode, $setColumnsCount } from "../nodes/ColumnsNode";

// Feishu-style column-count picker. When the caret is inside a ColumnsNode that has
// NOT yet been given a count (`__count === 0`), show a floating "选择栏数" panel with
// 2/3/4-column thumbnails anchored to the block. Picking one materializes the columns.
//
// Uses the same anchor-a-React-overlay-to-a-Lexical-block pattern as TableMenuPlugin
// (an editor update listener that reads the active block's DOM rect).

type Picker = { key: string; top: number; left: number };

export function ColumnsPickerPlugin() {
  const [editor] = useLexicalComposerContext();
  const [picker, setPicker] = useState<Picker | null>(null);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) {
          setPicker(null);
          return;
        }
        const anchor = sel.anchor.getNode();
        const top = anchor.getTopLevelElement();
        // Show the picker only for a columns block that hasn't been given a real
        // count yet. Materializing columns adds child ColumnNodes; the placeholder
        // state has exactly one (the seeded placeholder column). Use that as the
        // signal rather than __count, which may not be committed reliably.
        if (!$isColumnsNode(top) || top.getChildren().length > 1) {
          setPicker(null);
          return;
        }
        const dom = editor.getElementByKey(top.getKey());
        if (!dom) {
          setPicker(null);
          return;
        }
        const rect = dom.getBoundingClientRect();
        setPicker({ key: top.getKey(), top: rect.top, left: rect.left });
      });
    });
  }, [editor]);

  // Close the picker when clicking outside the editor or on Escape.
  useEffect(() => {
    if (!picker) return;
    const onDown = (e: MouseEvent) => {
      const editorRoot = document.querySelector(".editor-shell");
      const t = e.target as Node;
      if (editorRoot && !editorRoot.contains(t)) setPicker(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicker(null);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [picker]);

  if (!picker) return null;

  const choose = (count: number) => {
    setPicker(null);
    // The picker only shows while the caret is inside the columns block, so resolve
    // it from the current selection and walk up to the ColumnsNode.
    editor.update(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel)) return;
      let cur: unknown = sel.anchor.getNode();
      while (cur) {
        if ($isColumnsNode(cur as any)) {
          $setColumnsCount(cur as any, count);
          return;
        }
        cur = (cur as any).getParent?.();
      }
    });
  };

  const thumb = (cols: number) => {
    // Render a row of `cols` vertical bars so 2/3/4 reads like Feishu's picker.
    const bars = Array.from({ length: cols }, (_, i) => (
      <span key={i} className="columns-pick-bar" />
    ));
    return <span className="columns-pick-thumb">{bars}</span>;
  };

  return (
    <div className="columns-picker" style={{ top: picker.top, left: picker.left }}>
      <div className="columns-picker-label">选择栏数</div>
      <div className="columns-picker-row">
        {[2, 3, 4].map((n) => (
          <button key={n} className="columns-pick" onMouseDown={(e) => e.preventDefault()} onClick={() => choose(n)} title={`${n} 栏`}>
            {thumb(n)}
          </button>
        ))}
      </div>
    </div>
  );
}
