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

/// ★ **新建一个本地空间的那一行**（隐私边界 A=3，2026-09-24）。
///
/// **分类由入口决定**：本仓是**个人版入口** ⇒ 没显式指定时一律标成 `personal`
/// （团队空间由团队流程走 `space_crypto::set_space_kind(..., Team)` 标）。
/// 于是"新建 ⇒ 还没加密 ⇒ 绑同步会被闸门拦住并引导设口令"这条链**自动成立**，
/// 不需要用户先做一次分类动作。
///
/// ⚠️ 抽成独立函数就是为了**能被判据直接驱动**（命令那层要 `State<Db>`，测不了）。
pub(crate) fn insert_new_local_space(
    c: &rusqlite::Connection,
    id: &str,
    name: &str,
    theme: &str,
    sort_order: f64,
    now: i64,
) -> Result<(), String> {
    // 走同一个写入口：**分类只在这里定义一次**（新建与导入共用，免得两处口径漂）。
    insert_space_row(
        c,
        id,
        name,
        theme,
        "",
        sort_order,
        now,
        false,
        crate::space_crypto::SpaceKind::Personal,
    )
}

/// ★★ **用户在"新建空间"那一刻选的那一类**（owner 2026-09-25 拍板 A1）。
///
/// 为什么必须走"入口决定"而不是"先建再改"：`sync_gate` 对**未分类**的空间**一律放行**
/// （`AllowedUnclassified`）⇒ 一个本该加密的个人空间如果在"建完到改分类"之间被绑了同步，
/// 它的内容就**明文上云**了。把这一问放在创建那一刻，中间没有那个窗口。
///
/// ⚠️ `raw` 是**界面传来的参数** ⇒ 走 [`parse_new_space_kind`] 的**窄进**（只认两个字面量，
/// 别的串**报错**），与读库里那列用的 `SpaceKind::parse`（宽进、认不出算未分类）刻意相反。
pub(crate) fn insert_chosen_space(
    c: &rusqlite::Connection,
    id: &str,
    name: &str,
    theme: &str,
    sort_order: f64,
    now: i64,
    raw: &str,
) -> Result<(), String> {
    let kind = parse_new_space_kind(raw)?;
    insert_space_row(c, id, name, theme, "", sort_order, now, false, kind)
}

/// 建空间时**只认两个值**（`"personal"` / `"team"`）。
///
/// 为什么窄进：这是**界面传进来的参数**。把 `"tem"` 这类拼错**静默当成"取消分类"**，会让闸门
/// 在用户以为已经归类的时候**松开**（与 `set_space_kind` 的窄进口径一致）。
fn parse_new_space_kind(raw: &str) -> Result<crate::space_crypto::SpaceKind, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "personal" => Ok(crate::space_crypto::SpaceKind::Personal),
        "team" => Ok(crate::space_crypto::SpaceKind::Team),
        other => Err(format!(
            "空间类型只认「personal」或「team」，收到的是「{other}」——不猜（猜错会让同步闸门松开）"
        )),
    }
}

/// ★ **导入一个空间包时写 meta 那一行**（owner 2026-09-24 拍板**选项 ②**）。
///
/// 口径与 [`insert_new_local_space`] **完全一致**：**分类由入口决定** ⇒ 导入进来的也是 `personal`。
/// 于是"导入 ⇒ 还没加密 ⇒ 绑同步被闸门拦住并引导设口令"这条链对导入**同样**自动成立 ——
/// 不需要用户事后自己去面板里分类（那正是"未分类＝闸门没管到它"的漏洞面）。
///
/// `encrypted` 是"导入时**顺手按空间加密了没有**"（见 `workspace_io::import_workspace`：
/// 本机已解锁且有袋子 ⇒ 给新空间现造盒子并加密；否则**留明文**并由面板引导）。
pub(crate) fn insert_imported_space(
    c: &rusqlite::Connection,
    id: &str,
    name: &str,
    theme: &str,
    icon: &str,
    sort_order: f64,
    now: i64,
    encrypted: bool,
) -> Result<(), String> {
    insert_space_row(
        c,
        id,
        name,
        theme,
        icon,
        sort_order,
        now,
        encrypted,
        crate::space_crypto::SpaceKind::Personal,
    )
}

/// 新建 / 导入 **共用**的那一条 INSERT（`kind` 只有一个来源，见两个公开入口的注释）。
fn insert_space_row(
    c: &rusqlite::Connection,
    id: &str,
    name: &str,
    theme: &str,
    icon: &str,
    sort_order: f64,
    now: i64,
    encrypted: bool,
    kind: crate::space_crypto::SpaceKind,
) -> Result<(), String> {
    c.execute(
        "INSERT INTO meta.workspaces (id, name, theme, icon, sort_order, created_at, updated_at, encrypted, kind)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            name,
            theme,
            icon,
            sort_order,
            now,
            now,
            if encrypted { 1 } else { 0 },
            kind.as_str()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn create_workspace(
    db: State<'_, Db>,
    name: Option<String>,
    kind: Option<String>,
) -> Result<WorkspaceMeta, String> {
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
        // ★ A1（owner 2026-09-25 拍板）：界面**在创建那一刻**已经问过"个人 / 团队"。
        // 没传 kind（老调用方 / Web）⇒ 走原来的默认（`personal`），行为逐字不变。
        match kind.as_deref() {
            Some(k) => insert_chosen_space(&c, &id, &name, &theme, sort_order, now, k)?,
            None => insert_new_local_space(&c, &id, &name, &theme, sort_order, now)?,
        }
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
    // Build the welcome page from structured blocks. Small local fns keep every
    // serde_json literal shallow, so the json! macro recursion limit isn't hit.
    fn js_text(s: &str) -> serde_json::Value {
        serde_json::json!({ "type": "text", "text": s, "detail": 0, "format": 0, "mode": "normal", "style": "", "version": 1 })
    }
    fn js_para(s: &str) -> serde_json::Value {
        serde_json::json!({ "type": "paragraph", "version": 1, "direction": "ltr", "format": "", "indent": 0, "style": "", "children": [js_text(s)] })
    }
    fn js_heading(tag: &str, s: &str) -> serde_json::Value {
        serde_json::json!({ "type": "heading", "tag": tag, "version": 1, "direction": "ltr", "format": "", "indent": 0, "style": "", "children": [js_text(s)] })
    }
    fn js_bullet(items: &[&str]) -> serde_json::Value {
        let children = items
            .iter()
            .map(|s| serde_json::json!({ "type": "listitem", "value": 1, "version": 1, "direction": "ltr", "format": "", "indent": 0, "style": "", "children": [js_text(s)] }))
            .collect::<Vec<_>>();
        serde_json::json!({ "type": "list", "tag": "ul", "listType": "bullet", "start": 1, "version": 1, "direction": "ltr", "format": "", "indent": 0, "style": "", "children": children })
    }
    fn js_quote(s: &str) -> serde_json::Value {
        serde_json::json!({ "type": "quote", "version": 1, "direction": "ltr", "format": "", "indent": 0, "style": "", "children": [js_text(s)] })
    }
    fn js_callout(s: &str) -> serde_json::Value {
        serde_json::json!({ "type": "callout", "version": 1, "direction": "ltr", "format": "", "indent": 0, "style": "", "children": [js_para(s)] })
    }
    fn js_blank() -> serde_json::Value {
        serde_json::json!({ "type": "paragraph", "version": 1, "direction": "ltr", "format": "", "indent": 0, "style": "", "children": [] })
    }
    let home_json = serde_json::json!({
        "root": {
            "type": "root", "version": 1, "direction": "ltr", "format": "", "indent": 0,
            "children": [
                js_heading("h1", "欢迎来到你的新空间"),
                js_callout("本地优先 · 离线可用。你的笔记都保存在本机，改动即存，无需手动保存。"),
                js_heading("h2", "从这里开始"),
                js_bullet(&[
                    "新建页面：Ctrl+N 或左侧栏 ＋",
                    "插入内容：输入 / 打开块菜单（标题·表格·分栏·绘图…）",
                    "搭建数据库：创建为数据表格，属性页做看板 / 日历 / 时间轴",
                ]),
                js_heading("h2", "常用快捷键"),
                js_quote("Ctrl+K 命令面板 · Ctrl+/ 快捷键面板 · Ctrl+Shift+F 搜索 · Ctrl+E 切换笔记/看板/关系图"),
                serde_json::json!({ "type": "horizontalrule", "version": 1, "direction": "ltr", "format": "", "indent": 0, "style": "" }),
                js_callout("用 / 插入块或从模板中心创建；命令面板 Ctrl+K 找到所有能力；/帮助 打开完整使用指南。"),
                js_blank(),
            ]
        }
    }).to_string();
    // A welcoming cover + icon so the new space's start page feels finished.
    let home_cover = r#"url("/covers/default-cover.jpg")"#;
    let home_icon = "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBzdGFuZGFsb25lPSJubyI/PjwhRE9DVFlQRSBzdmcgUFVCTElDICItLy9XM0MvL0RURCBTVkcgMS4xLy9FTiIgImh0dHA6Ly93d3cudzMub3JnL0dyYXBoaWNzL1NWRy8xLjEvRFREL3N2ZzExLmR0ZCI+PHN2ZyB0PSIxNzg4MTg1NDc5MzUyIiBjbGFzcz0iaWNvbiIgdmlld0JveD0iMCAwIDEwMjQgMTAyNCIgdmVyc2lvbj0iMS4xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHAtaWQ9IjE2NjIiIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCI+PHBhdGggZD0iTTY5NC4yNzIgMjIwLjY3MmMtMTcuMDY2NjY3LTg1LjMzMzMzMy04MS4wNjY2NjctMTYyLjEzMzMzMy0xNzQuOTMzMzMzLTE1My42LTkzLjg2NjY2NyAxMi44LTI0My4yIDgxLjA2NjY2Ny0yMjEuODY2NjY3IDM1NC4xMzMzMzNzNzYuOCA0MDEuMDY2NjY3IDI0Ny40NjY2NjcgNDA5LjYgMzA3LjItMTc0LjkzMzMzMyAzMjguNTMzMzMzLTI2MC4yNjY2NjZjMTcuMDY2NjY3LTY0IDQ2LjkzMzMzMy0xMjMuNzMzMzMzIDg5LjYtMTc0LjkzMzMzNCAyNS42LTM4LjQtNjguMjY2NjY3LTk4LjEzMzMzMy0xMjgtMzQuMTMzMzMzLTU5LjczMzMzMyA2OC4yNjY2NjctNTkuNzMzMzMzIDExMC45MzMzMzMtMTEwLjkzMzMzMyAxMzIuMjY2NjY3LTguNTMzMzMzLTQ2LjkzMzMzMy0xMi44LTE4Ny43MzMzMzMtMjkuODY2NjY3LTI3My4wNjY2Njd6IiBmaWxsPSIjRkZDNjJBIiBvcGFjaXR5PSIuNCIgcC1pZD0iMTY2MyI+PC9wYXRoPjxwYXRoIGQ9Ik03NS42MDUzMzMgNjI2LjAwNTMzM2MyOS44NjY2NjcgNTUuNDY2NjY3IDY4LjI2NjY2NyAxMDYuNjY2NjY3IDExNS4yIDE1My42IDY4LjI2NjY2NyA4MS4wNjY2NjcgMTQwLjggMTgzLjQ2NjY2NyAyMDkuMDY2NjY3IDIxMy4zMzMzMzQgODUuMzMzMzMzIDM4LjQgMTQ1LjA2NjY2NyAxMi44IDIzNC42NjY2NjctMzQuMTMzMzM0IDExOS40NjY2NjctNTkuNzMzMzMzIDE3NC45MzMzMzMtMTU3Ljg2NjY2NyAxMzIuMjY2NjY2LTI5OC42NjY2NjYtMjkuODY2NjY3LTEwNi42NjY2NjctNDYuOTMzMzMzLTIxNy42LTU1LjQ2NjY2Ni0zMjguNTMzMzM0LTQuMjY2NjY3LTU1LjQ2NjY2Ny0xMTkuNDY2NjY3LTM4LjQtMTMyLjI2NjY2NyA1NS40NjY2NjctMTIuOCA5OC4xMzMzMzMgMjUuNiAxMzIuMjY2NjY3LTQuMjY2NjY3IDE4My40NjY2NjctMzguNC0zNC4xMzMzMzMtOTguMTMzMzMzLTg5LjYtMTM2LjUzMzMzMy0xMjMuNzMzMzM0cy0xNzAuNjY2NjY3LTE2Ni40LTIzOC45MzMzMzMtMTY2LjRjLTI5Ljg2NjY2NyAwLTY0IDguNTMzMzMzLTg5LjYgMjUuNi0yNS42IDIxLjMzMzMzMy0zOC40IDQ2LjkzMzMzMy00Ni45MzMzMzQgNzYuOCAwIDU1LjQ2NjY2Ny0xNy4wNjY2NjcgMTY2LjQgMTIuOCAyNDMuMnoiIGZpbGw9IiNGRkM2MkEiIHAtaWQ9IjE2NjQiPjwvcGF0aD48cGF0aCBkPSJNMjU0LjgwNTMzMyAxMS42MDUzMzNsNTkuNzMzMzM0IDE2Mi4xMzMzMzQgMjEuMzMzMzMzLTE2Mi4xMzMzMzRoLTgxLjA2NjY2N3ogbS0yMDAuNTMzMzMzIDE2Mi4xMzMzMzRsMTQwLjggMzguNC04MS4wNjY2NjctMTIzLjczMzMzNC01OS43MzMzMzMgODUuMzMzMzM0eiIgZmlsbD0iIzE1NDRGRiIgb3BhY2l0eT0iLjYiIHAtaWQ9IjE2NjUiPjwvcGF0aD48L3N2Zz4=";
    c.execute(
        "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, cover, icon, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, 'page', 0, ?6, ?7, ?8, ?8, NULL)",
        params![
            home_id, id, "开始",
            home_json,
            "欢迎来到你的新空间\n本地优先 · 离线可用。你的笔记都保存在本机，改动即存，无需手动保存。\n从这里开始\n新建页面：Ctrl+N 或左侧栏 ＋\n插入内容：输入 / 打开块菜单（标题·表格·分栏·绘图…）\n搭建数据库：创建为数据表格，属性页做看板 / 日历 / 时间轴\n常用快捷键\nCtrl+K 命令面板 · Ctrl+/ 快捷键面板 · Ctrl+Shift+F 搜索 · Ctrl+E 切换笔记/看板/关系图\n用 / 插入块或从模板中心创建；命令面板 Ctrl+K 找到所有能力；/帮助 打开完整使用指南。",
            home_cover,
            home_icon,
            now,
        ],
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

/// Copy a page (and its descendant tree) into another workspace, **across DBs**.
/// The source rows are read from the current (active) space's DB; the rows are
/// inserted into the TARGET space's DB (opened independently via open_space_conn).
/// The copied rows keep their blockIds so intra-subtree block references still
/// resolve; references to blocks outside the copied subtree become unresolved
/// (documented limit, since block graphs are workspace-scoped). Properties, tags
/// and attachment rows are re-parented to the new page ids. Attachment BYTES live
/// in the global content-addressed store (shared across spaces), so only the
/// attachment rows are copied — no byte duplication.
#[tauri::command]
pub fn copy_page_to_workspace(
    db: State<Db>,
    page_id: String,
    target_workspace_id: String,
    new_parent_id: Option<String>,
) -> Result<String, String> {
    let src = conn(&db);

    // Validate the target workspace exists (in meta).
    let ws_ok: bool = src
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM meta.workspaces WHERE id = ?1 AND deleted_at IS NULL)",
            params![target_workspace_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !ws_ok {
        return Err("目标工作空间不存在".to_string());
    }

    // If copying within the same space, the target conn is the main connection.
    let active = active_workspace_id(&src)?;
    let same_space = target_workspace_id == active;

    // Validate the source page exists in the source space.
    let src_exists: bool = src
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pages WHERE id = ?1 AND deleted_at IS NULL)",
            params![page_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !src_exists {
        return Err("源页面不存在".to_string());
    }

    // Collect the source subtree in BFS order, mapping old -> new id.
    let mut id_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut queue: Vec<String> = vec![page_id.clone()];
    let mut order: Vec<String> = Vec::new();
    while let Some(pid) = queue.pop() {
        let nid = uuid::Uuid::new_v4().to_string();
        id_map.insert(pid.clone(), nid.clone());
        order.push(pid.clone());
        let mut stmt = src
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

    // Open the target space's connection (may re-open the active file if same_space).
    let tgt = if same_space {
        None
    } else {
        Some(crate::db::open_space_conn(&target_workspace_id)?)
    };
    let tgt = tgt.as_ref().unwrap_or(&src);

    // Validate the new parent against the TARGET space.
    if let Some(np) = &new_parent_id {
        let parent_ok: bool = tgt
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pages WHERE id = ?1 AND deleted_at IS NULL)",
                params![np],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !parent_ok {
            return Err("目标父页面不存在于目标工作空间".to_string());
        }
    }

    let now = now_ms();
    for old_id in &order {
        // Fetch source row from the SOURCE connection.
        let (parent, title, content_json, content_text, kind, sort_order, created_at, icon, cover, cover_height, cover_pos): (
            Option<String>,
            String,
            String,
            String,
            String,
            f64,
            i64,
            String,
            String,
            i64,
            f64,
        ) = src
            .query_row(
                "SELECT parent_id, title, content_json, content_text, kind, sort_order, created_at, icon, cover, cover_height, cover_pos
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
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                        r.get(10)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;

        let new_id = id_map.get(old_id).cloned().unwrap_or_default();
        // Root gets the caller's new parent; descendants get their mapped parent.
        let new_parent = if old_id == &page_id {
            new_parent_id.clone()
        } else {
            parent.as_deref().map(|p| id_map.get(p).cloned()).flatten()
        };

        tgt.execute(
            "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at, icon, cover, cover_height, cover_pos)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12, ?13, ?14)",
            params![new_id, target_workspace_id, new_parent, title, content_json, content_text, kind, sort_order, created_at, now, icon, cover, cover_height, cover_pos],
        )
        .map_err(|e| e.to_string())?;

        // Copy page props, tags, and attachment rows (bytes are content-addressed/global).
        tgt.execute(
            "INSERT INTO page_props (page_id, attr_id, value)
             SELECT ?1, attr_id, value FROM page_props WHERE page_id = ?2",
            params![new_id, old_id],
        )
        .map_err(|e| e.to_string())?;
        tgt.execute(
            "INSERT INTO page_tags (page_id, tag_id)
             SELECT ?1, tag_id FROM page_tags WHERE page_id = ?2",
            params![new_id, old_id],
        )
        .map_err(|e| e.to_string())?;
        tgt.execute(
            "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
             SELECT ?1, ?2, name, hash, mime, size, created_at FROM attachments WHERE page_id = ?3",
            params![uuid::Uuid::new_v4().to_string(), new_id, old_id],
        )
        .map_err(|e| e.to_string())?;

        // Rebuild indexes in the TARGET space so search/blocks/backlinks/graph work.
        crate::search::sync_fts(tgt, &new_id, &title, &content_text)?;
        crate::blocks::rebuild_block_graph(tgt, &new_id, &content_json, &content_text)?;

        // Record a sync upsert (against the target's changes outbox).
        let detail = crate::models::PageDetail {
            id: new_id.clone(),
            workspace_id: target_workspace_id.clone(),
            parent_id: new_parent,
            title,
            content_json,
            content_text,
            cover: String::new(),
            icon: String::new(),
            cover_height: 300,
            cover_pos: 50.0,
            kind,
            sort_order,
            created_at,
            updated_at: now,
        };
        crate::sync::record_page_upsert(tgt, &detail)?;
    }

    // The temporary target connection (if any) drops at end of scope; the ref
    // binding `tgt` borrows either it or the main conn.
    Ok(id_map.get(&page_id).cloned().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 只够 `insert_space_row` 用的最小 `meta.workspaces`（列与 `db::meta_migrate` 同形）。
    fn conn_with_workspaces() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch("ATTACH DATABASE ':memory:' AS meta").unwrap();
        c.execute_batch(
            "CREATE TABLE meta.workspaces (
                 id TEXT PRIMARY KEY,
                 name TEXT NOT NULL DEFAULT '',
                 theme TEXT NOT NULL DEFAULT '',
                 icon TEXT NOT NULL DEFAULT '',
                 sort_order REAL NOT NULL DEFAULT 0,
                 created_at INTEGER NOT NULL DEFAULT 0,
                 updated_at INTEGER NOT NULL DEFAULT 0,
                 deleted_at INTEGER,
                 encrypted INTEGER NOT NULL DEFAULT 0,
                 kind TEXT NOT NULL DEFAULT ''
             );",
        )
        .unwrap();
        c
    }

    fn kind_of(c: &rusqlite::Connection, id: &str) -> String {
        c.query_row("SELECT kind FROM meta.workspaces WHERE id = ?1", [id], |r| r.get(0)).unwrap()
    }

    /// ★ A1 判据：**用户在创建那一刻选的那一类，必须真的落库**（个人 / 团队各一条）。
    ///
    /// 为什么承重：分类是**同步闸门唯一的输入**。落错了的表现不是报错，而是
    /// "个人空间没加密也能绑同步"（内容明文上云）——**能编译、别处单测也照绿**。
    #[test]
    fn the_kind_chosen_at_creation_is_what_lands_in_the_row() {
        let c = conn_with_workspaces();
        insert_chosen_space(&c, "s-personal", "我的", "#e11", 1.0, 1_000, "personal").unwrap();
        insert_chosen_space(&c, "s-team", "大家的", "#e22", 2.0, 1_000, "team").unwrap();
        assert_eq!(kind_of(&c, "s-personal"), "personal");
        assert_eq!(kind_of(&c, "s-team"), "team");
        // 大小写与空白照收（界面给的是字面量，但别为多一个空格就报错）
        insert_chosen_space(&c, "s-team2", "大家的2", "#e33", 3.0, 1_000, " Team ").unwrap();
        assert_eq!(kind_of(&c, "s-team2"), "team");
    }

    /// ★ A1 判据（**窄进**）：界面传了别的东西 ⇒ **报错**，而且**一行都不写**。
    ///
    /// 为什么不能"认不出就当未分类"：未分类在闸门眼里是**放行**的 ⇒ 那会让用户
    /// "以为自己选了个类型、其实闸门松开了"。所以这里刻意与读库那侧（`SpaceKind::parse` 宽进）相反。
    #[test]
    fn an_unknown_kind_is_refused_instead_of_silently_becoming_unclassified() {
        let c = conn_with_workspaces();
        for bad in ["", "  ", "tem", "personal!", "team-ish", "1", "Personal Team"] {
            let err = insert_chosen_space(&c, "s-bad", "x", "#e11", 1.0, 1_000, bad)
                .expect_err("认不出的类型必须报错（静默当未分类＝闸门松开）");
            assert!(err.contains("personal") && err.contains("team"), "报错要可操作：{err}");
        }
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM meta.workspaces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "报错那几次不许留下半行");
    }

    /// ★ 老口径不许变：**不传类型** ⇒ 与今天逐字节相同（`personal`，见 `insert_new_local_space`）。
    /// 这条挡的是"为了加 A1 顺手把默认值改掉了"——那会让所有老调用方建出未分类的空间。
    #[test]
    fn without_an_explicit_choice_the_default_stays_personal() {
        let c = conn_with_workspaces();
        insert_new_local_space(&c, "s-default", "默认", "#e11", 1.0, 1_000).unwrap();
        assert_eq!(kind_of(&c, "s-default"), "personal");
        // 导入那条路同样（口径与新建完全一致）
        insert_imported_space(&c, "s-import", "导入的", "#e12", "", 2.0, 1_000, false).unwrap();
        assert_eq!(kind_of(&c, "s-import"), "personal");
    }
}
