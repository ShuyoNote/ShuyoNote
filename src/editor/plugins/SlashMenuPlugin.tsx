import { useCallback } from "react";
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
import { $createCalloutNode } from "../nodes/CalloutNode";
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  $createTextNode,
  type ElementNode,
  type LexicalEditor,
  type TextNode,
} from "lexical";

class SlashOption extends MenuOption {
  title: string;
  badge: string;
  run: (editor: LexicalEditor) => void;

  constructor(
    key: string,
    title: string,
    badge: string,
    run: (editor: LexicalEditor) => void,
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

function makeOptions(): SlashOption[] {
  return [
    new SlashOption("h1", "标题 1", "H1", () => $replaceBlock($createHeadingNode("h1"))),
    new SlashOption("h2", "标题 2", "H2", () => $replaceBlock($createHeadingNode("h2"))),
    new SlashOption("h3", "标题 3", "H3", () => $replaceBlock($createHeadingNode("h3"))),
    new SlashOption("p", "正文", "¶", () => $replaceBlock($createParagraphNode())),
    new SlashOption("quote", "引用", "❝", () => $replaceBlock($createQuoteNode())),
    new SlashOption("callout", "Callout 提示框", "💡", () => $replaceBlock($createCalloutNode())),
    new SlashOption("code", "代码块", "{}", (editor) => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const anchor = selection.anchor.getNode();
        const topLevel = anchor.getTopLevelElement();
        if (!topLevel) return;
        const codeNode = $createCodeNode("javascript");
        const text = topLevel.getTextContent();
        if (text) {
          codeNode.append($createCodeHighlightNode(text));
        } else {
          codeNode.append($createTextNode(""));
        }
        topLevel.replace(codeNode);
        codeNode.selectStart();
      });
    }),
    new SlashOption("todo", "待办事项", "☑", (editor) =>
      editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined),
    ),
    new SlashOption("ul", "无序列表", "•", (editor) =>
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined),
    ),
    new SlashOption("ol", "有序列表", "1.", (editor) =>
      editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined),
    ),
    new SlashOption("hr", "分隔线", "—", (editor) =>
      editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined),
    ),
  ];
}

export function SlashMenuPlugin() {
  const [editor] = useLexicalComposerContext();
  const options = makeOptions();

  const triggerFn = useBasicTypeaheadTriggerMatch("/", { minLength: 0 });

  const onQueryChange = useCallback(() => {}, []);

  const onSelectOption = useCallback(
    (option: MenuOption, _textNode: TextNode | null, closeMenu: () => void) => {
      closeMenu();
      const slashOption = option as SlashOption;
      editor.update(() => {
        slashOption.run(editor);
      });
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
