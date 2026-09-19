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
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const outDir = resolve(process.argv[2] ?? "src-tauri/tests/fixtures/pdf");
mkdirSync(outDir, { recursive: true });

/** 用字节拼 PDF：手写 xref，偏移必须**字节精确**（这是手写 PDF 唯一真正容易错的地方）。 */
function buildPdf({ width, height, rotate = 0, content, extraObjects = {} }) {
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
    "/Resources << /Font << /F1 5 0 R >> /ExtGState << /GS1 6 0 R >> >>",
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
  pushObj(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
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
console.log("⚠️ 未覆盖（**不拿近似样本充数**）：");
console.log("   · 中文 —— 需要 CJK 字体嵌入或标准 CJK 字体名 + CMap，单独一步做；");
console.log("   · 扫描件 —— 需要在 PDF 里嵌一张图片流，单独一步做。");
process.exit(fail === 0 ? 0 : 1);
