// 划词查词的**判据管道**（第一期）：样本词表 ⇒ **一条命令**出三个读数。
//
// ```bash
// node scripts/dictionary-bench.mjs                       # 用默认样本词表
// node scripts/dictionary-bench.mjs --db <路径>            # 指某个库（默认 dev 产出那份）
// node scripts/dictionary-bench.mjs --hits apple,note      # 小样本库请换词表（见 --sample 的说明）
// node scripts/dictionary-bench.mjs --repeat 50            # 查询耗时采样次数
// node scripts/dictionary-bench.mjs --json                 # 机器可读
// ```
//
// 输出（三个读数，缺一不可）：
//   ① **命中率** —— 英文样本词必须 100% 命中（少了就是数据/取数那条路的问题）；
//   ② **查询耗时** —— 每次查询真的量一遍（中位数/p95），⛔ 不写"毫秒级"这种没有读数的说法；
//   ③ **查不到的词如何呈现** —— 中文术语与乱码必须走"未收录 ⇒ 可走 AI"，**并印出那句话**。
//
// ## 这一层量什么、**不**量什么（⚠️ 别把它读成"整条链验过了"）
//
// · 量的是**数据层**：这份 SQLite 里有没有这个词、查一次多久、没收录时我们能说出什么话。
// · **不**量 Rust 那条路（`dictionary.rs` 的规范化/失败分类）—— 那条由
//   `cargo test --lib dictionary` 量（含"词典不在"与"半包"两种失败态）。
// · **不**量界面文案 —— 那是 `src/lib/dictionary/lookup.test.ts`（vitest）的事。
// 三层的**权威**分别是：Rust（查询与分类）、TS（呈现）、本脚本（数据与耗时）。
//
// ## 为什么用 `node:sqlite`
//
// 与 `fetch-ecdict.mjs` 同一条理由：CI 与本机都是 Node 22，`node:sqlite` 内置 ⇒ 零依赖。
// ⚠️ 会多一行 `ExperimentalWarning`（不是报错）。
//
// ## 退出码
//
// `0` 三个读数都符合预期 ／ `1` 有期望被违反（逐条打印是哪一条）／ `2` 库不在或读不动（**不算通过**）。

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DEFAULT_DB = join(ROOT, "src-tauri", "assets", "ecdict", "ecdict.db");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const listOf = (f, dflt) => (valueOf(f) ?? dflt).split(",").map((s) => s.trim()).filter(Boolean);

/** 默认样本词表：**英文**（必须命中）／**中文术语**（英汉词典结构性查不到）／**乱码**（未收录）。 */
const HITS = listOf("--hits", "apple,note,computer,method,water");
const ZH = listOf("--zh", "方法论,核聚变");
const NONSENSE = listOf("--nonsense", "zzqxwv,qwertyxz");
const REPEAT = Number(valueOf("--repeat") || 20);
const DB = resolve(valueOf("--db") || DEFAULT_DB);

/** 规范化：与 `src-tauri/src/dictionary.rs::normalize` 同口径（去首尾空白与首尾标点、折叠大小写）。
 *  ⚠️ 权威在 Rust —— 这里只是"数据层要按同一把尺量"，改一处必须改两处（判据会当场对不上）。 */
const TRIM = /^[\s"'“”‘’()[\]{},.;:!?。，、：；！？]+|[\s"'“”‘’()[\]{},.;:!?。，、：；！？]+$/g;
const normalize = (raw) => raw.replace(TRIM, "").toLowerCase();

/** CJK 判定（与 Rust 同口径：`café` 这类带音符的英文词**不算**中文）。 */
const isCjk = (c) => {
  const n = c.codePointAt(0);
  return (
    (n >= 0x3040 && n <= 0x30ff) ||
    (n >= 0x3400 && n <= 0x4dbf) ||
    (n >= 0x4e00 && n <= 0x9fff) ||
    (n >= 0xf900 && n <= 0xfaff) ||
    (n >= 0xac00 && n <= 0xd7af) ||
    (n >= 0x20000 && n <= 0x2fa1f)
  );
};
const looksEnglish = (t) => [...t].some((c) => /[a-z]/.test(c)) && ![...t].some(isCjk);

/** 未收录时那句话（与 Rust `miss_message` 同口径；权威在 Rust，见文件头）。 */
function missMessage(kind, query) {
  switch (kind) {
    case "empty":
      return "没有选中文本 —— 划词查词不会凭空给释义。";
    case "not_english":
      return `本地词典是英汉词典，不含中文词条：「${query}」未收录 ⇒ 需要解释请走 AI（这里不编造本地释义）。`;
    case "not_found":
      return `「${query}」未收录于本地英汉词典（ECDICT） ⇒ 可走 AI 解释；这里不猜。`;
    default:
      return `选中的文本太长 ⇒ 本地词典只查单词/短语。`;
  }
}

/** 查一次：**与 Rust 同一顺序**（先规范化形式、再原样输入；两次都是等值查）。 */
function lookup(db, stmt, raw) {
  const norm = normalize(raw);
  if (!norm) return { status: "not_found", kind: "empty", query: norm };
  if (!looksEnglish(norm)) return { status: "not_found", kind: "not_english", query: norm };
  for (const form of [norm, raw.trim()]) {
    if (!form) continue;
    const row = stmt.get(form);
    if (row) return { status: "found", query: norm, matched: row.word, entry: row };
  }
  return { status: "not_found", kind: "not_found", query: norm };
}

function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function pct(xs, p) {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}

function main() {
  if (!existsSync(DB)) {
    console.error(`[dictionary-bench] 找不到库：${DB}`);
    console.error("  ⇒ **不算通过**。先产出它：node scripts/fetch-ecdict.mjs （或 --sample N 先跑小样本）");
    process.exit(2);
  }
  const sizeBytes = statSync(DB).size;
  let db;
  try {
    db = new DatabaseSync(DB, { readOnly: true });
  } catch (e) {
    console.error(`[dictionary-bench] 打不开库（${DB}）：${e.message} ⇒ **不算通过**`);
    process.exit(2);
  }
  let stmt;
  let count;
  try {
    count = db.prepare("SELECT count(*) AS n FROM stardict").get().n;
    stmt = db.prepare(
      "SELECT word, phonetic, translation, definition, pos, tag, exchange FROM stardict WHERE word = ? LIMIT 1",
    );
  } catch (e) {
    console.error(`[dictionary-bench] 库里没有 stardict 表或列不对：${e.message} ⇒ **不算通过**`);
    process.exit(2);
  }

  const failures = [];
  const latencies = [];
  const results = [];

  const run = (raw, expect) => {
    let out;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < REPEAT; i++) out = lookup(db, stmt, raw);
    const ns = Number(process.hrtime.bigint() - t0) / REPEAT;
    latencies.push(ns / 1e6);
    const ok = expect === "found" ? out.status === "found" : out.status === "not_found";
    if (!ok) failures.push(`${raw}：期望 ${expect}，实际 ${out.status}（${out.kind ?? ""}）`);
    if (out.status === "not_found") {
      // ⭐ "查不到怎么呈现"——把要显示的那句话原样印出来（⛔ 不许是一片空白）。
      out.message = missMessage(out.kind, out.query);
      if (!out.message.trim()) failures.push(`${raw}：未收录却没有任何可显示的文案（静默空白 ✗）`);
    }
    results.push({ raw, expect, ...out, ms: Number((ns / 1e6).toFixed(3)) });
    return out;
  };

  for (const w of HITS) run(w, "found");
  for (const w of ZH) {
    const out = run(w, "not_found");
    if (out.kind !== "not_english") failures.push(`${w}：中文术语应报 not_english，实际 ${out.kind}`);
    if (out.message && !(out.message.includes("英汉") && out.message.includes("AI"))) {
      failures.push(`${w}：未收录文案必须说清"英汉词典"并指向 AI：${out.message}`);
    }
  }
  for (const w of NONSENSE) {
    const out = run(w, "not_found");
    if (out.kind !== "not_found") failures.push(`${w}：乱码应报 not_found，实际 ${out.kind}`);
    // ⛔ 不许编造：未收录的结果里不许出现任何释义字段。
    if (out.entry) failures.push(`${w}：未收录却带回了词条 ⇒ 编造嫌疑 ✗`);
  }

  const hitTotal = HITS.length;
  const hitFound = results.filter((r) => HITS.includes(r.raw) && r.status === "found").length;
  const summary = {
    db: DB,
    dbBytes: sizeBytes,
    entries: count,
    hits: { total: hitTotal, found: hitFound, rate: hitTotal ? hitFound / hitTotal : 0 },
    latencyMs: {
      samples: latencies.length,
      median: Number(median(latencies).toFixed(3)),
      p95: Number(pct(latencies, 95).toFixed(3)),
      max: Number(Math.max(...latencies).toFixed(3)),
    },
    failures,
    results,
  };

  if (has("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[dictionary-bench] 库：${DB}`);
    console.log(`  文件 ${sizeBytes} 字节 / ${count} 条词条`);
    console.log("");
    console.log("① 命中率（英文样本必须都命中）");
    for (const r of results.filter((r) => HITS.includes(r.raw))) {
      const shown =
        r.status === "found"
          ? (r.entry.translation || r.entry.definition || "（无译文/定义）").replace(/\n/g, " ")
          : "MISS";
      console.log(`   ${r.status === "found" ? "✓" : "✗"} ${r.raw.padEnd(12)} ${r.ms.toFixed(3)} ms  ${shown.slice(0, 60)}`);
    }
    console.log(`   ⇒ 命中率 ${hitFound}/${hitTotal} = ${(100 * summary.hits.rate).toFixed(1)}%`);
    console.log("");
    console.log("② 查询耗时（每次查询重复量，含规范化；单位 ms）");
    console.log(
      `   样本 ${latencies.length} 次：中位数 ${summary.latencyMs.median} / p95 ${summary.latencyMs.p95} / 最大 ${summary.latencyMs.max}`,
    );
    console.log("");
    console.log("③ 查不到的词怎么呈现（必须明说未收录 ⇒ 走 AI，⛔ 不许空白、⛔ 不许编造）");
    for (const r of results.filter((r) => r.status === "not_found")) {
      console.log(`   · 「${r.raw}」（${r.kind}）`);
      console.log(`     ${r.message}`);
    }
    console.log("");
    if (failures.length) {
      console.log(`[结果] 有 ${failures.length} 条期望被违反：`);
      for (const f of failures) console.log(`   ✗ ${f}`);
    } else {
      console.log("[结果] 三个读数都符合预期 ✓（⚠️ 这只说明**数据层**过了 —— Rust 那条路由 cargo test 量）");
    }
  }
  db.close();
  process.exit(failures.length ? 1 : 0);
}

main();
