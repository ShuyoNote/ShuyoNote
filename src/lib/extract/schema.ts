// 派生文本层的表结构 —— **单一事实源**。
// 契约与取舍见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §6.1 / §15.5。
//
// 为什么 DDL 要抽成常量而不是各平台各写一份：
// 桌面（Rust `db.rs`）与 Web（TS `sqliteStore.ts`）都要建这三张表，
// **两份 DDL 漂移的后果是"同一份数据在两个平台上读不出来"**，而且不会有任何编译期报错。
// 所以这里导出字符串，Web 侧直接执行，Rust 侧照抄并加一条一致性断言（见 §7 的验收项）。
//
// 三张表都是**本地派生缓存**：只读、可重建、**不进同步 / 不进备份 / 不进导出**。

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
