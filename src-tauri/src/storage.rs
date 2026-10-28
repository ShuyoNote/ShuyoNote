use crate::db::Db;
use rusqlite::params;
use serde::Serialize;
use std::path::Path;
use tauri::{Manager, State};

#[derive(Serialize, Clone)]
pub struct StorageStats {
    pub db_bytes: i64,
    pub attachment_bytes: i64,
    pub attachment_count: i64,
    pub trash_count: i64,
    pub trash_bytes: i64,
    pub version_count: i64,
    pub version_bytes: i64,
    pub deleted_workspace_count: i64,
    pub temp_bytes: i64,
}

struct DirSize {
    bytes: i64,
    count: i64,
}

fn dir_size(dir: &Path) -> DirSize {
    let mut out = DirSize { bytes: 0, count: 0 };
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                let s = dir_size(&p);
                out.bytes += s.bytes;
                out.count += s.count;
            } else if p.is_file() {
                out.bytes += std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0) as i64;
                out.count += 1;
            }
        }
    }
    out
}

/// ⭐ 2026-10-11（owner 要「把加密空间有没有引用老明文」说死）：⭐ **只读**附件引用体检 ✓。
///
/// ⛔ 为什么**不复用** `scan_referenced_hashes` ✗：⭐ 那条是**删东西的闸** —— 任何空间读不到就**整体失败**
/// （⭐ 那是对的 ✓，⭐ 猜错会**真删** ✓）。⭐ 而体检要的恰恰相反：⭐ **读不到也要把话说出来** ✓。
/// ⇒ ⭐ 所以这里是**宽松版**：⭐ 逐空间记「读到几处引用」／「读不到，因为…」✓，⛔ 不挡任何人 ✓。
///
/// ⚠️ **如实**：它会走应用平时"打开空间"那条路（`open_space_conn` ✓ ⇒ 含**幂等迁移** ✓），
///    但 ⛔ 不删、⛔ 不搬、⛔ 不改任何附件字节 ✓ —— 它是一份**报表** ✓。
#[derive(Serialize, Clone)]
pub struct AttachmentAuditSpace {
    pub name: String,
    pub encrypted: bool,
    pub in_use: bool,
    pub readable: bool,
    pub referenced: i64,
    pub note: String,
}

#[derive(Serialize, Clone)]
pub struct AttachmentAudit {
    pub spaces: Vec<AttachmentAuditSpace>,
    pub legacy_files: i64,
    pub legacy_referenced: i64,
    pub legacy_orphan: i64,
    /// ⭐ **要害**：加密空间引用到的「老布局」文件（每项 `空间名 ／ hash 前 12 位 ／ 字节`）
    pub encrypted_refs_legacy: Vec<String>,
    /// ⭐⭐ **真正要动手的那一份**：加密空间引用、**而且它自己目录里还没有副本** ⇒ ⭐ 它在读老明文 ✗
    pub encrypted_refs_no_private_copy: Vec<String>,
    /// 加密空间引用、但**自己已经有副本**的处数 ✓（⭐ 那些只是"老那份还在"，⭐ 不是在读它 ✓）
    pub encrypted_refs_with_private_copy: i64,
    /// 明文空间引用到的老布局文件处数
    pub plain_refs_legacy: i64,
    /// 读不到的空间 —— ⚠️ 它们的引用**未知** ✓，⛔ 不许写成"没有" ✓
    pub unreadable: Vec<String>,
}

/// 一次扫描的原始料（⭐ 体检与"补副本"**共用同一遍** ⇒ ⛔ 别各扫一遍 ✗，否则两条读数会分家 ✓）
struct ScanFacts {
    spaces: Vec<AttachmentAuditSpace>,
    /// hash ⇒ [(空间 id, 空间名)]（⭐ id 是给"补副本"用的，⭐ 名字是给人看的 ✓）
    refs: std::collections::HashMap<String, Vec<(String, String)>>,
    /// 老布局文件：hash ⇒ (路径, 字节)
    legacy: std::collections::HashMap<String, (std::path::PathBuf, u64)>,
    unreadable: Vec<String>,
}

fn scan_attachment_facts(app_data_dir: &Path, db: &Db) -> Result<ScanFacts, String> {
    let att_root = app_data_dir.join("attachments");

    // ① 空间清单（id ／ 名字 ／ 加密 ／ 是否在用）
    let listed: Vec<(String, String, bool, bool)> = {
        let c = db.0.lock().expect("db mutex poisoned");
        let mut stmt = c
            .prepare("SELECT id, name, encrypted, deleted_at FROM meta.workspaces")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? != 0,
                    r.get::<_, Option<i64>>(3)?.is_none(),
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };

    // ② 逐空间读它引用的 hash（⭐ 宽松：读不到只记原因 ✓）
    let mut spaces = Vec::new();
    let mut refs: std::collections::HashMap<String, Vec<(String, String)>> =
        std::collections::HashMap::new();
    let mut unreadable = Vec::new();
    for (sid, name, encrypted, in_use) in &listed {
        match crate::db::open_space_conn(sid) {
            Ok(c) => {
                let mut n: i64 = 0;
                let mut stmt = c
                    .prepare("SELECT DISTINCT hash FROM attachments")
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                for h in rows.flatten() {
                    if h.is_empty() {
                        continue;
                    }
                    refs.entry(h).or_default().push((sid.clone(), name.clone()));
                    n += 1;
                }
                spaces.push(AttachmentAuditSpace {
                    name: name.clone(),
                    encrypted: *encrypted,
                    in_use: *in_use,
                    readable: true,
                    referenced: n,
                    note: String::new(),
                });
            }
            Err(e) => {
                let note = format!("读不到：{e}");
                unreadable.push(format!("「{name}」：{note}"));
                spaces.push(AttachmentAuditSpace {
                    name: name.clone(),
                    encrypted: *encrypted,
                    in_use: *in_use,
                    readable: false,
                    referenced: 0,
                    note,
                });
            }
        }
    }

    // ③ 老布局文件 ＝ 附件树里**不属于任何空间目录**的那些（⚠️ 跳过 `.part` 临时件 ✓）
    let mut legacy = std::collections::HashMap::new();
    for p in crate::attachments::walk_attachment_files(&att_root) {
        if crate::space_crypto::space_id_from_path(&p).is_some() {
            continue;
        }
        if p.extension().map(|e| e == "part").unwrap_or(false) {
            continue;
        }
        let hash = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let bytes = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        legacy.insert(hash, (p, bytes));
    }

    Ok(ScanFacts {
        spaces,
        refs,
        legacy,
        unreadable,
    })
}

#[tauri::command]
pub async fn audit_attachment_refs(
    app: tauri::AppHandle,
    db: State<'_, Db>,
) -> Result<AttachmentAudit, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let f = scan_attachment_facts(&app_data_dir, &db)?;

    let encrypted_ids: std::collections::HashSet<String> = f
        .spaces
        .iter()
        .filter(|s| s.encrypted)
        .map(|s| s.name.clone())
        .collect();
    let mut legacy_referenced = 0i64;
    let mut plain_refs_legacy = 0i64;
    let mut encrypted_refs_legacy = Vec::new();
    let mut encrypted_refs_no_private_copy = Vec::new();
    let mut encrypted_refs_with_private_copy = 0i64;
    for (hash, (_path, bytes)) in &f.legacy {
        if let Some(who) = f.refs.get(hash) {
            legacy_referenced += 1;
            for (sid, name) in who {
                if encrypted_ids.contains(name) {
                    let has_own = crate::attachments::find_path_by_hash(
                        &crate::attachments::space_attachments_dir(&app_data_dir, sid),
                        hash,
                    )
                    .is_some();
                    let line = format!("「{name}」／{}／{} B", &hash[..hash.len().min(12)], bytes);
                    if has_own {
                        encrypted_refs_with_private_copy += 1;
                    } else {
                        encrypted_refs_no_private_copy.push(line.clone());
                    }
                    encrypted_refs_legacy.push(line);
                } else {
                    plain_refs_legacy += 1;
                }
            }
        }
    }

    Ok(AttachmentAudit {
        spaces: f.spaces,
        legacy_files: f.legacy.len() as i64,
        legacy_referenced,
        legacy_orphan: f.legacy.len() as i64 - legacy_referenced,
        encrypted_refs_legacy,
        encrypted_refs_no_private_copy,
        encrypted_refs_with_private_copy,
        plain_refs_legacy,
        unreadable: f.unreadable,
    })
}

/// ⭐⭐ **甲（owner 2026-10-11 拍板）**：⭐ 给一个空间补一份**它自己的（加密）副本** ✓。
///
/// 为什么不改老布局那份 ✗：⭐ **别的空间还在用它** ✓（⭐ 实测：⭐ 同一份被「工作」和「保险柜」共用 ✓）
/// ⇒ ⭐ 删了就把明文空间弄坏了 ✗ ⇒ ⭐ **只补、不删** ✓（⭐ 多占几 KB，⭐ 换"加密空间不再读明文"✓）。
///
/// ⚠️⭐ **落盘前先核 sha256** ✗：⛔ 不核就写 ＝ 把一份"看起来对"的字节冒充成附件 ✗
///    （⭐ 而附件是**按内容寻址**的 ⇒ ⭐ 写错一次就是永久错 ✓）。核不上 ⇒ **报错、不写** ✓。
/// ⭐ **幂等**：⭐ 它自己目录里已经有了 ⇒ 什么都不做 ✓。
fn adopt_one(
    app_data_dir: &Path,
    space_id: &str,
    hash: &str,
    legacy: &Path,
    keys: &crate::crypto::AppKeys,
) -> Result<bool, String> {
    let data = std::fs::read(legacy).map_err(|e| e.to_string())?;
    let got = crate::dictionary::sha256_hex(&data);
    if !got.eq_ignore_ascii_case(hash) {
        return Err(format!(
            "内容指纹不符（算得 {got}）⇒ ⛔ 不写：⭐ 免得把一份坏字节冒充成附件 ✗"
        ));
    }
    let dir = crate::attachments::space_attachments_dir(app_data_dir, space_id);
    if crate::attachments::find_path_by_hash(&dir, hash).is_some() {
        return Ok(false);
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext = legacy
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_else(|| "bin".to_string());
    let (_p, wrote) =
        crate::attachments::write_attachment_once(&dir, hash, &ext, &data, Some(keys))?;
    Ok(wrote)
}

#[derive(Serialize, Clone)]
pub struct AdoptReport {
    /// 真补了几份
    pub adopted: i64,
    /// 本来就有 ⇒ 跳过几份
    pub already: i64,
    /// 写进去多少字节
    pub bytes: i64,
    /// 补了哪些（`空间名 ／ hash 前 12 位 ／ 字节`）
    pub items: Vec<String>,
    /// 没补成的（⭐ 原因逐条写清 ✓：⭐ 空间没解锁 ／ ⭐ 指纹不符 ／ ⭐ 读不到 ✓）
    pub skipped: Vec<String>,
}

/// ⭐ 甲 的执行者：⭐ 给**每个**"引用老明文却没自己副本"的**加密空间**补一份加密副本 ✓。
/// ⛔ 不删老文件、⛔ 不动明文空间、⛔ 不改任何被引用的字节 ✓。
#[tauri::command]
pub async fn adopt_legacy_refs_for_encrypted_spaces(
    app: tauri::AppHandle,
    db: State<'_, Db>,
) -> Result<AdoptReport, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let f = scan_attachment_facts(&app_data_dir, &db)?;

    let encrypted: std::collections::HashSet<String> = f
        .spaces
        .iter()
        .filter(|s| s.encrypted)
        .map(|s| s.name.clone())
        .collect();
    let mut rep = AdoptReport {
        adopted: 0,
        already: 0,
        bytes: 0,
        items: Vec::new(),
        skipped: Vec::new(),
    };

    // ⚠️ 逐条来：⭐ 一条失败⛔ 不连坐别的 ✓（⭐ 与"删东西的闸"相反：⭐ 这里错了只是少补一份 ✓）
    for (hash, (path, bytes)) in &f.legacy {
        let Some(who) = f.refs.get(hash) else {
            continue;
        };
        for (sid, name) in who {
            if !encrypted.contains(name) {
                continue;
            }
            if crate::attachments::find_path_by_hash(
                &crate::attachments::space_attachments_dir(&app_data_dir, sid),
                hash,
            )
            .is_some()
            {
                rep.already += 1;
                continue;
            }
            // ⭐ 钥匙只从**会话钥匙袋**来 ✓ ⇒ ⭐ 没解锁就如实跳过（⛔ 不猜、⛔ 不先写明文 ✓）
            let dbp = crate::db::space_db_path(&app_data_dir, sid);
            let keys = match crate::space_crypto::space_app_keys_for_path(&dbp) {
                Ok(Some(k)) => k,
                Ok(None) => {
                    rep.skipped.push(format!(
                        "「{name}」／{}：空间未解锁（先打开它再试）",
                        &hash[..hash.len().min(12)]
                    ));
                    continue;
                }
                Err(e) => {
                    rep.skipped.push(format!(
                        "「{name}」／{}：取钥匙失败：{e}",
                        &hash[..hash.len().min(12)]
                    ));
                    continue;
                }
            };
            match adopt_one(&app_data_dir, sid, hash, path, &keys) {
                Ok(true) => {
                    rep.adopted += 1;
                    rep.bytes += *bytes as i64;
                    rep.items.push(format!(
                        "「{name}」／{}／{} B",
                        &hash[..hash.len().min(12)],
                        bytes
                    ));
                }
                Ok(false) => rep.already += 1,
                Err(e) => rep
                    .skipped
                    .push(format!("「{name}」／{}：{e}", &hash[..hash.len().min(12)])),
            }
        }
    }
    Ok(rep)
}

/// M14.1 — Storage breakdown for the space-management panel.
#[tauri::command]
pub async fn storage_stats(
    app: tauri::AppHandle,
    db: State<'_, Db>,
) -> Result<StorageStats, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachment_dir = app_data_dir.join("attachments");

    let (trash_count, trash_bytes, version_count, version_bytes, deleted_workspace_count) = {
        let c = db.0.lock().expect("db mutex poisoned");
        let trash_count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM pages WHERE deleted_at IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let trash_bytes: i64 = c
            .query_row(
                "SELECT COALESCE(SUM(octet_length(content_json) + octet_length(content_text)),0) FROM pages WHERE deleted_at IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let version_count: i64 = c
            .query_row("SELECT COUNT(*) FROM page_versions", [], |r| r.get(0))
            .unwrap_or(0);
        let version_bytes: i64 = c
            .query_row(
                "SELECT COALESCE(SUM(octet_length(content_json) + octet_length(content_text)),0) FROM page_versions",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        // Soft-deleted workspaces live in meta (app-level), not per-space.
        let deleted_workspace_count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM meta.workspaces WHERE deleted_at IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        (
            trash_count,
            trash_bytes,
            version_count,
            version_bytes,
            deleted_workspace_count,
        )
    };

    let att_dir = attachment_dir.clone();
    let tmp = crate::tempdir::root();
    // Physical isolation: DB bytes = sum of all per-space DB files under spaces/.
    let spaces_dir = app_data_dir.join("spaces");
    let att_dir2 = attachment_dir.clone();
    let (db_bytes, attachment_bytes, attachment_count, temp_bytes) =
        tauri::async_runtime::spawn_blocking(move || {
            // Sum every per-space DB file (db + wal + shm) under spaces/.
            let mut db_bytes: i64 = 0;
            if let Ok(entries) = std::fs::read_dir(&spaces_dir) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p.is_file() {
                        db_bytes += std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0) as i64;
                    }
                }
            }
            let att = dir_size(&att_dir);
            let mut temp_bytes: i64 = 0;
            if let Ok(entries) = std::fs::read_dir(&tmp) {
                for e in entries.flatten() {
                    let name = e.file_name().to_string_lossy().into_owned();
                    if name.starts_with("shuyonote-backup-")
                        || name.starts_with("shuyonote-restore-")
                    {
                        temp_bytes += dir_size(&e.path()).bytes;
                    }
                }
            }
            // leftover .part upload temp files（★ 按空间分之后要**递归**找：`.part` 现在
            // 可能落在 `<根>/<空间>/` 下面，而不是根下）
            for p in crate::attachments::walk_attachment_files(&att_dir2) {
                let name = p
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if name.ends_with(".part") {
                    temp_bytes += std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0) as i64;
                }
            }
            (db_bytes, att.bytes, att.count, temp_bytes)
        })
        .await
        .map_err(|e| e.to_string())?;

    Ok(StorageStats {
        db_bytes,
        attachment_bytes,
        attachment_count,
        trash_count,
        trash_bytes,
        version_count,
        version_bytes,
        deleted_workspace_count,
        temp_bytes,
    })
}

/// **仍被引用的附件 hash** —— 附件字节是**全局共享**的内容寻址目录（所有空间同一份），
/// 所以"这个字节还有没有人用"必须**跨全部空间**来问，而且**不许 join `pages`**。
///
/// ⚠️ 这两点是 2026-09-19 社区缺陷帖 #6（GitCode issue #6）的根因：
///   · 旧口径 ①（`clear_trash`）：删完行后在**当前空间**里 `SELECT COUNT(*) FROM attachments WHERE hash=?`
///     ⇒ 别的空间还在引用同一 hash 时，也一样被判成孤儿 ⇒ **字节被删、那边的行还在**；
///   · 旧口径 ②（`purge_deleted_workspaces`）：`attachments a JOIN pages p ON p.id = a.page_id`
///     ⇒ 内连接**漏掉** `page_id IS NULL`（根目录文件）与"页已不在"的历史行 ⇒ 同样误判成孤儿。
/// 结果是对方空间出现「**行在字节不在**」：界面显示「未下载」，而如果那个空间没配同步
/// （服务器上也没有），就**永久不可恢复**。
///
/// 判据只有一句：`SELECT DISTINCT hash FROM attachments`（**不 join、不按 page 过滤**）。
/// `meta.workspaces` 里全部空间 id（含回收站里的空间 —— 它们的行还在，字节就还在被引用）。
///
/// ⚠️ **不许 `unwrap_or_default()`**：读 meta 失败时返回"零个空间"是**最危险**的那种失败 ——
/// 调用方会以为"谁的没被引用" ⇒ 把全部附件都当孤儿（2026-09-20 自查，与 F2 同族）。
fn all_space_ids(meta: &rusqlite::Connection) -> Result<Vec<String>, Vec<String>> {
    let mut stmt = meta
        .prepare("SELECT id FROM meta.workspaces")
        .map_err(|e| vec![format!("读 meta.workspaces 失败（{e}）")])?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| vec![format!("读 meta.workspaces 失败（{e}）")])?;
    rows.collect::<Result<Vec<String>, _>>()
        .map_err(|e| vec![format!("读 meta.workspaces 失败（{e}）")])
}

/// **全空间**引用集（严格版）：任何一个空间读不到 ⇒ `Err`，**绝不静默少扫**。
///
/// 老实现是 `filter_map(|sid| open_space_conn(sid).ok())` ＋ `unwrap_or_default()`
/// ⇒ 少一个空间就等于把"它引用的字节"判成孤儿。清理类命令一旦拿这个集合去"减"，
/// 就会**真删别的空间还在用的附件**（2026-09-19 缺陷帖 #6 的同一族，只是触发条件不同）。
/// 所以这里返回 `Result`，让调用方**在动手之前**决定"读不全就不删"。
pub(crate) fn all_referenced_hashes(
    meta: &rusqlite::Connection,
) -> Result<std::collections::HashSet<String>, Vec<String>> {
    let ids = all_space_ids(meta)?;
    Ok(scan_referenced_hashes(&ids, crate::db::open_space_conn)?
        .into_iter()
        .collect())
}

/// 除 `except_id` 之外**其余空间**的引用集（严格版）。给"先删除行、再回收字节"的命令用：
/// 当前空间那一份由调用方在删完之后自己查（它就在手上，不需要再开一条连接）。
pub(crate) fn other_spaces_referenced_hashes(
    meta: &rusqlite::Connection,
    except_id: &str,
) -> Result<std::collections::HashSet<String>, Vec<String>> {
    let ids: Vec<String> = all_space_ids(meta)?
        .into_iter()
        .filter(|i| i != except_id)
        .collect();
    Ok(scan_referenced_hashes(&ids, crate::db::open_space_conn)?
        .into_iter()
        .collect())
}

/// M14.2 — Permanently delete trash (soft-deleted pages) and release their bytes.
/// 只删**当前空间目录里**那些 hash 的字节；回 `(释放字节, 只在别处有字节的个数)`。
///
/// ⚠️ 为什么"只删自己目录"：附件按空间分（2026-09-24）⇒ 别的空间那份是**另一个文件**，
///    删它没有任何理由；**老布局**（`<根>/<桶>/`）那份更是"不读别的空间就证明不了安全" ⇒
///    `None` 分支**不删**、只计数（交给「整理附件布局」，那里有四道闸门）。
///
/// 抽成独立函数是为了**可判**：`clear_trash` 是 Tauri 命令，挂在命令体里的逻辑判据够不着。
pub(crate) fn release_own_attachment_bytes(
    own_dir: &Path,
    hashes: &std::collections::HashSet<String>,
) -> (u64, usize) {
    let mut freed: u64 = 0;
    let mut kept_elsewhere = 0usize;
    for hash in hashes {
        match crate::attachments::find_path_by_hash(own_dir, hash) {
            Some(p) => {
                freed += std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                let _ = std::fs::remove_file(p);
            }
            None => kept_elsewhere += 1,
        }
    }
    (freed, kept_elsewhere)
}

#[tauri::command]
pub async fn clear_trash(app: tauri::AppHandle, db: State<'_, Db>) -> Result<u64, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    // Collect trash page ids + candidate hashes while locked.
    let (trash_ids, hashes) = {
        let c = db.0.lock().expect("db mutex poisoned");
        let mut stmt = c
            .prepare("SELECT id FROM pages WHERE deleted_at IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let ids: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let mut hashes = Vec::new();
        {
            let mut hs = c
                .prepare("SELECT hash FROM attachments WHERE page_id = ?1")
                .map_err(|e| e.to_string())?;
            for pid in &ids {
                let h = hs
                    .query_map(params![pid], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                hashes.extend(h);
            }
        }
        (ids, hashes)
    };

    // ⭐⭐ **2026-10-25（行为修）**：**不再"跨全部空间读引用"** —— 附件自 2026-09-24 起
    //   按空间分目录（每个空间各存自己那份；同一份内容在两个空间是**两个文件**）
    //   ⇒ 清空**当前空间**的回收站时，只需要问"当前空间还引用不引用"，删除也只删**当前空间目录里**那份。
    //
    //   ⚠️ 老实现为什么要跨全部空间（**两条前提今天都不成立了**）：
    //     ① 那时删字节是 `find_attachment_anywhere(hash)`（全树按 hash 找）⇒ 会删到**别的空间**那份；
    //     ② 那时附件是**全局一份** ⇒ "别的空间引用它"确实等于"这份字节还被别人用"。
    //   ⇒ 现在这两条都不成立，于是"必须打开加密空间才能清空回收站"在这条路径上**是误拦**
    //     （真机：明文空间清回收站被锁着的「保险柜」挡住，用户报 2026-10-25 ✓）。
    //   ⚠️ **老布局**（`<根>/<桶>/`）里的那份这里**不删**：不读别的空间就无法证明它安全
    //     ⇒ 留给「整理附件布局」（那条路有四道闸门）。这条口径对用户是**更安全**的，不是放宽。
    let current_space = {
        let c = db.0.lock().expect("db mutex poisoned");
        crate::workspaces::active_workspace_id(&c)?
    };

    // Delete in a transaction.
    {
        let mut c = db.0.lock().expect("db mutex poisoned");
        let tx = c.transaction().map_err(|e| e.to_string())?;
        // Break parent-child FK links for trash pages (pages.parent_id has no
        // ON DELETE CASCADE and foreign_keys=ON), so deleting in any order
        // won't violate the constraint.
        tx.execute(
            "UPDATE pages SET parent_id = NULL WHERE parent_id IN (SELECT id FROM pages WHERE deleted_at IS NOT NULL)",
            [],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE pages SET parent_id = NULL WHERE deleted_at IS NOT NULL",
            [],
        )
        .map_err(|e| e.to_string())?;
        for pid in &trash_ids {
            for sql in [
                "DELETE FROM page_props WHERE page_id = ?1",
                "DELETE FROM page_tags WHERE page_id = ?1",
                "DELETE FROM page_versions WHERE page_id = ?1",
                "DELETE FROM database_columns WHERE db_page_id = ?1",
                "DELETE FROM backlinks WHERE source_page_id = ?1 OR target_page_id = ?1",
                "DELETE FROM blocks WHERE page_id = ?1",
                "DELETE FROM attachments WHERE page_id = ?1",
                "DELETE FROM page_fts WHERE page_id = ?1",
                "DELETE FROM pages WHERE id = ?1",
            ] {
                tx.execute(sql, params![pid]).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    // 删完行之后，**当前空间**还引用什么（只问这一个空间 ⇒ ⛔ 不需要打开任何别的空间 ✓）。
    // ⚠️ 别再把它和"别的空间的引用集合"并起来：那正是上面刚拆掉的老模型（会要求空间可读）。
    let orphaned: std::collections::HashSet<String> = {
        let c = db.0.lock().expect("db mutex poisoned");
        let mut stmt = c
            .prepare("SELECT DISTINCT hash FROM attachments")
            .map_err(|e| format!("读当前空间的 attachments 失败（{e}）⇒ 字节未回收，附件行已删"))?;
        let own = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| format!("读当前空间的 attachments 失败（{e}）⇒ 字节未回收，附件行已删"))?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| format!("读当前空间的 attachments 失败（{e}）⇒ 字节未回收，附件行已删"))?;
        let still_referenced: std::collections::HashSet<String> = own.into_iter().collect();
        hashes
            .iter()
            .filter(|h| !still_referenced.contains(*h))
            .cloned()
            .collect()
    };

    // Release bytes off the main thread (no DB needed) —— ⭐ **只删当前空间目录里那份**。
    let own_dir = crate::attachments::space_attachments_dir(&app_data_dir, &current_space);
    let freed = tauri::async_runtime::spawn_blocking(move || -> Result<u64, String> {
        let (freed, kept_elsewhere) = release_own_attachment_bytes(&own_dir, &orphaned);
        if kept_elsewhere > 0 {
            eprintln!(
                "[attachments] 清空回收站：{kept_elsewhere} 个哈希只在老布局里有字节 ⇒ 本次**未删**\
                 （留给「整理附件布局」；那里才判断得了别的空间引用）"
            );
        }
        // ⭐ 2026-10-25：删完文件顺手收空目录（否则桶目录只增不减；见 `prune_empty_dirs_under`）
        let pruned = crate::attachments::prune_empty_dirs_under(&own_dir);
        if pruned > 0 {
            eprintln!("[attachments] 清空回收站：顺手回收 {pruned} 个空目录");
        }
        Ok(freed)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(freed)
}

/// ⭐ **清掉孤儿派生行**（`att_id` 已不在 `attachments` 里的 `attachment_text` / `chunks`）。
///
/// 来由（2026-10-02）：那两张表**没有外键** ⇒ 老数据里删掉附件会留下孤儿派生文本 ✓
/// ⇒ 占空间 ✓ 且**可能进检索**（用户搜到已删附件的内容 ✓）。
/// ⚠️ 只清**派生缓存**（`db.rs` 的 DDL 注释写明它"只读、可重建、不进同步/备份/导出" ✓）
///    ⇒ 用户内容**一个字节都不动** ✓。
/// ⚠️ SQL 在 `derived_transport`（那两张表的唯一运输通道 ✓）⇒ 这里只**调**它 ✓。
#[tauri::command]
pub fn cleanup_orphan_derived(db: State<'_, Db>) -> Result<u64, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    let (text_rows, chunk_rows) = crate::derived_transport::clear_orphan_derived(&c)?;
    Ok((text_rows + chunk_rows) as u64)
}

/// M14.3 — Delete attachment bytes whose hash is referenced by no attachment row.
#[tauri::command]
pub async fn cleanup_orphan_attachments(
    app: tauri::AppHandle,
    db: State<'_, Db>,
) -> Result<u64, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachment_dir = app_data_dir.join("attachments");

    // ★ **必须跨全部空间**问"这个字节还有没有人用"（2026-09-20 自查发现这里只查了**当前空间**）：
    //   附件目录是全局共享的内容寻址目录，只按当前空间判断 ⇒ **别的空间仍在引用的字节被删**，
    //   对面出现"行在字节不在"（正是 2026-09-19 缺陷帖 #6 的症状，这里是它的**第三条路径**）。
    //   并且是严格版：任何一个空间读不到 ⇒ 整体失败、**一个字节都不删**（老代码只查当前空间，
    //   根本不会失败，也就永远不会告诉用户"我没法确定"）。
    let referenced: std::collections::HashSet<String> = {
        let c = db.0.lock().expect("db mutex poisoned");
        all_referenced_hashes(&c).map_err(|unreadable| {
            // ⭐ 2026-10-11（owner 选乙）：⭐ 同一句话，⭐ 三处共用 ✓
            unreadable_spaces_message(
                &unreadable,
                &space_name_map(&c, &unreadable),
                "打不开就判断不了哪些附件是孤儿",
            )
        })?
    };

    let att_dir = attachment_dir;
    let freed = tauri::async_runtime::spawn_blocking(move || -> Result<u64, String> {
        let mut freed: u64 = 0;
        // ★ 递归扫**整棵树**（`<根>/<空间>/<桶>/…` 与老布局都算）：按空间分之后
        //   孤儿可能躺在任何一个空间目录里，"哪些字节没人引用"这条判据本身是全局的。
        for p in crate::attachments::walk_attachment_files(&att_dir) {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let stem = name.split('.').next().unwrap_or("").to_string();
            if !stem.is_empty() && !referenced.contains(&stem) {
                freed += std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                let _ = std::fs::remove_file(&p);
            }
        }
        Ok(freed)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(freed)
}

/// M14.4 — Trim page version history to the newest `max_keep` per page.
#[tauri::command]
pub async fn cleanup_old_versions(db: State<'_, Db>, max_keep: Option<i64>) -> Result<i64, String> {
    let keep = max_keep.unwrap_or(50).max(1);
    let c = db.0.lock().expect("db mutex poisoned");
    let n = c
        .execute(
            "DELETE FROM page_versions WHERE rowid NOT IN (
                SELECT rowid FROM (
                    SELECT rowid, ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY created_at DESC, id DESC) AS rn
                    FROM page_versions
                ) WHERE rn <= ?1
            )",
            params![keep],
        )
        .map_err(|e| e.to_string())?;
    Ok(n as i64)
}

/// M14.4 — Delete leftover backup/restore temp dirs and `.part` upload temp files.
#[tauri::command]
pub async fn cleanup_temp_files(app: tauri::AppHandle) -> Result<u64, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachment_dir = app_data_dir.join("attachments");
    let tmp = crate::tempdir::root();
    let att_dir = attachment_dir;
    let freed = tauri::async_runtime::spawn_blocking(move || -> Result<u64, String> {
        let mut freed: u64 = 0;
        if let Ok(entries) = std::fs::read_dir(&tmp) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                // 前缀必须与创建时的 tag 一致（`tempdir::dir/path/file` 传的就是这些）。
                // 原先这里写的是 `shuyonote-backup-`，而导出用的是 `shuyonote-export-`
                // ⇒ 那半条清理**从来没生效过**；临时根现在是应用私有目录，一并列全。
                // 故意不含 `picked/`：选文件复制出来的副本可能还被前端引用着。
                if name.starts_with("shuyonote-export-")
                    || name.starts_with("shuyonote-restore-")
                    || name.starts_with("shuyonote-ws-")
                    || name.starts_with("shuyonote-plugin-")
                {
                    let p = e.path();
                    freed += dir_size(&p).bytes as u64;
                    let _ = std::fs::remove_dir_all(&p);
                }
            }
        }
        // ★ 递归找 `.part`（按空间分之后它们可能在 `<根>/<空间>/` 下）。
        for p in crate::attachments::walk_attachment_files(&att_dir) {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if name.ends_with(".part") {
                freed += std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                let _ = std::fs::remove_file(&p);
            }
        }
        Ok(freed)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(freed)
}

#[derive(Serialize)]
pub struct WorkspacePurgeResult {
    pub freed: u64,
    pub workspaces: usize,
}

/// 扫描一组空间库各自引用的附件 hash（`attachments` 表的 `hash` 列，**不 join `pages`**）。
///
/// ★ 为什么**读不到就报错**、而不是 `if let Ok(conn)` 跳过（2026-09-20 自查发现，
/// 与 F2 同一族：**静默数据丢失比报错坏得多**）：
/// 调用方 `purge_deleted_workspaces` 用"仍被剩余空间引用的 hash"去**减**掉要删的集合。
/// 少扫到一个空间 ⇒ 它引用的附件被当成孤儿 ⇒ **真删盘上文件**（图/附件打不开），
/// 而界面给的是一句绿色的「释放了多少」。空间库读不到的原因很多（文件缺失、半拷贝、
/// 权限、密钥不符），**没有一种是"它不引用任何附件"**。
///
/// 所以：读不到 ⇒ 返回这批 id 与原因，让调用方**一个附件都不删**。
/// 参数用闭包注入打开方式，是为了不依赖全局 APP_DATA_DIR 就能测这条规则。
fn scan_referenced_hashes<F>(ids: &[String], open: F) -> Result<Vec<String>, Vec<String>>
where
    F: Fn(&str) -> Result<rusqlite::Connection, String>,
{
    let mut out: Vec<String> = Vec::new();
    let mut unreadable: Vec<String> = Vec::new();
    for sid in ids {
        match open(sid) {
            Ok(conn) => match conn.prepare("SELECT DISTINCT hash FROM attachments") {
                Ok(mut stmt) => match stmt.query_map([], |r| r.get::<_, String>(0)) {
                    Ok(rows) => out.extend(rows.flatten()),
                    Err(e) => unreadable.push(format!("{sid}: 读 attachments 失败（{e}）")),
                },
                Err(e) => unreadable.push(format!("{sid}: 打不开 attachments 表（{e}）")),
            },
            Err(e) => unreadable.push(format!("{sid}: 打不开空间库（{e}）")),
        }
    }
    if unreadable.is_empty() {
        Ok(out)
    } else {
        Err(unreadable)
    }
}

/// ⭐ 2026-10-11（owner 选**乙**）：⭐ 把"读不到的空间"整段变成**人话** ✓。
///
/// 要点三件（⛔ **一处定义** ⇒ ⭐ 三处提示**必须说同一件事** ✗）：
///   ⭐ ① 点名是**哪个**空间（⭐ 原来只印 UUID ⇒ ⭐ 用户对不上是谁 ✗）
///   ⭐ ② 说清**怎么做**（⭐ 打开它、⭐ 输一次口令 ✓）
///   ⭐ ③ 说清**兜底**（⭐ 在你打开之前**一个字节都不删** ✗ —— ⭐ 这句最关键：
///      让"⭐ 失败 ✗"读起来像**保护** ✓，⛔ 不是坏 ✓）。
///
/// ⚠️ 空间名查不到就**退回印 id** ✗（⭐ 绝不编一个名字 ✓，⭐ 也绝不因此把整条提示变成空话 ✓）。
fn space_name_map(
    c: &rusqlite::Connection,
    unreadable: &[String],
) -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    for line in unreadable {
        // ⚠️ 这里**故意**按第一个 ':' 切一次 —— ⭐ 这些行都是**本文件**自己拼的 `{sid}: …` ✓
        //    （⭐ 产出与消费在同一份文件里 ⇒ ⛔ 不是"跨模块解析字符串" ✗；
        //     ⚠️ 改下面那三个 `push` 的格式时，⛔ 必须同时改这里 ✓）
        let sid = line.split(':').next().unwrap_or_default();
        if sid.is_empty() || m.contains_key(sid) {
            continue;
        }
        if let Ok(nm) = c.query_row(
            "SELECT name FROM meta.workspaces WHERE id = ?1",
            rusqlite::params![sid],
            |r| r.get::<_, String>(0),
        ) {
            m.insert(sid.to_string(), nm);
        }
    }
    m
}

/// ⭐ 拼那条人话提示（⭐ 与 `space_name_map` 配对用 ✓）。`action` 是"⭐ 打不开就判断不了什么 ✗"那半句 ✓。
fn unreadable_spaces_message(
    unreadable: &[String],
    id2name: &std::collections::HashMap<String, String>,
    action: &str,
) -> String {
    let named: Vec<String> = unreadable
        .iter()
        .map(|line| {
            let sid = line.split(':').next().unwrap_or_default();
            match id2name.get(sid) {
                Some(nm) => format!("「{nm}」{}", &line[sid.len()..]),
                None => line.clone(),
            }
        })
        .collect();
    format!(
        "清理需要先打开加密空间。有 {} 个空间当前读不到 ⇒ **本次什么都没删**（{}）：\n  - {}\n⇒ 打开它（输一次口令）再试一次；在你打开之前，我们一个字节都不删。",
        named.len(),
        action,
        named.join("\n  - ")
    )
}

/// M14.4 / M15.4c — Permanently delete soft-deleted workspaces. Under physical
/// isolation each deleted workspace's content lives in its OWN `spaces/<id>.db`,
/// so purging removes that DB file (and WAL) rather than deleting rows from the
/// active DB. The soft-deleted rows come from meta.workspaces. Then any attachment
/// bytes unreferenced by every remaining space's DB are freed (global store).
#[tauri::command]
pub async fn purge_deleted_workspaces(
    app: tauri::AppHandle,
    db: State<'_, Db>,
) -> Result<WorkspacePurgeResult, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachment_dir = app_data_dir.join("attachments");
    let spaces_dir = app_data_dir.join("spaces");

    // Soft-deleted workspace ids from meta.
    let deleted_ids: Vec<String> = {
        let c = db.0.lock().expect("db mutex poisoned");
        let mut stmt = c
            .prepare("SELECT id FROM meta.workspaces WHERE deleted_at IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let rows: Result<Vec<String>, _> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect();
        rows.map_err(|e| e.to_string())?
    };

    // ★ 顺序与严格性（2026-09-20 自查发现，与 F2 同族）：
    //   **先**把"仍被存活空间引用的 hash"扫干净，扫不到就**当场失败、什么都不删**；
    //   **再**删已软删空间的库文件与元数据行。
    //   老代码把这一步放在删除**之后**、且用 `if let Ok(conn)` 静默跳过读不到的空间 ⇒
    //   少扫一个存活空间，它引用的附件就被当成孤儿**真删掉**，界面还报"释放了多少"。
    let remaining_ids: Vec<String> = {
        let c = db.0.lock().expect("db mutex poisoned");
        let mut stmt = c
            .prepare("SELECT id FROM meta.workspaces WHERE deleted_at IS NULL")
            .map_err(|e| e.to_string())?;
        let rows: Result<Vec<String>, _> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect();
        rows.map_err(|e| e.to_string())?
    };
    let remaining_for_scan = remaining_ids.clone();
    // ⭐ 2026-10-11（owner 选乙）：⭐ 空间名要在**进 spawn 之前**取好 ✗ —— ⭐ 那个闭包里没有连接 ✓
    let name_map = {
        let c = db.0.lock().expect("db mutex poisoned");
        space_name_map(&c, &remaining_ids)
    };
    let referenced_remaining: std::collections::HashSet<String> =
        tauri::async_runtime::spawn_blocking(move || {
            scan_referenced_hashes(&remaining_for_scan, crate::db::open_space_conn)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|unreadable| {
            // ⭐ 2026-10-11（owner 选乙）：⭐ 这正是 owner 撞到的那一条 ⇒ ⭐ 现在它会**点名「保险柜」** ✓
            unreadable_spaces_message(&unreadable, &name_map, "打不开就判断不了哪些附件是孤儿")
        })?
        .into_iter()
        .collect();

    // For each deleted space, open its DB to collect the hashes it referenced, then
    // delete its DB + WAL files.
    let deleted_for_files = deleted_ids.clone();
    let (hashes_to_free, freed_bytes) =
        tauri::async_runtime::spawn_blocking(move || -> Result<(Vec<String>, u64), String> {
            let mut freed_bytes: u64 = 0u64;
            let mut released_hashes: Vec<String> = Vec::new();

            for sid in &deleted_for_files {
                // 这些空间**马上要被删掉**，所以读不到只意味着"少回收一些字节"（安全方向），
                // 与上面那条"存活空间读不到 ⇒ 不许删"是两件事，这里保持宽松。
                // ⚠️ 不 join `pages`：内连接会漏掉 `page_id IS NULL`（根目录文件）与
                // "页已不在"的历史行，那些字节会被当成孤儿（2026-09-19 缺陷帖 #6）。
                match crate::db::open_space_conn(sid) {
                    Ok(conn) => match conn.prepare("SELECT DISTINCT hash FROM attachments") {
                        Ok(mut stmt) => match stmt.query_map([], |r| r.get::<_, String>(0)) {
                            Ok(rows) => released_hashes.extend(rows.flatten()),
                            Err(e) => eprintln!(
                                "清理软删空间 {sid}：读 attachments 失败（{e}）⇒ 这批字节不回收"
                            ),
                        },
                        Err(e) => eprintln!(
                            "清理软删空间 {sid}：打不开 attachments 表（{e}）⇒ 这批字节不回收"
                        ),
                    },
                    Err(e) => eprintln!("清理软删空间 {sid}：打不开空间库（{e}）⇒ 这批字节不回收"),
                }
                // Delete the space DB + WAL/shm.
                if !crate::db::is_safe_space_id(sid) {
                    // 纵深防御：id 来源（meta.workspaces）理论上已被写路径校验，但防止
                    // 历史脏数据/二次污染把 `../` id 拼进删除路径（任意文件删）。
                    continue;
                }
                for suffix in ["", "-wal", "-shm"] {
                    let p = spaces_dir.join(format!("{sid}.db{suffix}"));
                    if let Ok(m) = std::fs::metadata(&p) {
                        if m.is_file() {
                            freed_bytes += m.len();
                            let _ = std::fs::remove_file(p);
                        }
                    }
                }
            }

            Ok((released_hashes, freed_bytes))
        })
        .await
        .map_err(|e| e.to_string())??;

    // Remove the soft-deleted meta.workspaces rows (now that their DBs are gone).
    {
        let c = db.0.lock().expect("db mutex poisoned");
        for sid in &deleted_ids {
            c.execute("DELETE FROM meta.workspaces WHERE id = ?1", params![sid])
                .map_err(|e| e.to_string())?;
        }
    }

    // Free orphaned attachment bytes: hashes referenced ONLY by deleted spaces.
    // `referenced_remaining` 已经在**删除之前**严格扫过（读不到就整体失败）—— 见上面的注释。

    let orphaned: Vec<String> = hashes_to_free
        .into_iter()
        .filter(|h| !referenced_remaining.contains(h))
        .collect();

    let att_dir = attachment_dir;
    let freed_att_bytes = tauri::async_runtime::spawn_blocking(move || -> Result<u64, String> {
        let mut freed: u64 = 0;
        for hash in orphaned {
            if let Some(p) = crate::attachments::find_attachment_anywhere(&att_dir, &hash) {
                freed += std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                let _ = std::fs::remove_file(p);
            }
        }
        // ⭐ 2026-10-25：删完文件顺手收空目录（否则桶目录只增不减；见 `prune_empty_dirs_under`）
        let pruned = crate::attachments::prune_empty_dirs_under(&att_dir);
        if pruned > 0 {
            eprintln!("[attachments] 清理孤立附件：顺手回收 {pruned} 个空目录");
        }
        Ok(freed)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(WorkspacePurgeResult {
        freed: freed_bytes + freed_att_bytes,
        workspaces: deleted_ids.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate;
    use rusqlite::Connection;

    /// ⭐⭐ **2026-10-25**：清空回收站**只删当前空间目录里那份** —— 老布局与别的空间那份一个字节都不许动。
    ///
    /// 真机来由：明文空间清回收站被锁着的「保险柜」挡下（"清理需要先打开加密空间"）——
    /// 那条拦的是**旧模型**（全局一份 ＋ 按 hash 全树删）；按空间分之后它既没必要、也不安全（会删到别人那份）。
    ///
    /// **变异**：把 `find_path_by_hash(own_dir, …)` 换回 `find_attachment_anywhere(root, …)` ⇒
    /// 老布局那份会被删 ⇒ 第二条断言红。
    #[test]
    fn clearing_trash_only_releases_bytes_inside_the_current_space_dir() {
        let app = std::env::temp_dir().join(format!("shuyo-trash-scope-{}", uuid::Uuid::new_v4()));
        let own = crate::attachments::space_attachments_dir(&app, "sp-mine");
        let other = crate::attachments::space_attachments_dir(&app, "sp-other");
        let root = crate::attachments::attachments_root(&app);
        let mine: &[u8] = b"MINE";
        let hash = crate::dictionary::sha256_hex(mine);
        let bucket = &hash[..2];
        // 自己那份、别的空间那份、老布局那份 —— 三处同 hash
        for d in [&own, &other, &root] {
            std::fs::create_dir_all(d.join(bucket)).unwrap();
            std::fs::write(d.join(bucket).join(format!("{hash}.png")), mine).unwrap();
        }
        // 只在老布局里有的第二个 hash
        let legacy_only = crate::dictionary::sha256_hex(b"LEGACY");
        std::fs::write(
            root.join(bucket).join(format!("{legacy_only}.png")),
            b"LEGACY",
        )
        .unwrap();

        let hashes: std::collections::HashSet<String> =
            [hash.clone(), legacy_only.clone()].into_iter().collect();
        let (freed, kept_elsewhere) = release_own_attachment_bytes(&own, &hashes);

        assert_eq!(freed, mine.len() as u64, "只该释放自己那份的字节");
        assert!(
            crate::attachments::find_path_by_hash(&own, &hash).is_none(),
            "自己那份该删掉"
        );
        assert!(
            crate::attachments::find_path_by_hash(&other, &hash).is_some(),
            "⛔ 别的空间那份不许动（那是另一个文件）"
        );
        assert!(
            crate::attachments::find_path_by_hash(&root, &hash).is_some(),
            "⛔ 老布局那份不许动（不读别的空间就证明不了安全）"
        );
        assert_eq!(
            kept_elsewhere, 1,
            "只在老布局里的那个要记数（留给「整理附件布局」）"
        );
        let _ = std::fs::remove_dir_all(&app);
    }

    // ⭐⭐ **2026-10-11（owner 拍「甲」）**：⭐ 补副本的合同 —— 四条判据，⭐ 全都钉**结果** ✓：
    //    ⭐ ① 补出来的那份**必须是密文** ✗（⛔ 不是把明文抄一份 ✓）
    //    ⭐ ② 而且**解得回原字节** ✓（⛔ "随便加密一下"不算 ✓）
    //    ⭐ ③ ⭐ ⭐ **老布局那份一个字节都不许动** ✗（⭐ 「工作」还在用它 ✓ —— ⭐ 这是"甲"的要害 ✓）
    //    ⭐ ④ **幂等** ✓ ＋ ⭐ **指纹不符 ⇒ 报错且什么都不写** ✗（⭐ 这条挡的是"把坏字节冒充成附件"✓）
    #[test]
    fn adopt_writes_an_encrypted_copy_and_leaves_the_legacy_one_alone() {
        let app = std::env::temp_dir().join(format!("shuyo-adopt-{}", uuid::Uuid::new_v4()));
        let legacy_dir = app.join("attachments").join("9f");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        let plain: Vec<u8> = b"\x89PNG\r\n\x1a\nADOPT-ME".to_vec();
        let hash = crate::dictionary::sha256_hex(&plain);
        let legacy = legacy_dir.join(format!("{hash}.png"));
        std::fs::write(&legacy, &plain).unwrap();

        let keys = crate::crypto::AppKeys::legacy_only([9u8; 32]);
        assert!(
            adopt_one(&app, "space-enc", &hash, &legacy, &keys).unwrap(),
            "第一次应当真写一份 ✓"
        );

        let own_dir = crate::attachments::space_attachments_dir(&app, "space-enc");
        let own = crate::attachments::find_path_by_hash(&own_dir, &hash)
            .expect("补完之后它自己目录里必须找得到");
        let raw = std::fs::read(&own).unwrap();
        assert_ne!(
            raw, plain,
            "⭐ 补的这份必须是**密文** ✗（⛔ 不是把明文抄一份 ✓）"
        );
        assert!(
            crate::security::decrypt_attachment_bytes(Some(&keys), &raw).unwrap() == plain,
            "⭐ 而且必须解得回原字节 ✓"
        );
        assert!(
            std::fs::read(&legacy).unwrap() == plain,
            "⭐⭐ 老布局那份**一个字节都不许动** ✗ —— 「工作」还在用它 ✓"
        );

        assert!(
            !adopt_one(&app, "space-enc", &hash, &legacy, &keys).unwrap(),
            "⭐ 幂等：已经有了 ⇒ 再跑不写 ✓"
        );

        // ⭐ 指纹不符 ⇒ ⛔ **不写**（⭐ 挡"把坏字节冒充成附件"✓）
        let bogus = "0".repeat(64);
        let tampered = legacy_dir.join(format!("{bogus}.png"));
        std::fs::write(&tampered, b"\x89PNG\r\n\x1a\nTAMPERED").unwrap();
        assert!(
            adopt_one(&app, "space-enc2", &bogus, &tampered, &keys).is_err(),
            "⛔ 指纹不符必须报错 ✗"
        );
        assert!(
            crate::attachments::find_path_by_hash(
                &crate::attachments::space_attachments_dir(&app, "space-enc2"),
                &bogus
            )
            .is_none(),
            "⛔ 指纹不符 ⇒ 它目录里**不许**出现任何东西 ✗"
        );

        let _ = std::fs::remove_dir_all(&app);
    }

    // ⭐⭐ **2026-10-11（owner 选乙）**：那条「读不到」的提示必须**说人话** ——
    //    ⭐ ① 点名**哪个空间**（⛔ 不是一串 UUID ✗）② 说清**怎么做**（⭐ 打开它、⭐ 输一次口令 ✓）
    //    ③ 说清**兜底**（⭐ 一个字节都不删 ✓ —— ⭐ 让"失败"读起来像**保护** ✓）
    //    ＋ ⭐ 名字查不到时**退回印 id** ✓（⛔ 绝不编一个名字 ✗、⛔ 也绝不把整条提示变成空话 ✓）。
    #[test]
    fn unreadable_message_names_the_space_and_says_what_to_do() {
        let sid = "99082b5a-dc25-4712-b2c9-fcff13612e64";
        let lines = vec![format!("{sid}: 打不开空间库（file is not a database）")];
        let mut m = std::collections::HashMap::new();
        m.insert(sid.to_string(), "保险柜".to_string());
        let msg = unreadable_spaces_message(&lines, &m, "打不开就判断不了哪些附件是孤儿");
        assert!(
            msg.contains("保险柜"),
            "⭐ 必须点名是哪个空间 —— 只说 UUID 用户对不上 ✗：{msg}"
        );
        assert!(
            !msg.contains(sid),
            "⭐ 名字查到了就不该再印那串 id ✗：{msg}"
        );
        assert!(
            msg.contains("打开它") && msg.contains("输一次口令"),
            "⭐ 得说清怎么做 ✗：{msg}"
        );
        assert!(
            msg.contains("一个字节都不删"),
            "⭐ 得说清兜底（让失败读起来像保护）✗：{msg}"
        );

        // ⭐ 反向：名字查不到 ⇒ **如实退回印 id** ✓
        let msg2 = unreadable_spaces_message(
            &lines,
            &std::collections::HashMap::new(),
            "打不开就判断不了哪些附件是孤儿",
        );
        assert!(msg2.contains(sid), "⭐ 查不到名字就得如实印 id ✗：{msg2}");
        assert!(
            msg2.contains("一个字节都不删"),
            "⭐ 即便查不到名字，兜底那句也必须在 ✗：{msg2}"
        );
    }

    // ★ 清理软删空间时"存活空间读不到 ⇒ 一个附件都不许删"（2026-09-20 自查发现的**静默数据丢失**）。
    // 老代码写成 `if let Ok(conn)` ⇒ 少扫一个存活空间，它引用的附件被当孤儿**真删**。
    #[test]
    fn purge_refuses_to_guess_when_a_live_space_is_unreadable() {
        let mk = |hashes: &[&str]| -> Connection {
            let c = Connection::open_in_memory().unwrap();
            migrate(&c, "w1").unwrap();
            for h in hashes {
                c.execute(
                    "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at) VALUES (?1, NULL, 'f', ?2, 'text/plain', 1, 1)",
                    params![format!("a-{h}"), h],
                )
                .unwrap();
            }
            c
        };

        let ids: Vec<String> = vec!["live-a".into(), "live-b".into()];

        // ① 都读得到 ⇒ 取并集。
        let open_ok = |sid: &str| -> Result<Connection, String> {
            Ok(match sid {
                "live-a" => mk(&["h1", "h2"]),
                _ => mk(&["h2", "h3"]),
            })
        };
        let mut got = scan_referenced_hashes(&ids, open_ok).unwrap();
        got.sort();
        got.dedup(); // 跨空间可能重复（调用方收进 HashSet）；这里只看并集对不对
        assert_eq!(got, vec!["h1", "h2", "h3"]);

        // ② 有一个读不到 ⇒ **整体失败**，且**一个 hash 都不返回**（调用方据此不删任何附件）。
        let open_partial = |sid: &str| -> Result<Connection, String> {
            if sid == "live-b" {
                return Err("数据库已加密但会话未解锁".to_string());
            }
            Ok(mk(&["h1"]))
        };
        let err = scan_referenced_hashes(&ids, open_partial).unwrap_err();
        assert_eq!(err.len(), 1, "{err:?}");
        assert!(err[0].starts_with("live-b:"), "{}", err[0]);
        assert!(err[0].contains("未解锁"), "{}", err[0]);

        // ③ 空集合 ⇒ Ok(空)，不把"没有空间"误判成失败。
        let empty: Vec<String> = vec![];
        assert!(scan_referenced_hashes(&empty, |_| Err("不该被调用".into()))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn clear_trash_breaks_parent_fk_before_delete() {
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&c, "w1").unwrap();
        // workspace 'w1' row is seeded by migrate(space_id="w1"); no duplicate insert.
        let page = "INSERT INTO pages (id,workspace_id,parent_id,title,content_json,content_text,kind,sort_order,created_at,updated_at,deleted_at) VALUES (?1,'w1',?2,'t','{}','','page',0,1,1,1)";
        c.execute(page, params!["p", rusqlite::types::Null])
            .unwrap();
        c.execute(page, params!["c", "p"]).unwrap();
        // A database page with a column referencing it (FK via database_columns).
        c.execute(
            "INSERT INTO pages (id,workspace_id,parent_id,title,content_json,content_text,kind,sort_order,created_at,updated_at,deleted_at) VALUES ('db1','w1',NULL,'db','{}','','database',0,1,1,1)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO attr_defs (id,name,type,options,created_at,updated_at) VALUES ('a1','test','text','[]',1,1)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO database_columns (db_page_id, attr_id, sort_order) VALUES ('db1','a1',0)",
            [],
        )
        .unwrap();

        let tx = c.transaction().unwrap();
        // Break parent-child FK links (clear_trash / purge_deleted_workspaces pattern).
        tx.execute(
            "UPDATE pages SET parent_id = NULL WHERE parent_id IN (SELECT id FROM pages WHERE deleted_at IS NOT NULL)",
            [],
        )
        .unwrap();
        tx.execute(
            "UPDATE pages SET parent_id = NULL WHERE deleted_at IS NOT NULL",
            [],
        )
        .unwrap();
        // Database page references via database_columns must be cleared too.
        tx.execute("DELETE FROM database_columns WHERE db_page_id = 'db1'", [])
            .unwrap();
        // Delete in a parent-then-child order; must not violate FK.
        tx.execute("DELETE FROM pages WHERE id = 'p'", []).unwrap();
        tx.execute("DELETE FROM pages WHERE id = 'c'", []).unwrap();
        tx.execute("DELETE FROM pages WHERE id = 'db1'", [])
            .unwrap();
        tx.commit().unwrap();

        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    /// 判据（2026-09-19 缺陷帖 #6 / GitCode issue #6）：**"谁还被引用"必须跨空间、且不看 `pages`**。
    ///
    /// 反例（这条判据要能抓住）：把口径换成 `attachments a JOIN pages p ON p.id = a.page_id`，
    /// 下面两条"页不可解析"的行都会从集合里消失 ⇒ 它们的字节会被当成孤儿删掉，
    /// 而**另一侧空间的行还在** ⇒ 用户看到「行在字节不在」。
    #[test]
    fn referenced_hashes_counts_rows_whose_page_is_gone_or_null() {
        const H: &str = "f2534c73fa62c0a6e0e5b6c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";
        // 两个空间各建一行，**同样走生产路径唯一的那条扫描函数**（按 id 现建连接）。
        let build = |sid: &str| -> Connection {
            let c = Connection::open_in_memory().unwrap();
            migrate(&c, sid).unwrap();
            // A：附件行指向一个**不存在**的页（页被永久删除后的残留 / 历史脏数据）
            // B：同一个 hash，page_id 为空（根目录文件）
            let page: Option<&str> = if sid == "a" { Some("gone") } else { None };
            let id = if sid == "a" { "x1" } else { "x2" };
            c.execute(
                "INSERT INTO attachments (id,page_id,name,hash,mime,size,created_at) \
                 VALUES (?1,?2,'n',?3,'image/png',1,1)",
                params![id, page, H],
            )
            .unwrap();
            c
        };
        let ids = vec!["a".to_string(), "b".to_string()];
        let set: std::collections::HashSet<String> =
            scan_referenced_hashes(&ids, |sid| Ok(build(sid)))
                .unwrap()
                .into_iter()
                .collect();
        assert!(
            set.contains(H),
            "跨空间 + 页不可解析都必须算被引用：{set:?}"
        );

        // 反例守卫：换成 `JOIN pages ON p.id = a.page_id` 的旧口径 ⇒ 两行都会消失。
        // 这里直接断言"不 join 才拿得到"，把口径钉在函数里（改回去这条就红）。
        let c = build("a");
        let joined: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM attachments a JOIN pages p ON p.id = a.page_id WHERE a.hash = ?1",
                params![H],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            joined, 0,
            "JOIN 口径下 A 的行应当查不到 —— 这正是缺陷帖 #6 的形态"
        );
    }
}
