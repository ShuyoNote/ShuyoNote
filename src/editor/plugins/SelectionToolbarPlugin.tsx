import { useEffect, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection, FORMAT_TEXT_COMMAND, type TextFormatType } from "lexical";
import {
  BoldIcon,
  CodeIcon,
  ItalicIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from "../../components/icons";

// Floating inline-formatting toolbar shown above the selected text.
const FORMATS: { key: TextFormatType; title: string; Icon: typeof BoldIcon }[] = [
  { key: "bold", title: "加粗", Icon: BoldIcon },
  { key: "italic", title: "斜体", Icon: ItalicIcon },
  { key: "underline", title: "下划线", Icon: UnderlineIcon },
  { key: "strikethrough", title: "删除线", Icon: StrikethroughIcon },
  { key: "code", title: "行内代码", Icon: CodeIcon },
];

export function SelectionToolbarPlugin() {
  const [editor] = useLexicalComposerContext();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.isCollapsed()) {
          setPos(null);
          return;
        }
        const domSelection = window.getSelection();
        if (domSelection && domSelection.rangeCount > 0) {
          const rect = domSelection.getRangeAt(0).getBoundingClientRect();
          setPos({ top: rect.top, left: rect.left + rect.width / 2 });
        } else {
          setPos(null);
        }
      });
    });
  }, [editor]);

  // Close selection toolbar when clicking outside it.
  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent) => {
      const el = document.querySelector(".selection-toolbar");
      if (el && !el.contains(e.target as Node)) setPos(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pos]);

  if (!pos) return null;

  const apply = (format: TextFormatType) => {
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
  };

  return (
    <div className="selection-toolbar" style={{ top: pos.top, left: pos.left }}>
      {FORMATS.map(({ key, title, Icon }) => (
        <button
          key={key}
          title={title}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => apply(key)}
        >
          <Icon width={14} height={14} />
        </button>
      ))}
    </div>
  );
}
