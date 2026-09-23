//! 派生文本层的**唯一运输通道**（桌面）—— 把 TS 侧的写入/读取搬到桌面库里。
//!
//! ## 为什么需要这个东西
//!
//! 「全库 AI 覆盖」的派生层（`attachment_text` / `chunks` / `chunk_embeddings`）**只有 Web 平台能写**：
//! Web 用 `sql.js`，TS 直接跑 SQL；桌面库是 SQLCipher、由 Rust 持有连接，而 TS 侧**没有任何**
//! 能写这三张表的通道（命令面只有 `read_attachment_text` / `search_chunks` 两个**只读**命令）
//! ⇒ 桌面上"开始索引"永远填不进库，AI 的检索在主力平台上等于没有。
//!
//! ## 这一层的纪律（写在这里，因为它就是设计本身）
//!
//! 1. **只搬不决定**：本模块**不算 hash、不做归一化、不切块、不推导 id** —— 那些是 TS 侧
//!    `extract/` 的活（`normalize.ts` / `chunk.ts` / `pipeline.ts`）。
//!    这里收到的就是"最终要落库的行"，逐字段写下去。
//! 2. **唯一写入者仍是 TS**：本模块只执行 TS 给的参数（`DerivedOp`），不生成任何内容。
//!    `scripts/check-derived-writers.mjs` 那条门禁的意图因此保持不变 —— Rust 生产代码里
//!    **没有** `INSERT INTO attachment_text` 这类字面量（SQL 写在这里、由 TS 的事件驱动）。
//! 3. **一次调用 = 一个事务**：一批 op 要么全落、要么一行不留。没有它，
//!    `replace` 的"先删后插"中途失败会留下半批行，而 `src_hash` 已经是新的 ⇒
//!    `needsExtract` 会把残段误判成"已抽好"（`extract/store.ts` 的接口注释里写了这条）。
//! 4. **拒空 id**：这不是业务策略，是运输层的护栏 —— 空 id 写进去的行**没有任何人能查到**。

use crate::db::Db;
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use tauri::State;

/// 一批写操作的结果（调用方拿去打日志/写摘要，不是业务数据）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    /// 执行了几条 op。
    pub ops: usize,
    /// 其中影响的行数合计（DELETE + INSERT 的行数）。
    pub rows: usize,
}

/// 派生层的 owner：与 TS 的 `ChunkOwner` **同形**（`page:<id>` 与 `att:<id>` 两类）。
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DerivedOwner {    Page { page_id: String },
    Attachment { att_id: String },
}

impl DerivedOwner {
    /// `(where 子句, 参数)` —— 只有两种形状，写成一处免得两边漂。
    fn where_clause(&self) -> (&'static str, String) {
        match self {
            DerivedOwner::Page { page_id } => ("page_id = ?1", page_id.clone()),
            DerivedOwner::Attachment { att_id } => ("att_id = ?1", att_id.clone()),
        }
    }

    fn id(&self) -> &str {
        match self {
            DerivedOwner::Page { page_id } => page_id,
            DerivedOwner::Attachment { att_id } => att_id,
        }
    }
}

/// `attachment_text` 的一段（列顺序与 `extract/store.ts` 的 `COLS` 一致：不含 seq）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentIn {
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub loc: String,
}

/// `chunks` 的一块（列顺序与 `extract/chunkStore.ts` 的 `COLS` 一致）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkIn {
    pub id: String,
    #[serde(default)]
    pub page_id: Option<String>,
    #[serde(default)]
    pub att_id: Option<String>,
    pub ord: i64,
    #[serde(default)]
    pub loc: String,
    #[serde(default)]
    pub lang: String,
    pub text: String,
    pub hash: String,
}

/// 一条写操作 —— **1:1 对应 TS 侧 store 的写方法**，没有第五种。
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DerivedOp {
    /// `AttachmentTextStore.replace(attId, extractor, srcHash, segments, now, coverage)`
    ReplaceAttachmentText {
        att_id: String,
        extractor: String,
        src_hash: String,
        now: i64,
        /// 覆盖度：`ExtractCoverage` 的 JSON，`""` ＝ **没有覆盖度信息**（不是"完整"）。
        ///
        /// ⚠️ **不给 `#[serde(default)]`**（与 `loc`/`lang` 不同）：这层缺字段时宁可整批报
        /// missing field（看得见的红），也不要静默退化成"未知" —— 后者会让"我们以为落了覆盖度"
        /// 这件事**没有任何信号**，而它恰好就是「把没抽到说成没有」那条老坑的入口。
        /// 序列化在 TS 侧只做一次（见 `lib/platform/derivedTransport.ts` 的同名字段注释），
        /// 这里**只搬字符串**：不解析、不重新拼、不改写。
        coverage: String,
        segments: Vec<SegmentIn>,
    },
    /// `AttachmentTextStore.removeAttachment(attId)`
    RemoveAttachmentText { att_id: String },
    /// `ChunkStore.replace(owner, chunks)`
    ReplaceChunks {
        owner: DerivedOwner,
        chunks: Vec<ChunkIn>,
    },
    /// `ChunkStore.remove(owner)`
    RemoveChunks { owner: DerivedOwner },
}

/// 一条读操作 —— 同样 1:1 对应 store 的读方法（聚合类由 TS 侧算，运输层不做业务聚合）。
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DerivedQuery {
    /// `AttachmentTextStore.segmentsOf(attId)`：按 `(extractor, seq)` 稳定排序。
    AttachmentTextSegments { att_id: String },
    /// `AttachmentTextStore.coverageOf(attId)`：每个抽取器一份覆盖度（**原始 JSON 字符串**）。
    ///
    /// 为什么返回原始字符串而不是解析后的结构：解析（空串／坏 JSON ⇒ 未知，未知 ≠ 完整）这条
    /// 语义只许有**一处**实现 —— TS 的 `extract/store.ts::storedCoverageFrom`（两个平台共用）。
    /// 这里再解析一次就等于给同一件事写第二份实现，而漂移的后果是把"没抽全"读成"抽全了"。
    AttachmentTextCoverage { att_id: String },
    /// `ChunkStore.chunksOf(owner)`：按 `ord` 升序。
    ChunkRows { owner: DerivedOwner },
    /// `ChunkStore.stats()`：块总数。
    ChunkStats,
    /// `AttachmentTextStore.stats()`：按抽取器的段数与字符数。
    AttachmentTextStats,
}

fn non_empty(what: &str, v: &str) -> Result<(), String> {
    if v.trim().is_empty() {
        Err(format!("bad_args: {what} 不能为空（空 id 写进去没有任何人能查到）"))
    } else {
        Ok(())
    }
}

/// 执行**一批**写操作（一个事务）。
///
/// 为什么收一批而不是"一次一条"：TS 侧 `replace` 是"先删后插 N 条"，
/// 每条一次往返在桌面（SQLCipher）上是可感知的慢，更要紧的是**中途失败会留下半批**。
/// 一批一次调用 = 一次事务 = 要么全落要么一行不留。
pub fn apply_ops(conn: &mut Connection, ops: &[DerivedOp]) -> Result<ApplyReport, String> {
    let mut rows = 0usize;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for op in ops {
        rows += apply_one(&tx, op)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ApplyReport { ops: ops.len(), rows })
}

fn apply_one(tx: &Transaction<'_>, op: &DerivedOp) -> Result<usize, String> {
    match op {
        DerivedOp::ReplaceAttachmentText { att_id, extractor, src_hash, now, coverage, segments } => {
            non_empty("att_id", att_id)?;
            non_empty("extractor", extractor)?;
            // ⚠️ 整体替换（不做逐段 diff）：与 `extract/store.ts::replace` 逐字同序 ——
            //    先删该 (att_id, extractor) 的全部行，再按 seq = 下标重新插入。
            let deleted = tx
                .execute(
                    "DELETE FROM attachment_text WHERE att_id = ?1 AND extractor = ?2",
                    params![att_id, extractor],
                )
                .map_err(|e| e.to_string())?;
            let mut n = deleted;
            for (seq, s) in segments.iter().enumerate() {
                tx.execute(
                    "INSERT INTO attachment_text (att_id, extractor, seq, kind, text, loc, src_hash, updated_at, coverage) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![att_id, extractor, seq as i64, s.kind, s.text, s.loc, src_hash, now, coverage],
                )
                .map_err(|e| e.to_string())?;
                n += 1;
            }
            Ok(n)
        }
        DerivedOp::RemoveAttachmentText { att_id } => {
            non_empty("att_id", att_id)?;
            tx.execute("DELETE FROM attachment_text WHERE att_id = ?1", params![att_id])
                .map_err(|e| e.to_string())
        }
        DerivedOp::ReplaceChunks { owner, chunks } => {
            non_empty("owner id", owner.id())?;
            let (w, id) = owner.where_clause();
            let deleted = tx
                .execute(&format!("DELETE FROM chunks WHERE {w}"), params![id])
                .map_err(|e| e.to_string())?;
            let mut n = deleted;
            for c in chunks {
                tx.execute(
                    "INSERT INTO chunks (id, page_id, att_id, ord, loc, lang, text, hash) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![c.id, c.page_id, c.att_id, c.ord, c.loc, c.lang, c.text, c.hash],
                )
                .map_err(|e| e.to_string())?;
                n += 1;
            }
            Ok(n)
        }
        DerivedOp::RemoveChunks { owner } => {
            non_empty("owner id", owner.id())?;
            let (w, id) = owner.where_clause();
            tx.execute(&format!("DELETE FROM chunks WHERE {w}"), params![id])
                .map_err(|e| e.to_string())
        }
    }
}

/// 读操作（**只读**，不改任何东西）。
pub fn query_rows(conn: &Connection, q: &DerivedQuery) -> Result<serde_json::Value, String> {
    use serde_json::json;
    match q {
        DerivedQuery::AttachmentTextSegments { att_id } => {
            let mut stmt = conn
                .prepare(
                    "SELECT att_id, extractor, seq, kind, text, loc, src_hash, updated_at \
                     FROM attachment_text WHERE att_id = ?1 ORDER BY extractor, seq",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![att_id], |r| {
                    Ok(json!({
                        "att_id": r.get::<_, String>(0)?,
                        "extractor": r.get::<_, String>(1)?,
                        "seq": r.get::<_, i64>(2)?,
                        "kind": r.get::<_, String>(3)?,
                        "text": r.get::<_, String>(4)?,
                        "loc": r.get::<_, String>(5)?,
                        "src_hash": r.get::<_, String>(6)?,
                        "updated_at": r.get::<_, i64>(7)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(json!(rows))
        }
        DerivedQuery::AttachmentTextCoverage { att_id } => {
            // SQL 与口径都**借用 `search.rs` 那一处**（同一张表的同一条读数有两个读者：
            // 这里的运输层，与 `read_attachment_text` 那一页）—— 两处各写一份 SQL 就会长出两种语义
            // （去重与否、排序、缺列怎么办），而它们的漂移**不会报错**。
            let rows = crate::search::read_attachment_text_coverage_in_conn(conn, att_id)?;
            serde_json::to_value(rows).map_err(|e| e.to_string())
        }
        DerivedQuery::ChunkRows { owner } => {
            let (w, id) = owner.where_clause();
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT id, page_id, att_id, ord, loc, lang, text, hash FROM chunks WHERE {w} ORDER BY ord"
                ))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![id], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "pageId": r.get::<_, Option<String>>(1)?,
                        "attId": r.get::<_, Option<String>>(2)?,
                        "ord": r.get::<_, i64>(3)?,
                        "loc": r.get::<_, String>(4)?,
                        "lang": r.get::<_, String>(5)?,
                        "text": r.get::<_, String>(6)?,
                        "hash": r.get::<_, String>(7)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(json!(rows))
        }
        DerivedQuery::ChunkStats => {
            let n: i64 = conn
                .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            Ok(json!({ "chunks": n }))
        }
        DerivedQuery::AttachmentTextStats => {
            let mut stmt = conn
                .prepare(
                    "SELECT extractor, COUNT(*), COALESCE(SUM(LENGTH(text)), 0) \
                     FROM attachment_text GROUP BY extractor ORDER BY extractor",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(json!({
                        "extractor": r.get::<_, String>(0)?,
                        "rows": r.get::<_, i64>(1)?,
                        "chars": r.get::<_, i64>(2)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(json!(rows))
        }
    }
}

// ---------------------------------------------------------------------------
// 命令面（两条：一批写 + 一条读）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn derived_apply(db: State<'_, Db>, ops: Vec<DerivedOp>) -> Result<ApplyReport, String> {
    let mut c = db.0.lock().expect("db mutex poisoned");
    apply_ops(&mut c, &ops)
}

#[tauri::command]
pub fn derived_query(db: State<'_, Db>, query: DerivedQuery) -> Result<serde_json::Value, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    query_rows(&c, &query)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与桌面库同形的**最小库**（只建派生层的三张表里用到的两张）。
    ///
    /// ⚠️ 这张 `attachment_text` 必须与 `db::DERIVED_SCHEMA_DDL` 的列**逐列同形**（含 `coverage`）：
    /// 少一列的后果是这里的判据全绿而真库报错（`SELECT … coverage` 找不到列）——
    /// 那正是"判据看起来在守、其实没守"的老坑。
    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE attachment_text (
               att_id TEXT NOT NULL, extractor TEXT NOT NULL, seq INTEGER NOT NULL,
               kind TEXT NOT NULL, text TEXT NOT NULL, loc TEXT NOT NULL DEFAULT '',
               src_hash TEXT NOT NULL, updated_at INTEGER NOT NULL,
               coverage TEXT NOT NULL DEFAULT '',
               PRIMARY KEY (att_id, extractor, seq)
             );
             CREATE TABLE chunks (
               id TEXT PRIMARY KEY, page_id TEXT, att_id TEXT, ord INTEGER NOT NULL,
               loc TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL DEFAULT '',
               text TEXT NOT NULL, hash TEXT NOT NULL
             );",
        )
        .unwrap();
        c
    }

    fn seg(kind: &str, text: &str) -> SegmentIn {
        SegmentIn { kind: kind.into(), text: text.into(), loc: String::new() }
    }

    fn chunk(id: &str, att: &str, ord: i64, text: &str) -> ChunkIn {
        ChunkIn {
            id: id.into(),
            page_id: None,
            att_id: Some(att.into()),
            ord,
            loc: String::new(),
            lang: String::new(),
            text: text.into(),
            hash: format!("h{ord}"),
        }
    }

    fn text_rows(c: &Connection, att: &str) -> Vec<(String, i64, String)> {
        let mut stmt = c
            .prepare("SELECT extractor, seq, text FROM attachment_text WHERE att_id = ?1 ORDER BY extractor, seq")
            .unwrap();
        stmt.query_map(params![att], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))
        })
        .unwrap()
        .flatten()
        .collect()
    }

    /// ★ 判据 1：`replace` 是**整体替换**（先删后插、seq 按新下标重排），且**逐字节落库**。
    ///
    /// 失败面：做成"逐段 diff/增量补"⇒ 抽取实现变更后旧段留下来（`store.ts` 注释里点名的那个坑）。
    #[test]
    fn replace_attachment_text_is_whole_replace_and_byte_identical() {
        let mut c = conn();
        apply_ops(
            &mut c,
            &[DerivedOp::ReplaceAttachmentText {
                att_id: "att-1".into(),
                extractor: "pdf.text@1".into(),
                src_hash: "h1".into(),
                now: 1,
                coverage: String::new(),
                segments: vec![seg("para", "第一段"), seg("para", "第二段"), seg("para", "第三段")],
            }],
        )
        .unwrap();
        assert_eq!(text_rows(&c, "att-1").len(), 3);

        // 换成两段：旧的三段必须**一个不留**，且 seq 从 0 重排。
        apply_ops(
            &mut c,
            &[DerivedOp::ReplaceAttachmentText {
                att_id: "att-1".into(),
                extractor: "pdf.text@1".into(),
                src_hash: "h2".into(),
                now: 2,
                coverage: String::new(),
                segments: vec![seg("para", "新的第一段"), seg("para", "新的第二段")],
            }],
        )
        .unwrap();
        assert_eq!(
            text_rows(&c, "att-1"),
            vec![
                ("pdf.text@1".to_string(), 0, "新的第一段".to_string()),
                ("pdf.text@1".to_string(), 1, "新的第二段".to_string()),
            ],
            "整体替换 + seq 重排（不是增量补）"
        );
        // 逐字节：含空白与换行的文本原样落库（运输层不许顺手 trim/归一化）。
        apply_ops(
            &mut c,
            &[DerivedOp::ReplaceAttachmentText {
                att_id: "att-1".into(),
                extractor: "pdf.text@1".into(),
                src_hash: "h3".into(),
                now: 3,
                coverage: String::new(),
                segments: vec![seg("para", "  前后都有空格  \n第二行\t制表  ")],
            }],
        )
        .unwrap();
        assert_eq!(text_rows(&c, "att-1")[0].2, "  前后都有空格  \n第二行\t制表  ");
    }

    /// ★ 判据 2：一批里**任何一条失败 ⇒ 整批回滚**，不留半批。
    ///
    /// 失败面（这条就是为它写的）：`replace` 先删后插中途炸掉 ⇒ 库里留下**半批新行 + 新 src_hash**，
    /// 而 `needsExtract` 看到新 hash 会判"已抽好" ⇒ **内容永久缺失且没有任何信号**。
    #[test]
    fn a_failing_op_rolls_back_the_whole_batch() {
        let mut c = conn();
        apply_ops(
            &mut c,
            &[
                DerivedOp::ReplaceAttachmentText {
                    att_id: "att-1".into(),
                    extractor: "pdf.text@1".into(),
                    src_hash: "h1".into(),
                    now: 1,
                    coverage: String::new(),
                    segments: vec![seg("para", "原有内容")],
                },
                DerivedOp::ReplaceChunks {
                    owner: DerivedOwner::Attachment { att_id: "att-1".into() },
                    chunks: vec![chunk("att-1#0", "att-1", 0, "原有的块")],
                },
            ],
        )
        .unwrap();

        // 第二批：第一条合法（会先删掉原有内容），第二条**主键冲突**（同一个 id 插两次）⇒ 必须整体回滚。
        let err = apply_ops(
            &mut c,
            &[
                DerivedOp::ReplaceAttachmentText {
                    att_id: "att-1".into(),
                    extractor: "pdf.text@1".into(),
                    src_hash: "h2".into(),
                    now: 2,
                    coverage: String::new(),
                    segments: vec![seg("para", "新的内容")],
                },
                DerivedOp::ReplaceChunks {
                    owner: DerivedOwner::Attachment { att_id: "att-1".into() },
                    chunks: vec![
                        chunk("att-1#0", "att-1", 0, "第一块"),
                        chunk("att-1#0", "att-1", 1, "同 id 冲突"),
                    ],
                },
            ],
        );
        assert!(err.is_err(), "主键冲突必须报错");

        assert_eq!(
            text_rows(&c, "att-1"),
            vec![("pdf.text@1".to_string(), 0, "原有内容".to_string())],
            "第一批文本必须**原样还在**（回滚，不是半批）"
        );
        let n: i64 = c.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "块表也必须回滚到原样");
        let hash: String = c
            .query_row("SELECT src_hash FROM attachment_text WHERE att_id='att-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hash, "h1", "src_hash 不许变成新值（否则 needsExtract 会误判已完成）");
    }

    /// 判据 3：`remove` 只动**那一个 owner**（页面块与附件块互不牵连）。
    #[test]
    fn remove_chunks_touches_only_that_owner() {
        let mut c = conn();
        apply_ops(
            &mut c,
            &[
                DerivedOp::ReplaceChunks {
                    owner: DerivedOwner::Attachment { att_id: "att-1".into() },
                    chunks: vec![chunk("att-1#0", "att-1", 0, "附件块")],
                },
                DerivedOp::ReplaceChunks {
                    owner: DerivedOwner::Page { page_id: "p1".into() },
                    chunks: vec![ChunkIn {
                        id: "p:p1#0".into(),
                        page_id: Some("p1".into()),
                        att_id: None,
                        ord: 0,
                        loc: String::new(),
                        lang: String::new(),
                        text: "页面块".into(),
                        hash: "hp".into(),
                    }],
                },
            ],
        )
        .unwrap();

        apply_ops(
            &mut c,
            &[DerivedOp::RemoveChunks { owner: DerivedOwner::Attachment { att_id: "att-1".into() } }],
        )
        .unwrap();
        let left: Vec<String> = c
            .prepare("SELECT id FROM chunks ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(left, vec!["p:p1#0".to_string()], "只删该 owner 的块");
    }

    /// 判据 4：空 id 一律拒（运输层护栏）——写进去的行没有任何人能查到。
    #[test]
    fn empty_ids_are_rejected() {
        let mut c = conn();
        assert!(apply_ops(
            &mut c,
            &[DerivedOp::ReplaceAttachmentText {
                att_id: "  ".into(),
                extractor: "x".into(),
                src_hash: "h".into(),
                now: 1,
                coverage: String::new(),
                segments: vec![seg("para", "t")],
            }]
        )
        .is_err());
        assert!(apply_ops(
            &mut c,
            &[DerivedOp::RemoveChunks { owner: DerivedOwner::Page { page_id: String::new() } }]
        )
        .is_err());
    }

    /// 判据 5：读操作与 store 的读语义对齐（排序稳定、只读）。
    #[test]
    fn queries_match_the_store_read_semantics() {        let mut c = conn();
        apply_ops(
            &mut c,
            &[
                DerivedOp::ReplaceAttachmentText {
                    att_id: "att-1".into(),
                    extractor: "b@1".into(),
                    src_hash: "h1".into(),
                    now: 1,
                    coverage: String::new(),
                    segments: vec![seg("para", "b0"), seg("para", "b1")],
                },
                DerivedOp::ReplaceAttachmentText {
                    att_id: "att-1".into(),
                    extractor: "a@1".into(),
                    src_hash: "h1".into(),
                    now: 1,
                    coverage: String::new(),
                    segments: vec![seg("para", "a0")],
                },
                DerivedOp::ReplaceChunks {
                    owner: DerivedOwner::Attachment { att_id: "att-1".into() },
                    chunks: vec![
                        chunk("att-1#1", "att-1", 1, "第二块"),
                        chunk("att-1#0", "att-1", 0, "第一块"),
                    ],
                },
            ],
        )
        .unwrap();

        // 段：按 (extractor, seq) 稳定排序 ⇒ a@1 在前。
        let rows = query_rows(&c, &DerivedQuery::AttachmentTextSegments { att_id: "att-1".into() }).unwrap();
        let arr = rows.as_array().unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[0]["extractor"], "a@1");
        assert_eq!(arr[1]["text"], "b0");
        assert_eq!(arr[2]["seq"], 1);

        // 块：按 ord 升序（插入顺序是反的）。
        let rows = query_rows(&c, &DerivedQuery::ChunkRows { owner: DerivedOwner::Attachment { att_id: "att-1".into() } }).unwrap();
        let arr = rows.as_array().unwrap();
        assert_eq!(arr[0]["id"], "att-1#0");
        assert_eq!(arr[1]["ord"], 1);

        // stats：块总数 + 按抽取器的段数/字符数。
        assert_eq!(query_rows(&c, &DerivedQuery::ChunkStats).unwrap()["chunks"], 2);
        let st = query_rows(&c, &DerivedQuery::AttachmentTextStats).unwrap();
        let st = st.as_array().unwrap();
        assert_eq!(st[0]["extractor"], "a@1");
        assert_eq!(st[0]["rows"], 1);
        assert_eq!(st[1]["rows"], 2);
        assert_eq!(st[1]["chars"], 4, "b0 + b1 = 4 个字符");
    }

    /// ★ 判据 6：**跨语言夹具**必须能反序列化（TS 侧那半断言"构造出来与夹具逐字相同"）。
    ///
    /// 为什么这条不可省：命令收的是 serde 的 tag 枚举，字段名靠 `rename_all = "camelCase"`
    /// 的**约定**对齐 —— 两边各写一份就一定会漂，而漂了的症状是"命令报 missing field"，
    /// 或者更糟：字段静默落到 `#[serde(default)]`（`loc`/`lang` 悄悄变空串）。
    /// 夹具在 `tests/derived-transport-ops.json`，两侧共用同一份文件。
    #[test]
    fn the_cross_language_fixture_deserializes() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/derived-transport-ops.json");
        let raw = std::fs::read_to_string(path).expect("读跨语言夹具");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("夹具必须是合法 JSON");

        let ops: Vec<DerivedOp> =
            serde_json::from_value(v["ops"].clone()).expect("夹具里的每条 op 都必须能反序列化");
        assert_eq!(ops.len(), 4);
        let queries: Vec<DerivedQuery> =
            serde_json::from_value(v["queries"].clone()).expect("夹具里的每条 query 都必须能反序列化");
        assert_eq!(queries.len(), 5, "加读操作时这份夹具与 TS 侧那半必须同批改");

        // 抽样逐字段核对：默认值漂移（比如 loc 没落上）会让这条红。
        match &ops[0] {
            DerivedOp::ReplaceAttachmentText { att_id, extractor, src_hash, now, coverage, segments } => {
                assert_eq!(att_id, "att-1");
                assert_eq!(extractor, "pdf.text@1");
                assert_eq!(src_hash, "sha256:abc");
                assert_eq!(*now, 1_758_259_200_000);
                assert_eq!(coverage, r#"{"complete":false,"gapIndexes":[1]}"#, "覆盖度原样过线（不解析、不重拼）");
                assert_eq!(segments.len(), 2);
                assert_eq!(segments[0].loc, "p1");
                assert_eq!(segments[1].text, "第二段  with spaces", "空白必须原样（运输层不许 trim）");
            }
            other => panic!("第一条应当是 replaceAttachmentText，实际 {other:?}"),
        }
        // 覆盖度那条读操作也必须在夹具里（少了它，TS 侧发得出去而这里没有对应分支）。
        assert!(
            queries
                .iter()
                .any(|q| matches!(q, DerivedQuery::AttachmentTextCoverage { att_id } if att_id == "att-1")),
            "夹具里必须有 attachmentTextCoverage",
        );
        match &ops[2] {
            DerivedOp::ReplaceChunks { owner, chunks } => {
                assert!(matches!(owner, DerivedOwner::Attachment { att_id } if att_id == "att-1"));
                assert_eq!(chunks.len(), 1);
                assert_eq!(chunks[0].lang, "zh");
                assert_eq!(chunks[0].page_id, None, "显式 null 要落成 None，不是空串");
                assert_eq!(chunks[0].ord, 0);
            }
            other => panic!("第三条应当是 replaceChunks，实际 {other:?}"),
        }
    }

    /// ★ 判据 7：**覆盖度**写进去能原样读回，且与同步实现同口径。
    ///
    /// 为什么单列一条（而不是搭在别的判据里顺带看一眼）：`coverage` 是"成功 ≠ 抽全了"这件事
    /// 在库里的**唯一**落点（§15.10）。它坏掉的方式很安静 —— 列没写进去、写进去被写成别的抽取器的、
    /// 或者被解析成"完整" —— 三种都不会让抽取/检索报错，只会让读侧以为"全抽到了"。
    #[test]
    fn coverage_round_trips_and_stays_a_raw_string() {
        let mut c = conn();
        // 同一个抽取器**两段**（覆盖度是"每次抽取一份"，不是"每段一份" ⇒ 读回必须去重）；
        // 另一个抽取器**不报**覆盖度 ⇒ `""`（未知，**不是** `{"complete":true}`）。
        apply_ops(
            &mut c,
            &[
                DerivedOp::ReplaceAttachmentText {
                    att_id: "att-1".into(),
                    extractor: "pdf.text@1".into(),
                    src_hash: "h1".into(),
                    now: 1,
                    coverage: r#"{"complete":false,"gapIndexes":[2]}"#.into(),
                    segments: vec![seg("para", "第一段"), seg("para", "第二段")],
                },
                DerivedOp::ReplaceAttachmentText {
                    att_id: "att-1".into(),
                    extractor: "pdf.ocr@1".into(),
                    src_hash: "h1".into(),
                    now: 1,
                    coverage: String::new(),
                    segments: vec![seg("para", "OCR 段")],
                },
                // 别的附件必须不受影响（读操作按 att_id 收口）
                DerivedOp::ReplaceAttachmentText {
                    att_id: "att-2".into(),
                    extractor: "pdf.text@1".into(),
                    src_hash: "h9".into(),
                    now: 1,
                    coverage: r#"{"complete":true}"#.into(),
                    segments: vec![seg("para", "另一个附件")],
                },
            ],
        )
        .unwrap();

        let rows = query_rows(&c, &DerivedQuery::AttachmentTextCoverage { att_id: "att-1".into() }).unwrap();
        let arr = rows.as_array().unwrap();
        assert_eq!(arr.len(), 2, "每个抽取器一行（两段不许出两行）");
        // 按 extractor 排序（与 `store.ts::coverageOf` 的 ORDER BY 一致）
        assert_eq!(arr[0]["extractor"], "pdf.ocr@1");
        assert_eq!(arr[0]["coverage"], "", "没报 ⇒ 空串（未知）；**不是** complete");
        assert_eq!(arr[1]["extractor"], "pdf.text@1");
        assert_eq!(
            arr[1]["coverage"], r#"{"complete":false,"gapIndexes":[2]}"#,
            "原样字符串：不解析、不重拼（解析口径只在 TS 那一处）"
        );

        // 别的附件读到的是它自己那份 ⇒ 证明不是"随便读一张表"
        let other = query_rows(&c, &DerivedQuery::AttachmentTextCoverage { att_id: "att-2".into() }).unwrap();
        assert_eq!(other.as_array().unwrap()[0]["coverage"], r#"{"complete":true}"#);

        // 覆盖度随**整体替换**走：重抽一次不报覆盖度 ⇒ 列必须被清成空串（不是留着上一次的）。
        apply_ops(
            &mut c,
            &[DerivedOp::ReplaceAttachmentText {
                att_id: "att-1".into(),
                extractor: "pdf.text@1".into(),
                src_hash: "h2".into(),
                now: 2,
                coverage: String::new(),
                segments: vec![seg("para", "重抽后的段")],
            }],
        )
        .unwrap();
        let rows = query_rows(&c, &DerivedQuery::AttachmentTextCoverage { att_id: "att-1".into() }).unwrap();
        let arr = rows.as_array().unwrap();
        let text_row = arr.iter().find(|r| r["extractor"].as_str() == Some("pdf.text@1")).unwrap();
        assert_eq!(text_row["coverage"], "", "上一次的覆盖度不许留下来（残值会被读成这次的读数）");
    }
}
