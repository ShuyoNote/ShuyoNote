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
// Rust 侧的切法有个**故意的保险**：只有当 `#[cfg(test)] mod tests` 出现在文件**后半段**时才切，
// 否则宁可不切、全量计数（免得某个中间位置的测试模块把后面的生产代码一起排除掉）。
//
// 用法：
//   node scripts/check-doc-content-access.mjs            # 校验（CI / 本地门禁）
//   node scripts/check-doc-content-access.mjs --update   # 把基线下调到当前实测（只允许变小）
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
const LAYER_FILES = new Set(["src/lib/docContent.ts", "src-tauri/src/doc_content.rs"]);

/** TS 测试文件的判据（`--update` 会把它们的基线项一并去掉）。 */
const isTestFile = (rel) => /\.test\.(ts|tsx|mjs|js)$/.test(rel);

/** Rust 文件末尾的测试模块（`#[cfg(test)]` + `mod tests`）。 */
const RUST_TEST_TAIL = /^#\[cfg\(test\)\]\s*\n\s*(?:pub\(crate\)\s+)?mod\s+tests\b/m;

/**
 * 取"算作生产替换面"的那部分文本。返回 `null` 表示这个文件不参与计数（测试文件）。
 * 排除测试**不是**放松：生产侧一处的余量都没有。
 */
function productionText(rel, text) {
  if (isTestFile(rel)) return null;
  if (!rel.endsWith(".rs")) return text;
  const m = RUST_TEST_TAIL.exec(text);
  // 保险：测试模块不在文件后半段就不切（宁可多算，不可漏算生产代码）。
  if (!m || m.index < text.length * 0.5) return text;
  return text.slice(0, m.index);
}

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
