use crate::db::Db;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager, State};

#[derive(Serialize)]
pub struct BackupResult {
    pub path: String,
    pub size: i64,
}

/// Progress emitted during export/import so the UI can show a live bar (the
/// work is genuinely long-running; the old sync command froze the UI thread).
#[derive(Clone, Serialize)]
pub struct BackupProgress {
    pub phase: String,     // "export" | "import"
    pub done: usize,       // files processed so far
    pub total: usize,      // total files
    pub bytes: u64,        // bytes processed
    pub message: String,   // human-readable stage label
}

// Create a consistent snapshot of the SQLite database via rusqlite's online
// backup API (safe under WAL), then zip it with the attachments directory.
fn backup_db(src: &rusqlite::Connection, dst: &Path) -> Result<(), String> {
    let mut dst_conn = rusqlite::Connection::open(dst).map_err(|e| e.to_string())?;
    let backup = rusqlite::backup::Backup::new(src, &mut dst_conn).map_err(|e| e.to_string())?;
    backup
        .run_to_completion(64, std::time::Duration::from_millis(5), None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

// Count files + total bytes under a directory (recursive), for progress.
fn count_dir(dir: &Path) -> (usize, u64) {
    let mut n = 0usize;
    let mut b = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let (dn, db) = count_dir(&p);
                n += dn;
                b += db;
            } else if p.is_file() {
                n += 1;
                b += std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    (n, b)
}

/// Stream-copy files into the zip (bounded memory) and emit progress.
fn add_dir_to_zip(
    zip: &mut zip::ZipWriter<std::fs::File>,
    base: &Path,
    dir: &Path,
    app: &tauri::AppHandle,
    done: &mut usize,
    bytes: &mut u64,
    total: usize,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let rel = path.strip_prefix(base).map_err(|e| e.to_string())?;
        let name = rel.to_string_lossy().replace('\\', "/");
        if path.is_dir() {
            zip.add_directory(format!("{name}/"), zip::write::SimpleFileOptions::default())
                .map_err(|e| e.to_string())?;
            add_dir_to_zip(zip, base, &path, app, done, bytes, total)?;
        } else if path.is_file() {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .map_err(|e| e.to_string())?;
            let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
            let copied = std::io::copy(&mut f, zip).map_err(|e| e.to_string())?;
            *bytes += copied;
            *done += 1;
            // Throttle emits (every file).
            let _ = app.emit(
                "backup-progress",
                BackupProgress {
                    phase: "export".to_string(),
                    done: *done,
                    total,
                    bytes: *bytes,
                    message: "打包附件…".to_string(),
                },
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn export_backup(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    dest_path: String,
) -> Result<BackupResult, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments");
    let dest = PathBuf::from(&dest_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Snapshot the DB to a temp file (brief DB lock; online backup is WAL-safe).
    let tmp_db = std::env::temp_dir().join(format!("shuyonote-backup-{}.db", uuid::Uuid::new_v4()));
    {
        let conn = db.0.lock().expect("db mutex poisoned");
        backup_db(&conn, &tmp_db)?;
    }

    let app2 = app.clone();
    let attachments2 = attachments_dir;
    let dest2 = dest.clone();
    let tmp_db2 = tmp_db;
    tauri::async_runtime::spawn_blocking(move || -> Result<BackupResult, String> {
        let file = std::fs::File::create(&dest2).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();

        // Add the DB snapshot (streaming).
        zip.start_file("shuyonote.db", opts).map_err(|e| e.to_string())?;
        let mut f = std::fs::File::open(&tmp_db2).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;

        let (total_files, total_bytes) = count_dir(&attachments2);
        let _ = app2.emit(
            "backup-progress",
            BackupProgress {
                phase: "export".to_string(),
                done: 0,
                total: total_files,
                bytes: 0,
                message: "开始打包附件…".to_string(),
            },
        );

        let mut done = 0usize;
        let mut bytes = 0u64;
        if attachments2.exists() {
            add_dir_to_zip(&mut zip, &attachments2, &attachments2, &app2, &mut done, &mut bytes, total_files)?;
        }

        let _ = app2.emit(
            "backup-progress",
            BackupProgress {
                phase: "export".to_string(),
                done,
                total: total_files,
                bytes,
                message: "压缩完成…".to_string(),
            },
        );
        let finished = zip.finish().map_err(|e| e.to_string())?;
        let size = finished.metadata().map_err(|e| e.to_string())?.len() as i64;
        let _ = std::fs::remove_file(&tmp_db2);
        let _ = total_bytes;
        Ok(BackupResult {
            path: dest2.to_string_lossy().into_owned(),
            size,
        })
    })
    .await
    .map_err(|e| e.to_string())?
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

/// Extract a backup zip into a temp dir, streaming each entry (bounded memory)
/// and emitting progress. Returns (db snapshot path, attachments src dir).
fn extract_backup(
    app: &tauri::AppHandle,
    src: &Path,
    tmp_dir: &Path,
) -> Result<(PathBuf, Option<PathBuf>), String> {
    std::fs::create_dir_all(tmp_dir).map_err(|e| e.to_string())?;
    let file = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let total = zip.len();
    let mut done = 0usize;

    let mut db_snapshot: Option<PathBuf> = None;
    let mut attachments_src: Option<PathBuf> = None;

    for i in 0..total {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let out_path = tmp_dir.join(&name);
        if name == "shuyonote.db" || (name.starts_with("attachments/") && !name.ends_with('/')) {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            done += 1;
            let _ = app.emit(
                "backup-progress",
                BackupProgress {
                    phase: "import".to_string(),
                    done,
                    total,
                    bytes: 0,
                    message: "解包备份…".to_string(),
                },
            );
            if name == "shuyonote.db" {
                db_snapshot = Some(out_path);
            } else {
                attachments_src = Some(tmp_dir.join("attachments"));
            }
        }
    }

    let db_snapshot = db_snapshot.ok_or_else(|| "备份中缺少数据库文件".to_string())?;
    Ok((db_snapshot, attachments_src))
}

#[tauri::command]
pub async fn import_backup(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    src_path: String,
) -> Result<(), String> {
    let src = PathBuf::from(&src_path);
    if !src.exists() {
        return Err("备份文件不存在".to_string());
    }

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments");

    let tmp_dir = std::env::temp_dir().join(format!("shuyonote-restore-{}", uuid::Uuid::new_v4()));

    // Extract zip off the main thread (no DB needed).
    let app2 = app.clone();
    let tmp_dir2 = tmp_dir.clone();
    let src2 = src.clone();
    let (db_snapshot, attachments_src) = tauri::async_runtime::spawn_blocking(move || {
        extract_backup(&app2, &src2, &tmp_dir2)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Restore the database into the live connection (brief DB lock).
    {
        let mut conn = db.0.lock().expect("db mutex poisoned");
        restore_db(&mut conn, &db_snapshot)?;
    }

    // Restore attachments (streaming copy, off the main thread).
    let app3 = app.clone();
    let att_dir = attachments_dir;
    let tmp_dir3 = tmp_dir;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _ = app3.emit(
            "backup-progress",
            BackupProgress {
                phase: "import".to_string(),
                done: 0,
                total: 1,
                bytes: 0,
                message: "恢复附件…".to_string(),
            },
        );
        if let Some(att) = attachments_src {
            if att.exists() {
                if att_dir.exists() {
                    std::fs::remove_dir_all(&att_dir).map_err(|e| e.to_string())?;
                }
                copy_dir(&att, &att_dir)?;
            }
        }
        let _ = std::fs::remove_dir_all(&tmp_dir3);
        let _ = app3.emit(
            "backup-progress",
            BackupProgress {
                phase: "import".to_string(),
                done: 1,
                total: 1,
                bytes: 0,
                message: "恢复完成…".to_string(),
            },
        );
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}
