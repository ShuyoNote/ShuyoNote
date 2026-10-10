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

/**
 * 拼接一个段落/单元格里的文本，**按文档顺序**处理段内元素。
 *
 * 为什么不能简单地"取所有 `<w:t>` 拼起来"（那是我第一版的做法，**对真实文档是错的**）：
 *  - `<w:br/>`（段内换行）与 `<w:tab/>`（段内制表）**没有文本内容**，
 *    只取 `w:t` 会把它们整段丢掉 ⇒ **两行被黏成一行、对齐文本丢列位**。真实文档里极常见。
 *  - `<w:delText>`（修订模式下**已删除**的文字）与 `<w:instrText>`（域代码，如 `PAGE \* MERGEFORMAT`）
 *    **都不是正文**。第一版是因为它们的 localName 恰好不叫 `t` 才没被抽到——那是**偶然正确**；
 *    这里改成显式排除，免得以后有人改了匹配方式就悄悄把它们抽进来。
 *  - ⚠️ 必须跳过**属性块**（`w:pPr` / `w:rPr` / …）：`<w:pPr><w:tabs><w:tab w:pos="720"/></w:tabs></w:pPr>`
 *    是**制表位定义**、不是制表符。若一路下钻，它们会被当成 `\t` 灌进正文（改这一版时差点踩到的坑）。
 */
function runText(el: Element): string {
  let out = "";
  const visit = (node: Element): void => {
    for (const child of Array.from(node.children)) {
      switch (child.localName) {
        // 属性块：整块跳过（里面的 w:tab 是制表位定义，不是制表符）
        case "pPr":
        case "rPr":
        case "tblPr":
        case "trPr":
        case "tcPr":
        case "sectPr":
          break;
        case "t":
          out += child.textContent ?? "";
          break;
        case "br":
        case "cr":
          out += "\n";
          break;
        case "tab":
          out += "\t";
          break;
        case "noBreakHyphen":
          out += "-";
          break;
        case "softHyphen":
          break;
        // 显式排除：修订删除的文字与域代码都不是正文
        case "delText":
        case "delInstrText":
        case "instrText":
          break;
        default:
          visit(child);
      }
    }
  };
  visit(el);
  return out;
}

/** 段文本归一：CRLF→LF、去行尾空白、压掉连续空行。**不做 trim 以外的改写**（保确定性）。 */
function normalizeText(s: string): string {
  const lines = s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""));
  // 去掉**首尾空行**，而不是 `trim()` 整个字符串：
  // 全局 trim 会吃掉行首的制表符，而那是"这个值属于第 N 列"的列位信息（见 `columnIndex`）。
  // 更糟的是它**只影响第一行**，于是"首行丢列位、后续行不丢"——同一份表里两套口径。
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
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

    // 脚注 / 尾注：它们在**独立 part**，正文里只有 `<w:footnoteReference w:id="N"/>` 这样的引用。
    // 制度文件里脚注常是真内容（引用依据、补充说明），只读 document.xml 会把它整块丢掉。
    // 这里按 part 顺序追加，`loc` 带上"脚注 N"以便回看时对得上。
    for (const [part, label] of [
      ["word/footnotes.xml", "脚注"],
      ["word/endnotes.xml", "尾注"],
    ] as const) {
      const notes = partXml(files, part);
      if (!notes) continue;
      for (const note of allByLocalName(notes, part.includes("foot") ? "footnote" : "endnote")) {
        const id = note.getAttributeNS("*", "id") ?? note.getAttribute("w:id") ?? "";
        // id 0 / -1 是**分隔符与延续分隔符**（Word 的内部标记），不是内容
        if (id === "0" || id === "-1" || id === "") continue;
        const text = normalizeText(
          allByLocalName(note, "p")
            .map((p) => runText(p))
            .filter((s) => s.length > 0)
            .join("\n"),
        );
        if (text) segments.push({ kind: "text", text, loc: `${label} ${id}` });
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
/**
 * 单元格引用 → 0 基列号：`"C1"` → `2`、`"AA3"` → `26`。无法解析返回 `null`（回退到顺序）。
 *
 * 为什么需要它：**Excel 会省略空单元格**。若 A1/B1 为空而 C1 有值，XML 里就是
 * `<row r="1"><c r="C1">…</c></row>` —— 按顺序塞会把 C 列的值放到第 0 列、**整行左移**，
 * "这个值属于哪一列"就丢了。（我第一版的夹具每列都写满，**恰好测不出这一条**。）
 */
function columnIndex(ref: string): number | null {
  const m = /^([A-Za-z]+)\d*$/.exec(String(ref ?? ""));
  if (!m) return null;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetText(sheet: Document, sst: string[]): string {
  const lines: string[] = [];
  for (const row of allByLocalName(sheet, "row")) {
    const cells = directChildren(row, "c");
    if (cells.length === 0) continue;
    const parts: string[] = [];
    let seq = 0;
    for (const c of cells) {
      const t = c.getAttribute("t") ?? "";
      let value = "";
      if (t === "inlineStr") {
        const is = directChildren(c, "is")[0];
        value = is ? runText(is) : "";
      } else {
        const v = directChildren(c, "v")[0];
        const raw = v?.textContent ?? "";
        // t="s" 共享字符串表下标 | t="b" 布尔（Excel 显示 TRUE/FALSE，不是 1/0）
        // t="str" 公式的字符串结果 | t="e" 错误值（#DIV/0! 之类，原样保留才是事实）
        value =
          t === "s" ? (sst[Number(raw)] ?? "") : t === "b" ? (raw === "1" ? "TRUE" : "FALSE") : raw;
      }
      // 按 `r` 补位（稀疏单元格）；拿不到 `r` 就退回顺序，别让整行错位
      const idx = columnIndex(c.getAttribute("r") ?? "") ?? seq;
      while (parts.length < idx) parts.push("");
      parts[idx] = value.replace(/[\t\n]+/g, " ");
      seq = idx + 1;
    }
    // 丢掉**行尾**空列；行首/行中的空列**保留**（那是列位信息）
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

/**
 * **表格**文本（`<p:graphicFrame><a:tbl>`）——单元格 `\t`、行 `\n`（与 docx 表格同一口径）。
 *
 * 为什么必须单独处理：幻灯片里的表格**不是 `<p:sp>`**，它是 `<p:graphicFrame>` 里的 `<a:tbl>`。
 * 只取 `p:sp` 会把整张表**静默丢掉**（不报错、只是内容少了）——这正是"真实文档 vs 合成夹具"的典型缺口。
 */
function graphicFrameText(fr: Element): string {
  const rows: string[] = [];
  for (const tr of allByLocalName(fr, "tr")) {
    const cells: string[] = [];
    for (const tc of allByLocalName(tr, "tc")) {
      const t = allByLocalName(tc, "p")
        .map((p) => runText(p))
        .filter((s) => s.length > 0)
        .join(" ");
      cells.push(t.replace(/[\t\n]+/g, " "));
    }
    rows.push(cells.join("\t"));
  }
  return rows.join("\n");
}

/**
 * 演讲者备注 part 的路径 → 它属于第几张幻灯片。
 *
 * 为什么不能按编号猜：`notesSlideN.xml` 的 N **与幻灯片的 N 不是同一个编号**，
 * 二者靠关系文件（`ppt/notesSlides/_rels/notesSlideN.xml.rels` → `../slides/slideM.xml`）关联。
 * 按编号猜会把备注贴到错的幻灯片上——那比不抽更糟（回链会指错）。
 */
function notesBySlide(files: Record<string, Uint8Array>): Map<number, string> {
  const out = new Map<number, string>();
  for (const path of Object.keys(files)) {
    const m = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/.exec(path);
    if (!m) continue;
    const rels = partXml(files, `ppt/notesSlides/_rels/notesSlide${m[1]}.xml.rels`);
    if (!rels) continue;
    let slideN: number | null = null;
    for (const rel of allByLocalName(rels, "Relationship")) {
      const target = rel.getAttribute("Target") ?? "";
      const tm = /slides\/slide(\d+)\.xml$/.exec(target);
      if (tm) {
        slideN = Number(tm[1]);
        break;
      }
    }
    if (slideN === null) continue;
    const doc = partXml(files, path);
    if (!doc) continue;
    const text = normalizeText(
      allByLocalName(doc, "sp")
        .map((sp) => shapeText(sp))
        .join("\n"),
    );
    if (text) out.set(slideN, text);
  }
  return out;
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
    const notes = notesBySlide(files);
    const segments: ExtractedSegment[] = [];
    for (const { path, n } of parts) {
      const doc = partXml(files, path);
      if (!doc) continue;
      const loc = `slide ${n}`;
      const shapes = allByLocalName(doc, "sp");
      const frames = allByLocalName(doc, "graphicFrame");

      // 先出标题（契约 §15.2：pptx 标题占位符 → heading），再出正文（形状 + 表格）。
      const titleText = shapes
        .filter(isTitleShape)
        .map((sp) => shapeText(sp))
        .join("\n");
      const title = normalizeText(titleText);
      if (title) segments.push({ kind: "heading", text: title, loc });

      const bodyParts = [
        ...shapes.filter((sp) => !isTitleShape(sp)).map((sp) => shapeText(sp)),
        ...frames.map((fr) => graphicFrameText(fr)),
      ];
      const body = normalizeText(bodyParts.join("\n"));
      if (body) segments.push({ kind: "slide", text: body, loc });

      // 演讲者备注：**独立成段**（它不是幻灯片"页面"上的内容，混进 body 会污染版面语义）。
      // loc 带上标记，便于回看时区分。
      const note = notes.get(n);
      if (note) segments.push({ kind: "text", text: note, loc: `${loc} 备注` });
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

// ============================================================================
// 块结构（Office 导入第一期 · 2026-10-09）
// ----------------------------------------------------------------------------
// ## 与上面「带定位的段」的分工（**为什么这里是加法而不是第二份解析**）
//  - **段**（`ExtractedSegment`，本文件上半部分）＝ 喂 **RAG / 派生表**的扁平纯文本：
//    表格拍平成 `\t` / `\n`、`loc` 带定位（docx 一律 `''`）。**一个字都没改** ✓。
//  - **块**（`NoteBlock`，本节）＝ 喂 **「导入为笔记」**的结构：标题层级、列表（有序/无序 ＋ 层级）、
//    表格行列、**图片字节**。落库形态由 `src/lib/office/` 决定（Markdown → 现有 md 导入管线）。
//  ⇒ 两者**共用同一套** zip / XML / 文本 helper（`unzip` / `partXml` / `allByLocalName` /
//    `directChildren` / `runText` / `normalizeText` / `startsWithZip` / `startsWithOle` ✓）——
//    **只有一个地方知道 docx 容器怎么读** ✓；差别只在"读出来交给谁"。
//
// ## 为什么不是 Kreuzberg（实测，留读数）
//  `kreuzberg 4.10.4` 的 `ExtractionResult`（registry 副本 `src/ocr/types.rs:165-170`）＝
//  `{ content: String, mime_type, metadata, tables: Vec<Table> }` ⇒ 它给**文本 ＋ 表格 markdown**，
//  ⛔ **给不了标题层级 / 列表 / 图片**；而本仓 `extract_kz.rs` 只回传 `content` ✓。
//
// ## 已知并接受的边界（写出来，免得被当成 bug）
//  - **合并单元格**（`w:gridSpan` / `w:vMerge`）按普通单元格展开，列数按 `w:tblGrid` 对齐（并给 warning ✓）。
//  - **段内换行**（`w:br`）在块里保留为 `\n`；导入后可能被渲染成两行（md 的软换行口径 ✓）。
//  - **超链接**第一期**不转链接**（`w:hyperlink` 的文字照常取，URL 丢掉）—— 如实记在缺口里 ✓。
//  - 文本框里的字（`w:drawing` 下的 `a:t`）**会**被当正文（与上面 `runText` 同口径 ✓）。

/** 一张从 `word/media/` 里取出来的图（字节原样，⛔ 不在这里落盘／不在这里算 hash）。 */
export interface DocxImage {
  /** 附件名：取自 media 里的文件名（如 `image1.png`）。 */
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** 「导入为笔记」要的块。（键顺序即文档顺序 ✓） */
export type NoteBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; level: number; marker: string; text: string }
  | { kind: "table"; rows: string[][] }
  | { kind: "image"; image: DocxImage };

/** 五类块的计数（判据管道的分子/分母都用它 ✓）。 */
export interface NoteBlockCounts {
  headings: number;
  paragraphs: number;
  listItems: number;
  images: number;
  tables: number;
}

export interface DocxNoteBlocksOk {
  ok: true;
  blocks: NoteBlock[];
  /** 去重后的图片（按 media 目标去重 ⇒ 同一张图被引用两次只给一份字节 ✓）。 */
  images: DocxImage[];
  /** **源文档里数到的**（分母：数 XML 元素，不依赖任何"应当转出多少"的猜测 ✓）。 */
  source: NoteBlockCounts;
  /** **转成块之后数到的**（分子）。 */
  converted: NoteBlockCounts;
  warnings: string[];
}

/** ⛔ 失败一律**可读**：带 code ＋ 一句人话（判据要求"看过它红"，不许静默出空笔记 ✗）。 */
export interface DocxNoteBlocksFail {
  ok: false;
  code:
    | "empty"
    | "not_zip"
    | "legacy_or_encrypted"
    | "corrupt"
    | "no_document"
    | "empty_body"
    | "images_without_bytes";
  message: string;
}

export type DocxNoteBlocksResult = DocxNoteBlocksOk | DocxNoteBlocksFail;

/**
 * 取属性值：**不依赖前缀**（生产者可能写 `w:val`、`ns0:val`；属性大小写敏感 ✓）。
 *
 * ⚠️⚠️ **2026-10-09 实测（第一期踩到的第一个坑）**：happy-dom（本仓 vitest 的环境）解析 XML 时，
 * **带前缀的属性**（`w:val` / `r:embed` / `w:numId`）其 `localName` **不等于** `val` / `embed`
 * —— 它给的是带前缀的整名。只比 `localName === name` ⇒ **所有属性都读成空串**：
 * 标题全变段落、列表全变段落、图片一张都取不到（实测 `source` 数出 15 段 / 0 标题 / 0 图片，
 * 而真值是 6 标题 0 …），而**元素名**（`w:p` / `w:tbl`）却正常 ⇒ 症状很有迷惑性 ✓。
 * ⇒ 三种写法都比：`localName`、限定名 `name`、以及"冒号后半段"（`w:val` ⇒ `val`）。
 *   比 `getAttributeNS("*", name)` 稳（那个在 happy-dom 上不可靠，本文件上半段已记过同类问题 ✓）。
 */
function attrOf(el: Element | undefined | null, name: string): string {
  if (!el) return "";
  for (const a of Array.from(el.attributes)) {
    const local = a.localName ?? "";
    if (local === name || a.name === name) return a.value;
    if (local.endsWith(`:${name}`) || a.name.endsWith(`:${name}`)) return a.value;
  }
  return "";
}

type ListKind = "ordered" | "bullet";

/**
 * `word/numbering.xml` ⇒ `numId → (ilvl → 有序/无序)`。
 * 没有这个文件时返回空表 ⇒ 调用方按"无序"兜底（比丢掉整个列表好 ✓）。
 */
function numberingMap(
  files: Record<string, Uint8Array>,
): Map<string, Map<number, ListKind>> {
  const out = new Map<string, Map<number, ListKind>>();
  const doc = partXml(files, "word/numbering.xml");
  if (!doc) return out;
  const abstracts = new Map<string, Map<number, ListKind>>();
  for (const an of allByLocalName(doc, "abstractNum")) {
    // `w:abstractNumId w:val="N"`（也可能写成属性 `w:abstractNumId="N"`）
    const id = attrOf(directChildren(an, "abstractNumId")[0], "val") || attrOf(an, "abstractNumId");
    if (!id) continue;
    const levels = new Map<number, ListKind>();
    for (const lvl of directChildren(an, "lvl")) {
      const ilvl = Number(attrOf(lvl, "ilvl") || "0");
      const fmt = attrOf(directChildren(lvl, "numFmt")[0], "val");
      // `bullet` / `none` / 没写 ⇒ 无序；其余（decimal / lowerLetter / roman / chineseCounting…）⇒ 有序
      levels.set(ilvl, fmt === "" || fmt === "bullet" || fmt === "none" ? "bullet" : "ordered");
    }
    abstracts.set(id, levels);
  }
  for (const num of allByLocalName(doc, "num")) {
    const numId = attrOf(num, "numId");
    const abstractId = attrOf(directChildren(num, "abstractNumId")[0], "val");
    const levels = abstracts.get(abstractId);
    if (numId && levels) out.set(numId, levels);
  }
  return out;
}

/** `word/_rels/document.xml.rels` ⇒ `rId → zip 内路径`（外链给空串 ⇒ 当"取不到字节"如实计 ✓）。 */
function docxRels(files: Record<string, Uint8Array>): Map<string, string> {
  const out = new Map<string, string>();
  const doc = partXml(files, "word/_rels/document.xml.rels");
  if (!doc) return out;
  for (const rel of allByLocalName(doc, "Relationship")) {
    const id = attrOf(rel, "Id");
    const target = attrOf(rel, "Target");
    if (!id || !target) continue;
    const external = /^[a-z][a-z0-9+.-]*:/i.test(target); // http: / file: / mailto: …
    out.set(id, external ? "" : `word/${target.replace(/^\.\//, "")}`);
  }
  return out;
}

function imageMimeOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  const table: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".emf": "image/emf",
    ".wmf": "image/wmf",
    ".svg": "image/svg+xml",
  };
  return table[ext] ?? "application/octet-stream";
}

/** 一个 run 的强调属性（`w:b` / `w:i` / `w:strike`；`w:val="0"` 是**显式关闭** ✗ 不算 ✓）。 */
interface RunStyle {
  bold: boolean;
  italic: boolean;
  strike: boolean;
}

const NO_STYLE: RunStyle = { bold: false, italic: false, strike: false };

function runStyleOf(run: Element): RunStyle {
  const rPr = directChildren(run, "rPr")[0];
  if (!rPr) return NO_STYLE;
  const on = (name: string): boolean => {
    const el = directChildren(rPr, name)[0];
    if (!el) return false;
    const v = attrOf(el, "val");
    return !(v === "0" || v === "false" || v === "none" || v === "off");
  };
  return {
    bold: on("b") || on("bCs"),
    italic: on("i") || on("iCs"),
    strike: on("strike") || on("dstrike"),
  };
}

/** 段落里取到的全部图片引用 id（`a:blip/@r:embed`、VML `v:imagedata/@r:id`／`@r:href`）。 */
function imageRidsIn(el: Element): string[] {
  const out: string[] = [];
  const visit = (node: Element): void => {
    for (const child of Array.from(node.children)) {
      if (child.localName === "blip" || child.localName === "imagedata") {
        const rid = attrOf(child, "embed") || attrOf(child, "id") || attrOf(child, "href");
        if (rid && !out.includes(rid)) out.push(rid);
      }
      visit(child);
    }
  };
  visit(el);
  return out;
}

interface TextFrag {
  text: string;
  style: RunStyle;
}

/** 段落里的文字碎片（带强调）＋ 图片引用（**文档顺序**）。 */
function paragraphParts(
  p: Element,
): { frags: TextFrag[]; rids: string[] } {
  const frags: TextFrag[] = [];
  const rids: string[] = [];
  const visit = (node: Element, style: RunStyle): void => {
    for (const child of Array.from(node.children)) {
      switch (child.localName) {
        // 属性块：整块跳过（与 `runText` 同口径：里面的 `w:tab` 是制表位定义 ✓）
        case "pPr":
        case "rPr":
        case "tblPr":
        case "trPr":
        case "tcPr":
        case "sectPr":
        case "tbl":
          break;
        case "r": {
          const s = runStyleOf(child);
          visit(child, {
            bold: style.bold || s.bold,
            italic: style.italic || s.italic,
            strike: style.strike || s.strike,
          });
          break;
        }
        case "t":
          frags.push({ text: child.textContent ?? "", style });
          break;
        case "br":
        case "cr":
          frags.push({ text: "\n", style });
          break;
        case "tab":
          frags.push({ text: "\t", style });
          break;
        case "noBreakHyphen":
          frags.push({ text: "-", style });
          break;
        // 修订删除的文字 / 域代码 / 软连字符：都不是正文（与 `runText` 同一份排除表 ✓）
        case "delText":
        case "delInstrText":
        case "instrText":
        case "softHyphen":
          break;
        case "drawing":
        case "pict": {
          for (const rid of imageRidsIn(child)) if (!rids.includes(rid)) rids.push(rid);
          // ⚠️ 继续下钻：文本框里的 `a:t` 也是正文（与 `runText` 同口径 ✓）
          visit(child, style);
          break;
        }
        default:
          visit(child, style);
      }
    }
  };
  visit(p, NO_STYLE);
  return { frags, rids };
}

/** 碎片合并（相邻同样式）＋ 加 markdown 强调标记。 */
function fragsToMarkdown(frags: TextFrag[]): string {
  const merged: TextFrag[] = [];
  for (const f of frags) {
    if (f.text === "") continue;
    const last = merged[merged.length - 1];
    if (
      last &&
      last.style.bold === f.style.bold &&
      last.style.italic === f.style.italic &&
      last.style.strike === f.style.strike
    ) {
      last.text += f.text;
    } else {
      merged.push({ text: f.text, style: { ...f.style } });
    }
  }
  return merged
    .map((f) => {
      // 只有空白／纯换行的碎片不加标记（否则 `**  **` 会被渲染器当成真强调 ✓）
      if (f.text.trim() === "") return f.text;
      let s = f.text;
      if (f.style.bold && f.style.italic) s = `***${s}***`;
      else if (f.style.bold) s = `**${s}**`;
      else if (f.style.italic) s = `*${s}*`;
      if (f.style.strike) s = `~~${s}~~`;
      return s;
    })
    .join("");
}

/** 标题层级：`Heading N` / `Title` / `outlineLvl`（0 基 ⇒ ＋1）。⛔ 不改上面 `docxHeadingLevel` ✗。 */
function noteHeadingLevel(p: Element): number | null {
  const pPr = directChildren(p, "pPr")[0];
  if (!pPr) return null;
  const style = attrOf(directChildren(pPr, "pStyle")[0], "val");
  const m = /^Heading\s*(\d+)$/i.exec(style);
  if (m) return Math.min(6, Math.max(1, Number(m[1])));
  if (/^Title$/i.test(style)) return 1;
  const outline = directChildren(pPr, "outlineLvl")[0];
  if (outline) return Math.min(6, Math.max(1, Number(attrOf(outline, "val") || "0") + 1));
  return null;
}

/** `w:numPr` ⇒ 这一段的列表层级与编号 id（`numId=0` ＝ 无编号 ⇒ null ✓）。 */
function noteListInfo(p: Element): { level: number; numId: string } | null {
  const pPr = directChildren(p, "pPr")[0];
  const numPr = pPr ? directChildren(pPr, "numPr")[0] : undefined;
  if (!numPr) return null;
  const numId = attrOf(directChildren(numPr, "numId")[0], "val");
  if (!numId || numId === "0") return null;
  const level = Number(attrOf(directChildren(numPr, "ilvl")[0], "val") || "0");
  return { level: Math.max(0, level), numId };
}

/** 表格 ⇒ 行列（列数按 `w:tblGrid` 对齐；合并单元格给 warning 并如实展开 ✓）。 */
function noteTableRows(tbl: Element, warnings: string[]): string[][] {
  const grid = directChildren(tbl, "tblGrid")[0];
  const gridCols = grid ? directChildren(grid, "gridCol").length : 0;
  const rows: string[][] = [];
  let merged = false;
  const collectRows = (container: Element): void => {
    for (const tr of directChildren(container, "tr")) {
      const cells: string[] = [];
      for (const tc of directChildren(tr, "tc")) {
        const tcPr = directChildren(tc, "tcPr")[0];
        if (tcPr && (directChildren(tcPr, "gridSpan").length > 0 || directChildren(tcPr, "vMerge").length > 0)) {
          merged = true;
        }
        const text = allByLocalName(tc, "p")
          .map((p) => normalizeText(runText(p)).replace(/\s+/g, " ").trim())
          .filter((s) => s.length > 0)
          .join(" ");
        cells.push(text);
      }
      rows.push(cells);
    }
  };
  collectRows(tbl);
  const width = Math.max(gridCols, ...rows.map((r) => r.length), 0);
  for (const r of rows) {
    if (r.length > width) {
      // 比 grid 还宽 ⇒ 说明有跨列表格没声明：按最宽的对齐，并如实记
      merged = true;
      continue;
    }
    while (r.length < width) r.push("");
  }
  if (merged) {
    warnings.push("表格里有合并单元格（gridSpan / vMerge）：按普通单元格展开，列数按 tblGrid 对齐");
  }
  return rows;
}

/** 源里的 `w:p` 属于哪一类（分母的算法：**只看 XML 事实**，不看转换结果 ✓）。 */
function sourceKindOf(p: Element): { kind: keyof NoteBlockCounts; level?: number; numId?: string } {
  const list = noteListInfo(p);
  if (list) return { kind: "listItems", level: list.level, numId: list.numId };
  const heading = noteHeadingLevel(p);
  if (heading !== null) return { kind: "headings", level: heading };
  return { kind: "paragraphs" };
}

/**
 * **docx ⇒ 块结构**（Office 导入第一期的入口）。
 *
 * 契约：**绝不抛** ⇒ 一切失败都是 `{ ok: false, code, message }`（可读 ✗ 不许静默空笔记 ✓）。
 */
export function docxToNoteBlocks(bytes: Uint8Array): DocxNoteBlocksResult {
  if (bytes.length === 0) {
    return { ok: false, code: "empty", message: "文件是空的（0 字节）⇒ 拒绝转换（⛔ 不生成空笔记）" };
  }
  if (startsWithOle(bytes)) {
    return {
      ok: false,
      code: "legacy_or_encrypted",
      message:
        "这是 OLE 复合文档：**旧式 .doc** 或**加密**的 .docx ⇒ 第一期只认未加密的 .docx；请先用 Word/WPS「另存为 .docx」再导入",
    };
  }
  if (!startsWithZip(bytes)) {
    return {
      ok: false,
      code: "not_zip",
      message: "不是 zip 容器（.docx 本身就是一个 zip）⇒ 这不是 .docx（扩展名被改过？）",
    };
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzip(bytes);
  } catch (e) {
    return {
      ok: false,
      code: "corrupt",
      message: `压缩包损坏或无法解压：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (files["EncryptionInfo"] || files["EncryptedPackage"]) {
    return {
      ok: false,
      code: "legacy_or_encrypted",
      message: "这是**加密**的 Office 容器（EncryptionInfo / EncryptedPackage）⇒ 第一期不处理受保护文档",
    };
  }

  let doc: Document | null;
  try {
    doc = partXml(files, "word/document.xml");
  } catch (e) {
    return {
      ok: false,
      code: "corrupt",
      message: `word/document.xml 不是合法 XML：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!doc) {
    return {
      ok: false,
      code: "no_document",
      message: "zip 里没有 word/document.xml ⇒ 这不是 .docx（可能只是个改了后缀的 .zip）",
    };
  }
  const body = allByLocalName(doc, "body")[0];
  if (!body) {
    return { ok: false, code: "corrupt", message: "word/document.xml 里没有 w:body ⇒ 结构不完整" };
  }

  const warnings: string[] = [];
  const rels = docxRels(files);
  const numbering = numberingMap(files);
  const source: NoteBlockCounts = { headings: 0, paragraphs: 0, listItems: 0, images: 0, tables: 0 };
  const blocks: NoteBlock[] = [];
  const imageByRid = new Map<string, DocxImage | null>();
  const imageObjects = new Set<DocxImage>();
  const listCounters = new Map<string, number>();
  let missingImageRefs = 0;

  const imageOf = (rid: string): DocxImage | null => {
    if (imageByRid.has(rid)) return imageByRid.get(rid) ?? null;
    const target = rels.get(rid);
    const raw = target ? files[target] : undefined;
    const img: DocxImage | null = raw
      ? { name: target!.split("/").pop() || "image", mime: imageMimeOf(target!), bytes: raw }
      : null;
    imageByRid.set(rid, img);
    if (!img) missingImageRefs += 1;
    return img;
  };

  const emitParagraph = (p: Element): void => {
    const { frags, rids } = paragraphParts(p);
    const text = fragsToMarkdown(frags);
    const hasText = text.trim().length > 0;
    const src = sourceKindOf(p);
    // ⚠️ 分母只数**有内容的**那一段：空段落（Word 里用来占行距）不是"要保留的东西" ✓
    //    （数进去会让真文档的保留率凭空变低 —— 那是**指标**的错，不是转换的错 ✗）
    if (hasText) {
      source[src.kind] += 1;
      if (src.kind === "listItems") {
        const kind = numbering.get(src.numId ?? "")?.get(src.level ?? 0) ?? "bullet";
        let marker = "-";
        if (kind === "ordered") {
          const key = `${src.numId}:${src.level}`;
          const n = (listCounters.get(key) ?? 0) + 1;
          listCounters.set(key, n);
          marker = `${n}.`;
        }
        blocks.push({ kind: "list", ordered: kind === "ordered", level: src.level ?? 0, marker, text });
      } else if (src.kind === "headings") {
        blocks.push({ kind: "heading", level: src.level ?? 1, text });
      } else {
        blocks.push({ kind: "paragraph", text });
      }
    }
    // 图片：每一个引用都进 `source.images`（分母），取不到字节就**只少图、不静默** ✓
    for (const rid of rids) {
      source.images += 1;
      const img = imageOf(rid);
      if (img) {
        imageObjects.add(img);
        blocks.push({ kind: "image", image: img });
      }
    }
  };

  const walkBody = (container: Element): void => {
    for (const child of Array.from(container.children)) {
      if (child.localName === "p") {
        emitParagraph(child);
      } else if (child.localName === "tbl") {
        source.tables += 1;
        const rows = noteTableRows(child, warnings);
        if (rows.length > 0) blocks.push({ kind: "table", rows });
      } else if (child.localName === "sdt") {
        // 内容控件（`w:sdt`）：正文裹在 `w:sdtContent` 里 ⇒ 递进一层（⛔ 不丢内容 ✗）
        const content = allByLocalName(child, "sdtContent")[0];
        if (content) walkBody(content);
      }
    }
  };
  walkBody(body);

  const converted: NoteBlockCounts = {
    headings: blocks.filter((b) => b.kind === "heading").length,
    paragraphs: blocks.filter((b) => b.kind === "paragraph").length,
    listItems: blocks.filter((b) => b.kind === "list").length,
    images: blocks.filter((b) => b.kind === "image").length,
    tables: blocks.filter((b) => b.kind === "table").length,
  };
  if (missingImageRefs > 0) {
    warnings.push(
      `${missingImageRefs} 处图片引用在 zip 里取不到字节（word/media 缺失或引的是外链）⇒ 如实少图，⛔ 没有补空`,
    );
  }

  if (blocks.length === 0) {
    if (source.images > 0) {
      return {
        ok: false,
        code: "images_without_bytes",
        message: `正文只有 ${source.images} 处图片引用、取不到图片字节，也没有文字 ⇒ 不生成空笔记`,
      };
    }
    return {
      ok: false,
      code: "empty_body",
      message:
        "正文里没有任何可转换的内容（0 块）⇒ 不生成空笔记（可能是空文档／正文只在页眉页脚／文本框／批注里）",
    };
  }

  return { ok: true, blocks, images: [...imageObjects], source, converted, warnings };
}
