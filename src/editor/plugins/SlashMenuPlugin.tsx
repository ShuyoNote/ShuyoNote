import { useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createHeadingNode, $createQuoteNode } from "@lexical/rich-text";
import { $createCodeHighlightNode, $createCodeNode } from "@lexical/code";
import {
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
} from "@lexical/list";
import { INSERT_HORIZONTAL_RULE_COMMAND } from "@lexical/react/LexicalHorizontalRuleNode";
import { INSERT_TABLE_COMMAND } from "@lexical/table";
import { api } from "../../lib/api";
import { toast } from "../../store/toast";
import { $createCalloutNode } from "../nodes/CalloutNode";
import { $createImageNode } from "../nodes/ImageNode";
import { $createVideoNode } from "../nodes/VideoNode";
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
} from "lexical";

class SlashOption extends MenuOption {
  title: string;
  badge: string;
  run: (editor: LexicalEditor) => void | Promise<void>;

  constructor(
    key: string,
    title: string,
    badge: string,
    run: (editor: LexicalEditor) => void | Promise<void>,
  ) {
    super(key);
    this.title = title;
    this.badge = badge;
    this.run = run;
  }
}

// Replace the current top-level block with a new element, moving children over.
function $replaceBlock(newNode: ElementNode) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  const anchor = selection.anchor.getNode();
  const topLevel = anchor.getTopLevelElement();
  if (!topLevel) return;
  const children = topLevel.getChildren();
  for (const child of children) {
    newNode.append(child);
  }
  topLevel.replace(newNode);
  newNode.selectStart();
}

// Replace the current top-level block with a decorator (image/video), then
// insert an empty paragraph after it and move the caret there.
function $insertBlockNode(node: LexicalNode) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  const anchor = selection.anchor.getNode();
  const topLevel = anchor.getTopLevelElement();
  if (!topLevel) return;
  topLevel.replace(node);
  const paragraph = $createParagraphNode();
  const parent = node.getParent();
  if (parent) {
    parent.splice(node.getIndexWithinParent() + 1, 0, [paragraph]);
    paragraph.select();
  }
}

function makeOptions(pageId: string): SlashOption[] {
  return [
    new SlashOption("h1", "标题 1", "H1", (editor) =>
      editor.update(() => $replaceBlock($createHeadingNode("h1"))),
    ),
    new SlashOption("h2", "标题 2", "H2", (editor) =>
      editor.update(() => $replaceBlock($createHeadingNode("h2"))),
    ),
    new SlashOption("h3", "标题 3", "H3", (editor) =>
      editor.update(() => $replaceBlock($createHeadingNode("h3"))),
    ),
    new SlashOption("p", "正文", "¶", (editor) =>
      editor.update(() => $replaceBlock($createParagraphNode())),
    ),
    new SlashOption("quote", "引用", "❝", (editor) =>
      editor.update(() => $replaceBlock($createQuoteNode())),
    ),
    new SlashOption("callout", "Callout 提示框", "💡", (editor) =>
      editor.update(() => $replaceBlock($createCalloutNode())),
    ),
    new SlashOption("image", "图片", "🖼", async (editor) => {
      const selected = await open({
        title: "选择图片",
        filters: [
          { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] },
        ],
        multiple: false,
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected as string];
      try {
        const metas = await api.importAttachmentFiles(pageId, paths);
        if (metas.length === 0) return;
        const src = convertFileSrc(metas[0].path);
        editor.update(() => $insertBlockNode($createImageNode(src)));
      } catch (e) {
        toast(`插入图片失败：${e}`, "error");
      }
    }),
    new SlashOption("video", "视频", "🎬", async (editor) => {
      const selected = await open({
        title: "选择视频",
        filters: [{ name: "视频", extensions: ["mp4", "webm", "mov", "m4v"] }],
        multiple: false,
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected as string];
      try {
        const metas = await api.importAttachmentFiles(pageId, paths);
        if (metas.length === 0) return;
        const src = convertFileSrc(metas[0].path);
        editor.update(() => $insertBlockNode($createVideoNode(src)));
      } catch (e) {
        toast(`插入视频失败：${e}`, "error");
      }
    }),
    new SlashOption("code", "代码块", "{}", (editor) =>
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const anchor = selection.anchor.getNode();
        const topLevel = anchor.getTopLevelElement();
        if (!topLevel) return;
        const codeNode = $createCodeNode("javascript");
        codeNode.append($createCodeHighlightNode(topLevel.getTextContent()));
        topLevel.replace(codeNode);
        codeNode.selectStart();
      }),
    ),
    new SlashOption("todo", "待办事项", "☑", (editor) => {
      editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined);
    }),
    new SlashOption("ul", "无序列表", "•", (editor) => {
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
    }),
    new SlashOption("ol", "有序列表", "1.", (editor) => {
      editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
    }),
    new SlashOption("hr", "分隔线", "—", (editor) => {
      editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined);
    }),
    new SlashOption("table", "表格", "▦", (editor) => {
      editor.dispatchCommand(INSERT_TABLE_COMMAND, {
        columns: "3",
        rows: "3",
        includeHeaders: { rows: true, columns: false },
      });
    }),
  ];
}

export function SlashMenuPlugin({ pageId }: { pageId: string }) {
  const [editor] = useLexicalComposerContext();
  const options = makeOptions(pageId);

  const triggerFn = useBasicTypeaheadTriggerMatch("/", { minLength: 0 });

  const onQueryChange = useCallback(() => {}, []);

  const onSelectOption = useCallback(
    (option: MenuOption, _textNode: TextNode | null, closeMenu: () => void) => {
      closeMenu();
      const slashOption = option as SlashOption;
      slashOption.run(editor);
    },
    [editor],
  );

  const menuRenderFn = useCallback(
    (
      anchorElementRef: React.RefObject<HTMLElement | null>,
      { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }: {
        selectedIndex: number | null;
        selectOptionAndCleanUp: (option: SlashOption) => void;
        setHighlightedIndex: (index: number) => void;
      },
    ) => {
      if (anchorElementRef.current === null) return null;
      return (
        <div className="slash-menu">
          {options.map((option, i) => (
            <button
              key={option.key}
              className={`slash-item ${selectedIndex === i ? "slash-item-active" : ""}`}
              onClick={() => selectOptionAndCleanUp(option)}
              onMouseEnter={() => setHighlightedIndex(i)}
            >
              <span className="slash-icon">{option.badge}</span>
              <span className="slash-title">{option.title}</span>
            </button>
          ))}
        </div>
      );
    },
    [options],
  );

  return (
    <LexicalTypeaheadMenuPlugin<SlashOption>
      options={options}
      triggerFn={triggerFn}
      onQueryChange={onQueryChange}
      onSelectOption={onSelectOption}
      menuRenderFn={menuRenderFn}
    />
  );
}
