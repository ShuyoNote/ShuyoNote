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

import type { ExtractDeps, ExtractErrorCode, SegmentKind } from "./types";

/** 造一个 zip 夹具（OOXML 是 zip + XML；这样仓库里不必留二进制样张）。 */
export function zipOf(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(files)) entries[name] = strToU8(body);
  return zipSync(entries);
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

  // ===== 待实现（`planned`）：先立期望，实现一落地就自动开始跑 =====
  {
    id: "pdf/文本层",
    pins: "一页一段、`loc = p.<n>`；**页序必须稳定**（回链靠它）",
    extractor: "pdf.text@1",
    filename: "制度.pdf",
    mime: "application/pdf",
    make: () => new Uint8Array(0),
    expect: { ok: true, kinds: ["text"], contains: [], locs: ["p.1"] },
    planned: true,
  },
  {
    id: "pdf/扫描件（无文本层）",
    pins: "文本层抽不出来 ⇒ `empty`（**不是失败**），好让调度器自然落到 `pdf.ocr`",
    extractor: "pdf.text@1",
    filename: "扫描件.pdf",
    mime: "application/pdf",
    make: () => new Uint8Array(0),
    expect: { ok: false, code: "empty" },
    planned: true,
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
];

/** 按目标抽取器分组（跑器与"是否还有 planned 未落地"检查都用它）。 */
export function fixturesFor(extractorId: string): ExtractFixture[] {
  return FIXTURES.filter((f) => f.extractor === extractorId);
}
