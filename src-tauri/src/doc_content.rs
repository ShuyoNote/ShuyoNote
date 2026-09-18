//! 「文档内容」那一层：**read / write / merge / derive**（阶段 0「接口收口」）。
//!
//! 上位文档：`docs/plans/2026-09-18-doc-content-layer-inventory.md`（API 草案在它 §3、边界规则在 §4）。
//!
//! **要做的事**：让 `content_json` / `content_text` 的直接访问**只经这一层**，
//! 将来换 CRDT（或做块级 LWW）时**只改这个文件**，调用方一行不改。
//!
//! ## v1 的纪律：**纯搬运，行为完全不变**
//!
//! 本文件里的 SQL 与分支顺序是从原处**逐字搬过来**的（`commands::save_page`、
//! `blocks::resolve_block` / `blocks::get_page_blocks`、`sync::apply_upsert`），
//! 只把"散落的直接访问"换成"一次调用"。
//! ⇒ **任何行为改动都必须另开一次提交**，并在提交信息里写清它是"顺手修的 bug"还是"收口的一部分"；
//! 混在一起之后，一旦回归就再也分不出是谁带来的。
//!
//! ## 门禁
//!
//! `scripts/check-doc-content-access.mjs` 把本文件列在豁免名单（`LAYER_FILES`）里：
//! 它是**允许**直接访问那两个字段的地方，其它文件的计数**只许减不许增**。
//! ⇒ 每搬进来一处，别处的白名单就**单调下降**一格。
//!
//! ## 还没搬的（诚实清单，别以为收口做完了）
//!
//! - **远端写路径**：`sync::apply_upsert` 的 `INSERT … ON CONFLICT` 仍写在 `sync.rs`
//!   （它要 `PageDetail` 的 11 个字段，值得单独一次提交；本轮只把它的**判定**搬了进来）；
//! - **`fetch_page` 的整行 SELECT**：它要 `cover/icon/kind/…`，属于"页面元数据"而不是"内容"，
//!   等元数据那一层有着落再说；
//! - **SQL 层的内联子查询**（如 `blocks::list_block_backlinks` 的 `(SELECT content_json …)`）：
//!   要在 SQL 里改，不是加一层函数能收的。

use rusqlite::{params, Connection, OptionalExtension};

/// 一页的**内容** —— 那一层的单位。
///
/// 为什么带 `title`：现有三个读调用方（`resolve_block` / `get_page_blocks` / `save_page` 的现状回读）
/// 都需要它，而它和内容在**同一行**；拆成两次查询会多一次 I/O，也多一个"读到两代数据"的窗口。
pub struct DocContent {
    pub title: String,
    pub json: String,
    pub text: String,
}

/// **唯一读出口**。页面不存在或已软删 ⇒ `Ok(None)`（**不**在这里报错：是"没有"还是"出错"由调用方决定）。
pub fn read(c: &Connection, page_id: &str) -> Result<Option<DocContent>, String> {
    c.query_row(
        "SELECT title, content_json, content_text FROM pages WHERE id = ?1 AND deleted_at IS NULL",
        params![page_id],
        |row| {
            Ok(DocContent {
                title: row.get(0)?,
                json: row.get(1)?,
                text: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// **唯一写入口**（本地保存那条路）。
///
/// `dirty = 1` 是**同步契约**的一部分，不是随手写的：`sync::apply_upsert` 的
/// "dirty 优先本地"就靠它保护"本地改了还没推"的内容。搬动时**必须**连它一起搬。
///
/// ⚠️ **版本快照**（`versions::snapshot_before_save`）**不在这里**：它是"版本历史策略"，
/// 不是"内容形态"。换 CRDT 后它的输入会变成 CRDT 快照，但**调用时机仍由 `save_page` 决定**。
///
/// ⚠️ 影响 0 行时**不在这里报错**（与搬运前逐字一致）：那意味着页面在读与写之间被删了，
/// 调用方随后的 `fetch_page` 会报"页面不存在"——同一个结果，不同的报错点，不为它改行为。
pub fn write(c: &Connection, page_id: &str, content: &DocContent, now: i64) -> Result<(), String> {
    c.execute(
        "UPDATE pages SET title = ?1, content_json = ?2, content_text = ?3, updated_at = ?4, dirty = 1 WHERE id = ?5",
        params![content.title, content.json, content.text, now, page_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// **派生**：内容变了之后，所有"从内容重建"的东西都从这里刷。
///
/// 今天是两块：FTS 索引（`search`）＋ 块图/反向链接（`blocks`）。
/// 纪律（文档 §4 规则 1）：**派生只能从这里出**，不许别处自己扫 `content_json` 建索引。
pub fn derive(c: &Connection, page_id: &str, content: &DocContent) -> Result<(), String> {
    derive_fts(c, page_id, &content.title, &content.text)?;
    crate::blocks::rebuild_block_graph(c, page_id, &content.json, &content.text)
}

/// 只刷 FTS —— **远端应用（`sync::apply_upsert`）今天只做这一步**，逐字搬运、不多做。
///
/// 收的是**三个借用参数**而不是 `&DocContent`：远端那条路径手上的字段本来就在
/// `PageDetail` 里，为调一次函数去 `clone` 一份可能很大的 `content_json` 不值当。
pub fn derive_fts(c: &Connection, page_id: &str, title: &str, text: &str) -> Result<(), String> {
    crate::search::sync_fts(c, page_id, title, text)
}

/// 本地侧用于**合并判定**的读数（`sync_seq` 与 `dirty`）。
pub struct LocalState {
    pub seq: i64,
    pub dirty: i64,
}

/// 读本地状态；页面不存在 ⇒ `Ok(None)`。
pub fn local_state(c: &Connection, page_id: &str) -> Result<Option<LocalState>, String> {
    c.query_row(
        "SELECT sync_seq, dirty FROM pages WHERE id = ?1",
        params![page_id],
        |row| {
            Ok(LocalState {
                seq: row.get(0)?,
                dirty: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// 合并判定：**本地留还是远端覆盖**。
#[derive(Debug, PartialEq, Eq)]
pub enum MergeDecision {
    KeepLocal,
    TakeRemote,
}

/// ★ **合并点** —— 整个收口的意义所在：只有这里知道"怎么合"。
///
/// 今天 = **页级 LWW + dirty 优先本地 + `seq` 权威**（逐字搬运自 `sync::apply_upsert` 的注释与分支）：
///
/// 1. 本地有**未推送**改动（`dirty != 0`）⇒ **留本地**（保护用户刚改的东西）；
/// 2. 本地已同步过**更靠后**的 `seq` ⇒ **留本地**（`seq` 是服务端单调序号，比设备时钟可靠）；
/// 3. 其余 ⇒ **远端覆盖本地**，并记下远端的 `seq`。
///
/// ⚠️ 阶段 1 把它换成**块级 LWW**、阶段 2/3 换成 **CRDT 合并** —— **只改这个函数**，调用方一行不改。
pub fn merge(local: Option<LocalState>, remote_seq: i64) -> MergeDecision {
    match local {
        Some(l) if l.dirty != 0 => MergeDecision::KeepLocal,
        Some(l) if l.seq > remote_seq => MergeDecision::KeepLocal,
        _ => MergeDecision::TakeRemote,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(seq: i64, dirty: i64) -> Option<LocalState> {
        Some(LocalState { seq, dirty })
    }

    #[test]
    fn local_page_absent_takes_remote() {
        assert_eq!(merge(None, 7), MergeDecision::TakeRemote);
    }

    #[test]
    fn dirty_local_wins_even_against_a_newer_seq() {
        // 「本地有未推送改动」优先于「远端 seq 更大」——这是保护用户刚改的内容那条。
        assert_eq!(merge(st(3, 1), 99), MergeDecision::KeepLocal);
    }

    #[test]
    fn already_synced_past_this_change_keeps_local() {
        assert_eq!(merge(st(10, 0), 9), MergeDecision::KeepLocal);
    }

    #[test]
    fn equal_seq_is_not_newer_so_remote_wins() {
        // 边界：`local_seq > remote_seq` 是**严格**大于 ⇒ 相等时远端覆盖（与搬运前一致）。
        assert_eq!(merge(st(9, 0), 9), MergeDecision::TakeRemote);
    }

    #[test]
    fn clean_and_behind_takes_remote() {
        assert_eq!(merge(st(4, 0), 5), MergeDecision::TakeRemote);
    }
}
