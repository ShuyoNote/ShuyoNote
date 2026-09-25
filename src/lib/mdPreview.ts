// Offscreen Markdown → Lexical JSON, for "转为笔记" (creating a page from a .md
// file in the file manager). Routes exactly like MarkdownImportDialog: pure
// Markdown goes through $convertFromMarkdownString (lossless); content that has
// block HTML is normalised via mdToHtml + $importHtml so structure is preserved.
// Runs in a detached Lexical editor (no DOM attach needed), like exportMarkdown.
import { createEditor, $getRoot } from "lexical";
import { $convertFromMarkdownString } from "@lexical/markdown";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { TableNode, TableCellNode, TableRowNode } from "@lexical/table";
import { CalloutNode } from "../editor/nodes/CalloutNode";
import { ColumnsBlockNode } from "../editor/nodes/ColumnsBlockNode";
import { ImageNode } from "../editor/nodes/ImageNode";
import { ImageRowNode } from "../editor/nodes/ImageRowNode";
import { VideoNode } from "../editor/nodes/VideoNode";
import { BlockRefNode } from "../editor/nodes/BlockRefNode";
import { BlockEmbedNode } from "../editor/nodes/BlockEmbedNode";
import { AttachmentRefNode } from "../editor/nodes/AttachmentRefNode";
import { DrawingNode } from "../editor/nodes/DrawingNode";
import { MermaidNode } from "../editor/nodes/MermaidNode";
import { SHUYONOTE_TRANSFORMERS, preprocessMarkdownImport } from "../editor/markdownTransformers";
import { $importHtml } from "../editor/htmlToLexical";
import { mdToHtml } from "../editor/mdToHtml";

/**
 * 节点表**必须惰性取**，不能写成模块顶层的 `const NODES = [...]`。
 *
 * ⚠️ 2026-09-23 实测（用户截图：社区链接存笔记 → `Minified Lexical error #365`）：
 *   `createEditor` 报的原文是
 *   `nodes[9] … is not a constructor that subclasses LexicalNode` —— 下标 9 正是 `ColumnsBlockNode`。
 *   根因是**循环 import**：
 *     `lib/mdPreview` → `editor/nodes/ColumnsBlockNode` → `store/notes` → `store/filePreview` → `lib/mdPreview`
 *   在 **dev/vitest**（原生 ESM）里求值顺序恰好让 `ColumnsBlockNode` 到位，所以本地与 CI 全绿；
 *   而**打包产物**里模块被拼在一起求值，`mdPreview` 的数组字面量先跑 ⇒ 读到的是尚未赋值的
 *   `undefined` ⇒ `createEditor` 抛错（打包后只剩 `#365` 这个码，正是用户看到的那条）。
 *   改成函数后，节点表在**调用时**才读这些绑定（那时所有模块都已求值完）⇒ 与求值顺序无关。
 *   注意：这一条**不能**靠单测发现（单测走的是 ESM，永远绿）—— 判据只能是**打包产物**里跑一遍。
 */
function mdNodes() {
  return [
    HeadingNode,
    QuoteNode,
    ListNode,
    ListItemNode,
    CodeNode,
    CodeHighlightNode,
    LinkNode,
    CalloutNode,
    HorizontalRuleNode,
    ColumnsBlockNode,
    ImageNode,
    ImageRowNode,
    VideoNode,
    BlockRefNode,
    BlockEmbedNode,
    AttachmentRefNode,
    DrawingNode,
    MermaidNode,
    TableNode,
    TableCellNode,
    TableRowNode,
  ];
}

/** 给判据用：节点表里每一项都必须是可构造的 Lexical 节点类（不是 `undefined`）。 */
export function mdNodeClasses(): unknown[] {
  return mdNodes();
}

const RE_BLOCK_HTML = /<(p|h[1-6]|div|img|table|ul|ol|li|blockquote|pre|hr|section|article|iframe)\b/i;

/**
 * Convert Markdown text into a Lexical serialised state (JSON) + plain text.
 * Returns null on parse failure. Caller creates the page with these.
 */
export function markdownToPageContent(text: string): { content_json: string; content_text: string } | null {
  if (!text.trim()) return null;
  const editor = createEditor({ nodes: mdNodes(), namespace: "shuyonote-md-preview" });
  try {
    const hasBlockHtml = RE_BLOCK_HTML.test(text);
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        if (hasBlockHtml) {
          $importHtml(mdToHtml(text), root);
        } else {
          $convertFromMarkdownString(preprocessMarkdownImport(text), SHUYONOTE_TRANSFORMERS, root);
        }
      },
      { discrete: true },
    );
    const state = editor.getEditorState();
    const content_json = JSON.stringify(state.toJSON());
    const content_text = state.read(() => $getRoot().getTextContent());
    return { content_json, content_text };
  } catch {
    return null;
  }
}
