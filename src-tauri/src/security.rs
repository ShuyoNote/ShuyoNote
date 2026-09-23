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
static SESSION_KEY: Mutex<Option<crypto::AppKeys>> = Mutex::new(None);

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

/// Read the session-held **key material** (if encryption is on and the session is unlocked).
/// No longer reads any persisted key — this is the E1 "密钥不落盘" guarantee.
///
/// 返回**整套**材料（`crypto::AppKeys`）而不是裸 32 字节：国密构建下应用层 AEAD 需要两把
/// 独立密钥（§0-B），而 `legacy` 那一把仍在里面 —— 它既给 v0/v1 双读，也是 SQLCipher 的 `PRAGMA key`。
pub fn key_if_enabled(c: &Connection) -> Option<crypto::AppKeys> {
    if !encryption_enabled(c) || LOCKED.load(Ordering::SeqCst) {
        return None;
    }
    *SESSION_KEY.lock().ok()?
}

/// Session-held key bytes (for SQLCipher `PRAGMA key` when opening an encrypted space DB).
/// Returns the raw 32-byte key regardless of the locked flag; callers gate on
/// [`encryption_enabled`] + lock state themselves.
pub fn session_key() -> Option<[u8; 32]> {
    SESSION_KEY.lock().ok()?.map(|k| k.legacy)
}

/// Encrypt attachment BYTES at rest using the session key, ONLY when encryption is on
/// and the session is unlocked. When off (or locked) this passes the bytes through
/// unchanged, so existing plaintext attachments keep working and new ones are stored
/// plainly until encryption is enabled.
pub fn encrypt_attachment_bytes(key: Option<&crypto::AppKeys>, data: &[u8]) -> Result<Vec<u8>, String> {
    match key {
        Some(k) => crypto::encrypt(data, k),
        None => Ok(data.to_vec()),
    }
}

/// Decrypt attachment bytes read back from disk. When key material is present, tries to
/// decrypt (**双读**：v0 无头 / v1 XChaCha20 / v2 国密，由密文头分派); if it fails the bytes
/// were plaintext (pre-encryption data, or encryption was off when saved), so they are
/// returned unchanged.
pub fn decrypt_attachment_bytes(key: Option<&crypto::AppKeys>, data: &[u8]) -> Result<Vec<u8>, String> {
    match key {
        Some(k) => {
            // ★ §0-C：**先看头**。这一段如果"看着就是密文、但版本本构建解不开"（典型：老版本应用遇到
            // 国密版写下的 v2 附件），**必须拒绝** —— 绝不能顺着"解不开 ⇒ 当明文"的旧逻辑把**密文**
            // 当明文交出去（那会安静地写出一个损坏的文件，是比报错更坏的结局）。
            let version = crypto::peek_format(data);
            if !crypto::format_supported(version) {
                return Err(crypto::unsupported_format_error(version));
            }
            match crypto::decrypt(data, k) {
                Ok(pt) => Ok(pt),
                // 认得出的版本、但解不开 ⇒ 仍然是"不是密文/口令不同"的老语义：透传
                //（历史行为：加密未开时存的就是明文；改这条会让既有明文附件读不出来）
                Err(_) => Ok(data.to_vec()),
            }
        }
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

/// 一段同步载荷（base64）里那段的密文版本 —— **不解密、不要密钥**。
/// 返回 `None` = 看着不像我们写的密文（加密未开时的明文 JSON、或老的无头数据）。
pub fn payload_format(payload: &str) -> Option<u8> {
    let bytes = crypto::b64_decode(payload).ok()?;
    crypto::peek_format(&bytes)
}

/// ★★ **整批拒绝**（§0-C）：这批载荷里只要有一段是本构建解不开的版本，
/// 就**一条都不应用**，并给出可操作错误 —— 而不是逐条解密失败、让用户以为"数据坏了"。
///
/// 为什么必须"整批"：逐条失败会**应用一半**（游标停在中途），用户看到的是"同步了一部分、
/// 剩下的一直报错"，而真正的原因是"这版应用读不了那个空间的数据"。
pub fn ensure_payloads_supported<'a>(payloads: impl IntoIterator<Item = &'a str>) -> Result<(), String> {
    let mut bad: Option<u8> = None;
    for p in payloads {
        // 只对"看着像我们写的密文"的载荷下结论：明文载荷 peek 出 None ⇒ 放行。
        if let Some(v) = payload_format(p) {
            if !crypto::format_supported(Some(v)) {
                bad = Some(v);
                break;
            }
        }
    }
    match bad {
        None => Ok(()),
        Some(v) => Err(format!(
            "本批同步数据里有本机解不开的密文版本（{v}）：{}。已**整批拒绝**，一条都没有应用",
            crypto::unsupported_format_error(Some(v))
        )),
    }
}

/// 这个空间**记录在案**的密文格式（`None` = 没记录）。§0-C："算法标识要落到空间状态上"。
///
/// ⚠️ 两处刻意的取舍：
/// ① 查询失败（老库缺列等）**吞成 `None` 而不是报错** —— 这一列的来源是 `db.rs` 的幂等迁移，
///    而"读不到"与"没记录"在**守卫**语义下都是"不该拦"（拦错会把能用的空间也锁住）；
/// ② 因此它**不是**安全边界，只是"尽早给一句人话"的机制：真正的拒绝在解密那一层（版本不支持 ⇒ Err）。
/// 记录的是"启用加密时本机构建写出去的那一版"，所以老端一开这个空间就能在**动手之前**判断。
pub fn space_format(c: &Connection, space_id: &str) -> Option<u8> {
    let v: i64 = c
        .query_row(
            "SELECT COALESCE(cipher_format, 0) FROM meta.workspaces WHERE id = ?1",
            params![space_id],
            |r| r.get(0),
        )
        .ok()?;
    if v <= 0 {
        None
    } else {
        Some(v as u8)
    }
}

/// 同步/使用这个空间**之前**的守卫：记录在案的格式本机构建解不开 ⇒ 明确拒绝并提示升级（§0-C）。
pub fn ensure_space_format_supported(c: &Connection, space_id: &str) -> Result<(), String> {
    match space_format(c, space_id) {
        Some(v) if !crypto::format_supported(Some(v)) => Err(format!(
            "这个空间（{space_id}）的数据是密文版本 {v}：{}",
            crypto::unsupported_format_error(Some(v))
        )),
        _ => Ok(()),
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
        .map_err(|e| format!("设置 SQLCipher 密钥失败: {e}"))?;
    // ★ P2 接线（2026-09-20）：把**页 MAC 与库 KDF 也设成国密**。这是"库级国密从能力变行为"的那一步。
    //   只在带 provider 补丁的构建（`sm-library`）里做：没有补丁的构建上这两条 PRAGMA 会被
    //   **静默丢掉**（回显依旧、不报错）⇒ 那正是"以为设了"的形态。
    #[cfg(feature = "sm-library")]
    apply_gm_page_settings(conn)?;
    Ok(())
}

/// `cipher_hmac_algorithm = HMAC_SM3` ＋ `cipher_kdf_algorithm = PBKDF2_HMAC_SM3`，**并校验回声**。
///
/// 顺序（AMD 2026-09-20 实测，见 `gm_provider.rs` 头注）：必须在 `PRAGMA key` **之后**、
/// 第一次读写**之前** —— key 之前设会被静默丢弃。
///
/// 三步，**互不依赖**（2026-09-22 更正，第一版把三件事混成一件，误诊了"口令不对"）：
///   ① [`library_recognizes_gm_labels`]：**这个库认不认识国密标签** —— 用内存库探，与口令/文件无关；
///      不认识就**响亮失败**（那种构建上标签会被静默丢掉，写出来仍 SHA512）。
///   ② [`set_gm_cipher_labels`]：设两条 PRAGMA。⚠️ **不能**用 `configure_gm_cipher`
///      （它带 `SELECT 1` 健康自检，而"口令不对"与"标签不认识"在那句话上**一字不差**）——
///      否则用错口令解锁空间时会报"这个构建可能没有 provider 补丁"，属**误诊**。
///   ③ [`read_gm_cipher_status`]：**回显**必须是 `Applied`；回显**读不出来**时不判红（那是这条连接
///      自己的问题，让后面的读去失败 ⇒ 由 `cipher_open_error` 翻成"两因一果"的可操作文本）。
#[cfg(feature = "sm-library")]
fn apply_gm_page_settings(conn: &Connection) -> Result<(), String> {
    use crate::gm_provider::{library_recognizes_gm_labels, read_gm_cipher_status, set_gm_cipher_labels};
    if !library_recognizes_gm_labels() {
        return Err(
            "这份构建的 SQLCipher **不认识** `HMAC_SM3` / `PBKDF2_HMAC_SM3`（内存库回显不是国密标签）——\n\
             而它**不会报错**：SQLCipher 接受不认识的标签却照默认算法走 ⇒ 写出来的仍是 SHA512 那套。\n\
             ⇒ 按约定**拒绝继续**：要么国密、要么别写库。多半是这份构建的 SQLCipher 没有 §3.1 provider 补丁\n\
             （或后端没有 SM3）—— 核对：`node scripts/check-crypto-backend.mjs` ／ 见方案 §3.5。"
                .to_string(),
        );
    }
    set_gm_cipher_labels(conn).map_err(|e| {
        format!("库级国密参数设置失败（{e}）—— 这个构建带 `sm-library`，按约定必须用 SM3 页 MAC/库 KDF")
    })?;
    match read_gm_cipher_status(conn) {
        Ok(crate::gm_provider::GmProviderStatus::Applied { .. }) => Ok(()),
        Ok(other) => Err(format!(
            "库级国密参数**没有生效**（回声 = {other:?}）：标签设下去了但算法没变 ⇒ 写出来的仍是默认
             （HMAC_SHA512 / PBKDF2_HMAC_SHA512）那套。⇒ **拒绝继续**：要么国密、要么别写库。"
        )),
        // 回显读不出来 ⇒ **不判红**：错口令 / 页参数不同的库都会把连接打进 error state，
        // 那是**这条连接**的问题，应该在后面的读上失败并给出可操作文本（`cipher_open_error`）。
        Err(_) => Ok(()),
    }
}

/// Apply `PRAGMA key` to a fresh connection if (and only if) its DB file is
/// encrypted at rest, using the session key. Errors when the file is encrypted but
/// the session is locked (no key) — callers must only reach here unlocked, except
/// the startup gate which avoids opening a keyed space DB until unlock.
///
/// ★ **第 1 步（按空间）**：先问**这个空间自己的**钥匙（钥匙袋里有没有它的盒子）——
/// 有 ⇒ 用它自己的；没有袋子 / 这个空间不在袋里 ⇒ 走**今天那条路**（应用级 session key）
/// ⇒ **零回归**。袋子有这个空间但会话锁着 ⇒ 报错（见 `space_crypto::space_key`：绝不静默退旧钥匙）。
pub fn key_space_conn(conn: &Connection, path: &Path) -> Result<(), String> {
    if space_db_is_encrypted(path) {
        if let Some(key) = crate::space_crypto::space_key_for_path(path)? {
            return set_cipher_key(conn, &key);
        }
        let key = session_key().ok_or("工作空间已加密但会话未解锁".to_string())?;
        set_cipher_key(conn, &key)?;
    }
    Ok(())
}

/// SQLCipher「这个库打不开」的**两种**原始报错 —— 实测这两句在**口令错**与**页参数/页加密算法不同**
/// 两种情况里**完全不可区分**（2026-09-20 探针：512 字节页库用默认参数打开 ⇒ `file is not a database`；
/// 同一个库用**错口令**打开 ⇒ **一字不差的同一句**；另一种参数不匹配 ⇒ `database disk image is malformed`）。
pub(crate) const CIPHER_OPEN_RAW: [&str; 2] = ["file is not a database", "database disk image is malformed"];

/// 把「库打不开」的原始报错翻成**可操作**的文本（**两因一果**）。
///
/// 为什么必须两因并列、而不是猜一个：见 [`CIPHER_OPEN_RAW`] 的实测 —— 报错层不区分，只能把
/// "口令不对"与"这个库用了另一种**页加密算法**（AES 页 vs SM4 页）"一起说，并给出下一步。
/// 这一条是为 P3（A 路：国密构建的 SM4 页加密）准备的：**升级到国密构建**后，应用层口令明明是对的
/// （哨兵解得开），库级却打不开，现场就是这两句之一 —— 不翻的话用户会一直以为"口令错了"。
///
/// ⚠️ 只翻**认得出来的**那两句；其余错误**原样返回**（诊断为"可能是页加密算法不同"要有依据，
/// 不能把所有开库失败都套上这个解释）。
pub(crate) fn cipher_open_error(raw: &str, what: &str) -> String {
    if !CIPHER_OPEN_RAW.iter().any(|m| raw.contains(m)) {
        return raw.to_string();
    }
    format!(
        "{what}打不开：{raw}\n\
         ⇒ 两种成因，报错本身**分不出**是哪一种，请按顺序排除：\n\
         \u{20}1) **口令/密钥不对**（最常见）：确认大小写、输入法、以及是不是另一台设备的口令；\n\
         \u{20}2) **这个库用了另一种页加密算法**（例如库是 AES 页、而本构建是 SM4 页，或反过来）：\n\
         \u{20}   页加密算法是**库文件**的属性、不是开关 ⇒ 换构建后必须**迁移**：用**原构建**打开并先「关闭磁盘加密」\n\
         \u{20}   （导出成明文）⇒ 换本构建 ⇒ 重新「开启磁盘加密」；或改用导出包导入。详见 docs/SM-CRYPTO-DELIVERY.md。\n\
         原始报错保留在上面，排查时以它为准。"
    )
}

/// Same as [`key_space_conn`] but with an **explicitly supplied** key instead of the
/// process-wide session key. Callers that already hold a key (backup export) must use
/// this so the keyed connection and any keyed *destination* are guaranteed to use the
/// same bytes.
pub fn key_conn_with(conn: &Connection, key: &[u8; 32]) -> Result<(), String> {
    set_cipher_key(conn, key)
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
        // Must NOT swallow a SQL error here: a failed export would leave an empty or
        // partial target that the caller could mistake for a successful decrypt.
        // (sqlcipher_export returns NULL on success — we only care that it didn't error.)
        src.execute_batch("SELECT sqlcipher_export('target');")
            .map_err(|e| format!("sqlcipher_export 失败: {e}"))?;
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

    // Enumerate the source's real tables (skip sqlite_* system tables and the FTS5
    // **virtual tables + their shadow tables** — both families are rebuilt on the target below).
    //
    // ⚠️⚠️ **以后再加 FTS5 表，这里必须同步加一行前缀**（2026-09-19：`chunk_fts` 就是第二次踩同一个坑）。
    //   为什么必须排除，而不是"让它一起被拷"：FTS5 会连带建一族影子表
    //   （`_config` / `_data` / `_docsize` / `_idx`），其中 `<表>_config` 是**单行表**（`k` 唯一）
    //   ⇒ 逐表 `INSERT … SELECT *` 拷到第二行就撞 `UNIQUE constraint failed`，
    //   而报错发生在**用户数据迁移路径**上（开/关加密时的就地转换），代价极高。
    //   实测（macOS 侧 2026-09-19）：本表当初让 `security::` 8 条判据在**分支自己的基点**上就是红的。
    //   排除之后索引不会丢：`chunks` 行被拷过去时触发器会自动维护，兜底还有读取路径上的
    //   `search::ensure_chunk_fts()`（计数对不上就整体重建）。
    let tables: Vec<String> = {
        let mut stmt = dst
            .prepare(
                "SELECT name FROM plain.sqlite_master WHERE type='table' \
                 AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'page_fts%' \
                 AND name NOT LIKE 'chunk_fts%' ORDER BY name",
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
    if let Err(e) = rebuild_space_db(path, &tmp, to_encrypted, key, &stem) {
        // Clean up the temp file(s) so a failed rebuild never leaves a plaintext
        // or partial copy behind (the original source is untouched on this path).
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(tmp.with_extension("db-wal"));
        let _ = std::fs::remove_file(tmp.with_extension("db-shm"));
        return Err(e);
    }

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
    // ★ 失败要**可操作**（P3 预置）：解锁时应用层哨兵已经验过口令了，随后这一步是**库级**打开 ——
    //   页加密算法/页参数不同时原始报错与"口令错"一字不差，不翻的话用户会一直怀疑口令。
    crate::db::reopen_space_at(c, space_id, app_data_dir)
        .map_err(|e| cipher_open_error(&e, &format!("空间 {space_id} 的库")))
}

/// Per-space at-rest encryption marker (meta.workspaces.encrypted): records which
/// space DBs are SQLCipher-encrypted (set on a successful enable/disable). The open
/// path keys a connection when the file is detected as encrypted at rest (header
/// sniff is the ground truth); the marker is explicit bookkeeping per the plan.
pub(crate) fn set_space_encrypted_marked(c: &Connection, space_id: &str, enc: bool) -> Result<(), String> {
    // §0-C：除了 encrypted 标记，还记下"这个空间的数据是哪一版密文"（启用时 = 本构建写出去的那版；
    // 关闭时清 0）。**必须有这一列**：光靠密文头，老端要读到某一条时才知道读不了。
    c.execute(
        "UPDATE meta.workspaces SET encrypted = ?1, cipher_format = ?2 WHERE id = ?3",
        params![
            if enc { 1 } else { 0 },
            if enc { crypto::CURRENT_FORMAT as i64 } else { 0 },
            space_id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Reset every workspace's encryption marker to 0 (used when rolling back).
fn clear_all_space_markers(c: &Connection) -> Result<(), String> {
    c.execute("UPDATE meta.workspaces SET encrypted = 0, cipher_format = 0", [])
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
    // 整套密钥材料（legacy ＋ 国密那一对）。字符串/二进制两条路径共用 `keys`，所以
    // 「口令验证哨兵」与「附件/同步载荷」写下的是**同一版**密文。
    let keys = crypto::derive_app_keys(&passphrase, &salt)?;
    let verify = crypto::encrypt_str(VERIFY_MSG, &keys)?;

    // Config lives in meta (plaintext) so a fresh locked launch can still derive the
    // key before the (now-encrypted) space DB is readable.
    sync::set_meta_state(conn, crypto::ENC_SALT, &crypto::b64_encode(&salt))?;
    sync::set_meta_state(conn, crypto::ENC_VERIFY, &verify)?;
    sync::set_meta_state(conn, crypto::ENC_ENABLED, "1")?;
    let active = crate::workspaces::active_workspace_id(conn)?;
    // NOTE: `ENC_KEY` is intentionally NOT persisted — the derived key is only held
    // in this session (SESSION_KEY). At-rest protection comes from the SQLCipher
    // space DBs encrypted below with the same key.
    *SESSION_KEY.lock().map_err(|_| "会话锁失效".to_string())? = Some(keys);
    LOCKED.store(false, Ordering::SeqCst);

    // Convert every non-active space to disk-encrypted (active handled last via swap).
    // ⚠️ 库级（SQLCipher）用的仍是 `legacy[..]` 那 32 字节 —— 库级换 KDF 是 P2-P3 的事。
    let non_active = match convert_all_spaces(conn, app_data_dir, true, Some(&keys.legacy)) {
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
    if let Err(e) = convert_space_db(&active_path, true, Some(&keys.legacy)) {
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
    // ★ §0-C：这个空间记录在案的密文版本本构建解不开 ⇒ **同步之前**就明确拒绝，
    //   而不是逐条解密失败（后者会被读成"数据坏了"）。
    if let Ok(space_id) = crate::workspaces::active_workspace_id(c) {
        ensure_space_format_supported(c, &space_id)?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct EncryptionStatus {
    pub enabled: bool,
    pub locked: bool,
    /// **本会话写新数据用的密文版本**（§0-C：算法标识不能只藏在密文里，状态上也要有一份）。
    /// 解锁着 ⇒ 手上这套密钥材料真正会写出来的版本；锁着/未开启 ⇒ 本构建的默认写入版本。
    pub format: u8,
    /// 上一条的**稳定算法名**（`crypto::format_name`，单一定义处）。
    pub algorithm: String,
    /// **当前活动空间**记录在案的密文版本（0 = 未记录）。§0-C 的另一半：
    /// 只报全局开关不够 —— 界面/诊断要能说出"**这个空间**的数据是哪一版"，
    /// 而"读到某一条才发现读不了"正是我们要避免的那种失败。
    pub space_format: u8,
    /// 上一条的稳定算法名（未记录时是空串）。
    pub space_algorithm: String,
}

#[tauri::command]
pub fn encryption_status(db: State<Db>) -> Result<EncryptionStatus, String> {
    let c = conn(&db);
    let enabled = encryption_enabled(&c);
    let locked = LOCKED.load(Ordering::SeqCst);
    let format = match key_if_enabled(&c) {
        Some(k) => crypto::active_format(&k),
        None => crypto::CURRENT_FORMAT,
    };
    let space_format = crate::workspaces::active_workspace_id(&c)
        .ok()
        .as_deref()
        .and_then(|sid| space_format(&c, sid))
        .unwrap_or(0);
    Ok(EncryptionStatus {
        enabled,
        locked,
        format,
        algorithm: crypto::format_name(format).to_string(),
        space_format,
        space_algorithm: if space_format == 0 {
            String::new()
        } else {
            crypto::format_name(space_format).to_string()
        },
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
    // ★ 第 1 步：锁定时连**主密钥**一起卸下（袋子的公开材料留着无妨：它本来就是公开的）。
    crate::space_crypto::set_session_master(None)?;
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
    let keys = crypto::derive_app_keys(&passphrase, &salt)?;
    let verify = sync::get_meta_state(conn, crypto::ENC_VERIFY).ok_or("加密状态缺失".to_string())?;
    // ★ 哨兵按**自己的密文头**分派 ⇒ 在国密构建里解开老（v1）哨兵靠的是双读，
    //   而不是"猜口令" —— 口令对不对与"这段是哪一版"是两件事。
    let msg = crypto::decrypt_str(&verify, &keys).map_err(|_| "口令不正确".to_string())?;
    if msg != VERIFY_MSG {
        return Err("口令不正确".to_string());
    }
    let active = crate::workspaces::active_workspace_id(conn)?;
    *SESSION_KEY.lock().map_err(|_| "会话锁失效".to_string())? = Some(keys);
    LOCKED.store(false, Ordering::SeqCst);
    // ★ 第 1 步（按空间）：同一句口令也用来**载入公开材料 ＋ 推出主密钥**（袋子没有 ⇒ 全 `None`，
    //   与接线前逐字相同）。袋子坏了 ⇒ 在这里**报错**（不许静默降级成明文路径）。
    crate::space_crypto::carry_keyring(conn)?;
    let master = crate::space_crypto::master_from_passphrase(conn, &passphrase)?;
    crate::space_crypto::set_session_master(master)?;
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
    let keys = *SESSION_KEY.lock().map_err(|_| "会话锁失效".to_string())?;
    // 库级（SQLCipher）只用 legacy 那 32 字节；国密那一对是应用层载荷用的，换成它库就打不开了。
    let key = keys.map(|k| k.legacy);
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
    use std::sync::atomic::AtomicU32;

    /// ⚠️ **临时目录名必须"每次调用都不同"**，不能只靠 `进程号 + 毫秒`（2026-09-19 的 CI 教训）。
    ///
    /// 原来七个用例各自写 `shuy_xxx_{pid}_{now_ms()}`：**并发**下会撞名 —— cargo 的测试线程同时起跑时，
    /// 两个测试可以在**同一毫秒**里各建一个同名目录，而 `temp_ws()` 开头就 `remove_dir_all`，
    /// 于是 B 把 A 刚建好的 meta.db/space db 删掉、两边还共用同一个 meta.db
    /// ⇒ A 写入 `ENC_ENABLED=1` 之后，B 的"未开启"用例读到"已开启"，一串用例跟着红。
    ///
    /// 复现（当时留的探针，改前 **5/5 必红**）：8 个线程用 `Barrier` 同时调 `temp_ws()`，去重后不足 8 个目录。
    /// 这解释了 `rust-sm-crypto` 在 Linux CI 上红、而本机 macOS 连跑两遍全绿 —— 差别只在**线程调度**。
    /// 序号是 `Relaxed` 就够（只要唯一，不承担同步语义）。
    static TMP_SEQ: AtomicU32 = AtomicU32::new(0);
    fn uniq_tmp(tag: &str) -> PathBuf {
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("shuy_{tag}_{}_{}_{seq}", std::process::id(), db::now_ms()))
    }

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
        let dir = std::env::temp_dir().join(uniq_tmp("e1"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let meta_path = dir.join("meta.db");
        {
            let m = Connection::open(&meta_path).unwrap();
            m.execute_batch(
                "CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, theme TEXT, icon TEXT NOT NULL DEFAULT '', sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, encrypted INTEGER NOT NULL DEFAULT 0, cipher_format INTEGER NOT NULL DEFAULT 0); \
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
        let key = crypto::AppKeys::legacy_only(crypto::derive_key("hunter2", &salt).unwrap());
        let plain = b"some attachment bytes \x00\x01\x02";
        let enc = encrypt_attachment_bytes(Some(&key), plain).unwrap();
        assert_ne!(enc, plain);
        let dec = decrypt_attachment_bytes(Some(&key), &enc).unwrap();
        assert_eq!(dec, plain);
        // Wrong key -> decrypt fails -> raw ciphertext passthrough (never corrupts).
        let wrong = crypto::AppKeys::legacy_only(crypto::derive_key("wrong", &salt).unwrap());
        let dec2 = decrypt_attachment_bytes(Some(&wrong), &enc).unwrap();
        assert_eq!(dec2, enc);
        // No key (encryption off/locked) -> passthrough.
        assert_eq!(encrypt_attachment_bytes(None, plain).unwrap(), plain);
        assert_eq!(decrypt_attachment_bytes(None, plain).unwrap(), plain);
        // A key present but the data is plaintext -> passthrough (backward compat).
        assert_eq!(decrypt_attachment_bytes(Some(&key), plain).unwrap(), plain);
    }

    /// ★ 2026-09-22 改写（接线构建实测抓出来的）：**这份夹具的写法决定了它能证明什么**。
    ///
    /// 原版用"明文主连接 ＋ `ATTACH … KEY` 导出"造加密库 —— 在**接线构建**里那条路写出来的是
    /// **默认库级参数（HMAC_SHA512）** 的库（`ATTACH` 的 codec 不认 `sm-library` 的接线），
    /// 而应用读它用的是国密参数 ⇒ 读不开。也就是说：原版夹具**本身是另一套参数**，
    /// 它证明的其实是"跨参数读不开"，不是"本构建能往返"。
    ///
    /// 现在两半都留下：
    ///   · **生产口径**（`convert_space_db` 用的那个原语 `rebuild_space_db`）写的库 ⇒ 必须能往返；
    ///   · **裸 ATTACH（另一套库级参数）写的库** ⇒ **必须读不开**（快路的后果，响亮报错；
    ///     这是"跨参数不可读"的正例，只在 `sm-library` 构建上判 —— 默认构建读得开它，那是对的）。
    /// ★ 隐私边界**第 1 步（按空间）**：**开库路径**优先用这个空间**自己的**钥匙
    /// （钥匙袋里有它的盒子），而不是应用级 session key —— 并证明"用错钥匙真的打不开"
    /// （不是碰巧读开了）。没有袋子时走旧路，那条由 `space_crypto` 的单测钉着。
    #[test]
    fn key_space_conn_prefers_the_space_key_from_the_keyring() {
        let _g = SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(uniq_tmp("spacekey"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();

        // 明文源（真 schema，`rebuild_space_db` 是整表拷贝，列数要对得上）。
        let src = dir.join("src.db");
        {
            let c = Connection::open(&src).unwrap();
            crate::db::migrate(&c, "sc-space-1").unwrap();
            c.execute(
                "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at) \
                 VALUES ('p1', 'sc-space-1', NULL, 'hi', '{\"root\":{}}', 'hi', 'page', 0, 1, 1, NULL)",
                [],
            )
            .unwrap();
            c.close().unwrap();
        }
        // 用**空间自己的钥匙**造一个密文库，放在我们约定的路径上。
        let space_key = crate::keyring::random_space_key();
        let space_path = space_db_path(&dir, "sc-space-1");
        rebuild_space_db(&src, &space_path, true, Some(&space_key), "sc-space-1").unwrap();
        assert!(space_db_is_encrypted(&space_path));

        // 袋子里放它的盒子；会话主密钥装上；**应用级 session key 故意装一把错的**
        //   ⇒ 只有"真的按空间取钥匙"才可能读开。
        let mut kr = crate::keyring::Keyring::new();
        let master = kr.kdf.derive_master("pw").unwrap();
        kr.wrap(&master, "sc-space-1", &space_key).unwrap();
        crate::space_crypto::set_keyring_for_test(Some(kr));
        crate::space_crypto::set_session_master(Some(master)).unwrap();
        *SESSION_KEY.lock().unwrap() = Some(crypto::AppKeys::legacy_only([9u8; 32]));

        // ① 开库：读得到（尽管应用级那把是错的）
        {
            let c = Connection::open(&space_path).unwrap();
            key_space_conn(&c, &space_path).unwrap();
            let n: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 1, "按空间取钥匙：应用级会话钥匙是错的，也该读得开");
        }

        // ② 把袋子清掉（＝旧路）⇒ 同一路径用那把错的 session key **读不开**
        //    ⇒ 证明 ① 用的确实是空间自己的钥匙（而不是"SQLCipher 随便给什么钥都开"）。
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
        {
            let c = Connection::open(&space_path).unwrap();
            let _ = key_space_conn(&c, &space_path);
            assert!(
                c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0)).is_err(),
                "没有袋子 ⇒ 走旧路 ⇒ 错钥匙必须读不开"
            );
        }

        // ③ 收尾：别把全局状态留给别的判据（袋子/主密钥/session key 全清）
        *SESSION_KEY.lock().unwrap() = None;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn encrypted_db_roundtrip_and_sniff() {
        let _g = SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(uniq_tmp("sniff"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let salt = crypto::random_salt();
        let key = crypto::derive_key("hunter2", &salt).unwrap();
        let hex = crypto::key_hex(&key);

        // 明文源：**用真 app schema**（`rebuild_space_db` 是按表名整表拷贝的，列数必须对得上）。
        let src = dir.join("default.db");
        {
            let c = Connection::open(&src).unwrap();
            crate::db::migrate(&c, "default").unwrap();
            c.execute(
                "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at) \
                 VALUES ('p1', 'default', NULL, 'hi', '{\"root\":{}}', 'hi', 'page', 0, 1, 1, NULL)",
                [],
            )
            .unwrap();
            c.close().unwrap();
        }
        // 先嗅一次头（原版要证的正是"嗅探不破坏后续导出"）。
        assert!(!space_db_is_encrypted(&src));

        let encp = dir.join("enc.db");
        rebuild_space_db(&src, &encp, true, Some(&key), "default").unwrap();
        assert!(space_db_is_encrypted(&encp));
        // 无钥读不开。
        {
            let c = Connection::open(&encp).unwrap();
            assert!(c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0)).is_err());
        }
        // 错钥读不开（★ 这一支在接线构建里曾被我第一版接线**误诊**成"构建没有 provider 补丁"，
        //   见 `apply_gm_page_settings` 的注释）。
        let wrong = crypto::derive_key("wrong-pass", &salt).unwrap();
        {
            let c = Connection::open(&encp).unwrap();
            c.execute_batch(&format!("PRAGMA key = \"x'{}';\"", crypto::key_hex(&wrong))).unwrap();
            assert!(c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0)).is_err());
        }
        // 对钥（走开库路径 key_space_conn）读得开。
        *SESSION_KEY.lock().unwrap() = Some(crypto::AppKeys::legacy_only(key));
        {
            let c = Connection::open(&encp).unwrap();
            key_space_conn(&c, &encp).unwrap();
            let n: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 1);
            let t: String = c.query_row("SELECT title FROM pages WHERE id='p1'", [], |r| r.get(0)).unwrap();
            assert_eq!(t, "hi");
        }

        // ② 另一套库级参数（裸 `ATTACH … KEY`，明文主连接）写的库：
        //    ★ **判据自适应当前状态**（2026-09-22 补丁 v4 之后改；v4 之前这里写的是"必须读不开"）：
        //    · **v4 之前**：裸 ATTACH 写的是**默认参数**（页 MAC/库 KDF = SHA512），而生产口径设的是 SM3
        //      ⇒ 两套参数 ⇒ **必须读不开**（那条负判据当时是对的）；
        //    · **v4 之后**：OpenSSL 构建的**默认值就是 SM3** ⇒ 裸 ATTACH 与生产口径**同一套参数**
        //      ⇒ **读得开是对的**（这正说明"库级参数不再靠应用约定"）。
        //    ⇒ 把它写成"先量这份文件到底是哪一套参数，再断言对应结论"，两种世界下都是真话。
        #[cfg(feature = "sm-library")]
        {
            let legacy = dir.join("raw_attach.db");
            {
                let c = Connection::open(&src).unwrap();
                let e = legacy.display().to_string().replace('\'', "''");
                c.execute_batch(&format!("ATTACH DATABASE '{e}' AS enc KEY \"x'{hex}'\";")).unwrap();
                let _ = c.query_row("SELECT sqlcipher_export('enc')", [], |r| r.get::<_, i64>(0));
                c.execute_batch("DETACH DATABASE enc;").unwrap();
                c.close().unwrap();
            }
            assert!(space_db_is_encrypted(&legacy), "裸 ATTACH 也该写出密文库");

            // 先用**裸钥**（＝写它的那套参数）确认真能读开，并问出"这份构建的默认是不是 SM3"
            let defaults_are_sm3 = {
                let bare = Connection::open(&legacy).unwrap();
                bare.execute_batch(&format!("PRAGMA key = \"x'{hex}'\";")).unwrap();
                let st = crate::gm_provider::read_gm_cipher_status(&bare).unwrap();
                let read: Result<i64, _> =
                    bare.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0));
                assert!(read.is_ok(), "裸钥读不开自己写出来的库 ⇒ 夹具/构建有问题：{read:?}");
                st.is_applied()
            };

            // 再用**生产口径**（接线后的国密参数）读同一份文件
            let c = Connection::open(&legacy).unwrap();
            key_conn_with(&c, &key).unwrap();
            let via_app: Result<i64, _> =
                c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0));
            if defaults_are_sm3 {
                assert!(
                    via_app.is_ok(),
                    "补丁 v4 之后默认已是 SM3 ⇒ 裸 ATTACH 写的库与生产口径**同参数**，必须读得开：{via_app:?}"
                );
                println!("裸 ATTACH 产物读数：默认已是国密（v4）⇒ 生产口径也读得开（{via_app:?}）");
            } else {
                assert!(
                    via_app.is_err(),
                    "默认还不是 SM3（v4 之前）⇒ 裸 ATTACH 写的是另一套参数，必须读不开，却读到了 {via_app:?}"
                );
                println!("裸 ATTACH 产物读数：默认仍是 SHA512（v4 之前）⇒ 生产口径读不开（符合当时的负判据）");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    // convert_space_db (per-table rebuild migration) ENCRYPT direction: build a plaintext
    // space DB with the REAL app schema + a page, encrypt it in place, verify it reads
    // back via the open-time keying (header sniff + session key), and confirm no temp
    // files remain. This is the E1 enable-migration that actually encrypts existing spaces.
    // ★ P3 预置的可操作错误（§3.3②）：这两句原始报错**必须**被翻成"两因一果"，
    //   其余错误**必须**原样返回（诊断要有依据，不能把一切开库失败都解释成"页加密算法不同"）。
    #[test]
    fn cipher_open_errors_are_translated_but_other_errors_are_not() {
        for raw in [
            "file is not a database",
            "database disk image is malformed",
            "SqliteFailure(Error { code: NotADatabase }, Some(\"file is not a database\"))",
        ] {
            let out = cipher_open_error(raw, "空间 s1 的库");
            assert!(out.contains("口令"), "没提口令：{out}");
            assert!(out.contains("页加密算法"), "没提页加密算法：{out}");
            assert!(out.contains("关闭磁盘加密"), "没给下一步：{out}");
            assert!(out.contains(raw), "原始报错必须保留（排查以它为准）：{out}");
        }
        // 认不出的错误 ⇒ 原样返回（不套解释）
        for raw in ["unable to open database file", "disk I/O error", "some other failure"] {
            assert_eq!(cipher_open_error(raw, "空间 s1 的库"), raw);
        }
    }

    // ★ 端到端：真造一个"页参数与默认不同"的库（P3 之前页加密算法换不了，这是**同一失败签名**的载体：
    //   探针实测——写库时用非默认页参数 ⇒ 用默认参数打开就是 `file is not a database`，与**错口令**一字不差），
    //   再走**真实开库路径** `db::open_space_conn_at`，断言错误已经是可操作文本。
    #[test]
    fn open_space_conn_reports_an_actionable_error_for_a_mismatched_page_db() {
        let _g = SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(uniq_tmp("mismatch"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("spaces")).unwrap();
        // meta.db（open_space_conn_at 会 ATTACH 它）
        {
            let m = Connection::open(dir.join("meta.db")).unwrap();
            crate::db::open_meta_conn_at(&dir).unwrap().close().unwrap();
            m.close().unwrap();
        }
        let key = crypto::derive_key("hunter2", &crypto::random_salt()).unwrap();
        let hex = crypto::key_hex(&key);
        let path = crate::db::space_db_path(&dir, "s1");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(&format!("PRAGMA key = \"x'{hex}'\";")).unwrap();
            // 先 key 再设非默认页大小（探针 O1 形态）⇒ 这份文件的页参数与本构建的默认**不同**
            c.execute_batch("PRAGMA cipher_page_size = 512;").unwrap();
            c.execute_batch("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);").unwrap();
            assert_eq!(c.query_row("SELECT COUNT(*) FROM t", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
            c.close().unwrap();
        }
        // `open_space_conn_at` 会用**会话密钥**给连接加钥 ⇒ 这里按真实解锁后的状态置上（本模块的测试同法）。
        *SESSION_KEY.lock().unwrap() = Some(crypto::AppKeys::legacy_only(key));
        let err = crate::db::open_space_conn_at("s1", &dir).unwrap_err();
        *SESSION_KEY.lock().unwrap() = None;
        assert!(err.contains("口令"), "开库失败没给可操作文本：{err}");
        assert!(err.contains("页加密算法"), "没提页加密算法：{err}");
        assert!(err.contains("关闭磁盘加密"), "没给下一步：{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn convert_space_db_encrypt_back_to_readable() {
        let _g = SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(uniq_tmp("conv"));
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
        *SESSION_KEY.lock().unwrap() = Some(crypto::AppKeys::legacy_only(key));
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
        let dir = std::env::temp_dir().join(uniq_tmp("idem"));
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
        *SESSION_KEY.lock().unwrap() = Some(crypto::AppKeys::legacy_only(key));
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
        let dir = std::env::temp_dir().join(uniq_tmp("loop"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir.join("spaces")).unwrap();
        let meta_path = dir.join("meta.db");
        {
            let m = Connection::open(&meta_path).unwrap();
            m.execute_batch(
                "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, theme TEXT, icon TEXT NOT NULL DEFAULT '', sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, encrypted INTEGER NOT NULL DEFAULT 0, cipher_format INTEGER NOT NULL DEFAULT 0); \
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
        let dir = std::env::temp_dir().join(uniq_tmp("osc"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir.join("spaces")).unwrap();
        let meta_path = dir.join("meta.db");
        {
            let m = Connection::open(&meta_path).unwrap();
            m.execute_batch("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, theme TEXT, icon TEXT NOT NULL DEFAULT '', sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, encrypted INTEGER NOT NULL DEFAULT 0, cipher_format INTEGER NOT NULL DEFAULT 0);").unwrap();
            m.close().unwrap();
        }
        let space_path = dir.join("spaces").join("default.db");
        {
            let s = Connection::open(&space_path).unwrap();
            crate::db::migrate(&s, "default").unwrap();
            s.execute_batch("INSERT INTO pages (id, workspace_id, title, content_text, created_at, updated_at) VALUES ('p1','default','hello','hello',1,1)").unwrap();
            // ★ 派生层也给一行：`convert_space_db` 是**逐表拷贝**，而 `chunk_fts` 是 FTS5 虚拟表
            //   （带一族单行影子表）⇒ 它必须被**排除**而不是被拷（见 `convert_space_db` 里那段注释）。
            //   这一行用来验证"排除索引之后，索引本身还在"。
            s.execute_batch(
                "INSERT INTO chunks (id, page_id, att_id, ord, loc, lang, text, hash) \
                 VALUES ('p1#0','p1',NULL,0,'','zh','hello chunk body','h1')",
            )
            .unwrap();
            s.close().unwrap();
        }
        let salt = crypto::random_salt();
        let key = crypto::derive_key("hunter2", &salt).unwrap();
        // Encrypt the space at rest, then open it via the cross-space path (keyed).
        convert_space_db(&space_path, true, Some(&key)).unwrap();
        *SESSION_KEY.lock().unwrap() = Some(crypto::AppKeys::legacy_only(key));
        let conn = crate::db::open_space_conn_at("default", &dir).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // ★ 逐表拷贝排除索引表之后，**索引本身必须还在**（两条机制：拷 `chunks` 时触发器维护；
        //   兜底是读取路径上的 `ensure_chunk_fts()`）。只测"不炸了"是不够的 ——
        //   索引静默丢了的话，症状是"搜索悄悄变差"，没有任何报错。
        let chunks_n: i64 = conn.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0)).unwrap();
        let indexed_n: i64 = conn.query_row("SELECT COUNT(*) FROM chunk_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(chunks_n, 1, "转换后 chunks 行数不对（拷贝漏了派生层？）");
        assert_eq!(indexed_n, chunks_n, "转换后块级 FTS 索引与 chunks 行数不一致（索引被拷坏或丢了）");
        let chunk_hit: i64 = conn
            .query_row("SELECT COUNT(*) FROM chunk_fts WHERE chunk_fts MATCH 'chunk'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(chunk_hit, 1, "转换后块级全文检索查不到那行（索引没被维护/重建）");
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
        let dir = std::env::temp_dir().join(uniq_tmp("lock"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir.join("spaces")).unwrap();
        let meta_path = dir.join("meta.db");
        {
            let m = Connection::open(&meta_path).unwrap();
            m.execute_batch("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, theme TEXT, icon TEXT NOT NULL DEFAULT '', sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, encrypted INTEGER NOT NULL DEFAULT 0, cipher_format INTEGER NOT NULL DEFAULT 0); CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
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
    fn enable_meta(c: &Connection, pass: &str) -> crypto::AppKeys {
        let salt = crypto::random_salt();
        let key = crypto::derive_key(pass, &salt).unwrap();
        sync::set_meta_state(c, crypto::ENC_SALT, &crypto::b64_encode(&salt)).unwrap();
        // ⚠️ 这里刻意用 `legacy_only`：本测试组盯的是 SQLCipher/库级与既有 v1 口径，
        //    "国密构建下三条路径也走 v2"由 crypto.rs 与下面那条 cfg 用例负责，别把两件事混在一起。
        let keys = crypto::AppKeys::legacy_only(key);
        sync::set_meta_state(c, crypto::ENC_VERIFY, &crypto::encrypt_str(VERIFY_MSG, &keys).unwrap()).unwrap();
        sync::set_meta_state(c, crypto::ENC_ENABLED, "1").unwrap();
        *SESSION_KEY.lock().unwrap() = Some(keys);
        LOCKED.store(false, Ordering::SeqCst);
        keys
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

    // ── §0-C：算法标识要落到「空间状态 ＋ 同步载荷」，且**动手之前**就拒绝 ──────────────
    //
    // 这一组盯的是"老端遇到新数据"这一类失败。它的最坏形态**不是报错**，而是：
    //   ① 逐条解密失败 ⇒ 用户以为"数据坏了"，而且同步**应用了一半**；
    //   ② 更糟：附件那条路的旧逻辑是"解不开 ⇒ 当明文" ⇒ 把**密文当明文**写出去（安静地损坏文件）。
    // 判据分两半：默认构建要**拒绝**（v2 解不开），国密构建要**放行**（v2 就是它自己写的）。

    /// 一段载荷的版本要能**不解密**就读出来：这是"整批拒绝"的地基。
    #[test]
    fn payload_format_is_readable_without_the_key() {
        let keys = crypto::derive_app_keys("pw", &crypto::random_salt()).unwrap();
        let v1 = crypto::encrypt_str("payload", &crypto::AppKeys::legacy_only(keys.legacy)).unwrap();
        assert_eq!(payload_format(&v1), Some(crypto::VERSION_XCHACHA));
        // 明文 JSON（加密未开时的载荷）：看着不像密文 ⇒ None ⇒ **放行**（绝不能拦）
        assert_eq!(payload_format(r#"{"id":"p1","title":"晴"}"#), None);
        assert_eq!(payload_format(""), None);
    }

    /// ★ 整批语义：一批里只要有一段解不开，就**一条都不应用**（返回 Err，而不是跳过那一条）。
    #[cfg(not(feature = "sm-crypto"))]
    #[test]
    fn prescan_refuses_the_whole_batch_when_any_payload_is_v2() {
        let keys = crypto::derive_app_keys("pw", &crypto::random_salt()).unwrap();
        let v1 = crypto::encrypt_str("ok", &crypto::AppKeys::legacy_only(keys.legacy)).unwrap();
        let mut v2_blob = crypto::b64_decode(&v1).unwrap();
        v2_blob[1] = crypto::VERSION_SM4; // 伪造一段 v2（本构建解不开）
        let v2 = crypto::b64_encode(&v2_blob);

        // ① 全 v1 + 明文 ⇒ 放行
        assert!(ensure_payloads_supported([v1.as_str(), r#"{"a":1}"#]).is_ok());
        // ② 只要**有一段** v2 ⇒ 整批拒绝，且错误**可操作**（说清换国密版）
        let err = ensure_payloads_supported([v1.as_str(), v2.as_str()]).unwrap_err();
        assert!(err.contains("整批拒绝"), "错误里要说清'一条都没应用'：{err}");
        assert!(err.contains("国密版"), "错误不可操作：{err}");
    }

    /// 国密构建遇到 v2 必须**放行**（那是它自己写的），不能一律拒绝。
    #[cfg(feature = "sm-crypto")]
    #[test]
    fn prescan_allows_v2_in_the_sm_build() {
        let keys = crypto::derive_app_keys("pw", &crypto::random_salt()).unwrap();
        let v2 = crypto::encrypt_str("国密载荷", &keys).unwrap();
        assert_eq!(payload_format(&v2), Some(crypto::VERSION_SM4));
        assert!(ensure_payloads_supported([v2.as_str()]).is_ok());
    }

    /// 空间级：启用加密时**记下**这个空间的版本；关闭时清掉。
    #[test]
    fn space_format_is_recorded_on_enable_and_cleared_on_disable() {
        let _g = SEC_LOCK.lock().unwrap();
        let (_t, c) = temp_ws();
        assert_eq!(space_format(&c, "default"), None, "没启用时不该有记录");
        enable_meta(&c, "supersecret");
        set_space_encrypted_marked(&c, "default", true).unwrap();
        assert_eq!(
            space_format(&c, "default"),
            Some(crypto::CURRENT_FORMAT),
            "启用后必须记下'本构建写的是哪一版'（§0-C 的空间算法标识）"
        );
        set_space_encrypted_marked(&c, "default", false).unwrap();
        assert_eq!(space_format(&c, "default"), None, "关闭后要清掉，别留下让人误判的旧值");
    }

    /// ★ 空间级守卫：**记录在案的版本本构建解不开 ⇒ 用这个空间之前就拒绝**（不是读到某条才发现）。
    #[cfg(not(feature = "sm-crypto"))]
    #[test]
    fn space_guard_refuses_v2_in_the_default_build() {
        let _g = SEC_LOCK.lock().unwrap();
        let (_t, c) = temp_ws();
        // 直接写一个"国密空间"的记录（模拟：这个空间的数据是国密版写下的）
        c.execute("UPDATE meta.workspaces SET cipher_format = ?1 WHERE id = 'default'", [crypto::VERSION_SM4])
            .unwrap();
        let err = ensure_space_format_supported(&c, "default").unwrap_err();
        assert!(err.contains("国密版"), "错误不可操作：{err}");
        // 而且 sync_gate 会把它挡在**同步之前**
        let gate = sync_gate(&c).unwrap_err();
        assert!(gate.contains("国密版"), "同步前就该拒绝，而不是逐条解密失败：{gate}");
    }

    /// 国密构建下同一个空间记录必须**放行**（它自己就是写 v2 的那一版）。
    #[cfg(feature = "sm-crypto")]
    #[test]
    fn space_guard_allows_v2_in_the_sm_build() {
        let _g = SEC_LOCK.lock().unwrap();
        let (_t, c) = temp_ws();
        c.execute("UPDATE meta.workspaces SET cipher_format = ?1 WHERE id = 'default'", [crypto::VERSION_SM4])
            .unwrap();
        assert!(ensure_space_format_supported(&c, "default").is_ok());
        assert!(sync_gate(&c).is_ok());
    }

    /// ★★ 附件那条路的**安静损坏**：解不开的**密文**绝不能被当成明文交出去。
    /// （旧逻辑是"解不开 ⇒ 透传"，那对"明文附件"是对的，对"本构建读不了的密文"是灾难。）
    #[cfg(not(feature = "sm-crypto"))]
    #[test]
    fn attachment_bytes_of_an_unsupported_format_are_refused_not_passed_through() {
        let keys = crypto::derive_app_keys("pw", &crypto::random_salt()).unwrap();
        let v1 = crypto::encrypt(b"from an older build", &crypto::AppKeys::legacy_only(keys.legacy)).unwrap();
        let mut v2 = v1.clone();
        v2[1] = crypto::VERSION_SM4; // 伪造"国密版写下的附件"
        let err = decrypt_attachment_bytes(Some(&keys), &v2).unwrap_err();
        assert!(err.contains("国密版"), "必须拒绝并说清怎么办：{err}");
        // 而**真的明文**（历史行为）仍要透传：加密未开时存的就是明文
        assert_eq!(decrypt_attachment_bytes(Some(&keys), b"plain file bytes").unwrap(), b"plain file bytes");
        // 认得出的版本但解不开（口令不同）也仍旧透传，别把老行为改坏
        let wrong = crypto::derive_app_keys("other", &crypto::random_salt()).unwrap();
        assert_eq!(decrypt_attachment_bytes(Some(&wrong), &v1).unwrap(), v1);
    }

    /// ★ **临时目录不许撞名**（2026-09-19 CI 红根因的常开判据）。
    ///
    /// 这条判据的形态是**并发**（不是"调两次"）：改前用顺序调两次是**绿的** ——
    /// 两次 `temp_ws()` 之间隔着三次 SQLite 建库，早就跨过毫秒了；只有"多个测试线程同时起跑"
    /// 才会落在同一毫秒里。所以判据必须用 `Barrier` 让 8 个线程**同时**进 `temp_ws()`，
    /// 否则它会给出假的安心（本机能过、CI 照红）。
    #[test]
    fn temp_dirs_are_unique_under_concurrency() {
        use std::collections::HashSet;
        use std::sync::{Arc, Barrier};
        const N: usize = 8;
        let barrier = Arc::new(Barrier::new(N));
        let hs: Vec<_> = (0..N)
            .map(|_| {
                let b = barrier.clone();
                std::thread::spawn(move || {
                    b.wait();
                    let (t, _c) = temp_ws();
                    t._dir
                })
            })
            .collect();
        let dirs: Vec<_> = hs.into_iter().map(|h| h.join().unwrap()).collect();
        for d in &dirs {
            assert!(d.exists(), "临时目录应当真的建出来了：{}", d.display());
        }
        let uniq: HashSet<_> = dirs.iter().collect();
        assert_eq!(
            uniq.len(),
            dirs.len(),
            "并发 temp_ws() 撞名：{N} 次里只有 {} 个不同目录 —— 并发测试会互相 remove_dir_all／串库",
            uniq.len()
        );
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
        let key = crypto::AppKeys::legacy_only(crypto::derive_key("correct-horse", &salt).unwrap());
        let wrong = crypto::AppKeys::legacy_only(crypto::derive_key("wrong-pass", &salt).unwrap());
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

    // ── P1：国密构建下"三条路径"都真的走 SM4（§7 验收：附件 / 导出包 / 同步载荷逐条勾）──
    //
    // ⚠️ 这一组**只在 `--features sm-crypto` 下编**。它盯的是"路径覆盖"，不是算法本身
    //    （算法由 `crypto_sm` 的 GM/T 向量用例与对拍门禁盯）。三条路径都从**同一个** `AppKeys`
    //    入口进出 —— 这也正是"漏一条就是一半国密"最容易发生的地方。
    #[cfg(feature = "sm-crypto")]
    #[test]
    fn national_crypto_covers_all_three_paths_and_keeps_the_library_key_unchanged() {
        let _g = SEC_LOCK.lock().unwrap();
        let (_t, c) = temp_ws();
        // 用**真**派生（不是 legacy_only）⇒ 手里有国密那一对密钥，写出去的就是 v2。
        let salt = crypto::random_salt();
        let keys = crypto::derive_app_keys("supersecret", &salt).unwrap();
        assert!(keys.sm.is_some(), "国密构建的会话密钥里必须有国密那一对");
        sync::set_meta_state(&c, crypto::ENC_SALT, &crypto::b64_encode(&salt)).unwrap();
        sync::set_meta_state(&c, crypto::ENC_VERIFY, &crypto::encrypt_str(VERIFY_MSG, &keys).unwrap()).unwrap();
        sync::set_meta_state(&c, crypto::ENC_ENABLED, "1").unwrap();
        *SESSION_KEY.lock().unwrap() = Some(keys);
        LOCKED.store(false, Ordering::SeqCst);

        // ★ 库级（SQLCipher 的 `PRAGMA key`）**必须仍是 legacy 那 32 字节**：
        //   一换，所有既有加密库当场打不开 —— 这是 P1 最贵的回归，比"少覆盖一条路径"更严重。
        assert_eq!(
            session_key(),
            Some(keys.legacy),
            "库级密钥被国密密钥顶替了 —— 既有加密库会全部打不开（库级换 KDF 是 P2-P3 的事）"
        );

        // ① 附件静置（含同步上传/下载共用的那条入口）
        let att = b"attachment bytes for the national-crypto path";
        let enc = encrypt_attachment_bytes(Some(&keys), att).unwrap();
        assert_eq!(&enc[..2], &[crypto::MAGIC, crypto::VERSION_SM4], "附件没写成国密");
        assert_eq!(decrypt_attachment_bytes(Some(&keys), &enc).unwrap(), att);

        // ② 同步载荷（上线时走的就是它）
        let payload = r#"{"id":"p1","content_text":"国密同步载荷"}"#;
        let wire = encrypt_payload(&c, payload).unwrap();
        let wire_bytes = crypto::b64_decode(&wire).unwrap();
        assert_eq!(&wire_bytes[..2], &[crypto::MAGIC, crypto::VERSION_SM4], "同步载荷没写成国密");
        assert_eq!(decrypt_payload(&c, &wire).unwrap(), payload);

        // ③ 导出包里的附件（读出来给人 = 走解密那条），以及"整库备份/导出"用的库级迁移
        //    仍然拿 legacy 密钥 —— 这一条由上面 `session_key()` 的断言守着。
        assert_eq!(
            crypto::decrypt(&wire_bytes, &keys).unwrap(),
            payload.as_bytes(),
            "v2 载荷必须能被同一个 AppKeys 解开（字符串/二进制两条路径同一套编码）"
        );

        // ④ 双读：老（v1）哨兵在国密构建里也解得开 —— 老用户升到国密版不会卡在解锁这一步。
        let old_sentinel = crypto::encrypt_str(VERIFY_MSG, &crypto::AppKeys::legacy_only(keys.legacy)).unwrap();
        assert_eq!(
            crypto::decrypt_str(&old_sentinel, &keys).unwrap(),
            VERIFY_MSG,
            "国密构建解不开 v1 哨兵 ⇒ 老用户升级后卡在解锁屏（§4 第 6 条）"
        );
    }

    // A raw SQLCipher key (x'hex') created on one connection is readable on a fresh
    // connection with the same key and fails with a wrong key — the disk-encryption
    // foundation that convert_space_db builds on.
    /// 夹具的**生成器**（默认不跑；`--ignored` 手动跑）。它刻意留在仓库里，因为夹具必须在
    /// "**另一种后端**"下才能重新生成 —— 那是 ⑤ 的验收条件之一，别人要复现得知道怎么造。
    ///
    /// ⚠️ 生成时必须确认当时编进去的是哪个后端（`node scripts/check-crypto-backend.mjs`）：
    /// 这份夹具要的是"**macOS 默认（CommonCrypto）写下的密文**"，换后端之后不要拿新后端重生成它，
    /// 否则"换后端前后旧库仍可读"这条判据就变成了"用同一个后端验证自己"。
    #[test]
    #[ignore = "夹具生成器（手动跑；须核对当时编入的后端）"]
    /// **SM4 页**夹具生成器（2026-09-20，配合补丁 v3「无条件 SM4 页加密」）。
    ///
    /// ⚠️ **必须在"页加密＝SM4"的构建里跑**（`scripts/sm-library-build.mjs --openssl-dir <Tongsuo>`
    /// 打完 v3 补丁之后）：同一个生成器在 AES 页构建里跑出来的就是 AES 页夹具（那份叫
    /// `sqlcipher-backend-fixture.db`，见下一个生成器）。**从内容上看不出是哪一种** ——
    /// 这正是 `cipher_settings` 里没有 algorithm 字段的后果，所以两条判据靠"交叉打开"来判定
    /// （见 `exactly_one_page_cipher_fixture_opens_and_the_other_is_refused`）。
    ///
    /// ★ **更正（2026-09-22）**：这份夹具是用**裸 `PRAGMA key`**（不设任何 `cipher_*`）写的 ⇒
    /// 它的**页 MAC/库 KDF 是"这个构建的默认值"**，不是"SM3"。补丁 v3 只改页加密算法
    /// （`default_hmac_algorithm` / `default_kdf_algorithm` 在补丁里是**未改的上下文行**）⇒
    /// 当今它写出来的是 **SM4 页 ＋ SHA512 默认**。所以：
    ///   · 它证明的是**页加密**（这一条判据只判页加密，别再把它读成"页 MAC/KDF 也是国密"）；
    ///   · 页 MAC/库 KDF 的国密化由**另外两处**证：`gm_provider` 的回显（连接级）＋
    ///     `sqlcipher-sm3-fixture.db`（那份是**显式设了国密参数**写的，参数绑定是真的）。
    ///   · 补丁 v4（把默认值也改成 SM3）落地后：**在 OpenSSL 构建里**这份夹具会变成 SM4 页 ＋ SM3，
    ///     那时**重生成**它即可（`raw_key_defaults_are_sm3_only_when_the_patch_says_so` 会自动换边）。
    #[test]
    #[ignore = "夹具生成器：必须在**页加密＝SM4**的构建里跑（打 v3 补丁 ＋ OpenSSL 后端；与是否接线无关）"]
    fn gen_sm4_page_fixture() {
        let hex = crypto::key_hex(&[7u8; 32]);
        let key_sql = format!("PRAGMA key = \"x'{hex}'\";");
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/sqlcipher-sm4-page-fixture.db");
        let _ = std::fs::remove_file(&out);
        {
            let c = Connection::open(&out).unwrap();
            c.execute_batch(&key_sql).unwrap();
            c.execute_batch(
                "CREATE TABLE pages (id TEXT PRIMARY KEY, title TEXT NOT NULL, content_text TEXT NOT NULL); \
                 INSERT INTO pages VALUES ('p1','后端无关性夹具','由创建时的 provider 写下的密文'); \
                 INSERT INTO pages VALUES ('p2','第二行','确认多行与顺序');",
            )
            .unwrap();
            c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        }
        let n = std::fs::metadata(&out).unwrap().len();
        println!("SM4 页夹具已生成：{}（{n} 字节）", out.display());
        assert!(n > 4096, "夹具太小，像个空库：{n} 字节");
    }

    fn gen_backend_fixture() {
        let hex = crypto::key_hex(&[7u8; 32]);
        let key_sql = format!("PRAGMA key = \"x'{hex}'\";");
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/sqlcipher-backend-fixture.db");
        let _ = std::fs::remove_file(&out);
        {
            let c = Connection::open(&out).unwrap();
            c.execute_batch(&key_sql).unwrap();
            c.execute_batch(
                "CREATE TABLE pages (id TEXT PRIMARY KEY, title TEXT NOT NULL, content_text TEXT NOT NULL); \
                 INSERT INTO pages VALUES ('p1','后端无关性夹具','由创建时的 provider 写下的密文'); \
                 INSERT INTO pages VALUES ('p2','第二行','确认多行与顺序');",
            )
            .unwrap();
            // 强制落盘（不然可能还在 WAL 里）
            c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        }
        let n = std::fs::metadata(&out).unwrap().len();
        println!("夹具已生成：{}（{n} 字节）", out.display());
        assert!(n > 4096, "夹具太小，像个空库：{n} 字节");
    }

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

    /// ★★ **换加密后端前后，旧库仍必须可读**（方案 §7 风险表里那条验收项）。
    ///
    /// 为什么这条是**硬**要求：SQLCipher 的页加密后端是**编译期**决定的（`SQLCIPHER_CRYPTO_CC`
    /// 只有 AES；`SQLCIPHER_CRYPTO_OPENSSL` 才能接 Tongsuo 的 SM4）—— 也就是说
    /// **`--features sm-crypto` 能不能真的用上国密，取决于这个后端有没有被换掉**。
    /// 而后端一换，所有既有用户库里那些"用 Apple 后端写下的页"就要靠**参数逐字节一致**
    /// （PBKDF2-HMAC-SHA512 轮数 / AES-256-CBC / 页大小 / HMAC 大小）才打得开。
    /// 参数只要有一处不同，症状就是**用户打不开自己的数据库**，而它在开发机上不会自己冒出来。
    ///
    /// 夹具 `tests/sqlcipher-backend-fixture.db` 是 **2026-09-19 由 macOS 默认后端（CommonCrypto）**
    /// 真实写下的（生成器见 `gen_backend_fixture`，key = `0x07 × 32`）。
    /// 读一份**页加密夹具**：能读开就顺手验证"内容对 ＋ 还写得进"，不能读开就把原始错误带回。
    ///
    /// 为什么"读得开还要写得进"：页参数不一致时，**读**可能侥幸通过而**写回**才炸
    /// （既有判据的老经验），所以这里把写也验一遍。
    fn probe_page_cipher_fixture(bytes: &[u8], tag: &str) -> Result<usize, String> {
        assert!(bytes.len() > 4096, "{tag} 夹具不见了或太小（{} 字节）", bytes.len());
        assert_ne!(&bytes[..16], b"SQLite format 3\0", "{tag} 夹具是**明文** SQLite —— 那样它证明不了任何东西");
        let dir = uniq_tmp(&format!("fix-{tag}"));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fixture.db");
        std::fs::write(&path, bytes).unwrap();
        let c = Connection::open(&path).unwrap();
        c.execute_batch(&format!("PRAGMA key = \"x'{}'\";", crypto::key_hex(&[7u8; 32]))).unwrap();
        let rows: Result<Vec<(String, String, String)>, _> = c
            .prepare("SELECT id, title, content_text FROM pages ORDER BY id")
            .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect());
        let rows = match rows {
            Ok(r) => r,
            Err(e) => return Err(e.to_string()),
        };
        assert_eq!(
            rows,
            vec![
                ("p1".to_string(), "后端无关性夹具".to_string(), "由创建时的 provider 写下的密文".to_string()),
                ("p2".to_string(), "第二行".to_string(), "确认多行与顺序".to_string()),
            ],
            "{tag} 夹具读出来的内容不对"
        );
        c.execute("INSERT INTO pages VALUES ('p3','本构建新写的','仍然可写')", [])
            .map_err(|e| format!("{tag} 夹具读得开但**写不进**：{e}"))?;
        let n: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(&dir);
        Ok(n as usize)
    }

    /// ★ **库级参数是库文件的属性**：同一份构建**只能**读开其中一种夹具（方案 §3.3 判据 1「交叉打开必须失败」）。
    ///
    /// ⚠️⚠️ **这条判据只判「页加密」，不判页 MAC/库 KDF**（2026-09-22 **更正我自己**）：
    /// 两份夹具都是用**裸 `PRAGMA key`**（不设任何 `cipher_*`）写的 ⇒ 它们的**页 MAC/库 KDF 都是
    /// "写它那个构建的默认值"**。补丁 v3 只改页加密算法（`default_hmac_algorithm` /
    /// `default_kdf_algorithm` 在补丁里是**未改的上下文行**）⇒ 当今两份夹具的 MAC/KDF **都是 SHA512**，
    /// 而**页**一个是 AES、一个是 SM4 —— 所以交叉打开能分开的**只有页加密**。
    /// 我先前在这条判据的打印里写了"SM4 页 ＋ **SM3** 页 MAC/库 KDF"，那是**把夹具的来源读错了**：
    /// `gen_sm4_page_fixture` 从来没有设过 `cipher_*`，它打印不出 SM3 这件事。
    /// 页 MAC/库 KDF 的国密化**另有证据**：`gm_provider` 的回显（连接级）＋ `sqlcipher-sm3-fixture.db`
    /// （显式设了国密参数写的，参数绑定是真的）＋ `raw_key_defaults_are_sm3_only_when_the_patch_says_so`
    /// （默认值到底是不是 SM3；补丁 v4 落地后会自动换边）。
    ///
    /// 两份夹具内容**逐字相同**、都用同一把裸钥（`[7u8;32]`），唯一差别是**写下它的构建的页加密算法**：
    ///   · `sqlcipher-backend-fixture.db` —— **AES 页**（由 CommonCrypto 的默认构建写下，2026-09-19）；
    ///   · `sqlcipher-sm4-page-fixture.db` —— **SM4 页**（由打了补丁 v3「无条件 SM4 页加密」的构建写下，2026-09-20）。
    ///     ⚠️ **页加密一改，这份夹具就要重生成**（`gen_sm4_page_fixture`）。
    ///
    /// 断言 **恰好一个能开**，并打印**是哪一个** —— 这同时**报出这份构建的页加密算法**，
    /// 而这是唯一可信的判据：`cipher_settings` 的回显里**没有** algorithm 字段（方案 §3.2 事实 3），
    /// 靠回显或环境变量都会得到"绿得不是它声称的那件事"。
    ///
    /// ⚠️ 这条判据替换了原来的 `fixture_db_written_by_the_other_provider_still_opens`
    /// （它证明的是"换 **provider** 之后旧库仍可读"）—— 那条在"页加密也跟着换"之后**语义就变了**：
    /// 现在决定可读性的是**页加密算法**，不是 provider。两份夹具 + 异或，把这个性质**双向**钉住。
    #[test]
    fn exactly_one_page_cipher_fixture_opens_and_the_other_is_refused() {
        let aes = probe_page_cipher_fixture(include_bytes!("../tests/sqlcipher-backend-fixture.db"), "aes-page");
        let sm4 = probe_page_cipher_fixture(include_bytes!("../tests/sqlcipher-sm4-page-fixture.db"), "sm4-page");
        match (&aes, &sm4) {
            (Ok(n), Err(e)) => {
                assert!(e.contains("file is not a database"), "SM4 夹具被拒的理由不该是别的：{e}");
                println!(
                    "本构建的**页加密** = **AES 页**（AES 夹具读开且可写，{n} 行；SM4 夹具按预期拒绝：{e}）\
                     —— 页 MAC/库 KDF 不在这一条里（夹具是裸钥写的，见本条判据的注释）"
                );
            }
            (Err(e), Ok(n)) => {
                assert!(e.contains("file is not a database"), "AES 夹具被拒的理由不该是别的：{e}");
                println!(
                    "本构建的**页加密** = **SM4 页**（SM4 夹具读开且可写，{n} 行；AES 夹具按预期拒绝：{e}）\
                     —— 页 MAC/库 KDF 不在这一条里（夹具是裸钥写的，见本条判据的注释）"
                );
            }
            (Ok(_), Ok(_)) => panic!("两份页加密不同的夹具**都能开** ⇒ 「页加密是库文件属性」不成立，或某份夹具写错了"),
            (Err(a), Err(b)) => panic!("两种都开不了 ⇒ 夹具/密钥/构建有问题：aes={a}；sm4={b}"),
        }
    }

    /// ★ **夹具的页 MAC/库 KDF 到底是什么？** —— 用"同一个文件、两种读法"分开（2026-09-22 加）。
    ///
    /// 动机：上面那条**交叉打开**只能分开**页加密**，而"库级 MAC/KDF 是国密"这句话曾经被挂在它头上
    /// （我自己写错了一次，见那条判据的注释）。这一条直接量**那个问题**：
    /// 同一份 SM4 夹具，**裸钥**读得开、**再设 `cipher_hmac_algorithm=HMAC_SM3`/`cipher_kdf_algorithm=PBKDF2_HMAC_SM3`**
    /// 之后还读得开吗？—— 实测（补丁 v3、未接线）**读不开**（`file is not a database`）⇒
    /// 说明这份夹具的 MAC/KDF 是**默认（SHA512）**，页加密与 MAC/KDF 是**两件事**。
    ///
    /// ★ **它同时是"补丁 v4"的前瞻判据**（自适应当前状态，不需要改代码就能换边）：
    ///   · 裸钥读法回显**不是** SM3（今天）⇒ 断言"设了国密参数之后**读不开**"（证明夹具不是 SM3 参数）；
    ///   · 裸钥读法回显**是** SM3（v4 落地后的 OpenSSL 构建）⇒ 断言"设了国密参数之后**照样读得开**"。
    /// ⇒ v4 落地时这一条会自动变成"默认值＝国密"的产物级判据，不用人来记得改它。
    #[test]
    fn raw_key_defaults_are_sm3_only_when_the_patch_says_so() {
        let bytes = include_bytes!("../tests/sqlcipher-sm4-page-fixture.db");
        let hex = crypto::key_hex(&[7u8; 32]);
        let key_sql = format!("PRAGMA key = \"x'{hex}'\";");
        let dir = uniq_tmp("raw-defaults");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fixture.db");
        std::fs::write(&path, bytes.as_slice()).unwrap();

        // ① 裸钥（不设任何 cipher_*）：先看回显，再决定期望
        let raw = Connection::open(&path).unwrap();
        raw.execute_batch(&key_sql).unwrap();
        let status = crate::gm_provider::read_gm_cipher_status(&raw).unwrap();
        let defaults_are_sm3 = status.is_applied();
        let raw_read: Result<i64, _> = raw
            .query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0));
        // 页加密不同的话裸钥就开不了（AES 页构建里读 SM4 夹具）⇒ 那种构建上这条判据只报状态
        let page_cipher_matches = raw_read.is_ok();
        drop(raw);

        // ② 同一个文件、**设了国密参数**再读
        let gm = Connection::open(&path).unwrap();
        gm.execute_batch(&key_sql).unwrap();
        let gm_read = (|| -> Result<i64, String> {
            crate::gm_provider::configure_gm_cipher(&gm)?;
            gm.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())
        })();

        println!(
            "SM4 夹具读数：裸钥默认回显 = {:?}（defaults_are_sm3={defaults_are_sm3}）· 裸钥读 = {raw_read:?} · 设国密参数后读 = {gm_read:?}",
            status
        );
        if !page_cipher_matches {
            println!("（本构建的页加密不是 SM4 ⇒ 两个读法都读不开，这一条只报状态、不断言）");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        if defaults_are_sm3 {
            // v4 落地后的形态：默认就是国密 ⇒ 设了国密参数照样读得开
            assert!(
                gm_read.is_ok(),
                "裸钥默认回显已经是 SM3，但设了国密参数反而读不开 ⇒ 默认值与显式设置不一致：{gm_read:?}"
            );
        } else {
            assert!(
                gm_read.is_err(),
                "裸钥默认**不是** SM3，而设了国密参数却仍读得开 ⇒ 这份夹具本来就用国密参数写的（标签与事实不符）：{gm_read:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
