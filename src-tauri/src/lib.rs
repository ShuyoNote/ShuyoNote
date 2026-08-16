mod commands;
mod db;
mod models;
mod search;
mod sync;

use db::Db;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            commands::save_page,
            commands::delete_page,
            commands::move_page,
            search::search,
            sync::get_sync_config,
            sync::set_sync_config,
            sync::sync_now,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
