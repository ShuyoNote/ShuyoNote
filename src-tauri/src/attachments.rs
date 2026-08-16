use crate::db::{now_ms, Db};
use crate::models::AttachmentMeta;
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
use serde::Deserialize;
use std::path::PathBuf;
use tauri::{Manager, State};

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

#[derive(Deserialize)]
pub struct SaveImageArgs {
    pub page_id: Option<String>,
    pub name: Option<String>,
    pub mime: String,
    pub data: Vec<u8>,
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
