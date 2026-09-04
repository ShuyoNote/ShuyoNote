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
    c.execute(
        "UPDATE pages SET title = ?1, content_json = ?2, content_text = ?3, updated_at = ?4 WHERE id = ?5",
        params![title, content_json, content_text, now, page_id],
    )
    .map_err(|e| e.to_string())?;

    crate::search::sync_fts(&c, &page_id, &title, &content_text)?;
    crate::blocks::rebuild_block_graph(&c, &page_id, &content_json, &content_text)?;

    let page = crate::commands::fetch_page(&c, &page_id)?;
    crate::sync::record_page_upsert(&c, &page)?;
    Ok(page)
}
