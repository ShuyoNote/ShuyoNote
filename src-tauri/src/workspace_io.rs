use crate::db::{now_ms, Db};
use crate::models::WorkspaceMeta;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager, State};

#[derive(Serialize)]
pub struct WorkspaceExportResult {
    pub path: String,
    pub size: i64,
    pub pages: usize,
    pub attachments: usize,
}

/// Progress for long-running workspace export/import.
#[derive(Clone, Serialize)]
pub struct WorkspaceProgress {
    pub phase: String,   // "export" | "import"
    pub done: usize,
    pub total: usize,
    pub bytes: u64,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct WorkspaceMetaFile {
    id: String,
    name: String,
    theme: String,
    icon: String,
}

// --- helpers ---

fn emit(
    app: &tauri::AppHandle,
    phase: &str,
    done: usize,
    total: usize,
    bytes: u64,
    message: &str,
) {
    let _ = app.emit(
        "workspace-progress",
        WorkspaceProgress {
            phase: phase.to_string(),
            done,
            total,
            bytes,
            message: message.to_string(),
        },
    );
}

/// Count files + total bytes under a directory (recursive).
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

/// Online-backup `src` into `dst` (WAL-safe).
fn backup_db(src: &Connection, dst: &Path) -> Result<(), String> {
    let mut dst_conn = Connection::open(dst).map_err(|e| e.to_string())?;
    let backup = rusqlite::backup::Backup::new(src, &mut dst_conn).map_err(|e| e.to_string())?;
    backup
        .run_to_completion(64, std::time::Duration::from_millis(5), None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Copy a file into zip streaming, reporting progress.
fn add_file_to_zip(
    zip: &mut zip::ZipWriter<std::fs::File>,
    name: &str,
    src: &Path,
    bytes: &mut u64,
) -> Result<(), String> {
    zip.start_file(name, zip::write::SimpleFileOptions::default())
        .map_err(|e| e.to_string())?;
    let mut f = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let copied = std::io::copy(&mut f, zip).map_err(|e| e.to_string())?;
    *bytes += copied;
    Ok(())
}

/// Export the current space (the one the main connection is on) to a self-contained
/// zip: `shuyonote.db` (space DB snapshot) + `attachments/<hash>.<ext>` for each
/// attachment the space's pages reference + `workspace.json` metadata.
#[tauri::command]
pub async fn export_workspace(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    dest_path: String,
) -> Result<WorkspaceExportResult, String> {
    // Collect the workspace metadata + the hashes referenced by this space.
    let (space, referenced_hashes) = {
        let c = db.0.lock().expect("db mutex poisoned");
        let active: String = crate::workspaces::active_workspace_id(&c)?;
        let (name, theme, icon): (String, String, String) = c
            .query_row(
                "SELECT name, COALESCE(theme,''), icon FROM meta.workspaces WHERE id = ?1",
                params![active],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|_| "工作空间不存在".to_string())?;
        // Distinct hashes used by this space's pages (incl. trash, so nothing is lost).
        let hashes: Vec<String> = c
            .prepare(
                "SELECT DISTINCT a.hash FROM attachments a
                 JOIN pages p ON p.id = a.page_id
                 WHERE p.workspace_id = ?1",
            )
            .map_err(|e| e.to_string())?
            .query_map(params![active], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        (
            WorkspaceMetaFile {
                id: active,
                name,
                theme,
                icon,
            },
            hashes,
        )
    };

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments");
    let dest = PathBuf::from(&dest_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Snapshot the space DB to a temp file (brief DB lock; online backup is WAL-safe).
    let tmp_db = std::env::temp_dir().join(format!("shuyonote-ws-{}.db", uuid::Uuid::new_v4()));
    {
        let conn = db.0.lock().expect("db mutex poisoned");
        backup_db(&conn, &tmp_db)?;
    }

    let app2 = app.clone();
    let attachments2 = attachments_dir;
    let dest2 = dest.clone();
    let tmp_db2 = tmp_db;
    let space2 = space.clone();
    let hashes2 = referenced_hashes.clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<WorkspaceExportResult, String> {
        let file = std::fs::File::create(&dest2).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        let mut bytes = 0u64;

        emit(&app2, "export", 0, 1, 0, "打包空间数据库…");
        add_file_to_zip(&mut zip, "shuyonote.db", &tmp_db2, &mut bytes)?;

        // workspace.json metadata.
        let meta_json = serde_json::to_string(&space2).map_err(|e| e.to_string())?;
        zip.start_file("workspace.json", opts).map_err(|e| e.to_string())?;
        bytes += std::io::Write::write(&mut zip, meta_json.as_bytes()).map_err(|e| e.to_string())? as u64;

        // Only the attachment bytes this space references (self-contained).
        let mut done = 0usize;
        let total = hashes2.len();
        let mut matched = 0usize;
        for hash in &hashes2 {
            let path = find_by_hash(&attachments2, hash);
            if let Some(p) = path {
                let fname = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                let name = format!("attachments/{fname}");
                emit(&app2, "export", done, total, bytes, "打包附件…");
                add_file_to_zip(&mut zip, &name, &p, &mut bytes)?;
                matched += 1;
            }
            done += 1;
        }

        let finished = zip.finish().map_err(|e| e.to_string())?;
        let size = finished.metadata().map_err(|e| e.to_string())?.len() as i64;
        emit(&app2, "export", total, total, bytes, "导出完成…");
        let _ = std::fs::remove_file(&tmp_db2);
        Ok(WorkspaceExportResult {
            path: dest2.to_string_lossy().into_owned(),
            size,
            pages: 0,
            attachments: matched,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Import a workspace from a self-contained zip produced by [`export_workspace`].
/// Creates a NEW workspace (never overwrites an existing one). Extracts the space
/// DB into `spaces/<id>.db`, copies referenced attachments into the global store,
/// and registers the workspace in meta.
#[tauri::command]
pub async fn import_workspace(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    src_path: String,
    name: Option<String>,
) -> Result<WorkspaceMeta, String> {
    let src = PathBuf::from(&src_path);
    if !src.exists() {
        return Err("空间包不存在".to_string());
    }

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments");
    let spaces_dir = app_data_dir.join("spaces");

    let tmp_dir = std::env::temp_dir().join(format!("shuyonote-wsin-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    // Extract zip off the main thread.
    let src2 = src.clone();
    let tmp_dir2 = tmp_dir.clone();
    let Extracted { db_snapshot, att_src_dir, meta_file } = tauri::async_runtime::spawn_blocking(move || {
        extract_workspace_zip(&src2, &tmp_dir2)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Decide a fresh workspace id (import never clobbers an existing space).
    let new_id = {
        let c = db.0.lock().expect("db mutex poisoned");
        let base = meta_file.as_ref().map(|m| m.id.clone()).filter(|i| !i.is_empty());
        let mut candidate = base.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        // Ensure uniqueness against meta.workspaces.
        loop {
            let exists: bool = c
                .query_row("SELECT EXISTS(SELECT 1 FROM meta.workspaces WHERE id = ?1)", params![candidate], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if !exists {
                break;
            }
            candidate = uuid::Uuid::new_v4().to_string();
        }
        candidate
    };

    let import_name = name
        .unwrap_or_else(|| meta_file.as_ref().map(|m| m.name.clone()).unwrap_or_else(|| "导入空间".to_string()));
    let import_name = import_name.trim();
    let import_name = if import_name.is_empty() { "导入空间".to_string() } else { import_name.to_string() };

    // Place the space DB at spaces/<id>.db.
    let target_db = spaces_dir.join(format!("{new_id}.db"));
    std::fs::create_dir_all(spaces_dir).map_err(|e| e.to_string())?;
    std::fs::copy(&db_snapshot, &target_db).map_err(|e| e.to_string())?;

    // Copy referenced attachment bytes into the global store (content-addressed,
    // skip bytes already present).
    let att_src = att_src_dir.map(|d| tmp_dir.join(d));
    let (files, _) = match &att_src {
        Some(d) if d.exists() => count_dir(d),
        _ => (0, 0),
    };
    let mut done = 0usize;
    let mut bytes = 0u64;
    if let Some(d) = &att_src {
        if d.exists() {
            copy_attachments_into_store(app.clone(), d, &attachments_dir, &mut done, &mut bytes).await?;
        }
    }

    // Register in meta.workspaces.
    let sort_order: f64 = {
        let c = db.0.lock().expect("db mutex poisoned");
        c.query_row(
            "SELECT COALESCE(MAX(sort_order),0) + 1 FROM meta.workspaces WHERE deleted_at IS NULL",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    };
    let theme = meta_file.as_ref().map(|m| m.theme.clone()).unwrap_or_else(|| "#3370FF".to_string());
    let icon = meta_file.as_ref().map(|m| m.icon.clone()).unwrap_or_default();
    let now = now_ms();
    {
        let c = db.0.lock().expect("db mutex poisoned");
        c.execute(
            "INSERT INTO meta.workspaces (id, name, theme, icon, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![new_id, import_name, theme, icon, sort_order, now, now],
        )
        .map_err(|e| e.to_string())?;
    }

    emit(&app, "import", files, files, bytes, "导入完成…");
    let _ = std::fs::remove_dir_all(&tmp_dir);

    // Return the new workspace metadata.
    let c = db.0.lock().expect("db mutex poisoned");
    c.query_row(
        "SELECT id,name,theme,icon,sort_order,created_at,updated_at FROM meta.workspaces WHERE id = ?1",
        params![new_id],
        |r| {
            Ok(WorkspaceMeta {
                id: r.get(0)?,
                name: r.get(1)?,
                theme: r.get::<_, Option<String>>(2)?,
                icon: r.get(3)?,
                sort_order: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

fn find_by_hash(dir: &Path, hash: &str) -> Option<PathBuf> {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.split('.').next() == Some(hash) {
                return Some(entry.path());
            }
        }
    }
    None
}

/// Join a zip entry name onto a base dir, refusing any entry that could escape
/// the base dir via `..`, an absolute path, a root, or a Windows drive prefix.
/// Zip entry names are attacker-controlled and must never be trusted verbatim —
/// a hostile zip can name an entry `attachments/../../evil` to write outside the
/// extraction dir (zip-slip).
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

struct Extracted {
    db_snapshot: PathBuf,
    att_src_dir: Option<String>,
    meta_file: Option<WorkspaceMetaFile>,
}

fn extract_workspace_zip(src: &Path, tmp_dir: &Path) -> Result<Extracted, String> {
    scan_workspace_zip(src, tmp_dir)
}

fn scan_workspace_zip(src: &Path, tmp_dir: &Path) -> Result<Extracted, String> {
    let file = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let total = zip.len();

    let mut db_snapshot: Option<PathBuf> = None;
    let mut att_src_dir: Option<String> = None;
    let mut meta_file: Option<WorkspaceMetaFile> = None;

    for i in 0..total {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let is_db = name == "shuyonote.db";
        let is_meta = name == "workspace.json";
        let is_att = name.starts_with("attachments/") && !name.ends_with('/');
        if !is_db && !is_meta && !is_att {
            continue;
        }
        let out_path = match safe_join(tmp_dir, &name) {
            Some(p) => p,
            None => return Err(format!("空间包包含非法路径条目: {name}")),
        };
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        if is_db {
            db_snapshot = Some(out_path);
        } else if is_meta {
            let mut s = String::new();
            std::io::Read::read_to_string(&mut std::fs::File::open(&out_path).map_err(|e| e.to_string())?, &mut s)
                .map_err(|e| e.to_string())?;
            meta_file = serde_json::from_str::<WorkspaceMetaFile>(&s).ok();
        } else {
            att_src_dir = Some("attachments".to_string());
        }
    }

    let db_snapshot = db_snapshot.ok_or_else(|| "空间包中缺少数据库文件".to_string())?;
    Ok(Extracted { db_snapshot, att_src_dir, meta_file })
}

async fn copy_attachments_into_store(
    app: tauri::AppHandle,
    src_dir: &Path,
    store_dir: &Path,
    done: &mut usize,
    bytes: &mut u64,
) -> Result<(), String> {
    std::fs::create_dir_all(store_dir).map_err(|e| e.to_string())?;
    let app2 = app.clone();
    let src2 = src_dir.to_path_buf();
    let store2 = store_dir.to_path_buf();
    let files = std::fs::read_dir(&src2)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect::<Vec<_>>();
    let total = files.len();
    let mut done_local = done.clone();
    let mut bytes_local = *bytes;
    tauri::async_runtime::spawn_blocking(move || -> Result<(usize, u64), String> {
        for path in files {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
            if let Some(name) = name {
                // Keep the content-addressed filename (<hash>.<ext>); skip if present.
                let dest = store2.join(name);
                if !dest.exists() {
                    std::fs::copy(&path, &dest).map_err(|e| e.to_string())?;
                    if let Ok(m) = std::fs::metadata(&dest) {
                        bytes_local += m.len();
                    }
                }
            }
            done_local += 1;
            emit(&app2, "import", done_local, total, bytes_local, "恢复附件…");
        }
        Ok((done_local, bytes_local))
    })
    .await
    .map_err(|e| e.to_string())??;
    *done = done_local;
    *bytes = bytes_local;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    #[test]
    fn extract_workspace_zip_parses_db_meta_att() {
        let tmp = std::env::temp_dir().join(format!("shuyonote-wsio-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let zip_path = tmp.join("ws.zip");
        {
            let f = File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("shuyonote.db", opts).unwrap();
            zip.write_all(b"SQLITE3[...]").unwrap();
            zip.start_file("workspace.json", opts).unwrap();
            zip.write_all(r##"{"id":"ws-a","name":"项目空间","theme":"#00B578","icon":"star"}"##.as_bytes()).unwrap();
            zip.start_file("attachments/abc123.png", opts).unwrap();
            zip.write_all(b"PNGDATA").unwrap();
            zip.finish().unwrap();
        }

        let out = std::env::temp_dir().join(format!("shuyonote-wsio-out-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&out);
        let ex = scan_workspace_zip(&zip_path, &out).unwrap();
        assert_eq!(ex.db_snapshot.file_name().unwrap(), "shuyonote.db");
        assert_eq!(ex.att_src_dir.as_deref(), Some("attachments"));
        let mf = ex.meta_file.unwrap();
        assert_eq!(mf.id, "ws-a");
        assert_eq!(mf.name, "项目空间");
        assert_eq!(mf.theme, "#00B578");
        assert!(out.join("attachments/abc123.png").exists());

        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_dir_all(&out);
    }

    // The export query must collect ONLY the hashes referenced by the space's pages.
    #[test]
    fn export_hash_query_scopes_to_space() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        crate::db::migrate(&conn, "ws-a").unwrap();
        conn.execute(
            "INSERT INTO pages (id,workspace_id,title,created_at,updated_at) VALUES ('p1','ws-a','t',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments (id,page_id,name,hash,mime,size,created_at) VALUES ('a1','p1','x.png','h1','image/png',1,1)",
            [],
        )
        .unwrap();
        // A second space's attachment row in a separate DB; here we simply verify scoping.
        conn.execute("INSERT INTO workspaces (id,name,created_at,updated_at) VALUES ('ws-b','b',1,1)", [])
            .unwrap();
        conn.execute(
            "INSERT INTO pages (id,workspace_id,title,created_at,updated_at) VALUES ('p2','ws-b','t',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments (id,page_id,name,hash,mime,size,created_at) VALUES ('a2','p2','y.png','h2','image/png',1,1)",
            [],
        )
        .unwrap();

        let hashes: Vec<String> = conn
            .prepare(
                "SELECT DISTINCT a.hash FROM attachments a
                 JOIN pages p ON p.id = a.page_id
                 WHERE p.workspace_id = ?1",
            )
            .unwrap()
            .query_map(params!["ws-a"], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(hashes, vec!["h1".to_string()]);
    }
}
