use crate::db::Db;
use crate::models::PageDetail;
use crate::search;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

const KEY_DEVICE_ID: &str = "device_id";
const KEY_SERVER_URL: &str = "server_url";
const KEY_TOKEN: &str = "token";
const KEY_LAST_PUSHED: &str = "last_pushed_seq";
const KEY_LAST_PULLED: &str = "last_pulled_seq";

// ---- state helpers ----

pub fn get_state(c: &Connection, key: &str) -> Option<String> {
    c.query_row(
        "SELECT value FROM sync_state WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn set_state(c: &Connection, key: &str, value: &str) -> Result<(), String> {
    c.execute(
        "INSERT INTO sync_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn device_id(c: &Connection) -> Result<String, String> {
    get_state(c, KEY_DEVICE_ID).ok_or_else(|| "设备 ID 未初始化".to_string())
}

// ---- outbox recording ----

pub fn record_change(
    c: &Connection,
    entity: &str,
    entity_id: &str,
    op: &str,
    payload: Option<&str>,
    updated_at: i64,
) -> Result<(), String> {
    let did = device_id(c)?;
    c.execute(
        "INSERT INTO changes (device_id, device_seq, entity, entity_id, op, payload, updated_at)
         VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6)",
        params![did, entity, entity_id, op, payload, updated_at],
    )
    .map_err(|e| e.to_string())?;
    let seq = c.last_insert_rowid();
    // device_seq mirrors local auto-increment seq (unique per device).
    c.execute(
        "UPDATE changes SET device_seq = ?1 WHERE seq = ?1",
        params![seq],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn record_page_upsert(c: &Connection, page: &PageDetail) -> Result<(), String> {
    let payload = serde_json::to_string(page).map_err(|e| e.to_string())?;
    record_change(c, "page", &page.id, "upsert", Some(&payload), page.updated_at)
}

// ---- remote apply (LWW) ----

fn apply_upsert(c: &Connection, page: &PageDetail) -> Result<(), String> {
    let local_updated: Option<i64> = c
        .query_row(
            "SELECT updated_at FROM pages WHERE id = ?1",
            params![page.id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some(local) = local_updated {
        if local > page.updated_at {
            return Ok(()); // local wins
        }
    }

    c.execute(
        "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, sort_order, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           parent_id = excluded.parent_id,
           title = excluded.title,
           content_json = excluded.content_json,
           content_text = excluded.content_text,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at,
           deleted_at = NULL",
        params![
            page.id,
            page.workspace_id,
            page.parent_id,
            page.title,
            page.content_json,
            page.content_text,
            page.sort_order,
            page.created_at,
            page.updated_at
        ],
    )
    .map_err(|e| e.to_string())?;

    search::sync_fts(c, &page.id, &page.title, &page.content_text)?;
    Ok(())
}

fn apply_delete(c: &Connection, id: &str, updated_at: i64) -> Result<(), String> {
    let local_updated: Option<i64> = c
        .query_row(
            "SELECT updated_at FROM pages WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some(local) = local_updated {
        if local > updated_at {
            return Ok(()); // local edit wins over remote delete
        }
    }

    c.execute(
        "UPDATE pages SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![updated_at, id],
    )
    .map_err(|e| e.to_string())?;
    search::remove_fts(c, id)?;
    Ok(())
}

// ---- wire types ----

#[derive(Serialize, Deserialize)]
struct OutgoingChange {
    device_seq: i64,
    entity: String,
    entity_id: String,
    op: String,
    payload: Option<String>,
    updated_at: i64,
}

#[derive(Serialize)]
struct PushRequest {
    device_id: String,
    changes: Vec<OutgoingChange>,
}

#[derive(Deserialize)]
struct IncomingChange {
    #[allow(dead_code)]
    seq: i64,
    entity: String,
    entity_id: String,
    op: String,
    payload: Option<String>,
    updated_at: i64,
}

#[derive(Deserialize)]
struct PullResponse {
    changes: Vec<IncomingChange>,
}

#[derive(Serialize)]
pub struct SyncReport {
    pub pushed: usize,
    pub pulled: usize,
    pub last_pushed_seq: i64,
    pub last_pulled_seq: i64,
}

#[derive(Deserialize)]
pub struct SyncConfigArgs {
    pub server_url: String,
    pub token: Option<String>,
}

#[derive(Serialize)]
pub struct SyncConfig {
    pub server_url: String,
    pub token: String,
    pub device_id: String,
    pub last_pushed_seq: i64,
    pub last_pulled_seq: i64,
}

fn state_i64(c: &Connection, key: &str) -> i64 {
    get_state(c, key).and_then(|v| v.parse().ok()).unwrap_or(0)
}

#[tauri::command]
pub fn get_sync_config(db: State<'_, Db>) -> Result<SyncConfig, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    let device_id = device_id(&c)?;
    Ok(SyncConfig {
        server_url: get_state(&c, KEY_SERVER_URL).unwrap_or_default(),
        token: get_state(&c, KEY_TOKEN).unwrap_or_default(),
        device_id,
        last_pushed_seq: state_i64(&c, KEY_LAST_PUSHED),
        last_pulled_seq: state_i64(&c, KEY_LAST_PULLED),
    })
}

#[tauri::command]
pub fn set_sync_config(db: State<'_, Db>, args: SyncConfigArgs) -> Result<(), String> {
    let c = db.0.lock().expect("db mutex poisoned");
    let url = args.server_url.trim().trim_end_matches('/').to_string();
    set_state(&c, KEY_SERVER_URL, &url)?;
    set_state(&c, KEY_TOKEN, args.token.as_deref().unwrap_or(""))?;
    Ok(())
}

async fn do_push(
    db: &State<'_, Db>,
    server_url: &str,
    token: &str,
) -> Result<(usize, i64), String> {
    let (device_id, last_pushed, changes): (String, i64, Vec<OutgoingChange>) = {
        let c = db.0.lock().expect("db mutex poisoned");
        let device_id = device_id(&c)?;
        let last_pushed = state_i64(&c, KEY_LAST_PUSHED);
        let mut stmt = c
            .prepare(
                "SELECT device_seq, entity, entity_id, op, payload, updated_at
                 FROM changes WHERE device_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT 500",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![device_id, last_pushed], |row| {
                Ok(OutgoingChange {
                    device_seq: row.get(0)?,
                    entity: row.get(1)?,
                    entity_id: row.get(2)?,
                    op: row.get(3)?,
                    payload: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let changes = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        (device_id, last_pushed, changes)
    };

    if changes.is_empty() {
        return Ok((0, last_pushed));
    }

    let client = reqwest::Client::new();
    let mut req = client
        .post(format!("{server_url}/push"))
        .json(&PushRequest { device_id, changes });
    if !token.is_empty() {
        req = req.bearer_auth(token);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("同步服务返回错误: {}", resp.status()));
    }

    // On success advance last_pushed_seq to the max local seq pushed.
    let (max_seq, count): (i64, usize) = {
        let c = db.0.lock().expect("db mutex poisoned");
        let max_seq: i64 = c
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM changes WHERE seq > ?1",
                params![last_pushed],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM changes WHERE seq > ?1",
                params![last_pushed],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        set_state(&c, KEY_LAST_PUSHED, &max_seq.to_string())?;
        (max_seq, count as usize)
    };

    Ok((count, max_seq))
}

async fn do_pull(
    db: &State<'_, Db>,
    server_url: &str,
    token: &str,
) -> Result<(usize, i64), String> {
    let last_pulled = {
        let c = db.0.lock().expect("db mutex poisoned");
        state_i64(&c, KEY_LAST_PULLED)
    };

    let client = reqwest::Client::new();
    let mut req = client
        .get(format!("{server_url}/pull"))
        .query(&[("since", last_pulled.to_string()), ("limit", "500".to_string())]);
    if !token.is_empty() {
        req = req.bearer_auth(token);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("同步服务返回错误: {}", resp.status()));
    }
    let body: PullResponse = resp.json().await.map_err(|e| e.to_string())?;

    let mut max_pulled = last_pulled;
    let mut count = 0;
    {
        let c = db.0.lock().expect("db mutex poisoned");
        for change in body.changes {
            if change.seq > max_pulled {
                max_pulled = change.seq;
            }
            match (change.entity.as_str(), change.op.as_str()) {
                ("page", "upsert") => {
                    if let Some(payload) = &change.payload {
                        if let Ok(page) = serde_json::from_str::<PageDetail>(payload) {
                            apply_upsert(&c, &page)?;
                            count += 1;
                        }
                    }
                }
                ("page", "delete") => {
                    apply_delete(&c, &change.entity_id, change.updated_at)?;
                    count += 1;
                }
                _ => {}
            }
        }
        set_state(&c, KEY_LAST_PULLED, &max_pulled.to_string())?;
    }

    Ok((count, max_pulled))
}

#[tauri::command]
pub async fn sync_now(db: State<'_, Db>) -> Result<SyncReport, String> {
    let (server_url, token) = {
        let c = db.0.lock().expect("db mutex poisoned");
        (
            get_state(&c, KEY_SERVER_URL).unwrap_or_default(),
            get_state(&c, KEY_TOKEN).unwrap_or_default(),
        )
    };
    if server_url.is_empty() {
        return Err("未配置同步服务器".to_string());
    }

    let (pushed, last_pushed_seq) = do_push(&db, &server_url, &token).await?;
    let (pulled, last_pulled_seq) = do_pull(&db, &server_url, &token).await?;

    Ok(SyncReport {
        pushed,
        pulled,
        last_pushed_seq,
        last_pulled_seq,
    })
}
