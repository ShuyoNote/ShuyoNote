mod ai;
mod attachments;
mod backlinks;
mod backup;
mod blocks;
mod bookmark;
mod commands;
mod crypto;
mod database;
mod db;
mod graph;
mod models;
mod pdf_native;
mod plugins;
mod properties;
mod search;
mod security;
mod storage;
mod sync;
mod tags;
mod templates;
mod titlebar;
mod trash;
mod versions;
mod windows;
mod workspace_io;
mod workspaces;

use db::Db;
use std::borrow::Cow;
use std::sync::Mutex;
use tauri::http::header::CACHE_CONTROL;
use tauri::webview::PageLoadEvent;
use tauri::{utils::config::Color, Manager, WebviewUrl, WebviewWindowBuilder};

/// Apply cache headers to the Tauri-served web resources so that a version
/// upgrade does not leave the WebView serving a stale `index.html` from cache.
///
/// - The app shell (`index.html`, manifest, root) gets `no-cache`, so the next
///   launch re-validates and pulls the freshly embedded shell after an update.
/// - Content-hashed assets under `/assets/` stay immutable+long-lived (they are
///   content-addressed, so a stale hash can never point at wrong content).
fn with_cache_headers(
    request: tauri::http::Request<Vec<u8>>,
    response: &mut tauri::http::Response<Cow<'static, [u8]>>,
) {
    let path = request.uri().path().to_string();
    let value = if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    if let Ok(header_value) = value.parse() {
        response.headers_mut().insert(CACHE_CONTROL, header_value);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 单实例：禁止多开。ShuyoNote 是本地优先单库（meta.db 一个 device_id /
        // token / auth_sessions），多实例会互相覆盖 token、device 绑定冲突（同机多实例
        // 各自登录 = 之前 zhaizy/cnzen001 那类 403）。第二个实例启动时唤起第一个。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 唤起已有实例到前台：先还原最小化窗口，再抢焦点。否则二次启动时最小化的
            // 实例只是被 set_focus，不会取消最小化/前置，用户以为没响应用户。
            fn raise(w: tauri::WebviewWindow) {
                let _ = w.unminimize(); // 最小化 → 还原
                let _ = w.show();       // 确保显示（可能在托盘/隐藏）
                let _ = w.set_focus();  // 抢焦点到前台
            }
            if let Some(w) = app.get_webview_window("main") {
                raise(w);
            }
        }))
        // E1 attachment at-rest decryption-on-serve: `convertFileSrc(path, "attachment")`
        // produces a platform-correct `attachment://`/`http://attachment.localhost` URL;
        // this handler percent-decodes the target path, validates it is under the app's
        // attachments dir, reads the (possibly session-key encrypted) bytes and returns
        // them decrypted — so the WebView renders plaintext WITHOUT writing it to disk.
        .register_uri_scheme_protocol("attachment", |ctx, request| {
            use percent_encoding::percent_decode;
            use std::path::{Component, Path};
            use tauri::http::header::{ACCESS_CONTROL_ALLOW_ORIGIN, CONTENT_TYPE};
            let raw_path = request.uri().path().as_bytes();
            let decoded = percent_decode(if raw_path.len() > 1 { &raw_path[1..] } else { raw_path })
                .decode_utf8_lossy()
                .into_owned();
            let app = ctx.app_handle();
            let data_dir = app.path().app_data_dir().ok();
            let attachments_dir = data_dir.map(|d| d.join("attachments"));
            // Validate the target is inside the attachments dir. A lexical
            // `starts_with` is NOT a boundary (it doesn't normalize `..`), so:
            // 1) reject any `..` path component outright, and
            // 2) canonicalize both sides and compare the resolved paths.
            let ok = attachments_dir
                .as_ref()
                .and_then(|ad| ad.canonicalize().ok())
                .and_then(|canon_ad| {
                    let p = Path::new(&decoded);
                    if p.components().any(|c| matches!(c, Component::ParentDir)) {
                        return None;
                    }
                    let canon = p.canonicalize().ok()?;
                    canon.starts_with(&canon_ad).then_some(())
                })
                .is_some();
            if !ok {
                return tauri::http::Response::builder()
                    .status(403)
                    .body(Cow::Owned(Vec::new()))
                    .unwrap();
            }
            let raw = std::fs::read(&decoded).unwrap_or_default();
            let key = {
                let db = app.state::<Db>();
                let c = db.0.lock().expect("db mutex poisoned");
                security::key_if_enabled(&c)
            };
            let out = security::decrypt_attachment_bytes(key.as_ref(), &raw).unwrap_or(raw.clone());
            let ext = Path::new(&decoded)
                .extension()
                .map(|e| e.to_string_lossy().to_string())
                .unwrap_or_else(|| "bin".to_string());
            let mime = match ext.as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                "svg" => "image/svg+xml",
                "pdf" => "application/pdf",
                _ => "application/octet-stream",
            };
            // The app shell (http://tauri.localhost in prod / localhost:1420 in dev)
            // fetches these URLs cross-origin. Without ACAO the browser blocks the
            // response and the PDF/image fails to load. Echo the caller's origin if
            // it is one of our app origins (attachment URLs are content-addressed and
            // unguessable, so we do NOT use `*`).
            let origin = request
                .headers()
                .get("origin")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let allow_origin = match origin.as_deref() {
                Some(o)
                    if o.starts_with("http://tauri.localhost")
                        || o.starts_with("http://127.0.0.1")
                        || o.starts_with("http://localhost") =>
                {
                    o
                }
                _ => "http://tauri.localhost",
            };
            tauri::http::Response::builder()
                .header(CONTENT_TYPE, mime)
                .header(ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin)
                .body(Cow::Owned(out))
                .unwrap()
        })
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let conn = db::init(app_data_dir).map_err(|e| {
                eprintln!("failed to init db: {e}");
                std::io::Error::other(e.to_string())
            })?;
            // E1: if workspace encryption is enabled, default to the locked state on
            // launch so the passphrase must be re-entered before any encrypted sync.
            security::startup_lock(&conn);
            app.manage(Db(Mutex::new(conn)));
            // Seed a bundled demo plugin so the plugin system has something to load.
            let _ = plugins::ensure_demo_plugin(&app.handle());

            // The main window is built in code so we can attach the resource
            // cache-header hook (config-created windows can't). Its label is
            // "main" to match the `default` capability and the rest of the app.
            let version = app.package_info().version.to_string();
            let url = WebviewUrl::App("index.html".into());
            WebviewWindowBuilder::new(app, "main", url)
                .title(format!("ShuyoNote 数友笔记 · v{version}"))
                .inner_size(1200.0, 800.0)
                // 自绘标题栏（前端 <TitleBar />）。做成无边框而不是保留系统栏，
                // 是为了让顶栏能显示「当前页面 · 空间」并与应用配色连成一体。
                // 用户可在 设置 → 外观 关掉，前端会运行时 setDecorations(true)
                // 恢复系统标题栏——因为 Windows 上无边框要自己接管 Aero Snap
                // 与边缘 resize，万一某台机器手感不对得有退路。
                .decorations(false)
                // 关键：Windows 上内置 drag-drop handler 开着时，HTML5 拖拽
                // API 不可用——data-tauri-drag-region 正是依赖它拖窗口，所以
                // 标题栏拖不动。这里关掉，让标题栏可拖；文件视图需要 OS 拖文件
                // 时前端临时开（见 titlebar::set_drag_drop_enabled）。
                .drag_and_drop(false)
                // 关键注释：Windows 上 dragDropEnabled 默认 true，此时
                // data-tauri-drag-region 不生效（标题栏拖不动）。这里显式关掉，
                // 文件视图挂载时前端临时打开（api.setDragDropEnabled(true)）。
                // 关键：Windows 上必须 dragDropEnabled=false，data-tauri-drag-region
                // 才生效（否则标题栏/PDF 头部都拖不动窗口——默认值 true 时 WebView
                // 把鼠标当文件拖入处理）。代价是 OS 文件拖入上传失效，因此文件视图
                // 挂载时会临时 setDragDropEnabled(true)，离开时再关（见 api.ts
                // setDragDropEnabled）。
                // Start hidden + brand-dark background: WebView2 cold-start shows a
                // white window before the HTML/SW/splash paints. We tint the
                // window to the splash's dark background and only reveal it once
                // the page has finished loading, so there's no white flash.
                .background_color(Color(11, 21, 51, 255))
                .visible(false)
                .on_page_load(|window, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        let _ = window.show();
                    }
                })
                .on_web_resource_request(with_cache_headers)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_pages,
            commands::list_workspace_pages,
            workspaces::list_workspaces,
            workspaces::create_workspace,
            workspaces::get_active_workspace_id,
            workspaces::set_active_workspace_id,
            workspaces::copy_page_to_workspace,
            workspaces::delete_workspace,
            workspaces::get_workspace_name,
            workspaces::rename_workspace,
            workspaces::set_workspace_settings,
            commands::get_page,
            commands::create_page,
            commands::create_folder,
            commands::create_database,
            commands::save_page,
            commands::set_page_cover,
            commands::set_page_icon,
            commands::set_page_cover_height,
            commands::save_pdf_annotations,
            commands::list_pdf_annotations,
            commands::list_all_pdf_annotations,
            commands::render_pdf_page,
            commands::delete_page,
            commands::move_page,
            search::search,
            sync::get_sync_config,
            sync::set_sync_config,
            sync::sync_now,
            sync::list_sync_profiles,
            sync::set_sync_profile,
            sync::sync_workspace,
            sync::team_register,
            sync::team_login,
            sync::team_logout,
            sync::team_list_spaces,
            sync::team_create_space,
            sync::team_list_members,
            sync::team_invite_member,
            sync::team_set_member_role,
            sync::team_remove_member,
            sync::team_get_session,
            sync::team_get_me,
            sync::team_get_server_email,
            sync::list_sync_history,
            sync::clear_sync_history,
            sync::team_list_orgs,
            sync::team_create_org,
            sync::team_list_org_members,
            sync::team_invite_org_member,
            sync::team_set_org_member_active,
            sync::team_remove_org_member,
            sync::team_approve_org_invite,
            sync::team_reject_org_invite,
            sync::team_deactivate_account,
            sync::team_deactivate_org_member,
            sync::team_generate_org_invite_code,
            sync::team_join_org_by_code,
            attachments::save_image,
            attachments::attachment_path,
            attachments::copy_attachment,
            attachments::list_attachment_hashes,
            attachments::read_attachment_bytes,
            attachments::write_attachment_bytes,
            attachments::import_attachment_files,
            attachments::list_page_attachments,
            attachments::list_all_pdf_attachments,
            attachments::remove_attachment,
            attachments::remove_attachments,
            attachments::move_attachment,
            attachments::get_attachment,
            attachments::restore_attachment,
            bookmark::fetch_bookmark_metadata,
            backlinks::get_backlinks,
            blocks::resolve_block,
            blocks::get_page_blocks,
            blocks::search_blocks,
            blocks::list_block_backlinks,
            graph::get_graph,
            properties::list_attr_defs,
            properties::create_attr,
            properties::update_attr,
            properties::delete_attr,
            properties::set_page_prop,
            properties::remove_page_prop,
            properties::get_page_props,
            database::get_db_columns,
            database::add_db_column,
            database::remove_db_column,
            database::query_database,
            database::board_by_attr,
            database::list_db_views,
            database::save_db_view,
            database::delete_db_view,
            database::set_db_rule,
            database::get_db_rule,
            database::resolve_refs,
            tags::list_tags,
            tags::create_tag,
            tags::rename_tag,
            tags::delete_tag,
            tags::page_tags,
            tags::add_tag,
            tags::remove_tag,
            tags::pages_by_tag,
            tags::board_data,
            tags::move_card,
            templates::list_templates,
            templates::save_as_template,
            templates::delete_template,
            trash::list_deleted,
            trash::restore_page,
            trash::purge_page,
            versions::list_versions,
            versions::restore_version,
            backup::export_backup,
            backup::import_backup,
            backup::write_text_file,
            backup::write_binary_file,
            backup::read_text_file,
            workspace_io::export_workspace,
            workspace_io::import_workspace,
            storage::storage_stats,
            storage::clear_trash,
            storage::cleanup_orphan_attachments,
            storage::cleanup_old_versions,
            storage::cleanup_temp_files,
            storage::purge_deleted_workspaces,
            windows::open_page_window,
            titlebar::set_titlebar_theme,
            titlebar::show_window_menu,
            titlebar::set_mica_effect,
            plugins::list_plugins,
            plugins::set_plugin_enabled,
            plugins::run_plugin_command,
            plugins::uninstall_plugin,
            plugins::install_plugin,
            plugins::open_plugin_dir,
            security::set_encryption,
            security::encryption_status,
            security::disable_encryption,
            security::lock_encryption,
            security::unlock_encryption,
            ai::ai_complete,
            ai::ai_probe,
            ai::ai_complete_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
