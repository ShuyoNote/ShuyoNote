// 软著登记用的**源代码文档**生成器（中国版权保护中心登记制）。
//
// 为什么要脚本：格式要求很死，手排一次错一次，而**补正一次就是几十个工作日**：
//   · 提交**前 30 页 + 后 30 页**（共 60 页）；
//   · **每页不少于 50 行**；
//   · **页眉标注软件全称 + 版本号**；
//   · **连续页码**。
// 所以这里把"排版"变成产物的一部分，并**自检页数/每页行数**——不满足就直接退出码非零，
// 而不是产出一份看起来没问题的文档。
//
// 用法：
//   node scripts/software-copyright-doc.mjs                 # 输出到 tmp/softcopyright/
//   node scripts/software-copyright-doc.mjs --out <目录>
//
// 材料清单 / 说明书草稿 / 登记流程见**私有仓库** `shuyonote-sync-server` 的 `docs/softcopyright/`
// ——软著属公司运作材料，2026-09-13 移出公开仓库。本脚本留在公开仓库，是因为它要读**本仓库的源码树**
// 来截取源代码文档；产物落在本站的 `tmp/softcopyright/`（gitignore）。
//
// 产物是**可打印的 HTML**（A4 纵向、每页一个 .page 块、print 时强制分页）：
// 用浏览器打开 → 打印 → 另存为 PDF，就是可提交的那份。之所以不直接生成 PDF：
// 不引入 PDF 库、也不依赖中文字体内嵌，交给浏览器排版最省事且分页确定。
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 软件全称（用户 2026-09-13 定的）。**必须与登记申请表、以及商店里的应用名一致或包含关系成立。** */
const SOFTWARE_NAME = "ShuyoNote 数友笔记";
/** 每页行数：要求是"不少于 50 行"，这里取 50（60 页正好 3000 行，不多不少）。 */
const LINES_PER_PAGE = 50;
/** 前后各取多少页。 */
const PAGES_PER_SIDE = 30;
/** 一行超过这个宽度就在打印时被裁掉——脚本会统计并报告有多少行受影响。 */
const MAX_COLS = 118;

const outArg = process.argv.indexOf("--out");
const OUT = outArg > -1 ? resolve(process.argv[outArg + 1]) : join(root, "tmp", "softcopyright");

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

// ---- 收集源码：顺序必须**确定**（同一版本两次产出同一份文档，便于核对）----
// Rust 内核在前（含入口 lib.rs/main.rs），前端在后；**不收录测试文件**——
// 提交的是程序本身的源码，测试文件会让审阅者分不清哪部分是产品代码。
function walk(dir, filter, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, filter, acc);
    else if (filter(name)) acc.push(p);
  }
  return acc;
}

const isTest = (n) => /\.test\.tsx?$/.test(n) || /_test\.rs$/.test(n);
const rustFiles = walk(join(root, "src-tauri", "src"), (n) => extname(n) === ".rs" && !isTest(n));
const tsFiles = walk(join(root, "src"), (n) => [".ts", ".tsx"].includes(extname(n)) && !isTest(n));

/** 入口文件排最前：审阅者通常从入口看起。 */
const entryFirst = (files, entries) =>
  [...files].sort((a, b) => {
    const ai = entries.findIndex((e) => a.endsWith(e));
    const bi = entries.findIndex((e) => b.endsWith(e));
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.localeCompare(b);
  });

const files = [
  ...entryFirst(rustFiles, ["lib.rs", "main.rs"]),
  ...entryFirst(tsFiles, ["main.tsx", "App.tsx", "index.ts"]),
];

// ---- 拼成带"文件分节"的行流 ----
// 每一行记成 { text, clipped }：裁行统计要**按最终提交的那 60 页**算，
// 按全文算出来的数字（1.2%）没有意义——审阅者看的是那 60 页。
const lines = [];
for (const f of files) {
  const rel = relative(root, f).split("\\").join("/");
  lines.push({ text: "// " + "=".repeat(76), clipped: false });
  lines.push({ text: "// 文件：" + rel, clipped: false });
  lines.push({ text: "// " + "=".repeat(76), clipped: false });
  for (const raw of readFileSync(f, "utf8").split(/\r?\n/)) {
    if (raw.length > MAX_COLS) {
      lines.push({ text: raw.slice(0, MAX_COLS - 1) + "»", clipped: true, full: raw.length });
    } else {
      lines.push({ text: raw, clipped: false });
    }
  }
  lines.push({ text: "", clipped: false });
}

// ---- 取前 30 页 + 后 30 页 ----
const perSide = LINES_PER_PAGE * PAGES_PER_SIDE;
const totalPagesAvailable = Math.floor(lines.length / LINES_PER_PAGE);
let selected;
let mode;
if (lines.length <= perSide * 2) {
  // 源码不足 60 页：整份提交，但要**明确说清**（不足 60 页时按实际页数提交是允许的）
  selected = lines.slice();
  mode = "full";
} else {
  selected = [...lines.slice(0, perSide), ...lines.slice(lines.length - perSide)];
  mode = "head30+tail30";
}

const pages = [];
for (let i = 0; i < selected.length; i += LINES_PER_PAGE) {
  pages.push(selected.slice(i, i + LINES_PER_PAGE));
}

// 提交范围内（而非全文）的裁行统计
const selClipped = selected.filter((l) => l.clipped);
const selMax = selected.reduce((a, l) => Math.max(a, l.full ?? l.text.length), 0);

// ---- 自检：不满足格式就非零退出，而不是产出"看起来没问题"的文档 ----
const problems = [];
if (mode === "head30+tail30" && pages.length !== 60) {
  problems.push(`应为 60 页，实际 ${pages.length} 页`);
}
for (const [i, p] of pages.entries()) {
  if (p.length < LINES_PER_PAGE) problems.push(`第 ${i + 1} 页只有 ${p.length} 行（要求 ≥${LINES_PER_PAGE}）`);
}
if (!SOFTWARE_NAME.trim()) problems.push("软件全称为空");

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${SOFTWARE_NAME} V${version} 源代码</title>
<style>
  @page { size: A4 portrait; margin: 14mm 12mm; }
  body { margin: 0; font-family: "Cascadia Mono", Consolas, "Courier New", monospace; }
  .page { page-break-after: always; break-after: page; }
  .page:last-child { page-break-after: auto; }
  .hd { font-size: 9pt; display: flex; justify-content: space-between; border-bottom: 1px solid #999; padding-bottom: 2mm; margin-bottom: 2mm; }
  pre { font-size: 7.6pt; line-height: 1.28; margin: 0; white-space: pre; overflow: hidden; }
  .ft { font-size: 8.5pt; text-align: center; margin-top: 2mm; }
  @media print { .noprint { display: none; } }
</style></head><body>
<div class="noprint" style="font-family:sans-serif;font-size:12px;padding:8px;background:#fffbe6;border-bottom:1px solid #e0d48a">
  ${SOFTWARE_NAME} V${version} · 源代码文档 · 共 ${pages.length} 页 · 每页 ${LINES_PER_PAGE} 行<br>
  用浏览器「打印 → 另存为 PDF」即为可提交的文档（版式已按 A4 纵向、每页强制分页设置）。打印时本提示不会出现。
</div>
${pages
  .map(
    (p, i) => `<div class="page">
  <div class="hd"><span>${SOFTWARE_NAME} V${version}</span><span>源代码</span></div>
  <pre>${p.map((l) => esc(l.text)).join("\n")}</pre>
  <div class="ft">第 ${i + 1} 页 / 共 ${pages.length} 页</div>
</div>`,
  )
  .join("\n")}
</body></html>`;

mkdirSync(OUT, { recursive: true });
const htmlPath = join(OUT, `源代码-${SOFTWARE_NAME.replace(/\s+/g, "")}-V${version}.html`);
writeFileSync(htmlPath, html, "utf8");

console.log(`[软著] 软件全称：${SOFTWARE_NAME}  版本：V${version}`);
console.log(`[软著] 收录文件 ${files.length} 个（Rust ${rustFiles.length} / 前端 ${tsFiles.length}），共 ${lines.length} 行`);
console.log(`[软著] 全文可分 ${totalPagesAvailable} 页；本次取 ${mode === "full" ? "全部" : "前 30 页 + 后 30 页"}`);
console.log(`[软著] 产出 ${pages.length} 页 × ${LINES_PER_PAGE} 行`);
console.log(
  `[软著] **提交范围内的**裁行：${selClipped.length} / ${selected.length} 行` +
    `（超 ${MAX_COLS} 字符；最长被裁行原长 ${selMax}）。裁行以 » 结尾标出。`,
);
console.log(`[软著] 输出：${htmlPath}`);

if (problems.length) {
  console.error("[软著] 格式自检未通过：");
  for (const p of problems) console.error("  ✗ " + p);
  process.exit(1);
}
console.log("[软著] 格式自检通过：页数、每页行数、页眉、连续页码均符合要求。");
