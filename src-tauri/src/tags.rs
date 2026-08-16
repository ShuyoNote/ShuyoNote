use crate::db::Db;
use crate::models::{PageMeta, Tag};
use rusqlite::{params, OptionalExtension};
use tauri::State;

fn conn<'a>(db: &'a State<'_, Db>) -> std::sync::MutexGuard<'a, rusqlite::Connection> {
    db.0.lock().expect("db mutex poisoned")
}

#[tauri::command]
pub fn list_tags(db: State<'_, Db>) -> Result<Vec<Tag>, String> {
    let c = conn(&db);
    let mut stmt = c
        .prepare("SELECT id, name FROM tags ORDER BY name ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn page_tags(db: State<'_, Db>, page_id: String) -> Result<Vec<Tag>, String> {
    let c = conn(&db);
    let mut stmt = c
        .prepare(
            "SELECT t.id, t.name FROM tags t JOIN page_tags pt ON t.id = pt.tag_id
             WHERE pt.page_id = ?1 ORDER BY t.name ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![page_id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_tag(db: State<'_, Db>, page_id: String, name: String) -> Result<Tag, String> {
    let c = conn(&db);
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("标签名不能为空".to_string());
    }

    // Get or create the tag.
    let tag_id: Option<String> = c
        .query_row("SELECT id FROM tags WHERE name = ?1", params![name], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;

    let tag_id = match tag_id {
        Some(id) => id,
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            c.execute("INSERT INTO tags (id, name) VALUES (?1, ?2)", params![id, name])
                .map_err(|e| e.to_string())?;
            id
        }
    };

    c.execute(
        "INSERT OR IGNORE INTO page_tags (page_id, tag_id) VALUES (?1, ?2)",
        params![page_id, tag_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(Tag { id: tag_id, name })
}

#[tauri::command]
pub fn remove_tag(db: State<'_, Db>, page_id: String, tag_id: String) -> Result<(), String> {
    let c = conn(&db);
    c.execute(
        "DELETE FROM page_tags WHERE page_id = ?1 AND tag_id = ?2",
        params![page_id, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pages_by_tag(db: State<'_, Db>, tag_id: String) -> Result<Vec<PageMeta>, String> {
    let c = conn(&db);
    let mut stmt = c
        .prepare(
            "SELECT p.id, p.workspace_id, p.parent_id, p.title, p.sort_order, p.created_at, p.updated_at, p.deleted_at
             FROM pages p JOIN page_tags pt ON p.id = pt.page_id
             WHERE pt.tag_id = ?1 AND p.deleted_at IS NULL
             ORDER BY p.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![tag_id], |row| {
            Ok(PageMeta {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                parent_id: row.get(2)?,
                title: row.get(3)?,
                sort_order: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                deleted_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}
