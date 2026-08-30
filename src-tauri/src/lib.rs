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
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let conn = db::init(app_data_dir).map_err(|e| {
                eprintln!("failed to init db: {e}");
                std::io::Error::other(e.to_string())
            })?;
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
