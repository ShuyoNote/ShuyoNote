import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, COMMAND_PRIORITY_EDITOR, KEY_DOWN_COMMAND, $isRangeSelection } from "lexical";
import { useEditorStore } from "../../store/editor";

// "按 '空格' 打开 AI": pressing Space on an EMPTY block opens the inline AI draft
// bar instead of inserting a meaningless space. Guarded to only fire on a truly
// blank top-level block (no text), so normal typing — and IME composition (Chinese
// pinyin uses Space to accept a candidate) — are never broken.
export function AiSpaceTriggerPlugin() {
  const [editor] = useLexicalComposerContext();
  const setAiBarOpen = useEditorStore((s) => s.setAiBarOpen);

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (e: KeyboardEvent) => {
        if (e.code !== "Space" || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
        let onBlankLine = false;
        editor.getEditorState().read(() => {
          const sel = $getSelection();
          if ($isRangeSelection(sel)) {
            const top = sel.anchor.getNode().getTopLevelElement();
            if (top && top.getTextContent().length === 0) onBlankLine = true;
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
