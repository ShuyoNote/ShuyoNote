// 文档相对链接检查：扫描仓库内所有 .md，校验形如 `[文字](相对路径)` 的链接 —— **任意相对路径**（2026-09-28 前只认 `.md`，图片链接因此无人看管）
// 目标文件真实存在（忽略 http(s) 外链与纯锚点）。
//
// 起因：`docs/plans/*.md` 里长期存在「按自己在 docs/ 根目录」写的链接
// （`](plans/xxx.md)`、`](design-philosophy.md)`），实际应为 `](xxx.md)` /
// `](../design-philosophy.md)`——渲染出来是死链，评审时才发现。
//
// 用法：node scripts/check-doc-links.mjs   （有死链即非零退出）
//
// ⭐ 2026-10-02：多一条口径 —— **越出仓根的相对链接也算死链**（详见下面那段注释里的真事故：
//    链到私有信箱仓 `ShuyoNote-collab` ⇒ 本机那个文件在 ⇒ 本机绿，而 CI 只检出客户端仓 ⇒ 红 ✗）。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { plansIndexProblems } from "./lib/docs-index.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// ⚠️ 2026-09-28 把 `vendor` 明确排除 —— **放宽面之后第一次出现死链，全部来自上游 vendor 文件**：
//    `src-tauri/vendor/pdfium/**/licenses/libjpeg_turbo.md → README.ijg`（3 处，实测）。
//    那是**上游自己的文档**，不是我们的：**改它 = 改 vendor（不许）**，**藏它 = 静默（也不许）**
//    ⇒ 所以选择**明确排除 ＋ 写明理由**：判据的面收在"**我们自己的文档**"上。
const SKIP = /(^|[\\/])(node_modules|tmp|dist|dist-web|target|\.git|vendor)([\\/]|$)/;
// ⭐ 2026-09-28：面从「只认 `.md`」放宽到「**任意相对路径**」—— 之前**图片 `![..](..)` 没有任何门禁看着**：
//    macOS 侧实测（放一条死图链接）⇒ 本门禁照报"全部可达、exit 0" ✗。
//    · 两种形态都认：`[文字](目标)` 与 `![图注](目标)`；
//    · 只排除外链/锚点/邮件/内联（`https?:` `#` `mailto:` `data:`）；
//    · 解析（`existsSync` ⇒ **目录也算可达**）一个字没动 —— 那处本来就对；扫描面只加了 `vendor`（理由见下方 SKIP 注释）。
const LINK = /!?\[[^\]]*\]\((?!https?:|#|mailto:|data:)([^)\s#]+)(?:#[^)\s]*)?\)/g;

function collect(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (SKIP.test(relative(root, p))) continue;
    if (entry.isDirectory()) collect(p, acc);
    else if (entry.name.endsWith(".md")) acc.push(p);
  }
  return acc;
}

// ⭐ 2026-09-28：**先把代码围栏与行内代码挖掉再匹配** ——
//    写在反引号里的 `[文字](不存在的.md)` 是在**讲语法本身**，不是链接 ✗。
//    （macOS 侧用夹具证明：现判据会把它当坏链报出来；真仓当前恰好 **0 条**这种形态
//      ⇒ 是"**恰好没爆**"，不是"**不会爆**"。）
//    ⚠️ 掩码必须**等长且保留换行** —— 否则行号会整体错位（下面就是按偏移算行号的）。
function maskCodeSpans(text) {
  const blank = (s) => s.replace(/[^\n]/g, " ");
  let out = text.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, blank); // 成对围栏
  out = out.replace(/^[ \t]*(```|~~~)[\s\S]*$/m, blank); // 未闭合的围栏（一直掩到文末）
  out = out.replace(/`[^`\n]*`/g, blank); // 行内代码
  return out;
}
const files = collect(root);
const broken = [];
let links = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const scan = maskCodeSpans(text); // ⭐ 代码围栏/行内代码先挖掉（等长掩码 ⇒ 偏移与行号不变）
  for (const m of scan.matchAll(LINK)) {
    links++;
    const target = resolve(dirname(file), m[1]);
    // ⭐⭐ 2026-10-02（macOS 侧）：**越出仓根的相对链接一律算死链** —— 这条是"本机绿、CI 红"那一族。
    //
    // 来由（真事故，就在同一天）：`docs/specs/2026-10-01-enterprise-im-spec.md:89` 链到
    //   `../../../ShuyoNote-collab/2026-10-02-….md` —— 那是**私有信箱仓**（不入产品仓 ✓）。
    //   ⚠️ 本机工作区里那个文件**在** ⇒ `existsSync` 判它"可达" ⇒ **本机 exit 0** ✓，
    //   而 CI **只检出客户端仓** ⇒ 同一个判据在 CI 上 exit 1 ✗（判语逐字见那份变异的 finding）。
    //   ⇒ 这是**判据自己的面**错了：对"链到仓外"这种事，`existsSync` 的答案**取决于跑它的那台机器** ✗。
    // 判据：解析结果落在**仓根之外** ⇒ 死链。理由一句话：**本仓的 CI 只检出本仓 ⇒ 仓外的目标永远不可达** ✓。
    // ⚠️ **量过再立**（K11）：全仓 1339 条相对链接里越根的只有 **1** 条（就是上面那条）⇒ 这条规则**零误报** ✓。
    //   反例（不该被它误伤）：仓内任意深度的 `../` 都仍然放行（只判"出不出仓根"，不判"跳几层" ✓）。
    const out = relative(root, target);
    if (out.startsWith("..") || isAbsolute(out)) {
      const line = scan.slice(0, m.index).split("\n").length;
      broken.push(
        `${relative(root, file)}:${line} → ${m[1]}` +
          `（**越出仓根**：本仓 CI 只检出本仓 ⇒ 仓外的目标永远不可达；请在仓内另放一份或改成纯文字 ✓）`
      );
      continue;
    }
    if (!existsSync(target)) {
      // 行号便于直接定位
      const line = scan.slice(0, m.index).split("\n").length;
      broken.push(`${relative(root, file)}:${line} → ${m[1]}`);
    }
  }
}

if (broken.length) {
  console.error(`文档死链 ${broken.length} 处（共扫描 ${files.length} 个 .md / ${links} 条相对链接，**含图片与任意后缀**）：`);
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
  console.log(`文档链接完整（**含图片与任意后缀**）：${files.length} 个 .md，${links} 条相对链接全部可达；「快速导航」左列形态正确；方案索引齐全（${planFiles.length} 篇）。`);
}
