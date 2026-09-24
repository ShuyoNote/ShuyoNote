use crate::db::Db;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager, State};

#[derive(Serialize)]
pub struct BackupResult {
    pub path: String,
    pub size: i64,
    /// ★ **被跳过的空间**（2026-09-20 加）：原来这种情况只在 stderr 打一行
    /// `备份跳过加密空间 …`，用户拿到一个"看起来成功"的包，**里面却没有那些空间的数据**。
    /// 现在把 `"<spaceId>: <原因>"` 原样带回给调用方，界面必须显示它。
    pub skipped: Vec<String>,
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
/// Online-backup `src` into `dst`（WAL-safe），**目标可选加同一把钥**。
///
/// ⚠️⚠️ 为什么要"可选加钥"（2026-09-20 实测，修 F2）：SQLCipher 的在线备份 API
/// **要求目标也加同一把钥** —— 源加钥、目标**不加钥**时报
/// `backup is not supported with encrypted databases`；两边同钥才成功（产物是**密文**，
/// 这与本模块恢复路径的既有语义一致：加密空间的快照要用会话密钥才打得开）。
///
/// ⚠️⚠️ 目标端**必须走 `key_conn_with`（＝带库级参数的生产口径），不能只写裸 `PRAGMA key`**
/// （2026-09-22 接线构建实测抓到）：备份 API 是**按目标连接的 codec 重新加密页面**的
/// ⇒ 目标端用什么参数，产物就是什么参数。只写裸 `PRAGMA key` 时目标端是默认参数
/// （HMAC_SHA512），于是在**国密（`sm-library`）构建**里会产出一份 **SM3 源 → SHA512 快照**
/// 的产物，而恢复路径用国密参数去读它 ⇒ `file is not a database`（判据
/// `snapshot_spaces_keys_the_encrypted_space_and_names_what_it_skips` 当场红）。
fn backup_db(src: &rusqlite::Connection, dst: &Path, key: Option<&[u8; 32]>) -> Result<(), String> {
    let mut dst_conn = rusqlite::Connection::open(dst).map_err(|e| e.to_string())?;
    if let Some(k) = key {
        crate::security::key_conn_with(&dst_conn, k)?;
    }
    let backup = rusqlite::backup::Backup::new(src, &mut dst_conn).map_err(|e| e.to_string())?;
    backup
        .run_to_completion(64, std::time::Duration::from_millis(5), None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 给每个空间库做一份在线快照，返回 `(成功的 (spaceId, 快照文件), 被跳过的说明)`。
///
/// ★ 为什么要**返回** `skipped` 而不是只打日志（2026-09-20，修 F2）：
/// E1（磁盘加密）下加密空间需要会话密钥；拿不到钥、或单个空间快照失败时，
/// 老代码要么让**整个导出硬失败**（`workspace_io` 那条路径），要么**静默少一个空间**
/// （只在 stderr 打一行）。两种都不是备份产品该有的行为：前者让用户根本导不出，
/// 后者让用户以为导全了。现在的契约是**能导的导、不能导的明说**。
///
/// ★ owner 第三轮拍板（2026-09-24）：钥匙**按空间取**（`space_crypto::space_key_for_path`），
/// 不再是"应用级一把会话钥匙 `session_key`"（那把已删）。所以每个空间各取各的钥匙 ——
/// 恰好也是"按空间加密"该有的样子：一个空间拿不到钥匙，**不影响**别的空间进备份。
/// ⚠️ 本进程还没载入公开材料（未解锁 / 之前是应用级加密的存量库）⇒ `space_key_for_path` 要么
/// `Err`（袋里有它但锁着）要么 `None`（袋里没有 / 没有袋子）⇒ 两种都记进 `skipped` 并**继续**，
/// 绝不"拿一把错的钥匙去快照"（那会写出一个打不开的备份）。
fn snapshot_spaces(
    spaces_dir: &Path,
    tmp_root: &Path,
) -> Result<(Vec<(String, PathBuf)>, Vec<String>), String> {
    let mut snapshots: Vec<(String, PathBuf)> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    if !spaces_dir.exists() {
        return Ok((snapshots, skipped));
    }
    for entry in std::fs::read_dir(spaces_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".db") {
            continue;
        }
        let id = name.trim_end_matches(".db").to_string();
        let path = spaces_dir.join(&name);
        let out = tmp_root.join("spaces").join(&name);
        let conn = rusqlite::Connection::open(&path).map_err(|e| e.to_string())?;
        // 加密空间：连接要加钥，**快照目标也要同一把钥**（见 `backup_db` 注释）。
        let key = if crate::security::space_db_is_encrypted(&path) {
            match crate::space_crypto::space_key_for_path(&path) {
                Ok(Some(k)) => Some(k),
                Ok(None) => {
                    skipped.push(format!(
                        "{id}: 空间是密文但钥匙袋里没有它的盒子（应用级加密的存量库，本版已不再支持）\
                         ⇒ 这个空间没进备份"
                    ));
                    continue;
                }
                Err(e) => {
                    skipped.push(format!("{id}: 空间已加密但拿不到它的钥匙（{e}）⇒ 这个空间没进备份"));
                    continue;
                }
            }
        } else {
            None
        };
        if let Some(k) = key.as_ref() {
            if let Err(e) = crate::security::key_conn_with(&conn, k) {
                skipped.push(format!("{id}: 加钥失败（{e}）⇒ 没进备份"));
                continue;
            }
        }
        // 单个空间的失败**不中断整个备份**，而是记进 `skipped`。
        if let Err(e) = backup_db(&conn, &out, key.as_ref()) {
            skipped.push(format!("{id}: 快照失败（{e}）⇒ 没进备份"));
            continue;
        }
        snapshots.push((id, out));
    }
    // 输出顺序稳定（`read_dir` 顺序随文件系统），便于测试与产物可比。
    snapshots.sort();
    skipped.sort();
    Ok((snapshots, skipped))
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
    // 目标位置：桌面是路径、Android 是 `content://` URI（写 URI 只能"先写缓存再搬"，
    // 而且 zip 需要 Seek，所以这里拿到的是**中转文件路径**）。见 `save_target` 模块头。
    let target = crate::save_target::SaveTarget::new(&app, &dest_path, "shuyonote-backup")?;
    let dest = target.write_path().to_path_buf();

    // Stage a compact snapshot of meta.db + every per-space DB in a temp dir, then
    // stream them all into one zip. Online snapshotting is WAL-safe and holds each
    // source connection only briefly, so the live app keeps working throughout.
    let tmp_root = crate::tempdir::dir("shuyonote-export").map_err(|e| e.to_string())?;
    std::fs::create_dir_all(tmp_root.join("spaces")).map_err(|e| e.to_string())?;

    let tmp_meta = tmp_root.join("meta.db");
    {
        let meta_conn = rusqlite::Connection::open(&meta_file).map_err(|e| e.to_string())?;
        backup_db(&meta_conn, &tmp_meta, None)?;
    }

    // ★ 被跳过的空间要**带回给用户**（原来只在 stderr 打一行，包看起来是成功的）。
    //   钥匙**按空间**在 `snapshot_spaces` 里各取各的（应用级那把会话钥匙已随应用级加密一起删）。
    let (space_snapshots, skipped) = snapshot_spaces(&spaces_dir, &tmp_root)?;

    let app2 = app.clone();
    let attachments2 = attachments_dir;
    let dest2 = dest.clone();
    let tmp_root2 = tmp_root.clone();
    let out = tauri::async_runtime::spawn_blocking(move || -> Result<BackupResult, String> {
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
            // 报**用户选的位置**，不是我们的中转文件路径（URI 目标下后者对用户没意义）。
            path: dest_path.clone(),
            size,
            skipped,
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    // URI 目标：把中转文件整份搬进用户选的位置（桌面是空操作）。
    target.commit()?;
    Ok(out)
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

/// Read the space's display name / theme / icon from **备份快照**, with an actionable
/// diagnosis when the read fails.
///
/// ★ 为什么单独拎一层（2026-09-20，F2 邻接修）：E1 下备份里的空间是**密文快照**。
/// 「同一台设备、同一口令」恢复没问题；但**另一台设备 / 另一个口令**导出的备份，
/// `PRAGMA key` 本身**不会报错**（SQLCipher 直到第一次读写才验钥），于是失败点落在
/// 这次读上，原始报错是 `file is not a database` —— 用户完全无从下手。这里把它翻成
/// 「这份备份是别的密钥写的」。
fn read_snapshot_meta(
    conn: &rusqlite::Connection,
    snap: &Path,
    orig_id: &str,
) -> Result<(String, String, String), String> {
    read_workspace_meta(conn).map_err(|e| snapshot_read_diagnosis(snap, orig_id, &e))
}

/// 见 [`read_snapshot_meta`]：密文快照读不出来 ⇒ 说清是「密钥不是这一套」。
fn snapshot_read_diagnosis(snap: &Path, orig_id: &str, raw: &str) -> String {
    if crate::security::space_db_is_encrypted(snap) {
        format!(
            "备份里的空间 {orig_id} 是密文，当前的口令打不开它（原始报错：{raw}）。\
             密文备份只能用**导出时那一套密钥**恢复；这通常说明备份来自另一台设备或另一个加密口令。\
             请在原设备上、用原口令重新导出，或先在那台设备上关闭磁盘加密再导出。"
        )
    } else {
        raw.to_string()
    }
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
    // Android：选择器给的是 `content://` URI，先落成真实临时路径（桌面原样返回）。
    // 否则下一行的 `exists()` 会 false，报"备份文件不存在"——文件明明在那儿。
    let picked = crate::picked_file::materialize(&app, &src_path)?;
    let src = picked.path().to_path_buf();
    if !src.exists() {
        return Err("备份文件不存在".to_string());
    }

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let spaces_dir = crate::db::spaces_dir(&app_data_dir);
    let attachments_dir = app_data_dir.join("attachments");
    let meta_file = crate::db::meta_path(&app_data_dir);
    std::fs::create_dir_all(&spaces_dir).map_err(|e| e.to_string())?;

    let tmp_dir = crate::tempdir::path("shuyonote-restore");
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
            read_snapshot_meta(&c, snap, orig_id)?
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
pub fn write_text_file(app: tauri::AppHandle, path: String, content: String) -> Result<(), String> {
    // Android：保存对话框给的是 `content://` URI，不能当路径用（真机实测 EROFS）。
    // 走 SaveTarget：桌面=直接写路径（行为不变），URI=先写缓存再整份搬进去。
    let target = crate::save_target::SaveTarget::new(&app, &path, "shuyonote-text")?;
    std::fs::write(target.write_path(), content).map_err(|e| e.to_string())?;
    target.commit()
}

/// Write raw bytes to a path. Used by the desktop "save as" of the exported PDF
/// annotated copy (dialog.save → write_binary_file). Web degrades to download.
#[tauri::command]
pub fn write_binary_file(app: tauri::AppHandle, path: String, data: Vec<u8>) -> Result<(), String> {
    let target = crate::save_target::SaveTarget::new(&app, &path, "shuyonote-bin")?;
    std::fs::write(target.write_path(), data).map_err(|e| e.to_string())?;
    target.commit()
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TMP_SEQ: AtomicU32 = AtomicU32::new(0);

    fn uniq_tmp(tag: &str) -> PathBuf {
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "shuy_bk_{tag}_{}_{}_{seq}",
            std::process::id(),
            crate::db::now_ms()
        ))
    }

    /// 建一个带真实 schema（`crate::db::migrate`）和一个页面的空间库。
    fn make_space(path: &Path, id: &str) {
        let c = rusqlite::Connection::open(path).unwrap();
        crate::db::migrate(&c, id).unwrap();
        c.execute(
            "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at) \
             VALUES ('p1', ?1, NULL, 'hi', '{\"root\":{}}', 'hi', 'page', 0, 1, 1, NULL)",
            [id],
        )
        .unwrap();
        c.close().unwrap();
    }

    // F2 回归锚点（E1 磁盘加密）：加密空间**必须真的进快照**（目标同钥），
    // 拿不到钥时必须「少一份但明说」，不能硬失败、更不能静默少一个空间。
    //
    // ★ owner 第三轮拍板（2026-09-24）改写：钥匙**按空间**取（不再有"应用级一把会话钥匙"）
    //   ⇒ ① 的夹具从"传一把会话钥匙"改成"袋子里放它的盒子 ＋ 会话装上主密钥"。
    //   ⚠️ 这会动**进程级全局**（KEYRING / SESSION_MASTER）⇒ 必须与其它会话态判据串行（`SEC_LOCK`）。
    #[test]
    fn snapshot_spaces_keys_the_encrypted_space_and_names_what_it_skips() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let dir = uniq_tmp("spaces");
        let _ = std::fs::remove_dir_all(&dir);
        let spaces = dir.join("spaces");
        std::fs::create_dir_all(&spaces).unwrap();
        let out_root = dir.join("out");
        std::fs::create_dir_all(out_root.join("spaces")).unwrap();

        let plain = spaces.join("plain.db");
        let enc = spaces.join("enc.db");
        make_space(&plain, "plain");
        make_space(&enc, "enc");
        let key = crate::crypto::derive_key("hunter2", &crate::crypto::random_salt()).unwrap();
        crate::security::convert_space_db(&enc, true, Some(&key)).unwrap();
        assert!(crate::security::space_db_is_encrypted(&enc));

        // ① 解锁态：袋子里有 enc 的盒子 ＋ 会话有主密钥 ⇒ 两个空间都进快照；
        //    加密那份本身是**密文**，但用同一把钥能读出页面（证明它是真数据 ——
        //    不是「写坏/写空之后看起来成功」的那种快照）。
        crate::space_crypto::set_space_box_for_test("enc", &key, "pw");
        let (snaps, skipped) = snapshot_spaces(&spaces, &out_root).unwrap();
        assert!(skipped.is_empty(), "解锁态不该有跳过：{skipped:?}");
        assert_eq!(
            snaps.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["enc", "plain"]
        );
        let enc_out = &snaps.iter().find(|(id, _)| id == "enc").unwrap().1;
        assert!(
            crate::security::space_db_is_encrypted(enc_out),
            "加密空间的快照也应是密文（目标必须同钥）"
        );
        {
            let c = rusqlite::Connection::open(enc_out).unwrap();
            crate::security::key_conn_with(&c, &key).unwrap();
            let t: String = c
                .query_row("SELECT title FROM pages WHERE id='p1'", [], |r| r.get(0))
                .unwrap();
            assert_eq!(t, "hi");
        }

        // ② 锁定态（袋子里没有它的盒子）：明文那份照导，加密那份**记名跳过**（带空间 id 和原因）。
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
        let out2 = dir.join("out2");
        std::fs::create_dir_all(out2.join("spaces")).unwrap();
        let (snaps2, skipped2) = snapshot_spaces(&spaces, &out2).unwrap();
        assert_eq!(
            snaps2.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["plain"]
        );
        assert_eq!(skipped2.len(), 1, "跳过必须被记下来：{skipped2:?}");
        assert!(skipped2[0].starts_with("enc:"), "{}", skipped2[0]);
        assert!(
            skipped2[0].contains("钥匙袋"),
            "跳过原因要说清「为什么拿不到钥匙」：{}",
            skipped2[0]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // F2 邻接（E1 导入）：**另一套密钥**写的密文快照，报错必须是「可操作」的，
    // 而不是 SQLCipher 的 `file is not a database`。
    #[test]
    fn cross_key_encrypted_snapshot_gets_an_actionable_diagnosis() {
        let dir = uniq_tmp("crosskey");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let snap = dir.join("enc.db");
        make_space(&snap, "enc");
        let key_a = crate::crypto::derive_key("passphrase-A", &crate::crypto::random_salt()).unwrap();
        let key_b = crate::crypto::derive_key("passphrase-B", &crate::crypto::random_salt()).unwrap();
        crate::security::convert_space_db(&snap, true, Some(&key_a)).unwrap();
        assert!(crate::security::space_db_is_encrypted(&snap));

        // 同一把钥（同设备同口令）⇒ 正常读出空间名。
        {
            let c = rusqlite::Connection::open(&snap).unwrap();
            crate::security::key_conn_with(&c, &key_a).unwrap();
            let (name, _, _) = read_snapshot_meta(&c, &snap, "enc").unwrap();
            assert_eq!(name, "默认空间"); // migrate 播下的那行工作空间名
        }
        // 另一把钥（另一台设备/另一个口令）⇒ 读失败，且诊断里必须点明"密钥不是这一套"。
        {
            let c = rusqlite::Connection::open(&snap).unwrap();
            crate::security::key_conn_with(&c, &key_b).unwrap();
            let e = read_snapshot_meta(&c, &snap, "enc").unwrap_err();
            assert!(e.contains("密文"), "诊断没说明是密文：{e}");
            assert!(e.contains("另一台设备"), "诊断没说清成因：{e}");
            assert!(e.contains("原设备"), "诊断没给出下一步：{e}");
            assert!(e.contains("enc"), "诊断没带上是哪个空间：{e}");
        }
        // 明文快照的原始报错**不能**被套上"密文"的解释（否则就是误诊）。
        let plain = dir.join("plain.db");
        make_space(&plain, "plain");
        {
            let c = rusqlite::Connection::open(&plain).unwrap();
            c.execute_batch("PRAGMA foreign_keys=OFF; DELETE FROM workspaces").unwrap();
            let e = read_snapshot_meta(&c, &plain, "plain").unwrap_err();
            assert!(!e.contains("密文"), "明文快照被误诊成密文：{e}");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}
