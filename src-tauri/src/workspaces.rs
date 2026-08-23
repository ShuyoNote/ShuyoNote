use crate::db::{now_ms, Db};
use crate::models::WorkspaceMeta;
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::MutexGuard;
use tauri::State;

/// Active-workspace key persisted in the key-value `sync_state` table.
const ACTIVE_KEY: &str = "active_workspace_id";

fn conn<'a>(db: &'a State<'_, Db>) -> MutexGuard<'a, Connection> {
    db.0.lock().unwrap()
}

fn row_to_meta(row: &rusqlite::Row) -> rusqlite::Result<WorkspaceMeta> {
    Ok(WorkspaceMeta {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

/// The workspace the app is currently operating on (persisted). Falls back to the
/// oldest non-deleted workspace (the "default"/"默认空间" seeded on first run).
pub(crate) fn active_workspace_id(c: &Connection) -> Result<String, String> {
    let persisted: Option<String> = c
        .query_row(
            "SELECT value FROM sync_state WHERE key = ?1",
            params![ACTIVE_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = persisted {
        let ok: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1 AND deleted_at IS NULL)",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if ok {
            return Ok(id);
        }
    }
    // Fallback: oldest non-deleted workspace; persist it so state stays consistent.
    let id: String = c
        .query_row(
            "SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "没有可用的工作空间".to_string())?;
    c.execute(
        "INSERT INTO sync_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![ACTIVE_KEY, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn get_active_workspace_id(db: State<Db>) -> Result<String, String> {
    let c = conn(&db);
    active_workspace_id(&c)
}

#[tauri::command]
pub fn set_active_workspace_id(db: State<Db>, id: String) -> Result<(), String> {
    let c = conn(&db);
    let exists: bool = c
        .query_row("SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)", params![id], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("工作空间不存在".to_string());
    }
    c.execute(
        "INSERT INTO sync_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![ACTIVE_KEY, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The active workspace's name (for the sidebar title), falling back to the first workspace.
#[tauri::command]
pub fn get_workspace_name(db: State<Db>) -> Result<String, String> {
    let active = get_active_workspace_id(db.clone())?;
    let c = conn(&db);
    c.query_row("SELECT name FROM workspaces WHERE id = ?1", params![active], |row| row.get(0))
        .or_else(|_| {
            c.query_row(
                "SELECT name FROM workspaces ORDER BY created_at ASC LIMIT 1",
                [],
                |row| row.get(0),
            )
        })
        .map_err(|e| e.to_string())
}

/// Rename the **active** workspace (keeps the old UI signature).
#[tauri::command]
pub fn rename_workspace(db: State<Db>, name: String) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("名称不能为空".to_string());
    }
    let active = get_active_workspace_id(db.clone())?;
    let c = conn(&db);
    c.execute(
        "UPDATE workspaces SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![trimmed, now_ms(), active],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_workspaces(db: State<Db>) -> Result<Vec<WorkspaceMeta>, String> {
    let c = conn(&db);
    let mut stmt = c
        .prepare("SELECT id, name, created_at, updated_at FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC")
        .map_err(|e| e.to_string())?;
    let mapped = stmt
        .query_map([], |row| row_to_meta(row))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in mapped {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn create_workspace(db: State<Db>, name: Option<String>) -> Result<WorkspaceMeta, String> {
    let c = conn(&db);
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let trimmed = name.unwrap_or_default().trim().to_string();
    let name = if trimmed.is_empty() { "新建工作区".to_string() } else { trimmed };

    c.execute(
        "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, now, now],
    )
    .map_err(|e| e.to_string())?;

    // Make the new workspace active so the user lands in it immediately.
    c.execute(
        "INSERT INTO sync_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![ACTIVE_KEY, id],
    )
    .map_err(|e| e.to_string())?;

    c.query_row(
        "SELECT id, name, created_at, updated_at FROM workspaces WHERE id = ?1",
        params![id],
        |row| row_to_meta(row),
    )
    .map_err(|e| e.to_string())
}

/// Soft-delete a workspace. If it's the active one, reset the active pointer so
/// the app falls back to another workspace. Content (pages etc.) is retained and
/// recoverable; queries no longer surface the soft-deleted workspace.
#[tauri::command]
pub fn delete_workspace(db: State<Db>, id: String) -> Result<(), String> {
    let c = conn(&db);
    let active = get_active_workspace_id(db.clone())?;
    let now = now_ms();
    let n = c
        .execute(
            "UPDATE workspaces SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
            params![now, now, id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("工作空间不存在或已删除".to_string());
    }
    if active == id {
        c.execute("DELETE FROM sync_state WHERE key = ?1", params![ACTIVE_KEY])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Copy a page (and its descendant tree) into another workspace. The copied rows
/// keep their blockIds so intra-subtree block references still resolve; references
/// to blocks outside the copied subtree become unresolved (documented limit, since
/// block graphs are workspace-scoped). Properties, tags and attachment rows are
/// re-parented to the new page ids (attachment bytes are content-addressed/shared).
#[tauri::command]
pub fn copy_page_to_workspace(
    db: State<Db>,
    page_id: String,
    target_workspace_id: String,
    new_parent_id: Option<String>,
) -> Result<String, String> {
    let c = conn(&db);

    // Validate targets.
    let ws_ok: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1 AND deleted_at IS NULL)",
            params![target_workspace_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !ws_ok {
        return Err("目标工作空间不存在".to_string());
    }
    if let Some(np) = &new_parent_id {
        let parent_ok: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pages WHERE id = ?1 AND deleted_at IS NULL AND workspace_id = ?2)",
                params![np, target_workspace_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !parent_ok {
            return Err("目标父页面不存在于目标工作空间".to_string());
        }
    }

    // Collect the source subtree in BFS order, mapping old -> new id.
    let mut id_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut queue: Vec<String> = vec![page_id.clone()];
    let mut order: Vec<String> = Vec::new();
    while let Some(pid) = queue.pop() {
        let nid = uuid::Uuid::new_v4().to_string();
        id_map.insert(pid.clone(), nid.clone());
        order.push(pid.clone());
        let mut stmt = c
            .prepare("SELECT id FROM pages WHERE parent_id = ?1 AND deleted_at IS NULL")
            .map_err(|e| e.to_string())?;
        let kids: Vec<String> = stmt
            .query_map(params![pid], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for kid in kids {
            queue.push(kid);
        }
    }

    let now = now_ms();
    for old_id in &order {
        // Fetch source row.
        let (parent, title, content_json, content_text, kind, sort_order, created_at): (
            Option<String>,
            String,
            String,
            String,
            String,
            f64,
            i64,
        ) = c
            .query_row(
                "SELECT parent_id, title, content_json, content_text, kind, sort_order, created_at
                 FROM pages WHERE id = ?1 AND deleted_at IS NULL",
                params![old_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;

        let new_id = id_map.get(old_id).cloned().unwrap_or_default();
        // Root gets the caller's new parent; descendants get their mapped parent.
        let new_parent = if old_id == &page_id {
            new_parent_id.clone()
        } else {
            let old_parent = parent.as_deref().map(|p| id_map.get(p).cloned()).flatten();
            old_parent
        };

        c.execute(
            "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)",
            params![new_id, target_workspace_id, new_parent, title, content_json, content_text, kind, sort_order, created_at, now],
        )
        .map_err(|e| e.to_string())?;

        // Copy page props (global attr_defs), tags, and attachment rows.
        c.execute(
            "INSERT INTO page_props (page_id, attr_id, value)
             SELECT ?1, attr_id, value FROM page_props WHERE page_id = ?2",
            params![new_id, old_id],
        )
        .map_err(|e| e.to_string())?;
        c.execute(
            "INSERT INTO page_tags (page_id, tag_id)
             SELECT ?1, tag_id FROM page_tags WHERE page_id = ?2",
            params![new_id, old_id],
        )
        .map_err(|e| e.to_string())?;
        c.execute(
            "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
             SELECT ?1, ?2, name, hash, mime, size, created_at FROM attachments WHERE page_id = ?3",
            params![uuid::Uuid::new_v4().to_string(), new_id, old_id],
        )
        .map_err(|e| e.to_string())?;

        // Rebuild indexes for the new page so search/blocks/backlinks/graph work
        // in the target workspace.
        crate::search::sync_fts(&c, &new_id, &title, &content_text)?;
        crate::blocks::rebuild_block_graph(&c, &new_id, &content_json, &content_text)?;

        // Record a sync upsert so the copied page propagates to the server.
        let detail = crate::models::PageDetail {
            id: new_id.clone(),
            workspace_id: target_workspace_id.clone(),
            parent_id: new_parent,
            title,
            content_json,
            content_text,
            kind,
            sort_order,
            created_at,
            updated_at: now,
        };
        crate::sync::record_page_upsert(&c, &detail)?;
    }

    Ok(id_map.get(&page_id).cloned().unwrap_or_default())
}
