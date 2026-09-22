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
pub fn list_pages(db: State<Db>) -> Result<Vec<PageMeta>, String> {
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

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
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
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_page(db: State<Db>, id: String) -> Result<PageDetail, String> {
    let c = conn(&db);
    let page = fetch_page(&c, &id)?;
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
}

#[tauri::command]
pub fn create_page(db: State<Db>, args: CreatePageArgs) -> Result<PageDetail, String> {
    create_node(
        db,
        args.parent_id,
        args.title,
        "page",
        args.content_json,
        args.content_text,
    )
}

#[tauri::command]
pub fn create_folder(db: State<Db>, args: CreatePageArgs) -> Result<PageDetail, String> {
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
    content_json: Option<String>,
    content_text: Option<String>,
) -> Result<PageDetail, String> {
    let c = conn(&db);
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

    let json = content_json.unwrap_or_else(|| "{}".to_string());
    let text = content_text.unwrap_or_default();
    let ws = workspaces::active_workspace_id(&c)?;

    c.execute(
        "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)",
        params![id, ws, parent_id, title, json, text, kind, sort_order, now, now],
    )
    .map_err(|e| e.to_string())?;

    search::sync_fts(&c, &id, &title, &text)?;
    // Rebuild block/backlink graph on create too, so any `[[双链]]` / block refs in
    // the initial content (e.g. the programmatically-created 使用指南 pages) show
    // up in the relationship graph. Mirrors save_page.
    blocks::rebuild_block_graph(&c, &id, &json, &text)?;

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

#[derive(Deserialize)]
pub struct SetCoverArgs {
    pub id: String,
    /// CSS gradient string (e.g. "linear-gradient(...)") or an empty string to clear.
    pub cover: String,
}

/// Set a page's cover (CSS gradient) and return the updated page detail.
#[tauri::command]
pub fn set_page_cover(db: State<Db>, args: SetCoverArgs) -> Result<PageDetail, String> {
    let c = conn(&db);
    c.execute(
        "UPDATE pages SET cover = ?1 WHERE id = ?2 AND deleted_at IS NULL",
        params![args.cover, args.id],
    )
    .map_err(|e| e.to_string())?;
    fetch_page(&c, &args.id)
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
pub fn save_pdf_annotations(db: State<Db>, args: SavePdfAnnotationsArgs) -> Result<serde_json::Value, String> {
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
pub fn list_pdf_annotations(db: State<Db>, args: ListPdfAnnotationsArgs) -> Result<Vec<serde_json::Value>, String> {
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
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
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
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Set a page's cover height (px) and return the updated page detail.
#[tauri::command]
pub fn set_page_cover_height(db: State<Db>, args: SetCoverHeightArgs) -> Result<PageDetail, String> {
    let c = conn(&db);
    c.execute(
        "UPDATE pages SET cover_height = ?1 WHERE id = ?2 AND deleted_at IS NULL",
        params![args.height.clamp(120, 720), args.id],
    )
    .map_err(|e| e.to_string())?;
    fetch_page(&c, &args.id)
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
    fetch_page(&c, &args.id)
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
    fetch_page(&c, &args.id)
}

#[tauri::command]
pub fn save_page(db: State<Db>, args: SavePageArgs) -> Result<PageDetail, String> {
    let c = conn(&db);
    let now = now_ms();

    // Read current values for fields not provided. 走「文档内容」那一层（阶段 0 接口收口）。
    let cur = crate::doc_content::read(&c, &args.id)?
        .ok_or_else(|| "页面不存在".to_string())?;

    let content = crate::doc_content::DocContent {
        title: args.title.unwrap_or(cur.title),
        // ★ **阶段 1**：保存时给每个有身份的顶层块盖 `blockRev`（baseline = 库里这一页）。
        //   块级判定（`sync::apply_upsert` 的 `merge_remote_content`）靠它比"哪一块更新"；
        //   不盖章 ⇒ 判定每一页都会回落到页级 LWW，接线等于白接。
        //   ⚠️ 顺序：**先盖章再落库/快照** —— 快照里存的应当是"用户真正保存的那一版"（含 rev）。
        json: crate::doc_content::stamp_block_revs(
            &c,
            &args.id,
            &args.content_json.unwrap_or_else(|| cur.json.clone()),
        )?,
        text: args.content_text.unwrap_or(cur.text),
    };

    // Snapshot the current state before overwriting (version history).
    versions::snapshot_before_save(&c, &args.id, &content.title, &content.json, &content.text)?;

    crate::doc_content::write(&c, &args.id, &content, now)?;
    crate::doc_content::derive(&c, &args.id, &content)?;

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
            .query_row("SELECT title FROM pages WHERE id = ?1", params![pid], |r| r.get(0))
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
    pub rgba_base64: String,
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
#[tauri::command]
pub async fn render_pdf_page(app: tauri::AppHandle, db: State<'_, Db>, args: RenderPdfPageArgs) -> Result<PdfPagePayload, String> {
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
    // 在阻塞线程池上执行栅格化，避免阻塞主（UI）线程。
    // 两条路径都**归一成紧凑 RGBA**（前端按 宽×高×4 校验字节数）：
    //  · MuPDF 出的是带行填充的缓冲 ⇒ 还要 `compact_rgba`；
    //  · PDFium 的 `as_rgba_bytes()` **本来就是紧凑的** ⇒ 不需要那一步（见 pdfium_native.rs 模块头第 1 条）。
    let (compact, w, h) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(Vec<u8>, usize, usize), String> {
            match engine {
                PdfEngine::Mupdf => {
                    #[cfg(feature = "mupdf-rollback")]
                    {
                        let (rgba, w, h, stride) =
                            unsafe { crate::pdf_native::render_page(&hash, &bytes, page_index, scale) }?;
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
                    crate::pdfium_native::render_page_owned(&hash, bytes, idx, scale)
                }
            }
        },
    )
    .await
    .map_err(|e| format!("render task failed: {e}"))??;
    let width = u32::try_from(w).map_err(|_| format!("PDF: 页面宽度 {w} 超出范围"))?;
    let height = u32::try_from(h).map_err(|_| format!("PDF: 页面高度 {h} 超出范围"))?;
    use base64::Engine as _;
    Ok(PdfPagePayload {
        width,
        height,
        rgba_base64: base64::engine::general_purpose::STANDARD.encode(&compact),
    })
}

/// 这个构建**有没有编入 MuPDF**（构建期特性 `mupdf-rollback`）——配置的**单一事实来源**：
/// 命令的分派与下面的判据都问它，免得"注释说没编、代码却还在调"。
pub(crate) fn mupdf_compiled() -> bool {
    cfg!(feature = "mupdf-rollback")
}

/// 请求了 MuPDF、但这个构建没编入它时给的那句话。
///
/// 为什么要这么长：这不是"内部错误"，而是**用户（或灰度时的人）敲了一个开关却得不到想要的东西**
/// —— 必须一句话说清"现在没有它 + 换哪个开关 + 想要它怎么构建"。
/// （编了 `mupdf-rollback` 的构建里这句话没有调用点，但那是有意的：判据与文档都指着它。）
#[cfg_attr(feature = "mupdf-rollback", allow(dead_code))]
pub(crate) const MUPDF_NOT_COMPILED: &str = "这个构建没有编入 MuPDF（构建期特性 `mupdf-rollback`，2026-09-21 起默认不编）。\
现在请把 SHUYONOTE_PDF_ENGINE 设为 pdfium（或删掉这个环境变量）用默认引擎；\
若确实要用 MuPDF 回滚，请用带 `--features mupdf-rollback` 重新构建的安装包。";

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
        assert_eq!(PdfEngine::from_env_value(Some(" pdfium ")), PdfEngine::Pdfium);
        assert_eq!(PdfEngine::from_env_value(Some("mupdf")), PdfEngine::Mupdf);
        assert_eq!(PdfEngine::from_env_value(Some("MuPDF")), PdfEngine::Mupdf);
    }

    /// 认不出的值（含空串）⇒ 默认，不报错。失败面：把 `""` 当成"显式指定了某个引擎"。
    #[test]
    fn unknown_or_empty_values_fall_back_to_default() {
        for v in [Some(""), Some("   "), Some("pdf"), Some("1"), Some("true"), Some("pdfiumm")] {
            assert_eq!(PdfEngine::from_env_value(v), PdfEngine::Pdfium, "value={v:?}");
        }
    }

    /// 验收项"**一键切回 MuPDF**"：无论默认是哪个，显式写 `mupdf` 都必须得到 MuPDF。
    /// 这条与默认值无关，所以它在 P5 前后**都应该绿**。
    ///
    /// 另断言"默认确实已经不是 MuPDF" —— 否则"回滚"这个词是空的（回滚到同一个东西）。
    #[test]
    fn explicit_mupdf_always_rolls_back() {
        assert_eq!(PdfEngine::from_env_value(Some("mupdf")), PdfEngine::Mupdf);
        assert_ne!(PdfEngine::DEFAULT, PdfEngine::Mupdf, "P5 之后默认不再是 MuPDF；若改成 MuPDF 请同步改这条与上面那条");
    }

    /// ★ **2026-09-21 的新不变式**：MuPDF 是构建期特性（默认不编）⇒ 显式要它却编不出时，
    /// 必须给一句**能照着做**的错，而不是静默换成 PDFium、也不是 panic。
    ///
    /// 这条在两种构建下都跑（各断言各的那一半）：默认构建断言"拒绝 + 出路"，
    /// `--features mupdf-rollback` 构建断言"放行"。
    #[test]
    fn asking_for_mupdf_says_what_to_do_when_the_feature_is_off() {
        assert_eq!(
            super::mupdf_compiled(),
            cfg!(feature = "mupdf-rollback"),
            "`mupdf_compiled()` 必须与 feature 一致（它是配置的单一事实来源）"
        );
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

/// **裁决一处冲突**：`choice` = `"local"` / `"remote"`（其余值一律报错，**不默认选边**）。
///
/// 落库那一笔是**一次本地编辑**（`dirty = 1`）⇒ 会被推上去 —— "留本地"就是这么生效的。
#[tauri::command]
pub fn resolve_page_conflict(db: State<Db>, conflict_id: String, choice: String) -> Result<(), String> {
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
