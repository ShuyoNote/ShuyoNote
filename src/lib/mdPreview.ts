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

const NODES = [
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

const RE_BLOCK_HTML = /<(p|h[1-6]|div|img|table|ul|ol|li|blockquote|pre|hr|section|article|iframe)\b/i;

/**
 * Convert Markdown text into a Lexical serialised state (JSON) + plain text.
 * Returns null on parse failure. Caller creates the page with these.
 */
export function markdownToPageContent(text: string): { content_json: string; content_text: string } | null {
  if (!text.trim()) return null;
  const editor = createEditor({ nodes: NODES, namespace: "shuyonote-md-preview" });
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
