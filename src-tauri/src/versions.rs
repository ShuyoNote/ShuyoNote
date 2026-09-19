use crate::db::{now_ms, Db};
use crate::models::PageDetail;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

const MAX_VERSIONS_PER_PAGE: i64 = 50;

fn conn<'a>(db: &'a State<'_, Db>) -> std::sync::MutexGuard<'a, rusqlite::Connection> {
    db.0.lock().expect("db mutex poisoned")
}

#[derive(Serialize)]
pub struct PageVersion {
    pub id: String,
    pub page_id: String,
    pub title: String,
    pub content_text: String,
    pub created_at: i64,
}

// Snapshot the current content before an update (called by save_page).
// Dedups consecutive identical snapshots; caps total per page.
pub fn snapshot_before_save(c: &Connection, page_id: &str, title: &str, content_json: &str, content_text: &str) -> Result<(), String> {
    // Dedup: skip if the latest snapshot has identical content.
    let last: Option<(String, String, String)> = c
        .query_row(
            "SELECT title, content_json, content_text FROM page_versions
             WHERE page_id = ?1 ORDER BY created_at DESC LIMIT 1",
            params![page_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some((lt, lj, lt2)) = last {
        if lt == title && lj == content_json && lt2 == content_text {
            return Ok(());
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    c.execute(
        "INSERT INTO page_versions (id, page_id, title, content_json, content_text, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, page_id, title, content_json, content_text, now],
    )
    .map_err(|e| e.to_string())?;

    // Cap history: keep the newest MAX_VERSIONS_PER_PAGE.
    c.execute(
        "DELETE FROM page_versions WHERE page_id = ?1 AND id NOT IN (
            SELECT id FROM page_versions WHERE page_id = ?1 ORDER BY created_at DESC LIMIT ?2
        )",
        params![page_id, MAX_VERSIONS_PER_PAGE],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn list_versions(db: State<'_, Db>, page_id: String) -> Result<Vec<PageVersion>, String> {
    let c = conn(&db);
    let mut stmt = c
        .prepare(
            "SELECT id, page_id, title, content_text, created_at FROM page_versions
             WHERE page_id = ?1 ORDER BY created_at DESC LIMIT 100",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![page_id], |row| {
            Ok(PageVersion {
                id: row.get(0)?,
                page_id: row.get(1)?,
                title: row.get(2)?,
                content_text: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_page_versions(db: State<'_, Db>, page_id: String) -> Result<usize, String> {
    // 手动清空：删除该页的全部历史快照（保留当前内容；当前页不属于 page_versions）。
    let c = conn(&db);
    let n = c
        .execute("DELETE FROM page_versions WHERE page_id = ?1", params![page_id])
        .map_err(|e| e.to_string())?;
    Ok(n)
}

#[tauri::command]
pub fn restore_version(db: State<'_, Db>, version_id: String) -> Result<PageDetail, String> {
    let c = conn(&db);
    restore_version_in_conn(&c, &version_id)
}

/// `restore_version` 的实现（命令面只负责取连接）。
///
/// 抽成 `_in_conn` 的理由与 `search::read_attachment_text_in_conn` 相同：**判据与命令面必须走
/// 同一条代码路径**，否则判据测得是"另一份实现"，而漂移恰好发生在没被测的那一份里。
pub(crate) fn restore_version_in_conn(c: &Connection, version_id: &str) -> Result<PageDetail, String> {
    let (page_id, title, content_json, content_text): (String, String, String, String) = c
        .query_row(
            "SELECT page_id, title, content_json, content_text FROM page_versions WHERE id = ?1",
            params![version_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "版本不存在".to_string())?;

    let now = now_ms();
    // Preserve the CURRENT content before we overwrite it, so a restore is
    // reversible (you can go back to what you had just before restoring).
    // Dedups against the latest snapshot, so this is a no-op when the current
    // content is already the newest snapshot.
    // ⚠️ 活性谓词与 `doc_content::read` / `readContent` 一致（`deleted_at IS NULL`）：
    // **恢复只对活页** —— 要给已软删的页面恢复内容，应先把页面还原出来（2026-09-19 跨机裁定）。
    // 查不到就**拒绝**（不是 `?` 冒泡 sqlite 的 "Query returned no rows"）：原来只是静默跳过快照、
    // UPDATE 照旧改写已软删的页 ⇒ "只对活页"在代码上并不成立。错误文案与前端 `web.ts` **逐字一致**，
    // 便于日后交叉检索两侧是不是同一条语义。
    let (cur_title, cur_json, cur_text): (String, String, String) = c
        .query_row(
            "SELECT title, content_json, content_text FROM pages WHERE id = ?1 AND deleted_at IS NULL",
            params![page_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "页面不存在或已删除（先还原页面，再恢复它的历史版本）".to_string())?;
    snapshot_before_save(c, &page_id, &cur_title, &cur_json, &cur_text)?;

    // `dirty = 1`：恢复版本是**用户自己刚做的动作**，与 `doc_content::write` 硬写 1、
    // `upsert_remote` 硬写 0 成对。不置 1 时，"恢复后、推送前"的某次 pull 会**静默把这次恢复冲掉**
    // （最终虽收敛，但用户会看到内容闪回且没有任何提示）—— 与这一路在修的"成功 ≠ 生效"同源。
    // 2026-09-19 裁定 (a)：**两侧同批**改（前端半 = Windows `1db5fca`，Rust 半 = 本笔）。
    c.execute(
        "UPDATE pages SET title = ?1, content_json = ?2, content_text = ?3, updated_at = ?4, dirty = 1 WHERE id = ?5",
        params![title, content_json, content_text, now, page_id],
    )
    .map_err(|e| e.to_string())?;

    crate::search::sync_fts(c, &page_id, &title, &content_text)?;
    crate::blocks::rebuild_block_graph(c, &page_id, &content_json, &content_text)?;

    let page = crate::commands::fetch_page(c, &page_id)?;
    crate::sync::record_page_upsert(c, &page)?;
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与真库**同一条**建库路径：meta（`device_id` 在里面）+ `migrate` + attach。
    ///
    /// 为什么不图省事用 `Connection::open_in_memory()`：`record_page_upsert` 要读
    /// `meta.sync_state.device_id`，而 meta 的 schema 只有走仓库自己的入口才有（`open_meta_conn_at`）。
    /// 自己手抄一份建表语句就等于判据测的是"另一套 schema"——那正是这一路一直在避免的漂移。
    fn test_conn(tag: &str) -> (Connection, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("shuyonote-versions-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        // ① 先建 meta.db 的 schema（`open_meta_conn_at` 是仓库自己的入口，幂等）
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        // ② 空间连接会 attach meta ⇒ `set_meta_state`（写的是 `meta.sync_state`）必须在这个连接上跑
        let c = crate::db::open_space_conn_at("s1", &dir).unwrap();
        crate::sync::set_meta_state(&c, "device_id", "test-device").unwrap();
        (c, dir)
    }

    fn insert_page(c: &Connection, id: &str, text: &str, deleted_at: Option<i64>) {
        let now = now_ms();
        c.execute(
            "INSERT INTO pages (id, workspace_id, title, content_json, content_text, kind, created_at, updated_at, deleted_at, dirty)
             VALUES (?1, ?2, ?3, '{}', ?4, 'page', ?5, ?5, ?6, 0)",
            params![id, "s1", "页", text, now, deleted_at],
        )
        .unwrap();
    }

    fn insert_version(c: &Connection, id: &str, page_id: &str, text: &str) {
        c.execute(
            "INSERT INTO page_versions (id, page_id, title, content_json, content_text, created_at)
             VALUES (?1, ?2, '页', '{}', ?3, ?4)",
            params![id, page_id, text, now_ms()],
        )
        .unwrap();
    }

    /// ★ **恢复版本 = 一次本地未推送改动** ⇒ 必须置 `dirty = 1`。
    ///
    /// 这条判据是这一族改动的承重件（2026-09-19 裁定 (a)）：不置 1 时，"恢复后、推送前"的某次
    /// pull 会**静默把这次恢复冲掉**（`shouldTakeRemote` 只看 `dirty`/`seq`），最终虽收敛，
    /// 但用户会看到内容闪回且没有任何提示 —— 与 `truncated`/`ExtractCoverage` 那类"成功 ≠ 生效"
    /// 是同一族问题。前端半边在 `scripts/verify-two-device-sync.mjs` 的场景 G；
    /// **这里是 Rust 半边**，两边各自钉住才算"两侧同批"。
    #[test]
    fn restore_version_marks_the_page_dirty() {
        let (c, dir) = test_conn("dirty");
        insert_page(&c, "p1", "旧内容", None);
        insert_version(&c, "v1", "p1", "恢复后的内容");

        let before: i64 = c.query_row("SELECT dirty FROM pages WHERE id = ?1", params!["p1"], |r| r.get(0)).unwrap();
        assert_eq!(before, 0, "前置：新页 dirty 应为 0");

        let page = restore_version_in_conn(&c, "v1").expect("活页应当能恢复");
        assert_eq!(page.content_text, "恢复后的内容");

        let dirty: i64 = c.query_row("SELECT dirty FROM pages WHERE id = ?1", params!["p1"], |r| r.get(0)).unwrap();
        assert_eq!(dirty, 1, "★ 恢复必须置 dirty=1（否则推送前的 pull 会静默冲掉这次恢复）");

        // 恢复前的当前内容要进快照（可逆）——与前端同一条语义
        let versions: i64 = c
            .query_row("SELECT COUNT(*) FROM page_versions WHERE page_id = ?1", params!["p1"], |r| r.get(0))
            .unwrap();
        assert_eq!(versions, 2, "应当多出一份『恢复前内容』的快照（历史行 + 本次快照）");

        // 本笔改动还应当进 outbox（`record_page_upsert` 本来就有，这里顺手钉住"恢复会被推送"）
        let outbox: i64 = c
            .query_row("SELECT COUNT(*) FROM changes WHERE entity = 'page' AND entity_id = 'p1'", [], |r| r.get(0))
            .unwrap();
        assert!(outbox >= 1, "恢复后应当有一笔 page 变更进 outbox（否则恢复内容不会被推送）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★ 「恢复只对活页」：软删页拒绝恢复，且错误文案与前端**逐字一致**。
    #[test]
    fn restore_version_refuses_a_soft_deleted_page() {
        let (c, dir) = test_conn("deleted");
        insert_page(&c, "p2", "已删页的内容", Some(now_ms()));
        insert_version(&c, "v2", "p2", "想恢复成这个");

        let err = restore_version_in_conn(&c, "v2").unwrap_err();
        assert_eq!(
            err,
            "页面不存在或已删除（先还原页面，再恢复它的历史版本）",
            "错误文案必须与前端 web.ts 逐字一致（便于日后交叉检索两侧是否同一语义）"
        );
        let text: String = c.query_row("SELECT content_text FROM pages WHERE id = ?1", params!["p2"], |r| r.get(0)).unwrap();
        assert_eq!(text, "已删页的内容", "被拒之后内容不得被改写");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
