// 共用夹具集 —— 契约见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §15.6 / §12.5。
//
// **为什么需要它**：§12.3 把格式抽取器"分家"给三台机器并行做（Windows=OOXML、Mac=PDF+扫描件、
// AMD=图片+音视频）。分家的头号风险不是"谁写不出来"，而是**三套各自能跑、但结果不一致**——
// 比如同样的 docx，一边把表格拼成 `\t`、另一边拼成空格；一边的 `loc` 是 `p.12`、另一边是 `12`。
// 这类漂移**不会有任何编译期报错**，只会让检索层拿到两种形状的数据。
//
// 所以：**同一批样张 → 同一组期望**，三份实现都跑这一套。本文件是那套期望的**单一事实源**。
//
// 两条刻意的断言口径（都是为了让夹具"抓得住真问题、又不会因无关细节变红"）：
//  1. **断言 kind 序列 + 关键子串，而不是逐字符文本**。逐字符会让"多一个空格"这种无关差异变红，
//     最后大家学会"红了就改夹具"——那时夹具就废了。
//  2. **断言 loc 序列（给了就严格比）**。定位是回链的命根子，属于"必须一致"的那一类。

import { strToU8, zipSync } from "fflate";

import { depsOf, fakeRasterize, fakeVision } from "./testing/fakeDeps";
import type { ExtractDeps, ExtractErrorCode, SegmentKind } from "./types";

/** 造一个 zip 夹具（OOXML 是 zip + XML；这样仓库里不必留二进制样张）。 */
export function zipOf(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(files)) entries[name] = strToU8(body);
  return zipSync(entries);
}

/**
 * 造一个最小 PDF 夹具（一页），同样不在仓库里留二进制样张。
 *
 * `withText: false` 造的是**只有图形、没有任何文本算子**的页 —— 也就是"扫描件"在结构上的等价物
 * （文字被画成像素，没有可抽的文本层）。这正是 PDF 这一轴最要紧的分支：`pdf.text` 抽不到时
 * **必须**返回 `empty`（而不是 `corrupt` 或抛异常），调度器才会按候选列表去试 `pdf.ocr`。
 *
 * 交叉引用表按规范写全（偏移量真算），所以它是**合法 PDF**，不是"靠解析器容错才过"的假样本。
 */
/** 一页的内容流：`text` 为空就只画一个方块（模拟"这一页是图，没有文本层"）。 */
function pdfPageContent(text: string, graphics = false): string {
  const escaped = text.replace(/[()\\]/g, (c) => `\\${c}`);
  const draw = text.length > 0 ? `BT /F1 24 Tf 20 100 Td (${escaped}) Tj ET\n` : "";
  return (graphics ? `0 0 1 rg 20 20 100 100 re f\n` : "") + draw;
}

/**
 * 造一个 N 页的 PDF（同样不用二进制样张）。
 *
 * 为什么要多页：`pdf.text` 的定位是 `p.<n>`，而**回链全靠页序**——
 * "一页一段、页码从 1 起、顺序与文档一致"这条只有多页夹具能钉住（单页夹具永远看不出顺序问题）。
 * 每页可以带 `graphics: true` 来模拟"同一页里既有文字又有图"（仍应只出一段 `text`）。
 */
export function pdfPages(pages: readonly { text: string; graphics?: boolean }[]): Uint8Array {
  const contents = pages.map((p) => pdfPageContent(p.text, p.graphics));
  // 对象编号：1=Catalog，2=Pages，随后每页两个（Page + Contents），最后 1 个 Font。
  const fontId = 3 + pages.length * 2;
  const pageIds = pages.map((_, i) => 3 + i * 2);
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  ];
  pages.forEach((_, i) => {
    const pageId = 3 + i * 2;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${pageId + 1} 0 R ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
    const c = contents[i];
    objects.push(`<< /Length ${c.length} >>\nstream\n${c}endstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

export function pdfOf(text: string, opts: { withText?: boolean } = {}): Uint8Array {
  const withText = opts.withText ?? true;
  const content = withText
    ? `BT /F1 24 Tf 20 100 Td (${text.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET\n`
    : `0 0 1 rg 20 20 100 100 re f\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

export type FixtureExpectation =
  | {
      ok: true;
      /** 段类型序列（严格比）。 */
      kinds: readonly SegmentKind[];
      /** 必须出现在**某个段** text 里的关键子串（保底断言"内容真的抽到了"）。 */
      contains: readonly string[];
      /** 期望的 loc 序列（给了就严格比；不给表示"这个格式没有稳定定位"）。 */
      locs?: readonly string[];
    }
  | { ok: false; code: ExtractErrorCode };

export interface ExtractFixture {
  /** 夹具 id（出现在断言消息里，写成"格式/场景"）。 */
  id: string;
  /** 这个夹具在钉什么（一句话，将来别人改它时知道底线在哪）。 */
  pins: string;
  /** 目标抽取器 id（精确匹配）。 */
  extractor: string;
  filename: string;
  mime: string;
  /** 惰性构造字节：planned 夹具不必真造出来。 */
  make: () => Uint8Array;
  /** 注入给抽取器的依赖。**默认不给** ⇒ `cost:"gpu"` 的抽取器会走 `provider_error`，
   *  于是"默认不出网"这条底线在夹具层面也被钉住。要测 gpu 的成功路径就显式给 `vision`。 */
  deps?: ExtractDeps;
  expect: FixtureExpectation;
  /** true = 该抽取器**尚未实现**（夹具先立着，实现一落地就自动开始跑）。 */
  planned?: boolean;
}

// ---------------------------------------------------------------- 构造用的小片段

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const S_NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const P_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

const docxBody = (inner: string) => zipOf({ "word/document.xml": `<w:document ${W_NS}><w:body>${inner}</w:body></w:document>` });
const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

/** OLE 复合文档头 —— 加密的 OOXML（以及老式 .doc）长这样。 */
function oleBytes(): Uint8Array {
  const b = new Uint8Array(64);
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].forEach((v, i) => (b[i] = v));
  return b;
}

// ---------------------------------------------------------------- 夹具集

export const FIXTURES: readonly ExtractFixture[] = [
  // ===== OOXML（Windows 已实现；`bce2d31`）=====
  {
    id: "ooxml/docx-基本",
    pins: "标题→heading、正文→text；**跨 run 必须拼接而不插空格**（run 是样式切分，不是词切分）",
    extractor: "ooxml.docx@1",
    filename: "报告.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    make: () =>
      docxBody(
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度总结</w:t></w:r></w:p>` +
          `<w:p><w:r><w:t>第一段</w:t></w:r><w:r><w:t>（续）</w:t></w:r></w:p>`,
      ),
    expect: {
      ok: true,
      kinds: ["heading", "text"],
      contains: ["季度总结", "第一段（续）"],
      locs: ["", ""], // docx 无页号（见 ooxml.ts 头注释），故 loc 一律为空
    },
  },
  {
    id: "ooxml/docx-表格",
    pins: "表格单独成段；**单元格用 \\t、行用 \\n**（这条三份实现最容易各写各的）",
    extractor: "ooxml.docx@1",
    filename: "表.docx",
    mime: "",
    make: () =>
      docxBody(
        `<w:tbl><w:tr><w:tc>${p("项目")}</w:tc><w:tc>${p("金额")}</w:tc></w:tr>` +
          `<w:tr><w:tc>${p("差旅")}</w:tc><w:tc>${p("1200")}</w:tc></w:tr></w:tbl>`,
      ),
    expect: { ok: true, kinds: ["table"], contains: ["项目\t金额", "差旅\t1200"] },
  },
  {
    id: "ooxml/xlsx-多表",
    pins: "一表一段、`loc = S<表名>`；**空单元格要保留列位**（否则列错位）；按 workbook 顺序出段",
    extractor: "ooxml.xlsx@1",
    filename: "预算.xlsx",
    mime: "",
    make: () =>
      zipOf({
        "xl/workbook.xml": `<workbook ${S_NS}><sheets><sheet name="预算" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        "xl/sharedStrings.xml": `<sst ${S_NS}><si><t>差旅</t></si><si><t>住宿</t></si></sst>`,
        "xl/worksheets/sheet1.xml": `<worksheet ${S_NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>合计</t></is></c><c r="B2"/><c r="C2"><v>3000</v></c></row></sheetData></worksheet>`,
      }),
    expect: { ok: true, kinds: ["sheet"], contains: ["差旅\t住宿", "合计\t\t3000"], locs: ["S预算"] },
  },
  {
    id: "ooxml/xlsx-稀疏单元格",
    pins:
      "**Excel 会省略空单元格**（A/B 空、C 有值 ⇒ 只有 `<c r=\"C1\">`）。必须按 `r` 补位，" +
      "否则 C 列的值会跑到第 0 列、整行左移（第一版夹具每列都写满，**恰好测不出这条**）",
    extractor: "ooxml.xlsx@1",
    filename: "稀疏.xlsx",
    mime: "",
    make: () =>
      zipOf({
        "xl/workbook.xml": `<workbook ${S_NS}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        "xl/sharedStrings.xml": `<sst ${S_NS}><si><t>只有C列</t></si></sst>`,
        "xl/worksheets/sheet1.xml": `<worksheet ${S_NS}><sheetData><row r="1"><c r="C1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
      }),
    // 行首空列**保留**——那正是"这个值属于第 3 列"的信息
    expect: { ok: true, kinds: ["sheet"], contains: ["\t\t只有C列"] },
  },
  {
    id: "ooxml/xlsx-布尔单元格",
    pins: "`t=\"b\"` 的 1/0 在 Excel 里显示为 TRUE/FALSE —— 直接输出 1/0 是失真",
    extractor: "ooxml.xlsx@1",
    filename: "布尔.xlsx",
    mime: "",
    make: () =>
      zipOf({
        "xl/workbook.xml": `<workbook ${S_NS}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        "xl/worksheets/sheet1.xml": `<worksheet ${S_NS}><sheetData><row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c></row></sheetData></worksheet>`,
      }),
    expect: { ok: true, kinds: ["sheet"], contains: ["TRUE\tFALSE"] },
  },
  {
    id: "ooxml/pptx-段内换行",
    pins: "`<a:br/>` 与 docx 的 `<w:br/>` 同类：没有文本内容，不处理会把两行黏成一行",
    extractor: "ooxml.pptx@1",
    filename: "换行.pptx",
    mime: "",
    make: () =>
      zipOf({
        "ppt/slides/slide1.xml": `<p:sld ${P_NS}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>上</a:t><a:br/><a:t>下</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
      }),
    expect: { ok: true, kinds: ["slide"], contains: ["上\n下"] },
  },
  {
    id: "ooxml/pptx-表格",
    pins:
      "幻灯片里的**表格不是 `<p:sp>` 而是 `<p:graphicFrame><a:tbl>`** ⇒ 只取 `sp` 会把整张表**静默丢掉**" +
      "（不报错、只是内容少了）。单元格 `\\t`、行 `\\n`，与 docx 表格同一口径",
    extractor: "ooxml.pptx@1",
    filename: "表格.pptx",
    mime: "",
    make: () =>
      zipOf({
        "ppt/slides/slide1.xml":
          `<p:sld ${P_NS}><p:cSld><p:spTree>` +
          `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>` +
          `<a:tr><a:tc><a:txBody><a:p><a:r><a:t>项目</a:t></a:r></a:p></a:txBody></a:tc>` +
          `<a:tc><a:txBody><a:p><a:r><a:t>金额</a:t></a:r></a:p></a:txBody></a:tc></a:tr>` +
          `<a:tr><a:tc><a:txBody><a:p><a:r><a:t>差旅</a:t></a:r></a:p></a:txBody></a:tc>` +
          `<a:tc><a:txBody><a:p><a:r><a:t>1200</a:t></a:r></a:p></a:txBody></a:tc></a:tr>` +
          `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>` +
          `</p:spTree></p:cSld></p:sld>`,
      }),
    expect: { ok: true, kinds: ["slide"], contains: ["项目\t金额", "差旅\t1200"] },
  },
  {
    id: "ooxml/pptx-演讲者备注",
    pins:
      "备注在**独立 part** `ppt/notesSlides/notesSlideN.xml`，且 **N 与幻灯片编号不是同一个编号**" +
      "（靠 `_rels` 关联）⇒ 按编号猜会把备注贴到错的幻灯片、回链就指错了。这里断言它**独立成段**、" +
      "`loc` 带「备注」标记",
    extractor: "ooxml.pptx@1",
    filename: "备注.pptx",
    mime: "",
    make: () =>
      zipOf({
        "ppt/slides/slide1.xml": `<p:sld ${P_NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>季度回顾</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
        "ppt/notesSlides/notesSlide9.xml": `<p:notes ${P_NS}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>记得强调留存率</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
        // 关键：备注 9 属于 slide 1（编号故意不同，防止实现按编号猜）
        "ppt/notesSlides/_rels/notesSlide9.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="notesSlide" Target="../slides/slide1.xml"/></Relationships>`,
      }),
    expect: {
      ok: true,
      kinds: ["heading", "text"],
      contains: ["季度回顾", "记得强调留存率"],
      locs: ["slide 1", "slide 1 备注"],
    },
  },
  {
    id: "ooxml/pptx-标题与正文",
    pins: "标题占位符→heading、其余→slide；`loc = slide <n>`",
    extractor: "ooxml.pptx@1",
    filename: "汇报.pptx",
    mime: "",
    make: () =>
      zipOf({
        "ppt/slides/slide1.xml": `<p:sld ${P_NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>季度回顾</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>要点一</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
      }),
    expect: { ok: true, kinds: ["heading", "slide"], contains: ["季度回顾", "要点一"], locs: ["slide 1", "slide 1"] },
  },
  {
    id: "ooxml/加密",
    pins: "加密的 OOXML 是 OLE 复合文档 ⇒ **encrypted，不是 corrupt**（调度器据此决定不再换抽取器）",
    extractor: "ooxml.docx@1",
    filename: "加密.docx",
    mime: "",
    make: oleBytes,
    expect: { ok: false, code: "encrypted" },
  },
  {
    id: "ooxml/不是-zip",
    pins: "**unsupported ≠ corrupt**：不是 zip 就该让调度器去换一个抽取器",
    extractor: "ooxml.docx@1",
    filename: "x.docx",
    mime: "",
    make: () => strToU8("这不是一个 zip"),
    expect: { ok: false, code: "unsupported" },
  },
  {
    id: "ooxml/zip-但缺-part",
    pins: "是 zip 但没有 word/document.xml ⇒ **unsupported**（不是 corrupt）",
    extractor: "ooxml.docx@1",
    filename: "x.docx",
    mime: "",
    make: () => zipOf({ "foo.txt": "x" }),
    expect: { ok: false, code: "unsupported" },
  },
  {
    id: "ooxml/docx-段内换行与制表",
    pins:
      "`<w:br/>`→换行、`<w:tab/>`→制表符。**这两个没有文本内容**，只取 `w:t` 会整段丢掉 ⇒ " +
      "两行被黏成一行、对齐文本丢列位（真实文档里极常见）",
    extractor: "ooxml.docx@1",
    filename: "换行.docx",
    mime: "",
    make: () =>
      docxBody(
        `<w:p><w:r><w:t>第一行</w:t><w:br/><w:t>第二行</w:t></w:r>` +
          `<w:r><w:tab/><w:t>列2</w:t></w:r></w:p>`,
      ),
    expect: { ok: true, kinds: ["text"], contains: ["第一行\n第二行", "\t列2"] },
  },
  {
    id: "ooxml/docx-制表位定义不算制表符",
    pins:
      "`<w:pPr><w:tabs><w:tab w:pos=\"720\"/></w:tabs></w:pPr>` 是**制表位定义**、不是制表符。" +
      "遍历时若一路下钻属性块，会把一堆 `\\t` 灌进正文",
    extractor: "ooxml.docx@1",
    filename: "制表位.docx",
    mime: "",
    make: () =>
      docxBody(
        `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/><w:tab w:val="left" w:pos="1440"/></w:tabs></w:pPr>` +
          `<w:r><w:t>正文</w:t></w:r></w:p>`,
      ),
    expect: { ok: true, kinds: ["text"], contains: ["正文"] },
  },
  {
    id: "ooxml/docx-脚注与尾注",
    pins:
      "脚注/尾注在**独立 part**（`word/footnotes.xml` / `endnotes.xml`），正文里只有引用" +
      "（`<w:footnoteReference w:id=\"3\"/>`）⇒ 只读 `document.xml` 会把它们**整块丢掉**。" +
      "另：**id 0 / -1 是 Word 的分隔符标记，不是内容**，必须排除",
    extractor: "ooxml.docx@1",
    filename: "带脚注.docx",
    mime: "",
    make: () =>
      zipOf({
        "word/document.xml": `<w:document ${W_NS}><w:body><w:p><w:r><w:t>正文引用了脚注</w:t></w:r></w:p></w:body></w:document>`,
        "word/footnotes.xml": `<w:footnotes ${W_NS}>` +
          `<w:footnote w:id="-1"><w:p><w:r><w:t>分隔符</w:t></w:r></w:p></w:footnote>` +
          `<w:footnote w:id="0"><w:p><w:r><w:t>延续分隔符</w:t></w:r></w:p></w:footnote>` +
          `<w:footnote w:id="3"><w:p><w:r><w:t>依据：财会〔2026〕12 号</w:t></w:r></w:p></w:footnote>` +
          `</w:footnotes>`,
        "word/endnotes.xml": `<w:endnotes ${W_NS}>` +
          `<w:endnote w:id="2"><w:p><w:r><w:t>尾注：见附件三</w:t></w:r></w:p></w:endnote>` +
          `</w:endnotes>`,
      }),
    expect: {
      ok: true,
      kinds: ["text", "text", "text"],
      contains: ["正文引用了脚注", "依据：财会〔2026〕12 号", "尾注：见附件三"],
      locs: ["", "脚注 3", "尾注 2"],
    },
  },
  {
    id: "ooxml/docx-修订与域代码不入正文",
    pins:
      "`<w:delText>`（修订模式**已删除**的文字）与 `<w:instrText>`（域代码，如 `PAGE \\* MERGEFORMAT`）" +
      "都不是正文。第一版是**偶然**没抽到（localName 恰好不叫 `t`）；这条把它变成**显式**保证",
    extractor: "ooxml.docx@1",
    filename: "修订.docx",
    mime: "",
    make: () =>
      docxBody(
        `<w:p><w:r><w:t>保留的</w:t></w:r>` +
          `<w:del><w:r><w:delText>删掉的旧话</w:delText></w:r></w:del>` +
          `<w:r><w:instrText>PAGE \\* MERGEFORMAT</w:instrText><w:t>3</w:t></w:r></w:p>`,
      ),
    expect: { ok: true, kinds: ["text"], contains: ["保留的", "3"] },
  },

  // ===== 图片（Windows 已实现骨架 `image.ocr@1`；实跑调优归 AMD）=====
  {
    id: "image/没配视觉模型",
    pins: "**§15.3-7**：没有 deps.vision 必须立刻 provider_error，**不许自建网络**（默认不出网的底线）",
    extractor: "image.ocr@1",
    filename: "扫描件.png",
    mime: "image/png",
    make: () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    expect: { ok: false, code: "provider_error" },
  },

  // ===== PDF + 扫描件（Mac 侧轴；`pdf.text@1` 已落地，故不再标 planned） =====
  {
    id: "pdf/文本层",
    pins: "一页一段、`loc = p.<n>`；**页序必须稳定**（回链靠它）",
    extractor: "pdf.text@1",
    filename: "制度.pdf",
    mime: "application/pdf",
    // ⚠️ 样张用 **ASCII**：这是 Helvetica（Type1 简单字体）的最小 PDF，字串按单字节编码写进内容流，
    //    塞 UTF-8 的中文会被解析成乱码 —— 那不是抽取器的 bug，是**样张本身不合法**。
    //    中文（内嵌字体 + ToUnicode）走真实现场验证：见本仓 docs 里那条「真 PDF 复验」记录。
    make: () => pdfOf("Chapter One of the Rules"),
    expect: { ok: true, kinds: ["text"], contains: ["Chapter One"], locs: ["p.1"] },
  },
  {
    id: "pdf/扫描件（无文本层）",
    pins: "文本层抽不出来 ⇒ `empty`（**不是失败**），好让调度器自然落到 `pdf.ocr`",
    extractor: "pdf.text@1",
    filename: "扫描件.pdf",
    mime: "application/pdf",
    make: () => pdfOf("", { withText: false }),
    expect: { ok: false, code: "empty" },
  },
  {
    id: "pdf/不是 PDF（换了扩展名）",
    pins: "字节开头没有 `%PDF-` ⇒ `unsupported`，让调度器换别的抽取器（而不是报 corrupt 吓人）",
    extractor: "pdf.text@1",
    filename: "假装.pdf",
    mime: "application/pdf",
    make: () => new TextEncoder().encode("这不是 PDF，只是扩展名叫 .pdf\n"),
    expect: { ok: false, code: "unsupported" },
  },
  {
    id: "pdf/文本层里的括号与反斜杠",
    pins: "PDF 字符串转义（`\\(` `\\)` `\\\\`）不能把正文搞坏——夹具自带转义，抽取结果要还原成原文",
    extractor: "pdf.text@1",
    filename: "转义.pdf",
    mime: "application/pdf",
    // ⚠️ 断言只钉**转义那一小段**，不钉整串：这个最小 PDF 用 Helvetica 且**没有字体度量数据**
    //    （测试环境取不到 LiberationSans），pdf.js 在长串上会**截断**（实测："parens ( and ) he"）。
    //    那是**样张/测试环境**的限制，不是抽取器的问题——真 PDF（Chrome 生成、字体内嵌）抽得完整，
    //    见本轴的真实现场复验记录。这里要钉的是"\\\\( \\\\) 转义不会把正文搞坏"，前缀足够。
    make: () => pdfOf("parens ( and ) and backslash \\ here"),
    expect: { ok: true, kinds: ["text"], contains: ["parens ( and )"], locs: ["p.1"] },
  },
  {
    id: "pdf/扫描件走视觉通道（未注入依赖）",
    pins: "§15.3-7 的不变量：没有 deps.rasterize / deps.vision 就必须立刻 provider_error、**绝不自建渲染与网络**（与 image.ocr 同一条底线）",
    extractor: "pdf.ocr@1",
    filename: "扫描件.pdf",
    mime: "application/pdf",
    make: () => pdfOf("", { withText: false }),
    expect: { ok: false, code: "provider_error" },
  },
  {
    // 正向那条：A 方案（`rasterize` 直出**编码图**）落地后补上 —— 共用夹具是三台机器共用的口径，
    // 所以它用**共享假 deps**（`fakeRasterize` 产出合法 PNG、用生产同一个编码器；`fakeVision` 确定性返回）。
    // ⚠️ 这条钉的是**混合文档**（正文是文字、中间夹扫描页）：文字页出 `text`、扫描页出 `ocr`，
    //    页码各自正确、顺序不乱；而且**只有空页**被光栅化/调模型（`pdf.ocr` 自带文本层，
    //    对"正文是文字、插页是扫描"的文档白烧一遍 VLM 是数量级浪费）。
    id: "pdf/混合文档：文字页与扫描页各出对应的段",
    pins: "混合文档 ⇒ 文字页 `kind=text`、扫描页 `kind=ocr`，`loc` 各自正确（p.1 / p.2 / p.3），顺序与文档一致",
    extractor: "pdf.ocr@1",
    filename: "混排扫描.pdf",
    mime: "application/pdf",
    make: () => pdfPages([{ text: "First" }, { text: "", graphics: true }, { text: "Third" }]),
    deps: depsOf({ rasterize: fakeRasterize({ pages: 3 }), vision: fakeVision("扫描页认出来的字") }),
    expect: { ok: true, kinds: ["text", "ocr", "text"], contains: ["First", "Third", "扫描页认出来的字"], locs: ["p.1", "p.2", "p.3"] },
  },
  {
    id: "pdf/多页-页序",
    pins: "**页序**是回链的命根子：一页一段、`loc` 从 `p.1` 连到 `p.3`、顺序与文档一致（单页夹具看不出顺序问题）",
    extractor: "pdf.text@1",
    filename: "三页制度.pdf",
    mime: "application/pdf",
    make: () => pdfPages([{ text: "Chapter One" }, { text: "Chapter Two" }, { text: "Chapter Three" }]),
    expect: {
      ok: true,
      kinds: ["text", "text", "text"],
      contains: ["Chapter One", "Chapter Three"],
      locs: ["p.1", "p.2", "p.3"],
    },
  },
  {
    id: "pdf/中间页无文本（图+字混排）",
    pins: "中间那一页是图 ⇒ **只有两段**、`loc` 必须是 `p.1` 与 `p.3`（**跳号而不是顺移**，否则回链指错页）",
    extractor: "pdf.text@1",
    filename: "混排.pdf",
    mime: "application/pdf",
    make: () => pdfPages([{ text: "First" }, { text: "", graphics: true }, { text: "Third" }]),
    expect: { ok: true, kinds: ["text", "text"], contains: ["First", "Third"], locs: ["p.1", "p.3"] },
  },
  {
    // ⚠️ 样张刻意短：这个最小 PDF 没有字体度量数据（测试环境取不到 LiberationSans），
    //    pdf.js 的文本重建在长串上会**少末尾一两个字符**（实测："Caption and figure" → "Caption and figur"，
    //    且与 /Length 无关——delta=±2 都没变化）。那是**测试环境**的限制，真 PDF（Chrome 生成、字体内嵌）
    //    抽得完整。所以这里只断言短串本身，别把环境限制当成抽取器的行为。
    id: "pdf/一页里既有字又有一块图",
    pins: "图不影响文本层：同页文字仍**只出一段**（不要把一张图拆成第二段）",
    extractor: "pdf.text@1",
    filename: "图文.pdf",
    mime: "application/pdf",
    make: () => pdfPages([{ text: "Caption", graphics: true }]),
    expect: { ok: true, kinds: ["text"], contains: ["Caption"], locs: ["p.1"] },
  },
  {
    id: "pdf/整页只有空白（空白不算内容）",
    pins: "**空白不是内容**：文本层只有空格 ⇒ 必须报 `empty`，否则库里会塞进一堆空段，检索里全是噪声",
    extractor: "pdf.text@1",
    filename: "空白.pdf",
    mime: "application/pdf",
    make: () => pdfOf("   "),
    expect: { ok: false, code: "empty" },
  },
  {
    id: "pdf/五十页（页序与规模）",
    pins: "页数上来之后 `loc` 仍必须连续、顺序正确（p.1…p.50）——同时看着「页数与页码别有 off-by-one」",
    extractor: "pdf.text@1",
    filename: "五十页.pdf",
    mime: "application/pdf",
    make: () => pdfPages(Array.from({ length: 50 }, (_, i) => ({ text: `Page ${i + 1}` }))),
    expect: {
      ok: true,
      kinds: Array.from({ length: 50 }, () => "text" as const),
      contains: ["Page 1", "Page 50"],
      locs: Array.from({ length: 50 }, (_, i) => `p.${i + 1}`),
    },
  },
  {
    id: "image/有字",
    pins: "VLM 返回文字 ⇒ `kind: ocr`、`loc` 为空（单张图没有页/时间码的概念）",
    extractor: "image.ocr@1",
    filename: "发票.png",
    mime: "image/png",
    make: () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    // 显式注入 vision ⇒ 走成功路径（不给 deps 的那条由 "image/没配视觉模型" 覆盖）
    deps: { vision: async () => "发票号码 001" },
    expect: { ok: true, kinds: ["ocr"], contains: ["发票号码"], locs: [""] },
  },
  {
    id: "ooxml/xls-旧格式",
    pins: "旧 .xls 不是 OOXML（是 OLE），需要 LibreOffice headless 转换 —— 属另一族",
    extractor: "ooxml.legacy@1",
    filename: "旧表.xls",
    mime: "application/vnd.ms-excel",
    make: oleBytes,
    expect: { ok: true, kinds: ["sheet"], contains: [] },
    planned: true,
  },
  {
    id: "av/转写",
    pins: "音视频转写：`loc = HH:MM:SS`（时间码是这类内容唯一的定位）",
    extractor: "av.transcript@1",
    filename: "会议.mp4",
    mime: "video/mp4",
    make: () => new Uint8Array(0),
    expect: { ok: true, kinds: ["transcript"], contains: [], locs: ["00:00:00"] },
    planned: true,
  },

  // ===== 纯文本（Windows；**真样张跑器发现整目录 `.md` 全是 no_extractor** 之后补的）=====
  {
    id: "text/markdown-标题与段落",
    pins:
      "标题行**自己起一段**（真实 markdown 里标题后常无空行；只按空行切会把「标题+正文」合成一块、" +
      "整块标成 heading，正文的类型就丢了）；`loc` = `L<块首行号>`，行号是纯文本唯一稳定的定位",
    extractor: "text.plain@1",
    filename: "说明.md",
    mime: "text/markdown",
    make: () => strToU8("# 标题\n正文一\n\n## 二级\n正文二\n"),
    expect: {
      ok: true,
      kinds: ["heading", "text", "heading", "text"],
      contains: ["# 标题", "正文一", "## 二级", "正文二"],
      locs: ["L1", "L2", "L4", "L5"],
    },
  },
  {
    id: "text/csv",
    pins: "csv/tsv 也是纯文本，整篇一段即可（列语义不归抽取层管）",
    extractor: "text.plain@1",
    filename: "值班表.csv",
    mime: "text/csv",
    make: () => strToU8("姓名,班次\n张三,早班\n"),
    expect: { ok: true, kinds: ["text"], contains: ["姓名,班次", "张三,早班"], locs: ["L1"] },
  },
  {
    id: "text/空文件",
    pins: "空（或只有空白）⇒ `empty`，不是失败",
    extractor: "text.plain@1",
    filename: "空.txt",
    mime: "text/plain",
    make: () => strToU8("   \n\n  \n"),
    expect: { ok: false, code: "empty" },
  },
  {
    id: "text/含-NUL-的二进制",
    pins:
      "误命名成 `.txt` 的二进制（前 8KB 含 NUL）⇒ `unsupported`。" +
      "**绝不能抽成乱码**——那会把二进制噪声灌进检索索引，而且看不出是错的",
    extractor: "text.plain@1",
    filename: "其实是二进制.txt",
    mime: "text/plain",
    make: () => new Uint8Array([0x68, 0x69, 0x00, 0x01, 0x02, 0x03]),
    expect: { ok: false, code: "unsupported" },
  },

  // ===== HTML（Windows；与 text.plain 同一次真样张里发现的缺口）=====
  {
    id: "text/html-去脚本与块级分段",
    pins:
      "① `<script>/<style>` **必须清掉**——否则一整页 JS 会被当正文灌进索引（HTML 抽取最常见的脏数据）；" +
      "② 块级元素各起一段、`<h1>-<h6>` 标 `heading`、行内元素（`<a>/<b>`）**不单独成段**",
    extractor: "text.html@1",
    filename: "页面.html",
    mime: "text/html",
    make: () =>
      strToU8(
        "<html><head><title>不该出现</title><style>p{color:red}</style></head><body>" +
          "<h1>季度总结</h1>" +
          "<p>正文<b>加粗</b>继续</p>" +
          "<script>var x = '不该出现';</script>" +
          "<ul><li>要点一</li><li>要点二</li></ul>" +
          "</body></html>",
      ),
    expect: {
      ok: true,
      kinds: ["heading", "text", "text", "text"],
      contains: ["季度总结", "正文加粗继续", "要点一", "要点二"],
      locs: ["", "", "", ""],
    },
  },
  {
    id: "text/html-纯脚本页",
    pins: "解析后没内容（纯 JS 页 / 不是 HTML）⇒ `empty`，不是失败",
    extractor: "text.html@1",
    filename: "空壳.html",
    mime: "text/html",
    make: () => strToU8("<html><body><script>app()</script></body></html>"),
    expect: { ok: false, code: "empty" },
  },
];

/** 按目标抽取器分组（跑器与"是否还有 planned 未落地"检查都用它）。 */
export function fixturesFor(extractorId: string): ExtractFixture[] {
  return FIXTURES.filter((f) => f.extractor === extractorId);
}
