use crate::db::Db;
use serde::Serialize;
use std::io::{Read, Write};
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

// Restore the database from a backup snapshot into the live connection.
fn restore_db(dst: &mut rusqlite::Connection, src: &Path) -> Result<(), String> {
    let src_conn = rusqlite::Connection::open(src).map_err(|e| e.to_string())?;
    let backup = rusqlite::backup::Backup::new(&src_conn, dst).map_err(|e| e.to_string())?;
    backup
        .run_to_completion(64, std::time::Duration::from_millis(5), None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

// Recursively copy a directory tree.
fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let entries = std::fs::read_dir(src).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir(&from, &to)?;
        } else if from.is_file() {
            std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn import_backup(app: tauri::AppHandle, db: State<'_, Db>, src_path: String) -> Result<(), String> {    let src = PathBuf::from(&src_path);
    if !src.exists() {
        return Err("备份文件不存在".to_string());
    }

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments");

    // Extract the zip into a temp dir.
    let tmp_dir = std::env::temp_dir().join(format!("shuyonote-restore-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    let file = std::fs::File::open(&src).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    let mut db_snapshot: Option<PathBuf> = None;
    let mut attachments_src: Option<PathBuf> = None;

    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let out_path = tmp_dir.join(&name);
        if name == "shuyonote.db" {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            std::fs::write(&out_path, &bytes).map_err(|e| e.to_string())?;
            db_snapshot = Some(out_path);
        } else if name.starts_with("attachments/") && !name.ends_with('/') {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            std::fs::write(&out_path, &bytes).map_err(|e| e.to_string())?;
            attachments_src = Some(tmp_dir.join("attachments"));
        }
    }

    let db_snapshot = db_snapshot.ok_or_else(|| "备份中缺少数据库文件".to_string())?;

    // Restore database into live connection.
    {
        let mut conn = db.0.lock().expect("db mutex poisoned");
        restore_db(&mut conn, &db_snapshot)?;
    }

    // Restore attachments directory.
    if let Some(att) = attachments_src {
        if att.exists() {
            // Clear existing attachments dir, then copy over.
            if attachments_dir.exists() {
                std::fs::remove_dir_all(&attachments_dir).map_err(|e| e.to_string())?;
            }
            copy_dir(&att, &attachments_dir)?;
        }
    }

    // Clean up temp dir.
    let _ = std::fs::remove_dir_all(&tmp_dir);

    Ok(())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}
