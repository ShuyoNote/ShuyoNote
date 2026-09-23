// 门禁：**「文档内容」的直接访问只许减、不许增**。
//
// 背景（阶段 0「接口收口」，见 docs/plans/2026-09-18-doc-content-layer-inventory.md）：
// 最初盘点时 `content_json` / `content_text` / `contentJson` 在前端与 Rust 侧共 **746 处、80 个文件**
// 里被直接提到（**含测试**；见下面的口径修订 —— 排除测试后的生产面读数以基线文件为准）。
// 换 CRDT（或做块级 LWW）时，如果全仓都直接摸这两个字段，替换面就是这么大；
// 收口的目标是让它们**只经一层**（read/write/merge/derive）。
//
// 做法：记一份**每文件基线计数**，规则三条：
//   1. 出现新文件直接引用 ⇒ **红**；
//   2. 某文件计数**超过**基线 ⇒ **红**（说明又往里加直接访问了）；
//   3. 计数**低于**基线 ⇒ 提示"请下调基线"（`--update`），让收口**单调收敛**。
//
// ## 口径修订 2（AMD 侧，2026-09-18）：切测试尾部改用**可证明**的规则
//
// 上面的"口径修订"把测试排除出计数 —— **我（AMD，本门禁的登记人）支持这条**，理由与 macOS 一致：
// 测试夹具里 `INSERT INTO pages (... content_text ...)` 不是 CRDT 的替换面，把它算进来等于
// "谁写测试谁红"，最后只会逼人把测试挪到扫不到的目录。
//
// 但其中 Rust 的切法用了**位置比例**（`#[cfg(test)] mod tests` 落在文件后半段就切到文件尾），
// 那是**代理**不是证明，而且失效方向最坏：**只要测试模块之后还有生产代码，那段生产代码会被一起切掉**
// ⇒ 在它里面新增直接访问**不报红**（假绿）。所以这里换成：
//
//   · 用一个小扫描器给文本打区域掩码（代码/行注释/块注释/字符串/字符字面量）；
//   · 从每个 `#[cfg(test)]` 起做**花括号配对**找到该 item 的结束位置；
//   · ★ 只有**该 item 之后只剩空白与注释**（即它真的是文件尾巴）才切；
//   · 任何不确定（名字不认识、配对失败、后面还有东西）**一律不切**，全量计数。
//
// 两个方向的性质因此变成：**可能多算（假红，可见且便宜），不可能漏算（假绿）**。
// 它也不再依赖"测试模块叫 `mod tests`"，也不依赖"测试在后半段"。
//
// ## 口径修订（macOS 侧，2026-09-18 —— 有异议请直接回滚这一处，理由留在协同信箱）
//
// **测试代码不算「生产替换面」，从计数里排除**。原口径把 `*.test.ts(x)` 与 Rust 的测试模块一起数，
// 结果是：**谁为新功能写一条内容相关的测试，谁就红**。这条门禁上线当天就撞上了 ——
// `pages.get` 加分页（`dc400c16`）新增的直接访问**全在生产侧为零**（同一条 SQL 列、同一个 JSON 键），
// 涨的 13 处全在测试与注释里：TS 测试 7→14、Rust 21→27（其中 5 处在 `mod tests` 内、1 处在文档注释里）。
// 换 CRDT 时没人需要改测试夹具里 `INSERT INTO pages (... content_text ...)` 的那一列 —— 它不是替换面。
// 把测试算进来，只会让人为了过门禁而把测试挪到扫不到的目录，或者干脆不写测试；两者都更糟。
//
// 边界（写清楚免得这条豁免被当成"随便加"）：**生产代码一处的余量都没有** ——
// `.ts/.tsx`（非测试）与 Rust 测试模块之前的部分仍然逐字符计数、超基线即红。
// （Rust 那条"位于后半个文件才切"的比例保险已被上面的口径修订 2 换成配对证明。）
//
// ## 撞上假红时的固定处置（避免每次都重新吵口径）
//
// 1. **先看是不是测试** ⇒ 测试已在计数外（上面两条口径修订），所以这一步现在通常直接排除掉；
// 2. **再改措辞 / 参数名**（首选）：把 `contentJson: string` 这类**收 JSON 文本**的参数改成
//    `docJson`，把注释里的字段名改成中文描述 —— 这不是绕过，那个名字本来就不该叫存储字段名；
// 3. **口径本身不动**：token 计数是**粗粒度**代理，它分不清"参数名/注释"与"真的访问字段"，
//    加"排除某类文件/某个目录"的豁免等于**开一个可以按目录无限扩大的洞**（今天排纯函数层、
//    明天排视图层）。真需要豁免的只有**那一层自己**，走 `LAYER_FILES`（就两个文件，写死在下面）。
//
// 一句话：**判据可以粗，但不许按目录豁免**；每次假红都要在提交信息里写清"为什么这不是新增替换面"。
//
// ## 为什么**注释里出现也算**（macOS 侧 2026-09-22 提的；写在这里免得下一个人以为它误报）
//
// ① **可靠地把注释摘掉做不到**：TS 的模板串 / 正则、Rust 的 `///` 与 `/* */` 嵌套、raw string —— 每加一条
//    "聪明"的剥离规则，就多一种**漏算（假绿）**的形状，而这条门禁最不能接受的就是假绿；
// ② 更根本的是**注释会教人**：写着 `content_text` 的注释等于告诉下一个读者"直接读这一列是正常的"，
//    而这条门禁要收的正是"直接读这两列"这件事本身。⇒ 想提这两列，就在注释里写**中文描述**
//    （"正文文本列"），不要去写存储字段名（处置第 2 条，也是这次 `web.ts` / `App.tsx` 假红的走法）。
//
// 用法：
//   node scripts/check-doc-content-access.mjs            # 校验（CI / 本地门禁）
//   node scripts/check-doc-content-access.mjs --update   # 把基线下调到当前实测（只允许变小）
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
// 判据（测试文件 / Rust 生产文本）在 `scripts/lib/rust-scan.mjs`，那里有自己的回归判据
// （`rust-scan.test.mjs`）：其中的「配对证明」是给一次真实漏报立的闸 —— 旧实现按位置比例切尾部，
// 会在「测试模块之后还有生产代码」时把生产代码一起切掉，新增的直接访问因此**不报红**。
import { isTestFile, productionText } from "./lib/rust-scan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(root, "scripts", "doc-content-access-baseline.json");
const PATTERNS = [/content_json/g, /content_text/g, /contentJson/g];
const UPDATE = process.argv.includes("--update");

/** 需要扫的目录与扩展名。 */
const ROOTS = [
  { dir: join(root, "src"), exts: [".ts", ".tsx"] },
  { dir: join(root, "src-tauri", "src"), exts: [".rs"] },
];

/** 收口后**允许**直接访问的那一层（还没建，先占位；建成后它们本就该在名单里）。 */
const LAYER_FILES = new Set([
  "src/lib/docContent.ts",
  "src-tauri/src/doc_content.rs",
  // 阶段 2（2026-09-23）：`content_json` ⇄ `ydoc` 的**唯一实现**（Slice A）。它按定义就是"那一层"的新成员：
  // 唯一能同时提到落盘形态与 CRDT 形态的地方，别的地方一律经它转（判据在 `yDocBridge.test.ts`）。
  // ⚠️ 加这里等于声明"这个文件本来就该直接访问" —— 以后它不是那一层了（比如改成经 `docContent.ts` 中转）就把它删掉。
  "src/lib/crdt/yDocBridge.ts",
]);

// 判据（测试文件 / Rust 生产文本）都在 `scripts/lib/rust-scan.mjs`，见文件头 import 处的说明。

function walk(dir, exts, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "target" || entry === "dist") continue;
      walk(p, exts, out);
    } else if (exts.includes(p.slice(p.lastIndexOf(".")))) {
      out.push(p);
    }
  }
  return out;
}

const counts = {};
let skippedTestFiles = 0;
let trimmedRustTails = 0;
for (const { dir, exts } of ROOTS) {
  if (!existsSync(dir)) continue;
  for (const file of walk(dir, exts)) {
    const rel = relative(root, file).replace(/\\/g, "/");
    // 那一层自己**本来就该**直接访问：计数阶段就跳过（否则 `--update` 会把豁免文件写进基线，
    // 而基线里躺着豁免文件会让"文件数下降"这个读数失去意义）。
    if (LAYER_FILES.has(rel)) continue;
    const raw = readFileSync(file, "utf8");
    const text = productionText(rel, raw);
    if (text === null) {
      skippedTestFiles++;
      continue;
    }
    if (text.length !== raw.length) trimmedRustTails++;
    let n = 0;
    for (const re of PATTERNS) n += (text.match(re) ?? []).length;
    if (n > 0) counts[rel] = n;
  }
}

const hadBaseline = existsSync(BASELINE);
const baseline = hadBaseline ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};

if (UPDATE) {
  // 「只许减」：不允许把基线调高（要调高说明又新增了直接访问，那应该先改代码）。
  // ⚠️ **首次创建要豁免**：基线还不存在时，每个文件都是"0 → N"，那不叫上涨，那叫 bootstrap。
  //    这一条是门禁第一次跑时自己抓出来的（它拒绝了创建基线），写下来免得后人再踩。
  const raised = hadBaseline
    ? Object.entries(counts).filter(([f, n]) => (baseline[f] ?? 0) < n)
    : [];
  if (raised.length) {
    console.error("✗ 拒绝上调基线（先去掉新增的直接访问）：");
    for (const [f, n] of raised) console.error(`   · ${f}: ${baseline[f] ?? 0} → ${n}`);
    process.exit(1);
  }
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + "\n", "utf8");
  const total = Object.values(sorted).reduce((a, b) => a + b, 0);
  console.log(`✓ 基线已下调：${Object.keys(sorted).length} 个文件 / ${total} 处`);
  process.exit(0);
}

const problems = [];
for (const [file, n] of Object.entries(counts)) {
  if (LAYER_FILES.has(file)) continue;
  const was = baseline[file];
  if (was === undefined) problems.push(`新增文件直接引用（不在基线里）：${file}（${n} 处）`);
  else if (n > was) problems.push(`直接访问变多：${file} ${was} → ${n}（收口要求只减不增）`);
}

const wasTotal = Object.values(baseline).reduce((a, b) => a + b, 0);
const nowTotal = Object.values(counts).reduce((a, b) => a + b, 0);

if (problems.length) {
  console.error(`✗ 文档内容直接访问门禁未通过（${problems.length} 项）：`);
  for (const p of problems) console.error("   · " + p);
  console.error(`
这些访问应当只经「那一层」：
   read(spaceId,pageId) / write(...) / merge(local,remote) / derive(merged)
详见 docs/plans/2026-09-18-doc-content-layer-inventory.md §3/§4。`);
  process.exit(1);
}

const lowerable = Object.entries(baseline).filter(([f, n]) => (counts[f] ?? 0) < n);
console.log(
  `✓ 文档内容直接访问（生产面）：${Object.keys(counts).length} 个文件 / ${nowTotal} 处（基线 ${wasTotal} 处）` +
    `　—　已排除 ${skippedTestFiles} 个测试文件、${trimmedRustTails} 个 Rust 测试尾部`,
);
if (lowerable.length) {
  console.log(`  ℹ️ 有 ${lowerable.length} 个文件的计数已经低于基线，可下调基线让它继续收敛：`);
  for (const [f, n] of lowerable.slice(0, 10)) console.log(`     · ${f}: ${n} → ${counts[f] ?? 0}`);
  console.log("     跑 `node scripts/check-doc-content-access.mjs --update`（只允许变小）。");
}
