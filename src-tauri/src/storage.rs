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

/// M14.1 — Storage breakdown for the space-management panel.
#[tauri::command]
pub async fn storage_stats(app: tauri::AppHandle, db: State<'_, Db>) -> Result<StorageStats, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachment_dir = app_data_dir.join("attachments");

    let (trash_count, trash_bytes, version_count, version_bytes, deleted_workspace_count) = {
        let c = db.0.lock().expect("db mutex poisoned");
        let trash_count: i64 = c
            .query_row("SELECT COUNT(*) FROM pages WHERE deleted_at IS NOT NULL", [], |r| r.get(0))
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
            .query_row("SELECT COUNT(*) FROM meta.workspaces WHERE deleted_at IS NOT NULL", [], |r| r.get(0))
            .unwrap_or(0);
        (trash_count, trash_bytes, version_count, version_bytes, deleted_workspace_count)
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
                    if name.starts_with("shuyonote-backup-") || name.starts_with("shuyonote-restore-") {
                        temp_bytes += dir_size(&e.path()).bytes;
                    }
                }
            }
            // leftover .part upload temp files（★ 按空间分之后要**递归**找：`.part` 现在
            // 可能落在 `<根>/<空间>/` 下面，而不是根下）
            for p in crate::attachments::walk_attachment_files(&att_dir2) {
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
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
    Ok(scan_referenced_hashes(&ids, crate::db::open_space_conn)?.into_iter().collect())
}

/// 除 `except_id` 之外**其余空间**的引用集（严格版）。给"先删除行、再回收字节"的命令用：
/// 当前空间那一份由调用方在删完之后自己查（它就在手上，不需要再开一条连接）。
pub(crate) fn other_spaces_referenced_hashes(
    meta: &rusqlite::Connection,
    except_id: &str,
) -> Result<std::collections::HashSet<String>, Vec<String>> {
    let ids: Vec<String> = all_space_ids(meta)?.into_iter().filter(|i| i != except_id).collect();
    Ok(scan_referenced_hashes(&ids, crate::db::open_space_conn)?.into_iter().collect())
}

/// M14.2 — Permanently delete trash (soft-deleted pages) and release their bytes.
#[tauri::command]
pub async fn clear_trash(app: tauri::AppHandle, db: State<'_, Db>) -> Result<u64, String> {    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachment_dir = app_data_dir.join("attachments");

    // Collect trash page ids + candidate hashes while locked.
    let (trash_ids, hashes) = {
        let c = db.0.lock().expect("db mutex poisoned");
        let mut stmt = c.prepare("SELECT id FROM pages WHERE deleted_at IS NOT NULL").map_err(|e| e.to_string())?;
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

    // ★ **动手之前**先把"别的空间还引用着什么"读全（2026-09-20 自查，与 F2 同族）：
    //   读不全（有空间打不开/密钥不符）就**当场失败、一行都不删**。老实现是
    //   `filter_map(open(...).ok())` ＋ `unwrap_or_default()` ⇒ 读不到的空间等于"它不引用任何附件"
    //   ⇒ 与它共享的字节被当孤儿真删，对面出现"行在字节不在"（缺陷帖 #6 同一族）。
    //   当前空间那一份**不在这里扫**：它的行马上要删掉，扫早了会把该释放的字节又算成"还被引用"
    //   （删完之后直接在手上这条连接上查，见下面 `still_referenced`）。
    let (current_space, other_refs) = {
        let c = db.0.lock().expect("db mutex poisoned");
        let current = crate::workspaces::active_workspace_id(&c)?;
        let other = other_spaces_referenced_hashes(&c, &current).map_err(|unreadable| {
            format!(
                "有 {} 个空间当前读不到 ⇒ **无法安全判断哪些附件还有人在用，本次不清理、什么都没删**：\n  - {}",
                unreadable.len(),
                unreadable.join("\n  - ")
            )
        })?;
        (current, other)
    };
    let _ = &current_space;

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
        tx.execute("UPDATE pages SET parent_id = NULL WHERE deleted_at IS NOT NULL", [])
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

    // Determine which hashes are now orphaned (no longer referenced) before releasing the lock.
    // ⚠️ **跨全部空间**来问（见 `referenced_hashes` 的注释）：只查当前空间会把**别的空间**
    // 仍在引用的字节当成孤儿删掉 ⇒ 那边出现「行在字节不在」（2026-09-19 缺陷帖 #6）。
    // 别的空间那一份已经在上面**严格**扫过（读不到就不许往下走）；这里只补当前空间删完行之后的现状。
    let orphaned: std::collections::HashSet<String> = {
        let c = db.0.lock().expect("db mutex poisoned");
        let mut still_referenced = other_refs;
        let mut stmt = c
            .prepare("SELECT DISTINCT hash FROM attachments")
            .map_err(|e| format!("读当前空间的 attachments 失败（{e}）⇒ 字节未回收，附件行已删"))?;
        let own = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| format!("读当前空间的 attachments 失败（{e}）⇒ 字节未回收，附件行已删"))?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| format!("读当前空间的 attachments 失败（{e}）⇒ 字节未回收，附件行已删"))?;
        still_referenced.extend(own);
        hashes.iter().filter(|h| !still_referenced.contains(*h)).cloned().collect()
    };

    // Release bytes off the main thread (no DB needed).
    let att_dir = attachment_dir;
    let freed = tauri::async_runtime::spawn_blocking(move || -> Result<u64, String> {
        let mut freed: u64 = 0;
        for hash in orphaned {
            if let Some(p) = crate::attachments::find_attachment_anywhere(&att_dir, &hash) {
                freed += std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                let _ = std::fs::remove_file(p);
            }
        }
        Ok(freed)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(freed)
}

/// M14.3 — Delete attachment bytes whose hash is referenced by no attachment row.
#[tauri::command]
pub async fn cleanup_orphan_attachments(app: tauri::AppHandle, db: State<'_, Db>) -> Result<u64, String> {
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
            format!(
                "有 {} 个空间当前读不到 ⇒ **无法判断哪些附件是孤儿，本次不删任何附件**：\n  - {}",
                unreadable.len(),
                unreadable.join("\n  - ")
            )
        })?
    };

    let att_dir = attachment_dir;
    let freed = tauri::async_runtime::spawn_blocking(move || -> Result<u64, String> {
        let mut freed: u64 = 0;
        // ★ 递归扫**整棵树**（`<根>/<空间>/<桶>/…` 与老布局都算）：按空间分之后
        //   孤儿可能躺在任何一个空间目录里，"哪些字节没人引用"这条判据本身是全局的。
        for p in crate::attachments::walk_attachment_files(&att_dir) {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
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
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
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

/// M14.4 / M15.4c — Permanently delete soft-deleted workspaces. Under physical
/// isolation each deleted workspace's content lives in its OWN `spaces/<id>.db`,
/// so purging removes that DB file (and WAL) rather than deleting rows from the
/// active DB. The soft-deleted rows come from meta.workspaces. Then any attachment
/// bytes unreferenced by every remaining space's DB are freed (global store).
#[tauri::command]
pub async fn purge_deleted_workspaces(app: tauri::AppHandle, db: State<'_, Db>) -> Result<WorkspacePurgeResult, String> {
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
    let referenced_remaining: std::collections::HashSet<String> =
        tauri::async_runtime::spawn_blocking(move || {
            scan_referenced_hashes(&remaining_for_scan, crate::db::open_space_conn)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|unreadable| {
            format!(
                "有 {} 个存活空间当前读不到 ⇒ **无法判断哪些附件是孤儿，本次不删任何附件**（什么都还没删）：\n  - {}",
                unreadable.len(),
                unreadable.join("\n  - ")
            )
        })?
        .into_iter()
        .collect();

    // For each deleted space, open its DB to collect the hashes it referenced, then
    // delete its DB + WAL files.
    let deleted_for_files = deleted_ids.clone();
    let (hashes_to_free, freed_bytes) = tauri::async_runtime::spawn_blocking(move || -> Result<(Vec<String>, u64), String> {
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
                        Err(e) => eprintln!("清理软删空间 {sid}：读 attachments 失败（{e}）⇒ 这批字节不回收"),
                    },
                    Err(e) => eprintln!("清理软删空间 {sid}：打不开 attachments 表（{e}）⇒ 这批字节不回收"),
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
        Ok(freed)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(WorkspacePurgeResult { freed: freed_bytes + freed_att_bytes, workspaces: deleted_ids.len() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate;
    use rusqlite::Connection;

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
        assert!(scan_referenced_hashes(&empty, |_| Err("不该被调用".into())).unwrap().is_empty());
    }

    #[test]
    fn clear_trash_breaks_parent_fk_before_delete() {
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&c, "w1").unwrap();
        // workspace 'w1' row is seeded by migrate(space_id="w1"); no duplicate insert.
        let page = "INSERT INTO pages (id,workspace_id,parent_id,title,content_json,content_text,kind,sort_order,created_at,updated_at,deleted_at) VALUES (?1,'w1',?2,'t','{}','','page',0,1,1,1)";
        c.execute(page, params!["p", rusqlite::types::Null]).unwrap();
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
        tx.execute("UPDATE pages SET parent_id = NULL WHERE deleted_at IS NOT NULL", []).unwrap();
        // Database page references via database_columns must be cleared too.
        tx.execute("DELETE FROM database_columns WHERE db_page_id = 'db1'", []).unwrap();
        // Delete in a parent-then-child order; must not violate FK.
        tx.execute("DELETE FROM pages WHERE id = 'p'", []).unwrap();
        tx.execute("DELETE FROM pages WHERE id = 'c'", []).unwrap();
        tx.execute("DELETE FROM pages WHERE id = 'db1'", []).unwrap();
        tx.commit().unwrap();

        let n: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
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
            scan_referenced_hashes(&ids, |sid| Ok(build(sid))).unwrap().into_iter().collect();
        assert!(set.contains(H), "跨空间 + 页不可解析都必须算被引用：{set:?}");

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
        assert_eq!(joined, 0, "JOIN 口径下 A 的行应当查不到 —— 这正是缺陷帖 #6 的形态");
    }
}
