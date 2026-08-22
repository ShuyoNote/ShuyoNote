use crate::db::Db;
use crate::models::{BoardColumn, PageMeta, Tag};
use crate::workspaces;
use rusqlite::{params, OptionalExtension};
use tauri::State;

fn conn<'a>(db: &'a State<'_, Db>) -> std::sync::MutexGuard<'a, rusqlite::Connection> {
    db.0.lock().expect("db mutex poisoned")
}

#[tauri::command]
pub fn list_tags(db: State<'_, Db>) -> Result<Vec<Tag>, String> {
    let c = conn(&db);
    let ws = workspaces::active_workspace_id(&c)?;
    let mut stmt = c
        .prepare(
            "SELECT t.id, t.name, COUNT(pt.page_id) AS page_count
             FROM tags t
             LEFT JOIN page_tags pt ON t.id = pt.tag_id
             LEFT JOIN pages p ON p.id = pt.page_id AND p.deleted_at IS NULL AND p.workspace_id = ?1
             GROUP BY t.id, t.name
             ORDER BY t.name ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![ws], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                page_count: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_tag(db: State<'_, Db>, name: String) -> Result<Tag, String> {
    let c = conn(&db);
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("标签名不能为空".to_string());
    }
    let existing: Option<String> = c
        .query_row("SELECT id FROM tags WHERE name = ?1", params![name], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let id = match existing {
        Some(id) => id,
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            c.execute("INSERT INTO tags (id, name) VALUES (?1, ?2)", params![id, name])
                .map_err(|e| e.to_string())?;
            id
        }
    };
    Ok(Tag { id, name, page_count: 0 })
}

#[tauri::command]
pub fn rename_tag(db: State<'_, Db>, tag_id: String, name: String) -> Result<Tag, String> {
    let c = conn(&db);
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("标签名不能为空".to_string());
    }

    // If another tag already holds this name, MERGE pages into it, then drop the
    // old tag (keeps names unique). Otherwise rename in place.
    let other: Option<String> = c
        .query_row(
            "SELECT id FROM tags WHERE name = ?1 AND id != ?2",
            params![name, tag_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some(other_id) = other {
        c.execute(
            "INSERT OR IGNORE INTO page_tags (page_id, tag_id)
             SELECT page_id, ?1 FROM page_tags WHERE tag_id = ?2",
            params![other_id, tag_id],
        )
        .map_err(|e| e.to_string())?;
        c.execute("DELETE FROM page_tags WHERE tag_id = ?1", params![tag_id])
            .map_err(|e| e.to_string())?;
        // Only remove the old tag row if it's not the same as the target.
        if other_id != tag_id {
            c.execute("DELETE FROM tags WHERE id = ?1", params![tag_id])
                .map_err(|e| e.to_string())?;
        }
        let count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM page_tags pt JOIN pages p ON p.id = pt.page_id AND p.deleted_at IS NULL WHERE pt.tag_id = ?1",
                params![other_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        return Ok(Tag { id: other_id, name, page_count: count });
    }

    c.execute("UPDATE tags SET name = ?1 WHERE id = ?2", params![name, tag_id])
        .map_err(|e| e.to_string())?;
    let count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM page_tags pt JOIN pages p ON p.id = pt.page_id AND p.deleted_at IS NULL WHERE pt.tag_id = ?1",
            params![tag_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(Tag { id: tag_id, name, page_count: count })
}

#[tauri::command]
pub fn delete_tag(db: State<'_, Db>, tag_id: String) -> Result<(), String> {
    let c = conn(&db);
    c.execute("DELETE FROM page_tags WHERE tag_id = ?1", params![tag_id])
        .map_err(|e| e.to_string())?;
    c.execute("DELETE FROM tags WHERE id = ?1", params![tag_id])
        .map_err(|e| e.to_string())?;
    Ok(())
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
                page_count: 0,
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

    Ok(Tag {
        id: tag_id,
        name,
        page_count: 0,
    })
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
    let ws = workspaces::active_workspace_id(&c)?;
    pages_by_tag_impl(&c, &tag_id, &ws)
}

fn pages_by_tag_impl(c: &rusqlite::Connection, tag_id: &str, ws: &str) -> Result<Vec<PageMeta>, String> {
    let mut stmt = c
        .prepare(
            "SELECT p.id, p.workspace_id, p.parent_id, p.title, p.kind, p.sort_order, p.created_at, p.updated_at, p.deleted_at
             FROM pages p JOIN page_tags pt ON p.id = pt.page_id
             WHERE pt.tag_id = ?1 AND p.deleted_at IS NULL AND p.workspace_id = ?2
             ORDER BY p.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![tag_id, ws], |row| {
            Ok(PageMeta {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                parent_id: row.get(2)?,
                title: row.get(3)?,
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
pub fn board_data(db: State<'_, Db>) -> Result<Vec<BoardColumn>, String> {
    let c = conn(&db);
    let ws = workspaces::active_workspace_id(&c)?;

    let tags = {
        let mut stmt = c
            .prepare("SELECT id, name FROM tags ORDER BY name ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    page_count: 0,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };

    let mut columns = Vec::new();
    for tag in &tags {
        let pages = pages_by_tag_impl(&c, &tag.id, &ws)?;
        columns.push(BoardColumn {
            tag: Some(tag.clone()),
            pages,
        });
    }

    // Untagged column (pages with no tag at all).
    let untagged: Vec<PageMeta> = {
        let mut stmt = c
            .prepare(
                "SELECT p.id, p.workspace_id, p.parent_id, p.title, p.kind, p.sort_order, p.created_at, p.updated_at, p.deleted_at
                 FROM pages p
                 WHERE p.deleted_at IS NULL AND p.kind = 'page' AND p.workspace_id = ?1
                   AND NOT EXISTS (SELECT 1 FROM page_tags pt WHERE pt.page_id = p.id)
                 ORDER BY p.updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![ws], |row| {
                Ok(PageMeta {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    parent_id: row.get(2)?,
                    title: row.get(3)?,
                    kind: row.get(4)?,
                    sort_order: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                    deleted_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    columns.push(BoardColumn {
        tag: None,
        pages: untagged,
    });

    Ok(columns)
}

#[tauri::command]
pub fn move_card(db: State<'_, Db>, page_id: String, tag_id: String) -> Result<(), String> {
    let c = conn(&db);
    // Remove the page from all columns first, then assign the target tag.
    c.execute("DELETE FROM page_tags WHERE page_id = ?1", params![page_id])
        .map_err(|e| e.to_string())?;
    c.execute(
        "INSERT OR IGNORE INTO page_tags (page_id, tag_id) VALUES (?1, ?2)",
        params![page_id, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
