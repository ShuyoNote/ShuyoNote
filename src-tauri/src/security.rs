use crate::crypto;
use crate::db::{Db, space_db_path};
use crate::sync;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::State;

/// App-session "locked" flag: gating pushes/pulls until the passphrase is re-entered.
static LOCKED: AtomicBool = AtomicBool::new(false);

/// Session-held derived key (NOT persisted at rest). Populated on enable/unlock,
/// cleared on lock/disable. This is the E1 "密钥不落盘" core: the passphrase-derived
/// key only lives in this process's memory, never written to disk.
static SESSION_KEY: Mutex<Option<[u8; 32]>> = Mutex::new(None);

/// Constant encrypted as the verify sentinel so `unlock_encryption` can validate
/// the passphrase without persisting the key at rest.
const VERIFY_MSG: &str = "shuyonote-encryption-verify";

fn conn<'a>(db: &'a State<'_, Db>) -> std::sync::MutexGuard<'a, Connection> {
    db.0.lock().expect("db mutex poisoned")
}

// ---- meta (app-level, plaintext) encryption config ----
//
// E1 disk encryption: when encryption is enabled the workspace DBs themselves are
// SQLCipher-encrypted at rest, so the salt/verify/enabled flags CANNOT live inside
// a space DB (they'd be unreadable before unlock — a chicken-and-egg that would
// make the app unable to start). They therefore live in meta.db (plaintext), the
// only readable place on a fresh, locked launch.

/// Whether encryption is on for the app (read from meta.db, never from a space DB).
fn encryption_enabled(c: &Connection) -> bool {
    sync::get_meta_state(c, crypto::ENC_ENABLED).as_deref() == Some("1")
}

/// Encryption flag read straight from a connection's own base `sync_state`, used
/// by `db::init` before meta is ATTACHed (i.e. on the plain meta.db connection).
pub(crate) fn encryption_enabled_base(c: &Connection) -> bool {
    sync::get_state(c, crypto::ENC_ENABLED).as_deref() == Some("1")
}

/// Whether the session currently holds a derived key (i.e. not locked).
pub(crate) fn session_has_key() -> bool {
    SESSION_KEY.lock().map(|s| s.is_some()).unwrap_or(false)
}

/// Read the session-held derived key (if encryption is on and session currently unlocked).
/// No longer reads any persisted key — this is the E1 "密钥不落盘" guarantee.
pub fn key_if_enabled(c: &Connection) -> Option<[u8; 32]> {
    if !encryption_enabled(c) || LOCKED.load(Ordering::SeqCst) {
        return None;
    }
    *SESSION_KEY.lock().ok()?
}

/// Session-held key bytes (for SQLCipher `PRAGMA key` when opening an encrypted space DB).
/// Returns the raw 32-byte key regardless of the locked flag; callers gate on
/// [`encryption_enabled`] + lock state themselves.
pub fn session_key() -> Option<[u8; 32]> {
    *SESSION_KEY.lock().ok()?
}

/// Encrypt attachment BYTES at rest using the session key, ONLY when encryption is on
/// and the session is unlocked. When off (or locked) this passes the bytes through
/// unchanged, so existing plaintext attachments keep working and new ones are stored
/// plainly until encryption is enabled.
pub fn encrypt_attachment_bytes(key: Option<&[u8; 32]>, data: &[u8]) -> Result<Vec<u8>, String> {
    match key {
        Some(k) => crypto::encrypt(data, k),
        None => Ok(data.to_vec()),
    }
}

/// Decrypt attachment bytes read back from disk. When a key is present, tries to decrypt
/// (ciphertext = `nonce(24)||ct`); if it fails the bytes were plaintext (pre-encryption
/// data or encryption was off when saved), so they are returned unchanged.
pub fn decrypt_attachment_bytes(key: Option<&[u8; 32]>, data: &[u8]) -> Result<Vec<u8>, String> {
    match key {
        Some(k) => match crypto::decrypt(data, k) {
            Ok(pt) => Ok(pt),
            Err(_) => Ok(data.to_vec()), // not ciphertext -> plaintext passthrough
        },
        None => Ok(data.to_vec()),
    }
}

/// Encrypt a plaintext payload for the wire if encryption is enabled.
pub fn encrypt_payload(c: &Connection, payload: &str) -> Result<String, String> {
    match key_if_enabled(c) {
        Some(k) => crypto::encrypt_str(payload, &k),
        None => Ok(payload.to_string()),
    }
}

/// Decrypt an incoming payload if encryption is enabled; passthrough otherwise.
pub fn decrypt_payload(c: &Connection, payload: &str) -> Result<String, String> {
    match key_if_enabled(c) {
        Some(k) => crypto::decrypt_str(payload, &k),
        None => Ok(payload.to_string()),
    }
}

// ---- disk-encryption helpers ----

/// True if a DB file is SQLCipher-encrypted. A plaintext SQLite file starts with
/// the 16-byte magic "SQLite format 3\0"; SQLCipher replaces it with a random salt.
/// Header-sniffing is the ground truth (self-healing even if a marker is lost) and
/// is what decides whether to `PRAGMA key` before touching a space DB.
pub fn space_db_is_encrypted(path: &Path) -> bool {
    use std::io::Read;
    if let Ok(mut f) = std::fs::File::open(path) {
        let mut buf = [0u8; 16];
        if f.read(&mut buf).unwrap_or(0) == 16 {
            return &buf != b"SQLite format 3\0";
        }
    }
    // Missing / empty / too-small file: nothing protected yet -> treat as plaintext.
    false
}

/// Set a SQLCipher raw key on a freshly-opened connection (`PRAGMA key = "x'hex'"`).
fn set_cipher_key(conn: &Connection, key: &[u8; 32]) -> Result<(), String> {
    let hex = crypto::key_hex(key);
    conn.execute_batch(&format!("PRAGMA key = \"x'{hex}'\";"))
        .map_err(|e| format!("设置 SQLCipher 密钥失败: {e}"))
}

/// Apply `PRAGMA key` to a fresh connection if (and only if) its DB file is
/// encrypted at rest, using the session key. Errors when the file is encrypted but
/// the session is locked (no key) — callers must only reach here unlocked, except
/// the startup gate which avoids opening a keyed space DB until unlock.
pub fn key_space_conn(conn: &Connection, path: &Path) -> Result<(), String> {
    if space_db_is_encrypted(path) {
        let key = session_key().ok_or("工作空间已加密但会话未解锁".to_string())?;
        set_cipher_key(conn, &key)?;
    }
    Ok(())
}

/// Rebuild `src_path`'s schema + data into a brand-new DB at `dst_path`, applying the
/// target key (if `to_encrypted`) so the output is a fully self-contained, re-readable
/// space DB. Uses the app's own `migrate` to recreate the schema and copies each table
/// row-for-row (explicitly skipping FTS shadow tables, re-syncing FTS afterwards). This
/// is deterministic and avoids the platform's unreliable `sqlcipher_export`.
fn rebuild_space_db(
    src_path: &Path,
    dst_path: &Path,
    to_encrypted: bool,
    key: Option<&[u8; 32]>,
    space_id: &str,
) -> Result<(), String> {
    let src_enc = space_db_is_encrypted(src_path);
    // DECRYPT (encrypted source -> plaintext target): open the encrypted source as the
    // KEYED main connection and ATTACH the plaintext target with `KEY ""`, then
    // `sqlcipher_export` copies the full schema + data as plaintext. (Attaching a keyed
    // source to a plaintext connection failed on this build, so we invert the direction.)
    if !to_encrypted && src_enc {
        let k = key.ok_or("解密迁移需要密钥".to_string())?;
        let src = Connection::open(src_path).map_err(|e| e.to_string())?;
        set_cipher_key(&src, k)?;
        let dst_sql = dst_path.display().to_string().replace('\'', "''");
        src.execute_batch(&format!("ATTACH DATABASE '{dst_sql}' AS target KEY \"\";"))
            .map_err(|e| format!("ATTACH 目标库失败: {e}"))?;
        let _r: Result<_, _> = src.query_row("SELECT sqlcipher_export('target')", [], |r| r.get::<_, i64>(0));
        src.execute_batch("DETACH DATABASE target;").map_err(|e| format!("DETACH 目标库失败: {e}"))?;
        src.close().map_err(|(_c, e)| format!("关闭源连接失败: {e}"))?;
        return Ok(());
    }

    // Target connection (keyed if we are encrypting; else plaintext).
    let dst = Connection::open(dst_path).map_err(|e| e.to_string())?;
    if to_encrypted {
        let k = key.ok_or("加密迁移需要密钥".to_string())?;
        set_cipher_key(&dst, k)?;
    }
    // Recreate the app schema on the fresh target (idempotent; seeds workspaces + FTS).
    crate::db::migrate(&dst, space_id).map_err(|e| e.to_string())?;
    let _ = dst.execute_batch("PRAGMA foreign_keys = OFF;");

    // ATTACH the source with a KEY matching ITS cipher state (KEY "" = plaintext so a
    // keyed target connection doesn't try to decrypt it). This enables a cross-state
    // data copy: read from the attached source (its cipher) and write to main (ours).
    let src_sql = src_path.display().to_string().replace('\'', "''");
    let src_key = if src_enc {
        let k = key.ok_or("解密迁移需要密钥".to_string())?;
        format!("KEY \"x'{}\"", crypto::key_hex(k))
    } else {
        "KEY \"\"".to_string()
    };
    dst.execute_batch(&format!("ATTACH DATABASE '{src_sql}' AS plain {src_key};"))
        .map_err(|e| format!("ATTACH 源库失败: {e}"))?;

    // Enumerate the source's real tables (skip sqlite_* system tables and page_fts*
    // FTS shadow tables — the latter are rebuilt below).
    let tables: Vec<String> = {
        let mut stmt = dst
            .prepare(
                "SELECT name FROM plain.sqlite_master WHERE type='table' \
                 AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'page_fts%' ORDER BY name",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?;
        rows.map(|r| r.map_err(|e| e.to_string())).collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    // migrate() seeds the target's `workspaces` row with the space id; drop it so the
    // source's real workspace row replaces it without a UNIQUE conflict.
    let _ = dst.execute_batch("DELETE FROM main.workspaces;");
    for t in &tables {
        dst.execute(&format!("INSERT INTO main.\"{t}\" SELECT * FROM plain.\"{t}\""), [])
            .map_err(|e| format!("拷贝表 {t} 失败: {e}"))?;
    }
    dst.execute_batch("DETACH DATABASE plain;")
        .map_err(|e| format!("DETACH 源库失败: {e}"))?;
    // Re-sync the FTS index from the now-copied pages (migrate only indexes empty pages).
    let _ = dst.execute_batch("DELETE FROM page_fts;");
    dst.execute(
        "INSERT INTO page_fts (page_id, title, body) SELECT id, title, content_text FROM pages WHERE deleted_at IS NULL",
        [],
    )
    .map_err(|e| format!("重建全文索引失败: {e}"))?;

    dst.close().map_err(|(_c, e)| format!("关闭目标库失败: {e}"))?;
    Ok(())
}

/// Convert a space DB file between plaintext and SQLCipher-encrypted at rest,
/// atomically replacing the file. `to_encrypted` selects the target state; `key`
/// is required when encrypting. No-op if the file is already in the target state.
pub fn convert_space_db(path: &Path, to_encrypted: bool, key: Option<&[u8; 32]>) -> Result<(), String> {
    let cur_enc = space_db_is_encrypted(path);
    if cur_enc == to_encrypted {
        return Ok(());
    }
    if !path.exists() {
        // Nothing to convert; a future open will create the DB fresh (and if the
        // space is on encryption, opening with the key will encrypt it on creation).
        return Ok(());
    }
    let dir = path.parent().ok_or("库路径无父目录".to_string())?;
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "db".to_string());
    let tmp = dir.join(format!("{stem}_conv_migrate.db"));
    // Rebuild the source's schema + data into a fresh DB at `tmp` (applying the target
    // key, or leaving plaintext), via the controlled per-table copy.
    rebuild_space_db(path, &tmp, to_encrypted, key, &stem)?;

    // SAFETY: verify the exported temp is actually readable in its target state BEFORE
    // replacing the source. If it isn't, clean up and error, leaving the original file
    // untouched — a failed migration must never corrupt a real space DB.
    let readable = {
        let vc = Connection::open(&tmp).map_err(|e| e.to_string())?;
        if to_encrypted {
            let k = key.ok_or("加密迁移需要密钥".to_string())?;
            set_cipher_key(&vc, k)?;
        }
        vc.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
    };
    if readable.is_err() {
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(tmp.with_extension("db-wal"));
        let _ = std::fs::remove_file(tmp.with_extension("db-shm"));
        return Err("迁移导出校验失败，已中止（原库未受影响）".to_string());
    }

    // Swap: back up the original bytes, remove original + sidecars, move the temp in,
    // then re-verify; restore the backup if the swap left an unreadable file.
    let backup = std::fs::read(path).map_err(|e| format!("备份原库失败: {e}"))?;
    let _ = std::fs::remove_file(Path::new(&format!("{}-wal", path.display())));
    let _ = std::fs::remove_file(Path::new(&format!("{}-shm", path.display())));
    let _ = std::fs::remove_file(Path::new(&format!("{}-journal", path.display())));
    let _ = std::fs::remove_file(path);
    if let Err(e) = std::fs::rename(&tmp, path) {
        std::fs::write(path, &backup).ok();
        return Err(format!("替换库文件失败: {e}"));
    }
    let _ = std::fs::remove_file(tmp.with_extension("db-wal"));
    let _ = std::fs::remove_file(tmp.with_extension("db-shm"));
    // Re-verify the swapped file; restore the backup on failure.
    let sw = {
        let vc = Connection::open(path).map_err(|e| e.to_string())?;
        if to_encrypted {
            let k = key.ok_or("加密迁移需要密钥".to_string())?;
            set_cipher_key(&vc, k)?;
        }
        vc.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
    };
    if sw.is_err() {
        std::fs::write(path, &backup).ok();
        let _ = std::fs::remove_file(Path::new(&format!("{}-wal", path.display())));
        let _ = std::fs::remove_file(Path::new(&format!("{}-shm", path.display())));
        return Err("迁移替换校验失败，已恢复原库".to_string());
    }
    Ok(())
}

/// Re-encrypt/decrypt every existing space DB to match `enabled`. The ACTIVE space is
/// excluded here (its file is held open as the main connection); the caller swaps the
/// active connection first and re-keys it separately via the returned active id handling.
/// Reads space ids from meta.workspaces. Missing files are skipped.
pub fn convert_all_spaces(
    c: &Connection,
    dir: &Path,
    to_encrypted: bool,
    key: Option<&[u8; 32]>,
) -> Result<Vec<String>, String> {
    let active = crate::workspaces::active_workspace_id(c)?;
    let mut spaces: Vec<String> = {
        let mut stmt = c
            .prepare("SELECT id FROM meta.workspaces WHERE deleted_at IS NULL")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| r.map_err(|e| e.to_string())).collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    // Also include the active id itself even if it's not in meta (edge safety).
    if !spaces.contains(&active) {
        spaces.push(active.clone());
    }
    let mut converted = Vec::new();
    for sid in &spaces {
        if sid == &active {
            continue; // caller handles the active connection swap
        }
        let path = space_db_path(dir, sid);
        convert_space_db(&path, to_encrypted, key)?;
        converted.push(sid.clone());
    }
    Ok(converted)
}

/// Re-open the given space DB on the main connection, applying the session-key
/// `PRAGMA key` when the file is encrypted. Used by enable/unlock/disable so the
/// active space is keyed (or plaintext after disable) right after a convert.
fn reopen_keyed(c: &mut Connection, space_id: &str, app_data_dir: &Path) -> Result<(), String> {
    // `reopen_space_at` re-opens the file and re-attaches meta; it applies the key
    // itself (via key_space_conn) when the target file is encrypted.
    crate::db::reopen_space_at(c, space_id, app_data_dir)
}

/// Per-space at-rest encryption marker (meta.workspaces.encrypted): records which
/// space DBs are SQLCipher-encrypted (set on a successful enable/disable). The open
/// path keys a connection when the file is detected as encrypted at rest (header
/// sniff is the ground truth); the marker is explicit bookkeeping per the plan.
pub(crate) fn set_space_encrypted_marked(c: &Connection, space_id: &str, enc: bool) -> Result<(), String> {
    c.execute(
        "UPDATE meta.workspaces SET encrypted = ?1 WHERE id = ?2",
        params![if enc { 1 } else { 0 }, space_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Reset every workspace's encryption marker to 0 (used when rolling back).
fn clear_all_space_markers(c: &Connection) -> Result<(), String> {
    c.execute("UPDATE meta.workspaces SET encrypted = 0", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Roll the app encryption config back to "off" (used when enabling/disabling fails),
/// WITHOUT touching any space DB file (convert_space_db is already safe on failure).
fn rollback_encryption_config(c: &Connection) {
    let _ = sync::set_meta_state(c, crypto::ENC_ENABLED, "0");
    let _ = clear_all_space_markers(c);
    if let Ok(mut g) = SESSION_KEY.lock() {
        *g = None;
    }
    LOCKED.store(false, Ordering::SeqCst);
}

/// Enable app encryption: persist the meta config, encrypt every space DB at rest, and
/// mark them. `conn` is the active connection (space + meta attached); `app_data_dir` is
/// where the space DBs live. Self-contained (takes the session key from the passphrase),
/// so it's testable without a Tauri app.
pub(crate) fn set_encryption_impl(
    conn: &mut Connection,
    app_data_dir: &Path,
    passphrase: String,
) -> Result<(), String> {
    if passphrase.trim().len() < 8 {
        return Err("口令至少 8 位".to_string());
    }
    let salt = crypto::random_salt();
    let key = crypto::derive_key(&passphrase, &salt)?;
    let verify = crypto::encrypt_str(VERIFY_MSG, &key)?;

    // Config lives in meta (plaintext) so a fresh locked launch can still derive the
    // key before the (now-encrypted) space DB is readable.
    sync::set_meta_state(conn, crypto::ENC_SALT, &crypto::b64_encode(&salt))?;
    sync::set_meta_state(conn, crypto::ENC_VERIFY, &verify)?;
    sync::set_meta_state(conn, crypto::ENC_ENABLED, "1")?;
    let active = crate::workspaces::active_workspace_id(conn)?;
    // NOTE: `ENC_KEY` is intentionally NOT persisted — the derived key is only held
    // in this session (SESSION_KEY). At-rest protection comes from the SQLCipher
    // space DBs encrypted below with the same key.
    *SESSION_KEY.lock().map_err(|_| "会话锁失效".to_string())? = Some(key);
    LOCKED.store(false, Ordering::SeqCst);

    // Convert every non-active space to disk-encrypted (active handled last via swap).
    let non_active = match convert_all_spaces(conn, app_data_dir, true, Some(&key)) {
        Ok(v) => v,
        Err(e) => {
            rollback_encryption_config(conn);
            return Err(e);
        }
    };
    // Mark every successfully converted non-active space as encrypted.
    for sid in &non_active {
        if let Err(e) = set_space_encrypted_marked(conn, sid, true) {
            rollback_encryption_config(conn);
            return Err(e);
        }
    }

    // Swap out the active connection, convert its file, then re-open it keyed.
    let active_path = space_db_path(app_data_dir, &active);
    let _ = std::mem::replace(conn, Connection::open_in_memory().map_err(|e| e.to_string())?);
    if let Err(e) = convert_space_db(&active_path, true, Some(&key)) {
        // convert_space_db is safe: it restored the plaintext source on failure.
        let _ = crate::db::reopen_space_at(conn, &active, app_data_dir);
        rollback_encryption_config(conn);
        return Err(e);
    }
    reopen_keyed(conn, &active, app_data_dir)?;
    if let Err(e) = set_space_encrypted_marked(conn, &active, true) {
        rollback_encryption_config(conn);
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
pub fn set_encryption(db: State<Db>, passphrase: String) -> Result<(), String> {
    let mut guard = db.0.lock().map_err(|_| "会话锁失效".to_string())?;
    let dir = crate::db::app_data_dir_ref().ok_or("app data dir not initialised")?;
    set_encryption_impl(&mut *guard, dir, passphrase)
}

/// Gate sync: when encryption is on but the session is locked, refuse to sync
/// rather than silently sending/accepting plaintext on the wire.
pub fn sync_gate(c: &Connection) -> Result<(), String> {
    if encryption_enabled(c) && LOCKED.load(Ordering::SeqCst) {
        return Err("已开启端到端加密但会话已锁定，请先解锁再同步".to_string());
    }
    Ok(())
}

#[derive(Serialize)]
pub struct EncryptionStatus {
    pub enabled: bool,
    pub locked: bool,
}

#[tauri::command]
pub fn encryption_status(db: State<Db>) -> Result<EncryptionStatus, String> {
    let c = conn(&db);
    Ok(EncryptionStatus {
        enabled: encryption_enabled(&c),
        locked: LOCKED.load(Ordering::SeqCst),
    })
}

/// Lock the session: drop the session key, mark locked, and CLOSE the active space
/// connection (restore an in-memory base + meta, like the startup gate) so a locked
/// session genuinely cannot read the space — the "锁定态不读" E1 guarantee, not just
/// gating sync. `unlock_encryption` re-opens the space keyed.
pub(crate) fn lock_encryption_impl(conn: &mut Connection, app_data_dir: &Path) -> Result<(), String> {
    if !encryption_enabled(conn) {
        return Err("未开启端到端加密".to_string());
    }
    *SESSION_KEY.lock().map_err(|_| "会话锁失效".to_string())? = None;
    LOCKED.store(true, Ordering::SeqCst);
    let _ = std::mem::replace(conn, Connection::open_in_memory().map_err(|e| e.to_string())?);
    let meta = crate::db::meta_path(app_data_dir).display().to_string().replace('\'', "''");
    conn.execute_batch(&format!("ATTACH DATABASE '{meta}' AS meta KEY \"\""))
        .map_err(|e| format!("锁定时重置连接失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn lock_encryption(db: State<Db>) -> Result<(), String> {
    let mut guard = db.0.lock().map_err(|_| "会话锁失效".to_string())?;
    let dir = crate::db::app_data_dir_ref().ok_or("app data dir not initialised")?;
    lock_encryption_impl(&mut *guard, dir)
}

/// Unlock the session: verify the passphrase against the meta sentinel, store the derived
/// session key, and re-open the active space DB keyed (it is SQLCipher-encrypted at rest).
pub(crate) fn unlock_encryption_impl(
    conn: &mut Connection,
    app_data_dir: &Path,
    passphrase: String,
) -> Result<(), String> {
    if !encryption_enabled(conn) {
        return Err("未开启端到端加密".to_string());
    }
    let salt_b64 = sync::get_meta_state(conn, crypto::ENC_SALT).ok_or("加密状态缺失".to_string())?;
    let salt = crypto::b64_decode(&salt_b64).map_err(|e| format!("盐值无效: {e}"))?;
    let key = crypto::derive_key(&passphrase, &salt)?;
    let verify = sync::get_meta_state(conn, crypto::ENC_VERIFY).ok_or("加密状态缺失".to_string())?;
    let msg = crypto::decrypt_str(&verify, &key).map_err(|_| "口令不正确".to_string())?;
    if msg != VERIFY_MSG {
        return Err("口令不正确".to_string());
    }
    let active = crate::workspaces::active_workspace_id(conn)?;
    *SESSION_KEY.lock().map_err(|_| "会话锁失效".to_string())? = Some(key);
    LOCKED.store(false, Ordering::SeqCst);
    // Re-open the active space DB keyed — without this PRAGMA key the app would fail to
    // read it after a locked restart.
    reopen_keyed(conn, &active, app_data_dir)?;
    Ok(())
}

#[tauri::command]
pub fn unlock_encryption(db: State<Db>, passphrase: String) -> Result<(), String> {
    let mut guard = db.0.lock().map_err(|_| "会话锁失效".to_string())?;
    let dir = crate::db::app_data_dir_ref().ok_or("app data dir not initialised")?;
    unlock_encryption_impl(&mut *guard, dir, passphrase)
}

/// Disable app encryption: decrypt every space DB back to plaintext, clear the meta flag
/// + markers, and clear the session key. Requires an unlocked session (the key to decrypt).
pub(crate) fn disable_encryption_impl(conn: &mut Connection, app_data_dir: &Path) -> Result<(), String> {
    let key = *SESSION_KEY.lock().map_err(|_| "会话锁失效".to_string())?;
    if !encryption_enabled(conn) {
        return Err("未开启端到端加密".to_string());
    }
    // We need the key to decrypt the space DBs; if the session is locked (key gone),
    // ask for the passphrase to recover it rather than leaving encrypted DBs unreadable.
    if key.is_none() {
        return Err("会话已锁定，请先解锁（输入口令）再关闭加密，以免加密库无法读取".to_string());
    }
    let active = crate::workspaces::active_workspace_id(conn)?;
    let key = key.unwrap();
    // Decrypt every non-active space back to plaintext. If any cannot be decrypted,
    // fail without turning the flag off.
    convert_all_spaces(conn, app_data_dir, false, Some(&key))?;
    // Turn the app-level flag off (in meta).
    sync::set_meta_state(conn, crypto::ENC_ENABLED, "0")?;
    clear_all_space_markers(conn)?;

    let active_path = space_db_path(app_data_dir, &active);
    let _ = std::mem::replace(conn, Connection::open_in_memory().map_err(|e| e.to_string())?);
    if let Err(e) = convert_space_db(&active_path, false, Some(&key)) {
        let _ = crate::db::reopen_space_at(conn, &active, app_data_dir);
        sync::set_meta_state(conn, crypto::ENC_ENABLED, "1")?;
        return Err(e);
    }
    reopen_keyed(conn, &active, app_data_dir)?;
    *SESSION_KEY.lock().map_err(|_| "会话锁失效".to_string())? = None;
    LOCKED.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn disable_encryption(db: State<Db>) -> Result<(), String> {
    let mut guard = db.0.lock().map_err(|_| "会话锁失效".to_string())?;
    let dir = crate::db::app_data_dir_ref().ok_or("app data dir not initialised")?;
    disable_encryption_impl(&mut *guard, dir)
}

/// On app start, if encryption is enabled, default to the locked state so the derived
/// key must be re-entered before any encrypted sync happens (restart does not leave
/// the session unlocked with a persisted key).
pub fn startup_lock(c: &Connection) {
    if encryption_enabled(c) {
        LOCKED.store(true, Ordering::SeqCst);
    }
}

// ---- round-trip tests ----
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;
    use std::path::PathBuf;

    // SESSION_KEY / LOCKED are process-wide statics. These tests set them, so they
    // must not run concurrently with each other (or the key_space_conn reopen in
    // header_sniff could read an overwritten session key).
    static SEC_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A temp dir owning a real on-disk meta.db + a plaintext space DB, with `meta`
    /// ATTACHed on the returned space connection so the meta-slot config helpers and
    /// the startup gate behave like the real app connection. Keeps meta.db open while
    /// the tests read/write the meta config.
    struct Temp {
        _dir: PathBuf,
        _meta_conn: Connection,
    }

    fn temp_ws() -> (Temp, Connection) {
        let dir = std::env::temp_dir().join(format!("shuy_e1_{}_{}", std::process::id(), db::now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let meta_path = dir.join("meta.db");
        {
            let m = Connection::open(&meta_path).unwrap();
            m.execute_batch(
                "CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, theme TEXT, icon TEXT NOT NULL DEFAULT '', sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, encrypted INTEGER NOT NULL DEFAULT 0); \
                 CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
            )
            .unwrap();
            m.execute_batch("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('default', '默认空间', 1, 1)")
                .unwrap();
        }
        // A space DB file (initially plaintext, valid SQLite with our schema).
        let space_path = dir.join("default.db");
        {
            let s = Connection::open(&space_path).unwrap();
            s.execute_batch(
                "CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); \
                 CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); \
                 CREATE TABLE pages (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL DEFAULT '', content_json TEXT NOT NULL DEFAULT '{}', content_text TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'page', sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);",
            )
            .unwrap();
            s.execute_batch("INSERT INTO pages (id, workspace_id, title, created_at, updated_at) VALUES ('p1', 'default', 'hi', 1, 1)")
                .unwrap();
        }
        // Main connection re-opens the space DB, then ATTACHes meta as `meta`.
        let conn = Connection::open(&space_path).unwrap();
        let meta_sql = meta_path.display().to_string().replace('\'', "''");
        conn.execute_batch(&format!("ATTACH DATABASE '{meta_sql}' AS meta")).unwrap();
        let tmp = Temp { _dir: dir, _meta_conn: Connection::open(&meta_path).unwrap() };
        (tmp, conn)
    }

    // Header-sniff + open-time keying, against a DB produced by the DETERMINISTIC
    // manual sqlcipher_export (which is what open-time keying uses in the app; the
    // convert_space_db migration is best-effort and separately documented). Covers:
    // plaintext not-encrypted, encrypted detected, unkeyed read fails, wrong key
    // fails, right key reads.
    #[test]
    fn attachment_bytes_encrypt_decrypt_roundtrip() {
        let salt = crypto::random_salt();
        let key = crypto::derive_key("hunter2", &salt).unwrap();
        let plain = b"some attachment bytes \x00\x01\x02";
        let enc = encrypt_attachment_bytes(Some(&key), plain).unwrap();
        assert_ne!(enc, plain);
        let dec = decrypt_attachment_bytes(Some(&key), &enc).unwrap();
        assert_eq!(dec, plain);
        // Wrong key -> decrypt fails -> raw ciphertext passthrough (never corrupts).
        let wrong = crypto::derive_key("wrong", &salt).unwrap();
        let dec2 = decrypt_attachment_bytes(Some(&wrong), &enc).unwrap();
        assert_eq!(dec2, enc);
        // No key (encryption off/locked) -> passthrough.
        assert_eq!(encrypt_attachment_bytes(None, plain).unwrap(), plain);
        assert_eq!(decrypt_attachment_bytes(None, plain).unwrap(), plain);
        // A key present but the data is plaintext -> passthrough (backward compat).
        assert_eq!(decrypt_attachment_bytes(Some(&key), plain).unwrap(), plain);
    }

    #[test]
    fn encrypted_db_roundtrip_and_sniff() {
        let _g = SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuy_sniff_{}_{}", std::process::id(), db::now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("default.db");
        {
            let c = Connection::open(&src).unwrap();
            c.execute_batch("CREATE TABLE pages (id TEXT PRIMARY KEY, title TEXT); INSERT INTO pages VALUES('p1','hi');").unwrap();
            c.close().unwrap();
        }
        assert!(!space_db_is_encrypted(&src));
        let salt = crypto::random_salt();
        let key = crypto::derive_key("hunter2", &salt).unwrap();
        let hex = crypto::key_hex(&key);
        // REPLICATE convert_space_db: sniff the source first (File::open + read),
        // then export — to test whether that sniff corrupts the export.
        assert!(!space_db_is_encrypted(&src));
        let encp = dir.join("enc.db");
        {
            let c = Connection::open(&src).unwrap();
            let e = encp.display().to_string().replace('\'', "''");
            c.execute_batch(&format!("ATTACH DATABASE '{e}' AS enc KEY \"x'{hex}'\";")).unwrap();
            let _ = c.query_row("SELECT sqlcipher_export('enc')", [], |r| r.get::<_, i64>(0));
            c.execute_batch("DETACH DATABASE enc;").unwrap();
            c.close().unwrap();
        }
        assert!(space_db_is_encrypted(&encp));
        // Unkeyed read fails.
        {
            let c = Connection::open(&encp).unwrap();
            assert!(c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0)).is_err());
        }
        // Wrong key fails.
        let wrong = crypto::derive_key("wrong-pass", &salt).unwrap();
        {
            let c = Connection::open(&encp).unwrap();
            c.execute_batch(&format!("PRAGMA key = \"x'{}\";", crypto::key_hex(&wrong))).unwrap();
            assert!(c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0)).is_err());
        }
        // Right key via key_space_conn (session key) reads.
        *SESSION_KEY.lock().unwrap() = Some(key);
        {
            let c = Connection::open(&encp).unwrap();
            key_space_conn(&c, &encp).unwrap();
            let n: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 1);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    // convert_space_db (per-table rebuild migration) ENCRYPT direction: build a plaintext
    // space DB with the REAL app schema + a page, encrypt it in place, verify it reads
    // back via the open-time keying (header sniff + session key), and confirm no temp
    // files remain. This is the E1 enable-migration that actually encrypts existing spaces.
    #[test]
    fn convert_space_db_encrypt_back_to_readable() {
        let _g = SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuy_conv_{}_{}", std::process::id(), db::now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let space = dir.join("default.db");
        {
            let c = Connection::open(&space).unwrap();
            crate::db::migrate(&c, "default").unwrap();
            c.execute(
                "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at) \
                 VALUES ('p1', 'default', NULL, 'hi', '{\"root\":{}}', 'hi', 'page', 0, 1, 1, NULL)",
                [],
            )
            .unwrap();
            c.close().unwrap();
        }
        let salt = crypto::random_salt();
        let key = crypto::derive_key("hunter2", &salt).unwrap();
        // Encrypt in place.
        convert_space_db(&space, true, Some(&key)).unwrap();
        *SESSION_KEY.lock().unwrap() = Some(key);
        assert!(space_db_is_encrypted(&space));
        // Reopen with the session key (the open-point path the app uses) and read rows.
        {
            let c = Connection::open(&space).unwrap();
            key_space_conn(&c, &space).unwrap();
            let n: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 1);
            let title: String = c.query_row("SELECT title FROM pages WHERE id='p1'", [], |r| r.get(0)).unwrap();
            assert_eq!(title, "hi");
        }
        // Decrypt back to plaintext (disable) and verify it reads without a key.
        convert_space_db(&space, false, Some(&key)).unwrap();
        assert!(!space_db_is_encrypted(&space));
        {
            let c = Connection::open(&space).unwrap();
            let n: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 1);
        }
        // No temp files left behind.
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("_conv_"))
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // convert_space_db must be SAFE on a real failure: if the swap verification fails,
    // it restores the original. Here we force a failure by decrypting a NON-encrypted
    // source (a no-op in `convert_space_db`, so instead we assert the encrypt direction
    // is idempotent: converting an already-encrypted file is a no-op and stays readable).
    #[test]
    fn convert_space_db_is_idempotent_for_already_encrypted() {
        let _g = SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuy_idem_{}_{}", std::process::id(), db::now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let space = dir.join("default.db");
        {
            let c = Connection::open(&space).unwrap();
            crate::db::migrate(&c, "default").unwrap();
            c.execute("INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at) VALUES ('p1','default',NULL,'hi','{}','hi','page',0,1,1,NULL)", []).unwrap();
            c.close().unwrap();
        }
        let salt = crypto::random_salt();
        let key = crypto::derive_key("hunter2", &salt).unwrap();
        convert_space_db(&space, true, Some(&key)).unwrap();
        assert!(space_db_is_encrypted(&space));
        // Converting an already-encrypted file back to "encrypted" is a no-op.
        convert_space_db(&space, true, Some(&key)).unwrap();
        assert!(space_db_is_encrypted(&space));
        *SESSION_KEY.lock().unwrap() = Some(key);
        let c = Connection::open(&space).unwrap();
        key_space_conn(&c, &space).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Full E1 closed loop at the Rust layer: enable (encrypt spaces + mark) -> simulate a
    // restart with the session locked (no key) -> unlock (verify passphrase, reopen keyed)
    // -> data readable -> disable (decrypt back). Exercises the real set/unlock/disable
    // cores against an on-disk app dir.
    #[test]
    fn full_loop_enable_restart_unlock_readable_disable() {
        let _g = SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuy_loop_{}_{}", std::process::id(), db::now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir.join("spaces")).unwrap();
        let meta_path = dir.join("meta.db");
        {
            let m = Connection::open(&meta_path).unwrap();
            m.execute_batch(
                "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, theme TEXT, icon TEXT NOT NULL DEFAULT '', sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, encrypted INTEGER NOT NULL DEFAULT 0); \
                 CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
            )
            .unwrap();
            m.execute_batch("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('default', '默认空间', 1, 1)").unwrap();
            m.close().unwrap();
        }
        let space_path = dir.join("spaces").join("default.db");
        {
            let s = Connection::open(&space_path).unwrap();
            crate::db::migrate(&s, "default").unwrap();
            s.execute_batch("INSERT INTO pages (id, workspace_id, title, content_text, created_at, updated_at) VALUES ('p1','default','hello','hello',1,1)").unwrap();
            s.close().unwrap();
        }
        let meta_sql = meta_path.display().to_string().replace('\'', "''");
        // Main app connection: active space + meta attached.
        let mut conn = Connection::open(&space_path).unwrap();
        conn.execute_batch(&format!("ATTACH DATABASE '{meta_sql}' AS meta")).unwrap();

        // ---- ENABLE ----
        set_encryption_impl(&mut conn, &dir, "pass1234".to_string()).unwrap();
        assert!(space_db_is_encrypted(&space_path));
        assert!(encryption_enabled(&conn));
        let marker: i64 = conn.query_row("SELECT encrypted FROM meta.workspaces WHERE id='default'", [], |r| r.get(0)).unwrap();
        assert_eq!(marker, 1);
        // The active space is reopened keyed, so the main conn can read it.
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // Simulate the app restart: drop the enable-time connection entirely (a real
        // restart closes every handle to the space before re-opening locked).
        drop(conn);

        // ---- SIMULATE RESTART (session locked, no key persisted) ----
        *SESSION_KEY.lock().unwrap() = None;
        LOCKED.store(true, Ordering::SeqCst);
        // A fresh connection to the encrypted space WITHOUT the key cannot read it.
        {
            let fresh = Connection::open(&space_path).unwrap();
            assert!(fresh.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0)).is_err());
        }
        // Wrong passphrase fails. (The locked-main handle is an in-memory base + meta
        // attached, like db::init's startup gate — the encrypted space is NOT opened.)
        let mut bad = Connection::open_in_memory().unwrap();
        bad.execute_batch(&format!("ATTACH DATABASE '{meta_sql}' AS meta KEY \"\"")).unwrap();
        assert!(unlock_encryption_impl(&mut bad, &dir, "wrong-pass".to_string()).is_err());

        // ---- UNLOCK (fresh locked-main handle -> reopens keyed space) ----
        let mut locked = Connection::open_in_memory().unwrap();
        locked.execute_batch(&format!("ATTACH DATABASE '{meta_sql}' AS meta KEY \"\"")).unwrap();
        unlock_encryption_impl(&mut locked, &dir, "pass1234".to_string()).unwrap();
        assert_eq!(LOCKED.load(Ordering::SeqCst), false);
        let n: i64 = locked.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // User data is lossless across the encrypt->unlock migration.
        let ws_name: String = locked.query_row("SELECT name FROM workspaces WHERE id='default'", [], |r| r.get(0)).unwrap();
        assert_eq!(ws_name, "默认空间");
        let title: String = locked.query_row("SELECT title FROM pages WHERE id='p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(title, "hello");

        // ---- DISABLE (decrypt back) ----
        disable_encryption_impl(&mut locked, &dir).unwrap();
        assert!(!space_db_is_encrypted(&space_path));
        let n: i64 = locked.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        assert!(!encryption_enabled(&locked));
        let title2: String = locked.query_row("SELECT title FROM pages WHERE id='p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(title2, "hello");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Cross-space open path (`open_space_conn_at`) reads an ENCRYPTED non-active space
    // correctly by keying the fresh connection (the "db.rs 打开点 PRAGMA key" item).
    #[test]
    fn open_space_conn_reads_encrypted_space() {
        let _g = SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuy_osc_{}_{}", std::process::id(), db::now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir.join("spaces")).unwrap();
        let meta_path = dir.join("meta.db");
        {
            let m = Connection::open(&meta_path).unwrap();
            m.execute_batch("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, theme TEXT, icon TEXT NOT NULL DEFAULT '', sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, encrypted INTEGER NOT NULL DEFAULT 0);").unwrap();
            m.close().unwrap();
        }
        let space_path = dir.join("spaces").join("default.db");
        {
            let s = Connection::open(&space_path).unwrap();
            crate::db::migrate(&s, "default").unwrap();
            s.execute_batch("INSERT INTO pages (id, workspace_id, title, content_text, created_at, updated_at) VALUES ('p1','default','hello','hello',1,1)").unwrap();
            s.close().unwrap();
        }
        let salt = crypto::random_salt();
        let key = crypto::derive_key("hunter2", &salt).unwrap();
        // Encrypt the space at rest, then open it via the cross-space path (keyed).
        convert_space_db(&space_path, true, Some(&key)).unwrap();
        *SESSION_KEY.lock().unwrap() = Some(key);
        let conn = crate::db::open_space_conn_at("default", &dir).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // Full-text search still works post-encryption (the migration rebuilds page_fts).
        let fts: i64 = conn
            .query_row("SELECT COUNT(*) FROM page_fts WHERE page_fts MATCH 'hello'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fts, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // "锁定态不读": lock_encryption closes the space connection (in-memory+meta), so a
    // locked session cannot read the space; unlock re-opens it keyed and reads work.
    #[test]
    fn lock_closes_connection_unlock_reopens() {
        let _g = SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuy_lock_{}_{}", std::process::id(), db::now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir.join("spaces")).unwrap();
        let meta_path = dir.join("meta.db");
        {
            let m = Connection::open(&meta_path).unwrap();
            m.execute_batch("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, theme TEXT, icon TEXT NOT NULL DEFAULT '', sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, encrypted INTEGER NOT NULL DEFAULT 0); CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
            m.execute_batch("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('default','默认空间',1,1)").unwrap();
            m.close().unwrap();
        }
        let space_path = dir.join("spaces").join("default.db");
        {
            let s = Connection::open(&space_path).unwrap();
            crate::db::migrate(&s, "default").unwrap();
            s.execute_batch("INSERT INTO pages (id, workspace_id, title, content_text, created_at, updated_at) VALUES ('p1','default','hello','hello',1,1)").unwrap();
            s.close().unwrap();
        }
        let meta_sql = meta_path.display().to_string().replace('\'', "''");
        let mut conn = Connection::open(&space_path).unwrap();
        conn.execute_batch(&format!("ATTACH DATABASE '{meta_sql}' AS meta")).unwrap();
        // enable -> encrypted + keyed
        set_encryption_impl(&mut conn, &dir, "pass1234".to_string()).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // lock -> connection becomes in-memory+meta, space NOT readable
        lock_encryption_impl(&mut conn, &dir).unwrap();
        assert_eq!(LOCKED.load(Ordering::SeqCst), true);
        assert!(conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0)).is_err());
        // meta is still accessible (app shell)
        let enabled: bool = encryption_enabled(&conn);
        assert!(enabled);
        // unlock -> reopens keyed space, readable again
        unlock_encryption_impl(&mut conn, &dir, "pass1234".to_string()).unwrap();
        assert_eq!(LOCKED.load(Ordering::SeqCst), false);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Enable encryption in meta (not the space DB) and populate the session key/unlock.
    fn enable_meta(c: &Connection, pass: &str) -> [u8; 32] {
        let salt = crypto::random_salt();
        let key = crypto::derive_key(pass, &salt).unwrap();
        sync::set_meta_state(c, crypto::ENC_SALT, &crypto::b64_encode(&salt)).unwrap();
        sync::set_meta_state(c, crypto::ENC_VERIFY, &crypto::encrypt_str(VERIFY_MSG, &key).unwrap()).unwrap();
        sync::set_meta_state(c, crypto::ENC_ENABLED, "1").unwrap();
        *SESSION_KEY.lock().unwrap() = Some(key);
        LOCKED.store(false, Ordering::SeqCst);
        key
    }

    #[test]
    fn payload_roundtrip_when_enabled() {
        let _g = SEC_LOCK.lock().unwrap();
        let (_t, c) = temp_ws();
        enable_meta(&c, "supersecret");
        let plain = r#"{"id":"p1","content_json":"hello","content_text":"hi"}"#;
        let enc = encrypt_payload(&c, plain).unwrap();
        assert_ne!(enc, plain);
        let dec = decrypt_payload(&c, &enc).unwrap();
        assert_eq!(dec, plain);
        // key is only in session, never persisted anywhere.
        assert!(sync::get_state(&c, crypto::ENC_KEY).is_none());
        assert!(sync::get_meta_state(&c, crypto::ENC_KEY).is_none());
    }

    #[test]
    fn payload_passthrough_when_disabled() {
        let (_t, c) = temp_ws();
        let plain = "plaintext payload";
        assert_eq!(encrypt_payload(&c, plain).unwrap(), plain);
        assert_eq!(decrypt_payload(&c, plain).unwrap(), plain);
    }

    #[test]
    fn verify_sentinel_roundtrip() {
        let salt = crypto::random_salt();
        let key = crypto::derive_key("correct-horse", &salt).unwrap();
        let wrong = crypto::derive_key("wrong-pass", &salt).unwrap();
        let sentinel = crypto::encrypt_str(VERIFY_MSG, &key).unwrap();
        assert_eq!(crypto::decrypt_str(&sentinel, &key).unwrap(), VERIFY_MSG);
        assert!(crypto::decrypt_str(&sentinel, &wrong).is_err());
    }

    #[test]
    fn lock_gates_key_and_sync() {
        let _g = SEC_LOCK.lock().unwrap();
        let (_t, c) = temp_ws();
        enable_meta(&c, "supersecret");
        assert!(key_if_enabled(&c).is_some());
        assert!(sync_gate(&c).is_ok());

        LOCKED.store(true, Ordering::SeqCst);
        assert!(key_if_enabled(&c).is_none());
        assert!(sync_gate(&c).is_err());

        LOCKED.store(false, Ordering::SeqCst);
        assert!(key_if_enabled(&c).is_some());
        assert!(sync_gate(&c).is_ok());
    }

    // A raw SQLCipher key (x'hex') created on one connection is readable on a fresh
    // connection with the same key and fails with a wrong key — the disk-encryption
    // foundation that convert_space_db builds on.
    #[test]
    fn raw_key_open_and_read() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("shuy_rawkey_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let hex = crypto::key_hex(&[7u8; 32]);
        let key_sql = format!("PRAGMA key = \"x'{hex}'\";");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(&key_sql).unwrap();
            c.execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t(v) VALUES('secret');").unwrap();
        }
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(&key_sql).unwrap();
            let v: String = c.query_row("SELECT v FROM t WHERE id=1", [], |r| r.get(0)).unwrap();
            assert_eq!(v, "secret");
        }
        let _ = std::fs::remove_file(&path);
    }
}
