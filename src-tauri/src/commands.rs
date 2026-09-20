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
        json: args.content_json.unwrap_or(cur.json),
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
    // 环境变量取值与默认值见 `PdfEngine::resolve` / `PdfEngine::DEFAULT`。
    // ⚠️ 2026-09-20 起取值**多看一眼库在不在**（`resolve` 的注释写了为什么）：
    //    默认=PDFium，但**库不在时回退 MuPDF** —— 否则包里还没带库的平台会当场渲染失败，
    //    而终端用户设不了 `SHUYONOTE_PDF_ENGINE`。
    let env_value = std::env::var("SHUYONOTE_PDF_ENGINE").ok();
    let pdfium_ready = crate::pdfium_native::library_available();
    let engine = PdfEngine::resolve(env_value.as_deref(), pdfium_ready);
    // 回退要**说出来一次**：否则"默认引擎是 PDFium"在那些平台上就是一句假话，
    // 而且排查时只能看到"走了 MuPDF"却不知道为什么。
    if !pdfium_ready
        && engine == PdfEngine::Mupdf
        && !env_value.as_deref().map(str::trim).map(|v| v.eq_ignore_ascii_case("mupdf")).unwrap_or(false)
    {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            eprintln!(
                "[pdf] 未找到 PDFium 动态库 ⇒ 本机**回退到 MuPDF**（开发机：`node scripts/fetch-pdfium.mjs`；\
                 装包时应由打包步骤把库放到可执行文件同目录。显式要 PDFium：`SHUYONOTE_PDF_ENGINE=pdfium`）"
            );
        });
    }
    // ⚠️ **两套缓存互斥淘汰**（P2 验收项）：同一个 hash 若被两个引擎各持一份，
    // 内存会无声翻倍而两侧 LRU 互不知情 ⇒ 切引擎时先清掉另一侧的同 key 条目。
    match engine {
        PdfEngine::Pdfium => crate::pdf_native::forget(&hash),
        PdfEngine::Mupdf => crate::pdfium_native::forget(&hash),
    }
    // 缓存命中判断也要**按引擎各查各的**（两套缓存彼此独立）。
    let cached = match engine {
        PdfEngine::Mupdf => crate::pdf_native::has_document(&hash),
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
                    let (rgba, w, h, stride) =
                        unsafe { crate::pdf_native::render_page(&hash, &bytes, page_index, scale) }?;
                    Ok((crate::pdf_native::compact_rgba(&rgba, w, h, stride)?, w, h))
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

    /// ★ **取值口径：把"库在不在"也算进去**（P5 之后必须有这一层）。
    ///
    /// 参数 `value` = `SHUYONOTE_PDF_ENGINE` 的取值（**大小写与首尾空格都不敏感**）；
    /// `pdfium_available` = PDFium 动态库是否就位（`pdfium_native::library_available()`）。
    ///
    /// 为什么必须看库（2026-09-20，Windows 侧复核 P5 时发现）：默认已切成 `Pdfium`，
    /// 而**只有 Windows 的包确定带了库**（方案 §4 验收表：Linux/macOS/Android 的"首启即可渲染"**未验**）。
    /// 默认若不管库在不在，那些平台的 PDF 会**当场渲染失败** ——
    /// 而"回滚"要靠 `SHUYONOTE_PDF_ENGINE=mupdf`，**终端用户设不了这个环境变量**。
    ///
    /// ⇒ 语义三条：
    /// 1. 显式 `pdfium` ⇒ **PDFium，不回退**（调用方明确要它，就该把"库不在"这个错误**说出来**，
    ///    而不是悄悄换引擎 —— 否则排查时会以为自己在用 PDFium，"成功 ≠ 生效"那一类）；
    /// 2. 显式 `mupdf` ⇒ **MuPDF**（与库在不在无关：一键回滚必须在任何机器上都有效）；
    /// 3. 缺省 / 认不出的值（含空串）⇒ **库在走 [`PdfEngine::DEFAULT`]（现在是 PDFium），
    ///    库不在回退 MuPDF**（MuPDF 编译进二进制，一定在）。认不出不报错：渲染不该因为一个拼错的开关而失败。
    pub(crate) fn resolve(value: Option<&str>, pdfium_available: bool) -> PdfEngine {
        match value.map(str::trim) {
            Some(v) if v.eq_ignore_ascii_case("pdfium") => PdfEngine::Pdfium,
            Some(v) if v.eq_ignore_ascii_case("mupdf") => PdfEngine::Mupdf,
            _ if pdfium_available => PdfEngine::DEFAULT,
            _ => PdfEngine::Mupdf,
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
            PdfEngine::resolve(None, true),
            PdfEngine::Pdfium,
            "未设环境变量时的默认引擎（P5 切换点，见 PdfEngine::DEFAULT）"
        );
    }

    /// 显式值必须胜过默认值，且**大小写/空格不敏感**（灰度时人手敲的开关）。
    /// `true` = "库在"那一档（显式值本来就与库在不在无关，两种都断言在下面两条）。
    #[test]
    fn explicit_values_win_and_are_case_insensitive() {
        assert_eq!(PdfEngine::resolve(Some("pdfium"), true), PdfEngine::Pdfium);
        assert_eq!(PdfEngine::resolve(Some("PDFium"), true), PdfEngine::Pdfium);
        assert_eq!(PdfEngine::resolve(Some(" pdfium "), true), PdfEngine::Pdfium);
        assert_eq!(PdfEngine::resolve(Some("mupdf"), true), PdfEngine::Mupdf);
        assert_eq!(PdfEngine::resolve(Some("MuPDF"), true), PdfEngine::Mupdf);
    }

    /// 认不出的值（含空串）⇒ 默认，不报错。失败面：把 `""` 当成"显式指定了某个引擎"。
    #[test]
    fn unknown_or_empty_values_fall_back_to_default() {
        for v in [Some(""), Some("   "), Some("pdf"), Some("1"), Some("true"), Some("pdfiumm")] {
            assert_eq!(PdfEngine::resolve(v, true), PdfEngine::Pdfium, "value={v:?}");
        }
    }

    /// 验收项"**一键切回 MuPDF**"：无论默认是哪个，显式写 `mupdf` 都必须得到 MuPDF。
    /// 这条与默认值无关，所以它在 P5 前后**都应该绿**。
    ///
    /// 另断言"默认确实已经不是 MuPDF" —— 否则"回滚"这个词是空的（回滚到同一个东西）。
    #[test]
    fn explicit_mupdf_always_rolls_back() {
        assert_eq!(PdfEngine::resolve(Some("mupdf"), true), PdfEngine::Mupdf);
        assert_ne!(PdfEngine::DEFAULT, PdfEngine::Mupdf, "P5 之后默认不再是 MuPDF；若改成 MuPDF 请同步改这条与上面那条");
    }

    /// ★ **缺库回退**（2026-09-20 补）：默认取值必须**看库在不在**。
    ///
    /// 为什么要有这条：P5 已把默认切成 PDFium，而**只有 Windows 的包确定带了库**
    /// （方案 §4 验收表里 Linux/macOS/Android 的"首启即可渲染"**未验**）⇒
    /// 若默认不看库在不在，那些平台的 PDF 会**当场渲染失败**，
    /// 而"回滚"要靠 `SHUYONOTE_PDF_ENGINE=mupdf` —— **终端用户设不了环境变量**。
    #[test]
    fn default_falls_back_to_mupdf_when_the_library_is_missing() {
        assert_eq!(PdfEngine::resolve(None, true), PdfEngine::Pdfium, "库在 ⇒ 走默认（PDFium）");
        assert_eq!(PdfEngine::resolve(None, false), PdfEngine::Mupdf, "库不在 ⇒ 回退 MuPDF");
        // 认不出的值也走同一条判断（而不是硬走 DEFAULT —— 那就等于"库不在也用 PDFium"）
        for v in [Some(""), Some("   "), Some("pdf"), Some("1"), Some("pdfiumm")] {
            assert_eq!(PdfEngine::resolve(v, true), PdfEngine::Pdfium, "value={v:?} 库在");
            assert_eq!(PdfEngine::resolve(v, false), PdfEngine::Mupdf, "value={v:?} 库不在");
        }
    }

    /// ⚠️ **显式**要 PDFium 时**不回退**：调用方明确要它，就该把"库不在"这个错误**说出来**，
    /// 而不是悄悄换一个引擎（否则排查时会以为自己在用 PDFium）。
    /// 这条属于"成功 ≠ 生效"那一族：**静默换引擎比报错更难查**。
    #[test]
    fn explicit_pdfium_never_silently_falls_back() {
        assert_eq!(PdfEngine::resolve(Some("pdfium"), false), PdfEngine::Pdfium);
        assert_eq!(PdfEngine::resolve(Some(" PDFIUM "), false), PdfEngine::Pdfium);
    }

    /// 显式 `mupdf` 与"库在不在"**无关** —— 一键回滚在任何机器上都必须有效。
    #[test]
    fn explicit_mupdf_is_unaffected_by_availability() {
        assert_eq!(PdfEngine::resolve(Some("mupdf"), true), PdfEngine::Mupdf);
        assert_eq!(PdfEngine::resolve(Some("mupdf"), false), PdfEngine::Mupdf);
    }
}
