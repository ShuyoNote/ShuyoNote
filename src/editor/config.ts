// Shared Lexical editor configuration: node registry, theme, and the allowed
// node-type set. Both the page editor (Editor.tsx) and Route-B per-column nested
// editors reuse this so they use the SAME node types and visual theme.
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { TableNode, TableCellNode, TableRowNode } from "@lexical/table";
import type { Klass, LexicalNode } from "lexical";
import { CalloutNode } from "./nodes/CalloutNode";
import { ColumnsNode } from "./nodes/ColumnsNode";
import { ColumnNode } from "./nodes/ColumnNode";
import { ColumnsBlockNode } from "./nodes/ColumnsBlockNode";
import { ImageNode } from "./nodes/ImageNode";
import { ImageRowNode } from "./nodes/ImageRowNode";
import { VideoNode } from "./nodes/VideoNode";
import { BlockRefNode } from "./nodes/BlockRefNode";
import { PdfRefNode } from "./nodes/PdfRefNode";
import { BlockEmbedNode } from "./nodes/BlockEmbedNode";
import { WebBookmarkNode } from "./nodes/WebBookmarkNode";
import { AttachmentRefNode } from "./nodes/AttachmentRefNode";
import { DrawingNode } from "./nodes/DrawingNode";
import { MermaidNode } from "./nodes/MermaidNode";

// All node types this editor can deserialize. A serialized node whose `type` is
// outside this set (e.g. a stray/unregistered type) is dropped by lexicalStateValid
// so it can't crash the editor or spam the console with "type ... not found".
export const EDITOR_NODES: Klass<LexicalNode>[] = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  CodeHighlightNode,
  LinkNode,
  CalloutNode,
  ColumnsNode,
  ColumnNode,
  ColumnsBlockNode,
  HorizontalRuleNode,
  ImageNode,
  ImageRowNode,
  VideoNode,
  BlockRefNode,
  PdfRefNode,
  BlockEmbedNode,
  WebBookmarkNode,
  AttachmentRefNode,
  DrawingNode,
  MermaidNode,
  TableNode,
  TableCellNode,
  TableRowNode,
];

// Lexical's always-core types plus the registered ones above.
const CORE_NODE_TYPES = ["root", "paragraph", "text", "linebreak", "tab"];
export const ALLOWED_NODE_TYPES = new Set<string>([
  ...CORE_NODE_TYPES,
  ...EDITOR_NODES.map((n) => (n as { getType?: () => string }).getType?.()).filter((t): t is string => typeof t === "string"),
]);

// Theme tokens shared by the page editor and per-column editors.
export const editorTheme = {
  heading: {
    h1: "editor-h1",
    h2: "editor-h2",
    h3: "editor-h3",
  },
  quote: "editor-quote",
  callout: "editor-callout",
  columns: "editor-columns",
  column: "editor-column",
  list: {
    ul: "editor-ul",
    ol: "editor-ol",
    listitem: "editor-listitem",
    checklist: "editor-checklist",
    listitemChecked: "editor-listitem-checked",
    listitemUnchecked: "editor-listitem-unchecked",
    nested: {
      listitem: "editor-nested-listitem",
    },
  },
  text: {
    bold: "editor-bold",
    italic: "editor-italic",
    underline: "editor-underline",
    strikethrough: "editor-strikethrough",
    code: "editor-code",
  },
  link: "editor-link",
  code: "editor-codeblock",
  hr: "editor-hr",
  table: "editor-table",
  tableScrollableWrapper: "editor-table-scrollable-wrapper",
  tableSelection: "table-selecting",
  tableCell: "editor-table-cell",
  tableCellHeader: "editor-table-cell-header",
  tableCellSelected: "editor-table-cell-selected",
  tableRow: "editor-table-row",
};
