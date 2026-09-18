// 门禁：**「文档内容」的直接访问只许减、不许增**。
//
// 背景（阶段 0「接口收口」，见 docs/plans/2026-09-18-doc-content-layer-inventory.md）：
// 今天 `content_json` / `content_text` / `contentJson` 在前端与 Rust 侧共 **746 处、80 个文件**里被直接提到。
// 换 CRDT（或做块级 LWW）时，如果全仓都直接摸这两个字段，替换面就是 746 处；
// 收口的目标是让它们**只经一层**（read/write/merge/derive）。
//
// 做法：记一份**每文件基线计数**，规则三条：
//   1. 出现新文件直接引用 ⇒ **红**；
//   2. 某文件计数**超过**基线 ⇒ **红**（说明又往里加直接访问了）；
//   3. 计数**低于**基线 ⇒ 提示"请下调基线"（`--update`），让收口**单调收敛**。
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
for (const { dir, exts } of ROOTS) {
  if (!existsSync(dir)) continue;
  for (const file of walk(dir, exts)) {
    const text = readFileSync(file, "utf8");
    let n = 0;
    for (const re of PATTERNS) n += (text.match(re) ?? []).length;
    if (n > 0) counts[relative(root, file).replace(/\\/g, "/")] = n;
  }
}

// ⚠️ **豁免层要从受约束计数里彻底摘掉**（不只是在校验时跳过它）。
// 2026-09-18 实测踩到：壳（`doc_content.rs`）一落地，本文件就**再也 `--update` 不了**——
// 它在基线里是 0、现在是 9，被当成"新增文件直接引用"而拒绝下调。
// 根因是"豁免"只写在**校验**那一支里，**写基线**那一支不知道它豁免。
// ⇒ 统一成这一个 `regulated`：`counts` 只是原始读数（含豁免层），受约束与入库的一律用它。
const regulated = Object.fromEntries(
  Object.entries(counts).filter(([f]) => !LAYER_FILES.has(f)),
);

const hadBaseline = existsSync(BASELINE);
const baseline = hadBaseline ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};

if (UPDATE) {
  // 「只许减」：不允许把基线调高（要调高说明又新增了直接访问，那应该先改代码）。
  // ⚠️ **首次创建要豁免**：基线还不存在时，每个文件都是"0 → N"，那不叫上涨，那叫 bootstrap。
  //    这一条是门禁第一次跑时自己抓出来的（它拒绝了创建基线），写下来免得后人再踩。
  const raised = hadBaseline
    ? Object.entries(regulated).filter(([f, n]) => (baseline[f] ?? 0) < n)
    : [];
  if (raised.length) {
    console.error("✗ 拒绝上调基线（先去掉新增的直接访问）：");
    for (const [f, n] of raised) console.error(`   · ${f}: ${baseline[f] ?? 0} → ${n}`);
    process.exit(1);
  }
  const sorted = Object.fromEntries(Object.entries(regulated).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + "\n", "utf8");
  const total = Object.values(sorted).reduce((a, b) => a + b, 0);
  console.log(`✓ 基线已下调：${Object.keys(sorted).length} 个文件 / ${total} 处`);
  process.exit(0);
}

const problems = [];
for (const [file, n] of Object.entries(regulated)) {
  const was = baseline[file];
  if (was === undefined) problems.push(`新增文件直接引用（不在基线里）：${file}（${n} 处）`);
  else if (n > was) problems.push(`直接访问变多：${file} ${was} → ${n}（收口要求只减不增）`);
}

const wasTotal = Object.values(baseline).reduce((a, b) => a + b, 0);
const nowTotal = Object.values(regulated).reduce((a, b) => a + b, 0);

if (problems.length) {
  console.error(`✗ 文档内容直接访问门禁未通过（${problems.length} 项）：`);
  for (const p of problems) console.error("   · " + p);
  console.error(`
这些访问应当只经「那一层」：
   read(spaceId,pageId) / write(...) / merge(local,remote) / derive(merged)
详见 docs/plans/2026-09-18-doc-content-layer-inventory.md §3/§4。`);
  process.exit(1);
}

const lowerable = Object.entries(baseline).filter(([f, n]) => (regulated[f] ?? 0) < n);
console.log(`✓ 文档内容直接访问：${Object.keys(regulated).length} 个文件 / ${nowTotal} 处（基线 ${wasTotal} 处）`);
if (lowerable.length) {
  console.log(`  ℹ️ 有 ${lowerable.length} 个文件的计数已经低于基线，可下调基线让它继续收敛：`);
  for (const [f, n] of lowerable.slice(0, 10)) console.log(`     · ${f}: ${n} → ${regulated[f] ?? 0}`);
  console.log("     跑 `node scripts/check-doc-content-access.mjs --update`（只允许变小）。");
}
