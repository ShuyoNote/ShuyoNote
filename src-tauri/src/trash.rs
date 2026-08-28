use crate::db::{now_ms, Db};
use crate::models::{PageDetail, PageMeta};
use crate::search;
use crate::sync;
use rusqlite::{params, Connection, OptionalExtension};
use tauri::State;

fn conn<'a>(db: &'a State<'_, Db>) -> std::sync::MutexGuard<'a, rusqlite::Connection> {
    db.0.lock().expect("db mutex poisoned")
}

fn fetch_page_any(c: &Connection, id: &str) -> Result<PageDetail, String> {
    c.query_row(
        "SELECT id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at
         FROM pages WHERE id = ?1",
        params![id],
        |row| {
            Ok(PageDetail {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                parent_id: row.get(2)?,
                title: row.get(3)?,
                content_json: row.get(4)?,
                content_text: row.get(5)?,
                cover: String::new(),
                icon: String::new(),
                cover_height: 300,
                kind: row.get(6)?,
                sort_order: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "页面不存在".to_string())
}

// Collect the page and all its descendants (regardless of deleted state).
fn collect_descendants(c: &Connection, root: &str) -> Result<Vec<String>, String> {
    let mut all = vec![root.to_string()];
    let mut queue = vec![root.to_string()];
    while let Some(parent) = queue.pop() {
        let mut stmt = c
            .prepare("SELECT id FROM pages WHERE parent_id = ?1")
            .map_err(|e| e.to_string())?;
        let children: Vec<String> = stmt
            .query_map(params![parent], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for child in children {
            all.push(child.clone());
            queue.push(child);
        }
    }
    Ok(all)
}

#[tauri::command]
pub fn list_deleted(db: State<'_, Db>) -> Result<Vec<PageMeta>, String> {
    let c = conn(&db);
    let mut stmt = c
        .prepare(
            "SELECT id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at
             FROM pages WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(PageMeta {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                parent_id: row.get(2)?,
                title: row.get(3)?,
                icon: String::new(),
                kind: row.get(4)?,
                sort_order: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                deleted_at: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn restore_page(db: State<'_, Db>, id: String) -> Result<(), String> {
    let c = conn(&db);
    let page = fetch_page_any(&c, &id)?;

    // If parent is also deleted, restore to root.
    let parent_id = match &page.parent_id {
        Some(pid) => {
            let parent_deleted: bool = c
                .query_row(
                    "SELECT deleted_at IS NOT NULL FROM pages WHERE id = ?1",
                    params![pid],
                    |row| row.get::<_, bool>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .unwrap_or(true);
            if parent_deleted {
                None
            } else {
                Some(pid.clone())
            }
        }
        None => None,
    };

    let now = now_ms();
    c.execute(
        "UPDATE pages SET deleted_at = NULL, parent_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![parent_id, now, id],
    )
    .map_err(|e| e.to_string())?;

    // Rebuild FTS index.
    search::sync_fts(&c, &id, &page.title, &page.content_text)?;

    // Record upsert so other devices learn of the restore.
    let restored = fetch_page_any(&c, &id)?;
    sync::record_page_upsert(&c, &restored)?;

    Ok(())
}

#[tauri::command]
pub fn purge_page(db: State<'_, Db>, id: String) -> Result<(), String> {
    let c = conn(&db);
    let ids = collect_descendants(&c, &id)?;

    for pid in &ids {
        search::remove_fts(&c, pid)?;
        c.execute("DELETE FROM page_tags WHERE page_id = ?1", params![pid])
            .map_err(|e| e.to_string())?;
        c.execute(
            "DELETE FROM backlinks WHERE source_page_id = ?1 OR target_page_id = ?1",
            params![pid],
        )
        .map_err(|e| e.to_string())?;
        c.execute("DELETE FROM blocks WHERE page_id = ?1", params![pid])
            .map_err(|e| e.to_string())?;
        c.execute("DELETE FROM attachments WHERE page_id = ?1", params![pid])
            .map_err(|e| e.to_string())?;
        c.execute("DELETE FROM pages WHERE id = ?1", params![pid])
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}
