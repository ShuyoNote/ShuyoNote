// CHANGELOG 结构门禁：**只钉"骨架"，不评"文风"。**
//
// 为什么要有它（都是这份文件真实出过的事）：
//   1. `## [1.66.0]` 出现过**两段**（`f9e07e2` 补写 1.67.0 时多插了一个段头，
//      把旧的 1.67.0 草稿段变成了第二段 1.66.0，正文与 1.67.0 逐字重复）——
//      靠人眼看几百行 markdown 发现不了，而 `check-versions.mjs` 只看第一个段头。
//   2. 发版时把 `[Unreleased]` 改名成本版本段之后，**忘了留一个新的 `[Unreleased]`**
//      （1.89.1 / 1.90.0 / 1.90.1 三次发版都留了，1.90.2 这次没留；
//      `a0ea3b7` 还专门把它挪到最上面，写明"Keep a Changelog：最新在上"）。
//      丢了它，下一轮改动就没有"该往哪儿写"的落点，容易又写成散段。
//      ⚠️ 注意这里只要求它**在**，不要求它**空**——首版门禁曾要求"`[Unreleased]` 必须为空"，
//      那是对 Keep a Changelog 的误读：`[Unreleased]` 的用途**就是攒尚未发布的改动**，
//      要求它为空等于"做完了改动却没法记账"（1.90.2 之后的移动端适配就卡在这条上）。
//      现在它和"基线之后的新版本"用**同一套**小标题口径检查。
//   3. 若干处 3–4 行连续空行、1 处空的 `- ` 占位条目、1 处标题前缺空行
//      （`### 新增` 直接跟在上一条目后面）——都不影响渲染，但确实是"乱"。
//
// 能挡住的（文件级，全部版本）：
//   - 段头格式：除 `[Unreleased]` 外必须是 `## [X.Y.Z] - YYYY-MM-DD`（真实日历日）；
//   - 版本号严格递减、**无重复段头**、首个 `##` 之前不许有 `###`；
//   - `[Unreleased]` 存在、唯一、是第一个段；**段头不带日期**、且**允许非空**
//     （非空时其 `###` 小标题按下面那条口径查）；
//   - 代码围栏成对；无 ≥3 行连续空行、空行无行尾空白、无空的 `- ` 条目；
//   - 每个 `##` / `###` 标题前有空行。
// 能挡住的（只对**基线之后**的版本，即 > BASELINE，**外加 `[Unreleased]`**）：
//   - 小标题唯一（同一段里不许两个 `### 修复`）且取自 ALLOWED_H3 允许集合。
//     `[Unreleased]` 与"基线之后的新版本"**用的是同一套**口径：它记的正是"即将成为
//     下一个版本"的内容，先用宽松口径记、发版时再收紧就失去意义了。
//
// 挡不住的（**故意不查**，别指望它）：
//   - 历史段的小标题口径：`### 优化 / 改进 / 重构 / 样式 / 工程 / 文档 / 测试 / 验证 / 说明 /
//     其它 / 其他` 以及 `### 修复（xxx）` 这类带括号的写法在 1.1.0–1.90.2 里共 150 多处、
//     涉及 110 多个版本。这是**历史记录**，统一口径等于重写历史，故一律 grandfather，
//     只用 BASELINE 管住新版本（要改历史得单独决策）。`[Unreleased]` **不** grandfather——
//     它记的是"还没发出去的新内容"，不是历史。
//   - 小标题的顺序（如"新增 → 变更 → 修复"）与数量：Keep a Changelog 允许只用其中几个。
//   - 条目措辞、详略、`**粗体标题**：说明` 与纯句子混用、缩进 2 空格 vs 4 空格。
//   - 内容是否**过时或自相矛盾**（例：1.90.2 里 `### 已知问题（尚未修）` 记的那条 panic
//     其实同一段上面的 `### 修复` 已经修掉了）。这类要人判断，脚本只保证骨架不烂。
//   - 日期与版本号的**先后是否合理**（1.84.0 的日期早于 1.83.0，是 `5d075fd` 从 git 重建段头时
//     落下的；改日期属于改历史，不在本门禁范围内）。
//   - 与 `package.json` 版本号的一致性 —— 那条归 `scripts/check-versions.mjs`。
//
// 用法：node scripts/check-changelog.mjs [目标文件]   （任何一条不满足即非零退出）
// 不传目标文件时检查仓库根的 CHANGELOG.md；传路径时检查该文件（自测用，规则完全相同）。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 基线：**此版本及更早的历史段一律按现状 grandfather**，只对新版本执行小标题口径检查。
// 加门禁时的最新版本就是 1.90.2（它自己也不合规：两个 `### 修复` + `### 已知问题（尚未修）`，
// 而同族历史的 1.86.0 一段里有 26 个重复小标题）⇒ 不能拿它当样本，只能从下一个版本起生效。
const BASELINE = [1, 90, 2];
const ALLOWED_H3 = ["新增", "变更", "修复", "移除", "安全", "废弃", "其它"];

const errors = [];
const argPath = process.argv[2];
const targetPath = argPath ? resolve(process.cwd(), argPath) : resolve(root, "CHANGELOG.md");
const rel = argPath || "CHANGELOG.md";

let text = "";
try {
  text = readFileSync(targetPath, "utf8");
} catch {
  console.error(`[check-changelog] 读不到 ${rel}`);
  process.exit(1);
}

if (text.charCodeAt(0) === 0xfeff) errors.push(`${rel}: 文件带 BOM —— 全文 diff 会莫名其妙，请存成无 BOM 的 UTF-8。`);
if (text.includes("\r\n")) errors.push(`${rel}: 出现 CRLF —— 本仓库该文件历史上是纯 LF，混行尾会让 diff 整文件重写。`);

const lines = text.split("\n");
const where = (i) => `${rel}:${i + 1}`;

// ---- 逐个段扫描（围栏内的内容对骨架规则不可见）----
const sections = []; // { title, line, endLine, h3: [{name, line}] }
let inFence = false;
let fenceOpenLine = -1;
let fenceCount = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (/^\s*```/.test(line)) {
    fenceCount++;
    if (!inFence) {
      inFence = true;
      fenceOpenLine = i;
    } else {
      inFence = false;
    }
    continue;
  }
  if (inFence) continue;

  const h2 = line.match(/^##\s+(.*?)\s*$/);
  if (h2) {
    sections.push({ title: h2[1], line: i, endLine: lines.length, h3: [] });
    continue;
  }
  const h3 = line.match(/^###\s+(.*?)\s*$/);
  if (h3) {
    if (!sections.length) errors.push(`${where(i)}: 出现在任何 "## " 段之前的 "### ${h3[1]}" —— 它不属于任何版本段。`);
    else sections[sections.length - 1].h3.push({ name: h3[1], line: i });
  }
}
if (inFence) errors.push(`${where(fenceOpenLine)}: 代码围栏（三个反引号）没有闭合 —— 文件结束时仍在围栏内。`);
if (fenceCount % 2 !== 0) errors.push(`${rel}: 代码围栏共 ${fenceCount} 个（应为偶数）。`);

for (let k = 0; k < sections.length; k++) sections[k].endLine = k + 1 < sections.length ? sections[k + 1].line - 1 : lines.length - 1;

if (!sections.length) {
  console.error(`[check-changelog] ${rel} 里一个 "## " 段都没有。`);
  process.exit(1);
}

// ---- 1. [Unreleased]：存在、唯一、在第一位（**内容允许非空**）----
// 为什么不再要求"空"：`[Unreleased]` 的用途**就是攒尚未发布的改动**（Keep a Changelog）。
// 要求它为空，等于"改动做完了却没处记账"——门禁从"守骨架"变成了"挡住记录"。
// 放开的是**有没有内容**，不是**内容长什么样**：它的段头仍不带日期，段里的 `###` 仍要
// 走 ALLOWED_H3 那套（见下面第 6 步，与"基线之后的新版本"同一个函数、同一套规则）。
const unreleased = sections.filter((s) => s.title === "[Unreleased]");
/** 只用于成功时打印"攒了几行"，不影响任何判定。 */
const unreleasedLines = unreleased.length
  ? lines.slice(unreleased[0].line + 1, unreleased[0].endLine + 1).filter((l) => l.trim() !== "").length
  : 0;
if (unreleased.length === 0) {
  errors.push(
    `${rel}: 缺 "## [Unreleased]" —— 它是"最新改动写哪儿"的落点（1.89.1/1.90.0/1.90.1 发版后都留了，` +
      `a0ea3b7 还专门把它挪到最上面）。发版把 [Unreleased] 开成本版本段之后，请补一个回来。`,
  );
} else {
  if (unreleased.length > 1) errors.push(`${rel}: "## [Unreleased]" 出现 ${unreleased.length} 次，只允许一个。`);
  const u = unreleased[0];
  if (u.line !== sections[0].line) {
    errors.push(`${where(u.line)}: "## [Unreleased]" 不是第一个段（第一个是 "## ${sections[0].title}"）——最新在上。`);
  }
  // 注：段头**不带日期**这条由第 2 步兜住——`## [Unreleased] - 2026-09-15` 匹配不上 HEADER，
  // 会报"段头不符合 `## [X.Y.Z] - YYYY-MM-DD`"。这里不重复查，避免两套说法互相漂移。
}

// ---- 2. 段头格式 + 3. 版本号严格递减、无重复 ----
const HEADER = /^\[(\d+)\.(\d+)\.(\d+)\] - (\d{4})-(\d{2})-(\d{2})$/;
const versions = [];
const seen = new Map();

for (const s of sections) {
  if (s.title === "[Unreleased]") continue;
  const m = s.title.match(HEADER);
  if (!m) {
    errors.push(`${where(s.line)}: 段头 "## ${s.title}" 不符合 ` + "`## [X.Y.Z] - YYYY-MM-DD`" + `（日期必填）。`);
    continue;
  }
  const [, a, b, c, y, mo, d] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) {
    errors.push(`${where(s.line)}: 日期 ${y}-${mo}-${d} 不是真实日历日。`);
  }
  const key = `${+a}.${+b}.${+c}`;
  if (seen.has(key)) errors.push(`${where(s.line)}: 段头 "## [${key}]" 重复（上一次在 ${where(seen.get(key))}）。`);
  else seen.set(key, s.line);
  versions.push({ key, num: [+a, +b, +c], line: s.line });
}

for (let i = 1; i < versions.length; i++) {
  const p = versions[i - 1].num;
  const q = versions[i].num;
  const cmp = p[0] - q[0] || p[1] - q[1] || p[2] - q[2];
  if (cmp <= 0) {
    errors.push(
      `${where(versions[i].line)}: "## [${versions[i].key}]" 排在 "## [${versions[i - 1].key}]" 之后 —— ` +
        `版本段必须从新到旧严格递减（相等也不行）。`,
    );
  }
}

// ---- 4. 标题前的空行 ----
for (let i = 1; i < lines.length; i++) {
  if (!/^#{2,3}\s/.test(lines[i])) continue;
  if (lines[i - 1].trim() !== "") {
    errors.push(`${where(i)}: 标题 "${lines[i].trim()}" 前缺空行（上一行是 ${JSON.stringify(lines[i - 1].trim().slice(0, 40))}）。`);
  }
}

// ---- 5. 空白与占位条目 ----
let blankRun = 0;
let inFence2 = false;
for (let i = 0; i < lines.length; i++) {
  if (/^\s*```/.test(lines[i])) {
    inFence2 = !inFence2;
    blankRun = 0;
    continue;
  }
  if (inFence2) continue;
  if (lines[i].trim() === "") {
    blankRun++;
    if (blankRun === 3) errors.push(`${where(i)}: 第 3 行连续空行（最多留 1 行）。`);
  } else {
    blankRun = 0;
    if (/^[ \t]+$/.test(lines[i])) errors.push(`${where(i)}: 只有空白字符的行。`);
    if (/^[ \t]*-[ \t]*$/.test(lines[i])) errors.push(`${where(i)}: 空的 "- " 占位条目（脚本模板漏填）。`);
  }
}

// ---- 6. 基线之后：小标题唯一且取自允许集合 ----
for (const s of sections) {
  if (s.title === "[Unreleased]") {
    checkH3(s, "Unreleased");
    continue;
  }
  const m = s.title.match(HEADER);
  if (!m) continue;
  const num = [+m[1], +m[2], +m[3]];
  const afterBaseline = num[0] - BASELINE[0] || num[1] - BASELINE[1] || num[2] - BASELINE[2];
  if (afterBaseline > 0) checkH3(s, s.title);
}

function checkH3(s, label) {
  const used = new Map();
  for (const { name, line } of s.h3) {
    if (!ALLOWED_H3.includes(name)) {
      errors.push(
        `${where(line)}: 小标题 "### ${name}"（段 ${label}）不在允许集合 ` +
          `[${ALLOWED_H3.join(" / ")}] 内 —— 历史段的其它写法（优化/改进/重构/工程/文档/测试/…）已 grandfather，` +
          `新段请用 Keep a Changelog 的这几种。`,
      );
    }
    if (used.has(name)) errors.push(`${where(line)}: 小标题 "### ${name}"（段 ${label}）重复（上一次在 ${where(used.get(name))}）。`);
    else used.set(name, line);
  }
}

if (errors.length) {
  console.error(`[check-changelog] ${errors.length} 项不通过：`);
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
console.log(
  `[check-changelog] 结构一致：${versions.length} 个版本段 + [Unreleased]（${unreleasedLines} 行内容）、` +
    `段头格式与递减顺序正确、无重复段头；` +
    `小标题口径检查对 [Unreleased] 与 ${BASELINE.join(".")} 之后的新版本生效（更早的历史段 grandfather）。`,
);
