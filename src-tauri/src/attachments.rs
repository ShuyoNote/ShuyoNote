use crate::db::{now_ms, Db};
use crate::models::{AttachmentMeta, AttachmentRow};
use crate::sync::record_change;
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager, State};

/// Lowercase-hex a byte slice (sha2 0.11's `Output` no longer implements
/// `LowerHex`, so we format it ourselves).
fn hex_of(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Content-addressed attachment hashes are SHA-256 (32 bytes → 64 lowercase hex).
/// Validating an IPC-supplied hash before joining it into a filesystem path
/// prevents a caller from writing outside the attachments dir via `../../evil`.
fn is_valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())
}

/// Bucket dir name = the first two hex chars of the hash (64-hex SHA-256).
/// Split into 256 subdirectories so a single attachments dir never grows unbounded
/// (avoids O(N) scans and per-dir dentry pressure).
fn bucket_of(hash: &str) -> &str {
    // hash is validated 64-hex elsewhere; guard defensively against short/non-hex.
    if hash.len() >= 2 { &hash[0..2] } else { "_" }
}

/// New content-addressed path: `attachments/<hash[0..2]>/<hash>.<ext>`.
/// Keeping the extension on the on-disk filename means the file is a real,
/// OS-openable path (so `openPath`/`revealFile`/asset protocol all work); the
/// extension also mirrors the DB `mime` so it stays consistent. Bucketing by the
/// first two hex chars keeps a single attachment dir from growing unbounded.
fn bucket_path(attachments_dir: &Path, hash: &str, ext: &str) -> PathBuf {
    attachments_dir.join(bucket_of(hash)).join(format!("{hash}.{ext}"))
}

/// Locate an attachment's bytes by hash. New layout (`attachments/<bucket>/<hash>.<ext>`)
/// is tried first (O(1) when the extension is known); if absent we fall back to
/// scanning the bucket dir (and then the legacy flat dir) comparing the hash stem,
/// so pre-bucket data keeps working (dual-read compat; we don't auto-migrate/delete).
pub(crate) fn find_path_by_hash(dir: &Path, hash: &str) -> Option<PathBuf> {
    // 1. Bucket dir, exact ext match (fast path).
    if let Ok(entries) = std::fs::read_dir(dir.join(bucket_of(hash))) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(stem) = name.split('.').next() {
                if stem == hash {
                    return Some(entry.path());
                }
            }
        }
    }
    // 2. Legacy flat dir.
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

/// 附件树的**根**（所有空间共用这一棵树）：`<app_data>/attachments`。
pub(crate) fn attachments_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("attachments")
}

/// 某个空间的附件目录：`<根>/<空间 id>`。
///
/// ★★ owner 2026-09-24 拍板（②）：附件库**按空间分**。hash 仍按**明文**算（空间内去重照旧），
/// 但**每个空间各存自己那一份**。为什么必须分：附件原来是**全局一份**，而钥匙从"应用级一把"
/// 改成"按空间"之后，同一份内容被"**一个加密空间 ＋ 一个明文空间**"同时引用时，
/// 谁先落盘谁决定那份字节是密文还是明文 —— 后读的那一方拿不到写它那把钥匙，解不开会被
/// **透传**（安静地交出一个坏文件）。分空间之后每个空间只读自己那份，这条缺口就不存在了。
/// 代价是**跨空间去重没了**，而那正是决策稿 §5.1 早就写下的取舍。
///
/// ⚠️ 空间 id 进路径前必须过 `db::is_safe_space_id`（挡 `../` 之类）；不合法 ⇒ 落到 `_invalid`，
/// **绝不**拼出树外的路径。
pub(crate) fn space_attachments_dir(app_data_dir: &Path, space_id: &str) -> PathBuf {
    let safe = if crate::db::is_safe_space_id(space_id) { space_id } else { "_invalid" };
    attachments_root(app_data_dir).join(safe)
}

/// 当前（活动）空间的 id；拿不到就退回空串（＝落到"根"，即老布局）—— **绝不 panic**。
pub(crate) fn active_space_id(c: &rusqlite::Connection) -> String {
    crate::workspaces::active_workspace_id(c).unwrap_or_default()
}

/// **读**一个空间的附件：先在这个空间**自己**的目录里找，找不到再回退到**老的全局布局**
/// （`<根>/<桶>/…` 与 `<根>/<hash>.<ext>`）。
///
/// ⚠️ 老文件**不搬**（owner 拍板）：纯位置回退，不涉及密钥、不静默降级 ⇒
/// 升级之后你原来那些附件照样读得到，一个文件都不用动。
pub(crate) fn find_attachment(app_data_dir: &Path, space_id: &str, hash: &str) -> Option<PathBuf> {
    find_path_by_hash(&space_attachments_dir(app_data_dir, space_id), hash)
        .or_else(|| find_path_by_hash(&attachments_root(app_data_dir), hash))
}

/// 在**整棵附件树**里按 hash 找（**不知道空间**的只读场景：存储统计/清理/按 hash 定位）。
/// 先看各空间目录（目录名排序，结果稳定），再看根下的老布局。
pub(crate) fn find_attachment_anywhere(root: &Path, hash: &str) -> Option<PathBuf> {
    if let Ok(entries) = std::fs::read_dir(root) {
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        for d in dirs {
            if let Some(p) = find_path_by_hash(&d, hash) {
                return Some(p);
            }
        }
    }
    find_path_by_hash(root, hash)
}

/// 递归列出附件树里的**所有文件**（三种布局都算：`<根>/<空间>/<桶>/f`、`<根>/<桶>/f`、`<根>/f`）。
/// 给"不知道空间"的那些路径用：存储统计 / 孤儿清理 / 临时文件清理。
pub(crate) fn walk_attachment_files(root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.is_file() {
                out.push(p);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, &mut out);
    out
}

#[derive(Clone, serde::Serialize)]
pub struct ImportProgress {
    pub index: usize,
    pub total: usize,
    pub name: String,
    pub done: u64,
    pub size: u64,
}

/// 我们"不知道这是什么"的那个 mime。`rename_attachment` 用它区分"已知类型"与"未知"。
pub(crate) const GENERIC_MIME: &str = "application/octet-stream";

/// `ext_from_mime` 的 `Option` 版：`None` = **这张表里没有**这个 mime
/// （而不是"它就叫 `.bin`"）。`mime_and_ext` 需要区分这两件事。
fn ext_from_mime_opt(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "application/pdf" => Some("pdf"),
        _ => None,
    }
}

fn ext_from_mime(mime: &str) -> &'static str {
    ext_from_mime_opt(mime).unwrap_or("bin")
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

/// 决定这次导入的 `(mime, ext)`。三层，逐层变弱——**桌面恒走 ①（或它的兜底）**，
/// 所以桌面行为与改这行之前逐字节一致。
///
/// ① **扩展名表**（[`mime_from_path`]）**认得**这个扩展名时就用它。
///    为什么它排在"系统说的 mime"前面：那张表是**我们自己的规范词汇**，
///    前端的 `mime === "text/markdown"` / `=== "application/pdf"` / `startsWith("image/")`
///    这些分支就是按它写的。而 `ContentResolver.getType` 可能给 `text/x-markdown`、
///    `image/x-png` 这类**非规范写法** —— 让它抢在前面会把前端**认得的**类型换成
///    **认不得的**，那是把 bug 换个方向（`.md` 的内置预览会消失）。
/// ② **系统说的 mime**（Android `ContentResolver.getType(uri)`）：扩展名表**不认识**
///    这个扩展名（含"根本没有扩展名"= Android 上那批裸 UUID）时的权威来源。
/// ③ **内容嗅探**（[`crate::magic`]）：连系统都问不到时兜底。这一层不依赖任何 Android
///    专属代码，所以"图片能预览、PDF 能进内置阅读器"能在本机单测里钉住。
///
/// 落盘扩展名 `ext` 的原则：**名字/嗅探给了就用它**（它决定
/// `attachments/<bucket>/<hash>.<ext>` 的文件名），只有完全没有时才退到
/// `ext_from_mime`（再不行 `bin`）。
fn mime_and_ext(
    src: &Path,
    system_mime: Option<&str>,
    sniffed: Option<crate::magic::Magic>,
) -> (String, String) {
    let (ext_mime, ext) = mime_from_path(src);

    if ext_mime != GENERIC_MIME {
        return (ext_mime, ext);
    }
    if let Some(sys_mime) = system_mime {
        let ext = if ext == "bin" {
            ext_from_mime(sys_mime).to_string()
        } else {
            ext
        };
        return (sys_mime.to_string(), ext);
    }
    if let Some(m) = sniffed {
        return (m.mime.to_string(), m.ext.to_string());
    }
    (ext_mime, ext)
}

/// 改名时按新名字重算 mime（语义见 [`rename_attachment`] 的文档）。
///
/// 判据只有一条：**新名字认得出类型就用它，认不出就原样保留**。
/// `mime_from_path` 认不出时给的是 `GENERIC_MIME`（`application/octet-stream`），
/// 那一支**不写回** —— 这是"永远不降级"的全部秘密：
///
/// - `report.pdf` → `report`（或 `report.unknownext`）：认不出 ⇒ 保留 `application/pdf`，
///   **PDF 阅读器不会被改名弄丢**；
/// - `x.txt` → `x.pdf`：认得出 ⇒ `application/pdf`，改名后就能进内置阅读器；
/// - 老数据（裸 UUID 名 + octet-stream，Android 导入那批）→ `photo.png`：认得出 ⇒ `image/png`，
///   用户靠改名**能自救**。
fn repaired_mime(current: &str, new_name: &str) -> String {
    let (mime, _) = mime_from_path(Path::new(new_name));
    if mime == GENERIC_MIME {
        current.to_string()
    } else {
        mime
    }
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
    Ok((hex_of(&hasher.finalize()), size))
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
    let c = db.0.lock().expect("db mutex poisoned");
    let (name, hash, mime, size): (String, String, String, i64) = c
        .query_row(
            "SELECT name, hash, mime, size FROM attachments WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|_| "附件不存在".to_string())?;
    // ★ 按空间找（`<根>/<空间>/…`），老位置（全局那份）仍回退得动。
    let path = find_attachment(&app_data_dir, &active_space_id(&c), &hash)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(AttachmentMeta { id, name, hash, mime, size, path })
}

/// 按 hash 在**某个目录**里把文件读出来（"找路径 + 读字节 + 出错怎么说"三件事的纯函数）。
/// ⚠️ 生产路径现在走 [`read_attachment_bytes_at`]（按空间 + 老位置回退）；这一条**只剩判据在用**
/// （它把"桶布局/扁平布局/找不到"三种形态钉在一处）。
#[cfg(test)]
pub(crate) fn read_bytes_at(dir: &Path, hash: &str) -> Result<Vec<u8>, String> {
    let path = find_path_by_hash(dir, hash).ok_or_else(|| {
        // 说清是"文件不在盘上"，而不是笼统的"读取失败"：这一条最常见的成因是
        // 外部把文件删了/移走了，而数据库里那行还在。
        "附件文件不存在（可能被移动或删除）".to_string()
    })?;
    std::fs::read(&path).map_err(|e| format!("读取附件失败：{e}"))
}

/// **按空间**读字节：先本空间目录，再回退老位置（老库升级后仍然读得到）。
pub(crate) fn read_attachment_bytes_at(
    app_data_dir: &Path,
    space_id: &str,
    hash: &str,
) -> Result<Vec<u8>, String> {
    let path = find_attachment(app_data_dir, space_id, hash).ok_or_else(|| {
        "附件文件不存在（可能被移动或删除）".to_string()
    })?;
    std::fs::read(&path).map_err(|e| format!("读取附件失败：{e}"))
}

#[tauri::command]
pub fn save_image(app: tauri::AppHandle, db: State<'_, Db>, args: SaveImageArgs) -> Result<AttachmentMeta, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // ★ 写入位置与钥匙都**按空间**（两者必须在同一把锁里取，免得中间空间被切走）。
    let (space, key) = {
        let c = db.0.lock().expect("db mutex poisoned");
        (active_space_id(&c), crate::security::key_if_enabled(&c))
    };
    let attachments_dir = space_attachments_dir(&app_data_dir, &space);
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

    // Content-addressed storage: filename = sha256 + ext inside a 2-char bucket dir.
    let mut hasher = Sha256::new();
    hasher.update(&args.data);
    let hash = hex_of(&hasher.finalize());
    let ext = ext_from_mime(&args.mime);
    let path = bucket_path(&attachments_dir, &hash, ext);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Dedup: write only if not already present **in this space**, encrypting at rest when this
    // space is encrypted+unlocked (the hash is over the PLAINTEXT, so dedup still works).
    //
    // ★ owner 第三轮拍板（2026-09-24）：钥匙**按空间**取（`key_if_enabled` ⇒ `space_crypto`）。
    // ★ owner 2026-09-24 拍板（②）：**去重也按空间** —— 去重只查本空间自己那份，
    //   于是"加密空间 ＋ 明文空间引用同一份内容"不再互相踩（各自留各自那份）。
    //   ⚠️ 刻意**不**把老位置（全局那份）算进去：算了就会跳过写入，让一个加密空间继续
    //   读着老位置的**明文**副本 —— 那是"加密空间里躺着明文"的静默形态。
    if !path.exists() {
        let bytes = crate::security::encrypt_attachment_bytes(key.as_ref(), &args.data)?;
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
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
    let filename = format!("{hash}.{ext}");
    let name = args.name.unwrap_or_else(|| filename.clone());
    let size = args.data.len() as i64;
    c.execute(
        "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, args.page_id, name, hash, args.mime, size, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    // Sync the attachment row metadata (bytes transfer separately via sync_attachments).
    let now = now_ms();
    let payload = serde_json::json!({ "id": &id, "page_id": &args.page_id, "name": &name, "hash": &hash, "mime": &args.mime, "size": size }).to_string();
    record_change(&c, "attachment", &id, "upsert", Some(&payload), now)?;

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
pub fn attachment_path(app: tauri::AppHandle, db: State<'_, Db>, hash: String) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // ★ 按空间找（老位置仍回退）。⚠️ **不做**"满树乱找"：别的空间那一份可能是**另一种密文**
    //   （那把钥匙不属于当前空间），把它交给系统去打开 = 安静地交出一个坏文件。
    let space = { let c = db.0.lock().expect("db mutex poisoned"); active_space_id(&c) };
    find_attachment(&app_data_dir, &space, &hash)
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "附件不存在".to_string())
}

/// Copy an attachment (by hash) to a user-chosen destination path (download). When app
/// encryption is on, the bytes are decrypted from disk first so the user gets the
/// plaintext file (when off, passthrough — the on-disk bytes are already plaintext).
#[tauri::command]
pub fn copy_attachment(app: tauri::AppHandle, db: State<'_, Db>, hash: String, dest_path: String) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let (space, key) = {
        let c = db.0.lock().expect("db mutex poisoned");
        (active_space_id(&c), crate::security::key_if_enabled(&c))
    };
    let p = find_attachment(&app_data_dir, &space, &hash).ok_or("附件不存在")?;
    // Android：保存对话框给的是 `content://` URI，`std::fs::write(uri)` 会 EROFS（真机实测）。
    // 走 SaveTarget：桌面=直接写（行为不变），URI=先写缓存再整份搬进去。
    // ⚠️ P2a/B3 复核过：`write_path()` 在**桌面**是目标本身、在 **Android URI** 目标是缓存里的
    // 真文件路径 ⇒ 两种情况下它都是**真实文件系统路径**，`fs::copy` 都能写（见 `save_target.rs`）。
    let target = crate::save_target::SaveTarget::new(&app, &dest_path, "shuyonote-att")?;
    export_attachment_to(&p, target.write_path(), key.as_ref())?;
    target.commit()
}

/// 把附件字节**以明文**落到 `write_path`。抽成纯函数就为了让"未加密 = 纯拷贝"这条能被单测钉住。
///
/// **P2a / B3（2026-09-15）**：未加密时磁盘上本来就是明文，原先却是
/// `read`（整份进内存）→ `decrypt_attachment_bytes(None, …)`（透传，还是在内存里）→ `write`，
/// **一读一写纯属白费**。这是全仓**唯一无条件**发生的整块读——导入 / 同步上传 / 同步下载
/// 都只在"用户开了静态加密"时才整块读（见 `docs/plans/2026-09-15-attachment-sync-scope-plan.md` §2.6(2)）。
/// 手机上"把传进去的视频导出到下载目录"当场 OOM 的就是它 ⇒ 改成 `fs::copy`（内核态拷贝，RSS 不随文件增长）。
///
/// ⚠️ **加密开启时仍是整块解密**，这里**不做**假优化："流式读 → 整块加密 → 流式写"并不降低
/// 峰值内存（整块 AEAD 必然要求整个明文同时在内存里）。要真流式得改成分块 AEAD ⇒ 那是 P2b，
/// 前提是**先真机实测是否真的 OOM**，且要兼容存量附件。
fn export_attachment_to(src: &Path, write_path: &Path, key: Option<&crate::crypto::AppKeys>) -> Result<(), String> {
    match key {
        // 未加密：磁盘上就是明文 ⇒ 直接拷，别把整份读进内存。
        None => std::fs::copy(src, write_path)
            .map(|_| ())
            .map_err(|e| format!("复制失败: {e}")),
        Some(k) => {
            let raw = std::fs::read(src).map_err(|e| e.to_string())?;
            let plain = crate::security::decrypt_attachment_bytes(Some(k), &raw)?;
            std::fs::write(write_path, &plain).map_err(|e| format!("复制失败: {e}"))
        }
    }
}

#[tauri::command]
pub fn list_attachment_hashes(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let root = attachments_root(&app_data_dir);
    let mut hashes = Vec::new();
    // ★ 递归扫**整棵树**：`<根>/<空间>/<桶>/<hash>.<ext>`（新）、`<根>/<桶>/…` 与 `<根>/<hash>.<ext>`
    //   （老布局）三种都算 —— 这是一条"盘上到底有哪些附件字节"的读数，不该因为分层就漏。
    for p in walk_attachment_files(&root) {
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        // Ignore stray .part files.
        if name.ends_with(".part") { continue; }
        if let Some(stem) = name.split('.').next() {
            if stem.len() == 64 && stem.chars().all(|c| c.is_ascii_hexdigit()) {
                hashes.push(stem.to_string());
            }
        }
    }
    hashes.sort();
    hashes.dedup();
    Ok(hashes)
}

#[tauri::command]
pub(crate) fn attachment_bytes(app: tauri::AppHandle, db: State<'_, Db>, hash: &str) -> Result<Vec<u8>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let (space, key) = {
        let c = db.0.lock().expect("db mutex poisoned");
        (active_space_id(&c), crate::security::key_if_enabled(&c))
    };
    // 找不到文件时说清是"文件不在盘上"：这一条最常见的成因是外部把文件删了/移走了，
    // 而数据库里那行还在——笼统的"附件不存在"会让人以为是数据库的问题。
    let raw = read_attachment_bytes_at(&app_data_dir, &space, hash)?;
    crate::security::decrypt_attachment_bytes(key.as_ref(), &raw)
}

#[tauri::command]
pub fn read_attachment_bytes(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hash: String,
) -> Result<tauri::ipc::Response, String> {
    // 用 `Response` 回原始字节（JS 侧拿到 ArrayBuffer）而不是 `Vec<u8>`：
    // 后者会序列化成 JSON 数字数组——2 MB 的 PDF 就是两千多万字符的文本，
    // 白白让 IPC 与 webview 各扛一次巨型 JSON 解析。图片/PDF 这类"要完整字节"的
    // 调用点都受益。（纯函数 `attachment_bytes` 留给 Rust 侧自己用的调用点。）
    Ok(tauri::ipc::Response::new(attachment_bytes(app, db, &hash)?))
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
    let (space, key) = {
        let c = db.0.lock().expect("db mutex poisoned");
        (active_space_id(&c), crate::security::key_if_enabled(&c))
    };
    let attachments_dir = space_attachments_dir(&app_data_dir, &space);
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

    // `hash` is IPC-supplied and joined into a path below; validate it before
    // touching the filesystem.
    if !is_valid_hash(&hash) {
        return Err("附件哈希无效".to_string());
    }

    let ext = ext_from_mime(&mime);
    let path = bucket_path(&attachments_dir, &hash, ext);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if !path.exists() {
        let bytes = crate::security::encrypt_attachment_bytes(key.as_ref(), &data)?;
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
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
    // ★ 导入进来的文件落进**当前空间**的目录（老位置只读回退，不再往里写）。
    let space = { let c = db.0.lock().expect("db mutex poisoned"); active_space_id(&c) };
    let attachments_dir = space_attachments_dir(&app_data_dir, &space);
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

    let total_files = paths.len();
    let mut results = Vec::new();
    for (index, p) in paths.into_iter().enumerate() {
        // Android：系统选择器给的是 `content://` URI，不是文件路径。先落成真实临时路径
        // （桌面原样返回、不做任何多余的事）；那份拷出来的临时文件随 `picked` 析构删除。
        // 它同时会把"这是什么文件"问清楚（名字/类型，见 `picked_file` 的模块头注释）。
        let picked = crate::picked_file::materialize(&app, &p)?;
        let src = picked.path().to_path_buf();
        // ⚠️ **名字不能用 `src.file_name()` 打头**：Android 上它是我们自己的临时文件名。
        // 改这行之前它就是**裸 UUID**，真机上列表显示成
        // `📎41449ced-… 未整理 文件 1.8 KB` —— 那就是这条 bug 的正面。
        // `effective_name()` 在桌面等价于 `src.file_name()`（选择器名字恒为 None）。
        let name = picked.effective_name();
        // mime/ext 的三层决策见 `mime_and_ext`（桌面恒走扩展名那一层，行为不变）。
        let (mime, ext) = mime_and_ext(&src, picked.system_mime(), picked.sniffed());

        // tmp lives in the flat attachments dir (part files never published); the
        // final file goes into a 2-char bucket dir once the hash is known.
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

        // Recompute the final path now that the real hash is known.
        let final_path = bucket_path(&attachments_dir, &hash, &ext);
        if let Some(parent) = final_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let key = { let c = db.0.lock().expect("db mutex poisoned"); crate::security::key_if_enabled(&c) };
        if final_path.exists() {
            // Content-addressed dedup **within this space**: identical file already stored
            // here (leave as-is, the read path decrypts/passthroughs).
            let _ = std::fs::remove_file(&tmp);
        } else if let Err(e) = std::fs::rename(&tmp, &final_path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        } else if key.is_some() {
            // Encrypt at rest (the streamed tmp was plaintext; hash is over plaintext).
            if let Ok(plain) = std::fs::read(&final_path) {
                if let Ok(bytes) = crate::security::encrypt_attachment_bytes(key.as_ref(), &plain) {
                    let _ = std::fs::write(&final_path, &bytes);
                }
            }
        }

        let c = db.0.lock().expect("db mutex poisoned");
        let id = uuid::Uuid::new_v4().to_string();
        c.execute(
            "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, page_id, name, hash, mime, size, now_ms()],
        )
        .map_err(|e| e.to_string())?;
        // Sync the attachment row metadata (bytes transfer separately via sync_attachments).
        let now = now_ms();
        let payload = serde_json::json!({ "id": &id, "page_id": &page_id, "name": &name, "hash": &hash, "mime": &mime, "size": size }).to_string();
        record_change(&c, "attachment", &id, "upsert", Some(&payload), now)?;

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
    page_id: Option<String>,
) -> Result<Vec<AttachmentRow>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let c = db.0.lock().expect("db mutex poisoned");
    let space = active_space_id(&c);
    // `page_id = NULL` 永远不成立，所以「空间根下的未整理文件」必须走 IS NULL 分支。
    //
    // `created_at` 从 2026-09-19 起**选出来**：文件管理表里有「创建时间 / 上次修改时间」两列，
    // 而附件行这两列此前是前端写死的 `"—"`（用户截图报的"时间全是 —"就是这个）。
    let sql = if page_id.is_some() {
        "SELECT id, name, hash, mime, size, created_at FROM attachments
         WHERE page_id = ?1 ORDER BY created_at DESC"
    } else {
        "SELECT id, name, hash, mime, size, created_at FROM attachments
         WHERE page_id IS NULL ORDER BY created_at DESC"
    };
    let mut stmt = c.prepare(sql).map_err(|e| e.to_string())?;
    let map_row = |row: &rusqlite::Row<'_>| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
        ))
    };
    let rows = match &page_id {
        Some(pid) => stmt.query_map(params![pid], map_row),
        None => stmt.query_map([], map_row),
    }
    .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for r in rows {
        let (id, name, hash, mime, size, created_at) = r.map_err(|e| e.to_string())?;
        let path = find_attachment(&app_data_dir, &space, &hash)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let meta = AttachmentMeta { id, name, hash, mime, size, path };
        out.push(attachment_row(meta, created_at));
    }
    Ok(out)
}

/// 组装文件管理的一行：`created_at` 直接来自 DB；`mtime` 取 **`meta.path` 指向的本地文件**的修改时间，
/// **取不到就是 0**（未下载 / 路径为空 / 是目录），前端据此显示「—」。
///
/// 抽成纯函数是为了**可测**：`list_page_attachments` 需要 `tauri::AppHandle`，单元测试里造不出来，
/// 而"哪来的时间戳、取不到给什么"正是这条判据真正承重的地方。
fn attachment_row(meta: AttachmentMeta, created_at: i64) -> AttachmentRow {
    let mtime = if meta.path.is_empty() {
        0
    } else {
        std::fs::metadata(&meta.path)
            // **只认常规文件**：路径不存在、是目录、权限不足 ⇒ 一律 0（目录的 mtime 不是"这份附件的修改时间"）
            .ok()
            .filter(|m| m.is_file())
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    };
    AttachmentRow { meta, created_at, mtime }
}

/// 文件管理那两列时间的口径判据（**跑不了 `cargo test` 的机器请交给能跑的那两台复核**，
/// 见 `docs/` 里"Windows 跑不了 cargo test"那条纪律）。
#[cfg(test)]
mod attachment_byte_free_tests {
    use super::*;
    use std::collections::HashSet;

    /// ★ 删附件字节的**跨空间**规则（2026-09-20 自查发现老实现只在当前空间里 `COUNT(*)`）：
    /// 附件目录是全局共享的，别的空间还引用同一个 hash 时**绝不能删**。
    /// 这里把三种输入直接钉住（改回"只看当前空间"这条就红）。
    #[test]
    fn bytes_are_only_freeable_when_no_other_space_references_the_hash() {
        let h = "f2534c73fa62c0a6e0e5b6c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";
        let mut others: HashSet<String> = HashSet::new();
        others.insert(h.to_string());

        // 别的空间还在引用 ⇒ **不删**，哪怕本空间已经 0 行（老实现会删 —— 就是那条路径）。
        assert!(!bytes_are_freeable(0, &Some(others.clone()), h));

        // 别的空间没人引用、本空间也 0 行 ⇒ 才删。
        assert!(bytes_are_freeable(0, &Some(HashSet::new()), h));

        // 本空间还有别的行引用 ⇒ 不删。
        assert!(!bytes_are_freeable(1, &Some(HashSet::new()), h));

        // **读不全（None）⇒ 一律不删**：字节留着只占空间，删错就是数据丢失。
        assert!(!bytes_are_freeable(0, &None, h));
        assert!(!bytes_are_freeable(1, &None, h));
    }
}

#[cfg(test)]
mod attachment_row_tests {
    use super::*;

    fn meta(path: &str) -> AttachmentMeta {
        AttachmentMeta {
            id: "a1".into(),
            name: "营业执照扫描件.png".into(),
            hash: "h".into(),
            mime: "image/png".into(),
            size: 395 * 1024,
            path: path.into(),
        }
    }

    /// - `created_at` **总是**来自 DB（该列 NOT NULL）⇒ 任何一行都该带出来；
    /// - `mtime` 只反映**本地常规文件**：未下载（path 为空）/ 路径不是文件 ⇒ 0
    ///   （前端显示「—」，**不许**拿 created_at 冒充"上次修改时间"）；本地有文件 ⇒ 正的毫秒时间戳。
    #[test]
    fn attachment_row_carries_db_created_at_and_only_local_file_mtime() {
        // ① 未下载：path 为空
        let row = attachment_row(meta(""), 1_700_000_000_000);
        assert_eq!(row.created_at, 1_700_000_000_000, "created_at 来自 DB，永远有");
        assert_eq!(row.mtime, 0, "未下载没有本地 mtime ⇒ 0（前端显示「—」）");
        assert_eq!(row.meta.name, "营业执照扫描件.png", "meta 字段要原样带出来");

        // ② 路径存在但不是文件（目录）：也不能把目录的 mtime 当成附件的
        let dir = std::env::temp_dir();
        assert_eq!(
            attachment_row(meta(&dir.to_string_lossy()), 1).mtime,
            0,
            "目录不是附件：取不到文件 mtime ⇒ 0"
        );

        // ③ 本地真的有文件 ⇒ 给出正的 mtime
        let f = std::env::temp_dir().join(format!(
            "shuyonote-attachment-row-{}-{}.bin",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&f, b"x").unwrap();
        let row = attachment_row(meta(&f.to_string_lossy()), 42);
        assert_eq!(row.created_at, 42);
        assert!(row.mtime > 0, "本地存在的文件应给出 mtime，实际 {}", row.mtime);
        let _ = std::fs::remove_file(&f);
    }
}

/// M24 — list every PDF attachment across all pages (for the command palette's
/// 「打开 PDF」entry). Sorted by most-recently-created first.
#[tauri::command]
pub fn list_all_pdf_attachments(
    app: tauri::AppHandle,
    db: State<'_, Db>,
) -> Result<Vec<AttachmentMeta>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let c = db.0.lock().expect("db mutex poisoned");
    let space = active_space_id(&c);
    let mut stmt = c
        .prepare(
            "SELECT id, name, hash, mime, size FROM attachments
             WHERE mime = 'application/pdf' ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
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
        let path = find_attachment(&app_data_dir, &space, &hash)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        out.push(AttachmentMeta { id, name, hash, mime, size, path });
    }
    Ok(out)
}

#[tauri::command]
pub fn remove_attachment(app: tauri::AppHandle, db: State<'_, Db>, id: String) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    remove_attachment_inner(&db, &app_data_dir, &id)
}

/// **除当前空间之外**其他空间引用的 hash（严格版）；读不全 ⇒ `None` 且原因打进 stderr。
///
/// ★ 为什么删字节必须问别的空间（2026-09-20 自查发现）：附件目录是**全局共享**的内容寻址目录，
/// 老的 `SELECT COUNT(*) FROM attachments WHERE hash = ?` 只在**当前空间**里数 ⇒ 别的空间还引用着
/// 同一个字节时也会数到 0 ⇒ **把人家还在用的文件删了**（缺陷帖 #6「行在字节不在」的又一条路径）。
/// 读不全（空间打不开/密钥不符）时**宁可不删**：字节留着只占空间，删错就是数据丢失，
/// 而且 `cleanup_orphan_attachments`（同样是严格版）以后能把它收回来。
fn other_spaces_refs(db: &State<'_, Db>) -> Option<std::collections::HashSet<String>> {
    let c = db.0.lock().expect("db mutex poisoned");
    let current = match crate::workspaces::active_workspace_id(&c) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("删除附件字节：拿不到当前空间 id（{e}）⇒ 这一轮不删任何字节（宁留勿删）");
            return None;
        }
    };
    match crate::storage::other_spaces_referenced_hashes(&c, &current) {
        Ok(set) => Some(set),
        Err(unreadable) => {
            eprintln!(
                "删除附件字节：有 {} 个空间读不到 ⇒ 这一轮不删任何字节（宁留勿删，之后可用「清理孤儿附件」回收）：\n  - {}",
                unreadable.len(),
                unreadable.join("\n  - ")
            );
            None
        }
    }
}

/// 该 hash 的字节现在可以删吗？**两个条件都满足才行**：当前空间里没有别的行引用它，
/// **并且**其他空间也没有。单独拎出来是为了让这条跨空间规则有判据守着。
fn bytes_are_freeable(local_count: i64, other_refs: &Option<std::collections::HashSet<String>>, hash: &str) -> bool {
    match other_refs {
        Some(set) => local_count == 0 && !set.contains(hash),
        None => false, // 读不全 ⇒ 不删
    }
}

// Delete a single attachment row; remove its on-disk bytes only when no row **in any space**
// references the hash (true global zero-reference).
//
// ★ 2026-09-24（附件按空间分之后）：要删的字节现在是**本空间自己**那份，
//   但**老位置**（全局那份）可能还在 —— 两份都处理：
//   · 本空间那份：`other_refs` 只影响"老位置"那一份的取舍，本空间自己那份在这条规则成立时一起删；
//   · 老位置那份：**只在别的空间也不引用**时才删（`bytes_are_freeable` 的老语义，一字不改）。
fn remove_attachment_inner(
    db: &State<'_, Db>,
    app_data_dir: &Path,
    id: &str,
) -> Result<(), String> {
    let other_refs = other_spaces_refs(db);
    remove_attachment_inner_with(db, app_data_dir, id, &other_refs)
}

fn remove_attachment_inner_with(
    db: &State<'_, Db>,
    app_data_dir: &Path,
    id: &str,
    other_refs: &Option<std::collections::HashSet<String>>,
) -> Result<(), String> {
    let c = db.0.lock().expect("db mutex poisoned");
    let space = active_space_id(&c);
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
    record_change(&c, "attachment", id, "delete", None, now_ms())?;

    // 本空间里还有别的行引用它吗？（跨空间那份在 `other_refs` 里）
    let count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM attachments WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    // ⚠️ 这一行**必须**带 `other_refs`：只数当前空间 = 把别的空间还在用的**老位置**字节删掉（缺陷帖 #6）。
    if bytes_are_freeable(count, other_refs, &hash) {
        if let Some(p) = find_path_by_hash(&space_attachments_dir(app_data_dir, &space), &hash) {
            let _ = std::fs::remove_file(p);
        }
        if let Some(p) = find_path_by_hash(&attachments_root(app_data_dir), &hash) {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(())
}

/// Batch-remove attachments. Each is deleted via the same zero-reference rule:
/// its disk bytes are freed only when no row references the hash anymore.
#[tauri::command]
pub fn remove_attachments(app: tauri::AppHandle, db: State<'_, Db>, ids: Vec<String>) -> Result<usize, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // 跨空间那一份**只算一次**（批量删除时逐条重算是 O(n×空间数) 次开库）。
    let other_refs = other_spaces_refs(&db);
    let mut removed = 0usize;
    for id in &ids {
        remove_attachment_inner_with(&db, &app_data_dir, id, &other_refs)?;
        removed += 1;
    }
    Ok(removed)
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
    // Sync the new folder ownership so the other device sees the move.
    let meta = c
        .query_row(
            "SELECT name, hash, mime, size FROM attachments WHERE id = ?1",
            params![id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((name, hash, mime, size)) = meta {
        let now = now_ms();
        let payload = serde_json::json!({ "id": &id, "page_id": &new_page_id, "name": &name, "hash": &hash, "mime": &mime, "size": size }).to_string();
        record_change(&c, "attachment", &id, "upsert", Some(&payload), now)?;
    }
    Ok(())
}

/// Rename an attachment's display name (bytes/hash unchanged).
///
/// ## mime 随不随改名变（2026-09-17 定的语义，别改回去）
///
/// **按新名字重算**，但只有一条判据：新名字**认得出类型**才写回（[`repaired_mime`]）。
/// 于是两件事同时成立：
///
/// - `x.txt` 改成 `x.pdf` ⇒ 立刻能进内置 PDF 阅读器；老数据（裸 UUID + octet-stream）
///   改成 `photo.png` ⇒ 用户能自救。改名这条路上"用户敲的扩展名"是**显式声明**，
///   该被采信。
/// - 改成一个**认不出**的名字（`report.pdf` → `report`、或改成 `.unknownext`）⇒
///   **原样保留**原来的 mime。改名永远不会把已知类型降级成 `application/octet-stream`
///   —— 否则把 `report.pdf` 改成 `report` 就能把 PDF 阅读器弄丢，那才是把能用的东西改坏。
#[tauri::command]
pub fn rename_attachment(db: State<'_, Db>, id: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("名称不能为空".to_string());
    }
    let c = db.0.lock().expect("db mutex poisoned");
    // 先在**同一个锁**里读出来：下面的 UPDATE 会用当前 mime 决定新 mime，
    // 两次查询之间不能被别人插进来改掉。
    let meta = c
        .query_row(
            "SELECT page_id, hash, mime, size FROM attachments WHERE id = ?1",
            params![id],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((page_id, hash, cur_mime, size)) = meta else {
        return Err("附件不存在".to_string());
    };
    let mime = repaired_mime(&cur_mime, &name);
    c.execute(
        "UPDATE attachments SET name = ?1, mime = ?2 WHERE id = ?3",
        params![name, mime, id],
    )
    .map_err(|e| e.to_string())?;
    // 同步新名称到其它设备（字节/hash 不变）。
    {
        let now = now_ms();
        let payload = serde_json::json!({ "id": &id, "page_id": page_id, "name": &name, "hash": &hash, "mime": &mime, "size": size }).to_string();
        record_change(&c, "attachment", &id, "upsert", Some(&payload), now)?;
    }
    Ok(())
}

/// Restore a historical version: clone the given attachment (by content hash) as
/// a NEW current attachment in `target_page_id`, so the chosen version becomes
/// the newest same-named file. Content-addressed bytes are shared (no rewrite).
#[tauri::command]
pub fn restore_attachment(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    target_page_id: String,
    source_id: String,
) -> Result<AttachmentMeta, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let c = db.0.lock().expect("db mutex poisoned");
    let space = active_space_id(&c);
    let (name, hash, mime, size): (String, String, String, i64) = c
        .query_row(
            "SELECT name, hash, mime, size FROM attachments WHERE id = ?1",
            params![source_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|_| "附件不存在".to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    c.execute(
        "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, target_page_id, name, hash, mime, size, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    // Sync the restored attachment as a new row (bytes are shared by content hash).
    let now = now_ms();
    let payload = serde_json::json!({ "id": &id, "page_id": &target_page_id, "name": &name, "hash": &hash, "mime": &mime, "size": size }).to_string();
    record_change(&c, "attachment", &id, "upsert", Some(&payload), now)?;
    let path = find_attachment(&app_data_dir, &space, &hash)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(AttachmentMeta { id, name, hash, mime, size, path })
}

#[cfg(test)]
mod read_bytes_tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shuyonote-att-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_bucketed_and_flat_attachments_and_says_what_is_missing() {
        let dir = temp_dir("read-bytes");
        let hash = "12d785817fcddf344ac33a36113281c27867c85b385f96771410b3ddccb3d223";
        // 分桶布局（新）
        let bucket = dir.join(&hash[..2]);
        std::fs::create_dir_all(&bucket).unwrap();
        std::fs::write(bucket.join(format!("{hash}.pdf")), b"%PDF-1.4 bucketed").unwrap();
        assert_eq!(read_bytes_at(&dir, hash).unwrap(), b"%PDF-1.4 bucketed");

        // 扁平布局（旧）：同一个 hash 也读得到
        let flat = temp_dir("read-bytes-flat");
        let h2 = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
        std::fs::write(flat.join(format!("{h2}.png")), b"flat bytes").unwrap();
        assert_eq!(read_bytes_at(&flat, h2).unwrap(), b"flat bytes");

        // 找不到时要说清是"文件不在盘上"，而不是笼统的读取失败
        let err = read_bytes_at(&dir, h2).unwrap_err();
        assert!(err.contains("附件文件不存在"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&flat);
    }
}

/// ★★ **附件库按空间分**（owner 2026-09-24 拍板 ②）—— 这一组判据钉的是"缺口真的没了"。
///
/// 缺口原话（收口前）：附件是**全局一份**内容寻址，而钥匙按空间 ⇒ 同一份内容被
/// "一个加密空间 ＋ 一个明文空间"同时引用时，**谁先落盘谁决定那份字节是密文还是明文**，
/// 后读的那一方解不开会被透传（安静地交出坏文件）。
#[cfg(test)]
mod per_space_layout_tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shuyonote-attspace-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 按空间**写**一份（与命令里那条写入路径同形状：`<根>/<空间>/<桶>/<hash>.<ext>`）。
    fn put(app_data_dir: &Path, space: &str, hash: &str, bytes: &[u8]) -> PathBuf {
        let dir = space_attachments_dir(app_data_dir, space);
        let path = bucket_path(&dir, hash, "bin");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        path
    }

    /// ① ★ 同一条 hash 在两个空间里**各自一份**：路径不同、字节不同（＝缺口不存在了）。
    /// 这条就是本次改动的**承重判据**：改回"全局一份"（`find_attachment` 退化成只查根）就红。
    #[test]
    fn the_same_hash_is_two_independent_files_in_two_spaces() {
        let app = temp_root("two-spaces");
        let hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        let a = put(&app, "space-a", hash, b"ciphertext written by A");
        let b = put(&app, "space-b", hash, b"plaintext written by B");
        assert_ne!(a, b, "两个空间必须是两份文件（而不是共用一份）");

        // 各读各的：谁也不会拿到对方那份
        assert_eq!(find_attachment(&app, "space-a", hash).unwrap(), a);
        assert_eq!(find_attachment(&app, "space-b", hash).unwrap(), b);
        assert_eq!(read_attachment_bytes_at(&app, "space-a", hash).unwrap(), b"ciphertext written by A");
        assert_eq!(read_attachment_bytes_at(&app, "space-b", hash).unwrap(), b"plaintext written by B");

        // 路径也必须**在各自空间目录下**（不是"两个名字指向同一处"）
        assert!(a.starts_with(space_attachments_dir(&app, "space-a")));
        assert!(b.starts_with(space_attachments_dir(&app, "space-b")));

        let _ = std::fs::remove_dir_all(&app);
    }

    /// ② 老位置（全局那份）**照样读得到** —— 升级不搬文件，谁都不会因为分层而丢附件。
    #[test]
    fn a_legacy_global_file_is_still_readable_from_any_space() {
        let app = temp_root("legacy");
        let root = attachments_root(&app);
        let hash = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
        // 老布局两种形态：分桶 ＋ 扁平
        let bucketed = root.join(&hash[..2]).join(format!("{hash}.png"));
        std::fs::create_dir_all(bucketed.parent().unwrap()).unwrap();
        std::fs::write(&bucketed, b"legacy bucketed").unwrap();
        let flat_hash = "0011223344556677889900112233445566778899001122334455667788990011";
        std::fs::write(root.join(format!("{flat_hash}.png")), b"legacy flat").unwrap();

        for space in ["space-a", "space-b"] {
            assert_eq!(
                read_attachment_bytes_at(&app, space, hash).unwrap(),
                b"legacy bucketed",
                "{space} 应当回退读到老位置那份"
            );
            assert_eq!(
                read_attachment_bytes_at(&app, space, flat_hash).unwrap(),
                b"legacy flat",
                "{space} 应当回退读到老位置（扁平）那份"
            );
        }
        // 而**写**永远落在空间目录里（`space_attachments_dir` 不改老位置）
        let mine = put(&app, "space-a", hash, b"mine");
        assert_eq!(read_attachment_bytes_at(&app, "space-a", hash).unwrap(), b"mine", "本空间那份优先");
        assert_eq!(read_attachment_bytes_at(&app, "space-b", hash).unwrap(), b"legacy bucketed", "别的空间不受影响");
        assert!(mine.starts_with(space_attachments_dir(&app, "space-a")));

        let _ = std::fs::remove_dir_all(&app);
    }

    /// ③ 统计/清理那几条路要能看见**所有布局**（递归遍历），否则按空间分之后它们会漏掉新目录。
    #[test]
    fn walking_the_tree_covers_every_layout() {
        let app = temp_root("walk");
        let root = attachments_root(&app);
        let h_new = "1111111111111111111111111111111111111111111111111111111111111111";
        let h_old = "2222222222222222222222222222222222222222222222222222222222222222";
        let h_flat = "3333333333333333333333333333333333333333333333333333333333333333";

        put(&app, "space-a", h_new, b"new layout");
        std::fs::create_dir_all(root.join(&h_old[..2])).unwrap();
        std::fs::write(root.join(&h_old[..2]).join(format!("{h_old}.bin")), b"old bucketed").unwrap();
        std::fs::write(root.join(format!("{h_flat}.bin")), b"old flat").unwrap();

        let mut found: Vec<String> = walk_attachment_files(&root)
            .iter()
            .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .collect();
        found.sort();
        assert_eq!(
            found,
            vec![format!("{h_new}.bin"), format!("{h_old}.bin"), format!("{h_flat}.bin")],
            "三种布局都要被遍历到（统计/孤儿清理靠它）"
        );
        // `find_attachment_anywhere`：不知道空间时也找得到（存储/清理那两条路用）
        assert!(find_attachment_anywhere(&root, h_new).is_some(), "新布局找得到");
        assert!(find_attachment_anywhere(&root, h_old).is_some(), "老桶布局找得到");
        assert!(find_attachment_anywhere(&root, h_flat).is_some(), "老扁平布局找得到");

        let _ = std::fs::remove_dir_all(&app);
    }

    /// ④ 空间 id **不许**穿出附件树（`is_safe_space_id` 把关）。
    #[test]
    fn a_hostile_space_id_cannot_escape_the_attachments_tree() {
        let app = temp_root("traversal");
        let dir = space_attachments_dir(&app, "../../evil");
        assert!(
            dir.starts_with(attachments_root(&app)),
            "空间 id 进路径前必须过白名单，实际：{}",
            dir.display()
        );
        let _ = std::fs::remove_dir_all(&app);
    }
}

/// **P2a / B3 的门禁**：导出（下载 / 另存为）分两条路，且**未加密那条必须是纯拷贝**。
#[cfg(test)]
mod export_attachment_tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shuyonote-att-export-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 未加密：导出的就是**逐字节相同**的原文件。
    ///
    /// 这条同时是"改成 `fs::copy` 之后行为没变"的判据——因为本分支原先走的是
    /// `read` → `decrypt_attachment_bytes(None, …)`（透传）→ `write`，产物必须一模一样。
    #[test]
    fn unencrypted_export_is_a_byte_for_byte_copy() {
        let dir = temp_dir("plain");
        let src = dir.join("12d785817fcddf344ac33a36113281c27867c85b385f96771410b3ddccb3d223.mp4");
        let dst = dir.join("out.mp4");
        // 比一页大的内容：整块读的老实现在这里会把整份读进内存，拷贝路径不会。
        let payload: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&src, &payload).unwrap();

        export_attachment_to(&src, &dst, None).unwrap();

        assert_eq!(std::fs::read(&dst).unwrap(), payload, "未加密导出必须逐字节相同");
        // 源文件仍在（导出是"另存一份"，不是"搬走"）。
        assert!(src.exists(), "导出不能动源文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 加密开启：磁盘上是密文，导出的必须是**明文**（否则用户拿到一个解不开的文件）。
    #[test]
    fn encrypted_export_decrypts_to_plaintext() {
        let dir = temp_dir("enc");
        let src = dir.join("aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899.pdf");
        let dst = dir.join("out.pdf");
        let key = crate::crypto::AppKeys::legacy_only([7u8; 32]);
        let plain = b"%PDF-1.7 real content";
        // 磁盘上存密文（与 security::encrypt_attachment_bytes 的落盘格式一致）。
        std::fs::write(&src, crate::security::encrypt_attachment_bytes(Some(&key), plain).unwrap()).unwrap();

        export_attachment_to(&src, &dst, Some(&key)).unwrap();

        assert_eq!(std::fs::read(&dst).unwrap(), plain, "加密导出必须解密成明文");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 默认构建（2026-09-20 起国密即默认）：磁盘上那份是 **v2（SM4-CBC ＋ HMAC-SM3）**，
    /// 导出的仍必须逐字节是**明文**。"导出包"这条路径最容易漏 —— 它读的是同一份文件，
    /// 但走的是"解密出来给人"（`export_attachment_to`），与附件预览不是同一段代码。
    #[cfg(feature = "sm-crypto")]
    #[test]
    fn encrypted_export_under_national_crypto_decrypts_to_plaintext() {
        let dir = temp_dir("enc-sm");
        let src = dir.join("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff.pdf");
        let dst = dir.join("out.pdf");
        let keys = crate::crypto::derive_app_keys("pw", &crate::crypto::random_salt()).unwrap();
        assert!(keys.sm.is_some(), "国密构建下派生出来必须有国密密钥");
        let plain = b"%PDF-1.7 national crypto content";
        let on_disk = crate::security::encrypt_attachment_bytes(Some(&keys), plain).unwrap();
        assert_eq!(
            &on_disk[..2],
            &[crate::crypto::MAGIC, crate::crypto::VERSION_SM4],
            "落盘的那份没写成国密 ⇒ 这条用例根本没测到国密路径"
        );
        std::fs::write(&src, &on_disk).unwrap();

        export_attachment_to(&src, &dst, Some(&keys)).unwrap();

        assert_eq!(std::fs::read(&dst).unwrap(), plain, "国密导出必须解密成明文");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// 「Android 导入的附件没有名字也没有类型」那条 bug 的**门禁**。
///
/// 真机症状：列表显示 `📎41449ced-… 未整理 文件 1.8 KB`，点它进不了内置预览
/// （`FileManagerView`/`PageTree` 都按 `file.mime` 分支），PDF 也进不了阅读器。
/// 这里钉住的就是**修好之后必须成立的那几件事**。
#[cfg(test)]
mod picked_mime_tests {
    use super::*;
    use crate::magic::Magic;

    /// 一段真实的 PNG 开头（签名 + IHDR 长度/类型）。
    const PNG_HEAD: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, b'I', b'H', b'D',
        b'R',
    ];

    /// **本 bug 的核心断言**：一个**没有扩展名**的临时文件（= Android 上那个裸 UUID），
    /// 只要内容嗅探认出是 PNG，mime 就必须是 `image/png` —— 前端那条
    /// `mime.startsWith("image/")` 分支才会亮，内置预览才进得去。
    #[test]
    fn an_extensionless_png_gets_image_png() {
        let src = Path::new("/tmp/picked/41449ced-d44e-4d3c-8e14-7c6733ad042a");
        let sniffed = crate::magic::sniff(PNG_HEAD);
        assert_eq!(sniffed.map(|m| m.ext), Some("png"), "前提：这段字节确实是 PNG");

        let (mime, ext) = mime_and_ext(src, None, sniffed);
        assert_eq!(mime, "image/png");
        assert_eq!(ext, "png");
    }

    /// 一整个 PDF 也一样要能进内置阅读器（`PageTree` 判的是 `application/pdf`）。
    #[test]
    fn an_extensionless_pdf_gets_application_pdf() {
        let src = Path::new("/tmp/picked/41449ced-d44e-4d3c-8e14-7c6733ad042a");
        let (mime, ext) = mime_and_ext(src, None, crate::magic::sniff(b"%PDF-1.7\n"));
        assert_eq!(mime, "application/pdf");
        assert_eq!(ext, "pdf");
    }

    /// 系统说的 mime 在**扩展名表不认识**时接手：它能认出表里没有的类型，
    /// 而且拿不到扩展名时落盘扩展名要跟着它走（`<hash>.<ext>` 里的 `<ext>` 由这里定）。
    #[test]
    fn the_system_mime_takes_over_where_the_extension_table_gives_up() {
        let bare = Path::new("/tmp/picked/41449ced");
        assert_eq!(
            mime_and_ext(bare, Some("image/png"), None),
            ("image/png".to_string(), "png".to_string())
        );
        // 表里没有的类型（opus）也照系统说的走
        assert_eq!(
            mime_and_ext(bare, Some("audio/opus"), None),
            ("audio/opus".to_string(), "bin".to_string())
        );
        // 表**不认识**的扩展名：mime 用系统说的，扩展名仍用名字给的那个
        assert_eq!(
            mime_and_ext(Path::new("/tmp/picked/x.opus"), Some("audio/opus"), None),
            ("audio/opus".to_string(), "opus".to_string())
        );
        // 表认识的扩展名：与桌面同一条路
        assert_eq!(
            mime_and_ext(Path::new("/tmp/picked/x.webp"), Some("image/webp"), None),
            ("image/webp".to_string(), "webp".to_string())
        );
    }

    /// **不能把前端认得的类型换成认不得的**：`ContentResolver.getType` 会给出
    /// `text/x-markdown` 这类非规范写法，而前端的 markdown 内置预览判的是**恰好等于**
    /// `text/markdown`。所以扩展名表（我们自己的规范词汇）必须先说话。
    #[test]
    fn a_non_canonical_system_mime_must_not_replace_our_canonical_one() {
        assert_eq!(
            mime_and_ext(Path::new("/tmp/picked/notes.md"), Some("text/x-markdown"), None),
            ("text/markdown".to_string(), "md".to_string())
        );
        assert_eq!(
            mime_and_ext(Path::new("/tmp/picked/a.png"), Some("image/x-png"), None),
            ("image/png".to_string(), "png".to_string())
        );
        assert_eq!(
            mime_and_ext(Path::new("/tmp/picked/a.pdf"), Some("application/x-pdf"), None),
            ("application/pdf".to_string(), "pdf".to_string())
        );
    }

    /// **桌面逐字节不变**的门禁：没有系统答案、没有嗅探时，走的必须是原来那条
    /// 扩展名表 —— 逐个类型对一遍，防止有人以后把优先级改错。
    #[test]
    fn without_any_android_layer_the_extension_table_still_decides() {
        for (path, mime, ext) in [
            ("/tmp/a.png", "image/png", "png"),
            ("/tmp/a.jpeg", "image/jpeg", "jpg"),
            ("/tmp/a.zip", "application/zip", "zip"),
            ("/tmp/a.md", "text/markdown", "md"),
            ("/tmp/a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
            // 认不出来的扩展名与**没有**扩展名：都是 octet-stream + bin（与今天一致）
            ("/tmp/a.unknownext", "application/octet-stream", "unknownext"),
            ("/tmp/41449ced-d44e-4d3c-8e14-7c6733ad042a", "application/octet-stream", "bin"),
        ] {
            assert_eq!(
                mime_and_ext(Path::new(path), None, None),
                (mime.to_string(), ext.to_string()),
                "{path}"
            );
        }
    }

    /// 嗅探只有在**完全没有扩展名**时才允许开口：有扩展名时它不得推翻扩展名表
    /// （否则同一个 hash 的老数据会从 `<hash>.bin` 漂到 `<hash>.png`，多出孤儿文件）。
    #[test]
    fn sniffing_never_overrides_a_real_extension() {
        let sniffed = Some(Magic { mime: "image/png", ext: "png" });
        assert_eq!(
            mime_and_ext(Path::new("/tmp/a.pdf"), None, sniffed),
            ("application/pdf".to_string(), "pdf".to_string())
        );
    }

    /// 改名那条语义（见 [`rename_attachment`] 的文档）：**按新名字重算，但永不降级**。
    #[test]
    fn renaming_recomputes_from_the_new_name_but_never_downgrades() {
        // ① 老数据（Android 导入那批：名字是裸 UUID、mime 是 octet-stream）改名成 .png ⇒ 救回来
        assert_eq!(repaired_mime(GENERIC_MIME, "photo.png"), "image/png");
        assert_eq!(repaired_mime(GENERIC_MIME, "photo.jpeg"), "image/jpeg");
        // ② 已知类型改成另一个**认得**的扩展名 ⇒ 采信用户敲的那个（改名 .txt→.pdf 之后
        //    要能进内置 PDF 阅读器，这是这条语义存在的理由）
        assert_eq!(repaired_mime("text/plain", "notes.pdf"), "application/pdf");
        assert_eq!(repaired_mime("text/markdown", "readme.md"), "text/markdown");
        // ③ **永不降级**：新名字认不出类型时原样保留 —— 否则 `report.pdf` 改成 `report`
        //    就能把 PDF 阅读器弄丢，那是把能用的东西改坏
        assert_eq!(repaired_mime("application/pdf", "report"), "application/pdf");
        assert_eq!(repaired_mime("image/png", "whatever.unknownext"), "image/png");
        assert_eq!(repaired_mime("application/pdf", "41449ced-d44e"), "application/pdf");
        // ④ 认不出 → 仍然认不出：维持"不知道"，不编
        assert_eq!(repaired_mime(GENERIC_MIME, "file.unknownext"), GENERIC_MIME);
    }

    /// `sniff_file` 要真的读盘（`materialize` 用它给无扩展名的临时文件补扩展名）。
    #[test]
    fn sniff_file_reads_from_disk() {
        let dir = std::env::temp_dir().join(format!(
            "shuyonote-sniff-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // 名字是裸 UUID、没有扩展名 —— 与 Android 上落下来的那个临时文件同形
        let bare = dir.join("41449ced-d44e-4d3c-8e14-7c6733ad042a");
        std::fs::write(&bare, PNG_HEAD).unwrap();
        assert_eq!(crate::magic::sniff_file(&bare).map(|m| m.mime), Some("image/png"));

        // 读不到的文件返回 None，不 panic（导入路径上"问不到"不能变成"导入失败"）
        assert_eq!(crate::magic::sniff_file(&dir.join("nope")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

