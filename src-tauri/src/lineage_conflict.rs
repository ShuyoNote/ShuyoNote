//! 页级**血统冲突**：两条独立编辑历史撞在一起时的**留痕 ＋ 裁决**（冲刺 §13.3 第 2 条）。
//!
//! ## 为什么它不能复用块级那张表
//!
//! 块级 `page_conflicts` 记的是"**同一块**被判成两版" —— 可以逐块选一侧，另一侧仍在版本历史里；
//! 而这里撞上的是**两条独立创建的血统**：Yjs 结构上就不是同一棵树，**合并在数学上做不到**
//! （S1 红线：硬合 ⇒ 顶层块变成两份、`blockId` 重复）。所以真实选项只有三条：
//! **① 留本机 ② 用对端 ③ 两个都要（一页变两页）**，其中只有 ③ 不丢数据。
//!
//! ## 为什么必须有 `remote_doc` 这一列
//!
//! "拒绝合并"发生在**打开页面**那一刻，而待并状态在这一步之后会被 `clearPending` **清掉** ⇒
//! 不在这里留一份**对端那一版的投影**，用户事后点"另存为新页"时**已经无米下锅**。
//!
//! ## 三条纪律（与 `page_conflicts` 同族）
//!
//! 1. **本地证据**：别的设备没有这行、服务端也没有这张表 —— 别拿它解释跨机器的差异；
//! 2. `resolved_at` 为空 ＝ **未决**；界面不许读成"已处理"（判据守着这一条）；
//! 3. **不默认选边**：`choice` 只认两个字面量，其余**报错**（与 `resolve_page_conflict` 同一纪律）。

use rusqlite::{params, Connection, OptionalExtension};

/// 一条页级血统冲突（`page_lineage_conflicts` 的一行）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PageLineageConflict {
    pub id: String,
    pub page_id: String,
    /// 本机这条血统的指纹（`lineageClientIds` 的 client id，逗号分隔、已排序）。
    pub mine_fp: String,
    /// 对端那条血统的指纹。
    pub remote_fp: String,
    /// 对端那一版的**整页投影 JSON**（"另存为新页"靠它 —— 待并状态会被清掉）。
    pub remote_doc: String,
    pub detected_at: i64,
    pub resolved_at: Option<i64>,
    pub resolved_choice: Option<String>,
}

/// 裁决选"留本机"（＝我知道了，别管它）。
pub const CHOICE_LOCAL: &str = "local";
/// 裁决选"把对端那一版另存为新页"（★ 唯一**不丢数据**的那条路）。
pub const CHOICE_SAVED_AS_NEW: &str = "saved-as-new";

/// 记一次页级血统冲突。返回**是否真的新建了一行**（`false` ＝ 这一对指纹已经记过/已裁决过）。
///
/// 去重口径（**同一对指纹只提一次**，这是"不许每开一次页面就打扰一次"的落脚点）：
/// · 同一 `(page_id, mine_fp, remote_fp)` **已有未决** ⇒ 只把快照刷新成最新那一版（对端可能又推了新的）；
/// · 同一对**已裁决过** ⇒ **不再提**（用户已经处理过这件事了）；
/// · 否则：先把这一页**别的**未决行删掉（旧指纹对已被新事实取代，避免堆积），再插一条。
pub fn record_lineage_conflict(
    c: &Connection,
    page_id: &str,
    mine_fp: &str,
    remote_fp: &str,
    remote_doc: &str,
    now: i64,
) -> Result<bool, String> {
    let existing: Option<(String, Option<i64>)> = c
        .query_row(
            "SELECT id, resolved_at FROM page_lineage_conflicts
             WHERE page_id = ?1 AND mine_fp = ?2 AND remote_fp = ?3
             ORDER BY detected_at DESC LIMIT 1",
            params![page_id, mine_fp, remote_fp],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match existing {
        Some((id, None)) => {
            // 未决：刷新快照与时间（同一件事又发生了一次，不是新的一件）
            c.execute(
                "UPDATE page_lineage_conflicts SET remote_doc = ?1, detected_at = ?2 WHERE id = ?3",
                params![remote_doc, now, id],
            )
            .map_err(|e| e.to_string())?;
            Ok(false)
        }
        Some((_, Some(_))) => Ok(false), // 已裁决过这一对 ⇒ 不再提
        None => {
            c.execute(
                "DELETE FROM page_lineage_conflicts WHERE page_id = ?1 AND resolved_at IS NULL",
                params![page_id],
            )
            .map_err(|e| e.to_string())?;
            c.execute(
                "INSERT INTO page_lineage_conflicts
                   (id, page_id, mine_fp, remote_fp, remote_doc, detected_at, resolved_at, resolved_choice)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    page_id,
                    mine_fp,
                    remote_fp,
                    remote_doc,
                    now,
                ],
            )
            .map_err(|e| e.to_string())?;
            Ok(true)
        }
    }
}

fn row_of(r: &rusqlite::Row<'_>) -> rusqlite::Result<PageLineageConflict> {
    Ok(PageLineageConflict {
        id: r.get(0)?,
        page_id: r.get(1)?,
        mine_fp: r.get(2)?,
        remote_fp: r.get(3)?,
        remote_doc: r.get(4)?,
        detected_at: r.get(5)?,
        resolved_at: r.get(6)?,
        resolved_choice: r.get(7)?,
    })
}

const COLS: &str =
    "id, page_id, mine_fp, remote_fp, remote_doc, detected_at, resolved_at, resolved_choice";

/// 这一页**未决**的页级冲突（**至多一条** —— 记的时候就把旧的未决删了）。
pub fn unresolved_lineage_conflict(
    c: &Connection,
    page_id: &str,
) -> Result<Option<PageLineageConflict>, String> {
    c.query_row(
        &format!(
            "SELECT {COLS} FROM page_lineage_conflicts
             WHERE page_id = ?1 AND resolved_at IS NULL ORDER BY detected_at DESC LIMIT 1"
        ),
        params![page_id],
        row_of,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// 这一页**全部**页级冲突（含已裁决；给判据与排错用 —— 界面只读未决那条，所以这里是 `cfg(test)`）。
#[cfg(test)]
pub fn lineage_conflicts_of(
    c: &Connection,
    page_id: &str,
) -> Result<Vec<PageLineageConflict>, String> {
    let mut stmt = c
        .prepare(&format!(
            "SELECT {COLS} FROM page_lineage_conflicts WHERE page_id = ?1 ORDER BY detected_at, id"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![page_id], row_of).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// ★ **裁决一条**：`choice` 只认 `local` / `saved-as-new`，其余**报错**（**不默认选边** ——
/// 与 `resolve_page_conflict` 同一纪律）；已裁决的再裁决也**报错**（不静默成功）。
pub fn resolve_lineage_conflict(
    c: &Connection,
    id: &str,
    choice: &str,
    now: i64,
) -> Result<(), String> {
    if choice != CHOICE_LOCAL && choice != CHOICE_SAVED_AS_NEW {
        return Err(format!(
            "choice 只能是 {CHOICE_LOCAL} 或 {CHOICE_SAVED_AS_NEW}，收到 {choice}"
        ));
    }
    let n = c
        .execute(
            "UPDATE page_lineage_conflicts SET resolved_at = ?1, resolved_choice = ?2
             WHERE id = ?3 AND resolved_at IS NULL",
            params![now, choice, id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("冲突不存在或已裁决".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真 schema 的临时库（照 `doc_content::tests::conflict_conn` 同一手法：
    /// **别手抄最小表** —— 这里虽然只用这一张，但手工 schema 会掩盖迁移问题）。
    fn conn(tag: &str) -> (Connection, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("shuyonote-lineage-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        let c = crate::db::open_space_conn_at("s1", &dir).unwrap();
        (c, dir)
    }

    fn page(c: &Connection, id: &str) {
        c.execute(
            "INSERT INTO pages (id, workspace_id, title, content_json, content_text, kind, created_at, updated_at, deleted_at, dirty) \
             VALUES (?1, 's1', '页', '{}', '', 'page', 0, 0, NULL, 0)",
            params![id],
        )
        .unwrap();
    }

    #[test]
    fn records_once_per_fingerprint_pair_and_refreshes_the_snapshot() {
        let (c, dir) = conn("record");
        page(&c, "p1");
        assert!(record_lineage_conflict(&c, "p1", "7", "42", "{\"v\":1}", 10).unwrap(), "第一次要落一行");
        // 同一对再来 ⇒ **不新建**，但快照刷新（对端可能又推了新的一版）
        assert!(!record_lineage_conflict(&c, "p1", "7", "42", "{\"v\":2}", 11).unwrap());
        let row = unresolved_lineage_conflict(&c, "p1").unwrap().expect("应当有未决");
        assert_eq!(row.remote_doc, "{\"v\":2}", "快照要刷新成最新那一版");
        assert_eq!(row.mine_fp, "7");
        assert_eq!(row.remote_fp, "42");
        assert_eq!(row.resolved_at, None);
        // 换了指纹对（对端另起了一条新血统）⇒ 旧的未决被取代，只剩一条
        assert!(record_lineage_conflict(&c, "p1", "7", "99", "{\"v\":3}", 12).unwrap());
        assert_eq!(lineage_conflicts_of(&c, "p1").unwrap().len(), 1, "同一页只留一条未决");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_already_resolved_pair_is_not_raised_again() {
        // ★ 这条就是"同一对指纹只提一次"：不然用户每开一次页面就被打扰一次
        let (c, dir) = conn("resolved");
        page(&c, "p1");
        record_lineage_conflict(&c, "p1", "7", "42", "{}", 10).unwrap();
        let id = unresolved_lineage_conflict(&c, "p1").unwrap().unwrap().id;
        resolve_lineage_conflict(&c, &id, CHOICE_SAVED_AS_NEW, 11).unwrap();

        assert!(!record_lineage_conflict(&c, "p1", "7", "42", "{}", 12).unwrap(), "已裁决过 ⇒ 不再提");
        assert!(unresolved_lineage_conflict(&c, "p1").unwrap().is_none(), "未决列表必须干净");
        // 但**换一条新血统**（新的指纹对）⇒ 那是一件新事，要提
        assert!(record_lineage_conflict(&c, "p1", "7", "100", "{}", 13).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_only_accepts_the_two_literals_and_refuses_a_second_time() {
        let (c, dir) = conn("resolve");
        page(&c, "p1");
        record_lineage_conflict(&c, "p1", "1", "2", "{}", 10).unwrap();
        let id = unresolved_lineage_conflict(&c, "p1").unwrap().unwrap().id;

        // ★ 不默认选边：其余一律报错（含空串、"remote" 这种"看起来像"的值）
        for bad in ["", "remote", "use-remote", "LOCAL"] {
            assert!(resolve_lineage_conflict(&c, &id, bad, 11).is_err(), "{bad:?} 不该被接受");
        }
        resolve_lineage_conflict(&c, &id, CHOICE_LOCAL, 11).unwrap();
        assert!(resolve_lineage_conflict(&c, &id, CHOICE_LOCAL, 12).is_err(), "已裁决的再裁决要报错");
        let all = lineage_conflicts_of(&c, "p1").unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].resolved_choice.as_deref(), Some(CHOICE_LOCAL));
        assert_eq!(all[0].resolved_at, Some(11));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_page_has_no_conflict_and_other_pages_are_not_disturbed() {
        let (c, dir) = conn("scope");
        page(&c, "p1");
        page(&c, "p2");
        record_lineage_conflict(&c, "p1", "1", "2", "{}", 10).unwrap();
        assert!(unresolved_lineage_conflict(&c, "nope").unwrap().is_none());
        assert!(unresolved_lineage_conflict(&c, "p2").unwrap().is_none(), "别把冲突记到别的页上");
        assert_eq!(lineage_conflicts_of(&c, "p2").unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
