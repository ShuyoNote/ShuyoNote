// OOXML 抽取器：docx / xlsx / pptx →「带定位的段」。
// 契约见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §15。
//
// 为什么用 fflate + DOMParser 而不是引第三方 office 解析库：
//  - fflate 已在 dependencies（插件打包在用），是纯 JS 的解压，桌面/Web 同构；
//  - OOXML 就是一个 zip + 一堆 XML，取文本只需要读少数几个 part，不值得为一件事引一个重依赖；
//  - 契约 §15.3-3 要求产出**纯文本**，本来就要自己控制"哪些元素算文本"。
//
// ⚠️ 已知并接受的边界（写出来，免得被当成 bug）：
//  - **docx 没有页号**：分页是渲染期的事，OOXML 里不存在 ⇒ docx 段的 `loc` 一律为 `''`。
//    要页号必须真正排版（LibreOffice headless）或让用户看 PDF 版。
//  - **不解析样式/批注/脚注/文本框**：只取正文流。页眉页脚与文本框里的文字**不在** `word/document.xml`。

import { unzipSync } from "fflate";

import {
  fail,
  ok,
  type ExtractInput,
  type ExtractResult,
  type ExtractedSegment,
  type Extractor,
} from "./types";

/** OLE 复合文档头（老式 .doc / 加密的 OOXML 都是它）——用来把"加密"和"损坏"分开。 */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWithOle(bytes: Uint8Array): boolean {
  if (bytes.length < OLE_MAGIC.length) return false;
  return OLE_MAGIC.every((b, i) => bytes[i] === b);
}

/** 解 zip；失败抛错，由调用方归类为 corrupt/internal。 */
function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes) as Record<string, Uint8Array>;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** 解析 XML；遇到 parsererror 抛错。 */
function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const err = doc.getElementsByTagName("parsererror");
  if (err.length > 0) throw new Error("XML 解析失败");
  return doc;
}

/** 取某个 part 的已解析 XML；不存在返回 null。 */
function partXml(
  files: Record<string, Uint8Array>,
  path: string,
): Document | null {
  const raw = files[path];
  if (!raw) return null;
  return parseXml(decode(raw));
}

/**
 * 命名空间无关地取全部同名元素。
 *
 * ⚠️ **刻意手工遍历，不用 `getElementsByTagNameNS("*", name)`**：实测 happy-dom 不支持该通配
 * （返回 0 条），而浏览器与 WebView 支持 ⇒ 用它会让"测试绿、线上崩"或反过来。
 * 手工比 `localName` 在前三者上行为一致，且**与前缀无关**（生产者用 `w:` 还是 `ns0:` 都无所谓）。
 */
function allByLocalName(root: Document | Element, localName: string): Element[] {
  const out: Element[] = [];
  // Document 取 documentElement；Element 本身就是起点（documentElement 为 undefined 时兜底）
  const start = (root as Document).documentElement ?? (root as Element);
  const visit = (el: Element): void => {
    if (el.localName === localName) out.push(el);
    for (const child of Array.from(el.children)) visit(child);
  };
  if (start) visit(start);
  return out;
}

function directChildren(el: Element, localName: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === localName);
}

/** 拼接元素内所有 `<*:t>` 的文本（跨 run 合并，不插空格——OOXML 的 run 是样式切分，不是词切分）。 */
function runText(el: Element): string {
  return allByLocalName(el, "t")
    .map((t) => t.textContent ?? "")
    .join("");
}

/** 段文本归一：CRLF→LF、去行尾空白、压掉连续空行。**不做 trim 以外的改写**（保确定性）。 */
function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 丢掉空段，并把全空的段集合转成 `empty` 错误（契约 §15.2 的 `empty` 语义）。 */
function finish(extractor: string, segments: ExtractedSegment[]): ExtractResult {
  const kept = segments.filter((s) => s.text.trim().length > 0);
  if (kept.length === 0) {
    return fail(extractor, "empty", "没有抽到任何文本（可能是扫描件 / 纯图 / 空文档）");
  }
  return ok(extractor, kept);
}

/** zip 魔数（普通包 / 空包 / 分卷），用来把"不是 zip"与"zip 损坏"分开。 */
function startsWithZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  );
}

/**
 * 把失败归类 —— 这个划分是**给调度器用的**，不是措辞问题：
 *  - 不是 zip、也不是 OLE ⇒ `unsupported`：这个抽取器不认这种字节，**换一个试**；
 *  - 是 OLE             ⇒ `encrypted`：加密的 OOXML 就是 OLE 复合文档；
 *  - 其余               ⇒ `corrupt`：确实是 zip，但里面坏了。
 */
function classifyFailure(extractor: string, input: ExtractInput, e: unknown): ExtractResult {
  if (startsWithOle(input.bytes)) {
    return fail(extractor, "encrypted", "文件是 OLE 复合文档（加密或旧式二进制格式）");
  }
  if (!startsWithZip(input.bytes)) {
    return fail(extractor, "unsupported", "不是 zip 容器（本抽取器只认 OOXML）");
  }
  const msg = e instanceof Error ? e.message : String(e);
  return fail(extractor, "corrupt", `OOXML 容器损坏或无法解压：${msg}`);
}

// ---------------------------------------------------------------- docx

const DOCX_ID = "ooxml.docx@1";

/** 段落是否标题：`w:pStyle` 以 Heading 开头，或 `w:outlineLvl` 存在（0 基）。 */
function docxHeadingLevel(p: Element): number | null {
  const pPr = directChildren(p, "pPr")[0];
  if (!pPr) return null;
  const style = directChildren(pPr, "pStyle")[0];
  const styleVal = style?.getAttributeNS("*", "val") ?? style?.getAttribute("w:val") ?? "";
  const m = /^Heading\s*(\d+)$/i.exec(styleVal);
  if (m) return Number(m[1]);
  if (directChildren(pPr, "outlineLvl").length > 0) return 1;
  return null;
}

/** 表格 → 一个段：单元格 `\t` 分隔、行 `\n` 分隔（契约 §15.3-3）。 */
function docxTableText(tbl: Element): string {
  const rows: string[] = [];
  for (const tr of directChildren(tbl, "tr")) {
    const cells: string[] = [];
    for (const tc of directChildren(tr, "tc")) {
      const cellText = allByLocalName(tc, "p")
        .map((p) => runText(p))
        .filter((t) => t.length > 0)
        .join(" ");
      cells.push(cellText.replace(/[\t\n]+/g, " "));
    }
    rows.push(cells.join("\t"));
  }
  return rows.join("\n");
}

function extractDocx(input: ExtractInput): ExtractResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzip(input.bytes);
  } catch (e) {
    return classifyFailure(DOCX_ID, input, e);
  }
  try {
    const doc = partXml(files, "word/document.xml");
    if (!doc) return fail(DOCX_ID, "unsupported", "zip 里没有 word/document.xml（不是 docx）");

    const body = allByLocalName(doc, "body")[0];
    if (!body) return fail(DOCX_ID, "corrupt", "word/document.xml 里没有 body（结构不完整）");

    const segments: ExtractedSegment[] = [];
    // 只走 body 的**直接子元素**，顺序即文档顺序；table 单独成段。
    for (const child of Array.from(body.children)) {
      if (child.localName === "p") {
        const text = normalizeText(runText(child));
        if (!text) continue;
        segments.push({
          kind: docxHeadingLevel(child) !== null ? "heading" : "text",
          text,
          loc: "", // docx 无页号，见文件头注释
        });
      } else if (child.localName === "tbl") {
        const text = normalizeText(docxTableText(child));
        if (text) segments.push({ kind: "table", text, loc: "" });
      }
    }
    return finish(DOCX_ID, segments);
  } catch (e) {
    return classifyFailure(DOCX_ID, input, e);
  }
}

// ---------------------------------------------------------------- xlsx

const XLSX_ID = "ooxml.xlsx@1";

/** rId → part 路径（`xl/_rels/workbook.xml.rels`）；Target 可能是相对路径。 */
function sheetTargets(files: Record<string, Uint8Array>): Map<string, string> {
  const out = new Map<string, string>();
  const rels = partXml(files, "xl/_rels/workbook.xml.rels");
  if (!rels) return out;
  for (const rel of allByLocalName(rels, "Relationship")) {
    const id = rel.getAttribute("Id") ?? rel.getAttributeNS("*", "Id") ?? "";
    const target = rel.getAttribute("Target") ?? "";
    if (!id || !target) continue;
    // Target 形如 "worksheets/sheet1.xml"，相对 xl/；也可能以 /xl/ 开头。
    const norm = target.startsWith("/")
      ? target.slice(1)
      : `xl/${target.replace(/^\.\//, "")}`;
    out.set(id, norm);
  }
  return out;
}

/** 共享字符串表：`<si>` 的序号即单元格 `t="s"` 里 `<v>` 的值。 */
function sharedStrings(files: Record<string, Uint8Array>): string[] {
  const doc = partXml(files, "xl/sharedStrings.xml");
  if (!doc) return [];
  const root = doc.documentElement;
  if (!root) return [];
  return directChildren(root, "si").map((si) => runText(si));
}

/** 一个工作表的文本：行 `\n`、列 `\t`；空单元格保留位置（否则列会错位）。 */
function sheetText(sheet: Document, sst: string[]): string {
  const lines: string[] = [];
  for (const row of allByLocalName(sheet, "row")) {
    const cells = directChildren(row, "c");
    if (cells.length === 0) continue;
    const parts: string[] = [];
    for (const c of cells) {
      const t = c.getAttribute("t") ?? "";
      let value = "";
      if (t === "inlineStr") {
        const is = directChildren(c, "is")[0];
        value = is ? runText(is) : "";
      } else {
        const v = directChildren(c, "v")[0];
        const raw = v?.textContent ?? "";
        value = t === "s" ? (sst[Number(raw)] ?? "") : raw;
      }
      parts.push(value.replace(/[\t\n]+/g, " "));
    }
    // 丢掉行尾的空列，避免整行都是制表符
    while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    lines.push(parts.join("\t"));
  }
  return lines.join("\n");
}

function extractXlsx(input: ExtractInput): ExtractResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzip(input.bytes);
  } catch (e) {
    return classifyFailure(XLSX_ID, input, e);
  }
  try {
    const wb = partXml(files, "xl/workbook.xml");
    if (!wb) return fail(XLSX_ID, "unsupported", "zip 里没有 xl/workbook.xml（不是 xlsx）");

    const targets = sheetTargets(files);
    const sst = sharedStrings(files);
    const sheets = allByLocalName(wb, "sheet");

    const segments: ExtractedSegment[] = [];
    for (let i = 0; i < sheets.length; i++) {
      const sh = sheets[i];
      const name = sh.getAttribute("name") ?? `Sheet${i + 1}`;
      const rid = sh.getAttributeNS("*", "id") ?? "";
      const path = targets.get(rid) ?? `xl/worksheets/sheet${i + 1}.xml`;
      const sheet = partXml(files, path);
      if (!sheet) continue;
      const text = normalizeText(sheetText(sheet, sst));
      if (!text) continue;
      segments.push({ kind: "sheet", text, loc: `S${name}` });
    }
    return finish(XLSX_ID, segments);
  } catch (e) {
    return classifyFailure(XLSX_ID, input, e);
  }
}

// ---------------------------------------------------------------- pptx

const PPTX_ID = "ooxml.pptx@1";

/** 幻灯片 part 按**数字序**排（`slide10` 必须排在 `slide9` 之后，字典序会错）。 */
function slideParts(files: Record<string, Uint8Array>): { path: string; n: number }[] {
  const out: { path: string; n: number }[] = [];
  for (const path of Object.keys(files)) {
    const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(path);
    if (m) out.push({ path, n: Number(m[1]) });
  }
  return out.sort((a, b) => a.n - b.n);
}

/** 该形状是否为标题占位符（`<p:ph type="title">` 或 `ctrTitle`）。 */
function isTitleShape(sp: Element): boolean {
  for (const ph of allByLocalName(sp, "ph")) {
    const t = ph.getAttribute("type") ?? "";
    if (t === "title" || t === "ctrTitle") return true;
  }
  return false;
}

/** 形状文本：段落间 `\n`，段内 run 直接相连。 */
function shapeText(sp: Element): string {
  const paras = allByLocalName(sp, "p").map((p) => runText(p));
  return paras.join("\n");
}

function extractPptx(input: ExtractInput): ExtractResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzip(input.bytes);
  } catch (e) {
    return classifyFailure(PPTX_ID, input, e);
  }
  try {
    const parts = slideParts(files);
    if (parts.length === 0) {
      return fail(PPTX_ID, "unsupported", "zip 里没有 ppt/slides/slideN.xml（不是 pptx）");
    }
    const segments: ExtractedSegment[] = [];
    for (const { path, n } of parts) {
      const doc = partXml(files, path);
      if (!doc) continue;
      const loc = `slide ${n}`;
      const shapes = allByLocalName(doc, "sp");

      // 先出标题（契约 §15.2：pptx 标题占位符 → heading），再出正文。
      const titleText = shapes
        .filter(isTitleShape)
        .map((sp) => shapeText(sp))
        .join("\n");
      const title = normalizeText(titleText);
      if (title) segments.push({ kind: "heading", text: title, loc });

      const body = normalizeText(
        shapes
          .filter((sp) => !isTitleShape(sp))
          .map((sp) => shapeText(sp))
          .join("\n"),
      );
      if (body) segments.push({ kind: "slide", text: body, loc });
    }
    return finish(PPTX_ID, segments);
  } catch (e) {
    return classifyFailure(PPTX_ID, input, e);
  }
}

// ---------------------------------------------------------------- 导出

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** 同步实现包成契约要求的 async 形状（失败也走返回值，不抛）。 */
function asExtractor(
  id: string,
  mimes: string[],
  extensions: string[],
  run: (input: ExtractInput) => ExtractResult,
): Extractor {
  return {
    id,
    mimes,
    extensions,
    cost: "cpu", // 纯解析：不吃 GPU，故按 cpu 排队
    async extract(input: ExtractInput): Promise<ExtractResult> {
      try {
        return run(input);
      } catch (e) {
        // 兜底：任何漏网的异常都按 internal 返回，绝不让异常穿透（契约 §15.3-2）
        const msg = e instanceof Error ? e.message : String(e);
        return fail(id, "internal", msg);
      }
    },
  };
}

export const docxExtractor: Extractor = asExtractor(
  DOCX_ID,
  [DOCX_MIME, "application/vnd.ms-word.document.macroenabled.12"],
  [".docx", ".docm"],
  extractDocx,
);

export const xlsxExtractor: Extractor = asExtractor(
  XLSX_ID,
  [XLSX_MIME, "application/vnd.ms-excel.sheet.macroenabled.12"],
  [".xlsx", ".xlsm"],
  extractXlsx,
);

export const pptxExtractor: Extractor = asExtractor(
  PPTX_ID,
  [PPTX_MIME, "application/vnd.ms-powerpoint.presentation.macroenabled.12"],
  [".pptx", ".pptm"],
  extractPptx,
);

/** OOXML 一族（注册表按这个顺序登记，docx/xlsx/pptx 的 mime 互不重叠）。 */
export const OOXML_EXTRACTORS: readonly Extractor[] = [
  docxExtractor,
  xlsxExtractor,
  pptxExtractor,
];
