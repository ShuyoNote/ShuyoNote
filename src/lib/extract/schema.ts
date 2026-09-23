// 派生文本层的表结构 —— **单一事实源**。
// 契约与取舍见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §6.1 / §15.5。
//
// 为什么 DDL 要抽成常量而不是各平台各写一份：
// 桌面（Rust `db.rs`）与 Web（TS `sqliteStore.ts`）都要建这三张表，
// **两份 DDL 漂移的后果是"同一份数据在两个平台上读不出来"**，而且不会有任何编译期报错。
// 所以这里导出字符串，Web 侧直接执行，Rust 侧照抄并加一条一致性断言（见 §7 的验收项）。
//
// 三张表都是**本地派生缓存**：只读、可重建、**不进同步 / 不进备份 / 不进导出**。
//
// ⚠️⚠️ **本文件里的反引号会进一条判据的解析** —— 保守纪律：**注释里别写反引号**。
// 判据在 Rust 侧（`db.rs::tests::derived_schema_matches_the_ts_source_of_truth`）：它把本文件读进去、
// **按反引号切分**、取奇数段当"模板字符串体"，再要求恰好 6 条 DDL 与 `DERIVED_SCHEMA_DDL` 逐字相同。
//
// ★ **精确规则**（2026-09-23；判据口径：按反引号切分 → 取奇数段 → 再按 CREATE 前缀过滤 → 要求恰好 6 条。
//   这一格是**三方各测一半**拼出来的：macOS 测到"落单"那格、Windows 测到"CREATE 前缀"那格、我复刻了两者）：
//   · 注释里写**成对**的普通反引号段（例如 exec() / run 那种）   ⇒ ✅ 绿（当前文件里本来就有 6 对）
//   · 写**一个落单**的反引号                                     ⇒ ❌ 红，但报「**解析出 0 条**」（奇偶翻转 ⇒ 6 条 DDL 全被跳过）
//   · 写一段**以 CREATE TABLE / CREATE INDEX 开头**的反引号段     ⇒ ❌ 红（解析出 **7 条**）
//   ⚠️ **我在这里先后写错过两层**（都公开订正过）：先说"多一对反引号就打乱奇偶"——把"落单"说成了"成对"；
//      改完后又只留下"以 CREATE 开头"那一格、漏掉"落单 ⇒ 0 条"。现在两格都在上面这张表里。
//   ⇒ 保守纪律仍然是一句话：**注释里别写反引号**（尤其别落单、别让段以那两个前缀开头）——它便宜、记得住。
//     真要走精确路线，该改的是**判据本身**（取全部段再按前缀过滤，并要求前缀后面还得跟一个表/索引名）；
//     那是 `db.rs` 的文件，归属与取舍见方案 §8.1。
//
// ⚠️ **coverage 列（2026-09-23 加）**：存的是 ExtractCoverage 的 JSON，空串 ＝ **没有覆盖度信息**
// （旧数据／抽取器未报）——**不许把它读成"完整"**。语义与理由：
//  · 这一列回答的是"**这份派生文本抽全了没有**"（§15.10：成功 ≠ 抽全了）。没有它，
//    「混合文档里那几页扫描件没抽到内容」与「文件里本来就没有」在 AI 工具面**长得一模一样**；
//  · **刻意冗余在每个段行上**（而不是另起一张表）：派生层是可重建缓存、replace() 整体替换
//    ⇒ 一行一次写，读侧少一次 join/额外查询；按本仓"少一张表就少一处三轴漂移"的口径选它
//    （同 §15.8 里选 RasterizedPage 而不是再加一个 encode 能力的理由）；
//  · 老库靠**两侧各一条幂等 ALTER TABLE … ADD COLUMN** 补（Rust db.rs::migrate / Web
//    sqliteStore.ts::migrate），因为 CREATE TABLE IF NOT EXISTS 不会给已存在的表加列。

/** 一行 = 一个抽取段（不是"一份附件一行"）：段自带定位，是回链与块级检索的最小单位。 */
export const ATTACHMENT_TEXT_DDL = `
CREATE TABLE IF NOT EXISTS attachment_text (
  att_id     TEXT    NOT NULL,
  extractor  TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  loc        TEXT    NOT NULL DEFAULT '',
  src_hash   TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  coverage   TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (att_id, extractor, seq)
);`;

export const ATTACHMENT_TEXT_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_attachment_text_src ON attachment_text(att_id, src_hash);`;

/** 分块（P2 用；P1 只建表不写）。页面块与附件块统一进这一张，检索不再按"页"为单位。 */
export const CHUNKS_DDL = `
CREATE TABLE IF NOT EXISTS chunks (
  id       TEXT PRIMARY KEY,
  page_id  TEXT,
  att_id   TEXT,
  ord      INTEGER NOT NULL,
  loc      TEXT NOT NULL DEFAULT '',
  lang     TEXT NOT NULL DEFAULT '',
  text     TEXT NOT NULL,
  hash     TEXT NOT NULL
);`;

/** 每条都是一条**单语句** —— 不依赖调用方用 `exec()` 支持多语句（sql.js 的 `run` 只吃一条）。 */
export const CHUNKS_INDEX_PAGE_DDL =
  `CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(page_id);`;

export const CHUNKS_INDEX_ATT_DDL =
  `CREATE INDEX IF NOT EXISTS idx_chunks_att ON chunks(att_id);`;

/** 块级嵌入（P2 用；与既有 page_embeddings 同构：模型 + 维度 + 内容哈希）。 */
export const CHUNK_EMBEDDINGS_DDL = `
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id   TEXT NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     TEXT NOT NULL,
  hash       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chunk_id, model)
);`;

/** 建表顺序（外键无关，但按依赖排便于阅读）。全部 `IF NOT EXISTS` ⇒ 幂等。
 *  **每条都是单语句**：不要求调用方实现"多语句 exec"。 */
export const DERIVED_SCHEMA_DDL: readonly string[] = [
  ATTACHMENT_TEXT_DDL,
  ATTACHMENT_TEXT_INDEX_DDL,
  CHUNKS_DDL,
  CHUNKS_INDEX_PAGE_DDL,
  CHUNKS_INDEX_ATT_DDL,
  CHUNK_EMBEDDINGS_DDL,
];
