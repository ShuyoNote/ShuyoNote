import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, COMMAND_PRIORITY_EDITOR, KEY_DOWN_COMMAND, $isRangeSelection } from "lexical";
import { useEditorStore } from "../../store/editor";

// "按 '空格' 打开 AI": pressing Space on an EMPTY block opens the inline AI draft
// bar instead of inserting a meaningless space.
//
// Guarded strictly to a TRULY blank top-level block (no text at the caret), so
// normal typing and IME composition are never hijacked: if the line has any text
// (including a half-typed pinyin candidate), we return false and never interfere.
// We deliberately do NOT check `e.isComposing` — with an active Chinese IME a Space
// press can be flagged as composing even on an empty line, which would block the
// trigger; the blank-line check alone is the real safety.
export function AiSpaceTriggerPlugin() {
  const [editor] = useLexicalComposerContext();
  const setAiBarOpen = useEditorStore((s) => s.setAiBarOpen);

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (e: KeyboardEvent) => {
        if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
        let onBlankLine = false;
        editor.getEditorState().read(() => {
          const sel = $getSelection();
          if ($isRangeSelection(sel) && sel.isCollapsed()) {
            const top = sel.anchor.getNode().getTopLevelElement();
            if (top && top.getTextContent().trim().length === 0) onBlankLine = true;
          }
        });
        if (!onBlankLine) return false;
        e.preventDefault();
        setAiBarOpen(true);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [editor, setAiBarOpen]);

  return null;
}
