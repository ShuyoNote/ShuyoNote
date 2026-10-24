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
    /// ⭐ **2026-10-25**：**孤儿库** —— `spaces/*.db` 在磁盘上，但 `meta.workspaces` 里**没有这一行**
    /// （界面上根本看不到的空间）。它们照样会被打进备份（⛔ 不静默丢一份可能含内容的库 ✗），
    /// 但必须**点名**：否则"备份 122 MB 里有多少是看不见的库"永远没人知道。
    #[serde(default)]
    pub orphans: Vec<String>,
}

/// 把一次备份的读数压成**一行**（日志与 UI 共用同一句，⛔ 不写第二遍 ✗）。
///
/// 形状：`size=<字节> skipped=<n>（<空间: 原因>；…） 孤儿库=<n>（<id>、…）`
/// —— 括号里只在**非零**时出现（正常那天的日志形状**一个字节都不变** ✓）。
pub(crate) fn summary_note(size: i64, skipped: &[String], orphans: &[String]) -> String {
    let mut s = format!("size={size} skipped={}", skipped.len());
    if !skipped.is_empty() {
        s.push_str("（");
        s.push_str(
            &skipped
                .iter()
                .map(|line| short_space_line(line))
                .collect::<Vec<_>>()
                .join("；"),
        );
        s.push('）');
    }
    if !orphans.is_empty() {
        s.push_str(&format!(
            " 孤儿库={}（{}）",
            orphans.len(),
            orphans
                .iter()
                .map(|id| short_space_id(id))
                .collect::<Vec<_>>()
                .join("、")
        ));
    }
    s
}

/// `"<36 位空间 id>: 原因"` ⇒ `"<前 8 位>…: 原因"`（一行日志里塞不下 36 位 × N 条 ✓）。
fn short_space_line(line: &str) -> String {
    match line.split_once(':') {
        // ⚠️ `split_once(':')` 的 `rest` **不含那个冒号** ⇒ 必须自己补回去
        //   （2026-10-25 实测：漏了它，日志里会变成「99082b5a…空间是密文…」✗）
        Some((id, rest)) => format!("{}:{}", short_space_id(id), rest),
        None => line.to_string(),
    }
}

fn short_space_id(id: &str) -> String {
    let id = id.trim();
    if id.len() > 8 {
        format!("{}…", &id[..8])
    } else {
        id.to_string()
    }
}

/// ⭐ **2026-10-25**：哪些 `spaces/*.db` 在 `meta.workspaces` 里**没有行**（孤儿库）。
///
/// 为什么要它：备份是**按目录**打的（`snapshot_spaces` 遍历 `spaces/`），不看 meta ⇒
/// 界面上看不见的库也会进包（真机实测：13 个库 / 9 个活空间 ⇒ 4 个孤儿）。
/// 口径：⛔ **不因此少打包**（那可能是一份用户内容，只是 meta 行丢了 ✗）；只**如实点名** ✓。
pub(crate) fn orphan_space_ids(
    meta_file: &Path,
    spaces_dir: &Path,
) -> Result<Vec<String>, String> {
    let known: std::collections::HashSet<String> = {
        let c = rusqlite::Connection::open(meta_file).map_err(|e| e.to_string())?;
        let mut st = c
            .prepare("SELECT id FROM workspaces")
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let mut out: Vec<String> = Vec::new();
    let Ok(rd) = std::fs::read_dir(spaces_dir) else {
        return Ok(out); // 没有目录 ⇒ 没有孤儿（不是错误 ✓）
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".db") else {
            continue;
        };
        if id.is_empty() || id.starts_with('.') {
            continue;
        }
        if !known.contains(id) {
            out.push(id.to_string());
        }
    }
    out.sort();
    Ok(out)
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
    // ⭐ 2026-10-25：**孤儿库**（目录里有 `.db`、`meta.workspaces` 里没有行）——
    //   它们照样进包（⛔ 不静默丢一份可能含内容的库 ✗），但要**点名**，见 `orphan_space_ids`。
    let orphans = orphan_space_ids(&meta_file, &spaces_dir)?;

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
            orphans,
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    // URI 目标：把中转文件整份搬进用户选的位置（桌面是空操作）。
    target.commit()?;
    Ok(out)
}

/// P1（自动备份）：⭐ **按我们定的位置跑一次**，并把保留分层也跑一遍 ✓
///
/// ⚠️ 这里**不重写**备份逻辑 —— 直接调已有的 `export_backup`（`#[tauri::command]` 也是普通 async fn ✓），
///    只把「去哪、叫什么名」换成我们自己的：`<app_data_dir>/backups/shuyonote-backup-<unix>.zip` ✓
/// ⚠️ 加密空间那条硬约束（`backup is not supported with encrypted databases`）由 `snapshot_spaces`
///    自己分叉并**如实报 skipped** ✓ —— 本函数把它带进日志，⛔ 不静默少数据 ✓
/// ⚠️ 删除只发生在 `backups/` 目录内、且**只删我们自己命名**的文件 ✓（保留分层的 remove 清单 ✓）
pub async fn run_auto_backup_once(app: &tauri::AppHandle) -> crate::auto_backup::RunResult {
    use crate::auto_backup::{now_unix, retention_keep, RunResult, Snapshot};
    use tauri::Manager;

    let app_data = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => return RunResult::Failed { note: format!("拿不到应用数据目录：{e}") },
    };
    let dir = app_data.join("backups");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return RunResult::Failed { note: format!("建备份目录失败：{e}") };
    }
    // ⚠️ 名字带**毫秒**（同秒两次调度不互相覆盖 ✗）＋ 先写 `.part` ⇒ **成功后才 rename** ✓
    //    （实测：我杀进程时留下过一个 0 MB 的 .zip ✗ —— 那会被保留策略当成"一份有效备份" ✓）
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(now_unix() as u128 * 1000);
    let final_dest = dir.join(format!("shuyonote-backup-{}.zip", stamp));
    let dest = dir.join(format!("shuyonote-backup-{}.zip.part", stamp));
    // ⚠️ 实测坑（本机一次真跑抓到的 ✓）：`setup()` 跑在 `Db` 被 `manage()` **之前** ⇒
    //    直接 `app.state::<Db>()` 会 **panic**：「state() called before manage()」✗
    //    （症状是"线程当场死了、什么都没备份"，而 `backups/` 目录已经被建出来 ✓）
    // ⇒ 这里**等它就绪**（最多 ~5s ✓）；拿不到就**如实跳过** ✓（⛔ 不假装成功 ✗）
    let mut ready = false;
    for _ in 0..50 {
        if app.try_state::<Db>().is_some() {
            ready = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if !ready {
        return RunResult::Skipped { note: "数据库 5 秒内没就绪".into() };
    }
    let db = app.state::<Db>();
    match export_backup(app.clone(), db, dest.to_string_lossy().to_string()).await {
        Ok(r) => {
            // ⭐ 成功才改名（rename ✓）：中断/崩溃只会留下 `.part`（⭐ 不算一份 ✓）
            if let Err(e) = std::fs::rename(&dest, &final_dest) {
                return RunResult::Failed { note: format!("改名失败：{e}") };
            }
            // ★ 保留分层：只认我们自己的命名，且只在这个目录里删 ✓
            let mut entries: Vec<Snapshot> = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for ent in rd.flatten() {
                    let name = ent.file_name().to_string_lossy().into_owned();
                    // ⭐ 只认"有效快照"（⭐ 0 字节与 `.part` 都不算 ✓）——判据在 auto_backup 里，可单测 ✓
                    if !name.starts_with("shuyonote-backup-") {
                        continue;
                    }
                    let sz = std::fs::metadata(ent.path()).map(|m| m.len()).unwrap_or(0);
                    if !crate::auto_backup::is_valid_snapshot(&name, sz) {
                        // ⚠️ 0 字节的 .zip ＝ 老版本留下的半个包 ⇒ 删掉 ✓；`.part` 若是旧的就一起清 ✓
                        let old = std::fs::metadata(ent.path())
                            .and_then(|m| m.modified())
                            .ok()
                            .and_then(|t| t.elapsed().ok())
                            .map(|d| d.as_secs() > 3600)
                            .unwrap_or(false);
                        if sz == 0 || (name.ends_with(".part") && old) {
                            let _ = std::fs::remove_file(ent.path());
                        }
                        continue;
                    }
                    if false {
                        continue;
                    }
                    let unix = std::fs::metadata(ent.path())
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    entries.push(Snapshot { name, unix });
                }
            }
            let plan = retention_keep(&entries, now_unix());
            let mut removed = 0usize;
            for name in &plan.remove {
                if std::fs::remove_file(dir.join(name)).is_ok() {
                    removed += 1;
                }
            }
            RunResult::Ok {
                kept: plan.keep.len(),
                removed,
                // ⭐ 2026-10-25：**跳过与孤儿都要点名**（原来只给计数 ⇒ 日志/UI 都看不出
                //   "是哪个空间、为什么"，和这两天修的"静默"是同一族 ✓）。
                note: summary_note(r.size, &r.skipped, &r.orphans),
            }
        }
        Err(e) => RunResult::Failed { note: format!("导出失败：{e}") },
    }
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
    rekey_workspace_from(conn, None, id, name, theme, icon)
}

/// ⭐⭐ **2026-10-19（owner 真机：恢复备份报 `FOREIGN KEY constraint failed`）**：
/// 把「这一格空间的 `workspaces` 行」改成 `new_id`，**并把引用它的行一起改过去**。
///
/// ## 旧实现为什么会在恢复时炸
/// 旧写法是 `DELETE FROM workspaces` ⇒ `INSERT (新 id)`。而 `pages.workspace_id` 有
/// **FK → `workspaces(id)`**（`db.rs` 建表语句逐字）⇒ 恢复里**重命名**那一支（备份里的空间 id
/// 与本机已有冲突 ⇒ 换一个新 id）必然踩到：删父行时要么当场 FK 失败，要么把 `pages`
/// 全部指到一个不存在的父（下次开连接就炸）✓
///
/// ## 现在的顺序（先改孩子、再改父）
/// 1. `PRAGMA foreign_keys=OFF`（**只在这条连接上**，改完立刻恢复）；
/// 2. 有 `old_id` ⇒ 先把 `pages.workspace_id` 改到新 id，再 `UPDATE workspaces SET id=…`；
/// 3. 那行不存在（或没有 `old_id`）⇒ `INSERT`；
/// 4. 恢复 `PRAGMA foreign_keys=ON`，再跑一次 `pragma_foreign_key_check` **自查**
///    （⛔ 不留悬空引用；有就报错中止，而不是把坏数据留下来）。
///
/// ⚠️ 幂等：`old_id` 为 `None` 或等于 `new_id` 时只做"确保那一行存在"。
fn rekey_workspace_from(
    conn: &rusqlite::Connection,
    old_id: Option<&str>,
    new_id: &str,
    name: &str,
    theme: &str,
    icon: &str,
) -> Result<(), String> {
    let now = crate::db::now_ms();
    conn.execute_batch("PRAGMA foreign_keys = OFF")
        .map_err(|e| format!("关闭外键检查失败：{e}"))?;
    let res = (|| -> Result<(), String> {
        if let Some(old) = old_id.map(str::trim).filter(|o| !o.is_empty() && *o != new_id) {
            conn.execute(
                "UPDATE pages SET workspace_id = ?1 WHERE workspace_id = ?2",
                rusqlite::params![new_id, old],
            )
            .map_err(|e| format!("把页面改到新空间失败（{old} → {new_id}）：{e}"))?;
            let n = conn
                .execute(
                    "UPDATE workspaces SET id = ?1, name = ?2, theme = ?3, icon = ?4, updated_at = ?5 WHERE id = ?6",
                    rusqlite::params![new_id, name, theme, icon, now, old],
                )
                .map_err(|e| format!("改空间行失败（{old} → {new_id}）：{e}"))?;
            if n > 0 {
                return Ok(());
            }
        }
        conn.execute(
            "INSERT OR REPLACE INTO workspaces (id, name, theme, icon, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![new_id, name, theme, icon, now, now],
        )
        .map_err(|e| format!("写空间行失败（{new_id}）：{e}"))?;
        Ok(())
    })();
    let _ = conn.execute_batch("PRAGMA foreign_keys = ON");
    res?;
    // ⭐ **2026-10-19（owner 真机第二轮：`恢复后仍有 1 条悬空引用`）**：
    //   这一查**不再中止导入** ✗ —— 实测那份备份里本来就有 1 条悬空引用（备份自身的历史脏数据），
    //   终止整次恢复等于"因为一条别人的旧脏数据，让你的备份导不进来" ✓。
    //   ⇒ 现在**如实报出来**（哪些表、各几条），但让导入继续 ✓。
    let dangling = dangling_refs(conn);
    if !dangling.is_empty() {
        eprintln!(
            "[backup] ⚠️ 导入的空间里有 {} 条**原本就存在**的悬空引用（备份里带出来的，不是这次改 id 造成的）：{}",
            dangling.iter().map(|x| x.1).sum::<i64>(),
            dangling
                .iter()
                .map(|(t, n)| format!("{t}={n}"))
                .collect::<Vec<_>>()
                .join("；")
        );
    }
    Ok(())
}

/// 悬空引用清单：`(表名, 条数)` —— 来自 `pragma_foreign_key_check`（只读）。
fn dangling_refs(conn: &rusqlite::Connection) -> Vec<(String, i64)> {
    let Ok(mut st) = conn.prepare("SELECT \"table\" FROM pragma_foreign_key_check") else {
        return Vec::new();
    };
    let Ok(rows) = st.query_map([], |r| r.get::<_, String>(0)) else {
        return Vec::new();
    };
    let mut counts: Vec<(String, i64)> = Vec::new();
    for t in rows.filter_map(|r| r.ok()) {
        match counts.iter_mut().find(|(n, _)| n == &t) {
            Some((_, c)) => *c += 1,
            None => counts.push((t, 1)),
        }
    }
    counts
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
            // ⭐ 2026-10-19：重命名那一支要把**旧 id 到新 id 的引用一起改**（否则 pages 指向不存在的父）
            rekey_workspace_from(&c, Some(orig_id.as_str()), &target_id, &name, &theme, &icon)?;
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

/// 读一个用户**选**来的文本文件。
///
/// ⚠️ **2026-09-25 真机实测抓到的一处真 bug**：这一条原来只有
/// `std::fs::read_to_string(&path)` —— 而 Android 的系统选择器给回来的是
/// **`content://…` URI**（`Path::new("content://…")` 是个普通相对文件名，`fs::read_to_string`
/// 必然失败）。写那一半（[`write_text_file`]）早就走 `SaveTarget` 把这件事处理掉了，
/// **读这一半一直漏着** —— 因为它当时没有调用方（B 片"配对码存/读文件"是第一个）。
///
/// 修法照 `import_backup` 的同一条路：**先 `picked_file::materialize` 落成真实临时路径**
/// （桌面原样返回 ⇒ 桌面行为逐字不变），再读。
#[tauri::command]
pub fn read_text_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let picked = crate::picked_file::materialize(&app, &path)?;
    std::fs::read_to_string(picked.path()).map_err(|e| e.to_string())
}

// ============================================================================
// **task-20：把已有的自动备份能力开成两条命令**（界面那格从"读不到"变成**真读数**）
// ----------------------------------------------------------------------------
// ⚠️ 为什么要开：`task-19` 把界面接上之后查出**真缺口** —— 后端**明明有**这个能力（备份真的在跑 ✓），
//    却**没有**任何命令能把读数给前端 ✗、也没有命令能"立刻备一次" ✗
//    ⇒ 于是界面只能**如实说"读不到"** ✓（⛔ 它没画假开关／假按钮 ✓）。
// ⭐ 这一节只做"**开两个口**"，⛔ 一条备份逻辑都不重写 ✗：
//    · 读：照 `run_auto_backup_once` **同一个目录算法**（`app_data.join("backups")` ✓）
//      ＋ **复用** `auto_backup::is_valid_snapshot`（半个包不算一份 ✓）
//    · 写：**直接调**既有的 `run_auto_backup_once` ✓
// ============================================================================

/// 自动备份的一份快照（⭐ 带大小 ⇒ 前端"共多大"不用猜 ✓）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoBackupSnapshot {
    pub name: String,
    pub unix: u64,
    pub size: u64,
}

/// 自动备份的**只读读数**（task-20 ①）。
///
/// ⚠️ `unreadable` 与 `count = 0` **不是一回事**（判据 b 挡的就是这个 ✓）：
///   · 目录不存在（还没备份过）⇒ `count = 0` ＋ `unreadable = None` ⇒ **真的 0 份** ✓
///   · `read_dir` 失败 ⇒ `unreadable = Some(原因)` ⇒ 界面**如实说"读不到"** ✓（⛔ 不许显示 0 ✗）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoBackupStatus {
    pub dir: String,
    pub count: usize,
    pub bytes: u64,
    pub last_success_unix: Option<u64>,
    pub snapshots: Vec<AutoBackupSnapshot>,
    /// 保留窗口（⭐ **照 `auto_backup` 的常量说** ⇒ ⛔ 界面不写第二遍 ✗，判据 i 会读这段源码核它 ✓）
    pub keep_days: u64,
    pub keep_weeks: u64,
    pub keep_months: u64,
    pub unreadable: Option<String>,
}

/// **立刻看一眼自动备份的读数**（只读 ✓，⛔ 不写盘、不跑备份 ✓）。
#[tauri::command]
pub fn auto_backup_status(app: tauri::AppHandle) -> AutoBackupStatus {
    use crate::auto_backup::{KEEP_DAYS, KEEP_MONTHS, KEEP_WEEKS};
    use tauri::Manager;

    let keep = |d: u64, w: u64, m: u64| (d, w, m);
    let (keep_days, keep_weeks, keep_months) = keep(KEEP_DAYS, KEEP_WEEKS, KEEP_MONTHS);

    let app_data = app.path().app_data_dir();
    let dir = match &app_data {
        Ok(d) => d.join("backups"), // ⭐ 与 `run_auto_backup_once` **同一算法** ✓
        Err(e) => {
            return AutoBackupStatus {
                dir: String::new(),
                count: 0,
                bytes: 0,
                last_success_unix: None,
                snapshots: Vec::new(),
                keep_days,
                keep_weeks,
                keep_months,
                unreadable: Some(format!("拿不到应用数据目录：{e}")),
            }
        }
    };

    match crate::auto_backup::list_snapshots(&dir) {
        Ok(list) => AutoBackupStatus {
            dir: dir.to_string_lossy().into_owned(),
            count: list.entries.len(),
            bytes: list.bytes,
            last_success_unix: list.last_success_unix,
            snapshots: list
                .entries
                .into_iter()
                .map(|e| AutoBackupSnapshot { name: e.name, unix: e.unix, size: e.size })
                .collect(),
            keep_days,
            keep_weeks,
            keep_months,
            unreadable: None,
        },
        // ⭐ 读不到就**说读不到**（⛔ 不吞成 0 份 ✗ —— 那会让用户以为"没有备份" ✓）
        Err(reason) => AutoBackupStatus {
            dir: dir.to_string_lossy().into_owned(),
            count: 0,
            bytes: 0,
            last_success_unix: None,
            snapshots: Vec::new(),
            keep_days,
            keep_weeks,
            keep_months,
            unreadable: Some(reason),
        },
    }
}

/// 一次"立刻备份"的读数（⭐ 形状与 `auto_backup` 那行日志**同源** ✓）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoBackupRunReport {
    pub ran: bool,
    pub kept: usize,
    pub removed: usize,
    pub note: String,
}

/// **立刻备份一次**（task-20 ②）—— ⭐ **不重写备份逻辑**：直接走既有的 `run_auto_backup_once` ✓
/// （它已经做过：建目录／写 `.part` ⇒ 成功才 rename／跑保留分层／拿不到密钥就**如实跳过** ✓）。
#[tauri::command]
pub async fn auto_backup_run_now(app: tauri::AppHandle) -> AutoBackupRunReport {
    use crate::auto_backup::RunResult;
    let r = match run_auto_backup_once(&app).await {
        RunResult::Ok { kept, removed, note } => AutoBackupRunReport { ran: true, kept, removed, note },
        // ⭐ 跳过／失败都**照实回**（⛔ 不假装跑成功 ✗）
        RunResult::Skipped { note } => AutoBackupRunReport { ran: false, kept: 0, removed: 0, note },
        RunResult::Failed { note } => AutoBackupRunReport { ran: false, kept: 0, removed: 0, note },
    };
    // ⭐⭐ **2026-10-25**：**手动那次也要留一行日志** ——
    //   真机踩到：点了「立即备份」后，日志里**一条都不多**（自动那趟由 `lib.rs` 打，
    //   手动这条只把报告回给 UI）⇒ "刚才那次跑没跑、跳了几个、包里有没有那个空间"只能靠猜。
    //   形状与自动那趟一致（前缀相同），只是多一个 `手动` 标记，便于 grep 区分。
    eprintln!("[auto-backup] 手动 ｜ {}", r.note);
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TMP_SEQ: AtomicU32 = AtomicU32::new(0);

    /// ⭐ **2026-10-25**：那一行读数必须能**点名**（跳过谁、哪些是孤儿库），
    /// 而干净那天**形状一个字节都不许变**（老日志/老判据照旧认）。
    ///
    /// **变异**：把 `summary_note` 退回 `format!("size={} skipped={}", …)` ⇒ 后两段红。
    #[test]
    fn the_summary_note_names_the_skipped_spaces_and_the_orphan_dbs() {
        // ① 干净：与旧版逐字相同（多一个空格都算破坏）
        assert_eq!(summary_note(123, &[], &[]), "size=123 skipped=0");

        // ② 有跳过 ⇒ 点名（id 截 8 位），原因原样留着
        let note = summary_note(
            9,
            &["99082b5a-dc25-4712-b2c9-fcff13612e64: 空间是密文但拿不到它的钥匙".to_string()],
            &[],
        );
        assert_eq!(note, "size=9 skipped=1（99082b5a…: 空间是密文但拿不到它的钥匙）");

        // ③ 有孤儿 ⇒ 单独一格点名（⛔ 不混进 skipped：那不是"没备份"，是"界面上看不见"）
        let note = summary_note(
            9,
            &[],
            &[
                "245461d6-1de2-4bf0-a946-8076a93e8053".to_string(),
                "ad6b0daf-zzzz".to_string(),
            ],
        );
        assert_eq!(note, "size=9 skipped=0 孤儿库=2（245461d6…、ad6b0daf…）");
    }

    /// ⭐ **2026-10-25**：`spaces/*.db` 里有、`meta.workspaces` 里**没有行**的 ⇒ 孤儿库
    /// （真机实测：13 个库 / 9 个活空间 ⇒ 4 个孤儿，且它们**每次备份都进包**）。
    ///
    /// **变异**：把 `known` 那个集合改成空 ⇒ 本判据红（全都算孤儿）。
    #[test]
    fn orphan_dbs_are_the_files_without_a_workspace_row() {
        let dir = uniq_tmp("orphan");
        std::fs::create_dir_all(dir.join("spaces")).unwrap();
        let meta = dir.join("meta.db");
        {
            let c = rusqlite::Connection::open(&meta).unwrap();
            c.execute_batch(
                "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', deleted_at INTEGER);
                 INSERT INTO workspaces (id) VALUES ('live-a'), ('live-b');",
            )
            .unwrap();
        }
        for f in ["live-a.db", "live-b.db", "ghost-1.db", "ghost-2.db"] {
            std::fs::write(dir.join("spaces").join(f), b"x").unwrap();
        }
        // `-wal` / `-shm` 不是库文件（⛔ 不许被算成孤儿）
        std::fs::write(dir.join("spaces").join("live-a.db-wal"), b"x").unwrap();
        std::fs::write(dir.join("spaces").join("live-a.db-shm"), b"x").unwrap();

        let got = orphan_space_ids(&meta, &dir.join("spaces")).unwrap();
        assert_eq!(got, vec!["ghost-1".to_string(), "ghost-2".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

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

#[cfg(test)]
mod rekey_tests {
    use super::*;

    /// ⭐ **2026-10-19（owner 真机：恢复备份报 `FOREIGN KEY constraint failed`）**：
    /// 恢复里**重命名**那一支（备份的空间 id 与本机冲突 ⇒ 换新 id）必须：
    /// ① 不报 FK 错；② `pages.workspace_id` **改到新 id**；③ 只留**一行** `workspaces`；
    /// ④ `pragma_foreign_key_check` **零悬空**。
    ///
    /// **变异**：把实现改回 `DELETE FROM workspaces` ＋ `INSERT` ⇒ ① 或 ② 必红。
    #[test]
    fn renaming_an_imported_space_repoints_its_pages_and_keeps_fk_clean() {
        let dir = std::env::temp_dir().join(format!("shuyo-rekey-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        // meta 里先有一行（`create_space_db_at` 里的 ensure_space_workspace 要读它）
        {
            let m = rusqlite::Connection::open(crate::db::meta_path(&dir)).unwrap();
            crate::db::meta_migrate(&m).unwrap();
            m.execute(
                "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('old-id', '旧', 1, 1)",
                [],
            )
            .unwrap();
        }
        crate::db::create_space_db_at(&dir, "old-id").unwrap();

        let c = rusqlite::Connection::open(crate::db::space_db_path(&dir, "old-id")).unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        // 一页挂在这个空间上（FK 生效 ⇒ 旧实现删父行会撞）
        // ⚠️ 只给**非内容列**：内容那两列有默认值，且"直接访问内容列"由
        //    `check-doc-content-access` 管着（只减不增）⇒ ⛔ 测试里也不去碰它们 ✓
        c.execute(
            "INSERT INTO pages (id, workspace_id, title, created_at, updated_at)
             VALUES ('pg-1', 'old-id', '标题', 1, 1)",
            [],
        )
        .unwrap();

        rekey_workspace_from(&c, Some("old-id"), "new-id", "新名字", "blue", "")
            .expect("重命名不该再撞外键");

        let ws: String = c
            .query_row("SELECT workspace_id FROM pages WHERE id = 'pg-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ws, "new-id", "页面没被改到新空间 ⇒ 指向了一个不存在的父");
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "workspaces 应当只有一行");
        let dangling: i64 = c
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dangling, 0, "还有悬空引用");
    }
}
