mod attachments;
mod backlinks;
mod backup;
mod commands;
mod db;
mod models;
mod search;
mod sync;
mod tags;
mod trash;
mod versions;

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_pages,
            commands::get_page,
            commands::create_page,
            commands::create_folder,
            commands::save_page,
            commands::delete_page,
            commands::move_page,
            search::search,
            sync::get_sync_config,
            sync::set_sync_config,
            sync::sync_now,
            attachments::save_image,
            attachments::attachment_path,
            attachments::list_attachment_hashes,
            attachments::read_attachment_bytes,
            attachments::write_attachment_bytes,
            backlinks::get_backlinks,
            tags::list_tags,
            tags::page_tags,
            tags::add_tag,
            tags::remove_tag,
            tags::pages_by_tag,
            tags::board_data,
            tags::move_card,
            trash::list_deleted,
            trash::restore_page,
            trash::purge_page,
            versions::list_versions,
            versions::restore_version,
            backup::export_backup,
            backup::import_backup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
