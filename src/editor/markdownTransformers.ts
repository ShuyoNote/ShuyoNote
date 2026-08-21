import {
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
  HorizontalRuleNode,
} from "@lexical/react/LexicalHorizontalRuleNode";
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  TableCellNode,
  TableNode,
  TableRowNode,
} from "@lexical/table";
import {
  CHECK_LIST,
  HEADING,
  MULTILINE_ELEMENT_TRANSFORMERS,
  ORDERED_LIST,
  QUOTE,
  TEXT_FORMAT_TRANSFORMERS,
  TEXT_MATCH_TRANSFORMERS,
  UNORDERED_LIST,
  isTableRowDivider,
  type ElementTransformer,
  type MultilineElementTransformer,
  type TextMatchTransformer,
  type Transformer,
} from "@lexical/markdown";
import {
  $createParagraphNode,
  $createTextNode,
  type ElementNode,
  type LexicalNode,
} from "lexical";
import { BlockEmbedNode, $createBlockEmbedNode, $isBlockEmbedNode } from "./nodes/BlockEmbedNode";
import { BlockRefNode, $createBlockRefNode, $isBlockRefNode } from "./nodes/BlockRefNode";
import { CalloutNode, $createCalloutNode, $isCalloutNode } from "./nodes/CalloutNode";
import { ImageNode, $createImageNode, $isImageNode } from "./nodes/ImageNode";
import { VideoNode, $createVideoNode, $isVideoNode } from "./nodes/VideoNode";

const UUID_RE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

// `![alt](src)`
export const IMAGE: ElementTransformer = {
  dependencies: [ImageNode],
  export: (node: LexicalNode) =>
    $isImageNode(node) ? `![${node.__altText || ""}](${node.__src})` : null,
  regExp: /^!\[([^\]]*)\]\(([^)]+)\)\s?$/,
  replace: (parentNode: ElementNode, _children: LexicalNode[], match: string[]) => {
    parentNode.replace($createImageNode(match[2], match[1]));
  },
  type: "element",
};

// `!video(src)`
export const VIDEO: ElementTransformer = {
  dependencies: [VideoNode],
  export: (node: LexicalNode) => ($isVideoNode(node) ? `!video(${node.__src})` : null),
  regExp: /^!video\(([^)]+)\)\s?$/,
  replace: (parentNode: ElementNode, _children: LexicalNode[], match: string[]) => {
    parentNode.replace($createVideoNode(match[1]));
  },
  type: "element",
};

// `{{blockId}}` (block embed)
export const BLOCK_EMBED: ElementTransformer = {
  dependencies: [BlockEmbedNode],
  export: (node: LexicalNode) => ($isBlockEmbedNode(node) ? `{{${node.__blockId}}}` : null),
  regExp: new RegExp(`^\\{\\{(${UUID_RE})\\}\\}\\s?$`),
  replace: (parentNode: ElementNode, _children: LexicalNode[], match: string[]) => {
    parentNode.replace($createBlockEmbedNode(match[1]));
  },
  type: "element",
};

// `---` horizontal rule
export const HORIZONTAL_RULE: ElementTransformer = {
  dependencies: [HorizontalRuleNode],
  export: (node: LexicalNode) => ($isHorizontalRuleNode(node) ? "---" : null),
  regExp: /^(---|\*\*\*|___)\s?$/,
  replace: (parentNode: ElementNode) => {
    parentNode.replace($createHorizontalRuleNode());
  },
  type: "element",
};

// `((blockId))` (inline block reference)
export const BLOCK_REF: TextMatchTransformer = {
  dependencies: [BlockRefNode],
  export: (node: LexicalNode) => ($isBlockRefNode(node) ? `((${node.__blockId}))` : null),
  importRegExp: new RegExp(`\\(\\((${UUID_RE})\\)\\)`),
  regExp: new RegExp(`\\(\\((${UUID_RE})\\)\\)$`),
  replace: (_textNode: LexicalNode, match: RegExpMatchArray) => {
    return $createBlockRefNode(match[1]);
  },
  type: "text-match",
};

// `> [!NOTE]` callout (multiline)
export const CALLOUT: MultilineElementTransformer = {
  dependencies: [CalloutNode],
  export: (node: LexicalNode, exportChildren: (n: ElementNode) => string) => {
    if (!$isCalloutNode(node)) return null;
    const lines = exportChildren(node).split("\n");
    return "> [!NOTE]\n" + lines.map((l) => "> " + l).join("\n");
  },
  regExpStart: /^>\s*\[!NOTE\]\s*/,
  regExpEnd: { regExp: /^(?!>\s)/, optional: true },
  replace: (
    rootNode: ElementNode,
    _children: LexicalNode[] | null,
    _startMatch: string[],
    _endMatch: string[] | null,
    linesInBetween: string[] | null,
  ) => {
    const callout = $createCalloutNode();
    const text = (linesInBetween ?? [])
      .map((l) => l.replace(/^>\s?/, ""))
      .join(" ")
      .trim();
    callout.append($createParagraphNode().append($createTextNode(text)));
    rootNode.append(callout);
  },
  type: "multiline-element",
};

// Markdown table
export const TABLE: MultilineElementTransformer = {
  dependencies: [TableNode, TableRowNode, TableCellNode],
  export: (node: LexicalNode, exportChildren: (n: ElementNode) => string) => {
    if (!$isTableNode(node)) return null;
    const output: string[] = [];
    for (const row of node.getChildren()) {
      if (!$isTableRowNode(row)) continue;
      const cells: string[] = [];
      for (const cell of row.getChildren()) {
        if ($isTableCellNode(cell)) {
          cells.push(exportChildren(cell).replace(/\n/g, " "));
        }
      }
      output.push("| " + cells.join(" | ") + " |");
    }
    if (output.length > 0) {
      const colCount = Math.max(output[0].split("|").length - 2, 1);
      output.splice(1, 0, "| " + Array(colCount).fill("---").join(" | ") + " |");
    }
    return output.join("\n");
  },
  regExpStart: /^\|/,
  regExpEnd: { regExp: /^(?!\|)/, optional: true },
  // Import is fully handled by handleImportAfterStartMatch; `replace` is
  // required by the type but never reached for tables.
  replace: () => undefined,
  handleImportAfterStartMatch: ({ lines, rootNode, startLineIndex }) => {
    const tableLines: string[] = [];
    let endIndex = startLineIndex;
    for (let i = startLineIndex; i < lines.length; i++) {
      if (/^\|/.test(lines[i])) {
        tableLines.push(lines[i]);
        endIndex = i;
      } else {
        break;
      }
    }

    const parseRow = (line: string): string[] =>
      line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

    let headerRow: string[] | null = null;
    const bodyRows: string[][] = [];
    let dividerSeen = false;
    for (const line of tableLines) {
      if (isTableRowDivider(line)) {
        dividerSeen = true;
        continue;
      }
      if (!dividerSeen) {
        headerRow = parseRow(line);
      } else {
        bodyRows.push(parseRow(line));
      }
    }
    if (headerRow === null) {
      headerRow = bodyRows.shift() ?? [];
    }

    const colCount = Math.max(headerRow.length, ...bodyRows.map((r) => r.length), 1);
    const table = $createTableNode();

    const headerRowNode = $createTableRowNode();
    for (let c = 0; c < colCount; c++) {
      const cell = $createTableCellNode();
      cell.append($createParagraphNode().append($createTextNode(headerRow[c] ?? "")));
      headerRowNode.append(cell);
    }
    table.append(headerRowNode);

    for (const row of bodyRows) {
      const rowNode = $createTableRowNode();
      for (let c = 0; c < colCount; c++) {
        const cell = $createTableCellNode();
        cell.append($createParagraphNode().append($createTextNode(row[c] ?? "")));
        rowNode.append(cell);
      }
      table.append(rowNode);
    }

    rootNode.append(table);
    return [true, endIndex];
  },
  type: "multiline-element",
};

// Full transformer list (defaults + ShuyoNote custom nodes).
export const SHUYONOTE_TRANSFORMERS: Transformer[] = [
  HEADING,
  QUOTE,
  CHECK_LIST,
  UNORDERED_LIST,
  ORDERED_LIST,
  HORIZONTAL_RULE,
  IMAGE,
  VIDEO,
  BLOCK_EMBED,
  ...MULTILINE_ELEMENT_TRANSFORMERS,
  CALLOUT,
  TABLE,
  ...TEXT_FORMAT_TRANSFORMERS,
  ...TEXT_MATCH_TRANSFORMERS,
  BLOCK_REF,
];
