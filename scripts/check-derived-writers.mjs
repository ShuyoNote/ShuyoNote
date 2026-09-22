// 门禁：**派生表的唯一写入者** —— `attachment_text` / `chunks` 的生产写入只许来自 TS 抽取管线。
//
// 背景（Windows 2026-09-18 的裁定）：桌面 `attachment_text` / `chunks` 的写入口**保持现状**
// （抽取管线是唯一写入者），但"唯一写入者"这条**必须做成可执行判据**，否则它只活在文档里 ——
// 这一轮已经证明"只写在文档里的规则会漂"。
//
// 本判据管的是**能长出第二条写入路径的那一侧**：`src-tauri/src/**` 里
// **非测试代码**出现 `INSERT INTO attachment_text|chunks`（含 `INSERT OR REPLACE` / `REPLACE`）⇒ 红。
// 测试模块里的 INSERT **不算**（Rust 侧今天就有两处在 `#[cfg(test)]` 里播种夹具）——
// 区域判定与「文档内容直接访问」门禁**共用** `scripts/lib/rust-scan.mjs`：
// 只有"该 `#[cfg(test)]` item 之后只剩空白/注释"才切，切不动就全量计数（宁可多算，不可漏算）。
//
// 读那一侧（`derivedText.ts` ↔ `search.rs::read_attachment_text_in_conn`）两边各写一份，
// 那是**另一件事**（要的是跨语言夹具），不在本判据里 —— 本判据只守"写只有一处"。
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { ALLOWED_RUST_WRITERS, scanDerivedWriters } from "./lib/derived-writers.mjs";
import { productionText } from "./lib/rust-scan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUST_ROOT = join(root, "src-tauri", "src");

/** 出错时能一眼看出"扫过哪些文件"，避免"目录写错 ⇒ 0 命中 ⇒ 假绿"。 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "target" || entry === "node_modules") continue;
      walk(p, out);
    } else if (p.endsWith(".rs")) {
      out.push(p);
    }
  }
  return out;
}

if (!existsSync(RUST_ROOT)) {
  console.error(`✗ 找不到 ${relative(root, RUST_ROOT)}（判据没东西可扫 ⇒ 拒绝给绿）`);
  process.exit(1);
}

const files = walk(RUST_ROOT).map((p) => ({
  path: relative(root, p).replace(/\\/g, "/"),
  text: productionText(relative(root, p).replace(/\\/g, "/"), readFileSync(p, "utf8")) ?? "",
}));

if (files.length === 0) {
  console.error("✗ src-tauri/src 下一个 .rs 都没有 ⇒ 拒绝给绿（判据不能空跑）");
  process.exit(1);
}

const violations = scanDerivedWriters(files);
if (violations.length) {
  console.error(`✗ 派生表出现了**生产**写入者（唯一写入者应是 TS 抽取管线）：`);
  for (const v of violations) console.error(`   · ${v.path}:${v.line} 写入 ${v.table}`);
  console.error(`
这两张表（attachment_text / chunks）的派生文本只由 TS 抽取管线写：
  src/lib/extract/store.ts / chunkStore.ts（经 sqliteStore.ts / web.ts）
**唯一豁免**是桌面运输通道 \`src-tauri/src/derived_transport.rs\`（它只执行 TS 发来的 op，
派生的 owner 仍是 TS 那一份 —— 见 scripts/lib/derived-writers.mjs 的 ALLOWED_RUST_WRITERS）。
除此之外 Rust 侧若确实需要写，请先回答"谁拥有这条派生"并把规则与判据一起改 —— 不要绕过这条门禁。`);
  process.exit(1);
}

console.log(
  `✓ 派生表唯一写入者：扫过 ${files.length} 个 .rs（已剥测试尾部），生产写入 0 处` +
    `（豁免 ${ALLOWED_RUST_WRITERS.length} 个已批准的运输通道文件）`,
);

