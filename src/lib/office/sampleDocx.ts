// **判据管道的样本 docx**（Office 导入第一期 · 2026-10-09）。
//
// ## 为什么样本是"造"出来的，而且带**声明的真值**
// 评估文档 §3-⑤ 要求"保留率"必须**机器可判**：要么有样本集 ＋ 一条命令，要么那只是"文档说它对"✗。
// 于是这里现造一份**真 docx**（zip ＋ OOXML，Word 能打开），同时给出**声明的真值**
// （`truth`：这份文档里到底有几个标题/段落/列表项/图片/表格 ✓）。
// 判据管道拿真值当第二把尺子：
//   ① **XML 分母**（`docxToNoteBlocks` 自己数的 `source`）⇒ 任何 docx 都能算保留率（含真实样本 ✓）
//   ② **声明真值**（本节）⇒ 只对造出来的样本成立，用来钉住"数得对"（分母自己算错时也能抓到 ✓）
//
// ⚠️ 合成样本**只能验我想到的情况**（这一条抄自 `src/lib/extract/realSamples.test.ts` 的教训）⇒
//    判据管道同时支持 `OFFICE_SAMPLES=<dir>` 跑**真实 .docx** ✓（没配就如实说"没查过"，⛔ 不当通过 ✗）。
//
// ⛔ 仓库里**不留二进制样张**：样本在内存里现造 ✓（与 `src/lib/extract/fixtures.ts` 同一习惯 ✓）。

import { strToU8, zipSync } from "fflate";

import type { NoteBlockCounts } from "../extract/ooxml";

/** 1×1 透明 PNG（67 B）—— 真实图片字节，用来验"图片能被取出来且字节真的在" ✓。 */
const PNG_1X1: number[] = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
  0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a,
  0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

export function samplePng(): Uint8Array {
  return new Uint8Array(PNG_1X1);
}

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const WP_NS = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 段落里的元素（**顺序即文档顺序** —— 真值就是按它数出来的 ✓）。 */
export type SampleElement =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "emph"; bold?: string; italic?: string; strike?: string }
  | { t: "break" }
  | { t: "li"; numId: string; level: number; text: string }
  | { t: "img"; media: string }
  | { t: "table"; rows: string[][]; gridCols?: number };

/**
 * 段落 ⇒ XML。
 * ⚠️ `pPrInner` 会被**包进 `<w:pPr>`** —— 这是真 Word 的结构 ✓：
 * 我第一版把 `<w:pStyle>` / `<w:numPr>` 直接挂在 `<w:p>` 下，于是解析层（正确地）读不到
 * `pPr` 里的东西 ⇒ 标题全变段落、列表全变段落（判据当场抓住 ✓）。夹具错了就该改夹具 ✓。
 */
function para(inner: string, pPrInner = ""): string {
  return `<w:p>${pPrInner ? `<w:pPr>${pPrInner}</w:pPr>` : ""}${inner}</w:p>`;
}

function run(text: string, props = ""): string {
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function imageParagraph(rid: string): string {
  return para(
    `<w:r><w:drawing><wp:inline><a:graphic><a:graphicData><a:blip r:embed="${rid}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
  );
}

function tableXml(rows: string[][], gridCols?: number): string {
  const width = gridCols ?? Math.max(...rows.map((r) => r.length), 1);
  const grid = `<w:tblGrid>${Array(width).fill('<w:gridCol w:w="2000"/>').join("")}</w:tblGrid>`;
  const body = rows
    .map((cells) => {
      const tcs = cells
        .map((cell) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${para(run(cell))}</w:tc>`)
        .join("");
      return `<w:tr>${tcs}</w:tr>`;
    })
    .join("");
  return `<w:tbl><w:tblPr/>${grid}${body}</w:tbl>`;
}

/** 一个样本：字节能喂给转换器，`truth` 是**声明**的真值 ✓。 */
export interface OfficeSample {
  name: string;
  bytes: Uint8Array;
  truth: NoteBlockCounts;
  note: string;
}

function countTruth(els: SampleElement[]): NoteBlockCounts {
  const truth: NoteBlockCounts = { headings: 0, paragraphs: 0, listItems: 0, images: 0, tables: 0 };
  for (const el of els) {
    if (el.t === "h") truth.headings += 1;
    else if (el.t === "p" || el.t === "emph" || el.t === "break") truth.paragraphs += 1;
    else if (el.t === "li") truth.listItems += 1;
    else if (el.t === "img") truth.images += 1;
    else if (el.t === "table") truth.tables += 1;
  }
  return truth;
}

/**
 * 造一份**真 docx**。
 * media 里给 `媒体名 → 字节`（`SampleElement.img` 的 `rid` 会按 media 顺序映射到 `rId10+i` ✓）。
 * ⭐ 导出给判据用：边界情形（空段落、列数不齐的表）自己拼元素表即可 ✓。
 */
export function buildSampleDocx(els: SampleElement[]): Uint8Array {
  const numbering =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:numbering ${W_NS}>` +
    // abstractNum 0 ＝ 无序（bullet），abstractNum 1 ＝ 有序（decimal）
    `<w:abstractNum w:abstractNumId="0">` +
    `<w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>` +
    `<w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>` +
    `</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1">` +
    `<w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>` +
    `</w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
    `<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>` +
    `</w:numbering>`;

  const mediaEntries: Record<string, Uint8Array> = {};
  const relEntries: string[] = [
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`,
  ];
  let mediaIndex = 0;
  const body: string[] = [];

  for (const el of els) {
    switch (el.t) {
      case "h":
        body.push(para(run(el.text), `<w:pStyle w:val="Heading${el.level}"/>`));
        break;
      case "p":
        body.push(para(run(el.text)));
        break;
      case "emph":
        body.push(
          para(
            [
              el.bold !== undefined ? run(el.bold, "<w:b/>") : "",
              el.italic !== undefined ? run(el.italic, "<w:i/>") : "",
              el.strike !== undefined ? run(el.strike, "<w:strike/>") : "",
            ].join(""),
          ),
        );
        break;
      case "break":
        body.push(para(`<w:r><w:t>第一行</w:t><w:br/><w:t>第二行</w:t></w:r>`));
        break;
      case "li":
        body.push(
          para(
            run(el.text),
            `<w:numPr><w:ilvl w:val="${el.level}"/><w:numId w:val="${el.numId}"/></w:numPr>`,
          ),
        );
        break;
      case "img": {
        if (!mediaEntries[el.media]) {
          mediaIndex += 1;
          mediaEntries[el.media] = samplePng();
          relEntries.push(
            `<Relationship Id="rId${10 + mediaIndex}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${el.media}"/>`,
          );
        }
        // media 名 → rId：第 N 个媒体就是 rId(10+N)（newest-first 的 `mediaIndex` 与之一致 ✓）
        const rid = `rId${10 + Object.keys(mediaEntries).indexOf(el.media) + 1}`;
        body.push(imageParagraph(rid));
        break;
      }
      case "table":
        body.push(tableXml(el.rows, el.gridCols));
        break;
    }
  }

  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document ${W_NS} ${R_NS} ${A_NS} ${WP_NS}><w:body>${body.join("")}</w:body></w:document>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "word/document.xml": strToU8(document),
    "word/numbering.xml": strToU8(numbering),
    "word/_rels/document.xml.rels":
      strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relEntries.join("")}</Relationships>`,
      ),
  };
  for (const [name, bytes] of Object.entries(mediaEntries)) {
    files[`word/media/${name}`] = bytes;
  }
  return zipSync(files);
}

function sample(name: string, note: string, els: SampleElement[]): OfficeSample {
  return { name, note, bytes: buildSampleDocx(els), truth: countTruth(els) };
}

/** 三个"应当 100% 保留"的合成样本（小 / 五类齐全 / 大）。 */
export function officeSamples(): OfficeSample[] {
  const small = sample("小样本.docx", "最小可用：1 个标题 ＋ 1 段正文", [
    { t: "h", level: 1, text: "季度报告" },
    { t: "p", text: "正文一段。" },
  ]);

  const full = sample("五类齐全.docx", "标题/段落/列表/图片/表格五类都有（含嵌套列表与强调）", [
    { t: "h", level: 1, text: "2026 年第三季度总结" },
    { t: "p", text: "本季度整体达成目标。" },
    { t: "h", level: 2, text: "一、营收" },
    { t: "p", text: "营收同比增长 12%。" },
    { t: "emph", bold: "重点项目：", italic: "海外版", strike: "旧口径已作废" },
    { t: "li", numId: "1", level: 0, text: "华东区" },
    { t: "li", numId: "1", level: 1, text: "上海" },
    { t: "li", numId: "1", level: 1, text: "杭州" },
    { t: "h", level: 2, text: "二、排期" },
    { t: "li", numId: "2", level: 0, text: "需求冻结" },
    { t: "li", numId: "2", level: 0, text: "联调" },
    { t: "li", numId: "2", level: 0, text: "发布" },
    { t: "p", text: "下面两张表分别给数据和对照。" },
    {
      t: "table",
      rows: [
        ["区域", "营收", "同比"],
        ["华东", "1,200", "+12%"],
        ["华南", "900", "+8%"],
      ],
    },
    { t: "img", media: "image1.png" },
    {
      t: "table",
      rows: [
        ["指标", "目标"],
        ["留存", "30%"],
      ],
    },
    { t: "img", media: "image1.png" },
    { t: "p", text: "段内换行：" },
    { t: "break" },
  ]);

  const bigEls: SampleElement[] = [{ t: "h", level: 1, text: "大样本：200 段正文" }];
  for (let i = 1; i <= 200; i++) bigEls.push({ t: "p", text: `第 ${i} 段正文，用来量耗时。` });
  for (let i = 1; i <= 20; i++) bigEls.push({ t: "li", numId: "2", level: 0, text: `清单第 ${i} 项` });
  bigEls.push({
    t: "table",
    rows: [
      ["列一", "列二"],
      ["甲", "乙"],
    ],
  });
  const big = sample("大样本.docx", "200 段 ＋ 20 列表项 ＋ 1 表（量耗时）", bigEls);

  return [small, full, big];
}

/** 一个"应当**可读失败**"的坏样本（转不成功不算异常，必须有 code ＋ 人话 ✓）。 */
export interface BrokenSample {
  name: string;
  bytes: Uint8Array;
  /** 期望的失败码（给不准的地方留空 ⇒ 判据只要求"可读失败" ✓）。 */
  expectCode?: string;
  note: string;
}

/** 坏样本：判据要"看过它红" ✓（⛔ 静默出空笔记即失败 ✗）。 */
export function brokenSamples(): BrokenSample[] {
  const random = new Uint8Array(512);
  for (let i = 0; i < random.length; i++) random[i] = (i * 37 + 11) & 0xff;

  const ole = new Uint8Array(64);
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].forEach((b, i) => (ole[i] = b));

  const zipWithoutDoc = zipSync({ "foo.txt": strToU8("这不是 docx") });

  const emptyBody = zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    ),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document ${W_NS}><w:body></w:body></w:document>`),
  });

  const brokenXml = zipSync({
    "word/document.xml": strToU8("<w:document><w:body><w:p>没闭合"),
  });

  const full = officeSamples()[1];
  const truncated = full.bytes.slice(0, Math.floor(full.bytes.length / 2));

  return [
    { name: "空字节.docx", bytes: new Uint8Array(0), expectCode: "empty", note: "0 字节" },
    { name: "随机字节.docx", bytes: random, expectCode: "not_zip", note: "根本不是 zip" },
    {
      name: "旧格式.doc",
      bytes: ole,
      expectCode: "legacy_or_encrypted",
      note: "OLE 复合文档头（旧 .doc / 加密的 .docx）",
    },
    {
      name: "zip-但没有-document.xml.docx",
      bytes: zipWithoutDoc,
      expectCode: "no_document",
      note: "是 zip，但不是 docx",
    },
    {
      name: "正文为空的.docx",
      bytes: emptyBody,
      expectCode: "empty_body",
      note: "⭐ 最要命的一种：结构合法但没内容 ⇒ 必须可读失败，⛔ 不许静默出空笔记",
    },
    { name: "XML-没闭合.docx", bytes: brokenXml, expectCode: "corrupt", note: "document.xml 不是合法 XML" },
    { name: "截断一半.docx", bytes: truncated, note: "字节被截断（期望码不写死：可能 corrupt、也可能 no_document）" },
  ];
}
