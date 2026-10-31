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
import {
  BLOCK_TYPE_OPTIONS,
  $blockTypeOf,
  $convertSelectedBlocksTo,
  type BlockType,
} from "../blockType";

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
  const [blockType, setBlockType] = useState<BlockType>("p");
  const [blockMenuOpen, setBlockMenuOpen] = useState(false);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.isCollapsed()) {
          setPos(null);
          return;
        }
        // 下拉控件要显示"当前是正文还是标题几"：取选区锚点所在块。
        setBlockType($blockTypeOf(selection.anchor.getNode()));
        const domSelection = window.getSelection();
        if (domSelection && domSelection.rangeCount > 0) {
          const rect = domSelection.getRangeAt(0).getBoundingClientRect();
          const tw = 260;
          const left = Math.max(tw / 2 + 8, Math.min(rect.left + rect.width / 2, window.innerWidth - tw / 2 - 8));
          const top = Math.max(56, rect.top);
          setPos({ top, left });
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

  // 工具条消失时把下拉也收掉，避免下次一出现就挂着旧菜单。
  useEffect(() => {
    if (!pos) setBlockMenuOpen(false);
  }, [pos]);

  if (!pos) return null;

  const apply = (format: TextFormatType) => {
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
  };

  const applyBlockType = (value: BlockType) => {
    setBlockMenuOpen(false);
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) $convertSelectedBlocksTo(selection, value);
    });
  };

  const currentLabel = BLOCK_TYPE_OPTIONS.find((o) => o.value === blockType)?.label ?? "正文";

  return (
    <div className="selection-toolbar" style={{ top: pos.top, left: pos.left }}>
      {/* 块类型下拉：正文 / 标题 1–3。点开时**不能**让编辑器失焦（否则选区没了）⇒ 一律 preventDefault。 */}
      <div className="selection-toolbar-blocktype">
        <button
          className="selection-toolbar-blocktype-btn"
          title="段落样式（正文 / 标题）"
          aria-haspopup="menu"
          aria-expanded={blockMenuOpen}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setBlockMenuOpen((v) => !v)}
        >
          {currentLabel}
          <span className="selection-toolbar-caret" aria-hidden="true">▾</span>
        </button>
        {blockMenuOpen && (
          <div className="selection-toolbar-menu" role="menu">
            {BLOCK_TYPE_OPTIONS.map((o) => (
              <button
                key={o.value}
                role="menuitemradio"
                aria-checked={o.value === blockType}
                className={o.value === blockType ? "is-current" : ""}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyBlockType(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="selection-toolbar-sep" aria-hidden="true" />
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
