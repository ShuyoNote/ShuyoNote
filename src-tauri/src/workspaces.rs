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
#[tauri::command]
pub fn get_active_workspace_id(db: State<Db>) -> Result<String, String> {
    let c = conn(&db);
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
