// OOXML 抽取器单测 —— 契约见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §15.6。
//
// 夹具策略（对 §15.6 的一处刻意偏离，理由写在下面）：
// §15.6 说夹具放 `fixtures/<format>/<sample>.<ext>`。这里改为**在测试内用 fflate 现场造最小 OOXML**：
//  - 仓库里不留二进制样张，评审者能直接读到"输入到底是什么"；
//  - 最小文档只含被测的那几个 part，回归时不会被无关内容干扰。
// 真样张（WPS/Office 导出的复杂文档）仍应作为**集成夹具**补，那属于 P1 后续，不在本单测范围。

import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { docxExtractor, pptxExtractor, xlsxExtractor } from "./ooxml";
import type { ExtractInput, ExtractResult } from "./types";

// ---------------------------------------------------------------- 夹具工具

function zip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(files)) entries[name] = strToU8(body);
  return zipSync(entries);
}

function input(bytes: Uint8Array, filename = "x"): ExtractInput {
  return { bytes, filename, mime: "", hash: "test-hash", deps: {} };
}

/** OLE 复合文档头 —— 加密的 OOXML（以及老式 .doc）长这样。 */
function oleBytes(): Uint8Array {
  const b = new Uint8Array(64);
  const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  magic.forEach((v, i) => (b[i] = v));
  return b;
}

/** 断言成功并取回结果（让后续断言不必反复判 ok）。 */
function expectOk(r: ExtractResult): Extract<ExtractResult, { ok: true }> {
  if (!r.ok) throw new Error(`期望成功，实际失败：${r.code} ${r.message}`);
  return r;
}

// ---------------------------------------------------------------- docx

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function docx(files: Record<string, string>): Uint8Array {
  return zip({ "[Content_Types].xml": "<Types/>", ...files });
}

const DOCX_BASIC = `<w:document ${W_NS}><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度总结</w:t></w:r></w:p>
  <w:p><w:r><w:t>第一段</w:t></w:r><w:r><w:t>（续）</w:t></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>差旅</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1200</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
</w:body></w:document>`;

describe("docx 抽取器", () => {
  it("正常样本：标题 → heading、正文 → text（跨 run 不插空格）、表格 → table", async () => {
    const r = expectOk(
      await docxExtractor.extract(input(docx({ "word/document.xml": DOCX_BASIC }))),
    );
    expect(r.extractor).toBe("ooxml.docx@1");
    expect(r.segments.map((s) => s.kind)).toEqual(["heading", "text", "table"]);
    expect(r.segments[0].text).toBe("季度总结");
    // 同一段落里的两个 run 必须拼在一起 —— OOXML 的 run 是样式切分，不是词切分
    expect(r.segments[1].text).toBe("第一段（续）");
    // 表格：单元格 \t 分隔、行 \n 分隔（契约 §15.3-3）
    expect(r.segments[2].text).toBe("项目\t金额\n差旅\t1200");
    // docx 没有页号 ⇒ loc 一律为空（文件头注释里写明了原因）
    expect(r.segments.every((s) => s.loc === "")).toBe(true);
  });

  it("outlineLvl 也算标题", async () => {
    const doc = `<w:document ${W_NS}><w:body>
      <w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>甲</w:t></w:r></w:p>
    </w:body></w:document>`;
    const r = expectOk(await docxExtractor.extract(input(docx({ "word/document.xml": doc }))));
    expect(r.segments[0].kind).toBe("heading");
  });

  it("空文档 → empty（不是 corrupt）", async () => {
    const doc = `<w:document ${W_NS}><w:body><w:p><w:r><w:t></w:t></w:r></w:p></w:body></w:document>`;
    const r = await docxExtractor.extract(input(docx({ "word/document.xml": doc })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("empty");
  });

  it("加密（OLE 头）→ encrypted", async () => {
    const r = await docxExtractor.extract(input(oleBytes(), "x.docx"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("encrypted");
  });

  it("不是 zip → unsupported（让调度器去换一个抽取器，而不是判文件坏了）", async () => {
    const r = await docxExtractor.extract(input(strToU8("这不是一个 zip")));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported");
  });

  it("是 zip 但没有 word/document.xml → unsupported（不是 corrupt）", async () => {
    const r = await docxExtractor.extract(input(zip({ "foo.txt": "x" })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported");
  });

  it("zip 损坏 → corrupt", async () => {
    // 有 zip 魔数、但内容不是合法 zip
    const broken = strToU8("PK\x03\x04 这不是合法的 zip 主体");
    const r = await docxExtractor.extract(input(broken));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("corrupt");
  });

  it("确定性：同一输入连抽两次，结果深度相等（契约 §15.3-5）", async () => {
    const bytes = docx({ "word/document.xml": DOCX_BASIC });
    const a = await docxExtractor.extract(input(bytes));
    const b = await docxExtractor.extract(input(bytes));
    expect(a).toStrictEqual(b);
  });
});

// ---------------------------------------------------------------- xlsx

const NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function xlsxFiles(): Record<string, string> {
  return {
    "xl/workbook.xml": `<workbook ${NS}><sheets>
        <sheet name="预算" sheetId="1" r:id="rId1"/>
      </sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
      </Relationships>`,
    "xl/sharedStrings.xml": `<sst ${NS}><si><t>差旅</t></si><si><t>住宿</t></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet ${NS}><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v>1200</v></c></row>
        <row r="2"><c r="A2" t="inlineStr"><is><t>合计</t></is></c><c r="B2"/><c r="C2"><v>3000</v></c></row>
      </sheetData></worksheet>`,
  };
}

describe("xlsx 抽取器", () => {
  it("按工作表出段：共享字符串 / 内联字符串 / 数字，loc = S<表名>", async () => {
    const r = expectOk(await xlsxExtractor.extract(input(zip(xlsxFiles()), "x.xlsx")));
    expect(r.extractor).toBe("ooxml.xlsx@1");
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].kind).toBe("sheet");
    expect(r.segments[0].loc).toBe("S预算");
    // 空单元格保留列位（B2 是空的 ⇒ 两个制表符），否则列会错位
    expect(r.segments[0].text).toBe("差旅\t住宿\t1200\n合计\t\t3000");
  });

  it("多工作表按 workbook.xml 的顺序出段", async () => {
    const files = xlsxFiles();
    files["xl/workbook.xml"] = `<workbook ${NS}><sheets>
        <sheet name="一" sheetId="1" r:id="rId2"/>
        <sheet name="二" sheetId="2" r:id="rId1"/>
      </sheets></workbook>`;
    files["xl/_rels/workbook.xml.rels"] = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/>
      </Relationships>`;
    files["xl/worksheets/sheet2.xml"] = `<worksheet ${NS}><sheetData>
        <row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>`;
    const r = expectOk(await xlsxExtractor.extract(input(zip(files), "x.xlsx")));
    expect(r.segments.map((s) => s.loc)).toEqual(["S一", "S二"]);
  });

  it("空表 → empty", async () => {
    const files = xlsxFiles();
    files["xl/worksheets/sheet1.xml"] = `<worksheet ${NS}><sheetData/></worksheet>`;
    const r = await xlsxExtractor.extract(input(zip(files), "x.xlsx"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("empty");
  });

  it("加密（OLE 头）→ encrypted", async () => {
    const r = await xlsxExtractor.extract(input(oleBytes(), "x.xlsx"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("encrypted");
  });

  it("缺 xl/workbook.xml → unsupported", async () => {
    const r = await xlsxExtractor.extract(input(zip({ "foo.txt": "x" })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported");
  });
});

// ---------------------------------------------------------------- pptx

const P_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

function slide(title: string, body: string[]): string {
  const bodyParas = body.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join("");
  return `<p:sld ${P_NS}><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:txBody>${bodyParas}</p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;
}

describe("pptx 抽取器", () => {
  it("标题占位符 → heading；其余 → slide；loc = 'slide N'", async () => {
    const bytes = zip({ "ppt/slides/slide1.xml": slide("季度回顾", ["要点一", "要点二"]) });
    const r = expectOk(await pptxExtractor.extract(input(bytes, "x.pptx")));
    expect(r.extractor).toBe("ooxml.pptx@1");
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]).toMatchObject({ kind: "heading", text: "季度回顾", loc: "slide 1" });
    expect(r.segments[1]).toMatchObject({ kind: "slide", text: "要点一\n要点二", loc: "slide 1" });
  });

  it("幻灯片按数字序排：slide10 必须在 slide9 之后（字典序会排错）", async () => {
    const bytes = zip({
      "ppt/slides/slide10.xml": slide("第十页", []),
      "ppt/slides/slide9.xml": slide("第九页", []),
    });
    const r = expectOk(await pptxExtractor.extract(input(bytes, "x.pptx")));
    expect(r.segments.map((s) => s.text)).toEqual(["第九页", "第十页"]);
  });

  it("只有正文、没有标题占位符时，不产出 heading 段", async () => {
    const bytes = zip({
      "ppt/slides/slide1.xml": `<p:sld ${P_NS}><p:cSld><p:spTree>
        <p:sp><p:txBody><a:p><a:r><a:t>就一段</a:t></a:r></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld></p:sld>`,
    });
    const r = expectOk(await pptxExtractor.extract(input(bytes, "x.pptx")));
    expect(r.segments.map((s) => s.kind)).toEqual(["slide"]);
  });

  it("空幻灯片 → empty", async () => {
    const bytes = zip({ "ppt/slides/slide1.xml": slide("", []) });
    const r = await pptxExtractor.extract(input(bytes, "x.pptx"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("empty");
  });

  it("加密（OLE 头）→ encrypted", async () => {
    const r = await pptxExtractor.extract(input(oleBytes(), "x.pptx"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("encrypted");
  });

  it("zip 里没有 slide → unsupported", async () => {
    const r = await pptxExtractor.extract(input(zip({ "foo.txt": "x" })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported");
  });

  it("确定性：同一输入连抽两次，结果深度相等", async () => {
    const bytes = zip({ "ppt/slides/slide1.xml": slide("甲", ["乙", "丙"]) });
    expect(await pptxExtractor.extract(input(bytes))).toStrictEqual(
      await pptxExtractor.extract(input(bytes)),
    );
  });
});

// ---------------------------------------------------------------- 通用契约

describe("契约不变量（跨三个抽取器）", () => {
  const cases: [string, typeof docxExtractor, Uint8Array][] = [
    ["docx", docxExtractor, docx({ "word/document.xml": DOCX_BASIC })],
    ["xlsx", xlsxExtractor, zip(xlsxFiles())],
    ["pptx", pptxExtractor, zip({ "ppt/slides/slide1.xml": slide("T", ["B"]) })],
  ];

  it("三者的 cost 都是 cpu（纯解析，不吃 GPU）", () => {
    for (const [, ex] of cases) expect(ex.cost).toBe("cpu");
  });

  it("id 都带版本号 `@n`（换实现才能整批重跑）", () => {
    for (const [, ex] of cases) expect(ex.id).toMatch(/^[a-z]+\.[a-z]+@\d+$/);
  });

  it("成功时 `extractor` 字段必须等于实现自己的 id", async () => {
    for (const [name, ex, bytes] of cases) {
      const r = expectOk(await ex.extract(input(bytes, `x.${name}`)));
      expect(r.extractor).toBe(ex.id);
    }
  });

  it("抽出的 text 不含任何标记（纯文本，无 <> 标签残留）", async () => {
    for (const [name, ex, bytes] of cases) {
      const r = expectOk(await ex.extract(input(bytes, `x.${name}`)));
      for (const s of r.segments) {
        expect(s.text).not.toMatch(/<[a-zA-Z/]/);
        // 已归一：**每行行尾无空白**。但**行首的制表符要保留** —— 那是表格的列位信息
        // （`normalizeText` 刻意只去首尾空行、不做全局 trim；见 ooxml.ts 里 columnIndex 的注释）。
        for (const line of s.text.split("\n")) {
          expect(line).toBe(line.replace(/[ \t]+$/, ""));
        }
      }
    }
  });

  it("失败一律走返回值，绝不抛异常（契约 §15.3-2）", async () => {
    const junk = strToU8("完全不是文档");
    for (const [, ex] of cases) {
      await expect(ex.extract(input(junk))).resolves.toMatchObject({ ok: false });
    }
  });
});
