use crate::db::{now_ms, Db};
use crate::models::{PageDetail, PageMeta};
use crate::search;
use crate::sync;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use tauri::State;

const DEFAULT_WORKSPACE: &str = "default";

fn conn<'a>(db: &'a State<'_, Db>) -> std::sync::MutexGuard<'a, rusqlite::Connection> {
    db.0.lock().expect("db mutex poisoned")
}

fn fetch_page(c: &Connection, id: &str) -> Result<PageDetail, String> {
    c.query_row(
        "SELECT id, workspace_id, parent_id, title, content_json, content_text, sort_order, created_at, updated_at
         FROM pages WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
        |row| {
            Ok(PageDetail {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                parent_id: row.get(2)?,
                title: row.get(3)?,
                content_json: row.get(4)?,
                content_text: row.get(5)?,
                sort_order: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "页面不存在".to_string())
}

#[tauri::command]
pub fn list_pages(db: State<Db>) -> Result<Vec<PageMeta>, String> {
    let c = conn(&db);
    let mut stmt = c
        .prepare(
            "SELECT id, workspace_id, parent_id, title, sort_order, created_at, updated_at, deleted_at
             FROM pages WHERE deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
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

#[tauri::command]
pub fn get_page(db: State<Db>, id: String) -> Result<PageDetail, String> {
    let c = conn(&db);
    fetch_page(&c, &id)
}

#[derive(Deserialize)]
pub struct CreatePageArgs {
    pub parent_id: Option<String>,
    pub title: Option<String>,
}

#[tauri::command]
pub fn create_page(db: State<Db>, args: CreatePageArgs) -> Result<PageDetail, String> {
    let c = conn(&db);
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let title = args.title.unwrap_or_default();

    // Place new page at the end among siblings.
    let sort_order: f64 = c
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM pages WHERE parent_id IS ?1",
            params![args.parent_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    c.execute(
        "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, sort_order, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, '{}', '', ?5, ?6, ?7, NULL)",
        params![id, DEFAULT_WORKSPACE, args.parent_id, title, sort_order, now, now],
    )
    .map_err(|e| e.to_string())?;

    search::sync_fts(&c, &id, &title, "")?;

    let page = fetch_page(&c, &id)?;
    sync::record_page_upsert(&c, &page)?;
    Ok(page)
}

#[derive(Deserialize)]
pub struct SavePageArgs {
    pub id: String,
    pub title: Option<String>,
    pub content_json: Option<String>,
    pub content_text: Option<String>,
}

#[tauri::command]
pub fn save_page(db: State<Db>, args: SavePageArgs) -> Result<PageDetail, String> {
    let c = conn(&db);
    let now = now_ms();

    // Read current values for fields not provided.
    let (cur_title, cur_json, cur_text): (String, String, String) = c
        .query_row(
            "SELECT title, content_json, content_text FROM pages WHERE id = ?1 AND deleted_at IS NULL",
            params![args.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "页面不存在".to_string())?;

    let title = args.title.unwrap_or(cur_title);
    let content_json = args.content_json.unwrap_or(cur_json);
    let content_text = args.content_text.unwrap_or(cur_text);

    c.execute(
        "UPDATE pages SET title = ?1, content_json = ?2, content_text = ?3, updated_at = ?4 WHERE id = ?5",
        params![title, content_json, content_text, now, args.id],
    )
    .map_err(|e| e.to_string())?;

    search::sync_fts(&c, &args.id, &title, &content_text)?;

    let page = fetch_page(&c, &args.id)?;
    sync::record_page_upsert(&c, &page)?;
    Ok(page)
}

#[tauri::command]
pub fn delete_page(db: State<Db>, id: String) -> Result<(), String> {
    let c = conn(&db);
    let now = now_ms();

    // Collect descendant ids to soft-delete recursively.
    let mut all = vec![id.clone()];
    let mut queue = vec![id.clone()];
    while let Some(parent) = queue.pop() {
        let mut stmt = c
            .prepare("SELECT id FROM pages WHERE parent_id = ?1 AND deleted_at IS NULL")
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

    for pid in all {
        c.execute(
            "UPDATE pages SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now, pid],
        )
        .map_err(|e| e.to_string())?;
        search::remove_fts(&c, &pid)?;
        sync::record_change(&c, "page", &pid, "delete", None, now)?;
    }

    Ok(())
}

#[derive(Deserialize)]
pub struct MovePageArgs {
    pub id: String,
    pub new_parent_id: Option<String>,
    pub sort_order: f64,
}

#[tauri::command]
pub fn move_page(db: State<Db>, args: MovePageArgs) -> Result<(), String> {
    let c = conn(&db);
    // Prevent moving a page under its own descendant.
    if let Some(ref parent) = args.new_parent_id {
        let mut cur = Some(parent.clone());
        while let Some(p) = cur {
            if p == args.id {
                return Err("不能将页面移动到其子页面下".to_string());
            }
            cur = c
                .query_row(
                    "SELECT parent_id FROM pages WHERE id = ?1",
                    params![p],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .flatten();
        }
    }

    let now = now_ms();
    c.execute(
        "UPDATE pages SET parent_id = ?1, sort_order = ?2, updated_at = ?3 WHERE id = ?4",
        params![args.new_parent_id, args.sort_order, now, args.id],
    )
    .map_err(|e| e.to_string())?;

    let page = fetch_page(&c, &args.id)?;
    sync::record_page_upsert(&c, &page)?;

    Ok(())
}
