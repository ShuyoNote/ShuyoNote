use crate::db::{now_ms, Db};
use crate::models::AttachmentMeta;
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager, State};

#[derive(Clone, serde::Serialize)]
pub struct ImportProgress {
    pub index: usize,
    pub total: usize,
    pub name: String,
    pub done: u64,
    pub size: u64,
}

fn ext_from_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "application/pdf" => "pdf",
        _ => "bin",
    }
}

/// Map a file path to (mime, extension) for general file attachments.
fn mime_from_path(path: &Path) -> (String, String) {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "tar" | "gz" => "application/gzip",
        "7z" => "application/x-7z-compressed",
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "json" => "application/json",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "ts" => "text/plain",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    };
    // Keep the canonical extension for the stored filename (normalize jpeg -> jpg).
    let canonical = match ext.as_str() {
        "jpeg" => "jpg",
        "htm" => "html",
        "markdown" => "md",
        other => other,
    };
    (mime.to_string(), if canonical.is_empty() { "bin".to_string() } else { canonical.to_string() })
}

fn find_path_by_hash(dir: &Path, hash: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(stem) = name.split('.').next() {
            if stem == hash {
                return Some(entry.path());
            }
        }
    }
    None
}

/// Stream-copy `src` to `dst` while computing SHA-256, without loading the
/// whole file into memory. Returns (hex hash, byte size). Invokes `on_progress`
/// after each chunk with (bytes_done, total_bytes).
fn copy_and_hash<F: FnMut(u64, u64)>(
    src: &Path,
    dst: &Path,
    mut on_progress: F,
) -> Result<(String, i64), String> {
    let total = std::fs::metadata(src).map(|m| m.len()).unwrap_or(0);
    let mut input = std::fs::File::open(src)
        .map_err(|e| format!("无法打开 {}: {e}", src.display()))?;
    let mut output = std::fs::File::create(dst).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024]; // 1 MiB chunks
    let mut size: i64 = 0;
    loop {
        let n = std::io::Read::read(&mut input, &mut buf).map_err(|e| {
            let _ = std::fs::remove_file(dst);
            e.to_string()
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        std::io::Write::write_all(&mut output, &buf[..n]).map_err(|e| {
            let _ = std::fs::remove_file(dst);
            e.to_string()
        })?;
        size += n as i64;
        on_progress(size as u64, total);
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

#[derive(Deserialize)]
pub struct SaveImageArgs {
    pub page_id: Option<String>,
    pub name: Option<String>,
    pub mime: String,
    pub data: Vec<u8>,
}

/// Resolve a single attachment by id, including its on-disk path (for the
/// "file reference card" node, which shows a snapshot of metadata and can open
/// the file with the system default app).
#[tauri::command]
pub fn get_attachment(app: tauri::AppHandle, db: State<'_, Db>, id: String) -> Result<AttachmentMeta, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments");
    let c = db.0.lock().expect("db mutex poisoned");
    let (name, hash, mime, size): (String, String, String, i64) = c
        .query_row(
            "SELECT name, hash, mime, size FROM attachments WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|_| "附件不存在".to_string())?;
    let path = find_path_by_hash(&attachments_dir, &hash)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(AttachmentMeta { id, name, hash, mime, size, path })
}

#[tauri::command]
pub fn save_image(app: tauri::AppHandle, db: State<'_, Db>, args: SaveImageArgs) -> Result<AttachmentMeta, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments");
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

    // Content-addressed storage: filename = sha256 + extension.
    let mut hasher = Sha256::new();
    hasher.update(&args.data);
    let hash = format!("{:x}", hasher.finalize());
    let ext = ext_from_mime(&args.mime);
    let filename = format!("{hash}.{ext}");
    let path = attachments_dir.join(&filename);

    // Dedup: write only if not already present.
    if !path.exists() {
        std::fs::write(&path, &args.data).map_err(|e| e.to_string())?;
    }

    let c = db.0.lock().expect("db mutex poisoned");

    // Return existing row if already saved (dedup by hash).
    if let Some(existing) = c
        .query_row(
            "SELECT id, name, hash, mime, size FROM attachments WHERE hash = ?1",
            params![hash],
            |row| {
                Ok(AttachmentMeta {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    hash: row.get(2)?,
                    mime: row.get(3)?,
                    size: row.get(4)?,
                    path: String::new(),
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        return Ok(AttachmentMeta {
            path: path.to_string_lossy().into_owned(),
            ..existing
        });
    }

    let id = uuid::Uuid::new_v4().to_string();
    let name = args.name.unwrap_or_else(|| filename.clone());
    let size = args.data.len() as i64;
    c.execute(
        "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, args.page_id, name, hash, args.mime, size, now_ms()],
    )
    .map_err(|e| e.to_string())?;

    Ok(AttachmentMeta {
        id,
        name,
        hash,
        mime: args.mime,
        size,
        path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn attachment_path(app: tauri::AppHandle, hash: String) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir: PathBuf = app_data_dir.join("attachments");
    // Find the file by hash prefix (extension unknown here).
    let entries = std::fs::read_dir(&attachments_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(stem) = name.split('.').next() {
            if stem == hash {
                return Ok(entry.path().to_string_lossy().into_owned());
            }
        }
    }
    Err("附件不存在".to_string())
}

/// Copy an attachment (by hash) to a user-chosen destination path (download).
#[tauri::command]
pub fn copy_attachment(app: tauri::AppHandle, hash: String, dest_path: String) -> Result<(), String> {
    let src = attachment_path(app, hash)?;
    std::fs::copy(&src, &dest_path).map_err(|e| format!("复制失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn list_attachment_hashes(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir: PathBuf = app_data_dir.join("attachments");
    let mut hashes = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&attachments_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(stem) = name.split('.').next() {
                if !stem.is_empty() {
                    hashes.push(stem.to_string());
                }
            }
        }
    }
    hashes.sort();
    hashes.dedup();
    Ok(hashes)
}

#[tauri::command]
pub fn read_attachment_bytes(app: tauri::AppHandle, hash: String) -> Result<Vec<u8>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir: PathBuf = app_data_dir.join("attachments");
    let entries = std::fs::read_dir(&attachments_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(stem) = name.split('.').next() {
            if stem == hash {
                return std::fs::read(entry.path()).map_err(|e| e.to_string());
            }
        }
    }
    Err("附件不存在".to_string())
}

#[tauri::command]
pub fn write_attachment_bytes(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hash: String,
    mime: String,
    name: String,
    data: Vec<u8>,
) -> Result<AttachmentMeta, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments");
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

    let ext = ext_from_mime(&mime);
    let path = attachments_dir.join(format!("{hash}.{ext}"));
    if !path.exists() {
        std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    }

    let c = db.0.lock().expect("db mutex poisoned");
    let id = uuid::Uuid::new_v4().to_string();
    let size = data.len() as i64;
    c.execute(
        "INSERT OR IGNORE INTO attachments (id, page_id, name, hash, mime, size, created_at)
         VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, hash, mime, size, now_ms()],
    )
    .map_err(|e| e.to_string())?;

    Ok(AttachmentMeta {
        id,
        name,
        hash,
        mime,
        size,
        path: path.to_string_lossy().into_owned(),
    })
}

/// Import arbitrary files by their on-disk paths (streaming, content-addressed).
/// The file picker runs in the frontend; only the chosen paths cross the IPC
/// boundary, so arbitrarily large files never get serialized into memory.
#[tauri::command]
pub fn import_attachment_files(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    page_id: Option<String>,
    paths: Vec<String>,
) -> Result<Vec<AttachmentMeta>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments");
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

    let total_files = paths.len();
    let mut results = Vec::new();
    for (index, p) in paths.into_iter().enumerate() {
        let src = PathBuf::from(&p);
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".to_string());
        let (mime, ext) = mime_from_path(&src);

        let tmp = attachments_dir.join(format!("{}.part", uuid::Uuid::new_v4()));
        let app_progress = app.clone();
        let name_progress = name.clone();
        let (hash, size) = match copy_and_hash(&src, &tmp, move |done, total| {
            let _ = app_progress.emit(
                "attachment-import-progress",
                ImportProgress {
                    index,
                    total: total_files,
                    name: name_progress.clone(),
                    done,
                    size: total,
                },
            );
        }) {
            Ok(v) => v,
            Err(e) => return Err(e),
        };

        let final_path = attachments_dir.join(format!("{hash}.{ext}"));
        if final_path.exists() {
            // Content-addressed dedup: identical file already stored.
            let _ = std::fs::remove_file(&tmp);
        } else if let Err(e) = std::fs::rename(&tmp, &final_path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }

        let c = db.0.lock().expect("db mutex poisoned");
        let id = uuid::Uuid::new_v4().to_string();
        c.execute(
            "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, page_id, name, hash, mime, size, now_ms()],
        )
        .map_err(|e| e.to_string())?;

        results.push(AttachmentMeta {
            id,
            name,
            hash,
            mime,
            size,
            path: final_path.to_string_lossy().into_owned(),
        });
    }
    Ok(results)
}

#[tauri::command]
pub fn list_page_attachments(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    page_id: String,
) -> Result<Vec<AttachmentMeta>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments");

    let c = db.0.lock().expect("db mutex poisoned");
    let mut stmt = c
        .prepare(
            "SELECT id, name, hash, mime, size FROM attachments
             WHERE page_id = ?1 ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![page_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for r in rows {
        let (id, name, hash, mime, size) = r.map_err(|e| e.to_string())?;
        let path = find_path_by_hash(&attachments_dir, &hash)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        out.push(AttachmentMeta { id, name, hash, mime, size, path });
    }
    Ok(out)
}

#[tauri::command]
pub fn remove_attachment(app: tauri::AppHandle, db: State<'_, Db>, id: String) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments");

    let c = db.0.lock().expect("db mutex poisoned");
    let hash: Option<String> = c
        .query_row(
            "SELECT hash FROM attachments WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(hash) = hash else {
        return Ok(());
    };

    c.execute("DELETE FROM attachments WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;

    // Remove the on-disk file only when no other row references its hash.
    let count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM attachments WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if count == 0 {
        if let Some(p) = find_path_by_hash(&attachments_dir, &hash) {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(())
}

/// Move an attachment to another folder/page container (update its page_id).
#[tauri::command]
pub fn move_attachment(db: State<'_, Db>, id: String, new_page_id: String) -> Result<(), String> {
    let c = db.0.lock().expect("db mutex poisoned");
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pages WHERE id = ?1 AND deleted_at IS NULL)",
            params![new_page_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("目标文件夹不存在".to_string());
    }
    let n = c
        .execute(
            "UPDATE attachments SET page_id = ?1 WHERE id = ?2",
            params![new_page_id, id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("附件不存在".to_string());
    }
    Ok(())
}
