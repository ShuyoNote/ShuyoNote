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
 * ⚠️ **2026-09-20 Windows 侧复核补的两处漏算**（实测，见 `derived-writers.test.mjs` 里那几条新判据）：
 *   1. **原实现是逐行扫**（`for line of text.split("\n")`）⇒ **跨行**的 SQL 一条也抓不到。
 *      真形态：`r#"INSERT INTO\n    chunks (id) VALUES (?1)"#` —— Rust 里写多行 SQL 很常见，
 *      而方向性约定是"**宁可多算（假红，看得见），不可漏算（假绿）**" ⇒ 改成**全文扫**、按 `m.index` 算行号。
 *   2. 表名前的**修饰**没覆盖：`main.chunks`、`"chunks"`、`[chunks]`、`` `chunks` `` ⇒ 都在漏算那一侧。
 *      （`INSERT OR IGNORE` 之类原来就覆盖了。）
 *   没动的：`DELETE FROM` / `UPDATE` **不在本判据范围内** —— 那是"唯一**写入**者"要不要放宽到清空/改写的
 *   口径问题，属 owner/AMD 的决定，不擅自扩大；要放宽请连同规则文本一起改。
 *
 * `chunk_embeddings` 也是派生表（Windows 2026-09-19 复核建议加）：它今天两侧都**没有生产写入者**
 * （唯一那条 INSERT 在 `search.rs` 的 `#[test]` 里）⇒ 现在加进来不会红，但将来谁第一个在
 * 生产代码里写它，就正好撞在这条规则上。零风险，所以收了。
 */
export const DERIVED_TABLES = ["attachment_text", "chunks", "chunk_embeddings"];

// 允许表名带 schema 前缀与各种引号/转义修饰；`\s+` 天然跨越换行（所以配全文扫就能抓跨行形态）。
// 字符类里有：反斜杠（Rust 字符串里的 `\"chunks\"` 在**源码文本**里带反斜杠）、双引号、反引号、方括号。
const INSERT_RE = new RegExp(
  "\\b(?:INSERT(?:\\s+OR\\s+\\w+)?|REPLACE)\\s+INTO\\s+" +
    "[\\\\\"`\\[\\]]*" +
    "(?:\\w+\\.)?" +
    "(" +
    DERIVED_TABLES.join("|") +
    ")\\b",
  "gi",
);

/**
 * 在一段（已剥掉测试尾部的）Rust 源码里找派生表的写入点。
 *
 * **全文扫、不逐行**（跨行 SQL 是真实形态）：行号由命中位置算出来。
 * @returns 命中列表：`{ table, line }`（行号按传入文本计，1 起；报的是 `INSERT` 那一行）
 *
 * ⚠️ **必须逐匹配扫全文、不能逐行扫**（AMD 2026-09-19 修，Windows 复核实测出来的假绿）：
 * 上面那条正则里的 `\s+` **本来就允许跨行**，而本仓自己的长 INSERT 恰恰爱写成多行 ——
 * `INSERT INTO` ⏎ `  chunks (id) VALUES (…)` 这种折行**逐行扫会静默漏过**。
 * 那是"实现把自己的正则废掉了一半"，不是设计取舍；判据见 `derived-writers.test.mjs` 的跨行用例。
 * ⚠️ 每次调用**新建一个正则**（而不是复用模块级 `INSERT_RE`）：`g` 正则有 `lastIndex` 状态，
 * 复用会让"上一次扫到一半失败"影响下一次（这里另配了零宽保护，两条一起兜住挂死）。
 */
export function findDerivedWrites(text) {
  const hits = [];
  const re = new RegExp(INSERT_RE.source, "gi");
  let m;
  while ((m = re.exec(text)) !== null) {
    hits.push({ table: m[1].toLowerCase(), line: text.slice(0, m.index).split("\n").length });
    // 零宽匹配保护（本正则不可能是零宽，但循环里少一个死循环的可能就少一次挂死）
    if (m.index === re.lastIndex) re.lastIndex++;
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
