use crate::db::Db;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{Manager, State};

#[derive(Serialize)]
pub struct BackupResult {
    pub path: String,
    pub size: i64,
}

// Create a consistent snapshot of the SQLite database via rusqlite's
// online backup API, then zip it together with the attachments directory.
fn backup_db(src: &rusqlite::Connection, dst: &Path) -> Result<(), String> {
    let mut dst_conn = rusqlite::Connection::open(dst).map_err(|e| e.to_string())?;
    let backup = rusqlite::backup::Backup::new(src, &mut dst_conn).map_err(|e| e.to_string())?;
    backup
        .run_to_completion(64, std::time::Duration::from_millis(5), None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn add_dir_to_zip(
    zip: &mut zip::ZipWriter<std::fs::File>,
    base: &Path,
    dir: &Path,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let rel = path.strip_prefix(base).map_err(|e| e.to_string())?;
        let name = rel.to_string_lossy().replace('\\', "/");
        if path.is_dir() {
            zip.add_directory(format!("{name}/"), zip::write::SimpleFileOptions::default())
                .map_err(|e| e.to_string())?;
            add_dir_to_zip(zip, base, &path)?;
        } else if path.is_file() {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .map_err(|e| e.to_string())?;
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn export_backup(app: tauri::AppHandle, db: State<'_, Db>, dest_path: String) -> Result<BackupResult, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments");

    let dest = PathBuf::from(&dest_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Snapshot db to a temp file (consistent even under WAL).
    let tmp_db = std::env::temp_dir().join(format!("shuyonote-backup-{}.db", uuid::Uuid::new_v4()));
    {
        let conn = db.0.lock().expect("db mutex poisoned");
        backup_db(&conn, &tmp_db)?;
    }

    let file = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default();

    // Add database snapshot.
    zip.start_file("shuyonote.db", opts).map_err(|e| e.to_string())?;
    let db_bytes = std::fs::read(&tmp_db).map_err(|e| e.to_string())?;
    zip.write_all(&db_bytes).map_err(|e| e.to_string())?;

    // Add attachments directory.
    if attachments_dir.exists() {
        add_dir_to_zip(&mut zip, &attachments_dir, &attachments_dir)?;
    }

    let finished = zip.finish().map_err(|e| e.to_string())?;
    let size = finished.metadata().map_err(|e| e.to_string())?.len() as i64;

    // Clean up temp snapshot.
    let _ = std::fs::remove_file(&tmp_db);

    Ok(BackupResult {
        path: dest.to_string_lossy().into_owned(),
        size,
    })
}
