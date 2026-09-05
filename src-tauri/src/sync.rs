use crate::db::Db;
use crate::models::PageDetail;
use crate::search;
use crate::security;
use futures_util::StreamExt;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use tauri::{Manager, State};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

const KEY_DEVICE_ID: &str = "device_id";
const KEY_SERVER_URL: &str = "server_url";
const KEY_TOKEN: &str = "token";
const KEY_SPACE_ID: &str = "space_id";
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

// App-level key-value state lives in meta.db (shared across every workspace).
// Only these go to meta: device_id + server_url + token. Per-workspace state
// (E2EE keys, sync cursor) stays in the space DB's own `sync_state`.
pub fn get_meta_state(c: &Connection, key: &str) -> Option<String> {
    c.query_row(
        "SELECT value FROM meta.sync_state WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn set_meta_state(c: &Connection, key: &str, value: &str) -> Result<(), String> {
    c.execute(
        "INSERT INTO meta.sync_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Store/refresh a per-server team session in `meta.auth_sessions`. Used by login/
/// register; token TTL is 30 days (server expires_at drives the real expiry).
fn set_auth_session(c: &Connection, server_url: &str, email: &str, token: &str) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    c.execute(
        "INSERT INTO auth_sessions (server_url, email, user_id, token, created_at, expires_at)
         VALUES (?1, ?2, '', ?3, ?4, ?4 + 2592000000)
         ON CONFLICT(server_url) DO UPDATE SET email=excluded.email, token=excluded.token, created_at=excluded.created_at, expires_at=excluded.expires_at",
        params![server_url, email, token, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Best-effort read of a per-server session token (`meta.auth_sessions`).
fn get_auth_token(c: &Connection, server_url: &str) -> Option<String> {
    c.query_row(
        "SELECT token FROM auth_sessions WHERE server_url = ?1",
        params![server_url],
        |row| row.get(0),
    )
    .ok()
}

/// Best-effort read of the email last logged in for a server (`meta.auth_sessions`).
/// Used to prefill the login form so a previously-synced server's account is remembered.
fn get_auth_email(c: &Connection, server_url: &str) -> Option<String> {
    c.query_row(
        "SELECT email FROM auth_sessions WHERE server_url = ?1",
        params![server_url],
        |row| row.get(0),
    )
    .ok()
}

pub fn device_id(c: &Connection) -> Result<String, String> {
    get_meta_state(c, KEY_DEVICE_ID).ok_or_else(|| "设备 ID 未初始化".to_string())
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
        "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           parent_id = excluded.parent_id,
           title = excluded.title,
           content_json = excluded.content_json,
           content_text = excluded.content_text,
           kind = excluded.kind,
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
            page.kind,
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
    space_id: String,
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
    /// Per-entity detail for "同步明细" (see SyncItem).
    pub items: Vec<SyncItem>,
}

/// One entity touched by a sync run — shown in the "同步明细" list.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct SyncItem {
    pub entity: String,   // "page" | "attachment" | ...
    pub entity_id: String,
    pub op: String,       // "upsert" | "delete"
    pub dir: String,      // "push" | "pull"
    pub title: String,    // human-readable name (page title, etc.), best-effort
}

/// Best-effort human-readable name for a change payload (page title, etc.).
fn item_title(entity: &str, payload: Option<&String>) -> String {
    if entity == "page" && payload.is_some() {
        if let Some(v) = serde_json::from_str::<serde_json::Value>(payload.unwrap()).ok() {
            if let Some(t) = v.get("title").and_then(|t| t.as_str()) {
                return t.to_string();
            }
            // Some page payloads nest the page object.
            if let Some(t) = v.get("page").and_then(|p| p.get("title")).and_then(|t| t.as_str()) {
                return t.to_string();
            }
        }
    }
    String::new()
}

#[derive(Deserialize)]
pub struct SyncConfigArgs {
    pub server_url: String,
    pub token: Option<String>,
    pub space_id: Option<String>,
}

#[derive(Serialize)]
pub struct SyncConfig {
    pub server_url: String,
    pub token: String,
    pub space_id: String,
    pub device_id: String,
    pub last_pushed_seq: i64,
    pub last_pulled_seq: i64,
}

// ---- S8: per-workspace sync profiles (multi-server / multi-space) ----

#[derive(Serialize, Deserialize, Clone)]
pub struct SyncProfile {
    pub ws_id: String,
    pub server_url: String,
    pub token: String,
    pub space_id: String,
    pub last_pushed_seq: i64,
    pub last_pulled_seq: i64,
}

const PROFILE_COLS: &str =
    "ws_id, server_url, token, space_id, last_pushed_seq, last_pulled_seq";

fn row_to_profile(r: &rusqlite::Row<'_>) -> rusqlite::Result<SyncProfile> {
    Ok(SyncProfile {
        ws_id: r.get(0)?,
        server_url: r.get(1)?,
        token: r.get(2)?,
        space_id: r.get(3)?,
        last_pushed_seq: r.get::<_, i64>(4)?,
        last_pulled_seq: r.get::<_, i64>(5)?,
    })
}

fn get_profile(c: &Connection, ws_id: &str) -> Result<SyncProfile, String> {
    let profile = c
        .query_row(
            &format!("SELECT {PROFILE_COLS} FROM sync_profiles WHERE ws_id = ?1"),
            params![ws_id],
            row_to_profile,
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(SyncProfile {
            ws_id: ws_id.to_string(),
            server_url: String::new(),
            token: String::new(),
            space_id: String::new(),
            last_pushed_seq: 0,
            last_pulled_seq: 0,
        });
    Ok(profile)
}

/// List the sync profiles of **live** workspaces only.
///
/// Workspaces are soft-deleted (`meta.workspaces.deleted_at`), and their profile
/// row is deliberately kept (so a recovered workspace keeps its binding), but a
/// deleted workspace must not show up in the sync panel as a bare UUID row, and
/// must not be pushed/pulled by `sync_now`. So the join is the single filter for
/// both call sites.
fn list_profiles(c: &Connection) -> Result<Vec<SyncProfile>, String> {
    let mut stmt = c
        .prepare(&format!(
            "SELECT {PROFILE_COLS} FROM sync_profiles p
             WHERE EXISTS (
                 SELECT 1 FROM meta.workspaces w
                 WHERE w.id = p.ws_id AND w.deleted_at IS NULL
             )
             ORDER BY p.ws_id"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_profile)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn set_profile(c: &Connection, ws_id: &str, server_url: &str, token: &str, space_id: &str) -> Result<(), String> {
    let url = server_url.trim().trim_end_matches('/').to_string();
    c.execute(
        "INSERT INTO sync_profiles (ws_id, server_url, token, space_id, last_pushed_seq, last_pulled_seq)
         VALUES (?1, ?2, ?3, ?4, 0, 0)
         ON CONFLICT(ws_id) DO UPDATE SET
           server_url = excluded.server_url,
           token = excluded.token,
           space_id = excluded.space_id",
        params![ws_id, url, token, space_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Update a single numeric field on a workspace's sync profile (best-effort).
fn set_profile_field(c: &Connection, ws_id: &str, field: &str, value: i64) -> Result<(), String> {
    // `field` is one of the trusted constants ("last_pushed_seq"/"last_pulled_seq").
    c.execute(
        &format!("UPDATE sync_profiles SET {field} = ?1 WHERE ws_id = ?2"),
        params![value, ws_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_sync_profiles(db: State<'_, Db>) -> Result<Vec<SyncProfile>, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    list_profiles(&c)
}

#[tauri::command]
pub fn set_sync_profile(
    db: State<'_, Db>,
    ws_id: String,
    server_url: String,
    token: Option<String>,
    space_id: Option<String>,
    email: Option<String>,
) -> Result<(), String> {
    let c = db.0.lock().expect("db mutex poisoned");
    set_profile(&c, &ws_id, &server_url, token.as_deref().unwrap_or(""), space_id.as_deref().unwrap_or(""))?;
    // 记住本次填的登录邮箱（供重开面板预填），只更新 email，保留已有 token/user_id。
    if let Some(e) = email.filter(|e| !e.trim().is_empty()) {
        let url = server_url.trim().trim_end_matches('/').to_string();
        let now = crate::db::now_ms();
        c.execute(
            "INSERT INTO auth_sessions (server_url, email, user_id, token, created_at, expires_at)
             VALUES (?1, ?2, '', '', ?3, 0)
             ON CONFLICT(server_url) DO UPDATE SET email = excluded.email",
            rusqlite::params![url, e, now],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn state_i64(c: &Connection, key: &str) -> i64 {
    get_state(c, key).and_then(|v| v.parse().ok()).unwrap_or(0)
}

#[tauri::command]
pub fn get_sync_config(db: State<'_, Db>) -> Result<SyncConfig, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    let device_id = device_id(&c)?;
    Ok(SyncConfig {
        server_url: get_meta_state(&c, KEY_SERVER_URL).unwrap_or_default(),
        token: get_meta_state(&c, KEY_TOKEN).unwrap_or_default(),
        space_id: get_meta_state(&c, KEY_SPACE_ID).unwrap_or_default(),
        device_id,
        last_pushed_seq: state_i64(&c, KEY_LAST_PUSHED),
        last_pulled_seq: state_i64(&c, KEY_LAST_PULLED),
    })
}

#[tauri::command]
pub fn set_sync_config(db: State<'_, Db>, args: SyncConfigArgs) -> Result<(), String> {
    let c = db.0.lock().expect("db mutex poisoned");
    let url = args.server_url.trim().trim_end_matches('/').to_string();
    set_meta_state(&c, KEY_SERVER_URL, &url)?;
    set_meta_state(&c, KEY_TOKEN, args.token.as_deref().unwrap_or(""))?;
    set_meta_state(&c, KEY_SPACE_ID, args.space_id.as_deref().unwrap_or(""))?;
    Ok(())
}

// ---- M27 团队版认证（客户端）----
// 对齐 sync-server `/auth/register` `/auth/login` `/auth/logout`。成功后把会话
// token 写入 meta.sync_state（复用 KEY_TOKEN），前端 auth store 据此维持登录态。

#[derive(serde::Serialize)]
pub struct TeamAuthResult {
    pub token: String,
}

#[tauri::command]
pub async fn team_register(
    db: State<'_, Db>,
    server_url: String,
    email: String,
    password: String,
    display: Option<String>,
    register_code: Option<String>,
) -> Result<TeamAuthResult, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/auth/register"))
        .json(&serde_json::json!({ "email": email, "password": password, "display": display, "register_code": register_code }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("注册失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let token = v.get("token").and_then(|t| t.as_str()).unwrap_or("").to_string();
    if token.is_empty() {
        return Err("服务端未返回 token".to_string());
    }
    let c = db.0.lock().expect("db mutex poisoned");
    set_meta_state(&c, KEY_SERVER_URL, &url)?;
    set_meta_state(&c, KEY_TOKEN, &token)?;
    set_auth_session(&c, &url, &email, &token)?;
    Ok(TeamAuthResult { token })
}

#[tauri::command]
pub async fn team_login(
    db: State<'_, Db>,
    server_url: String,
    email: String,
    password: String,
) -> Result<TeamAuthResult, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/auth/login"))
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("登录失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let token = v.get("token").and_then(|t| t.as_str()).unwrap_or("").to_string();
    if token.is_empty() {
        return Err("服务端未返回 token".to_string());
    }
    let c = db.0.lock().expect("db mutex poisoned");
    set_meta_state(&c, KEY_SERVER_URL, &url)?;
    set_meta_state(&c, KEY_TOKEN, &token)?;
    set_auth_session(&c, &url, &email, &token)?;
    Ok(TeamAuthResult { token })
}

#[tauri::command]
pub async fn team_logout(db: State<'_, Db>, server_url: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    // 先读 token（锁在块内释放，避免跨 await 持锁）。
    let token = {
        let c = db.0.lock().expect("db mutex poisoned");
        get_meta_state(&c, KEY_TOKEN).unwrap_or_default()
    };
    if !token.is_empty() {
        let client = reqwest::Client::new();
        let _ = client
            .post(format!("{url}/auth/logout"))
            .bearer_auth(&token)
            .send()
            .await;
    }
    {
        let c = db.0.lock().expect("db mutex poisoned");
        set_meta_state(&c, KEY_TOKEN, "")?;
        let _ = c.execute("DELETE FROM auth_sessions WHERE server_url = ?1", params![url]);
    }
    Ok(())
}

// ---- M27 团队空间 / 成员（客户端，Rust 代理绕过 WebView2 CORS）----
// 这些命令由前端传 server_url + token（登录态由 auth store 管理），用 reqwest
// 直连 sync-server，避免浏览器 fetch 触发 preflight 被无 CORS 层的服务端拦截。

#[derive(serde::Serialize)]
pub struct TeamSpace {
    pub id: String,
    pub name: String,
    pub role: String,
    pub owner_id: String,
}

#[derive(serde::Serialize)]
pub struct TeamMember {
    pub user_id: String,
    pub email: String,
    pub role: String,
}

#[tauri::command]
pub async fn team_list_spaces(server_url: String, token: String) -> Result<Vec<TeamSpace>, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{url}/spaces"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("拉取空间失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v["spaces"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|s| TeamSpace {
                    id: s["id"].as_str().unwrap_or("").to_string(),
                    name: s["name"].as_str().unwrap_or("").to_string(),
                    role: s["role"].as_str().unwrap_or("").to_string(),
                    owner_id: s["owner_id"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn team_create_space(server_url: String, token: String, name: String, org_id: Option<String>) -> Result<TeamSpace, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/spaces"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "name": name, "org_id": org_id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("创建空间失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(TeamSpace {
        id: v["id"].as_str().unwrap_or("").to_string(),
        name: v["name"].as_str().unwrap_or("").to_string(),
        role: v["role"].as_str().unwrap_or("").to_string(),
        owner_id: v["owner_id"].as_str().unwrap_or("").to_string(),
    })
}

#[tauri::command]
pub async fn team_list_members(server_url: String, token: String, space_id: String) -> Result<Vec<TeamMember>, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{url}/spaces/{space_id}/members"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("拉取成员失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v["members"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|m| TeamMember {
                    user_id: m["user_id"].as_str().unwrap_or("").to_string(),
                    email: m["email"].as_str().unwrap_or("").to_string(),
                    role: m["role"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn team_invite_member(server_url: String, token: String, space_id: String, email: String, role: String) -> Result<(), String> {
    team_member_post(&server_url, &token, &space_id, &email, &role).await
}

#[tauri::command]
pub async fn team_set_member_role(server_url: String, token: String, space_id: String, email: String, role: String) -> Result<(), String> {
    team_member_post(&server_url, &token, &space_id, &email, &role).await
}

async fn team_member_post(server_url: &str, token: &str, space_id: &str, email: &str, role: &str) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/spaces/{space_id}/members"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "user_email": email, "role": role }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("成员操作失败 {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn team_remove_member(server_url: String, token: String, space_id: String, user_id: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .delete(format!("{url}/spaces/{space_id}/members/{user_id}"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("移除成员失败 {}", resp.status()));
    }
    Ok(())
}

// ---- P0 org management (research group) ----
// A group leader (admin) manages member accounts and sees group-owned spaces.
// These call the sync-server /org/* endpoints (desktop only; the Web driver
// throws "仅桌面").

#[derive(serde::Serialize)]
pub struct TeamOrg {
    pub id: String,
    pub name: String,
    pub role: String,
    pub owner_id: String,
}

#[derive(serde::Serialize)]
pub struct TeamOrgMember {
    pub user_id: String,
    pub email: String,
    pub role: String,
    pub disabled: bool,
}

#[derive(serde::Serialize)]
pub struct TeamOrgInvite {
    pub email: String,
    pub status: String,
}

#[derive(serde::Serialize)]
pub struct TeamOrgMemberList {
    pub members: Vec<TeamOrgMember>,
    pub pending: Vec<TeamOrgInvite>,
}

#[tauri::command]
pub async fn team_list_orgs(server_url: String, token: String) -> Result<Vec<TeamOrg>, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{url}/orgs"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("拉取组织失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v["orgs"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|s| TeamOrg {
                    id: s["id"].as_str().unwrap_or("").to_string(),
                    name: s["name"].as_str().unwrap_or("").to_string(),
                    role: s["role"].as_str().unwrap_or("").to_string(),
                    owner_id: s["owner_id"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn team_create_org(server_url: String, token: String, name: String) -> Result<TeamOrg, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/orgs"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "name": name }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("创建组织失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(TeamOrg {
        id: v["id"].as_str().unwrap_or("").to_string(),
        name: v["name"].as_str().unwrap_or("").to_string(),
        role: v["role"].as_str().unwrap_or("").to_string(),
        owner_id: v["owner_id"].as_str().unwrap_or("").to_string(),
    })
}

#[tauri::command]
pub async fn team_list_org_members(server_url: String, token: String, org_id: String) -> Result<TeamOrgMemberList, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{url}/orgs/{org_id}/members"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("拉取成员失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let members = v["members"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|s| TeamOrgMember {
                    user_id: s["user_id"].as_str().unwrap_or("").to_string(),
                    email: s["email"].as_str().unwrap_or("").to_string(),
                    role: s["role"].as_str().unwrap_or("").to_string(),
                    disabled: s["disabled"].as_bool().unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default();
    let pending = v["pending"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|s| TeamOrgInvite {
                    email: s["email"].as_str().unwrap_or("").to_string(),
                    status: s["status"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(TeamOrgMemberList { members, pending })
}

#[tauri::command]
pub async fn team_approve_org_invite(server_url: String, token: String, org_id: String, email: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/orgs/{org_id}/invites/approve"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "email": email }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("批准成员失败 {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn team_reject_org_invite(server_url: String, token: String, org_id: String, email: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/orgs/{org_id}/invites/reject"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "email": email }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("拒绝成员失败 {}", resp.status()));
    }
    Ok(())
}

/// Self-deactivation (graduation handover). Revokes the session, disables the
/// account, and hands the caller's owned spaces to the org leader.
#[tauri::command]
pub async fn team_deactivate_account(server_url: String, token: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .delete(format!("{url}/auth/account"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("注销账号失败 {}", resp.status()));
    }
    Ok(())
}

/// Leader deactivates a group member (graduation handover).
#[tauri::command]
pub async fn team_deactivate_org_member(server_url: String, token: String, org_id: String, user_id: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/orgs/{org_id}/members/{user_id}/deactivate"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("注销成员失败 {}", resp.status()));
    }
    Ok(())
}

/// Leader generates / resets an org invite code; returns the code to hand out.
#[tauri::command]
pub async fn team_generate_org_invite_code(server_url: String, token: String, org_id: String) -> Result<String, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/orgs/{org_id}/invite-code"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("生成邀请码失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v["invite_code"].as_str().unwrap_or("").to_string())
}

/// A user joins an org by invite code (the code is the authorization).
#[tauri::command]
pub async fn team_join_org_by_code(server_url: String, token: String, code: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/orgs/join"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("加入组织失败 {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn team_invite_org_member(server_url: String, token: String, org_id: String, email: String, role: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/orgs/{org_id}/members"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "email": email, "role": role }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("邀请成员失败 {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn team_set_org_member_active(server_url: String, token: String, org_id: String, user_id: String, active: bool) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .patch(format!("{url}/orgs/{org_id}/members/{user_id}"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "active": active }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("切换成员状态失败 {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn team_remove_org_member(server_url: String, token: String, org_id: String, user_id: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .delete(format!("{url}/orgs/{org_id}/members/{user_id}"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("移除成员失败 {}", resp.status()));
    }
    Ok(())
}

/// M27 当前会话（后端存于 meta.sync_state 的 KEY_SERVER_URL/KEY_TOKEN）。
/// 前端启动时读取以恢复登录态（有 token 即视为已登录）。
#[derive(serde::Serialize)]
pub struct TeamSession {
    pub server_url: String,
    pub token: String,
}

#[tauri::command]
pub fn team_get_session(db: State<'_, Db>) -> Result<TeamSession, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    Ok(TeamSession {
        server_url: get_meta_state(&c, KEY_SERVER_URL).unwrap_or_default(),
        token: get_meta_state(&c, KEY_TOKEN).unwrap_or_default(),
    })
}

/// Return the current user's identity (email) for the given server, so the UI can
/// show which account is logged in.
#[derive(serde::Serialize)]
pub struct TeamMe {
    pub email: String,
}

#[tauri::command]
pub async fn team_get_me(server_url: String, token: String) -> Result<TeamMe, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{url}/auth/me"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("获取账号失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(TeamMe {
        email: v["email"].as_str().unwrap_or("").to_string(),
    })
}

/// Return the email last logged in for a server (local `meta.auth_sessions`), so a
/// previously-synced server's account can be prefilled in the login form.
#[tauri::command]
pub fn team_get_server_email(db: State<'_, Db>, server_url: String) -> Result<Option<String>, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    Ok(get_auth_email(&c, &server_url))
}

/// List recent sync-history entries (newest first).
#[tauri::command]
pub fn list_sync_history(db: State<'_, Db>, limit: Option<usize>) -> Result<Vec<SyncHistoryEntry>, String> {
    let limit = limit.unwrap_or(20);
    let c = db.0.lock().expect("db mutex poisoned");
    let mut stmt = c
        .prepare("SELECT ws_id, ws_name, at, pushed, pulled, ok, message, items FROM sync_history ORDER BY at DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![limit as i64], |r| {
            let items_json: String = r.get(7)?;
            let items: Vec<SyncItem> = if items_json.is_empty() {
                Vec::new()
            } else {
                serde_json::from_str(&items_json).unwrap_or_default()
            };
            Ok(SyncHistoryEntry {
                ws_id: r.get(0)?,
                ws_name: r.get(1)?,
                at: r.get(2)?,
                pushed: r.get(3)?,
                pulled: r.get(4)?,
                ok: r.get(5)?,
                message: r.get(6)?,
                items,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Clear all sync-history entries (local meta).
#[tauri::command]
pub fn clear_sync_history(db: State<'_, Db>) -> Result<(), String> {
    let c = db.0.lock().expect("db mutex poisoned");
    c.execute("DELETE FROM sync_history", []).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct SyncHistoryEntry {
    pub ws_id: String,
    pub ws_name: String,
    pub at: i64,
    pub pushed: i64,
    pub pulled: i64,
    pub ok: bool,
    pub message: String,
    pub items: Vec<SyncItem>,
}


async fn do_push(
    db: &State<'_, Db>,
    profile: &SyncProfile,
) -> Result<(usize, i64, Vec<SyncItem>), String> {
    let (device_id, last_pushed, changes): (String, i64, Vec<OutgoingChange>) = {
        let c = db.0.lock().expect("db mutex poisoned");
        security::sync_gate(&c)?;
        let device_id = device_id(&c)?;
        let last_pushed = profile.last_pushed_seq;
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
        // If E2EE is enabled, encrypt each payload before it leaves the device.
        let changes = if security::key_if_enabled(&c).is_some() {
            let mut out = Vec::with_capacity(changes.len());
            for mut ch in changes {
                if let Some(p) = ch.payload.take() {
                    ch.payload = Some(security::encrypt_payload(&c, &p)?);
                }
                out.push(ch);
            }
            out
        } else {
            changes
        };
        (device_id, last_pushed, changes)
    };

    if changes.is_empty() {
        return Ok((0, last_pushed, Vec::new()));
    }
    // 收集本次 push 的实体明细（供「同步明细」显示）。
    let items: Vec<SyncItem> = changes
        .iter()
        .map(|ch| {
            let title = item_title(&ch.entity, ch.payload.as_ref());
            SyncItem { entity: ch.entity.clone(), entity_id: ch.entity_id.clone(), op: ch.op.clone(), dir: "push".to_string(), title }
        })
        .collect();

    let client = reqwest::Client::new();
    let mut req = client
        .post(format!("{}/push", profile.server_url))
        .json(&PushRequest { device_id, space_id: profile.space_id.clone(), changes });
    let token = { let c = db.0.lock().expect("db mutex poisoned"); get_auth_token(&c, &profile.server_url).unwrap_or_else(|| profile.token.clone()) };
    if !token.is_empty() {
        req = req.bearer_auth(&token);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            "同步失败：会话已失效，请重新登录".to_string()
        } else {
            format!("同步服务返回错误: {}", resp.status())
        });
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
        set_profile_field(&c, &profile.ws_id, "last_pushed_seq", max_seq)?;
        (max_seq, count as usize)
    };

    Ok((count, max_seq, items))
}

async fn do_pull(
    db: &State<'_, Db>,
    profile: &SyncProfile,
) -> Result<(usize, i64, Vec<SyncItem>), String> {
    let last_pulled = {
        let c = db.0.lock().expect("db mutex poisoned");
        security::sync_gate(&c)?;
        profile.last_pulled_seq
    };

    let client = reqwest::Client::new();
    let my_device = {
        let c = db.0.lock().expect("db mutex poisoned");
        device_id(&c).ok()
    };
    let mut url = format!("{}/pull?since={last_pulled}&limit=500", profile.server_url);
    if !profile.space_id.is_empty() {
        url.push_str(&format!("&space_id={}", profile.space_id));
    }
    if let Some(d) = &my_device {
        url.push_str(&format!("&exclude_device={d}"));
    }
    let mut req = client.get(&url);
    let token = { let c = db.0.lock().expect("db mutex poisoned"); get_auth_token(&c, &profile.server_url).unwrap_or_else(|| profile.token.clone()) };
    if !token.is_empty() {
        req = req.bearer_auth(&token);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            "同步失败：会话已失效，请重新登录".to_string()
        } else {
            format!("同步服务返回错误: {}", resp.status())
        });
    }
    let body: PullResponse = resp.json().await.map_err(|e| e.to_string())?;

    let mut max_pulled = last_pulled;
    let mut count: usize = 0;
    let mut items: Vec<SyncItem> = Vec::new();
    {
        let c = db.0.lock().expect("db mutex poisoned");
        // 跨设备 pull 的变更可能引用了「尚未先到达」的父页 / 关联页，触发本地外键约束
        // （attachments.page_id / pages.parent_id 等）。批量应用期间临时关闭外键，
        // 应用完恢复原状态，避免整批 pull 被单个外键错误打断。
        let orig_fk: i64 = c
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap_or(0);
        let _ = c.execute_batch("PRAGMA foreign_keys = OFF;");
        for change in body.changes {
            if change.seq > max_pulled {
                max_pulled = change.seq;
            }
            let title = item_title(&change.entity, change.payload.as_ref());
            items.push(SyncItem { entity: change.entity.clone(), entity_id: change.entity_id.clone(), op: change.op.clone(), dir: "pull".to_string(), title });
            match (change.entity.as_str(), change.op.as_str()) {
                ("page", "upsert") => {
                    if let Some(payload) = &change.payload {
                        // Decrypt if E2EE is enabled (passthrough otherwise).
                        if let Ok(plain) = security::decrypt_payload(&c, payload) {
                            if let Ok(page) = serde_json::from_str::<PageDetail>(&plain) {
                                apply_upsert(&c, &page)?;
                                count += 1;
                            }
                        }
                    }
                }
                ("page", "delete") => {
                    apply_delete(&c, &change.entity_id, change.updated_at)?;
                    count += 1;
                }
                ("attachment", "upsert") => {
                    if let Some(payload) = &change.payload {
                        if let Ok(plain) = security::decrypt_payload(&c, payload) {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&plain) {
                                let id = v["id"].as_str().unwrap_or("").to_string();
                                if !id.is_empty() {
                                    let page_id: Option<String> = v["page_id"].as_str().map(|s| s.to_string());
                                    let name = v["name"].as_str().unwrap_or("").to_string();
                                    let hash = v["hash"].as_str().unwrap_or("").to_string();
                                    let mime = v["mime"].as_str().unwrap_or("").to_string();
                                    let size = v["size"].as_i64().unwrap_or(0);
                                    c.execute(
                                        "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
                                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                                         ON CONFLICT(id) DO UPDATE SET page_id=excluded.page_id, name=excluded.name, hash=excluded.hash, mime=excluded.mime, size=excluded.size",
                                        params![id, page_id, name, hash, mime, size, crate::db::now_ms()],
                                    )
                                    .map_err(|e| e.to_string())?;
                                    count += 1;
                                }
                            }
                        }
                    }
                }
                ("attachment", "delete") => {
                    c.execute("DELETE FROM attachments WHERE id = ?1", params![change.entity_id])
                        .map_err(|e| e.to_string())?;
                    count += 1;
                }
                _ => {}
            }
        }
        set_profile_field(&c, &profile.ws_id, "last_pulled_seq", max_pulled)?;
        let _ = c.execute_batch(&format!("PRAGMA foreign_keys = {orig_fk};"));
    }

    Ok((count, max_pulled, items))
}

#[derive(Serialize)]
pub struct WorkspaceSyncResult {
    pub ws_id: String,
    pub pushed: usize,
    pub pulled: usize,
    pub last_pushed_seq: i64,
    pub last_pulled_seq: i64,
    pub error: Option<String>,
}

async fn sync_workspace_only(
    app: &tauri::AppHandle,
    db: &State<'_, Db>,
    profile: &SyncProfile,
) -> Result<SyncReport, String> {
    let (pushed, last_pushed_seq, pushed_items) = do_push(db, profile).await?;
    let (pulled, last_pulled_seq, pulled_items) = do_pull(db, profile).await?;
    let att_items = sync_attachments(app, db, profile).await?;
    let mut items = pushed_items;
    items.extend(pulled_items);
    items.extend(att_items);
    Ok(SyncReport { pushed, pulled, last_pushed_seq, last_pulled_seq, items })
}

#[tauri::command]
pub async fn sync_now(app: tauri::AppHandle, db: State<'_, Db>) -> Result<Vec<WorkspaceSyncResult>, String> {
    let profiles = {
        let c = db.0.lock().expect("db mutex poisoned");
        list_profiles(&c)?
    };
    let mut results = Vec::new();
    for profile in profiles {
        // Skip empty/unbound profiles (no remote target configured).
        if profile.server_url.is_empty() || profile.space_id.is_empty() {
            continue;
        }
        let r = sync_workspace_only(&app, &db, &profile).await;
        results.push(match r {
            Ok(rep) => WorkspaceSyncResult {
                ws_id: profile.ws_id.clone(),
                pushed: rep.pushed,
                pulled: rep.pulled,
                last_pushed_seq: rep.last_pushed_seq,
                last_pulled_seq: rep.last_pulled_seq,
                error: None,
            },
            Err(e) => WorkspaceSyncResult {
                ws_id: profile.ws_id.clone(),
                pushed: 0,
                pulled: 0,
                last_pushed_seq: 0,
                last_pulled_seq: 0,
                error: Some(e),
            },
        });
    }
    Ok(results)
}

#[tauri::command]
pub async fn sync_workspace(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    ws_id: String,
) -> Result<WorkspaceSyncResult, String> {
    let profile = {
        let c = db.0.lock().expect("db mutex poisoned");
        get_profile(&c, &ws_id)?
    };
    // 服务端 S5+ 的 push/pull 强制 require_space——多设备同步必须绑定一个团队空间。
    // space_id 留空（单用户）无法走 require_space，服务端会 403。这里提前挡下，
    // 给出明确的「需绑定团队空间」提示，而不是让请求打到服务端才 403。
    if profile.server_url.is_empty() {
        return Err("请先配置同步服务器".to_string());
    }
    if profile.space_id.is_empty() {
        return Err("需绑定团队空间才能同步（多设备同步不支持留空）".to_string());
    }
    match sync_workspace_only(&app, &db, &profile).await {
        Ok(rep) => {
            write_sync_history(
                &db,
                &ws_id,
                &profile,
                rep.pushed,
                rep.pulled,
                true,
                "",
                &rep.items,
            );
            Ok(WorkspaceSyncResult {
                ws_id,
                pushed: rep.pushed,
                pulled: rep.pulled,
                last_pushed_seq: rep.last_pushed_seq,
                last_pulled_seq: rep.last_pulled_seq,
                error: None,
            })
        }
        Err(e) => {
            write_sync_history(&db, &ws_id, &profile, 0, 0, false, &e, &[]);
            Err(e)
        }
    }
}

/// Record one sync run in `meta.sync_history` (best-effort; never blocks sync).
fn write_sync_history(
    db: &State<'_, Db>,
    ws_id: &str,
    profile: &SyncProfile,
    pushed: usize,
    pulled: usize,
    ok: bool,
    message: &str,
    items: &[SyncItem],
) {
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let items_json = serde_json::json!(items).to_string();
    let r = || -> rusqlite::Result<()> {
        let c = db.0.lock().expect("db mutex poisoned");
        c.execute(
            "INSERT INTO sync_history (ws_id, ws_name, at, pushed, pulled, ok, message, items)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![ws_id, "", at, pushed as i64, pulled as i64, ok as i64, message, items_json],
        )?;
        // 只保留最近 100 条，避免无限增长。
        let _ = c.execute(
            "DELETE FROM sync_history WHERE id NOT IN (SELECT id FROM sync_history ORDER BY at DESC LIMIT 100)",
            [],
        );
        Ok(())
    };
    let _ = r();
}

#[derive(Deserialize)]
struct RemoteAttachment {
    hash: String,
    mime: String,
}

#[derive(Deserialize)]
struct RemoteAttachmentList {
    items: Vec<RemoteAttachment>,
}

async fn sync_attachments(
    app: &tauri::AppHandle,
    db: &State<'_, Db>,
    profile: &SyncProfile,
) -> Result<Vec<SyncItem>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir: PathBuf = app_data_dir.join("attachments");
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;
    let mut att_items: Vec<SyncItem> = Vec::new();

    let client = reqwest::Client::new();
    // Space-scoped attachments when bound to a team space; legacy global path otherwise.
    let att_base = if profile.space_id.is_empty() {
        profile.server_url.clone()
    } else {
        format!("{}/spaces/{}", profile.server_url, profile.space_id)
    };

    // 1. List remote hashes.
    let mut req = client.get(format!("{att_base}/attachments"));
    let token = { let c = db.0.lock().expect("db mutex poisoned"); get_auth_token(&c, &profile.server_url).unwrap_or_else(|| profile.token.clone()) };
    if !token.is_empty() {
        req = req.bearer_auth(&token);
    }
    let remote: RemoteAttachmentList = req
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let remote_set: HashSet<String> = remote.items.iter().map(|i| i.hash.clone()).collect();

    // 2. Local hashes (files on disk).
    let mut local_set = HashSet::new();
    if let Ok(entries) = std::fs::read_dir(&attachments_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // 排除 .part 临时文件（下载中断残留）：其内容哈希与目标不符，
            // 作为“本地待上传附件”上传会被服务端 SHA-256 校验拒绝（400）。
            if name.ends_with(".part") { continue; }
            if let Some(stem) = name.split('.').next() {
                local_set.insert(stem.to_string());
            }
        }
    }

    // 3. Upload local attachments missing on server. When at-rest encryption is on
    // (session unlocked), the on-disk bytes are ciphertext (nonce||ct) while the
    // server verifies SHA-256 against the claimed (plaintext) hash — so we must
    // decrypt before upload. When encryption is off, stream the plaintext file
    // directly to keep large-file memory usage low.
    let session_key = {
        let c = db.0.lock().expect("db mutex poisoned");
        security::key_if_enabled(&c)
    };
    for hash in local_set.difference(&remote_set) {
        let path = match find_file_by_stem(&attachments_dir, hash) {
            Some(p) => p,
            None => continue,
        };
        // Determine mime from local DB row.
        let mime = {
            let c = db.0.lock().expect("db mutex poisoned");
            c.query_row(
                "SELECT mime FROM attachments WHERE hash = ?1 LIMIT 1",
                params![hash],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
            .unwrap_or_else(|| "application/octet-stream".to_string())
        };
        let body = match &session_key {
            Some(k) => {
                let raw = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
                let plain = security::decrypt_attachment_bytes(Some(k), &raw)?;
                reqwest::Body::from(plain)
            }
            None => {
                let file = tokio::fs::File::open(&path).await.map_err(|e| e.to_string())?;
                reqwest::Body::wrap_stream(ReaderStream::new(file))
            }
        };
        let mut req = client
            .post(format!("{att_base}/attachments/{hash}?mime={mime}"))
            .body(body);
        if !profile.token.is_empty() {
            req = req.bearer_auth(&profile.token);
        }
        req.send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        att_items.push(SyncItem { entity: "attachment".to_string(), entity_id: hash.clone(), op: "upsert".to_string(), dir: "push".to_string(), title: String::new() });
    }

    // 4. Download remote attachments missing locally.
    let local_mimes: std::collections::HashMap<String, String> = {
        let c = db.0.lock().expect("db mutex poisoned");
        let mut map = std::collections::HashMap::new();
        let mut stmt = c
            .prepare("SELECT hash, mime FROM attachments")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            map.insert(r.0, r.1);
        }
        map
    };

    for item in &remote.items {
        // The hash comes from the server (untrusted): reject anything that is not a
        // canonical SHA-256 hex before joining it into a filesystem path, to prevent
        // a malicious server from writing outside the attachments dir.
        if !is_valid_attachment_hash(&item.hash) {
            continue;
        }
        if local_set.contains(&item.hash) {
            continue;
        }
        let mut req = client.get(format!("{att_base}/attachments/{}", item.hash));
        if !profile.token.is_empty() {
            req = req.bearer_auth(&profile.token);
        }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            continue;
        }
        let ext = ext_from_mime(&item.mime);
        let path = attachments_dir.join(format!("{}.{}", item.hash, ext));
        let mut size: i64 = 0;
        if !path.exists() {
            let tmp = attachments_dir.join(format!("{}.part", item.hash));
            let mut file = tokio::fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| e.to_string())?;
                size += chunk.len() as i64;
                file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            }
            file.flush().await.map_err(|e| e.to_string())?;
            drop(file);
            std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
            // E1: when at-rest encryption is on, store the downloaded PLAINTEXT
            // encrypted (nonce||ct) like every other attachment, so the read path
            // (decrypt/passthrough) and the at-rest guarantee stay consistent.
            if let Some(k) = &session_key {
                if let Ok(plain) = std::fs::read(&path) {
                    if let Ok(bytes) = security::encrypt_attachment_bytes(Some(k), &plain) {
                        let _ = std::fs::write(&path, &bytes);
                    }
                }
            }
        }
        // Insert/ignore into attachments table.
        {
            let c = db.0.lock().expect("db mutex poisoned");
            let id = uuid::Uuid::new_v4().to_string();
            c.execute(
                "INSERT OR IGNORE INTO attachments (id, page_id, name, hash, mime, size, created_at)
                 VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6)",
                params![id, format!("{}.{}", item.hash, ext), item.hash, item.mime, size, crate::db::now_ms()],
            )
            .map_err(|e| e.to_string())?;
        }
        att_items.push(SyncItem { entity: "attachment".to_string(), entity_id: item.hash.clone(), op: "upsert".to_string(), dir: "pull".to_string(), title: String::new() });
    }

    // Reuse local mimes for hash resolution (kept for future use).
    let _ = local_mimes;
    Ok(att_items)
}

/// Canonical SHA-256 hex (64 chars). Used to validate server-supplied hashes
/// before joining them into a local filesystem path — prevents path traversal if
/// a malicious/compromised sync server returns e.g. `../../meta.db` as a hash.
fn is_valid_attachment_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())
}

fn find_file_by_stem(dir: &PathBuf, stem: &str) -> Option<PathBuf> {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".part") { continue; }
            if name.split('.').next() == Some(stem) {
                return Some(entry.path());
            }
        }
    }
    None
}

fn ext_from_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "application/pdf" => "pdf",
        _ => "bin",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 复刻生产布局：main 为空间库，meta 作为 ATTACH 库承载 workspaces/sync_profiles。
    fn conn_with_meta() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("ATTACH DATABASE ':memory:' AS meta").unwrap();
        c.execute_batch(
            "CREATE TABLE meta.workspaces (id TEXT PRIMARY KEY, deleted_at INTEGER);
             CREATE TABLE meta.sync_profiles (
                 ws_id TEXT PRIMARY KEY,
                 server_url TEXT NOT NULL DEFAULT '',
                 token TEXT NOT NULL DEFAULT '',
                 space_id TEXT NOT NULL DEFAULT '',
                 last_pushed_seq INTEGER NOT NULL DEFAULT 0,
                 last_pulled_seq INTEGER NOT NULL DEFAULT 0
             );",
        )
        .unwrap();
        c
    }

    #[test]
    fn list_profiles_skips_deleted_and_orphan_workspaces() {
        let c = conn_with_meta();
        c.execute_batch(
            "INSERT INTO meta.workspaces (id, deleted_at) VALUES ('live', NULL), ('gone', 1730000000000);
             INSERT INTO meta.sync_profiles (ws_id, server_url) VALUES
                 ('live', 'http://a'), ('gone', 'http://b'), ('orphan', 'http://c');",
        )
        .unwrap();

        let got = list_profiles(&c).unwrap();

        // 软删除的空间（gone）与没有 workspaces 行的孤儿档案（orphan）都不出现，
        // 面板不会再显示裸 UUID 行，sync_now 也不会去同步已删除的空间。
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].ws_id, "live");
        assert_eq!(got[0].server_url, "http://a");
    }

    #[test]
    fn list_profiles_keeps_row_after_workspace_restore() {
        let c = conn_with_meta();
        c.execute_batch(
            "INSERT INTO meta.workspaces (id, deleted_at) VALUES ('ws', 1730000000000);
             INSERT INTO meta.sync_profiles (ws_id, server_url) VALUES ('ws', 'http://a');",
        )
        .unwrap();
        assert!(list_profiles(&c).unwrap().is_empty());

        // 档案行只是被「隐藏」而非删除：空间恢复后绑定原样回来。
        c.execute_batch("UPDATE meta.workspaces SET deleted_at = NULL WHERE id = 'ws'").unwrap();
        let got = list_profiles(&c).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].server_url, "http://a");
    }
}
