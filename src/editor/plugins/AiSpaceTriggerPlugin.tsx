import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection } from "lexical";
import { useEditorStore } from "../../store/editor";

// "按 '空格' 打开 AI": pressing Space on an EMPTY block opens the inline AI draft
// bar. We listen on `document` in the CAPTURE phase so our handler runs before the
// event reaches the editor — reliably canceling the space and opening the bar. (The
// Lexical KEY_DOWN_COMMAND route proved unreliable for a lone Space; a listener on
// the editor's own element runs after Lexical's handler due to registration order.)
//
// Guarded strictly to a TRULY blank top-level block (no text at the caret), so
// normal typing and IME composition are never hijacked: if the line has any text
// (including a half-typed pinyin candidate) we return and never interfere. We
// deliberately do NOT check `e.isComposing` — with an active Chinese IME a Space
// press can be flagged as composing even on an empty line; the blank-line check
// alone is the real safety.
export function AiSpaceTriggerPlugin() {
  const [editor] = useLexicalComposerContext();
  const setAiBarOpen = useEditorStore((s) => s.setAiBarOpen);

  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const t = e.target as Node | null;
      if (!t || !root.contains(t)) return;
      let onBlankLine = false;
      editor.getEditorState().read(() => {
        const sel = $getSelection();
        if ($isRangeSelection(sel) && sel.isCollapsed()) {
          const top = sel.anchor.getNode().getTopLevelElement();
          if (top && top.getTextContent().trim().length === 0) onBlankLine = true;
        }
      });
      // Temporary diag so we can confirm whether the trigger path is reached.
      console.info("[ShuyoNote-debug] space in editor; blank=", onBlankLine);
      if (!onBlankLine) return;
      e.preventDefault();
      setAiBarOpen(true);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [editor, setAiBarOpen]);

  return null;
}
