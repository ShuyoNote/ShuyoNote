// HTML 抽取器：网页/导出的 .html → 段。
// 契约见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §15。
//
// 起因同样来自**真样张跑器**：把真实目录指过去，`.md` 之外 `.html` 也全是 `no_extractor`
// （`customer-facing-playbook.html`）。保存的网页、文档系统导出的单页 HTML，
// 在知识库里是常见的一类，而且是**纯解析、零算力**。
//
// 三个刻意的口径：
//  1. **先去掉 script / style / noscript / head**：不清掉它们，一整页 JS 会被当成正文灌进索引
//     ——这是 HTML 抽取最常见的脏数据来源。
//  2. **块级元素决定分段**：`<p>/<li>/<td>/<h1>…` 各起一段；`<h1>-<h6>` 标成 `heading`（与 docx 一致）；
//     `<br>` 换算行。行内元素（`<a>/<b>/<span>`）只在父块里续写，**不单独成段**。
//  3. **不做 loc**：HTML 解析后没有稳定的页/行概念（DOM 顺序 ≠ 源文件行号），
//     与其编一个看着像定位的东西，不如留空（`loc` 的约定是"给人看的、可回溯的定位"）。
//
// ⚠️ 归一化函数在本地**重写了一遍**（没有从 `ooxml.ts` 里抽公共模块）：
// `ooxml.ts` 目前是**多人协作在改的文件**，为了这次改动去动它，冲突成本高于这 6 行重复。

import {
  fail,
  ok,
  type ExtractInput,
  type ExtractResult,
  type ExtractedSegment,
  type Extractor,
} from "./types";

const HTML_ID = "text.html@1";

/** 整块跳过：里面的内容不是正文。 */
const SKIP = new Set(["script", "style", "noscript", "template", "head", "title", "svg"]);

/** 标题元素 ⇒ `heading`。 */
const HEADING = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** 块级元素 ⇒ 边界（各起一段）。 */
const BLOCK = new Set([
  "p", "div", "section", "article", "aside", "header", "footer", "main", "nav",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tr", "td", "th", "caption",
  "blockquote", "pre", "figure", "figcaption", "form", "fieldset", "details", "summary", "hr",
]);

function norm(s: string): string {
  return s
    .replace(/\u00a0/g, " ") // &nbsp; 解出来的是不换行空格，换成普通空格
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/[ \t]{2,}/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 前 8KB 含 NUL ⇒ 当二进制（与 text.plain 同一判据）。 */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export function htmlToSegments(html: string): ExtractedSegment[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = doc.body ?? doc.documentElement;
  if (!root) return [];

  const out: ExtractedSegment[] = [];
  const flush = (buf: string[]) => {
    const t = norm(buf.join(""));
    if (t.length > 0) out.push({ kind: "text", text: t, loc: "" });
    buf.length = 0;
  };

  const walk = (el: Element, buf: string[]): void => {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3 /* text */) {
        buf.push(node.textContent ?? "");
        continue;
      }
      if (node.nodeType !== 1 /* element */) continue;
      const child = node as Element;
      const tag = child.localName.toLowerCase();
      if (SKIP.has(tag)) continue;

      if (HEADING.has(tag)) {
        flush(buf);
        const t = norm(child.textContent ?? "");
        if (t.length > 0) out.push({ kind: "heading", text: t, loc: "" });
        continue;
      }
      if (tag === "br") {
        buf.push("\n");
        continue;
      }
      if (BLOCK.has(tag)) {
        flush(buf); // 块开始 ⇒ 收掉行内积累
        walk(child, buf);
        flush(buf); // 块结束 ⇒ 本块独立成段
        continue;
      }
      // 行内元素（a / b / span / em…）：继续在父块里收集，不单独成段
      walk(child, buf);
    }
  };

  walk(root, []);
  return out;
}

function extractHtml(input: ExtractInput): ExtractResult {
  if (looksBinary(input.bytes)) {
    return fail(HTML_ID, "unsupported", "看起来是二进制（前 8KB 含 NUL）");
  }
  const html = new TextDecoder("utf-8").decode(input.bytes);
  if (html.trim().length === 0) return fail(HTML_ID, "empty", "文件是空的");

  const segments = htmlToSegments(html);
  if (segments.length === 0) {
    // 解析出来没内容：可能是纯 JS 页（被 SKIP 清干净了）或非 HTML
    return fail(HTML_ID, "empty", "解析后没有文本（可能是纯脚本页或不是 HTML）");
  }
  return ok(HTML_ID, segments);
}

export const htmlExtractor: Extractor = {
  id: HTML_ID,
  mimes: ["text/html", "application/xhtml+xml"],
  extensions: [".html", ".htm", ".xhtml"],
  cost: "cpu",
  extract: async (input: ExtractInput): Promise<ExtractResult> => {
    try {
      return extractHtml(input);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(HTML_ID, "internal", msg);
    }
  },
};
