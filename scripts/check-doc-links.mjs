// 文档相对链接检查：扫描仓库内所有 .md，校验形如 `[文字](相对路径.md)` 的链接
// 目标文件真实存在（忽略 http(s) 外链与纯锚点）。
//
// 起因：`docs/plans/*.md` 里长期存在「按自己在 docs/ 根目录」写的链接
// （`](plans/xxx.md)`、`](design-philosophy.md)`），实际应为 `](xxx.md)` /
// `](../design-philosophy.md)`——渲染出来是死链，评审时才发现。
//
// 用法：node scripts/check-doc-links.mjs   （有死链即非零退出）
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { plansIndexProblems } from "./lib/docs-index.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = /(^|[\\/])(node_modules|tmp|dist|dist-web|target|\.git)([\\/]|$)/;
const LINK = /\]\((?!https?:|#|mailto:)([^)#\s]+\.md)(?:#[^)\s]*)?\)/g;

function collect(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (SKIP.test(relative(root, p))) continue;
    if (entry.isDirectory()) collect(p, acc);
    else if (entry.name.endsWith(".md")) acc.push(p);
  }
  return acc;
}

const files = collect(root);
const broken = [];
let links = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(LINK)) {
    links++;
    const target = resolve(dirname(file), m[1]);
    if (!existsSync(target)) {
      // 行号便于直接定位
      const line = text.slice(0, m.index).split("\n").length;
      broken.push(`${relative(root, file)}:${line} → ${m[1]}`);
    }
  }
}

if (broken.length) {
  console.error(`文档死链 ${broken.length} 处（共扫描 ${files.length} 个 .md / ${links} 条相对链接）：`);
  for (const b of broken) console.error("  - " + b);
  process.exit(1);
}

// ── 附加口径：`docs/README.md` 的「快速导航」表是 **主题 → 入口**，左列不许是文件路径 ──
//
// 为什么单独判这一条（2026-09-19 实况，用户先发现的）：`docs/README.md` 里有两张**长得一样**的两列表，
// 但左列语义完全不同 —— `快速导航`（我想了解… → 从这里开始）与 `方案与规划（plans）`（文档 → 内容）。
// 有 4 次「新增方案文档后顺手登记」把**后者形态的行**（左列 = `[plans/x.md](…)`）插进了前者，
// 于是导航表左列变成文件路径、读者按"我想了解什么"找不到东西。
// ⚠️ **死链判据抓不到它**（链接全是好的、全部可达）—— 所以必须单独判"表内左列的形态"。
// 判据：`## 快速导航` 与下一个 `## ` 标题之间，表行的**第一个单元格不许以 `[` 开头**。
const navProblems = [];
{
  const readme = join(root, "docs", "README.md");
  if (existsSync(readme)) {
    const lines = readFileSync(readme, "utf8").split("\n");
    const start = lines.findIndex((l) => l.trim() === "## 快速导航");
    if (start >= 0) {
      for (let i = start + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i])) break;
        const m = /^\|\s*(\[[^\]]*\])/.exec(lines[i]);
        if (m) navProblems.push(`docs/README.md:${i + 1} 左列是链接「${m[1]}」—— 导航表左列应为「我想了解…」；方案登记请写进「方案与规划（plans）」表`);
      }
    }
  }
}
if (navProblems.length) {
  console.error(`「快速导航」表形态不对 ${navProblems.length} 处：`);
  for (const p of navProblems) console.error("  - " + p);
  process.exit(1);
}

// ── 附加口径②：`docs/README.md` 的「方案与规划（plans）」表必须**登记全部**方案文档 ──
//
// 为什么单判这一条（2026-09-22）：`docs/plans/` 已 71 篇，而写完一篇忘了登记时**死链判据抓不到**
// （它只查"链接指向的文件在不在"）⇒ 新会话按文档入口找不到那一篇，同一件事会被第二次立项。
// 判据与理由（含"只认表行、不认正文提一句"与"刻意不判反向"）见 `scripts/lib/docs-index.mjs`，
// 判据本身在 `scripts/lib/docs-index.test.mjs`（6 条，含两条变异）。
const plansDir = join(root, "docs", "plans");
{
  const planFiles = existsSync(plansDir)
    ? readdirSync(plansDir).filter((f) => f.endsWith(".md"))
    : [];
  const indexProblems = plansIndexProblems({
    planFiles,
    readmeText: existsSync(join(root, "docs", "README.md"))
      ? readFileSync(join(root, "docs", "README.md"), "utf8")
      : "",
  });
  if (indexProblems.length) {
    console.error(`方案索引不全 ${indexProblems.length} 处（docs/plans 共 ${planFiles.length} 篇）：`);
    for (const p of indexProblems) console.error("  - " + p);
    console.error("  为什么必须有这一条：**写完方案忘了登记，死链判据抓不到**（链接没坏，只是没人找得到）。");
    process.exit(1);
  }
  console.log(`文档链接完整：${files.length} 个 .md，${links} 条相对链接全部可达；「快速导航」左列形态正确；方案索引齐全（${planFiles.length} 篇）。`);
}
