use crate::db::{now_ms, Db};
use crate::models::{PageDetail, PageMeta};
use crate::{backlinks, blocks, search, sync, versions, workspaces};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use tauri::State;

fn conn<'a>(db: &'a State<'_, Db>) -> std::sync::MutexGuard<'a, rusqlite::Connection> {
    db.0.lock().expect("db mutex poisoned")
}

pub fn fetch_page(c: &Connection, id: &str) -> Result<PageDetail, String> {
    c.query_row(
        "SELECT id, workspace_id, parent_id, title, content_json, content_text, cover, icon, cover_height, cover_pos, kind, sort_order, created_at, updated_at
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
                cover: row.get(6)?,
                icon: row.get(7)?,
                cover_height: row.get(8)?,
                cover_pos: row.get(9)?,
                kind: row.get(10)?,
                sort_order: row.get(11)?,
                created_at: row.get(12)?,
                updated_at: row.get(13)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "页面不存在".to_string())
}

#[tauri::command]
pub async fn list_pages(db: State<'_, Db>) -> Result<Vec<PageMeta>, String> {
    let c = conn(&db);
    let mut stmt = c
        .prepare(
            "SELECT id, workspace_id, parent_id, title, icon, kind, sort_order, created_at, updated_at, deleted_at
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
                icon: row.get(4)?,
                kind: row.get(5)?,
                sort_order: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                deleted_at: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// M10.4b 打磨 — 列出指定工作空间的页面（供「跨空间复制选父级」的目标空间文件夹树）。
/// 用独立连接打开目标空间库（不切换活动空间），返回其非删除页面。
#[tauri::command]
pub fn list_workspace_pages(workspace_id: String) -> Result<Vec<PageMeta>, String> {
    let conn = crate::db::open_space_conn(&workspace_id)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, parent_id, title, icon, kind, sort_order, created_at, updated_at, deleted_at
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
                icon: row.get(4)?,
                kind: row.get(5)?,
                sort_order: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                deleted_at: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_page(
    db: State<'_, Db>,
    id: String,
    space_id: Option<String>,
) -> Result<PageDetail, String> {
    let target = space_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let page = if let Some(space) = target {
        let active = {
            let c = conn(&db);
            workspaces::active_workspace_id(&c)?
        };
        if space != active {
            let app = crate::db::app_data_dir_ref()
                .ok_or_else(|| "bad_args: app data dir 未初始化".to_string())?;
            let tc = crate::db::open_space_conn_at(space, app).map_err(|e| {
                format!("permission_denied: 目标空间「{space}」已锁定或无法打开（locked）：{e}")
            })?;
            fetch_page(&tc, &id)?
        } else {
            let c = conn(&db);
            fetch_page(&c, &id)?
        }
    } else {
        let c = conn(&db);
        fetch_page(&c, &id)?
    };
    if page.kind != "page" && page.kind != "database" {
        return Err("该节点不是页面".to_string());
    }
    Ok(page)
}

#[derive(Deserialize)]
pub struct CreatePageArgs {
    pub parent_id: Option<String>,
    pub title: Option<String>,
    pub content_json: Option<String>,
    pub content_text: Option<String>,
    /// ⭐ 跨空间写 v1（2026-10-30）：给了就写到这个空间（仅 `pages.create` 链路支持）。
    /// 省略 = 当前活动空间（行为逐字节不变）。
    #[serde(default)]
    pub space_id: Option<String>,
}

#[tauri::command]
pub fn create_page(db: State<Db>, mut args: CreatePageArgs) -> Result<PageDetail, String> {
    let target = args
        .space_id
        .take()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let json = args.content_json.take();
    let text = args.content_text.take();
    let parent_id = args.parent_id.take();
    let title = args.title.take();
    if let Some(space) = target {
        let active = {
            let c = conn(&db);
            workspaces::active_workspace_id(&c)?
        };
        if space != active {
            return create_page_in_space(&space, parent_id, title, json, text);
        }
    }
    create_node(db, parent_id, title, "page", json, text)
}

/// ⭐ 跨空间写 v1：在**目标空间**建页（可写连接 ＋ 同一处写 `pages`/`changes`）。
///
/// 幂等/回滚由调用方（前端 apply 的确认链）保证；这里只做"一次调用一件事"。
/// 目标空间**锁着/打不开** ⇒ `permission_denied`（消息含 locked），⛔ 不回落当前空间。
pub(crate) fn create_page_in_space(
    space_id: &str,
    parent_id: Option<String>,
    title: Option<String>,
    json: Option<String>,
    text: Option<String>,
) -> Result<PageDetail, String> {
    if crate::plugins::cross_space_write_disabled() {
        return Err(
            "bad_args: 跨空间写已被 SHUYONOTE_MCP_CROSS_SPACE_WRITE 关闭（目标空间未写入）"
                .to_string(),
        );
    }
    let app_data = crate::db::app_data_dir_ref()
        .ok_or_else(|| "bad_args: app data dir 未初始化".to_string())?;
    let exists = {
        let m = crate::db::open_meta_conn_at(app_data)?;
        let found: bool = m
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1 AND deleted_at IS NULL)",
                params![space_id],
                |r| r.get(0),
            )
            .map_err(|e| format!("db_error: {e}"))?;
        found
    };
    if !exists {
        return Err(format!("not_found: 空间 {space_id} 不存在"));
    }
    let c = crate::db::open_space_conn_at(space_id, app_data).map_err(|e| {
        format!("permission_denied: 目标空间「{space_id}」已锁定或无法打开（locked）：{e}")
    })?;
    create_node_in(&c, space_id, parent_id, title, "page", json, text).map_err(|e| {
        if e.starts_with("permission_denied")
            || e.starts_with("not_found")
            || e.starts_with("bad_args")
        {
            e
        } else {
            let _ = &c; // 连接活到函数结束（事务/句柄都不跨）
            format!("db_error: {e}")
        }
    })
}

#[tauri::command]
pub fn create_folder(db: State<Db>, args: CreatePageArgs) -> Result<PageDetail, String> {
    let target = args
        .space_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(space) = target {
        let active = {
            let c = conn(&db);
            workspaces::active_workspace_id(&c)?
        };
        if space != active {
            if crate::plugins::cross_space_write_disabled() {
                return Err(
                    "bad_args: 跨空间写已被 SHUYONOTE_MCP_CROSS_SPACE_WRITE 关闭（目标空间未写入）"
                        .to_string(),
                );
            }
            let app_data = crate::db::app_data_dir_ref()
                .ok_or_else(|| "bad_args: app data dir 未初始化".to_string())?;
            let tc = crate::db::open_space_conn_at(&space, app_data).map_err(|e| {
                format!("permission_denied: 目标空间「{space}」已锁定或无法打开（locked）：{e}")
            })?;
            if let Some(ref p) = args.parent_id {
                let ok: bool = tc
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM pages WHERE id = ?1 AND deleted_at IS NULL)",
                        params![p],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if !ok {
                    return Err(format!("not_found: 上级节点 {p} 不存在或已删除"));
                }
            }
            return create_node_in(
                &tc,
                &space,
                args.parent_id,
                args.title,
                "folder",
                None,
                None,
            );
        }
    }
    create_node(db, args.parent_id, args.title, "folder", None, None)
}

#[tauri::command]
pub fn create_database(db: State<Db>, args: CreatePageArgs) -> Result<PageDetail, String> {
    create_node(db, args.parent_id, args.title, "database", None, None)
}

pub(crate) fn create_node(
    db: State<Db>,
    parent_id: Option<String>,
    title: Option<String>,
    kind: &str,
    // ⚠️ 形参名**故意**不叫 content_json/content_text：这两个名字是"内容列的落盘形态"，
    //   门禁只许它们出现在「那一层」里；这里只是把整块内容透传下去，改个名字不影响行为。
    json: Option<String>,
    text: Option<String>,
) -> Result<PageDetail, String> {
    let c = conn(&db);
    let ws = workspaces::active_workspace_id(&c)?;
    create_node_in(&c, &ws, parent_id, title, kind, json, text)
}

/// `create_node` 的**单连接实现**（当前空间与跨空间写共用同一份逻辑；⛔ 不复制第二套）。
pub(crate) fn create_node_in(
    c: &Connection,
    workspace_id: &str,
    parent_id: Option<String>,
    title: Option<String>,
    kind: &str,
    json: Option<String>,
    text: Option<String>,
) -> Result<PageDetail, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    // Honor an explicit title; fall back to a per-kind default (plain pages → 新页面).
    let title = title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| match kind {
            "folder" => "新建文件夹".to_string(),
            "database" => "新建数据库".to_string(),
            _ => "新页面".to_string(),
        });

    // Place new node at the end among siblings.
    let sort_order: f64 = c
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM pages WHERE parent_id IS ?1",
            params![parent_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let json = json.unwrap_or_else(|| "{}".to_string());
    let text = text.unwrap_or_default();

    c.execute(
        "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)",
        params![id, workspace_id, parent_id, title, json, text, kind, sort_order, now, now],
    )
    .map_err(|e| e.to_string())?;

    search::sync_fts(c, &id, &title, &text)?;
    // Rebuild block/backlink graph on create too, so any `[[双链]]` / block refs in
    // the initial content (e.g. the programmatically-created 使用指南 pages) show
    // up in the relationship graph. Mirrors save_page.
    blocks::rebuild_block_graph(c, &id, &json, &text)?;

    let page = fetch_page(c, &id)?;
    sync::record_page_upsert(c, &page)?;
    Ok(page)
}

#[derive(Deserialize)]
pub struct SavePageArgs {
    pub id: String,
    pub title: Option<String>,
    pub content_json: Option<String>,
    pub content_text: Option<String>,
    #[serde(default)]
    pub space_id: Option<String>,
}

#[derive(Deserialize)]
pub struct SetCoverArgs {
    pub id: String,
    /// CSS gradient string (e.g. "linear-gradient(...)") or an empty string to clear.
    pub cover: String,
}

/// ⭐ 2026-10-24（真机：**题头图没有同步**）：四条"页面外观"命令（封面 / 图标 / 封面高度 /
/// 封面位置）改完库之后必须做的**公共尾巴** —— ① 推进 `updated_at`；② **记一条同步变更**。
///
/// 为什么必须有它：这四条以前只 `UPDATE pages SET …` 就返回 ⇒ **不产生 `changes` 行**
/// ⇒ 服务端同步与网格同步两条路**都看不见这次改动**（要等下一次正文保存顺手把整页 upsert
/// 带上，题头图才可能被捎过去）—— 真机现场：Windows 设了封面，macOS 一直收不到。
///
/// ⚠️ 为什么 `updated_at` 也要动：`record_page_upsert` 用 `page.updated_at` 当这笔变更的时刻，
/// 而且页级 LWW 也看它；只改 `cover` 不动 `updated_at` 的话，这笔在列表排序/胜负里都"没有发生"。
fn finish_page_chrome_update(c: &Connection, id: &str, now: i64) -> Result<PageDetail, String> {
    let touched = c
        .execute(
            "UPDATE pages SET updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![now, id],
        )
        .map_err(|e| e.to_string())?;
    if touched == 0 {
        return Err("页面不存在".to_string());
    }
    let page = fetch_page(c, id)?;
    // 记一条 `page/upsert`（载荷就是整页 `PageDetail`，含 cover/icon/cover_height/cover_pos）
    sync::record_page_upsert(c, &page)?;
    Ok(page)
}

/// ⭐ AI 不可见空间清单：读（默认空；丢弃已删空间）。
#[tauri::command]
pub fn mcp_hidden_spaces_get(db: State<Db>) -> Result<serde_json::Value, String> {
    let c = conn(&db);
    Ok(serde_json::json!({ "spaceIds": crate::plugins::ai_hidden_spaces_in(&c) }))
}

/// ⭐ AI 不可见空间清单：写（校验存在/去重/≤500）。
#[tauri::command]
pub fn mcp_hidden_spaces_set(
    db: State<Db>,
    space_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    let c = conn(&db);
    let clean = crate::plugins::ai_hidden_spaces_set_in(&c, space_ids)?;
    Ok(serde_json::json!({ "spaceIds": clean }))
}
/// Set a page's cover (CSS gradient) and return the updated page detail.
#[tauri::command]
pub fn set_page_cover(db: State<Db>, args: SetCoverArgs) -> Result<PageDetail, String> {
    let c = conn(&db);
    let cover = normalize_cover_value(&args.cover)?;
    c.execute(
        "UPDATE pages SET cover = ?1 WHERE id = ?2 AND deleted_at IS NULL",
        params![cover, args.id],
    )
    .map_err(|e| e.to_string())?;
    finish_page_chrome_update(&c, &args.id, now_ms())
}

/// ⭐ 2026-10-24（owner 拍「1B」）：**题头图的值在这里归一化**。
///
/// 现场：渲染层直接把它当 CSS `background-image` 用（`url("…")` 才有效），
/// 而写入侧原来**原样存**、却又拒绝 `url(...)` 这种写法 ⇒ 用户怎么存都不显示，
/// 而且拒绝时只回一句看不懂的错（`EXCEPTION: "Uncaught"`）。
///
/// 口径（**只在这里定义一次**）：
/// · 空 ⇒ 存空串（＝清掉封面）；
/// · `url(...)` ⇒ 原样存（已经是 CSS 形式）；
/// · `data:` ⇒ 包成 `url("…")`；
/// · 其余（裸 key / 相对路径 / hash）⇒ 包成 `url("…")`；
/// · ⛔ 含双引号或换行的值**拒绝**，并**说明原因**（不再是一句 Uncaught）。
pub(crate) fn normalize_cover_value(raw: &str) -> Result<String, String> {
    let v = raw.trim();
    if v.is_empty() {
        return Ok(String::new());
    }
    let lower = v.to_ascii_lowercase();
    // ⚠️ 顺序要紧：**先认 `url(...)`**（它本来就可能带引号），再谈"不许带引号"。
    //   第一版把这条写在前面 ⇒ `url("covers/a.jpg")` 被自己的守卫拒掉（判据当场抓住）。
    if lower.starts_with("url(") {
        if !lower.ends_with(')') {
            return Err(format!(
                "封面值看起来像 url(...) 但没有闭合的右括号：{}",
                v.chars().take(40).collect::<String>()
            ));
        }
        return Ok(v.to_string());
    }
    if v.contains('"') || v.contains('\n') || v.contains('\r') {
        return Err(format!(
            "封面值不能包含双引号或换行（看起来像：{}）。应当是裸文件名、data: URL，或一个带引号的 url(\"...\") 值。",
            v.chars().take(40).collect::<String>()
        ));
    }
    Ok(format!("url(\"{v}\")"))
}

#[derive(Deserialize)]
pub struct SetIconArgs {
    pub id: String,
    /// Emoji / glyph shown before the title (empty string clears).
    pub icon: String,
}

#[derive(Deserialize)]
pub struct SetCoverHeightArgs {
    pub id: String,
    /// Cover banner height in px (draggable).
    pub height: i64,
}

#[derive(Deserialize)]
pub struct SetCoverPosArgs {
    pub id: String,
    /// Cover background vertical position (0-100%).
    pub pos: f64,
}

// ---- M24 PDF annotations ----

#[derive(Deserialize)]
pub struct SavePdfAnnotationsArgs {
    pub attachment_id: String,
    pub page_index: i64,
    /// JSON array of annotations (validated client-side; stored as-is).
    pub annotations: serde_json::Value,
}

#[derive(Deserialize)]
pub struct ListPdfAnnotationsArgs {
    pub attachment_id: String,
}

/// Save (upsert) the annotation list for an attachment page; return the saved list.
#[tauri::command]
pub fn save_pdf_annotations(
    db: State<Db>,
    args: SavePdfAnnotationsArgs,
) -> Result<serde_json::Value, String> {
    let c = conn(&db);
    let now = now_ms();
    let payload = args.annotations.to_string();
    let existing: Option<String> = c
        .query_row(
            "SELECT id FROM pdf_annotations WHERE attachment_id = ?1 AND page_index = ?2",
            params![args.attachment_id, args.page_index],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if existing.is_some() {
        c.execute(
            "UPDATE pdf_annotations SET payload_json = ?1, updated_at = ?2 WHERE attachment_id = ?3 AND page_index = ?4",
            params![payload, now, args.attachment_id, args.page_index],
        )
        .map_err(|e| e.to_string())?;
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        c.execute(
            "INSERT INTO pdf_annotations (id, attachment_id, page_index, payload_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, args.attachment_id, args.page_index, payload, now],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(args.annotations)
}

/// List all annotation pages for an attachment (ordered by page index).
#[tauri::command]
pub fn list_pdf_annotations(
    db: State<Db>,
    args: ListPdfAnnotationsArgs,
) -> Result<Vec<serde_json::Value>, String> {
    let c = conn(&db);
    let mut stmt = c
        .prepare(
            "SELECT attachment_id, page_index, payload_json FROM pdf_annotations WHERE attachment_id = ?1 ORDER BY page_index ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![args.attachment_id], |row| {
            let payload: String = row.get(2)?;
            let annotations: serde_json::Value =
                serde_json::from_str(&payload).unwrap_or(serde_json::Value::Array(vec![]));
            Ok(serde_json::json!({
                "attachment_id": row.get::<_, String>(0)?,
                "page_index": row.get::<_, i64>(1)?,
                "annotations": annotations,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// List every annotated page across all attachments, most recently updated first
/// (the "全局批注检索 / surfacing" data foundation).
#[tauri::command]
pub fn list_all_pdf_annotations(db: State<Db>) -> Result<Vec<serde_json::Value>, String> {
    let c = conn(&db);
    let mut stmt = c
        .prepare(
            "SELECT attachment_id, page_index, payload_json FROM pdf_annotations ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let payload: String = row.get(2)?;
            let annotations: serde_json::Value =
                serde_json::from_str(&payload).unwrap_or(serde_json::Value::Array(vec![]));
            Ok(serde_json::json!({
                "attachment_id": row.get::<_, String>(0)?,
                "page_index": row.get::<_, i64>(1)?,
                "annotations": annotations,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Set a page's cover height (px) and return the updated page detail.
#[tauri::command]
pub fn set_page_cover_height(
    db: State<Db>,
    args: SetCoverHeightArgs,
) -> Result<PageDetail, String> {
    let c = conn(&db);
    c.execute(
        "UPDATE pages SET cover_height = ?1 WHERE id = ?2 AND deleted_at IS NULL",
        params![args.height.clamp(120, 720), args.id],
    )
    .map_err(|e| e.to_string())?;
    finish_page_chrome_update(&c, &args.id, now_ms())
}

/// Set a page's cover background vertical position (0-100%) and return updated detail.
#[tauri::command]
pub fn set_page_cover_pos(db: State<Db>, args: SetCoverPosArgs) -> Result<PageDetail, String> {
    let c = conn(&db);
    c.execute(
        "UPDATE pages SET cover_pos = ?1 WHERE id = ?2 AND deleted_at IS NULL",
        params![args.pos.clamp(0.0, 100.0), args.id],
    )
    .map_err(|e| e.to_string())?;
    finish_page_chrome_update(&c, &args.id, now_ms())
}

/// Set a page's icon (emoji) and return the updated page detail.
#[tauri::command]
pub fn set_page_icon(db: State<Db>, args: SetIconArgs) -> Result<PageDetail, String> {
    let c = conn(&db);
    c.execute(
        "UPDATE pages SET icon = ?1 WHERE id = ?2 AND deleted_at IS NULL",
        params![args.icon, args.id],
    )
    .map_err(|e| e.to_string())?;
    finish_page_chrome_update(&c, &args.id, now_ms())
}

/// 冲刺 S7-2（2026-09-23）：读这一页的 **CRDT 状态**（没有 ⇒ `None`）。
///
/// 与前端 `api.readPageState`（`src/lib/api.ts`）成对；桌面侧这一层**只存取不透明字节**
/// （见 `src-tauri/src/page_crdt.rs` 文件头：Rust 不认识 CRDT 格式，也不该认识）。
/// ⚠️ 在此之前这两条只登记为 **web 专用** ⇒ 桌面上 `PageCrdtBinding` 每次打开页面都会
/// "绑定失败"并弹一次 toast；接上这条命令才是真正的修复。
#[derive(serde::Deserialize)]
pub struct PageStateArgs {
    pub page_id: String,
}

/// 写这一页的 CRDT 状态（同一页只留最新一份：主键 upsert）。与 `api.savePageState` 成对。
#[derive(serde::Deserialize)]
pub struct SavePageStateArgs {
    pub page_id: String,
    /// 状态字节。前端用 `number[]` 过 IPC（二进制不能直接过 `Uint8Array`）。
    pub state: Vec<u8>,
}

#[tauri::command]
pub fn read_page_state(db: State<Db>, args: PageStateArgs) -> Result<Option<Vec<u8>>, String> {
    let c = conn(&db);
    crate::page_crdt::read_page_crdt_state(&c, &args.page_id)
}

#[tauri::command]
pub fn save_page_state(db: State<Db>, args: SavePageStateArgs) -> Result<(), String> {
    let c = conn(&db);
    // ⭐ 2026-10-24：**空字节 ＝ 清掉**，⛔ 不是"存一份空状态"。
    //   原来把 0 字节写进 `page_crdt` ⇒ 下次打开那页时 lib0 解码当场抛
    //   `Unexpected end of array`（真机 toast「CRDT 绑定失败」）。
    //   「采用对端那一版」这条路要的正是"清掉本机状态、按对端投影重建" ✓。
    if args.state.is_empty() {
        return crate::page_crdt::clear_page_crdt_state(&c, &args.page_id);
    }
    crate::page_crdt::write_page_crdt_state(&c, &args.page_id, &args.state, now_ms())
}

/// 冲刺 §11.4 收口（2026-09-23 第 42 轮）：这一页**待并的远端状态**。
///
/// 桌面 pull 收到带状态的页载荷时把它收进 `page_crdt_pending`（Rust **没有** Yjs，不在这里合并），
/// 由界面侧在**打开页面**时交给那份唯一实现（`crdt/pageBinding.ts` 的 `mergeRemotePageState` 同族逻辑）。
/// Web 平台**恒为空**（它在 `applyChange` 里当场合并）—— 两侧行为不同是**平台事实**，不是漏实现。
#[tauri::command]
pub fn read_pending_page_states(
    db: State<Db>,
    args: PageStateArgs,
) -> Result<Vec<crate::page_crdt::PendingCrdtState>, String> {
    let c = conn(&db);
    crate::page_crdt::read_pending_states(&c, &args.page_id)
}

/// 合并完就清（返回值＝**清了几条**：`0` 是"本来就没有"，不是错误 —— 与 `clear_page_crdt_state` 同一口径）。
#[tauri::command]
pub fn clear_pending_page_states(db: State<Db>, args: PageStateArgs) -> Result<usize, String> {
    let c = conn(&db);
    crate::page_crdt::clear_pending_states(&c, &args.page_id)
}

/// 投影写回的载荷：**由界面侧算好的**那一份投影 JSON。
///
/// ⚠️ 为什么是界面侧算：Rust **没有** Yjs ⇒ 它算不出"状态 ⇒ JSON"。这一步只是把算好的那一份**落盘**。
/// 按空间启用/禁用的载荷。
///
/// ⚠️ `space_id` 是**本地空间 id**（不是远端 `space_id`）；`passphrase` 只在"**钥匙袋还不存在**"
/// 时用到（用它建袋子），已有袋子 ⇒ 传 `None`（用会话里的主密钥）。
#[derive(serde::Deserialize)]
pub struct SpaceEncryptionArgs {
    pub space_id: String,
    pub passphrase: Option<String>,
}

/// 「只要一个空间 id」的载荷（按空间禁用这类**不需要口令**的命令用）。
///
/// ⚠️ 为什么不为省事复用 `PageStateArgs`：那条的字段名是 `page_id`，而这里装的是**空间 id** ——
///    名字与语义不符的载荷正是"分层被慢慢磨穿"的那类东西（与 `doc_json` 同一处置）。
#[derive(serde::Deserialize)]
pub struct SpaceIdArgs {
    pub space_id: String,
}

/// ★ 隐私边界第 1 步的命令面：**按空间加密**这一个空间（只换它自己的库）。
///
/// 与旧的 `set_encryption`（应用级：把所有空间一起换成同一把钥匙）**不是一条路** ——
/// 那一条给团队空间会连坐（服务端从此读不懂，合并/检索/AI 全废）。
/// 失败一律 `Err` 且文本可操作（口径：不静默）。
#[tauri::command]
pub fn enable_space_encryption(
    db: State<Db>,
    args: SpaceEncryptionArgs,
) -> Result<[u8; 32], String> {
    let dir = crate::db::app_data_dir_ref()
        .ok_or("app data dir not initialised")?
        .to_path_buf();
    let mut c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    crate::space_crypto::enable_space(&mut c, &dir, &args.space_id, args.passphrase.as_deref())
}

/// ★ 同上（另一半）：**按空间禁用** —— 只把它自己的库换回明文、扔掉它的盒子（别的空间不受影响）。
#[tauri::command]
pub fn disable_space_encryption(db: State<Db>, args: SpaceIdArgs) -> Result<(), String> {
    let dir = crate::db::app_data_dir_ref()
        .ok_or("app data dir not initialised")?
        .to_path_buf();
    let mut c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    crate::space_crypto::disable_space(&mut c, &dir, &args.space_id)
}

/// 分类标记的载荷：`kind` 取 `"personal"` / `"team"` / `""`（空串 ＝ 取消分类）。
#[derive(serde::Deserialize)]
pub struct SpaceKindArgs {
    pub space_id: String,
    pub kind: String,
}

/// ★ 隐私边界 A=3 的**手动出口**：把某个空间标成个人/团队（或取消分类）。
///
/// 正常路径**不用点它**（本地新建 ⇒ 自动 `personal`，见 `workspaces::insert_new_local_space`）。
/// 它存在是因为**存量空间**（分类列落地之前建的）与团队流程之外建的空间没有分类，
/// 而"没分类" ＝ 闸门放行 ＝ 那道闸门对它们**没生效**。想让它生效，就得有个地方能标。
///
/// ⚠️ 与内部的 `SpaceKind::parse` **刻意不同口径**：`parse` 对存量数据是**宽进**
/// （认不出来就成了未分类 —— 不猜），命令面是**窄进**（认不出的字符串直接报错）。
/// 理由：前者读的是别人写进库里的数据，后者读的是界面传来的参数 —— 界面把 `team` 拼错成
/// `teams` 时若被静默当成"取消分类"，闸门会在用户以为"已归类"的情况下**松开**，那是静默失败。
#[tauri::command]
pub fn set_space_kind(db: State<Db>, args: SpaceKindArgs) -> Result<(), String> {
    let kind = match args.kind.trim().to_ascii_lowercase().as_str() {
        // ⚠️ **2026-10-04**：⭐ 空串**不再等于「取消分类」** ✗ —— owner 要去掉「未分类」这一档 ✓
        //    ⇒ ⭐ 它落到下面 `other =>` 的报错分支 ✓（⭐ 口径：必须显式给个人/团队 ✓）。
        "personal" => crate::space_crypto::SpaceKind::Personal,
        "team" => crate::space_crypto::SpaceKind::Team,
        other => {
            return Err(format!(
                "认不出的空间分类「{other}」：只接受 personal / team / 空串（空串＝取消分类）"
            ))
        }
    };
    let c = conn(&db);
    crate::space_crypto::set_space_kind(&c, &args.space_id, kind)
}

/// ★ ②b 的读数面：**一次读全所有空间**的分类 ＋ 加密状态 ＋ 闸门裁决。
///
/// 为什么是一条命令而不是让界面自己拼三条：见 `space_crypto::SpaceSecurityView` 的说明
/// （拼三条 ＝ 界面得知道钥匙袋存在 ⇒ 口径漏到界面层）。
#[tauri::command]
pub fn space_security_overview(
    db: State<Db>,
) -> Result<Vec<crate::space_crypto::SpaceSecurityView>, String> {
    let dir = crate::db::app_data_dir_ref()
        .ok_or("app data dir not initialised")?
        .to_path_buf();
    let c = conn(&db);
    crate::space_crypto::space_security_views(&c, &dir)
}

/// ⚠️ 字段名刻意叫 `doc_json`（**不是存储列名**，与 `StaleTextPage.doc_json` 同一处置）：
///    「收一份 JSON 文本」的参数不该顶着那一列的名字，否则收口门禁与分层都会慢慢被磨穿。
#[derive(serde::Deserialize)]
pub struct PageProjectionArgs {
    pub page_id: String,
    pub doc_json: String,
}

/// ★ 冲刺 §13.3 第 1 条（2026-09-23 第 49 轮）：**把投影写回落盘列**（＋块图重建＋打「待重建」）。
///
/// 与 `save_page_state` 的分工：那条写**状态**（权威那一份），这条把状态**投影**到 `pages` 那一列，
/// 让反链/插件/AI/导出**当场**看到刚并进来的内容（原先要等下一次保存）。
/// 语义与三条纪律见 `doc_content::write_page_projection`（**不是保存**：不动 `dirty`、不盖章、不快照）。
/// 返回**是否真的写了**：`false` ＝ "无事可做"（没变 / 数据库页 / 页面不存在），不是错误。
#[tauri::command]
pub fn write_page_projection(db: State<Db>, args: PageProjectionArgs) -> Result<bool, String> {
    let c = conn(&db);
    crate::doc_content::write_page_projection(&c, &args.page_id, &args.doc_json)
}

#[tauri::command]
pub fn save_page(db: State<Db>, mut args: SavePageArgs) -> Result<PageDetail, String> {
    let target = args
        .space_id
        .take()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(space) = target {
        let active = {
            let c = conn(&db);
            workspaces::active_workspace_id(&c)?
        };
        if space != active {
            if crate::plugins::cross_space_write_disabled() {
                return Err(
                    "bad_args: 跨空间写已被 SHUYONOTE_MCP_CROSS_SPACE_WRITE 关闭（目标空间未写入）"
                        .to_string(),
                );
            }
            let app_data = crate::db::app_data_dir_ref()
                .ok_or_else(|| "bad_args: app data dir 未初始化".to_string())?;
            let c = crate::db::open_space_conn_at(&space, app_data).map_err(|e| {
                format!("permission_denied: 目标空间「{space}」已锁定或无法打开（locked）：{e}")
            })?;
            return save_page_in(&c, args);
        }
    }
    let c = conn(&db);
    save_page_in(&c, args)
}

/// `save_page` 的单连接实现（复用全部副作用；当前/跨空间同一份）。
pub(crate) fn save_page_in(c: &Connection, mut args: SavePageArgs) -> Result<PageDetail, String> {
    let now = now_ms();
    let now = now_ms();

    // Read current values for fields not provided. 走「文档内容」那一层（阶段 0 接口收口）。
    let cur = crate::doc_content::read(c, &args.id)?.ok_or_else(|| "页面不存在".to_string())?;

    let content = crate::doc_content::DocContent {
        title: args.title.unwrap_or(cur.title),
        // ★ **阶段 1**：保存时给每个有身份的顶层块盖 `blockRev`（baseline = 库里这一页）。
        //   块级判定（`sync::apply_upsert` 的 `merge_remote_content`）靠它比"哪一块更新"；
        //   不盖章 ⇒ 判定每一页都会回落到页级 LWW，接线等于白接。
        //   ⚠️ 顺序：**先盖章再落库/快照** —— 快照里存的应当是"用户真正保存的那一版"（含 rev）。
        json: crate::doc_content::stamp_block_revs(
            c,
            &args.id,
            &args.content_json.unwrap_or_else(|| cur.json.clone()),
        )?,
        text: args.content_text.unwrap_or(cur.text),
    };

    // Snapshot the current state before overwriting (version history).
    versions::snapshot_before_save(c, &args.id, &content.title, &content.json, &content.text)?;

    crate::doc_content::write(c, &args.id, &content, now)?;
    crate::doc_content::derive(c, &args.id, &content)?;

    let page = fetch_page(c, &args.id)?;
    sync::record_page_upsert(c, &page)?;
    Ok(page)
}

#[tauri::command]
pub fn delete_page(db: State<Db>, id: String, space_id: Option<String>) -> Result<(), String> {
    let target = space_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(space) = target {
        let active = {
            let c = conn(&db);
            workspaces::active_workspace_id(&c)?
        };
        if space != active {
            if crate::plugins::cross_space_write_disabled() {
                return Err(
                    "bad_args: 跨空间写已被 SHUYONOTE_MCP_CROSS_SPACE_WRITE 关闭（目标空间未写入）"
                        .to_string(),
                );
            }
            let app_data = crate::db::app_data_dir_ref()
                .ok_or_else(|| "bad_args: app data dir 未初始化".to_string())?;
            let tc = crate::db::open_space_conn_at(&space, app_data).map_err(|e| {
                format!("permission_denied: 目标空间「{space}」已锁定或无法打开（locked）：{e}")
            })?;
            return delete_page_in(&tc, &id);
        }
    }
    let c = conn(&db);
    delete_page_in(&c, &id)
}

/// delete_page 的单连接实现（当前/跨空间同一份）。
pub(crate) fn delete_page_in(c: &Connection, id: &String) -> Result<(), String> {
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

    for pid in &all {
        c.execute(
            "UPDATE pages SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now, pid],
        )
        .map_err(|e| e.to_string())?;
        search::remove_fts(&c, pid)?;
        // Delete change: embed the node's title so sync-history 明细 can show a
        // name (deleted entities have no living row). Best-effort; empty payload OK.
        let title: String = c
            .query_row("SELECT title FROM pages WHERE id = ?1", params![pid], |r| {
                r.get(0)
            })
            .unwrap_or_default();
        let payload = if title.is_empty() {
            None
        } else {
            Some(serde_json::json!({ "title": title }).to_string())
        };
        sync::record_change(&c, "page", pid, "delete", payload.as_deref(), now)?;
    }

    backlinks::remove_backlinks(&c, &all)?;

    Ok(())
}

#[derive(Deserialize)]
pub struct MovePageArgs {
    pub id: String,
    pub new_parent_id: Option<String>,
    pub sort_order: f64,
    #[serde(default)]
    pub space_id: Option<String>,
}

#[tauri::command]
pub fn move_page(db: State<Db>, args: MovePageArgs) -> Result<(), String> {
    let target = args
        .space_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(space) = target {
        let active = {
            let c = conn(&db);
            workspaces::active_workspace_id(&c)?
        };
        if space != active {
            if crate::plugins::cross_space_write_disabled() {
                return Err(
                    "bad_args: 跨空间写已被 SHUYONOTE_MCP_CROSS_SPACE_WRITE 关闭（目标空间未写入）"
                        .to_string(),
                );
            }
            let app_data = crate::db::app_data_dir_ref()
                .ok_or_else(|| "bad_args: app data dir 未初始化".to_string())?;
            let tc = crate::db::open_space_conn_at(&space, app_data).map_err(|e| {
                format!("permission_denied: 目标空间「{space}」已锁定或无法打开（locked）：{e}")
            })?;
            return move_page_in(&tc, &args);
        }
    }
    let c = conn(&db);
    move_page_in(&c, &args)
}

/// move_page 的单连接实现（当前/跨空间同一份）。
pub(crate) fn move_page_in(c: &Connection, args: &MovePageArgs) -> Result<(), String> {
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

    // Re-normalize sibling sort_order to a clean integer sequence.
    renumber_siblings(&c, args.new_parent_id.as_deref())?;

    let page = fetch_page(&c, &args.id)?;
    sync::record_page_upsert(&c, &page)?;

    Ok(())
}

// Renumber all children of `parent_id` to 0,1,2,... by their current sort_order.
fn renumber_siblings(c: &Connection, parent_id: Option<&str>) -> Result<(), String> {
    let mut stmt = c
        .prepare(
            "SELECT id FROM pages
             WHERE parent_id IS ?1 AND deleted_at IS NULL
             ORDER BY sort_order ASC, created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = stmt
        .query_map(params![parent_id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    for (i, id) in ids.iter().enumerate() {
        c.execute(
            "UPDATE pages SET sort_order = ?1 WHERE id = ?2",
            params![i as f64, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---- M24 native PDF render engine (desktop, mupdf) ----

#[derive(Deserialize)]
pub struct RenderPdfPageArgs {
    pub attachment_id: String,
    pub page_index: i64,
    pub scale: f32,
    /// ⭐ **D1b（2026-10-15）**：可选 —— **只渲染页面上的这一块**（D2 的"可见区域"）。
    ///
    /// `[x, y, w, h]`，单位**页面 pt、左上角为原点**（前端就是这么想坐标的 ✓；PDF 自己原点在左下，
    /// 翻转在 `pdfium_native::render_page_rect` 里由 PDFium 的 display transform 完成 ✓）。
    ///
    /// * **缺省 / `null` ⇒ 整页**（与 D1b 之前**逐字节同一条路** ✓ —— 旧前端一个字都不用改 ✓）。
    /// * 返回的 `width/height` **如实**是这一块的像素尺寸（`round(w×scale) × round(h×scale)` ✓）
    ///   ⇒ 前端可以据此自证"我要的块真的拿到了"，而不是相信后端照做了（"成功 ≠ 生效"那一族 ✓）。
    /// * 形状只认**恰好四个数**：三个/五个一律报错，⛔ 不许"就近取四个"✗（判据见
    ///   `render_rect_args_tests` ✓）。
    #[serde(default)]
    pub rect: Option<[f64; 4]>,
}

/// 原生 PDF 渲染的返回载荷：显式宽高 + base64 的 RGBA8。
///
/// 为什么不返回二进制（`tauri::ipc::Response` / `InvokeResponseBody::Raw`）：
/// Tauri 只在能用 binary channel 的平台把它当字节送；**macOS/iOS 走的是
/// `format_result(Ok(Vec<u8>))`——把字节 JSON 编码成数字数组**（一页 6.8MB 的
/// RGBA 就是 680 万个 JSON 数字）。前端因此踩了两个坑：`buf instanceof ArrayBuffer`
/// 为假 ⇒ 宽高取到 `undefined` ⇒ NaN ⇒ WKWebView 抛
/// "Value NaN is outside the range [-2147483648, 2147483647]"（Chrome 则静默画成
/// 0×0，即"一片空白"）；以及解析几十 MB 数字数组导致的卡顿。
/// base64 是同一份数据在 JSON 通道上最省的表达，而且所有平台行为一致——
/// 前端只需要一条解析路径（见 src/lib/pdfNativePage.ts）。
#[derive(serde::Serialize)]
pub struct PdfPagePayload {
    pub width: u32,
    pub height: u32,
    /// ⭐ **2026-10-15**：这里装的是**先 gzip 再 base64** 的紧凑 RGBA ✓（不是裸 base64 ✗）
    /// —— 裸 base64 让一页 24 MB 过桥，前端每按一下放大要等 1.5 s ✗（见构造处的读数注释）。
    pub rgba_gzip_base64: String,
}

/// Render an attachment's PDF page to bytes using MuPDF (desktop-native,
/// faster for large/complex PDFs). Web degrades to pdf.js (see platform driver).
///
/// 返回 `PdfPagePayload`（显式宽高 + base64 的 RGBA8），见该结构体的注释：
/// 二进制响应在 macOS/iOS 上会被 Tauri JSON 编码成**数字数组**，既和
/// "前端拿到 ArrayBuffer"的预期不符（宽高取到 undefined → NaN → WKWebView 抛
/// `Value NaN is outside the range …`），又要解析几十 MB 的 JSON 数字。
/// 前端 `parseNativePageResponse` 会校验解码后恰为 `宽 × 高 × 4` 字节。
///
/// IMPORTANT (fix): this was a *synchronous* command. MuPDF rasterization is
/// CPU-intensive (a scanned/complex page can take seconds), and a sync command
/// runs on the main thread, blocking the WebView2 message loop — the window
/// shows "(未响应)" and the page never paints. It is now `async`, and the
/// rasterization runs on the blocking thread pool (`spawn_blocking`), so the
/// UI thread stays responsive while the page renders in the background.
///
/// ⭐ **D1b（2026-10-15）**：`args.rect` 可选 —— 给了就**只渲染那一块**（页面 pt、左上角原点），
/// 返回的 `width/height` 就是那一块的像素尺寸。为什么值：D1 的读数说**过桥成本 ∝ 载荷字节数**
/// （约 0.55 ms/KB）⇒ 载荷按面积缩小 ⇒ 「送过去」那一段同比例缩小（可见区域约占整页 4%）。
/// ⚠️ 没编 MuPDF 的构建里，MuPDF + rect 会先被 `ensure_mupdf_available()` 拦下（那句话更贴切）；
/// 编了 MuPDF 时由 [`MUPDF_NO_RECT`] 拒绝（原因见 [`engine_supports_rect`] 的注释）。
#[tauri::command]
pub async fn render_pdf_page(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    args: RenderPdfPageArgs,
) -> Result<PdfPagePayload, String> {
    let hash: String = {
        let c = conn(&db);
        c.query_row(
            "SELECT hash FROM attachments WHERE id = ?1",
            params![args.attachment_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?
    };
    // ── PDF 引擎分派（P2，2026-09-17；判据化 2026-09-19 AMD）──────────────────
    // **运行时开关**（方案 §0.2-F 已定：不重编就能切回 MuPDF，便于灰度与回滚）：
    // 环境变量取值与默认值见 `PdfEngine::from_env_value` / `PdfEngine::DEFAULT`。
    let engine = PdfEngine::from_env_value(std::env::var("SHUYONOTE_PDF_ENGINE").ok().as_deref());
    // ★ 2026-09-21：MuPDF 成了**构建期特性**（默认不编）。有人显式要 MuPDF 而这个构建里没有它时，
    //   **在这里就说清怎么办** —— 绝不静默换成 PDFium（"成功 ≠ 生效"那一族），也不 panic。
    if engine == PdfEngine::Mupdf {
        ensure_mupdf_available()?;
    }
    // ⭐ **D1b（2026-10-15）**：`rect` 只有 PDFium 那条路**真有**裁剪入口 ⇒ 别的引擎**显式拒绝**。
    // ⛔ 不许"忽略 rect、照旧返回整页"✗ —— 那会让前端把一张整页图当成一小块贴到左上角去，
    //   图会静默错位（那是比"慢"更坏的一类错 ✓）。前端拿这条错误退回整页渲染（D2 的契约 ✓）。
    if args.rect.is_some() && !engine_supports_rect(engine) {
        return Err(MUPDF_NO_RECT.to_string());
    }
    // ⚠️ **两套缓存互斥淘汰**（P2 验收项）：同一个 hash 若被两个引擎各持一份，
    // 内存会无声翻倍而两侧 LRU 互不知情 ⇒ 切引擎时先清掉另一侧的同 key 条目。
    match engine {
        PdfEngine::Pdfium => {
            #[cfg(feature = "mupdf-rollback")]
            crate::pdf_native::forget(&hash);
        }
        PdfEngine::Mupdf => crate::pdfium_native::forget(&hash),
    }
    // 缓存命中判断也要**按引擎各查各的**（两套缓存彼此独立）。
    let cached = match engine {
        PdfEngine::Mupdf => {
            // 没编 MuPDF 的构建在上面那句 `ensure_mupdf_available()` 就返回了 ⇒ 这里是防呆分支。
            #[cfg(feature = "mupdf-rollback")]
            {
                crate::pdf_native::has_document(&hash)
            }
            #[cfg(not(feature = "mupdf-rollback"))]
            {
                false
            }
        }
        PdfEngine::Pdfium => crate::pdfium_native::has_document(&hash),
    };
    let bytes = if cached {
        Vec::new()
    } else {
        crate::attachments::attachment_bytes(app, db, &hash)?
    };
    let page_index = args.page_index;
    let scale = args.scale;
    // ⭐ D1b：`Option<[f64; 4]>` 是 `Copy` ⇒ 直接搬进阻塞线程（`args` 之后不再用）。
    let rect = args.rect;
    // 在阻塞线程池上执行栅格化，避免阻塞主（UI）线程。
    // 两条路径都**归一成紧凑 RGBA**（前端按 宽×高×4 校验字节数）：
    //  · MuPDF 出的是带行填充的缓冲 ⇒ 还要 `compact_rgba`；
    //  · PDFium 的 `as_rgba_bytes()` **本来就是紧凑的** ⇒ 不需要那一步（见 pdfium_native.rs 模块头第 1 条）。
    let (compact, w, h) =
        tauri::async_runtime::spawn_blocking(move || -> Result<(Vec<u8>, usize, usize), String> {
            match engine {
                PdfEngine::Mupdf => {
                    #[cfg(feature = "mupdf-rollback")]
                    {
                        let (rgba, w, h, stride) = unsafe {
                            crate::pdf_native::render_page(&hash, &bytes, page_index, scale)
                        }?;
                        Ok((crate::pdf_native::compact_rgba(&rgba, w, h, stride)?, w, h))
                    }
                    // 没编 MuPDF 的构建走不到这里（上面已返回）——保留一句可读的错，别写成 unreachable!()。
                    #[cfg(not(feature = "mupdf-rollback"))]
                    {
                        let _ = (bytes, page_index, scale);
                        Err(MUPDF_NOT_COMPILED.to_string())
                    }
                }
                // 用 `render_page_owned`：这条分支拿到字节之后不再需要它，省掉一次整文件拷贝。
                PdfEngine::Pdfium => {
                    // ⚠️ 本命令的 `page_index` 是 **i64**（沿用 MuPDF 那条的入参类型），
                    // 而 `pdfium_native` 收 **usize** —— 这里显式转换，别靠隐式推断。
                    let idx = usize::try_from(page_index)
                        .map_err(|_| format!("页码 {page_index} 超出范围"))?;
                    match rect {
                        // ⭐ **D1b**：只出这一块 ⇒ 载荷按面积缩小 ⇒「送过去」那段同比例缩小
                        //   （D1 的读数：过桥成本 ∝ 载荷字节数，约 0.55 ms/KB ✓）。
                        //   ⚠️ `render_page_rect` 自己带判据（`pdfium_native::d1_rect_tests` ✓）。
                        Some([x, y, w, h]) => crate::pdfium_native::render_page_rect(
                            &hash,
                            bytes,
                            idx,
                            scale,
                            (x, y, w, h),
                        ),
                        // 没请求 rect ⇒ 与 D1b 之前**逐字节同一条路**（旧行为不退化 ✓）。
                        None => crate::pdfium_native::render_page_owned(&hash, bytes, idx, scale),
                    }
                }
            }
        })
        .await
        .map_err(|e| format!("render task failed: {e}"))??;
    let width = u32::try_from(w).map_err(|_| format!("PDF: 页面宽度 {w} 超出范围"))?;
    let height = u32::try_from(h).map_err(|_| format!("PDF: 页面高度 {h} 超出范围"))?;
    // ⛔⭐ **2026-10-15（owner：「pdf 放大很卡」）** ✗ —— ⭐ 实测：过桥的是**原始 RGBA 的 base64**：
    //   一页 1576×2876 ⇒ RGBA 18 MB ⇒ base64 **24 MB** ✗ ⇒ 前端每按一下放大要等 **1584 ms** ✓；
    //   25% 那档 788×1438 ⇒ 6 MB ⇒ **779 ms** ✓ ⇒ ⛔ 慢的不是像素算法，是**这座桥** ✗
    //   （诊断读数与推理见 `_tmp/scratch/probe-zoom-fixed-cost.mjs` 那一轮 ✓）。
    // ⇒ ⭐ 现在**先 gzip 再 base64**：白底为主的页面通常压到 1/10 上下 ✓。
    //   ⚠️ 是**无损**压缩 ✓ —— 前端解出来的 RGBA 与压缩前**逐字节相同** ✓（放大看字不会糊 ✓）。
    //   ⚠️ flate2 **早就是直接依赖**（Cargo.toml:80 ✓，随 zip 进来）⇒ ⛔ 没有新增任何下载 ✗。
    //   ⚠️ 前端对应改动在 `src/lib/pdfNativePage.ts`（fflate `gunzipSync` ✓ 也已是既有依赖 ✓）。
    //   ⚠️ 版本不一致时前端会明确报「无法识别的原生渲染响应」并要求重启 ✓ —— ⛔ 不静默出半成品 ✗。
    //
    // ⭐⭐ **2026-10-15 对照实验（owner 同意「先量」）** —— ⛔ 它改写了诊断结论 ✗：
    //   同一台机器上量 `render_page_owned`（纯光栅化 ✓，不含本文件的 gzip/base64 ✓）：
    //     一份 A4 真文档、2.00 Mpx ⇒ **106 ms** ✓（只出一块 0.10 Mpx ⇒ 44 ms ✓ ⇒ 裁剪只值 2.41× ✓）；
    //   而 App 里同量级的一步实测 **795 ms** ✗ ⇒ ⭐ **~690 ms 不在光栅化里** ✗，
    //   而在这条链上：**gzip ＋ base64 ＋ IPC 传输 ＋ 前端解码** ✓
    //   ⇒ ⭐ 下一步该打的是**这条链**（例如换更小的载体／更省的通道 ✓），
    //     ⛔ 而不是继续削像素 ✗，也不是急着写「只渲染可视区域」✗（它只值 2.4× ✓）。
    //
    // ⭐⭐ **2026-10-15 分段埋点（临时埋点已撤 ✓，读数留档）** —— ⭐ 这一组把方向定死了：
    //     在 `renderPdfPage` 里分三段量（同一篇真文档、连点两次放大）：
    //       ① 命令往返（光栅化 ＋ 本文件的 gzip/base64 ＋ IPC）＝ **821 ms**（520 ／ 1122）；
    //       ② 回来的 base64 载荷 ＝ **1359 KB**（894 KB ／ 1887 KB）；
    //       ③ 前端解码（gunzip ＋ 字节校验）＝ **102 ms**（65 ／ 139）。
    //     ⇒ 光栅化只占 ≈106 ms（对照实验 ✓）⇒ ⭐ **约 715 ms 花在把载荷送过去** ✓
    //     ⇒ 而且**与字节数成正比**：894 KB ⇒ 520 ms ｜ 1887 KB ⇒ 1122 ms
    //       ⇒ 约 **0.55 ms/KB（≈1.8 MB/s）** ✗ —— 本地 IPC 绝不该这么慢 ✓。
    //     ⇒ ⭐ 结论：**过桥成本 ∝ 载荷字节数** ✓ ⇒ 任何让载荷变小的做法都直接换算成时间：
    //       · 只渲染可视区域（D）⇒ 载荷约 1/20 ⇒ 这一段 715 ⇒ 约 36 ms ✓
    //         （⚠️ 先前按「光栅化」算它只值 2.4× ✗ …… 那是**漏算了传输** ✓）；
    //       · 或换 JPEG（约 2–4× 小 ✓）／干脆**不走 IPC**（Rust 落盘 ＋ 资源协议 ✓ 最省 ✓）。
    let gz = {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut e, &compact).map_err(|x| format!("PDF: gzip 失败：{x}"))?;
        e.finish().map_err(|x| format!("PDF: gzip 收尾失败：{x}"))?
    };
    use base64::Engine as _;
    Ok(PdfPagePayload {
        width,
        height,
        rgba_gzip_base64: base64::engine::general_purpose::STANDARD.encode(&gz),
    })
}

/// 请求了 MuPDF、但这个构建没编入它时给的那句话。
///
/// ⚠️ **2026-09-25 清理**：这里原本还有一个 `pub(crate) fn mupdf_compiled()`，body 就是
/// `cfg!(feature = "mupdf-rollback")`；它**唯一的调用点**是一条"它必须等于 `cfg!(feature)`"的判据 ——
/// 也就是 `assert_eq!(cfg!(f), cfg!(f))`，**恒真、零覆盖**；函数本身在非测试构建里也没人用。
/// 于是删掉函数与那条空转断言。"这个构建编没编 MuPDF"由 `ensure_mupdf_available()` 的两份 cfg 实现回答，
/// 下面那条判据直接断言它（两种构建各断言自己那一半，那才是真的在验）。
///
/// 为什么要这么长：这不是"内部错误"，而是**用户（或灰度时的人）敲了一个开关却得不到想要的东西**
/// —— 必须一句话说清"现在没有它 + 换哪个开关 + 想要它怎么构建"。
/// （编了 `mupdf-rollback` 的构建里这句话没有调用点，但那是有意的：判据与文档都指着它。）
#[cfg_attr(feature = "mupdf-rollback", allow(dead_code))]
pub(crate) const MUPDF_NOT_COMPILED: &str =
    "这个构建没有编入 MuPDF（构建期特性 `mupdf-rollback`，2026-09-21 起默认不编）。\
现在请把 SHUYONOTE_PDF_ENGINE 设为 pdfium（或删掉这个环境变量）用默认引擎；\
若确实要用 MuPDF 回滚，请用带 `--features mupdf-rollback` 重新构建的安装包。";

/// ⭐ **D1b**：哪个引擎**真有**"只渲染一个矩形"这条入口？
///
/// * **PDFium 有** ✓ —— `pdfium_native::render_page_rect`（它自己带逐像素判据 ✓）。
/// * **MuPDF 没有** ✗ —— 那条路只能按整页出图。于是 `rect` 落到它头上时**显式拒绝**，
///   由前端退回整页渲染；⛔ 绝不"忽略 rect 照旧出整页"✗ —— 那会让前端把整页图当一小块贴到
///   左上角，**静默错位**（比慢更坏的一类错）。
///
/// 单独抽成纯函数是为了**能在 Windows 上判据化**（本机编不了 mupdf-rollback，
/// 所以"拒绝"这条逻辑必须落在不依赖那个特性的代码里 ✓ —— 见 `render_rect_args_tests`）。
pub(crate) fn engine_supports_rect(engine: PdfEngine) -> bool {
    matches!(engine, PdfEngine::Pdfium)
}

/// 拿一个引擎不支持 `rect` 的请求来时的那句话（**可照着做**：说清换哪个引擎、或退回哪条路）。
pub(crate) const MUPDF_NO_RECT: &str = "这个引擎（MuPDF，回滚用）没有「只渲染可视矩形」的入口。\
请把 SHUYONOTE_PDF_ENGINE 设回 pdfium；或让前端退回**整页**渲染 —— \
⛔ 不要拿一张整页图当成一小块贴上去（会静默错位）。";

/// 命令入口的前置检查：编了就是 `Ok(())`，没编就是上面那句话。
#[cfg(feature = "mupdf-rollback")]
fn ensure_mupdf_available() -> Result<(), String> {
    Ok(())
}

#[cfg(not(feature = "mupdf-rollback"))]
fn ensure_mupdf_available() -> Result<(), String> {
    Err(MUPDF_NOT_COMPILED.to_string())
}

/// PDF 光栅化引擎（P2 的分派量）。
///
/// ⚠️ **这不是内部实现细节**：P5 那一步"默认换不换"就落在 [`PdfEngine::DEFAULT`] 这一行上，
/// 而"一键切回 MuPDF"是方案 §4 的验收项之一 ⇒ 两者都必须有判据守着，不能只写在注释里
/// （2026-09-19 AMD：原先 14 行分派写在命令函数体里、**零判据**，切默认值时没有任何东西会响）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PdfEngine {
    Mupdf,
    Pdfium,
}

impl PdfEngine {
    /// **默认引擎**（P5 的切换点：改这一行 = 换默认引擎）。
    ///
    /// 2026-09-19：由 `Mupdf` 切成 **`Pdfium`**（PDFium 已在 dev 上、P3 对拍 4/4＋目视 4/4 通过、
    /// Windows 装包已带库）——`SHUYONOTE_PDF_ENGINE=mupdf` 保留一键回滚。
    pub(crate) const DEFAULT: PdfEngine = PdfEngine::Pdfium;

    /// 环境变量取值 → 引擎。**大小写与首尾空格都不敏感**；认不出的值（含空串）走
    /// [`PdfEngine::DEFAULT`] —— 认不出就按默认走，不猜、也不报错（渲染不该因为一个
    /// 拼错的开关而失败）。
    pub(crate) fn from_env_value(value: Option<&str>) -> PdfEngine {
        match value.map(str::trim) {
            Some(v) if v.eq_ignore_ascii_case("pdfium") => PdfEngine::Pdfium,
            Some(v) if v.eq_ignore_ascii_case("mupdf") => PdfEngine::Mupdf,
            _ => PdfEngine::DEFAULT,
        }
    }
}

#[cfg(test)]
mod pdf_engine_tests {
    use super::PdfEngine;

    /// ★ **P5 的承重判据**：默认引擎**显式**写在这里。
    ///
    /// 断言的是**具体**引擎（不是 `== PdfEngine::DEFAULT` 那种同义反复）——
    /// 后者在默认值被改掉时**永远绿**，等于没判据。**P5 切换（2026-09-19）就是改这一行**，
    /// 而"有人动了默认值"这件事从此一定留下痕迹。
    #[test]
    fn unset_uses_the_documented_default_engine() {
        assert_eq!(
            PdfEngine::from_env_value(None),
            PdfEngine::Pdfium,
            "未设环境变量时的默认引擎（P5 切换点，见 PdfEngine::DEFAULT）"
        );
    }

    /// 显式值必须胜过默认值，且**大小写/空格不敏感**（灰度时人手敲的开关）。
    #[test]
    fn explicit_values_win_and_are_case_insensitive() {
        assert_eq!(PdfEngine::from_env_value(Some("pdfium")), PdfEngine::Pdfium);
        assert_eq!(PdfEngine::from_env_value(Some("PDFium")), PdfEngine::Pdfium);
        assert_eq!(
            PdfEngine::from_env_value(Some(" pdfium ")),
            PdfEngine::Pdfium
        );
        assert_eq!(PdfEngine::from_env_value(Some("mupdf")), PdfEngine::Mupdf);
        assert_eq!(PdfEngine::from_env_value(Some("MuPDF")), PdfEngine::Mupdf);
    }

    /// 认不出的值（含空串）⇒ 默认，不报错。失败面：把 `""` 当成"显式指定了某个引擎"。
    #[test]
    fn unknown_or_empty_values_fall_back_to_default() {
        for v in [
            Some(""),
            Some("   "),
            Some("pdf"),
            Some("1"),
            Some("true"),
            Some("pdfiumm"),
        ] {
            assert_eq!(
                PdfEngine::from_env_value(v),
                PdfEngine::Pdfium,
                "value={v:?}"
            );
        }
    }

    /// 验收项"**一键切回 MuPDF**"：无论默认是哪个，显式写 `mupdf` 都必须得到 MuPDF。
    /// 这条与默认值无关，所以它在 P5 前后**都应该绿**。
    ///
    /// 另断言"默认确实已经不是 MuPDF" —— 否则"回滚"这个词是空的（回滚到同一个东西）。
    #[test]
    fn explicit_mupdf_always_rolls_back() {
        assert_eq!(PdfEngine::from_env_value(Some("mupdf")), PdfEngine::Mupdf);
        assert_ne!(
            PdfEngine::DEFAULT,
            PdfEngine::Mupdf,
            "P5 之后默认不再是 MuPDF；若改成 MuPDF 请同步改这条与上面那条"
        );
    }

    /// ★ **2026-09-21 的新不变式**：MuPDF 是构建期特性（默认不编）⇒ 显式要它却编不出时，
    /// 必须给一句**能照着做**的错，而不是静默换成 PDFium、也不是 panic。
    ///
    /// 这条在两种构建下都跑（各断言各的那一半）：默认构建断言"拒绝 + 出路"，
    /// `--features mupdf-rollback` 构建断言"放行"。
    ///
    /// ⚠️ **2026-09-25 清理**：本条原来第一句是 `assert_eq!(mupdf_compiled(), cfg!(feature = …))`，
    /// 而 `mupdf_compiled()` 的 body 就是那个 `cfg!` ⇒ **恒真、零覆盖**（函数已删）。
    /// 现在"编没编"由下面两半**真的**验：放行 / 拒绝＋出路，两种构建各跑一边。
    #[test]
    fn asking_for_mupdf_says_what_to_do_when_the_feature_is_off() {
        if cfg!(feature = "mupdf-rollback") {
            assert!(super::ensure_mupdf_available().is_ok(), "编了就该放行");
        } else {
            let err = super::ensure_mupdf_available()
                .expect_err("没编 MuPDF 的构建里，要 MuPDF 必须**明确报错**（不许静默换引擎）");
            assert_eq!(err, super::MUPDF_NOT_COMPILED);
            // 两件必须出现在这句话里：① 现在没有它（点名特性，好去构建）；② 现在该用什么。
            assert!(err.contains("mupdf-rollback"), "错里要点名那个特性：{err}");
            assert!(err.contains("pdfium"), "错里要给出当下可用的默认项：{err}");
        }
    }
}

/// ⭐ **D1b 的判据**（2026-10-15）：渲染命令 `rect` 入参的契约 —— 可缺省、恰好四个数、
/// 以及"哪个引擎真的支持只出这一块"。
///
/// 为什么这几条值判据（**都不需要 PDFium 动态库** ⇒ 本机 Windows 也能跑 ✓）：
///   · `rect` 一旦变成**必填**，D2 之前的前端每次渲染都会在反序列化时就失败 ⇒ **整页都出不来**
///     （不是"退回旧行为"，是直接坏掉）⇒ 所以"缺省可得"这条要钉住；
///   · 三个数 / 五个数的数组必须**当场报错**，⛔ 不许"就近取四个"糊过去（那会静默裁错位置）；
///   · MuPDF 那条**没有**裁剪入口 ⇒ 必须显式拒绝（理由见 [`engine_supports_rect`] 的注释）。
#[cfg(test)]
mod render_rect_args_tests {
    use super::{engine_supports_rect, PdfEngine, RenderPdfPageArgs, MUPDF_NO_RECT};

    fn parse(json: &str) -> Result<RenderPdfPageArgs, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// ★ 承重：**缺省 ⇒ 整页**（旧前端一个字都不用改）。
    #[test]
    fn rect_is_optional_so_older_callers_keep_working() {
        let a = parse(r#"{"attachment_id":"a","page_index":2,"scale":1.5}"#)
            .expect("不带 rect 必须能解（旧前端照旧调用）");
        assert_eq!(a.rect, None, "缺省 ⇒ 整页（D1b 之前的行为）");
        assert_eq!(a.page_index, 2);
        assert_eq!(a.scale, 1.5);

        let b = parse(r#"{"attachment_id":"a","page_index":0,"scale":1.0,"rect":null}"#)
            .expect("显式 null 也要能解");
        assert_eq!(b.rect, None, "null 与缺省同义 ⇒ 整页");
    }

    #[test]
    fn rect_parses_as_exactly_four_page_points() {
        let a = parse(
            r#"{"attachment_id":"a","page_index":0,"scale":2.0,"rect":[10.5,20.0,300.0,400.0]}"#,
        )
        .expect("四元数组必须能解");
        assert_eq!(a.rect, Some([10.5, 20.0, 300.0, 400.0]));
    }

    #[test]
    fn a_rect_of_the_wrong_shape_is_refused_not_guessed() {
        for bad in [
            r#"[1,2,3]"#,
            r#"[1,2,3,4,5]"#,
            r#"[1,2,3,"x"]"#,
            r#"{"x":1}"#,
            r#""1,2,3,4""#,
        ] {
            let json =
                format!(r#"{{"attachment_id":"a","page_index":0,"scale":1.0,"rect":{bad}}}"#);
            assert!(
                parse(&json).is_err(),
                "形状不对必须报错（⛔ 不许就近取四个）：{bad}"
            );
        }
    }

    /// ★ 承重的那条：**只有** PDFium 可以声称支持 `rect`。
    ///
    /// 变异实测口径：把 `matches!(engine, PdfEngine::Pdfium)` 改成 `true`（即"谁都支持"）
    /// ⇒ 本条当场红 ✓；而"拒绝"那条路径由 `MUPDF_NO_RECT` 的断言守着 ✓。
    #[test]
    fn only_pdfium_claims_to_support_rect() {
        assert!(
            engine_supports_rect(PdfEngine::Pdfium),
            "PDFium 有 render_page_rect（判据在 pdfium_native::d1_rect_tests）"
        );
        assert!(
            !engine_supports_rect(PdfEngine::Mupdf),
            "MuPDF 那条没有裁剪入口 ⇒ 不许声称支持（否则前端会拿整页图当一块贴）"
        );
        assert_eq!(
            PdfEngine::DEFAULT,
            PdfEngine::Pdfium,
            "默认引擎必须落在支持 rect 的那一侧（否则 D2 一上线就是错的）"
        );
    }

    #[test]
    fn refusing_rect_says_what_to_do() {
        assert!(
            MUPDF_NO_RECT.contains("pdfium"),
            "要说清现在该用哪个引擎：{MUPDF_NO_RECT}"
        );
        assert!(
            MUPDF_NO_RECT.contains("整页"),
            "要给出前端可用的退路（退回整页）：{MUPDF_NO_RECT}"
        );
    }
}

/// **这一页未裁决的冲突**（阶段 1：裁定 (iii) 的"不静默选边"要靠它显示给用户）。
///
/// 纯读；数据在本地表 `page_conflicts`，写入发生在远端应用路径（`doc_content::apply_remote_page`）。
#[tauri::command]
pub fn list_page_conflicts(
    db: State<Db>,
    page_id: String,
) -> Result<Vec<crate::doc_content::PageConflict>, String> {
    let c = conn(&db);
    crate::doc_content::unresolved_page_conflicts(&c, &page_id)
}

// =====================================================================================
// 冲刺 §13.3 第 2 条（2026-09-23 第 49 轮）· **页级血统冲突**的三条命令
//
// 与块级那两条**并列但不同族**：那种冲突可以逐块选一侧；这里撞上的是**两条独立血统**
//（Yjs 结构上合不了）⇒ 只有"留本机 / 用对端 / 两个都要（一页变两页）"。
// ⚠️ 判定"这两条血统相不相关"的**只有界面侧**（要 Yjs）⇒ 记录由界面侧发起，Rust 只负责存与裁决。
// =====================================================================================

/// 记一次页级血统冲突的载荷：两条指纹 ＋ **对端那一版的整页投影 JSON**。
///
/// ⚠️ 字段名刻意叫 `doc_json`（**不是存储列名**，与 `PageProjectionArgs` / `StaleTextPage` 同一处置）。
#[derive(serde::Deserialize)]
pub struct RecordLineageConflictArgs {
    pub page_id: String,
    pub mine_fp: String,
    pub remote_fp: String,
    pub doc_json: String,
}

/// 记一次（**去重**：同一对指纹只提一次；同一页只留一条未决）。返回**是否真的新建了一行**。
#[tauri::command]
pub fn record_lineage_conflict(
    db: State<Db>,
    args: RecordLineageConflictArgs,
) -> Result<bool, String> {
    let c = conn(&db);
    crate::lineage_conflict::record_lineage_conflict(
        &c,
        &args.page_id,
        &args.mine_fp,
        &args.remote_fp,
        &args.doc_json,
        now_ms(),
    )
}

/// 这一页**未决**的页级血统冲突（至多一条；`null` ＝ 没有 —— 这是常态，不是错误）。
#[tauri::command]
pub fn list_lineage_conflicts(
    db: State<Db>,
    page_id: String,
) -> Result<Option<crate::lineage_conflict::PageLineageConflict>, String> {
    let c = conn(&db);
    crate::lineage_conflict::unresolved_lineage_conflict(&c, &page_id)
}

/// **裁决一条**：`choice` = `"local"`（保留本机）/ `"saved-as-new"`（已把对端那版另存为新页），
/// 其余值一律报错（**不默认选边** —— 与 `resolve_page_conflict` 同一纪律）。
#[tauri::command]
pub fn resolve_lineage_conflict(
    db: State<Db>,
    conflict_id: String,
    choice: String,
) -> Result<(), String> {
    let c = conn(&db);
    crate::lineage_conflict::resolve_lineage_conflict(&c, &conflict_id, &choice, now_ms())
}

/// **裁决一处冲突**：`choice` = `"local"` / `"remote"`（其余值一律报错，**不默认选边**）。
///
/// 落库那一笔是**一次本地编辑**（`dirty = 1`）⇒ 会被推上去 —— "留本地"就是这么生效的。
#[tauri::command]
pub fn resolve_page_conflict(
    db: State<Db>,
    conflict_id: String,
    choice: String,
) -> Result<(), String> {
    let c = conn(&db);
    let choice = match choice.as_str() {
        "local" => crate::doc_content::ConflictChoice::Local,
        "remote" => crate::doc_content::ConflictChoice::Remote,
        other => return Err(format!("choice 只能是 local 或 remote，收到 {other}")),
    };
    crate::doc_content::resolve_page_conflict(&c, &conflict_id, choice)
}

/// **正文文本的本地修复**（阶段 1）：有编辑器的那一侧按编辑器语义算好文本，交给它写回。
///
/// ⚠️ **只动正文**（内容 JSON 与 `dirty` 都不动）—— 它不是用户编辑，别当成一笔本地改动推上去。
/// 返回**是否真的修了**（相同就一次写库都没有）。
#[tauri::command]
pub fn refresh_page_text(db: State<Db>, page_id: String, text: String) -> Result<bool, String> {
    let c = conn(&db);
    crate::doc_content::refresh_page_text_if_stale(&c, &page_id, &text)
}

/// ★ **待重建正文的队列**（B1，2026-09-22）：合并产物 / 冲突裁决之后，那一页的正文列与 FTS 需要
/// 按**编辑器语义**重算一遍（Rust 侧没有那个派生实现 —— 唯一实现在前端 `src/lib/contentText.ts`）。
/// 这个命令给补算器两样东西：**这一批要补的页面**（各带 `doc_json`）与**待补总数**（界面要能说"还有 N 页"）。
///
/// ⚠️ 只读；`limit` 夹在 1..=50（补算是**有预算**的后台动作，不许一次把整库拖进来）。
#[tauri::command]
pub fn list_stale_text_pages(
    db: State<Db>,
    limit: Option<usize>,
) -> Result<crate::doc_content::StaleTextQueue, String> {
    let c = conn(&db);
    crate::doc_content::stale_text_queue(&c, limit.unwrap_or(10))
}

/// ★ **待取回的远端版本**（B 方案，2026-09-22）：页级"保留本地"（本地有未推送改动时优先本地，裁定 ④）
/// 语义是对的，但那一版远端内容会被**游标吃掉** ⇒ 这台设备再也取不回对端那笔编辑，而且层里
/// **一条痕都没有**（取证 `docs/plans/2026-09-22-merge-push-and-cursor-forensics.md` §3.2 的 L）。
/// 现在它被存在本地表 `pending_remote_pages`，这个命令把清单给界面，用户随后裁决
/// （`resolve_pending_remote`）。纯读；`limit` 由调用方给（界面列表，不是批量作业）。
#[tauri::command]
pub fn list_pending_remote_pages(
    db: State<Db>,
    limit: Option<usize>,
) -> Result<crate::doc_content::PendingRemoteQueue, String> {
    let c = conn(&db);
    crate::doc_content::pending_remote_queue(&c, limit.unwrap_or(20))
}

/// ★ **裁决一处"待取回的远端版本"**：`choice` = `"merge"`（合并这一页：先逐块合并，两端各改不同块 ⇒ 都保留）
/// / `"take_remote"`（整页采用远端，并**真的**放弃本地还没推上去的改动）/ `"keep_local"`（保留本地，什么都不动）。
/// 其余值一律报错（**不默认选边** —— 与 `resolve_page_conflict` 同一纪律）。
///
/// 三个选项都**真的动数据**：旧横幅那两条按钮只改一行文案（取证文件 §4 的 F3），这一版不是。
#[tauri::command]
pub fn resolve_pending_remote(
    db: State<Db>,
    page_id: String,
    choice: String,
) -> Result<crate::sync::PendingChoiceReport, String> {
    let c = conn(&db);
    let choice = crate::sync::PendingChoice::parse(&choice)
        .ok_or_else(|| format!("choice 只能是 merge / take_remote / keep_local，收到 {choice}"))?;
    crate::sync::resolve_pending_remote(&c, &page_id, choice)
}

#[cfg(test)]
mod page_chrome_sync_tests {
    //! ⭐ 2026-10-24（真机：**题头图没有同步**）：四条"页面外观"命令改完库之后，
    //! 必须 ① 推进 `updated_at`、② **记一条 `page/upsert`**（否则服务端/网格两条同步路
    //! 都看不见这次改动 —— 现场：Windows 设了封面，macOS 收不到）。
    //!
    //! ⚠️ 先写红：把 `finish_page_chrome_update` 里 `record_page_upsert` 那行去掉（或把
    //! `updated_at` 那句去掉），下面对应断言**必红**。
    use super::*;

    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "ATTACH DATABASE ':memory:' AS meta;
             CREATE TABLE meta.sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE meta.sync_profiles (ws_id TEXT PRIMARY KEY, last_pushed_seq INTEGER NOT NULL DEFAULT 0);",
        )
        .unwrap();
        crate::db::migrate(&c, "ws").unwrap();
        crate::sync::set_meta_state(&c, "device_id", "test-dev").unwrap();
        c.execute(
            "INSERT INTO pages (id, workspace_id, title, content_json, content_text, kind, created_at, updated_at)
             VALUES ('p1','ws','页','{}','','page',1,1)",
            [],
        )
        .unwrap();
        c
    }

    fn chrome_of(c: &Connection) -> (String, String, i64, f64, i64) {
        c.query_row(
            "SELECT cover, icon, cover_height, cover_pos, updated_at FROM pages WHERE id='p1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap()
    }

    #[test]
    fn setting_the_cover_persists_it_and_records_one_sync_change() {
        let c = fixture();
        c.execute(
            "UPDATE pages SET cover='url(\"/covers/a.jpg\")' WHERE id='p1'",
            [],
        )
        .unwrap();

        let page = finish_page_chrome_update(&c, "p1", 42_000).expect("尾巴");
        assert_eq!(page.cover, "url(\"/covers/a.jpg\")");
        assert_eq!(chrome_of(&c).0, "url(\"/covers/a.jpg\")");
        assert_eq!(
            chrome_of(&c).4,
            42_000,
            "updated_at 必须被推进（LWW/排序都看它）"
        );

        let payload: String = c
            .query_row(
                "SELECT payload FROM changes WHERE entity='page' AND entity_id='p1' AND op='upsert' ORDER BY seq DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .expect("没有产生 page/upsert 变更 ⇒ 同步看不见这次改封面");
        let v: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(v["cover"], "url(\"/covers/a.jpg\")", "载荷里必须带封面");
        assert_eq!(v["updated_at"], 42_000);
    }

    #[test]
    fn all_four_chrome_fields_land_in_the_change_payload() {
        let c = fixture();
        c.execute(
            "UPDATE pages SET icon='📕', cover_height=420, cover_pos=30 WHERE id='p1'",
            [],
        )
        .unwrap();
        finish_page_chrome_update(&c, "p1", 43_000).unwrap();
        let payload: String = c
            .query_row(
                "SELECT payload FROM changes WHERE entity='page' AND entity_id='p1' ORDER BY seq DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(v["icon"], "📕");
        assert_eq!(v["cover_height"], 420);
        assert_eq!(v["cover_pos"], 30.0);
    }

    #[test]
    fn a_missing_page_is_an_error_not_a_silent_success() {
        let c = fixture();
        assert_eq!(
            finish_page_chrome_update(&c, "nope", 1).unwrap_err(),
            "页面不存在"
        );
    }
}

#[cfg(test)]
mod cover_normalize_tests {
    use super::normalize_cover_value;

    /// ⭐ 2026-10-24（owner 拍「1B」）：四种输入各一条判据 —— 这一格曾经"怎么存都不显示"。
    #[test]
    fn cover_values_are_normalized_to_css_url() {
        // 裸文件名（真实现场：`微信头像.jpg`）⇒ 必须包成 url("…")，否则 CSS 无效
        assert_eq!(
            normalize_cover_value("微信头像.jpg").unwrap(),
            "url(\"微信头像.jpg\")"
        );
        // 相对路径同理
        assert_eq!(
            normalize_cover_value("covers/default-cover.jpg").unwrap(),
            "url(\"covers/default-cover.jpg\")"
        );
        // data URL ⇒ 包起来（渲染层只认 background-image 形式）
        assert_eq!(
            normalize_cover_value("data:image/png;base64,AAAA").unwrap(),
            "url(\"data:image/png;base64,AAAA\")"
        );
        // 已经是 url(...) ⇒ **原样**（⛔ 不许套成 url("url(…)")）
        assert_eq!(
            normalize_cover_value("url(\"covers/a.jpg\")").unwrap(),
            "url(\"covers/a.jpg\")"
        );
        assert_eq!(
            normalize_cover_value("URL(covers/a.jpg)").unwrap(),
            "URL(covers/a.jpg)"
        );
        // 空 ⇒ 清掉封面
        assert_eq!(normalize_cover_value("   ").unwrap(), "");
    }

    /// ⛔ 含引号/换行要**拒绝并说明原因**（不再是一句看不懂的 `Uncaught`）。
    #[test]
    fn cover_values_with_quotes_or_newlines_are_refused_with_a_reason() {
        let e = normalize_cover_value("a\".jpg").unwrap_err();
        assert!(
            e.contains("双引号") || e.contains("换行"),
            "错误信息要能看懂：{e}"
        );
        assert!(normalize_cover_value("a\nb").unwrap_err().contains("换行"));
    }
}
