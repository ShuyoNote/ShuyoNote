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
        theme: row.get(2)?,
        icon: row.get(3)?,
        sort_order: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

const WS_COLS: &str = "id,name,theme,icon,sort_order,created_at,updated_at";

const ACCENTS: [&str; 8] = [
    "#3370FF", "#00B578", "#FF8A1E", "#7B61FF", "#00A9C7", "#D9A300", "#F54A45", "#646A73",
];

/// The workspace the app is currently operating on (persisted). Falls back to the
/// oldest non-deleted workspace (the "default"/"默认空间" seeded on first run).
/// Reads from `meta.sync_state` (meta.db is ATTACHed as `meta` on the connection).
pub(crate) fn active_workspace_id(c: &Connection) -> Result<String, String> {
    let persisted: Option<String> = c
        .query_row(
            "SELECT value FROM meta.sync_state WHERE key = ?1",
            params![ACTIVE_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = persisted {
        let ok: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM meta.workspaces WHERE id = ?1 AND deleted_at IS NULL)",
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
            "SELECT id FROM meta.workspaces WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "没有可用的工作空间".to_string())?;
    c.execute(
        "INSERT INTO meta.sync_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![ACTIVE_KEY, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn get_active_workspace_id(db: State<'_, Db>) -> Result<String, String> {
    let c = conn(&db);
    active_workspace_id(&c)
}

#[tauri::command]
pub async fn set_active_workspace_id(db: State<'_, Db>, id: String) -> Result<(), String> {
    let exists: bool = {
        let c = conn(&db);
        c.query_row("SELECT EXISTS(SELECT 1 FROM meta.workspaces WHERE id = ?1)", params![id], |row| row.get(0))
            .map_err(|e| e.to_string())?
    };
    if !exists {
        return Err("工作空间不存在".to_string());
    }
    {
        let c = conn(&db);
        c.execute(
            "INSERT INTO meta.sync_state (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![ACTIVE_KEY, id],
        )
        .map_err(|e| e.to_string())?;
    }
    // Re-point the main connection to the target space's DB file.
    let mut c = db.0.lock().expect("db mutex poisoned");
    crate::db::reopen_space(&mut c, &id)?;
    Ok(())
}

/// The active workspace's name (for the sidebar title), falling back to the first workspace.
#[tauri::command]
pub async fn get_workspace_name(db: State<'_, Db>) -> Result<String, String> {
    let c = conn(&db);
    let active = active_workspace_id(&c)?;
    c.query_row("SELECT name FROM meta.workspaces WHERE id = ?1", params![active], |row| row.get(0))
        .or_else(|_| {
            c.query_row(
                "SELECT name FROM meta.workspaces ORDER BY created_at ASC LIMIT 1",
                [],
                |row| row.get(0),
            )
        })
        .map_err(|e| e.to_string())
}

/// Rename a workspace by id.
#[tauri::command]
pub async fn rename_workspace(db: State<'_, Db>, id: String, name: String) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("名称不能为空".to_string());
    }
    let c = conn(&db);
    let n = c
        .execute(
            "UPDATE meta.workspaces SET name = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
            params![trimmed, now_ms(), id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("工作空间不存在".to_string());
    }
    Ok(())
}

/// Set per-workspace settings (accent color / icon / sort order).
#[tauri::command]
pub async fn set_workspace_settings(
    db: State<'_, Db>,
    id: String,
    theme: Option<String>,
    icon: Option<String>,
    sort_order: Option<f64>,
) -> Result<(), String> {
    let c = conn(&db);
    let n = c
        .execute(
            "UPDATE meta.workspaces SET theme = ?1, icon = ?2, sort_order = ?3, updated_at = ?4
             WHERE id = ?5 AND deleted_at IS NULL",
            params![theme, icon.unwrap_or_default(), sort_order.unwrap_or(0.0), now_ms(), id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("工作空间不存在".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn list_workspaces(db: State<'_, Db>) -> Result<Vec<WorkspaceMeta>, String> {
    let c = conn(&db);
    // Backfill theme colors for legacy workspaces created before the per-space
    // color feature (idempotent: only fills empty themes, distinct by creation order).
    {
        let ids: Vec<String> = c
            .prepare(
                "SELECT id FROM meta.workspaces WHERE deleted_at IS NULL AND (theme IS NULL OR theme = '') ORDER BY created_at ASC, id ASC",
            )
            .map_err(|e| e.to_string())?
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        for (i, wid) in ids.iter().enumerate() {
            let color = ACCENTS[i % ACCENTS.len()];
            c.execute(
                "UPDATE meta.workspaces SET theme = ?1 WHERE id = ?2 AND (theme IS NULL OR theme = '')",
                params![color, wid],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    let mut stmt = c
        .prepare(&format!(
            "SELECT {WS_COLS} FROM meta.workspaces WHERE deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC, id ASC"
        ))
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
pub async fn create_workspace(db: State<'_, Db>, name: Option<String>) -> Result<WorkspaceMeta, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let trimmed = name.unwrap_or_default().trim().to_string();
    let name = if trimmed.is_empty() { "新建工作区".to_string() } else { trimmed };

    let count: i64 = {
        let c = conn(&db);
        c.query_row("SELECT COUNT(*) FROM meta.workspaces WHERE deleted_at IS NULL", [], |r| r.get(0))
            .map_err(|e| e.to_string())?
    };
    let theme = ACCENTS[(count as usize) % ACCENTS.len()].to_string();
    let sort_order = (count + 1) as f64;

    {
        let c = conn(&db);
        c.execute(
            "INSERT INTO meta.workspaces (id, name, theme, icon, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, '', ?4, ?5, ?6)",
            params![id, name, theme, sort_order, now, now],
        )
        .map_err(|e| e.to_string())?;
        c.execute(
            "INSERT INTO meta.sync_state (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![ACTIVE_KEY, id],
        )
        .map_err(|e| e.to_string())?;
    }

    // Re-point the main connection to the new space's DB file (creates + migrates it).
    let mut c = db.0.lock().expect("db mutex poisoned");
    crate::db::reopen_space(&mut c, &id)?;
    // Seed a default home page so a new space isn't blank.
    let home_id = uuid::Uuid::new_v4().to_string();
    let home_json = r#"{"root":{"children":[{"type":"heading","tag":"h1","version":1,"children":[{"type":"text","text":"你好，这是你的新空间","detail":0,"format":0,"style":"","mode":"normal","version":1}],"direction":"ltr","format":"","indent":0,"style":"","mode":"normal","textFormat":0,"textStyle":""}],"direction":"ltr","format":"","indent":0,"type":"root","version":1}}"#;
    c.execute(
        "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, 'page', 0, ?6, ?6, NULL)",
        params![home_id, id, "开始", home_json, "你好，这是你的新空间\n点击上方“＋”开始创建页面。", now],
    )
    .map_err(|e| e.to_string())?;

    c.query_row(
        &format!("SELECT id,name,theme,icon,sort_order,created_at,updated_at FROM meta.workspaces WHERE id = ?1"),
        params![id],
        |row| row_to_meta(row),
    )
    .map_err(|e| e.to_string())
}

/// Soft-delete a workspace. If it's the active one, reset the active pointer so
/// the app falls back to another workspace. Content (pages etc.) is retained and
/// recoverable; queries no longer surface the soft-deleted workspace.
#[tauri::command]
pub async fn delete_workspace(db: State<'_, Db>, id: String) -> Result<(), String> {
    let c = conn(&db);
    let active = active_workspace_id(&c)?;
    let now = now_ms();
    let n = c
        .execute(
            "UPDATE meta.workspaces SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
            params![now, now, id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("工作空间不存在或已删除".to_string());
    }
    if active == id {
        c.execute("DELETE FROM meta.sync_state WHERE key = ?1", params![ACTIVE_KEY])
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

    // M15 物理隔离：跨空间复制需要跨库 DML（目标空间库 + 附件拷贝），在 M15.4 实现。
    // 在此前的单库模型里 "copy to another space" 会把页面字节写进当前库而 target_id
    // 只是标记，导致物理隔离后内容错库。现在是物理隔离稳定期，跨空间复制尚未实现，
    // 明确报错而非静默写错库。
    let active = active_workspace_id(&c)?;
    if target_workspace_id != active {
        return Err("跨空间复制将在后续版本支持（单空间可复制到本空间的新位置）".to_string());
    }

    // Validate targets.
    let ws_ok: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM meta.workspaces WHERE id = ?1 AND deleted_at IS NULL)",
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
