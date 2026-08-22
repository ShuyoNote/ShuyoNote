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

// `![alt](src)` (block image; optional ` =WxH` size hint)
export const IMAGE: ElementTransformer = {
  dependencies: [ImageNode],
  export: (node: LexicalNode) =>
    $isImageNode(node) ? `![${node.__altText || ""}](${node.__src})` : null,
  regExp: /^!\[([^\]]*)\]\(([^)=]+?)(?:\s*=\s*(\d+)x(\d+))?\)\s?$/,
  replace: (parentNode: ElementNode, _children: LexicalNode[], match: string[]) => {
    const src = match[2].trim();
    const width = match[3] ? +match[3] : null;
    const height = match[4] ? +match[4] : null;
    parentNode.replace($createImageNode(src, match[1], false, width, height));
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
  replace: (parentNode: ElementNode, _children: LexicalNode[], _match: string[], isImport: boolean) => {
    const hr = $createHorizontalRuleNode();
    parentNode.replace(hr);
    // When typed (not imported), drop an empty paragraph below so the caret can
    // keep typing right after the divider (matches the slash-menu behavior).
    if (!isImport) {
      const paragraph = $createParagraphNode();
      hr.insertAfter(paragraph);
      paragraph.select();
    }
  },
  type: "element",
  // Allow `---` + Enter to convert (Notion-style), not just `--- ` + space.
  triggerOnEnter: true,
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

// Lexical's markdown parser treats raw HTML as plain text, so importing a
// README-style document (full of <p>/<h1>/<img>/<strong>) shows the source
// tags instead of rendered content. Convert the common HTML tags down to
// markdown before the lexer runs so they parse into real blocks/nodes.
const HTML_RE = /<[a-zA-Z!/][^>]*>/;

function nodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").replace(/\u00a0/g, " ");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const inner = Array.from(el.childNodes, (c) => nodeToMarkdown(c)).join("");
  const cleaned = inner.replace(/[ \t]{2,}/g, " ").replace(/ ?\n ?/g, "\n").trim();

  switch (tag) {
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
      return `\n\n${"#".repeat(+tag[1])} ${cleaned}\n\n`;
    case "p":
    case "div":
    case "section":
    case "article":
    case "header":
    case "footer":
    case "main":
    case "aside":
      return `\n\n${cleaned}\n\n`;
    case "strong": case "b":
      return `**${cleaned}**`;
    case "em": case "i":
      return `*${cleaned}*`;
    case "del": case "s":
      return `~~${cleaned}~~`;
    case "code":
      return `\`${cleaned}\``;
    case "a":
      return `[${cleaned}](${el.getAttribute("href") ?? ""})`;
    case "img": {
      // Emit each image as its own block so it converts into an ImageNode
      // (inline images aren't reliably supported by the markdown importer).
      // Carry the explicit size hint so explicitly-sized images (e.g. a 128px
      // logo) render small instead of stretching to the column width.
      const src = el.getAttribute("src") ?? "";
      if (!src) return "";
      const alt = el.getAttribute("alt") ?? "";
      const w = el.getAttribute("width");
      const h = el.getAttribute("height");
      const size = w && h ? ` =${w}x${h}` : "";
      return `\n\n![${alt}](${src.trim()}${size})\n\n`;
    }
    case "br":
      return "  \n";
    case "hr":
      return `\n\n---\n\n`;
    case "li":
      return `\n- ${cleaned}`;
    case "ul":
    case "ol": {
      const items = Array.from(el.children)
        .map((li) => nodeToMarkdown(li))
        .join("");
      return `\n${items}\n`;
    }
    case "blockquote":
      return `\n\n> ${cleaned}\n\n`;
    case "pre":
      return `\n\n\`\`\`\n${el.textContent ?? ""}\n\`\`\`\n\n`;
    default:
      // Unknown tag: keep inner content (used for <div> children, spans, etc.).
      return cleaned;
  }
}

// Normalize any HTML embedded in imported Markdown into markdown syntax. Pure
// markdown (no HTML tags) is returned unchanged so the lexer sees it verbatim.
export function preprocessMarkdownImport(text: string): string {
  if (!HTML_RE.test(text)) return text;
  const doc = new DOMParser().parseFromString(text, "text/html");
  return nodeToMarkdown(doc.body).replace(/\n{3,}/g, "\n\n").trim();
}
