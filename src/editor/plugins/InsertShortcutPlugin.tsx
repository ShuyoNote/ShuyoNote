import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  KEY_DOWN_COMMAND,
  type ElementNode,
} from "lexical";
import { $createHeadingNode, $createQuoteNode } from "@lexical/rich-text";
import {
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
} from "@lexical/list";
import { $createSafeCodeNode } from "../nodes/SafeCodeNode";
import { $createLinkNode } from "@lexical/link";
import { $createHorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { $getInsertTargetBlock } from "../blockUtils";

// Keyboard shortcuts to insert/replace blocks, so common blocks are a keystroke
// away (no need to open the "/" menu). Combos use Ctrl/Cmd+Alt so they don't clash
// with the existing Ctrl+K/F/N/E shortcuts or Markdown input shortcuts.
//
//   Ctrl+Alt+1/2/3 → 标题1/2/3      Ctrl+Alt+U → 无序列表
//   Ctrl+Alt+O → 有序列表            Ctrl+Alt+T → 待办
//   Ctrl+Alt+Q → 引用               Ctrl+Alt+C → 代码块
//   Ctrl+Alt+L → 链接               Ctrl+Alt+M → 分隔线

function $replaceBlock(newNode: ElementNode) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  const anchor = selection.anchor.getNode();
  const target = $getInsertTargetBlock(anchor);
  if (!target || !$isElementNode(target)) return;
  for (const child of target.getChildren()) newNode.append(child);
  target.replace(newNode);
  newNode.selectStart();
}

export function InsertShortcutPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (e: KeyboardEvent) => {
        if (!(e.ctrlKey || e.metaKey) || !e.altKey || e.shiftKey) return false;
        const key = e.key.toLowerCase();

        if (key === "1") {
          e.preventDefault();
          editor.update(() => $replaceBlock($createHeadingNode("h1")));
          return true;
        }
        if (key === "2") {
          e.preventDefault();
          editor.update(() => $replaceBlock($createHeadingNode("h2")));
          return true;
        }
        if (key === "3") {
          e.preventDefault();
          editor.update(() => $replaceBlock($createHeadingNode("h3")));
          return true;
        }
        if (key === "u") {
          e.preventDefault();
          editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
          return true;
        }
        if (key === "o") {
          e.preventDefault();
          editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
          return true;
        }
        if (key === "t") {
          e.preventDefault();
          editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined);
          return true;
        }
        if (key === "q") {
          e.preventDefault();
          editor.update(() => $replaceBlock($createQuoteNode()));
          return true;
        }
        if (key === "c") {
          e.preventDefault();
          editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;
            const topLevel = $getInsertTargetBlock(selection.anchor.getNode());
            const code = $createSafeCodeNode();
            if (topLevel && $isElementNode(topLevel)) {
              for (const child of topLevel.getChildren()) code.append(child);
              topLevel.replace(code);
              code.selectStart();
            }
          });
          return true;
        }
        if (key === "l") {
          e.preventDefault();
          editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;
            const topLevel = $getInsertTargetBlock(selection.anchor.getNode());
            if (!topLevel) return;
            const text = topLevel.getTextContent() || "链接";
            const paragraph = $createParagraphNode();
            paragraph.append($createLinkNode("https://").append($createTextNode(text)));
            topLevel.replace(paragraph);
            paragraph.selectStart();
          });
          return true;
        }
        if (key === "m") {
          e.preventDefault();
          editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;
            const topLevel = $getInsertTargetBlock(selection.anchor.getNode());
            if (!topLevel) return;
            const hr = $createHorizontalRuleNode();
            topLevel.replace(hr);
            const paragraph = $createParagraphNode();
            hr.insertAfter(paragraph);
            paragraph.select();
          });
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [editor]);

  return null;
}
