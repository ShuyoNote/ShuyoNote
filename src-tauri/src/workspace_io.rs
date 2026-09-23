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

/// Online-backup `src` into `dst` (WAL-safe)，**目标可选加同一把钥**。
///
/// ⚠️⚠️ 为什么要"可选加钥"（2026-09-20 实测，修 F2）：SQLCipher 的在线备份 API
/// **要求目标也加同一把钥** —— 源加钥、目标**不加钥**时报
/// `backup is not supported with encrypted databases`；两边同钥才成功（产物是**密文**）。
///
/// ⚠️⚠️ 目标端必须走 `key_conn_with`（生产口径，带库级国密参数）—— 备份 API 按**目标连接的 codec**
/// 重新加密页面，只写裸 `PRAGMA key` 会产出"默认参数（SHA512）"的快照，而本模块下一步
/// `convert_space_db(dst, false, k)` 是用国密参数去读它的 ⇒ 接线构建里当场红
/// （2026-09-22 实测：`snapshot_plaintext_from_an_encrypted_source_is_readable_without_a_key`）。
fn backup_db_to(src: &Connection, dst: &Path, key: Option<&[u8; 32]>) -> Result<(), String> {
    let mut dst_conn = Connection::open(dst).map_err(|e| e.to_string())?;
    if let Some(k) = key {
        crate::security::key_conn_with(&dst_conn, k)?;
    }
    let backup = rusqlite::backup::Backup::new(src, &mut dst_conn).map_err(|e| e.to_string())?;
    backup
        .run_to_completion(64, std::time::Duration::from_millis(5), None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 把 `src` 的**明文**快照写到 `dst`（本模块的契约：zip 里那份 `shuyonote.db` 是明文，
/// `import_workspace` 正是按 "imported plaintext DB" 写的）。
///
/// 加密态下走**两步**（不改变契约、只用仓库已有机制）：
///   ① 先按"目标同钥"做一次 WAL 安全的**密文**快照（原先这一步就是失败的）；
///   ② 把这份密文快照搬到 `dst`，再用 `security::convert_space_db(..., false, key)`
///      **就地解密**成明文 —— 复用它既有的"先校验可读、再原子上换、失败恢复原库"流程
///      （⚠️ 它是**就地**转换：明文落在传入的那个路径上，所以必须先 copy 到 `dst` 再转，
///      否则解密结果会落在中转文件上、`dst` 根本不存在）。
fn snapshot_plaintext(src: &Connection, key: Option<&[u8; 32]>, dst: &Path) -> Result<(), String> {
    if let Some(k) = key {
        let mid = crate::tempdir::file("shuyonote-ws-keyed", "db");
        backup_db_to(src, &mid, Some(k))?;
        std::fs::copy(&mid, dst).map_err(|e| format!("中转快照落盘失败: {e}"))?;
        let _ = std::fs::remove_file(&mid);
        crate::security::convert_space_db(dst, false, Some(k))?;
    } else {
        backup_db_to(src, dst, None)?;
    }
    // ★ 契约自检：走到这里 `dst` 必须是**不加任何 PRAGMA key 就能打开、且有真实 schema**
    // 的明文库（zip 成员 `shuyonote.db` 的契约，`import_workspace` 按明文读）。这一句是
    // "加密态导出"最容易悄悄坏掉的地方：一旦它变成密文、或者根本没写出来，
    // 导入端就要么报错、要么把密文当明文读进去 —— 两种都不该等到用户导数据时才发现。
    // （注意：**不能**只靠"打开成功"判断 —— `Connection::open` 会把不存在的文件建成
    //  空库，空的明文库也能 `SELECT COUNT(*) FROM sqlite_master` 并返回 0。）
    if !dst.exists() || std::fs::metadata(dst).map(|m| m.len()).unwrap_or(0) == 0 {
        return Err("导出快照为空（明文快照没有写出来）".to_string());
    }
    if crate::security::space_db_is_encrypted(dst) {
        return Err("导出快照是密文（导出契约要求明文库）".to_string());
    }
    let vc = Connection::open(dst).map_err(|e| format!("导出快照不可打开: {e}"))?;
    let n: i64 = vc
        .query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get(0))
        .map_err(|e| format!("导出快照不是明文库（导出契约要求明文）: {e}"))?;
    if n == 0 {
        return Err("导出快照里没有任何表（快照不完整）".to_string());
    }
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
        // Distinct hashes used by this space's pages (incl. trash, so nothing is lost)
        // PLUS「未整理」的无归属附件（`page_id IS NULL`，空间根下直接上传的文件）。
        // 用 LEFT JOIN 而不是 INNER JOIN：内连接会把根文件整个漏掉，导致
        // 「导出空间 → 导入到别处」静默丢文件（表里有行、zip 里没字节）。
        let hashes: Vec<String> = c
            .prepare(
                "SELECT DISTINCT a.hash FROM attachments a
                 LEFT JOIN pages p ON p.id = a.page_id
                 WHERE a.page_id IS NULL OR p.workspace_id = ?1",
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
    // 目标位置：桌面=路径；Android=保存对话框给的 `content://` URI ⇒ 先写缓存再搬
    // （zip 需要 Seek，URI 只能顺序写）。见 `save_target` 模块头。
    let target = crate::save_target::SaveTarget::new(&app, &dest_path, "shuyonote-space")?;
    let dest = target.write_path().to_path_buf();

    // Snapshot the space DB to a temp file (brief DB lock; online backup is WAL-safe).
    let tmp_db = crate::tempdir::file("shuyonote-ws", "db");
    {
        let conn = db.0.lock().expect("db mutex poisoned");
        // ⚠️ 加密态必须把**会话密钥**传下去：不带钥去备份加密库会被 SQLCipher 拒绝
        //（见 `snapshot_plaintext` 注释）。
        let key = crate::security::key_if_enabled(&conn).map(|k| k.legacy);
        snapshot_plaintext(&conn, key.as_ref(), &tmp_db)?;
    }

    let app2 = app.clone();
    let attachments2 = attachments_dir;
    let dest2 = dest.clone();
    let dest_report = dest_path.clone();
    let tmp_db2 = tmp_db;
    let space2 = space.clone();
    let hashes2 = referenced_hashes.clone();

    let out = tauri::async_runtime::spawn_blocking(move || -> Result<WorkspaceExportResult, String> {
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
            // 报**用户选的位置**（URI 目标下中转文件路径对用户没有意义）。
            path: dest_report,
            size,
            pages: 0,
            attachments: matched,
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    // URI 目标：把中转文件整份搬进用户选的位置（桌面是空操作）。
    target.commit()?;
    Ok(out)
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
    // Android：选择器给的是 `content://` URI，先落成真实临时路径（桌面原样返回）。
    let picked = crate::picked_file::materialize(&app, &src_path)?;
    let src = picked.path().to_path_buf();
    if !src.exists() {
        return Err("空间包不存在".to_string());
    }

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments");
    let spaces_dir = app_data_dir.join("spaces");

    let tmp_dir = crate::tempdir::dir("shuyonote-wsin").map_err(|e| e.to_string())?;

    // Extract zip off the main thread.
    let src2 = src.clone();
    let tmp_dir2 = tmp_dir.clone();
    let Extracted { db_snapshot, att_src_dir, meta_file } = tauri::async_runtime::spawn_blocking(move || {
        extract_workspace_zip(&src2, &tmp_dir2)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Decide a fresh workspace id (import never clobbers an existing space).
    // 安全：zip 内的 workspace id 不可信（可能为 `../../x` 等穿越值），必须先过
    // `is_safe_space_id` 白名单再用于 `spaces/<id>.db` 路径拼接；不安全即改用 UUID。
    let new_id = {
        let c = db.0.lock().expect("db mutex poisoned");
        let raw = meta_file.as_ref().map(|m| m.id.clone()).filter(|i| !i.is_empty());
        let mut candidate = raw
            .filter(|i| crate::db::is_safe_space_id(i))
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
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

    // E1: when at-rest encryption is on and the session is unlocked, encrypt the
    // imported plaintext DB so it matches every other space. Record the state so
    // the meta row below is marked consistently.
    let encrypted = {
        let c = db.0.lock().expect("db mutex poisoned");
        match crate::security::key_if_enabled(&c) {
            Some(k) => {
                // 库级（SQLCipher）用 legacy 那 32 字节。
                crate::security::convert_space_db(&target_db, true, Some(&k.legacy))?;
                true
            }
            None => false,
        }
    };

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
            "INSERT INTO meta.workspaces (id, name, theme, icon, sort_order, created_at, updated_at, encrypted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![new_id, import_name, theme, icon, sort_order, now, now, if encrypted { 1 } else { 0 }],
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
    use std::sync::atomic::{AtomicU32, Ordering};

    static TMP_SEQ: AtomicU32 = AtomicU32::new(0);

    /// 进程内唯一的临时目录名（pid + 毫秒 + 自增序号）——测试并行时不能靠固定名字。
    fn uniq_tmp(tag: &str) -> PathBuf {
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "shuy_wsio_{tag}_{}_{}_{seq}",
            std::process::id(),
            crate::db::now_ms()
        ))
    }

    /// 建一个带真实 schema 的空间库（`crate::db::migrate`）并写一个页面。
    fn make_space_db(path: &Path, id: &str) {
        let c = Connection::open(path).unwrap();
        crate::db::migrate(&c, id).unwrap();
        c.execute(
            "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at) \
             VALUES ('p1', ?1, NULL, 'hi', '{\"root\":{}}', 'hi', 'page', 0, 1, 1, NULL)",
            [id],
        )
        .unwrap();
        c.close().unwrap();
    }

    // F2 回归锚点（E1 磁盘加密）：导出工作空间的契约是「zip 里那份 shuyonote.db 是明文」。
    // 源库加密时也要满足这个契约；而「源加密却不给钥」必须**明确失败**，绝不能产出一个
    // 看起来成功、实际打不开的坏快照。
    #[test]
    fn snapshot_plaintext_from_an_encrypted_source_is_readable_without_a_key() {
        let dir = std::env::temp_dir().join(uniq_tmp("wsenc"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("default.db");
        make_space_db(&src, "default");
        let key = crate::crypto::derive_key("hunter2", &crate::crypto::random_salt()).unwrap();
        crate::security::convert_space_db(&src, true, Some(&key)).unwrap();
        assert!(crate::security::space_db_is_encrypted(&src));

        // ① 回归锚点：源加密、不给钥 ⇒ SQLCipher 拒绝在线备份。老代码在这里让整个
        // 「导出工作空间」硬失败（`backup is not supported with encrypted databases`）。
        let bad = dir.join("bad.db");
        {
            let c = Connection::open(&src).unwrap();
            crate::security::key_conn_with(&c, &key).unwrap();
            let e = snapshot_plaintext(&c, None, &bad).unwrap_err();
            assert!(e.contains("backup is not supported"), "意外的错误：{e}");
        }

        // ② 给钥 ⇒ 产物**不用任何钥**就能读出页面（这才是 zip 成员的契约）。
        let dst = dir.join("plain.db");
        {
            let c = Connection::open(&src).unwrap();
            crate::security::key_conn_with(&c, &key).unwrap();
            snapshot_plaintext(&c, Some(&key), &dst).unwrap();
        }
        assert!(!crate::security::space_db_is_encrypted(&dst), "导出契约要求明文库");
        {
            // 注意：这里**故意**不设任何 PRAGMA key。
            let c = Connection::open(&dst).unwrap();
            let t: String = c
                .query_row("SELECT title FROM pages WHERE id='p1'", [], |r| r.get(0))
                .unwrap();
            assert_eq!(t, "hi");
        }
        // 中转的密文快照不能留在产物目录里。
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("ws-keyed"))
            .collect();
        assert!(leftovers.is_empty(), "中转文件残留：{leftovers:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★ **三平面联合格子 j1**（2026-09-23）：导出/导入走的是**整库在线备份**，
    /// 所以"另两个平面新加的表/列也会被带走"这件事，看起来是不证自明的 —— 而"看起来"正是要钉的东西。
    ///
    /// 为什么不能靠上面那条判据：它只断言了 `pages` 里那一行。而联合验收要问的是**交界处**：
    ///   · **块级 CRDT** 把每页的**权威状态**放进 `page_crdt`（血统；丢了就等于"一页变两页"）；
    ///   · **全库 AI 覆盖**把覆盖度放进 `attachment_text.coverage`（"抽到哪"的读数；丢了就成了"未知"）；
    ///   · 而源库是**加密**的（国密或 AES 页，取决于构建）⇒ 快照要把这三件事一起抬过去。
    ///
    /// 三条断言（缺一条就不是同一个故事）：
    ///   ① 快照产物**不给任何钥**读得开（导出契约：zip 里那份是明文）；
    ///   ② `page_crdt` 的**字节逐字节相同**（血统不能被截断/重编码）；
    ///   ③ `attachment_text.coverage` 的**文本逐字相同**（未知 ≠ 完整，所以空串与 `{"complete":false}` 是两件事）。
    ///
    /// ⚠️ 它**不**证明"跨后端也能读"（那是格子 j2：两份页加密夹具）；也不证明"平面开着时的全库扫描"
    /// （那是 j3）。本格只管**这条快照路径**——见 `docs/JOINT-ACCEPTANCE.md` 的格子表。
    #[test]
    fn snapshot_carries_the_other_two_planes_new_tables() {
        let dir = std::env::temp_dir().join(uniq_tmp("wsjoint"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("default.db");
        make_space_db(&src, "default");

        // CRDT 那半：一页的权威状态（这里不关心格式，只关心**字节**能原样过去）。
        let lineage: Vec<u8> = vec![0x00, 0x53, 0x02, 0xff, 0x10, 0x7f, 0x80, 0x01];
        // AI 覆盖那半：一份**非空**覆盖度（空串是"没算过"，正是最容易被顺手丢掉的形态）。
        let coverage = r#"{"complete":false,"pages":[{"from":1,"to":50,"total":120}]}"#;
        {
            let c = Connection::open(&src).unwrap();
            c.execute(
                "INSERT INTO page_crdt (page_id, state, updated_at) VALUES ('p1', ?1, 7)",
                [&lineage],
            )
            .unwrap();
            c.execute(
                "INSERT INTO attachment_text (att_id, extractor, seq, kind, text, loc, src_hash, updated_at, coverage) \
                 VALUES ('a1', 'pdf.text@1', 0, 'text', '正文', '', 'hash-a1', 7, ?1)",
                [coverage],
            )
            .unwrap();
            c.close().unwrap();
        }

        let key = crate::crypto::derive_key("hunter2", &crate::crypto::random_salt()).unwrap();
        crate::security::convert_space_db(&src, true, Some(&key)).unwrap();
        assert!(crate::security::space_db_is_encrypted(&src), "前置：源库应当是加密的");

        let dst = dir.join("plain.db");
        {
            let c = Connection::open(&src).unwrap();
            crate::security::key_conn_with(&c, &key).unwrap();
            snapshot_plaintext(&c, Some(&key), &dst).unwrap();
        }
        assert!(!crate::security::space_db_is_encrypted(&dst), "导出契约要求明文库");

        {
            // 故意不设任何 PRAGMA key：快照必须自己就能读。
            let c = Connection::open(&dst).unwrap();
            let got_state: Vec<u8> = c
                .query_row("SELECT state FROM page_crdt WHERE page_id='p1'", [], |r| r.get(0))
                .expect("快照里必须有 page_crdt 那一行（CRDT 血统）");
            assert_eq!(got_state, lineage, "page_crdt 的字节必须逐字节过去");
            let got_cov: String = c
                .query_row(
                    "SELECT coverage FROM attachment_text WHERE att_id='a1'",
                    [],
                    |r| r.get(0),
                )
                .expect("快照里必须有 attachment_text.coverage（AI 覆盖读数）");
            assert_eq!(got_cov, coverage, "覆盖度文本必须逐字过去（未知 ≠ 完整）");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

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

    // 导出必须收齐两类 hash：① 本空间页面引用的；② 空间根下的无归属附件
    // （`page_id IS NULL`，「未整理」文件）。同时**不能**串到别的空间。
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
        // 根下上传的「未整理」文件：没有 page_id。
        conn.execute(
            "INSERT INTO attachments (id,page_id,name,hash,mime,size,created_at) VALUES ('a3',NULL,'z.pdf','h3','application/pdf',1,1)",
            [],
        )
        .unwrap();

        let mut hashes: Vec<String> = conn
            .prepare(
                "SELECT DISTINCT a.hash FROM attachments a
                 LEFT JOIN pages p ON p.id = a.page_id
                 WHERE a.page_id IS NULL OR p.workspace_id = ?1",
            )
            .unwrap()
            .query_map(params!["ws-a"], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        hashes.sort();
        assert_eq!(hashes, vec!["h1".to_string(), "h3".to_string()]);
    }
}
