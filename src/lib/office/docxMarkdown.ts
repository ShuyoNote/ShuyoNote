// **块结构 ⇒ Markdown**（Office 导入第一期 · 2026-10-09）。
//
// ## 为什么中间过一层 Markdown 而不是直接建 Lexical 节点
// 本仓「导入整篇 Markdown」这条路已经**又老又稳**：`src/lib/mdPreview.ts` 的
// `markdownToPageContent()` 把 md 转成 Lexical JSON ＋ 纯文本（`MarkdownImportDialog` /
// `store/filePreview.ts` 的「转为笔记」都走它 ✓）。标题／段落／列表／表格／图片**正好是**它支持的
// md 构造 ⇒ 复用这一层 = 不用第二套"块 → Lexical"实现 ✓（这是本仓最忌的"两份真相源" ✗）。
//
// ## ⛔ 本文件不做的事
//  - **不解析 docx**（那是 `src/lib/extract/ooxml.ts::docxToNoteBlocks` 的活 ✓）
//  - **不落库、不发 IPC**（图片落成什么地址由调用方给 `resolveImage` 决定 ✓）
//  - **不猜**：图片 resolver 返回 null ⇒ 正文里留一行**可读说明**并计数 ✓（⛔ 不静默丢 ✗）

import type { DocxImage, NoteBlock } from "../extract/ooxml";

export interface MarkdownRenderResult {
  markdown: string;
  /** 引用了图片块的数量（＝ `![…](…)` 行数）。 */
  imagesRendered: number;
  /** 没能落成图片、只留了说明行的数量（⛔ 这个数不为 0 时必须让用户看见 ✓）。 */
  imagesUnresolved: number;
  warnings: string[];
}

export interface MarkdownRenderOptions {
  /**
   * 把一张图变成 md 里的 src（例如 `attachment://<hash>`）。
   * 返回 null ＝ 这张图**没落成**（调用方已经知道原因）⇒ 这里写一行人话 ✓。
   */
  resolveImage?: (image: DocxImage) => string | null;
}

/** 元数据块要的事实（⭐ 全部**注入** ⇒ 判据能固定时间与计数 ✓，⛔ 不读全局时钟 ✗）。 */
export interface OfficeMetaInput {
  /** 来源：这一层只知道**文件名** ✓（完整路径属于界面那层，见 `importPipeline` 的注释 ✓）。 */
  source: string;
  /** 转换时刻（注入 ✓）。 */
  at: Date;
  /** 原文档作者 —— ⚠️ 解析层**现在没读** `docProps/core.xml` ⇒ 拿不到就**不写这一行** ✓，⛔ 不写「未知」当事实 ✗。 */
  author?: string | null;
  /** 去掉空白后的字符数（⭐ 口径写在下面注释里 ✓ —— 「字数」这个词本身有歧义 ✓）。 */
  chars: number;
  images: number;
  tables: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * ⭐ 2026-10-11（owner：「至少加上元数据」）：⭐ 导入笔记**顶部那几行元数据** ✓。
 *
 * ⚠️ 只做**元数据这一件** ✗ —— ⭐ owner 提过的「目录」「图片列表」「表格列表」「附录」**故意不做** ✓：
 *   · 目录要编辑器有**锚点/跳转**那套能力 ✓，⭐ 现在没有 ⇒ ⭐ 塞进去就是"看着有、其实没用" ✗；
 *   · 图/表**已经在正文里** ⇒ 再列一遍是重复 ✓。
 * ⇒ ⭐ 判据里有一条专门钉这个（`docxMarkdown.test.ts`）✓。
 *
 * ⚠️ 作者拿不到时**整行不写** ✗（⛔ 不写「作者：未知」当事实 ✓）。
 * ⚠️ 「字数」口径 ＝ **去掉空白后的字符数** ✓（中文按字、英文按字符 ✓；⛔ 不说成"词数" ✗）。
 */
export function officeMetaMarkdown(meta: OfficeMetaInput): string {
  const d = meta.at;
  const lines = [
    `> 📄 来源：${meta.source}`,
    `> 🕐 转换时间：${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
      d.getHours(),
    )}:${pad2(d.getMinutes())}`,
  ];
  const author = meta.author?.trim();
  if (author) {
    lines.push(`> ✍️ 原文档作者：${author}`);
  }
  lines.push(`> 📊 字数：${meta.chars} 字 ｜ 图片：${meta.images} 张 ｜ 表格：${meta.tables} 个`);
  return lines.join("\n");
}

/** 表格单元格里不能出现的东西：`|` 会被导入器当分隔符（它**不做转义** ⇒ 列会错位 ✗）。 */
const PIPE_REPLACEMENT = "¦";

/** 正文里"看起来像 HTML 标签"的片段 ⇒ 导入器会走 HTML 归一那条路（`preprocessMarkdownImport`）。 */
const HTML_ISH = /<[a-zA-Z!/][^>]*>/;

/** 段落以这些开头会被 md 解析成**结构**（标题/列表/引用）而不只是文字。 */
const STRUCTURAL_START = /^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>)/;

function escapeCell(text: string): { text: string; replaced: number } {
  const oneLine = text.replace(/\s*\n\s*/g, " ").trim();
  let replaced = 0;
  const out = oneLine.replace(/\|/g, () => {
    replaced += 1;
    return PIPE_REPLACEMENT;
  });
  return { text: out, replaced };
}

/**
 * 块 ⇒ Markdown 全文。
 *
 * ⚠️ 分隔用**空行**（md 的块边界）✓；标题按 `#`×level（level 已在解析层夹到 1..6 ✓）。
 */
export function blocksToMarkdown(
  blocks: NoteBlock[],
  opts: MarkdownRenderOptions = {},
): MarkdownRenderResult {
  const warnings: string[] = [];
  const parts: string[] = [];
  let imagesRendered = 0;
  let imagesUnresolved = 0;
  let pipesReplaced = 0;
  let structuralParagraphs = 0;

  for (const block of blocks) {
    switch (block.kind) {
      case "heading":
        parts.push(`${"#".repeat(Math.min(6, Math.max(1, block.level)))} ${block.text}`);
        break;
      case "paragraph":
        if (STRUCTURAL_START.test(block.text)) structuralParagraphs += 1;
        parts.push(block.text);
        break;
      case "list":
        // 2 空格 / 级：Lexical 的 md 导入按缩进判嵌套 ✓
        parts.push(`${"  ".repeat(Math.max(0, block.level))}${block.marker} ${block.text}`);
        break;
      case "table": {
        const rows = block.rows;
        if (rows.length === 0) break;
        const width = Math.max(...rows.map((r) => r.length), 1);
        const lines: string[] = [];
        rows.forEach((row, index) => {
          const cells: string[] = [];
          for (let c = 0; c < width; c++) {
            const { text, replaced } = escapeCell(row[c] ?? "");
            pipesReplaced += replaced;
            cells.push(text);
          }
          lines.push(`| ${cells.join(" | ")} |`);
          // GFM：表头行后面必须有分隔行（本仓导入器同样要求 ✓）
          if (index === 0) lines.push(`| ${Array(width).fill("---").join(" | ")} |`);
        });
        parts.push(lines.join("\n"));
        break;
      }
      case "image": {
        const src = opts.resolveImage ? opts.resolveImage(block.image) : null;
        if (src) {
          const alt = block.image.name.replace(/[[\]()]/g, "");
          parts.push(`![${alt}](${src})`);
          imagesRendered += 1;
        } else {
          // ⭐ 如实写一行 —— 用户看得见"这里本该有张图"，而不是页面莫名其妙少东西 ✓
          parts.push(`> ⚠️ 图片「${block.image.name}」没能存进附件库，正文里没有它（原图仍在文档里）`);
          imagesUnresolved += 1;
        }
        break;
      }
    }
  }

  if (pipesReplaced > 0) {
    warnings.push(
      `${pipesReplaced} 个表格单元格里的 \`|\` 已换成 \`${PIPE_REPLACEMENT}\` —— 本仓的表格导入**不做转义**，不换会让列错位`,
    );
  }
  if (structuralParagraphs > 0) {
    warnings.push(
      `${structuralParagraphs} 段正文以 markdown 结构符号开头（\`#\` / \`-\` / \`1.\` / \`>\`）⇒ 导入后可能被当成标题或列表`,
    );
  }
  if (HTML_ISH.test(parts.join("\n"))) {
    warnings.push("正文里含 `<…>` 片段 ⇒ 导入器会走 HTML 归一那条路（结构可能被重排）");
  }
  if (imagesUnresolved > 0) {
    warnings.push(`${imagesUnresolved} 张图片没有进正文（已在上方逐张说明）`);
  }

  return {
    markdown: parts.join("\n\n").trim(),
    imagesRendered,
    imagesUnresolved,
    warnings,
  };
}
