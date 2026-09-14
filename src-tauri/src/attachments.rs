use crate::db::{now_ms, Db};
use crate::models::AttachmentMeta;
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

/// 按 hash 在附件目录里把文件读出来（纯函数：把"找路径 + 读字节 + 出错怎么说"这三件事
/// 从命令里拆出来，好测）。
pub(crate) fn read_bytes_at(dir: &Path, hash: &str) -> Result<Vec<u8>, String> {
    let path = find_path_by_hash(dir, hash).ok_or_else(|| {
        // 说清是"文件不在盘上"，而不是笼统的"读取失败"：这一条最常见的成因是
        // 外部把文件删了/移走了，而数据库里那行还在。
        "附件文件不存在（可能被移动或删除）".to_string()
    })?;
    std::fs::read(&path).map_err(|e| format!("读取附件失败：{e}"))
}

#[tauri::command]
pub fn save_image(app: tauri::AppHandle, db: State<'_, Db>, args: SaveImageArgs) -> Result<AttachmentMeta, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments");
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

    // Dedup: write only if not already present, encrypting at rest with the session key
    // when encryption is on+unlocked (the hash is over the PLAINTEXT, so dedup still works).
    if !path.exists() {
        let key = { let c = db.0.lock().expect("db mutex poisoned"); crate::security::key_if_enabled(&c) };
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
pub fn attachment_path(app: tauri::AppHandle, hash: String) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir: PathBuf = app_data_dir.join("attachments");
    find_path_by_hash(&attachments_dir, &hash)
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "附件不存在".to_string())
}

/// Copy an attachment (by hash) to a user-chosen destination path (download). When app
/// encryption is on, the bytes are decrypted from disk first so the user gets the
/// plaintext file (when off, passthrough — the on-disk bytes are already plaintext).
#[tauri::command]
pub fn copy_attachment(app: tauri::AppHandle, db: State<'_, Db>, hash: String, dest_path: String) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir: PathBuf = app_data_dir.join("attachments");
    let p = find_path_by_hash(&attachments_dir, &hash).ok_or("附件不存在")?;
    let raw = std::fs::read(&p).map_err(|e| e.to_string())?;
    let key = { let c = db.0.lock().expect("db mutex poisoned"); crate::security::key_if_enabled(&c) };
    let plain = crate::security::decrypt_attachment_bytes(key.as_ref(), &raw)?;
    // Android：保存对话框给的是 `content://` URI，`std::fs::write(uri)` 会 EROFS（真机实测）。
    // 走 SaveTarget：桌面=直接写（行为不变），URI=先写缓存再整份搬进去。
    let target = crate::save_target::SaveTarget::new(&app, &dest_path, "shuyonote-att")?;
    std::fs::write(target.write_path(), &plain).map_err(|e| format!("复制失败: {e}"))?;
    target.commit()
}

#[tauri::command]
pub fn list_attachment_hashes(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir: PathBuf = app_data_dir.join("attachments");
    let mut hashes = Vec::new();
    // Bucketed layout: `attachments/<hh>/<hash>.<ext>` — hash is the stem.
    if let Ok(bucket_entries) = std::fs::read_dir(&attachments_dir) {
        for be in bucket_entries.flatten() {
            let bname = be.file_name().to_string_lossy().into_owned();
            // Only two-hex bucket dirs (skip ".part" and other stray files).
            if bname.len() == 2 && bname.chars().all(|c| c.is_ascii_hexdigit()) && be.path().is_dir() {
                if let Ok(files) = std::fs::read_dir(be.path()) {
                    for f in files.flatten() {
                        let n = f.file_name().to_string_lossy().into_owned();
                        // Ignore stray .part files.
                        if n.ends_with(".part") { continue; }
                        if let Some(stem) = n.split('.').next() {
                            if stem.len() == 64 && stem.chars().all(|c| c.is_ascii_hexdigit()) {
                                hashes.push(stem.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    // Legacy flat layout: `attachments/<hash>.<ext>`.
    if let Ok(entries) = std::fs::read_dir(&attachments_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(stem) = name.split('.').next() {
                if stem.len() == 64 && stem.chars().all(|c| c.is_ascii_hexdigit()) {
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
pub(crate) fn attachment_bytes(app: tauri::AppHandle, db: State<'_, Db>, hash: &str) -> Result<Vec<u8>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir: PathBuf = app_data_dir.join("attachments");
    // 找不到文件时说清是"文件不在盘上"：这一条最常见的成因是外部把文件删了/移走了，
    // 而数据库里那行还在——笼统的"附件不存在"会让人以为是数据库的问题。
    let raw = read_bytes_at(&attachments_dir, hash)?;
    let key = { let c = db.0.lock().expect("db mutex poisoned"); crate::security::key_if_enabled(&c) };
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
    let attachments_dir = app_data_dir.join("attachments");
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
        let key = { let c = db.0.lock().expect("db mutex poisoned"); crate::security::key_if_enabled(&c) };
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
    let attachments_dir = app_data_dir.join("attachments");
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
            // Content-addressed dedup: identical file already stored (may have been
            // written before encryption; leave as-is, the read path decrypts/passthroughs).
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
) -> Result<Vec<AttachmentMeta>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments");

    let c = db.0.lock().expect("db mutex poisoned");
    // `page_id = NULL` 永远不成立，所以「空间根下的未整理文件」必须走 IS NULL 分支。
    let sql = if page_id.is_some() {
        "SELECT id, name, hash, mime, size FROM attachments
         WHERE page_id = ?1 ORDER BY created_at DESC"
    } else {
        "SELECT id, name, hash, mime, size FROM attachments
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
        ))
    };
    let rows = match &page_id {
        Some(pid) => stmt.query_map(params![pid], map_row),
        None => stmt.query_map([], map_row),
    }
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

/// M24 — list every PDF attachment across all pages (for the command palette's
/// 「打开 PDF」entry). Sorted by most-recently-created first.
#[tauri::command]
pub fn list_all_pdf_attachments(
    app: tauri::AppHandle,
    db: State<'_, Db>,
) -> Result<Vec<AttachmentMeta>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments");

    let c = db.0.lock().expect("db mutex poisoned");
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
    remove_attachment_inner(&db, &attachments_dir, &id)
}

// Delete a single attachment row; remove its on-disk bytes only when no other
// row references the hash (true global zero-reference).
fn remove_attachment_inner(
    db: &State<'_, Db>,
    attachments_dir: &Path,
    id: &str,
) -> Result<(), String> {
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
    record_change(&c, "attachment", id, "delete", None, now_ms())?;

    // Remove the on-disk file only when no other row references its hash.
    let count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM attachments WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if count == 0 {
        if let Some(p) = find_path_by_hash(attachments_dir, &hash) {
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
    let attachments_dir = app_data_dir.join("attachments");
    let mut removed = 0usize;
    for id in &ids {
        remove_attachment_inner(&db, &attachments_dir, id)?;
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
    let attachments_dir = app_data_dir.join("attachments");
    let c = db.0.lock().expect("db mutex poisoned");
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
    let path = find_path_by_hash(&attachments_dir, &hash)
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

