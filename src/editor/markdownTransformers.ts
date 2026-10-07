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
  TableCellHeaderStates,
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
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  type ElementNode,
  type LexicalNode,
} from "lexical";
import { parseInline, type MdInline } from "../lib/markdown";
import { BlockEmbedNode, $createBlockEmbedNode, $isBlockEmbedNode } from "./nodes/BlockEmbedNode";
import { BlockRefNode, $createBlockRefNode, $isBlockRefNode } from "./nodes/BlockRefNode";
import { CalloutNode, $createCalloutNode, $isCalloutNode } from "./nodes/CalloutNode";
import { ImageNode, $createImageNode, $isImageNode } from "./nodes/ImageNode";
import { VideoNode, $createVideoNode, $isVideoNode } from "./nodes/VideoNode";
import { FormulaNode, $createFormulaNode, $isFormulaNode } from "./nodes/FormulaNode";
import {
  MermaidNode,
  $createMermaidNode,
  $isMermaidNode,
} from "./nodes/MermaidNode";
import { suggestColWidths } from "../lib/tableFit";

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

/**
 * 表格单元格里的**行内格式**（owner 2026-10-01：「表格内的加粗问题没有解决」）。
 *
 * 原先两处单元格都是 `$createTextNode(原文)` —— 于是 `**粗**` 只是**字面文本** ✗。
 * 根因不是"解析器不认识粗体"，而是**表格整行被 `TABLE` 这个 element transformer 吃掉了**：
 * 行级的文本格式 transformer（`TEXT_FORMAT_TRANSFORMERS`）**根本看不到单元格里的字** ✓。
 *
 * 所以这里自己把单元格文本过一次行内解析 —— ⛔ **不另写解析器**：复用
 * `src/lib/markdown.ts` 的 `parseInline`（唯一出处 ✓）。
 * 效果：`**粗**` / `*斜*` / `` `码` `` ⇒ 带 format 的 TextNode ⇒ 渲染即为粗体/斜体/等宽 ✓，
 * 且导出侧 `exportChildren(cell)` 会照 format 还原 `**…**` ⇒ **往返不丢** ✓。
 *
 * ⚠️ **链接**暂按原文保留（`[label](url)`）—— 与改动前的行为一致 ✓，**不静默吞掉 URL** ✗。
 *    表格单元格里的链接少见，留作已知缺口（要补时用 `@lexical/link` 的 `$createLinkNode` ✓）。
 */
function appendInlineMarkdown(parent: ElementNode, pieces: MdInline[], format = 0): void {
  for (const piece of pieces) {
    switch (piece.kind) {
      case "text":
        parent.append($createTextNode(piece.text).setFormat(format));
        break;
      case "bold":
        appendInlineMarkdown(parent, piece.children, format | IS_BOLD);
        break;
      case "italic":
        appendInlineMarkdown(parent, piece.children, format | IS_ITALIC);
        break;
      case "code":
        parent.append($createTextNode(piece.text).setFormat(format | IS_CODE));
        break;
      case "link":
        parent.append($createTextNode(`[${piece.label}](${piece.href})`).setFormat(format));
        break;
    }
  }
}

/** 建一个单元格：段落 +（走行内解析的）若干文本节点。
 *  `headerState` 给表头行用（`TableCellHeaderStates.ROW` ⇒ 渲染成 `<th>`，
 *  owner 2026-10-01：「表格的标题列不加粗吗？」——md 惯例里表头本来就该是粗的 ✓）。 */
function createMarkdownCell(
  text: string,
  headerState: number = TableCellHeaderStates.NO_STATUS,
): TableCellNode {
  const paragraph = $createParagraphNode();
  appendInlineMarkdown(paragraph, parseInline(text));
  return $createTableCellNode(headerState).append(paragraph);
}

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
    // ⚠️ 2026-10-01 二次撤回：这里一度改成 `$createBlockTableNode(newBlockId())`（想让导入直接出模型表，
    //    从源头避开 `upgradeTableToBlockNode` 的"替换 ⇒ observer 悬空"）。
    //    **但它炸了另一条路** ✗：`src/lib/mdPreview.ts` 的**文件预览**用的是**同一组
    //    `SHUYONOTE_TRANSFORMERS`**，而它的编辑器**没注册 `BlockTableNode`** ⇒ 逐字报
    //    「Attempted to create node BlockTableNode that was not configured to be used on the editor」
    //    （堆栈：mdPreview.ts:84 → filePreview.ts:68 → FilePreviewDialog.tsx ✓）。
    //    ⇒ 撤回，回到内建 `TableNode`：先让预览恢复 ✓；
    //      真要根治 observer 那条，应在**加载路径**上把普通表升级（见与 owner 的讨论 ✓），
    //      而不是改这个被多处共用的 transformer ✗。
    const table = $createTableNode();

    const headerRowNode = $createTableRowNode();
    for (let c = 0; c < colCount; c++) {
      // ⚠️ 2026-10-01 撤回：这里一度把表头行标成 `TableCellHeaderStates.ROW`（渲染真 <th>），
      //    随后 owner 侧实测报「编辑器错误：tableObserver not found for tableKey: 2259」✗，
      //    而且**时间点正是重新导入之后** ⇒ 先撤回，把编辑器恢复稳定。
      //    表头观感（加粗 ＋ 背景）由 CSS 给（见 App.css 的 `.editor-content table th` /
      //    `table tr:first-child > td`）⇒ **不依赖这个状态** ✓，撤回后观感不变 ✓。
      headerRowNode.append(createMarkdownCell(headerRow[c] ?? ""));
    }
    table.append(headerRowNode);

    for (const row of bodyRows) {
      const rowNode = $createTableRowNode();
      for (let c = 0; c < colCount; c++) {
        rowNode.append(createMarkdownCell(row[c] ?? ""));
      }
      table.append(rowNode);
    }

    // ⭐ 2026-10-07（owner：「导入笔记时，表格列可否**自动适配列宽**，或跳到一个视觉合理的宽度」✗）：
    //   导入时**顺手按内容长度给一组相对列宽** ✓ —— 不设的话，配合
    //   `.editor-table { table-layout: fixed; width: 100% }` 就是**各列等宽** ✗
    //   ⇒ "示例 / 目的"这种文字多的列很挤、要折两行 ✓（owner 截图那张表 ✓）。
    //   纯规则在 `lib/tableFit.ts`（可单测 ✓）；这里只喂"表头 ＋ 每一行"的文本 ✓。
    //   ⚠️ 只表达**相对关系** ✓ —— 真落到页面上时由 `fitColWidths` 按可用宽度再归一化一次 ✓。
    table.setColWidths(suggestColWidths([headerRow, ...bodyRows]));

    rootNode.append(table);
    return [true, endIndex];
  },
  type: "multiline-element",
};

// `$$latex$$` block math formula (one line => FormulaNode)
export const FORMULA: ElementTransformer = {
  dependencies: [FormulaNode],
  export: (node: LexicalNode) => ($isFormulaNode(node) ? `$$${node.__latex}$$` : null),
  regExp: /^\$\$([\s\S]+?)\$\$\s?$/,
  replace: (parentNode: ElementNode, _children: LexicalNode[], match: string[]) => {
    const latex = (match[1] || "").trim();
    parentNode.replace($createFormulaNode(latex));
  },
  type: "element",
};

// ```` ```mermaid ```` 围栏 → **mermaid 块**（不是代码块）。2026-10-05 补（owner 实测：
// 导入的 .md 里 10 张流程图全变成代码块 ⇒ 编辑器只显示源码，"页面识别不了图形"）。
//
// ⚠️ **必须排在 `...MULTILINE_ELEMENT_TRANSFORMERS` 之前** —— 那个数组里有 Lexical 的 `CODE`，
//    它会先把 ```mermaid 吃成普通代码块（语言字段倒是抄对了 ⇒ 只是没渲染）。
// ⚠️ 闭合围栏必须**收紧**（`^[ \t]*```[ \t]*$`）：没闭合时返回 `null` 交回 `CODE`，
//    不能把后面整篇文档都吞进图里。
// ⚠️ 导入这一支只覆盖"经过 markdown 解析"的路径；**已经存成代码块的老内容**由
//    `blockIdTransform.upgradeCodeToBlockNode` 的 mermaid 分支兜（打开页面即生效）。
const MERMAID_END_RE = /^[ \t]*```[ \t]*$/;
export const MERMAID: MultilineElementTransformer = {
  dependencies: [MermaidNode],
  export: (node: LexicalNode) =>
    $isMermaidNode(node) ? "```mermaid\n" + node.getTextContent() + "\n```" : null,
  regExpStart: /^[ \t]*```mermaid[ \t]*$/,
  regExpEnd: /^[ \t]*```[ \t]*$/,
  // ⚠️ **必须自己处理导入**（不能用默认扫描那条路）：默认路会把结果塞进一个**新建的段落**里
  //    ⇒ `paragraph > mermaid`（实测 2026-10-05）。那样图是能渲染，但 mermaid 变成**嵌套块** ⇒
  //    按本仓"只有顶层块才有块身份"的规矩它**拿不到 blockId**（CRDT 平面里没有稳定身份 ✗）。
  //    自己 append 到 `rootNode` 才与 Lexical 的 `CODE` 同形（顶层块 ＋ 块 ID ✓）。
  handleImportAfterStartMatch: ({ lines, rootNode, startLineIndex }) => {
    for (let i = startLineIndex + 1; i < lines.length; i++) {
      if (MERMAID_END_RE.test(lines[i])) {
        rootNode.append($createMermaidNode(lines.slice(startLineIndex + 1, i).join("\n")));
        return [true, i];
      }
    }
    // 没闭合 ⇒ `null` = 让下一个 multiline transformer（Lexical 的 `CODE`）接手 ⇒ 退化成代码块 ✓
    return null;
  },
  replace: (
    rootNode: ElementNode,
    _children: LexicalNode[] | null,
    _startMatch: string[],
    _endMatch: string[] | null,
    linesInBetween: string[] | null,
  ) => {
    rootNode.append($createMermaidNode((linesInBetween ?? []).join("\n")));
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
  MERMAID, // ⚠️ 必须在 MULTILINE_ELEMENT_TRANSFORMERS（含 Lexical 的 CODE）之前
  ...MULTILINE_ELEMENT_TRANSFORMERS,
  CALLOUT,
  TABLE,
  FORMULA,
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
//
// ⭐ 2026-10-07（owner 连报两次：「原始 md 文档有缩进，你转换时丢掉了」＋「md 里面的 json 代码
//    转换后，缩进也没有了」✗）：**围栏代码块必须先原样摘出来** ✓。
//
//   为什么：这条路径是"**只要文档里有任何 HTML 标签**，就把整篇 md 丢给 `DOMParser`" ✓。
//   而 ```json / ```mermaid 围栏**不是 `<pre>`** ✗ ⇒ 两处折叠同时发生：
//     ① HTML 解析器先把非 `<pre>` 里的连续空格折成一个 ✗；
//     ② `nodeToMarkdown` 的元素分支 `inner.replace(/[ \t]{2,}/g, " ")` 再折一次 ✗。
//   ⇒ 围栏里**用来表达结构**的缩进全没了 ✓ —— 这正是那两条报障的同一个真因 ✓
//     （mermaid 没了层级 ⇒ `There can be only one root` ✓；json 没了缩进 ⇒ 不再是可读的 json ✓）。
//
//   修法：**先摘出围栏**（``` 与 ~~~ 都算 ✓，允许缩进 ✓），只对围栏**外面**做 HTML→markdown ✓，
//   最后按原顺序把围栏**一字不动**地拼回去 ✓。占位符用纯字母数字＋`%` ✓——不含空格/换行，
//   HTML 解析与折叠都动不了它 ✓（⛔ 别用 NUL 之类：HTML 解析器会把它换成 U+FFFD ✗）。
const FENCE_BLOCK_RE = /^[ \t]*(`{3,}|~{3,})[^\n]*\r?\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;

export function preprocessMarkdownImport(text: string): string {
  if (!HTML_RE.test(text)) return text;
  const fences: string[] = [];
  const masked = text.replace(FENCE_BLOCK_RE, (whole) => {
    fences.push(whole);
    return `%%FENCE${fences.length - 1}%%`;
  });
  const converted = nodeToMarkdown(new DOMParser().parseFromString(masked, "text/html").body)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // 把围栏拼回去（位置由占位符决定 ✓，顺序天然保持 ✓）
  return converted.replace(/%%FENCE(\d+)%%/g, (_m, i: string) => fences[Number(i)] ?? "").trim();
}
