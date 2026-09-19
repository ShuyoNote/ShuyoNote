// 派生表的**唯一写入者**规则：`attachment_text` / `chunks` 只由 TS 抽取管线写，
// Rust 侧**非测试代码**一律不许写这两张表（读了可以 —— 读那一处两边各写一份，是另一件事）。
//
// 为什么要做成机器判据（Windows 2026-09-18 的裁定原文："否则它只活在文档里 —— 这一轮已经证明
// '只写在文档里的规则会漂'"）：
//   · `chunks` / `attachment_text` 的写入路径一旦在两侧各长一条，症状是**同一份附件两套派生文本**，
//     而两边的测试都会绿（各测各的）；
//   · Rust 侧今天**确实有两处** INSERT，但都在 `#[cfg(test)]` 里（播种夹具）—— 规则不能写成
//     "Rust 里不许出现这两张表"，否则判据一开始就红，真回归会被淹没。
//     ⇒ 用与文档内容门禁**同一套**区域判定（`rust-scan.mjs` 的 `productionText`）把测试尾部切掉再找。
//
// 方向性约定：**宁可多算（假红，看得见），不可漏算（假绿）** —— 与 `rust-scan.mjs` 一致。

/**
 * 生产写入语句的判据（大小写不敏感；`INSERT INTO` / `INSERT OR REPLACE INTO` / `REPLACE INTO`）。
 *
 * `chunk_embeddings` 也是派生表（Windows 2026-09-19 复核建议加）：它今天两侧都**没有生产写入者**
 * （唯一那条 INSERT 在 `search.rs` 的 `#[test]` 里）⇒ 现在加进来不会红，但将来谁第一个在
 * 生产代码里写它，就正好撞在这条规则上。零风险，所以收了。
 */
export const DERIVED_TABLES = ["attachment_text", "chunks", "chunk_embeddings"];

const INSERT_RE = new RegExp(
  String.raw`\b(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+(${DERIVED_TABLES.join("|")})\b`,
  "gi",
);

/**
 * 在一段（已剥掉测试尾部的）Rust 源码里找派生表的写入点。
 * @returns 命中列表：`{ table, line }`（行号按传入文本计，1 起；报的是 `INSERT` 那一行）
 *
 * ⚠️ **必须逐匹配扫全文、不能逐行扫**（AMD 2026-09-19 修，Windows 复核实测出来的假绿）：
 * 上面那条正则里的 `\s+` **本来就允许跨行**，而本仓自己的长 INSERT 恰恰爱写成多行 ——
 * `INSERT INTO` ⏎ `  chunks (id) VALUES (…)` 这种折行**逐行扫会静默漏过**。
 * 那是"实现把自己的正则废掉了一半"，不是设计取舍；判据见 `derived-writers.test.mjs` 的跨行用例。
 */
export function findDerivedWrites(text) {
  const hits = [];
  const re = new RegExp(INSERT_RE.source, "gi");
  let m;
  while ((m = re.exec(text)) !== null) {
    hits.push({ table: m[1].toLowerCase(), line: text.slice(0, m.index).split("\n").length });
  }
  return hits;
}

/**
 * 给定 `{ path, text }`（text 已剥测试尾部）清单，返回违规项。
 * @returns `{ path, table, line }[]`
 */
export function scanDerivedWriters(files) {
  const out = [];
  for (const f of files) {
    for (const hit of findDerivedWrites(f.text)) {
      out.push({ path: f.path, table: hit.table, line: hit.line });
    }
  }
  return out;
}
