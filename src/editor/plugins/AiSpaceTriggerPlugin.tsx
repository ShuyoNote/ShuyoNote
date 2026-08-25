import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection } from "lexical";
import { useEditorStore } from "../../store/editor";

// "按 '空格' 打开 AI": pressing Space on an EMPTY block opens the inline AI draft
// bar, anchored to the caret. We listen on `document` in the CAPTURE phase so our
// handler runs before the event reaches the editor — reliably canceling the space.
//
// IMPORTANT: `editor.getRootElement()` is resolved FRESH at keydown time, never at
// mount (at plugin mount the root can still be null, which previously made the
// listener never get added and the trigger dead entirely).
//
// Guarded strictly to a TRULY blank top-level block (no text at the caret), so
// normal typing and IME composition are never hijacked: if the line has any text
// (including a half-typed pinyin candidate) we return and never interfere.
export function AiSpaceTriggerPlugin() {
  const [editor] = useLexicalComposerContext();
  const setAiBarOpen = useEditorStore((s) => s.setAiBarOpen);
  const setAiBarPos = useEditorStore((s) => s.setAiBarPos);
  const setAiBarAnchorKey = useEditorStore((s) => s.setAiBarAnchorKey);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      // Only react when the keydown is inside THIS editor's contentEditable.
      const root = editor.getRootElement();
      const t = e.target as Node | null;
      if (!root || !t || !root.contains(t)) return;
      let onBlankLine = false;
      let pos: { top: number; left: number } | null = null;
      editor.getEditorState().read(() => {
        const sel = $getSelection();
        if ($isRangeSelection(sel) && sel.isCollapsed()) {
          const top = sel.anchor.getNode().getTopLevelElement();
          if (top && top.getTextContent().trim().length === 0) {
            onBlankLine = true;
            setAiBarAnchorKey(top.getKey());
            const dom = editor.getElementByKey(top.getKey());
            if (dom) {
              const r = dom.getBoundingClientRect();
              const viewW = window.innerWidth;
              const viewH = window.innerHeight;
              const below = viewH - r.bottom;
              // Flip the popup ABOVE the caret when there isn't enough room below,
              // and clamp it to the viewport so it's never cut off.
              const popTop = below < 340 ? Math.max(8, r.top - 360) : r.bottom + 6;
              const popW = Math.min(780, viewW - 24);
              const left = Math.max(8, Math.min(r.left, viewW - popW - 8));
              pos = { top: popTop, left };
            }
          }
        }
      });
      if (!onBlankLine) return;
      e.preventDefault();
      if (pos) setAiBarPos(pos);
      setAiBarOpen(true);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [editor, setAiBarOpen, setAiBarPos, setAiBarAnchorKey]);

  return null;
}
