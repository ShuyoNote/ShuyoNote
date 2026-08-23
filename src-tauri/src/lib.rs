mod attachments;
mod backlinks;
mod backup;
mod blocks;
mod commands;
mod crypto;
mod database;
mod db;
mod graph;
mod models;
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
mod workspaces;

use db::Db;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let conn = db::init(app_data_dir).map_err(|e| {
                eprintln!("failed to init db: {e}");
                std::io::Error::other(e.to_string())
            })?;
            app.manage(Db(Mutex::new(conn)));
            // Seed a bundled demo plugin so the plugin system has something to load.
            let _ = plugins::ensure_demo_plugin(&app.handle());

            // Title bar shows both product names + the live build version, so it
            // never drifts from the packaged version on a new release.
            let version = app.package_info().version.to_string();
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_title(&format!("ShuyoNote 数友笔记 · v{version}"));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_pages,
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
            attachments::remove_attachment,
            attachments::move_attachment,
            attachments::get_attachment,
            attachments::restore_attachment,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
