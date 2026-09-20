// 生成 PDFium↔MuPDF 对拍用的**最小 PDF 样本**，并**用 pdfjs 当场校验**（不是"看着像 PDF"）。
//
// 用法：node tmp/fixture/make-pdf-fixtures.mjs [输出目录]
//   默认输出：src-tauri/tests/fixtures/pdf/（方案 §0.2-H：少量、小体积，入库）
//
// 为什么自写 PDF 字节而不是引第三方库：它们是**测试夹具**，引依赖等于给夹具加供应链
// （施工单 §4）。而"写对了没有"这件事**用仓库里已有的 pdfjs-dist 4.8.69 当校验器**——
// 它能告诉我们：页数、每页经旋转后的视口尺寸、以及会不会抛异常。
//
// 故意**不造假样本**：中文（要 CJK 字体嵌入或标准 CJK 字体名，他日单列）与
// 扫描件（要嵌图片流）**没有实现**，脚本会在末尾如实列出"未覆盖"，而不是拿近似样本充数。
//
// ★ 2026-09-20：上面那句的**括号部分做掉了一半** —— 现在实现了两类：
//   · `scan.pdf`：**扫描件**形态（嵌一张未压缩的图像 XObject，页面内容只有一条 `Do`）；
//   · `cjk.pdf`：**中文**（Type0 + 预定义 CMap `UniGB-UCS2-H` + 标准 CJK 字体名 `/STSong-Light`）。
// ⚠️ 两类**验的东西不同**，别混（对拍测试按文件名分类，见 `pdf_engine_compare.rs`）：
//   · 扫描件 → **硬判据**（同一张图、同一条 CTM ⇒ 两个引擎应当逐像素一致或极接近）；
//   · 中文 → **只报不判**（没有嵌入字体，两个引擎各自替换字体 ⇒ 字形本就不同，
//     "逐像素等价"这件事**在这个样本上不可能成立**，把它判红等于判一件做不到的事）。
//     它回答的是另一个问题：**两个引擎都能开、都画出了东西、尺寸一致**（"能显示但不对"的第一道筛）。
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const outDir = resolve(process.argv[2] ?? "src-tauri/tests/fixtures/pdf");
mkdirSync(outDir, { recursive: true });

/** 用字节拼 PDF：手写 xref，偏移必须**字节精确**（这是手写 PDF 唯一真正容易错的地方）。 */
function buildPdf({ width, height, rotate = 0, content, extraObjects = {}, extraResources = "", fontObject, imageResource }) {
  const parts = [];
  const offsets = [0];
  let len = 0;
  const push = (buf) => {
    parts.push(buf);
    len += buf.length;
  };
  const pushObj = (num, body) => {
    offsets[num] = len;
    push(Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, "latin1"));
  };

  push(Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1"));

  const kids = "3 0 R";
  const pageDict = [
    "<< /Type /Page /Parent 2 0 R",
    `/MediaBox [0 0 ${width} ${height}]`,
    rotate ? `/Rotate ${rotate}` : "",
    `/Resources << /Font << /F1 5 0 R >> /ExtGState << /GS1 6 0 R >>${
      imageResource ? ` /XObject << /Im0 ${imageResource} 0 R >>` : ""
    }${extraResources ? ` ${extraResources}` : ""} >>`,
    "/Contents 4 0 R >>",
  ]
    .filter(Boolean)
    .join(" ");

  pushObj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  pushObj(2, `<< /Type /Pages /Kids [${kids}] /Count 1 >>`);
  pushObj(3, pageDict);
  const stream = Buffer.from(content, "latin1");
  offsets[4] = len;
  push(Buffer.from(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n`, "latin1"));
  push(stream);
  push(Buffer.from("\nendstream\nendobj\n", "latin1"));
  pushObj(5, fontObject ?? "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pushObj(6, "<< /Type /ExtGState /ca 0.5 /CA 0.5 >>");
  for (const [num, body] of Object.entries(extraObjects)) pushObj(Number(num), body);

  const xrefStart = len;
  const count = Math.max(...Object.keys(offsets).map(Number)) + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) {
    xref += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  push(Buffer.from(xref, "latin1"));
  push(Buffer.from(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

/**
 * 造一张**块状**的未压缩 RGB 图（不是渐变、不是噪声）。
 * 为什么块状：对拍要的是"两个引擎画同一张图"，而**插值算法**是它们的自由 ——
 * 块状图在块内部处处相同 ⇒ 插值差异只可能出现在块边界（且只要 CTM 对齐到设备像素，
 * 边界也不会被重采样）。渐变/噪声会把"插值差异"放大成大面积超阈，掩盖真正的回归。
 */
function blockyImage(size) {
  const px = Buffer.alloc(size * size * 3);
  const blocks = 8;
  const step = size / blocks;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const bx = Math.floor(x / step);
      const by = Math.floor(y / step);
      const i = (y * size + x) * 3;
      px[i] = (bx * 255) / (blocks - 1);
      px[i + 1] = (by * 255) / (blocks - 1);
      px[i + 2] = bx === by ? 0 : 200;
    }
  }
  return px;
}


const TEXT = "BT /F1 24 Tf 72 700 Td (PDFium vs MuPDF - fixture) Tj ET\n";

const samples = [
  {
    file: "text.pdf",
    why: "基线：矢量文本 + 实心矩形",
    bytes: buildPdf({ width: 612, height: 792, content: `${TEXT}0 0 1 rg 72 600 200 100 re f\n` }),
    expect: { pages: 1, w: 612, h: 792 },
  },
  {
    file: "rotate90.pdf",
    why: "旋转页：viewport 应按 /Rotate 交换宽高（两引擎历史上最易错的一处）",
    bytes: buildPdf({
      width: 612,
      height: 792,
      rotate: 90,
      content: `${TEXT}1 0 0 rg 72 600 200 100 re f\n`,
    }),
    expect: { pages: 1, w: 792, h: 612 }, // ← pdfjs 会把旋转算进 viewport
  },
  {
    file: "alpha.pdf",
    why: "透明底：暗色主题下最容易「能显示但不对」",
    bytes: buildPdf({
      width: 400,
      height: 300,
      content: `0 0 1 rg 0 0 400 300 re f\n/GS1 gs\n1 0 0 rg 50 50 200 200 re f\n`,
    }),
    expect: { pages: 1, w: 400, h: 300 },
  },
  {
    file: "a0-large.pdf",
    why: "超大页（A0 2384×3370 pt）：触发 MAX_PAGE_PIXELS 与内存路径",
    bytes: buildPdf({
      width: 2384,
      height: 3370,
      content: `${TEXT}0.5 0.5 0.5 rg 100 100 1000 1000 re f\n`,
    }),
    expect: { pages: 1, w: 2384, h: 3370 },
  },
  {
    // ★ 2026-09-20 新增：**扫描件形态**（页面内容只有一条图像 `Do`，没有字形 ⇒ 没有抗锯齿差异）。
    // 图像 96×96 画进 64×64 pt 的框、框的右下角落在 (72,564)：
    // 前端对拍用 `SCALE=1.5` ⇒ 设备像素正好 96×96 **1:1**（偏移 108,846 都是整数）
    // ⇒ 不给两个引擎留"重采样"的自由，硬判据验的才是"图像流有没有画对"。
    file: "scan.pdf",
    why: "扫描件形态：图像 XObject（未压缩 RGB，1:1 到设备像素）+ 一条 Do",
    bytes: buildPdf({
      width: 612,
      height: 792,
      content: "q 64 0 0 64 72 564 cm /Im0 Do Q\n",
      imageResource: 7,
      extraObjects: {
        7: `<< /Type /XObject /Subtype /Image /Width 96 /Height 96 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${
          blockyImage(96).length
        } >>\nstream\n${blockyImage(96).toString("latin1")}\nendstream`,
      },
    }),
    expect: { pages: 1, w: 612, h: 792 },
  },
  {
    // ★ 2026-09-20 新增：**中文**（Type0 + 预定义 CMap `UniGB-UCS2-H` + 标准 CJK 字体名 `STSong-Light`）。
    // ⚠️ 没有嵌入字体 ⇒ 两个引擎各自做字体替换 ⇒ **字形不可能逐像素一致**（对拍里这一类**只报不判**，
    // 见 `pdf_engine_compare.rs` 的分类注释）。它验的是"都能开、都画了东西、尺寸一致"。
    file: "cjk.pdf",
    why: "中文：Type0/CID + UniGB-UCS2-H + 标准 CJK 字体名（**只报不判**，字形靠替换）",
    bytes: buildPdf({
      width: 612,
      height: 792,
      // `<4E2D 6587 6D4B 8BD5>` = "中文测试"（UTF-16BE hex string）
      content: "BT /F1 24 Tf 72 700 Td <4E2D65876D4B8BD5> Tj ET\n0 0 1 rg 72 600 200 60 re f\n",
      fontObject:
        "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [8 0 R] >>",
      extraObjects: {
        8: "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 9 0 R /DW 1000 >>",
        9: "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>",
      },
    }),
    expect: { pages: 1, w: 612, h: 792 },
  },
];

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
let pass = 0;
let fail = 0;

for (const s of samples) {
  const path = join(outDir, s.file);
  writeFileSync(path, s.bytes);
  try {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(s.bytes), disableWorker: true }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const ok =
      doc.numPages === s.expect.pages &&
      Math.round(vp.width) === s.expect.w &&
      Math.round(vp.height) === s.expect.h;
    console.log(
      `${ok ? "✅" : "❌"} ${s.file.padEnd(16)} ${s.bytes.length} B  pages=${doc.numPages} ` +
        `viewport=${Math.round(vp.width)}×${Math.round(vp.height)}（期望 ${s.expect.w}×${s.expect.h}）  — ${s.why}`,
    );
    ok ? pass++ : fail++;
  } catch (e) {
    console.log(`❌ ${s.file.padEnd(16)} 解析失败：${e?.message ?? e}`);
    fail++;
  }
}

console.log(`\n自校验：PASS=${pass} FAIL=${fail}（校验器 = 仓库自带的 pdfjs-dist 4.8.69，Node 里跑）`);
console.log("⚠️ 仍未覆盖（**不拿近似样本充数**）：旋转+扫描件叠加、加密 PDF、多页/多字体混排。");
console.log("   · 中文（cjk.pdf）用的是**标准 CJK 字体名 + 预定义 CMap**，没有嵌入字体 ⇒ 字形靠引擎替换，");
console.log("     所以对拍里它归**只报不判**那一类（逐像素等价在这个样本上本来就做不到）。");
process.exit(fail === 0 ? 0 : 1);
