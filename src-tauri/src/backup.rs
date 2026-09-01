use crate::db::Db;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager, State};

#[derive(Serialize)]
pub struct BackupResult {
    pub path: String,
    pub size: i64,
}

/// Result of a merge import: how many spaces were imported, and how many had an
/// id collision and were re-imported under a fresh id (never overwritten).
#[derive(Serialize)]
pub struct ImportSummary {
    pub imported: usize,
    pub renamed: usize,
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
    _db: State<'_, Db>,
    dest_path: String,
) -> Result<BackupResult, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments");
    let spaces_dir = crate::db::spaces_dir(&app_data_dir);
    let meta_file = crate::db::meta_path(&app_data_dir);
    let dest = PathBuf::from(&dest_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Stage a compact snapshot of meta.db + every per-space DB in a temp dir, then
    // stream them all into one zip. Online snapshotting is WAL-safe and holds each
    // source connection only briefly, so the live app keeps working throughout.
    let tmp_root = std::env::temp_dir().join(format!("shuyonote-export-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(tmp_root.join("spaces")).map_err(|e| e.to_string())?;

    let tmp_meta = tmp_root.join("meta.db");
    {
        let meta_conn = rusqlite::Connection::open(&meta_file).map_err(|e| e.to_string())?;
        backup_db(&meta_conn, &tmp_meta)?;
    }

    let mut space_snapshots: Vec<(String, PathBuf)> = Vec::new();
    if spaces_dir.exists() {
        for entry in std::fs::read_dir(&spaces_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".db") {
                let id = name.trim_end_matches(".db").to_string();
                let out = tmp_root.join("spaces").join(&name);
                let path = crate::db::space_db_path(&app_data_dir, &id);
                let conn = rusqlite::Connection::open(&path).map_err(|e| e.to_string())?;
                // E1: key the connection if this space's DB is SQLCipher-encrypted.
                // An encrypted space can't be read without the session key, so skip
                // it (with a log) rather than writing a corrupt/empty snapshot.
                if let Err(e) = crate::security::key_space_conn(&conn, &path) {
                    eprintln!("备份跳过加密空间 {id}: {e}");
                    continue;
                }
                backup_db(&conn, &out)?;
                space_snapshots.push((id, out));
            }
        }
    }

    let app2 = app.clone();
    let attachments2 = attachments_dir;
    let dest2 = dest.clone();
    let tmp_root2 = tmp_root.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<BackupResult, String> {
        let file = std::fs::File::create(&dest2).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();

        // meta.db first.
        zip.start_file("meta.db", opts).map_err(|e| e.to_string())?;
        let mut mf = std::fs::File::open(tmp_root2.join("meta.db")).map_err(|e| e.to_string())?;
        std::io::copy(&mut mf, &mut zip).map_err(|e| e.to_string())?;

        // Then every per-space DB.
        for (id, sf) in &space_snapshots {
            zip.start_file(format!("spaces/{id}.db"), opts).map_err(|e| e.to_string())?;
            let mut s = std::fs::File::open(sf).map_err(|e| e.to_string())?;
            std::io::copy(&mut s, &mut zip).map_err(|e| e.to_string())?;
        }

        // Then all attachments (content-addressed).
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
        let _ = std::fs::remove_dir_all(&tmp_root2);
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
/// Join a zip entry name onto a base dir, refusing entries that could escape via
/// `..`, absolute paths, roots, or Windows drive prefixes (zip-slip protection).
fn safe_join(base: &Path, name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    if p.is_absolute()
        || p.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return None;
    }
    Some(base.join(p))
}

/// A workspace id parsed from a zip entry name must be a single safe path
/// component (no separators, no `..`), since it is later joined into
/// `spaces/<id>.db`.
fn safe_space_id(id: &str) -> bool {
    !id.is_empty()
        && !id.contains('/')
        && !id.contains('\\')
        && id != "."
        && id != ".."
        && !id.contains('\0')
}

/// Extract a backup zip into a temp dir, streaming each entry (bounded memory)
/// and emitting progress. Accepts the full-library layout (`meta.db` +
/// `spaces/<id>.db` + `attachments/*`) and the legacy single-space layout
/// (`shuyonote.db` + `attachments/*`). Returns (meta snapshot option, a list of
/// (snapshot path, space id), attachments src dir option).
fn extract_full_backup(
    app: &tauri::AppHandle,
    src: &Path,
    tmp_dir: &Path,
) -> Result<(Option<PathBuf>, Vec<(PathBuf, String)>, Option<PathBuf>), String> {
    std::fs::create_dir_all(tmp_dir).map_err(|e| e.to_string())?;
    let file = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let total = zip.len();
    let mut done = 0usize;

    let mut meta_snap: Option<PathBuf> = None;
    let mut space_snaps: Vec<(PathBuf, String)> = Vec::new();
    let mut attachments_src: Option<PathBuf> = None;

    for i in 0..total {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let is_meta = name == "meta.db";
        let is_space = name.starts_with("spaces/") && name.ends_with(".db");
        let is_legacy = name == "shuyonote.db";
        let is_att = name.starts_with("attachments/") && !name.ends_with('/');
        if !(is_meta || is_space || is_legacy || is_att) {
            continue;
        }
        let out_path = match safe_join(tmp_dir, &name) {
            Some(p) => p,
            None => {
                eprintln!("backup zip rejected path entry: {name}");
                continue;
            }
        };
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
        if is_meta {
            meta_snap = Some(out_path);
        } else if is_space {
            let id = name.trim_start_matches("spaces/").trim_end_matches(".db").to_string();
            if !safe_space_id(&id) {
                eprintln!("backup zip rejected space id: {id}");
                continue;
            }
            space_snaps.push((out_path, id));
        } else if is_legacy {
            space_snaps.push((out_path, "__legacy__".to_string()));
        } else {
            attachments_src = Some(tmp_dir.join("attachments"));
        }
    }
    Ok((meta_snap, space_snaps, attachments_src))
}

/// Read the space's display name / theme / icon from its own `workspaces` row.
fn read_workspace_meta(conn: &rusqlite::Connection) -> Result<(String, String, String), String> {
    let (name, theme, icon): (String, String, String) = conn
        .query_row(
            "SELECT name, COALESCE(theme,''), COALESCE(icon,'') FROM workspaces ORDER BY created_at ASC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| e.to_string())?;
    Ok((name, theme, icon))
}

/// Whether a space with `id` already exists on disk or in meta (collision check).
fn space_exists(spaces_dir: &Path, meta_file: &Path, id: &str) -> Result<bool, String> {
    if spaces_dir.join(format!("{id}.db")).exists() {
        return Ok(true);
    }
    let meta_conn = rusqlite::Connection::open(meta_file).map_err(|e| e.to_string())?;
    let n: i64 = meta_conn
        .query_row("SELECT COUNT(*) FROM workspaces WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Re-point an imported space DB's own `workspaces` row to `id`.
fn rekey_workspace(conn: &rusqlite::Connection, id: &str, name: &str, theme: &str, icon: &str) -> Result<(), String> {
    let now = crate::db::now_ms();
    conn.execute("DELETE FROM workspaces", []).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO workspaces (id, name, theme, icon, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6)",
        rusqlite::params![id, name, theme, icon, now, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Register the imported space in meta.workspaces so it shows up in the sidebar.
fn register_space(meta_file: &Path, id: &str, name: &str, theme: &str, icon: &str) -> Result<(), String> {
    let meta_conn = rusqlite::Connection::open(meta_file).map_err(|e| e.to_string())?;
    let now = crate::db::now_ms();
    let max: f64 = meta_conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order),0) FROM workspaces WHERE deleted_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    meta_conn
        .execute(
            "INSERT INTO workspaces (id, name, theme, icon, sort_order, created_at, updated_at, deleted_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,NULL)",
            rusqlite::params![id, name, theme, icon, max + 1.0, now, now],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Merge a source directory into `dst`, copying only files missing at `dst`.
/// Attachments are content-addressed, so a same-named file is the same bytes.
fn merge_dir(src: &Path, dst: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            std::fs::create_dir_all(&to).map_err(|e| e.to_string())?;
            merge_dir(&from, &to)?;
        } else if from.is_file() && !to.exists() {
            std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn import_backup(
    app: tauri::AppHandle,
    _db: State<'_, Db>,
    src_path: String,
) -> Result<ImportSummary, String> {
    let src = PathBuf::from(&src_path);
    if !src.exists() {
        return Err("备份文件不存在".to_string());
    }

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let spaces_dir = crate::db::spaces_dir(&app_data_dir);
    let attachments_dir = app_data_dir.join("attachments");
    let meta_file = crate::db::meta_path(&app_data_dir);
    std::fs::create_dir_all(&spaces_dir).map_err(|e| e.to_string())?;

    let tmp_dir = std::env::temp_dir().join(format!("shuyonote-restore-{}", uuid::Uuid::new_v4()));
    let app2 = app.clone();
    let tmp2 = tmp_dir.clone();
    let src2 = src.clone();
    let (_meta_snap, space_snaps, att_src) = tauri::async_runtime::spawn_blocking(move || {
        extract_full_backup(&app2, &src2, &tmp2)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Merge each space as a fresh, never-clobbering import: if the id already
    // exists on disk / in meta, re-import it under a new id so nothing is lost.
    let mut imported = 0usize;
    let mut renamed = 0usize;
    for (snap, orig_id) in &space_snaps {
        let (name, theme, icon) = {
            let c = rusqlite::Connection::open(snap).map_err(|e| e.to_string())?;
            // E1: key the snapshot if it's an encrypted space DB — restoring an
            // encrypted space requires an unlocked session with the matching key.
            if let Err(e) = crate::security::key_space_conn(&c, snap) {
                return Err(format!("恢复加密空间 {orig_id} 需要先解锁: {e}"));
            }
            read_workspace_meta(&c)?
        };
        let target_id = if space_exists(&spaces_dir, &meta_file, orig_id)? {
            renamed += 1;
            uuid::Uuid::new_v4().to_string()
        } else {
            orig_id.clone()
        };
        let target = crate::db::space_db_path(&app_data_dir, &target_id);
        std::fs::copy(snap, &target).map_err(|e| e.to_string())?;
        {
            let c = rusqlite::Connection::open(&target).map_err(|e| e.to_string())?;
            if let Err(e) = crate::security::key_space_conn(&c, &target) {
                return Err(format!("恢复加密空间失败: {e}"));
            }
            rekey_workspace(&c, &target_id, &name, &theme, &icon)?;
        }
        register_space(&meta_file, &target_id, &name, &theme, &icon)?;
        imported += 1;
    }
    // meta.db snapshot is intentionally NOT overwritten: it carries cross-space
    // state (active id / device_id) we must not clobber during a merge import.

    // Merge attachments (content-addressed; only copy missing hashes).
    let app3 = app.clone();
    let att_dir = attachments_dir;
    let tmp3 = tmp_dir;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _ = app3.emit(
            "backup-progress",
            BackupProgress {
                phase: "import".to_string(),
                done: 0,
                total: 1,
                bytes: 0,
                message: "合并附件…".to_string(),
            },
        );
        if let Some(att) = att_src {
            if att.exists() {
                std::fs::create_dir_all(&att_dir).map_err(|e| e.to_string())?;
                merge_dir(&att, &att_dir)?;
            }
        }
        let _ = std::fs::remove_dir_all(&tmp3);
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

    Ok(ImportSummary { imported, renamed })
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
