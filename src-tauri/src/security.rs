use crate::crypto;
use crate::db::{Db, space_db_path};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::State;

/// App-session "locked" flag: gating pushes/pulls until the passphrase is re-entered.
static LOCKED: AtomicBool = AtomicBool::new(false);

/// 会话态（`LOCKED` / 钥匙袋 / **主密钥**）都是**进程级全局** ⇒
/// 凡是会动它们的**测试**（`security::tests` 与 `space_crypto::tests`）必须共用这一把锁串行跑，
/// 否则 cargo test 的多线程会把它们交错（表现：隔离跑绿、**全量跑红**）。
#[cfg(test)]
pub(crate) static SEC_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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

/// Whether encryption is on **for this connection's space**: its DB file is ciphertext
/// **or** the keyring holds a box for it.
///
/// ★ owner 第三轮拍板（2026-09-24）：**旧路兜底（应用级标志 `ENC_ENABLED`）已删** ——
/// "应用级加密"（全局一把钥匙）那一套整条去掉，存量库按 C=1 口径**报错＋说清**，
/// 绝不静默降级成明文。所以这里只剩"按空间"一条判据。
fn encryption_enabled(c: &Connection) -> bool {
    let Some(path) = c.path().filter(|p| !p.is_empty()) else {
        return false; // 内存连接（锁定时的主连接）/ 无空间上下文 ⇒ 不是"这个空间的库"
    };
    let p = Path::new(path);
    if space_db_is_encrypted(p) {
        return true;
    }
    match crate::space_crypto::space_id_from_path(p) {
        Some(id) => crate::space_crypto::keyring().map(|k| k.has(&id)).unwrap_or(false),
        None => false,
    }
}

/// 会话当前**拿得到**这个空间库的钥匙吗（＝袋子有它的盒子 ＋ 会话里有主密钥）。
///
/// ⚠️ 这是"启动闸门要不要拦"的唯一判据 —— 旧版看的是应用级 `SESSION_KEY`，
/// 那条已随应用级加密一起删（空间钥匙不落盘、也不在启动时存在）。
fn space_key_available(path: &Path) -> bool {
    matches!(crate::space_crypto::space_key_for_path(path), Ok(Some(_)))
}

/// Read the **space-held** key material for this connection's space
/// (if that space is encrypted and the session is unlocked).
///
/// ⚠️ 返回的是**这个空间自己的**钥匙（`space_crypto::space_app_keys_for_path`），不是
/// "应用级一把钥匙" —— 后者已随 owner 第三轮拍板整条删掉。明文空间 / 未解锁 / 拿不出空间上下文
/// ⇒ `None`（调用方按"不加密"处理）。**没有"退回旧钥匙"这条出口**：
/// 密文库而袋里没有盒子的形态在**开库**那一步就已经响亮失败（[`key_space_conn`]），
/// 载荷那条另有一层明确的 `Err`（[`encrypt_payload`] / [`decrypt_payload`]）。
pub fn key_if_enabled(c: &Connection) -> Option<crypto::AppKeys> {
    if LOCKED.load(Ordering::SeqCst) {
        return None;
    }
    if !encryption_enabled(c) {
        return None;
    }
    let path = c.path().filter(|p| !p.is_empty())?;
    crate::space_crypto::space_app_keys_for_path(Path::new(path)).ok().flatten()
}

/// Encrypt attachment BYTES at rest with **this space's** key, ONLY when the space is
/// encrypted and the session is unlocked. When there is no key (plaintext space / locked)
/// this passes the bytes through unchanged, so plaintext spaces keep working.
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
///
/// ★ **按空间**（见 [`wire_keys_for_conn`] 的三种出口）：有盒子 ⇒ 用**它自己的**钥匙（v1）；
/// 明文空间 ⇒ 原样；密文库而袋里没有它（应用级加密的存量库）⇒ **`Err`**。
/// ⚠️ 这一条 `Err` 是**必须**的：绝不把没有钥匙的空间**当明文发出去**（那是静默的明文上云）。
pub fn encrypt_payload(c: &Connection, payload: &str) -> Result<String, String> {
    match wire_keys_for_conn(c)? {
        Some(k) => crypto::encrypt_str(payload, &k),
        None => Ok(payload.to_string()),
    }
}

/// Decrypt an incoming payload if encryption is enabled; passthrough otherwise.
///
/// ⚠️ 与 `encrypt_payload` 同一条按空间规则。**放行条件**收得更紧：只有"这个空间本来就不该是密文"
/// （袋里没有它 ＋ 库文件也不是密文）才原样返回；否则解不开就**报错**（不许把密文当明文读）。
pub fn decrypt_payload(c: &Connection, payload: &str) -> Result<String, String> {
    match wire_keys_for_conn(c)? {
        Some(k) => crypto::decrypt_str(payload, &k),
        None => Ok(payload.to_string()),
    }
}

/// ★ **这个连接**（＝这个空间库）在 wire 上该用哪把钥匙。**出口只有三种，没有第四种**：
///
/// · 袋子里真有这个空间 ⇒ `Ok(Some(它自己的 AppKeys))`；
/// · 袋里没有它、而这个库**不是密文**（＝明文空间）⇒ `Ok(None)`（不加密，原样过）；
/// · 袋里没有它、而这个库**是密文** ⇒ `Err` —— 那是"**应用级加密**"（全局一把钥匙）留下的存量库，
///   而那一套已按 owner 拍板删掉 ⇒ **响亮拒绝**：不退回旧钥匙、更不把明文放行。
///   （"静默降级成明文"正是这里最坏的结局，所以宁可整条同步失败。）
fn wire_keys_for_conn(c: &Connection) -> Result<Option<crypto::AppKeys>, String> {
    let Some(path) = c.path().filter(|p| !p.is_empty()) else {
        return Ok(None); // 内存连接：没有空间上下文 ⇒ 没有钥匙可用，也不该有
    };
    let path = Path::new(path);
    if let Some(keys) = crate::space_crypto::space_app_keys_for_path(path)? {
        return Ok(Some(keys));
    }
    if space_db_is_encrypted(path) {
        return Err(legacy_ciphertext_refusal(
            crate::space_crypto::space_id_from_path(path).as_deref(),
            "本版不会退回旧钥匙，也不会把明文发出去（这条载荷没有离开本机）",
        ));
    }
    Ok(None)
}

/// 「密文库 ＋ 钥匙袋里没有它的盒子」＝ **应用级加密**留下的存量库。**开库那条与载荷那条共用这一句**
/// （两处各写一遍，措辞迟早会漂；而这句正是用户唯一能看到的"为什么打不开"）。
fn legacy_ciphertext_refusal(space_id: Option<&str>, tail: &str) -> String {
    format!(
        "{} —— 那是早先「应用级加密」（全局一把钥匙）留下的存量库，\
         而**应用级加密已不再支持**：{tail}。\
         唯一还有救的一条路：在**还有那份旧材料**的设备上把公开材料推给同步服务，再在这台设备上取回\
         （公开材料里带着这个空间的盒子），否则这个空间打不开。",
        legacy_who(space_id)
    )
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

/// ★ **启动闸门**——"这个空间的库现在能不能直接打开？"
///
/// 判据是**嗅这个文件 ＋ 现在拿不拿得到它的钥匙**：密的 **且** 会话里没有它的空间钥匙 ⇒ 不能
/// （退回内存库 ＋ attach meta，让解锁屏能用）；否则能。
/// ⇒ 好处：一个**明文**空间不再因为"别的空间开着加密"而被拦在解锁屏后面。
pub(crate) fn startup_needs_unlock(space_path: &Path) -> bool {
    space_db_is_encrypted(space_path) && !space_key_available(space_path)
}

/// Apply `PRAGMA key` to a fresh connection if (and only if) its DB file is
/// encrypted at rest, using **this space's own** key from the keyring.
/// Errors when the file is encrypted but there is no box for it — callers must only
/// reach here unlocked, except the startup gate which avoids opening a keyed space DB
/// until unlock.
///
/// ★ owner 第三轮拍板（2026-09-24）：**"应用级 session key"那条兜底已删**（连解锁的兜底一起）——
/// 密文库而袋里没有它的盒子有两种，都要**响亮说清**、绝不猜：
/// · 本进程还没载入公开材料（＝还没解锁 / meta 里根本没有钥匙袋）⇒ 让用户先解锁；
/// · 载入了袋子而里面没有这个空间 ⇒ 那是应用级加密的存量库 ⇒ 本版**不再支持**（[`legacy_ciphertext_refusal`]）。
pub fn key_space_conn(conn: &Connection, path: &Path) -> Result<(), String> {
    if !space_db_is_encrypted(path) {
        return Ok(());
    }
    let space_id = crate::space_crypto::space_id_from_path(path);
    if let Some(key) = crate::space_crypto::space_key_for_path(path)? {
        return set_cipher_key(conn, &key);
    }
    if !crate::space_crypto::keyring_loaded() {
        return Err(format!(
            "{}，而本进程还没有载入公开材料（钥匙袋）—— 先输口令解锁，再打开这个空间。\
             ⚠️ 若本机从来没有过钥匙袋，那这份库就是「应用级加密」留下的存量库：**应用级加密已不再支持**，\
             本版不会退回旧钥匙，也不会把密文当明文读。",
            legacy_who(space_id.as_deref())
        ));
    }
    Err(legacy_ciphertext_refusal(
        space_id.as_deref(),
        "本版不会退回旧钥匙，也不会把密文当明文读",
    ))
}

/// 「谁」那一小段（两处报错共用，免得措辞漂）。
fn legacy_who(space_id: Option<&str>) -> String {
    match space_id {
        Some(id) => format!("空间「{id}」的库是密文，但钥匙袋里没有它的盒子"),
        None => "这个库是密文，但钥匙袋里没有它的盒子".to_string(),
    }
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
    // ★★ 逐表拷贝：**按列名求交集**，不许再写 `SELECT *`。
    //
    // 为什么（owner 2026-09-24 现场）：源库是**老 schema**（比如某个"很久没被打开过"的空间文件
    // 还没有 09-23 才加的那一列），而目标是 `migrate()` 刚建出来的**当前 schema** ⇒ 两边列数不同
    // ⇒ `INSERT INTO main.t SELECT * FROM plain.t` 当场报
    // 「table main.workspaces has 9 columns but 8 values were supplied」，
    // 而这条路径是**开/关加密**（现在唯一的加密开关）⇒ 那个空间**根本加不了密**。
    // ⚠️ 以前的判据全绿，是因为夹具都是"刚 migrate 过的新库"—— 又一类**只有老库才会中**的缺陷。
    // 口径（不静默）：
    //   · 目标有、源没有的列 ⇒ 不拷（让它取目标默认值）—— 这正是"老库补列"该有的样子；
    //   · **源有、目标没有的列** ⇒ **拒绝转换并报错**：那说明这个文件比本版新，硬拷会**静默丢数据**。
    for t in &tables {
        let src_cols = table_columns(&dst, &format!("plain.\"{t}\""))?;
        let dst_cols = table_columns(&dst, &format!("main.\"{t}\""))?;
        let missing_in_target: Vec<&String> =
            src_cols.iter().filter(|c| !dst_cols.iter().any(|d| d.eq_ignore_ascii_case(c))).collect();
        if !missing_in_target.is_empty() {
            return Err(format!(
                "表 {t} 里有本版不认识的列（{}）—— 这个库比本版**新**，硬转换会丢数据 ⇒ 拒绝转换。\
                 请升级应用后再开/关这个空间的加密。",
                missing_in_target.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
            ));
        }
        let common: Vec<&String> =
            src_cols.iter().filter(|c| dst_cols.iter().any(|d| d.eq_ignore_ascii_case(c))).collect();
        let cols = common.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
        dst.execute(
            &format!("INSERT INTO main.\"{t}\" ({cols}) SELECT {cols} FROM plain.\"{t}\""),
            [],
        )
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

/// 读一个（可能被 ATTACH 的）表的列名。
///
/// ⚠️ 用 `SELECT * … LIMIT 0` 的 `column_names()`，**不用** `pragma_table_info`：
/// 后者带 schema 的名字要么报错要么返回空（我在判据里踩过一次），而这里要的是"这个连接看到的
/// 真实列序"，`column_names()` 就是权威。表名来自 `sqlite_master`（我们自己建的），已加引号。
fn table_columns(conn: &Connection, qualified_table: &str) -> Result<Vec<String>, String> {
    let stmt = conn
        .prepare(&format!("SELECT * FROM {qualified_table} LIMIT 0"))
        .map_err(|e| format!("读列名失败（{qualified_table}）：{e}"))?;
    Ok(stmt.column_names().into_iter().map(|s| s.to_string()).collect())
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

/// Re-open the given space DB on the main connection, applying **that space's own**
/// `PRAGMA key` when the file is encrypted. Used by unlock (and by the per-space enable/
/// disable path in `space_crypto`) so the active space is keyed (or plaintext after a
/// disable) right after a convert.
fn reopen_keyed(c: &mut Connection, space_id: &str, app_data_dir: &Path) -> Result<(), String> {
    // `reopen_space_at` re-opens the file and re-attaches meta; it applies the key
    // itself (via key_space_conn) when the target file is encrypted.
    // ★ 失败要**可操作**（P3 预置）：解锁时应用层哨兵已经验过口令了，随后这一步是**库级**打开 ——
    //   页加密算法/页参数不同时原始报错与"口令错"一字不差，不翻的话用户会一直怀疑口令。
    crate::db::reopen_space_at(c, space_id, app_data_dir)
        .map_err(|e| cipher_open_error(&e, &format!("空间 {space_id} 的库")))
}

/// Per-space at-rest encryption marker (meta.workspaces.encrypted): records which
/// space DBs are SQLCipher-encrypted (set on a successful **per-space** enable/disable).
/// The open path keys a connection when the file is detected as encrypted at rest (header
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
    /// ★ 第 1 步（1b-2）：**当前活动空间的按空间读数**（库文件是不是密的／袋里有没有它／拿不拿得到钥匙）。
    /// 与上面的 `space_format` 互补：那个说"数据是哪一版"，这个说"**这个空间到底加不加密、钥匙在不在**"——
    /// 第 2 步的同步闸门与设置面板都读它。
    pub active_space: crate::space_crypto::SpaceCryptoStatus,
    /// ★ 第 2 步：**闸门对当前活动空间的裁决**（拦 / 放行 / 放行但未分类 ＋ 原因）。
    /// 放在这里是为了让 owner/UI **一眼看到**"这个空间会不会被闸门拦住"，而不是只能从绑定失败里猜。
    pub active_space_gate: crate::space_crypto::SyncGateView,
}

#[tauri::command]
pub fn encryption_status(db: State<Db>) -> Result<EncryptionStatus, String> {
    let c = conn(&db);
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
    // ★ 第 1 步（1b-2）：活动空间的**按空间**读数（纯读：嗅文件 ＋ 看本进程的钥匙袋/会话）。
    let active_id = crate::workspaces::active_workspace_id(&c).ok();
    let active_space = match (crate::db::app_data_dir_ref(), active_id.as_deref()) {
        (Some(dir), Some(sid)) => {
            let mut st = crate::space_crypto::space_status(dir, sid);
            // ★ 名字（不是 uuid）：闸门那句拦人的话要说名字（owner 2026-09-24 指出）。
            crate::space_crypto::fill_space_name(&c, &mut st);
            st
        }
        _ => crate::space_crypto::SpaceCryptoStatus {
            space_id: String::new(),
            name: String::new(),
            encrypted_on_disk: false,
            in_keyring: false,
            key_available: false,
        },
    };
    // ★ owner 第三轮拍板（2026-09-24）：`enabled` **也要看活动空间自己**。
    //   为什么必须：解锁屏的判据是 `enabled && locked`（`App.tsx`），而**锁定时主连接是内存库**
    //   —— 它的 `c.path()` 是空的 ⇒ 只看连接会把"已加密但锁着"读成"没开加密" ⇒ 解锁屏不出现、
    //   用户直接对着一个读不出来的外壳。旧版靠应用级标志（meta 里那个 `ENC_ENABLED`）躲过这一条，
    //   而那个标志已随应用级加密一起删 ⇒ 这里按活动空间的文件头 ＋ 盒子补上。
    let enabled = encryption_enabled(&c) || active_space.encrypted_on_disk || active_space.in_keyring;
    // ★ 第 2 步：闸门裁决（同一份读数 ＋ 本地分类标记 ⇒ 视图）。
    let active_space_gate = match active_id.as_deref() {
        Some(sid) => crate::space_crypto::sync_gate_view(
            &active_space,
            crate::space_crypto::space_kind(&c, sid),
        ),
        None => crate::space_crypto::SyncGateView {
            allow: true,
            unclassified: true,
            reason: "还没有活动空间".to_string(),
        },
    };
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
        active_space,
        active_space_gate,
    })
}

/// Lock the session: drop the **space master key**, mark locked, and CLOSE the active space
/// connection (restore an in-memory base + meta, like the startup gate) so a locked
/// session genuinely cannot read the space — the "锁定态不读" guarantee, not just
/// gating sync. `unlock_encryption` re-opens the space keyed.
///
/// ★ owner 第三轮拍板（2026-09-24）：锁定时卸下的是**钥匙袋的主密钥**
/// （`space_crypto::SESSION_MASTER`）—— 空间钥匙是它解盒子解出来的，主密钥一走就再也拿不到。
/// 袋子的**公开材料**留着无妨（它本来就是公开的），而且留着才能让"未解锁"与"袋里没有它"
/// 在报错时分开说。
pub(crate) fn lock_encryption_impl(conn: &mut Connection, app_data_dir: &Path) -> Result<(), String> {
    if LOCKED.load(Ordering::SeqCst) {
        return Ok(()); // 已经锁着：幂等（此时的连接本来就是那把内存连接，再"锁"一次没有意义）
    }
    if !encryption_enabled(conn) {
        return Err("这个空间没有加密，没有什么可锁的".to_string());
    }
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
///
/// ★ owner 第三轮拍板（2026-09-24）：解锁**不再碰应用级的盐/哨兵**（`ENC_SALT` / `ENC_VERIFY`
/// 那套随应用级加密一起删）。现在的形状：
/// · 载入**公开材料**（钥匙袋）⇒ 按**袋子自己记的** KDF 参数推主密钥；
/// · 口令对不对**由解盒子回答**（AEAD）：解不开 ⇒ "盒子打不开（口令不对或盒子被改过）"，
///   **不是**旧文案"口令不正确"（旧文案来自哨兵，哨兵已删）；
/// · **没有袋子 / 袋里一个盒子都没有** ⇒ 直接算解锁成功（旧路已无 ⇒ 等价于"什么都还没加密"）；
/// · 应用级加密的存量库在**开库那一步**响亮失败（[`key_space_conn`]），不在这里伪装成"解锁成功"。
pub(crate) fn unlock_encryption_impl(
    conn: &mut Connection,
    app_data_dir: &Path,
    passphrase: String,
) -> Result<(), String> {
    // ★ 件5 的实测口径（2026-09-24 晚**更新**）：应用级那套删掉之后，**整条解锁** ＝
    //   **一次 KDF**（钥匙袋那条：Argon2id ＋ 国密构建里的 SM3 那条腿）＋ 解盒子 ＋ 开库。
    //   微基准只量了 KDF 本身，所以这里自己记一条时间线 —— 真机上量"整体解锁"就靠它。
    let t_unlock = std::time::Instant::now();
    // 载入公开材料（坏材料 ⇒ 在这里**报错**，不许静默当成"没有袋子"而降级成明文路径）。
    crate::space_crypto::carry_keyring(conn)?;
    let master = crate::space_crypto::master_from_passphrase(conn, &passphrase)?;
    // ★ 口令对不对，**由解盒子回答**（袋子没有 / 一个盒子都没有 ⇒ 没什么可解 ⇒ 直接算成功）。
    if let (Some(m), Some(kr)) = (master, crate::space_crypto::keyring()) {
        crate::space_crypto::verify_master_against_keyring(&kr, &m)?;
    }
    crate::space_crypto::set_session_master(master)?;
    LOCKED.store(false, Ordering::SeqCst);
    let active = crate::workspaces::active_workspace_id(conn)?;
    // Re-open the active space DB keyed — without this PRAGMA key the app would fail to
    // read it after a locked restart. ⚠️ 存量（应用级加密的）库在这一步响亮失败。
    reopen_keyed(conn, &active, app_data_dir)?;
    // ★ 件5：一行**耗时日志**（桌面直接可见；Android 侧看它能不能进 logcat —— 进不了就下一版换落盘）。
    //   读数要点：这里是**一遍 KDF ＋ 解盒子 ＋ 开库**（应用级那条 KDF 已删 ⇒ 比旧读数少一遍）。
    eprintln!(
        "[unlock] 整条解锁 {} ms（一遍 KDF：钥匙袋那条；＋解盒子 ＋开库）",
        t_unlock.elapsed().as_millis()
    );
    Ok(())
}

#[tauri::command]
pub fn unlock_encryption(db: State<Db>, passphrase: String) -> Result<(), String> {
    let mut guard = db.0.lock().map_err(|_| "会话锁失效".to_string())?;
    let dir = crate::db::app_data_dir_ref().ok_or("app data dir not initialised")?;
    unlock_encryption_impl(&mut *guard, dir, passphrase)
}

/// On app start: (a) load the **public material** (the keyring) into this process, and
/// (b) if the **active space** is encrypted, default to the locked state so the passphrase
/// must be re-entered before any encrypted sync happens (restart does not leave the session
/// unlocked with a persisted key — the master key never touches disk).
///
/// ★ owner 第三轮拍板（2026-09-24）：
/// · 锁的判据是**嗅活动空间自己的库文件**（旧版看应用级标志；那个标志已删）
///   ⇒ 明文空间不再因为"别的空间开着加密"而被拦在解锁屏后面。
/// · 公开材料**是公开的** ⇒ 启动就载进本进程。为什么要它：这样"还没解锁"与"袋里根本没有它的盒子"
///   在报错时能分开说（前者让用户输口令，后者是应用级加密的存量库 ⇒ 说"不再支持"）。
///   坏材料只记一行，**真正的报错留给解锁那一步**（那里会 `Err` 出来，见 `carry_keyring`）。
pub fn startup_lock(c: &Connection) {
    if let Err(e) = crate::space_crypto::carry_keyring(c) {
        eprintln!("[keyring] 启动载入公开材料失败（解锁时会再报一次）：{e}");
    }
    let encrypted = match (
        crate::db::app_data_dir_ref(),
        crate::workspaces::active_workspace_id(c).ok(),
    ) {
        (Some(dir), Some(active)) => space_db_is_encrypted(&space_db_path(dir, &active)),
        // 拿不到活动空间（老库/异常形态）⇒ 退回"这个连接"的读数，别漏锁。
        _ => encryption_enabled(c),
    };
    if encrypted {
        LOCKED.store(true, Ordering::SeqCst);
    }
}

// ---- round-trip tests ----
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::sync;
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU32;

    /// ⚠️ **临时目录名必须"每次调用都不同"**，不能只靠 `进程号 + 毫秒`（2026-09-19 的 CI 教训）。
    ///
    /// 原来七个用例各自写 `shuy_xxx_{pid}_{now_ms()}`：**并发**下会撞名 —— cargo 的测试线程同时起跑时，
    /// 两个测试可以在**同一毫秒**里各建一个同名目录，而 `temp_ws()` 开头就 `remove_dir_all`，
    /// 于是 B 把 A 刚建好的 meta.db/space db 删掉、两边还共用同一个 meta.db
    /// ⇒ A 造出来的"已加密空间"状态被 B 读到，一串用例跟着红。
    ///
    /// 复现（当时留的探针，改前 **5/5 必红**）：8 个线程用 `Barrier` 同时调 `temp_ws()`，去重后不足 8 个目录。
    /// 这解释了 `rust-sm-crypto` 在 Linux CI 上红、而本机 macOS 连跑两遍全绿 —— 差别只在**线程调度**。
    /// 序号是 `Relaxed` 就够（只要唯一，不承担同步语义）。
    static TMP_SEQ: AtomicU32 = AtomicU32::new(0);
    fn uniq_tmp(tag: &str) -> PathBuf {
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("shuy_{tag}_{}_{}_{seq}", std::process::id(), db::now_ms()))
    }

    // LOCKED / 钥匙袋 / 会话主密钥 are process-wide statics. These tests set them, so they
    // must not run concurrently with each other (or the key_space_conn reopen in
    // header_sniff could read an overwritten keyring/master).
    //
    // ★ 2026-09-23：**同一把锁也给 `space_crypto::tests` 用**（那里同样改 `KEYRING` /
    // `SESSION_MASTER` 这两个进程级全局）—— 隔离跑绿、全量跑红就是这么来的
    // （cargo test 的线程会把这些测试交错）。⇒ 提到模块级 `pub(crate)`，两处共用一把。
    use super::SEC_LOCK;

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
    /// ★ 隐私边界**第 1 步（按空间）**：**开库路径**用的是这个空间**自己的**钥匙
    /// （钥匙袋里有它的盒子），而不是（已经删掉的）应用级 session key。
    ///
    /// ★ owner 第三轮拍板（2026-09-24）改写：原来 ① 靠"故意装一把错的应用级会话钥匙"来证明
    /// "真的是按空间取"，现在应用级那把**已经不存在了**，所以改成三条各自独立的断言：
    ///   ① 袋里有它 ⇒ 读得开；
    ///   ② 盒子里换**另一把**钥匙（同一个空间 id）⇒ 读不开 —— 证明 ① 用的确实是盒子里那把
    ///      （不是"SQLCipher 随便给什么钥都开"）；
    ///   ③ 把袋子清掉（＝**应用级加密**留下的存量库的形态）⇒ `key_space_conn` 必须 **Err**，
    ///      而且那句话要说清"应用级加密已不再支持" —— **没有"退回旧钥匙"这条兜底**。
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

        // ① 袋子里放它的盒子（**就是那把 space_key**）＋ 会话装上主密钥 ⇒ 读得开
        crate::space_crypto::set_space_box_for_test("sc-space-1", &space_key, "pw");
        {
            let c = Connection::open(&space_path).unwrap();
            key_space_conn(&c, &space_path).unwrap();
            let n: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 1, "袋里有它 ⇒ 按空间取钥匙读得开");
        }

        // ② 盒子里换**另一把**钥匙（同一个空间 id）⇒ 同一路径读不开
        //    ⇒ 证明 ① 用的确实是盒子里那把（而不是"SQLCipher 随便给什么钥都开"）。
        crate::space_crypto::set_space_box_for_test("sc-space-1", &[9u8; 32], "pw");
        {
            let c = Connection::open(&space_path).unwrap();
            let _ = key_space_conn(&c, &space_path);
            assert!(
                c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0)).is_err(),
                "盒子里的钥匙不是它那把 ⇒ 必须读不开"
            );
        }

        // ③ 袋子清掉（＝应用级加密的存量库）⇒ **响亮报错**，没有"退回旧钥匙"这条兜底
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
        {
            let c = Connection::open(&space_path).unwrap();
            let err = key_space_conn(&c, &space_path).unwrap_err();
            assert!(
                err.contains("应用级加密"),
                "存量库必须报「应用级加密已不再支持」，而不是含糊的「打不开」：{err}"
            );
            assert!(err.contains("旧钥匙"), "要说清不会退回旧钥匙：{err}");
            assert!(
                c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0)).is_err(),
                "报错之后连接也不能读开"
            );
        }

        // ④ 收尾：别把全局状态留给别的判据（袋子/主密钥全清）
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★ **wire 载荷按空间** —— 袋子里真有这个空间 ⇒ 用它**自己**的钥匙；明文空间 ⇒ 原样；
    /// 锁着 ⇒ **报错**（绝不静默放明文）；密文库而袋里没有它 ⇒ **报错**（应用级加密的存量库）。
    #[test]
    fn wire_payloads_use_the_space_key_and_never_silently_fall_back_to_plaintext() {
        let _g = SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(uniq_tmp("wirekey"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        // 一个真文件连接（内容不用加密，只为让 `c.path()` 指到 `spaces/sc-wire-1.db`）
        let space_path = space_db_path(&dir, "sc-wire-1");
        let c = Connection::open(&space_path).unwrap();

        // ① 没有袋子 ⇒ 明文空间 ⇒ 原样（不加密，也不报错）
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
        assert_eq!(encrypt_payload(&c, "abc").unwrap(), "abc", "没开加密 ⇒ 原样");

        // ② 袋子里有这个空间 ⇒ 用**它自己的**钥匙（不是任何"全局钥匙"—— 那种东西已经没了）
        let space_key = crate::keyring::random_space_key();
        crate::space_crypto::set_space_box_for_test("sc-wire-1", &space_key, "pw");

        let sealed = encrypt_payload(&c, "机密").unwrap();
        assert_ne!(sealed, "机密", "袋里的空间必须真的加密");
        assert_eq!(
            crate::crypto::decrypt_str(&sealed, &crypto::AppKeys::legacy_only(space_key)).unwrap(),
            "机密",
            "★ 用的是**空间自己的**钥匙"
        );
        assert!(
            crate::crypto::decrypt_str(&sealed, &crypto::AppKeys::legacy_only([9u8; 32])).is_err(),
            "不是别的钥匙（否则就是没按空间）"
        );
        assert_eq!(decrypt_payload(&c, &sealed).unwrap(), "机密", "收回来也要解得开");

        // ③ 锁着（主密钥卸下）⇒ **报错**，绝不静默放明文
        crate::space_crypto::set_session_master(None).unwrap();
        let err = match encrypt_payload(&c, "机密") {
            Ok(v) => panic!("锁着还把明文放行了：{v}"),
            Err(e) => e,
        };
        assert!(err.contains("未解锁"), "{err}");
        assert!(decrypt_payload(&c, &sealed).is_err(), "锁着也不许把密文当明文读");

        // ④ 收尾：清干净（别留给别的判据）
        crate::space_crypto::set_keyring_for_test(None);
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ **密文库 ＋ 袋里没有它的盒子 ⇒ 载荷路径响亮失败**（owner 第三轮拍板的承重判据）。
    ///
    /// 这是"应用级加密的存量库"唯一的形态，也是**最容易静默降级成明文**的地方：
    /// 旧代码在这里走"没有钥匙 ⇒ 原样放行"，于是密文空间的载荷会**明文上云**。
    /// 现在必须 `Err`，并且那句话要说清"应用级加密已不再支持 / 不会退回旧钥匙 / 不会把明文发出去"。
    #[test]
    fn a_ciphertext_space_without_a_box_is_refused_on_the_wire_never_plaintext() {
        let _g = SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(uniq_tmp("nobox"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        let space_path = space_db_path(&dir, "sc-nobox-1");
        // 造一个**密文**库（袋子里没有它的盒子 —— 这就是应用级加密留下的形状）
        {
            let c = Connection::open(&space_path).unwrap();
            crate::db::migrate(&c, "sc-nobox-1").unwrap();
        }
        convert_space_db(&space_path, true, Some(&[7u8; 32])).unwrap();
        assert!(space_db_is_encrypted(&space_path));

        // 极端一点：连袋子都载入了（但里面没有它）—— 也不许放行
        crate::space_crypto::set_space_box_for_test("另一个空间", &[3u8; 32], "pw");
        let c = Connection::open(&space_path).unwrap();

        let err = encrypt_payload(&c, "机密").unwrap_err();
        assert!(err.contains("应用级加密"), "要说清是应用级加密的存量库：{err}");
        assert!(err.contains("旧钥匙"), "要说清不会退回旧钥匙：{err}");
        assert!(err.contains("明文"), "要说清不会把明文发出去：{err}");
        // 收回来那一半同样不许"把密文当明文读"
        assert!(decrypt_payload(&c, "一段载荷").is_err(), "读这一半也不许放行");

        // 没有袋子（＝读老库那台机器）同样是响亮失败，而不是"当明文"
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
        assert!(encrypt_payload(&c, "机密").is_err(), "没有袋子也要报错，不许当明文");

        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★ 第 1 步（1b-2b）：**开关与启动闸门都看"这个空间自己"** ——
    /// `encryption_enabled` 不再只读应用级标志；启动闸门嗅的是那个空间的文件。
    #[test]
    fn per_space_switch_and_startup_gate_look_at_the_space_itself() {
        let _g = SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(uniq_tmp("perspace"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();

        // 一个**明文**空间（连接开着它 ⇒ `c.path()` 指到 spaces/sc-flag.db）
        let c = crate::db::open_space_conn_at("sc-flag", &dir).unwrap();
        let path = space_db_path(&dir, "sc-flag");

        // ① 明文 ＋ 袋里没有 ⇒ **不算加密**
        assert!(!encryption_enabled(&c), "什么都没开 ⇒ 不是加密空间");
        // ② 袋里有它（哪怕文件还是明文）⇒ 算加密（"这个空间本该是密的"）
        let boxed_key = crate::keyring::random_space_key();
        crate::space_crypto::set_space_box_for_test("sc-flag", &boxed_key, "pw");
        assert!(encryption_enabled(&c), "★ 袋里有它 ⇒ 这个空间是加密的（按空间）");
        crate::space_crypto::set_keyring_for_test(None);

        // ③ 启动闸门：明文 ⇒ 不用解锁；换成密文 ⇒ 没钥匙就要解锁；有钥匙（袋里有它 ＋ 会话解锁）就不用
        //    ⚠️ 转换前**必须让开这个空间的连接**（Windows 上文件被占用 ⇒ `os error 5`）
        drop(c);
        assert!(!startup_needs_unlock(&path), "明文库 ⇒ 直接能开");
        let key = crate::keyring::random_space_key();
        convert_space_db(&path, true, Some(&key)).unwrap();
        assert!(space_db_is_encrypted(&path));
        assert!(startup_needs_unlock(&path), "密文库 ＋ 没有钥匙 ⇒ 走解锁屏");
        crate::space_crypto::set_space_box_for_test("sc-flag", &key, "pw");
        assert!(!startup_needs_unlock(&path), "袋里有它 ＋ 会话已解锁 ⇒ 不用再拦");
        // ★ 反过来：袋子在、会话**没解锁**（主密钥卸下）⇒ 仍然要拦（而且不是静默地放它开）
        crate::space_crypto::set_session_master(None).unwrap();
        assert!(startup_needs_unlock(&path), "袋里有它但会话锁着 ⇒ 还是要拦");

        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
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
        // ★ owner 第三轮拍板之后：钥匙来自**这个空间自己的盒子**（id 从文件名 `enc.db` 反推）。
        crate::space_crypto::set_space_box_for_test("enc", &key, "pw");
        {
            let c = Connection::open(&encp).unwrap();
            key_space_conn(&c, &encp).unwrap();
            let n: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 1);
            let t: String = c.query_row("SELECT title FROM pages WHERE id='p1'", [], |r| r.get(0)).unwrap();
            assert_eq!(t, "hi");
        }
        // ♻️ 别把进程级全局留给别的判据（袋子/主密钥）
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();

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
        // `open_space_conn_at` 会用**这个空间自己的钥匙**给连接加钥 ⇒ 这里按真实解锁后的状态
        // 造出它（袋子里的盒子 ＋ 会话主密钥；应用级那条"会话密钥"已经删了）。
        crate::space_crypto::set_space_box_for_test("s1", &key, "pw");
        let err = crate::db::open_space_conn_at("s1", &dir).unwrap_err();
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
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
        crate::space_crypto::set_space_box_for_test("default", &key, "pw");
        assert!(space_db_is_encrypted(&space));
        // Reopen with the space key (the open-point path the app uses) and read rows.
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
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
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
        crate::space_crypto::set_space_box_for_test("default", &key, "pw");
        let c = Connection::open(&space).unwrap();
        key_space_conn(&c, &space).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        drop(c);
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Full closed loop at the Rust layer (★ owner 第三轮拍板后改写：**应用级那套已删**,
    // 现在走的是**按空间**那条真路): 按空间启用（现造随机钥匙＋盒子 ⇒ 只这一个空间变密文）
    // -> 模拟重启（会话锁定、主密钥不落盘）-> 解锁（**按袋子记的 KDF 参数**推主密钥，
    // **由解盒子回答口令对不对**）-> 读得到 -> 关掉（换回明文、扔掉盒子）。
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
                "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, theme TEXT, icon TEXT NOT NULL DEFAULT '', sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, encrypted INTEGER NOT NULL DEFAULT 0, cipher_format INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT ''); \
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
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();

        // ---- ENABLE（按空间）----
        crate::space_crypto::enable_space(&mut conn, &dir, "default", Some("pass1234")).unwrap();
        assert!(space_db_is_encrypted(&space_path));
        assert!(encryption_enabled(&conn));
        assert!(crate::space_crypto::keyring().unwrap().has("default"), "应当装了盒子");
        let marker: i64 = conn.query_row("SELECT encrypted FROM meta.workspaces WHERE id='default'", [], |r| r.get(0)).unwrap();
        assert_eq!(marker, 1);
        // The active space is reopened keyed, so the main conn can read it.
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // Simulate the app restart: drop the enable-time connection entirely (a real
        // restart closes every handle to the space before re-opening locked).
        drop(conn);

        // ---- SIMULATE RESTART (session locked, **主密钥不落盘**) ----
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
        LOCKED.store(true, Ordering::SeqCst);
        // A fresh connection to the encrypted space WITHOUT the key cannot read it.
        {
            let fresh = Connection::open(&space_path).unwrap();
            assert!(fresh.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0)).is_err());
        }
        // Wrong passphrase fails — ★ 而且**由解盒子回答**，不是旧文案「口令不正确」
        //（那句来自已被删掉的哨兵）。锁定态主连接是内存库 ＋ meta（与 db::init 的启动闸门同一形状）。
        let mut bad = Connection::open_in_memory().unwrap();
        bad.execute_batch(&format!("ATTACH DATABASE '{meta_sql}' AS meta KEY \"\"")).unwrap();
        let bad_err = unlock_encryption_impl(&mut bad, &dir, "wrong-pass".to_string()).unwrap_err();
        assert!(bad_err.contains("打不开"), "错口令要说清是盒子打不开：{bad_err}");
        assert!(
            !bad_err.contains("口令不正确"),
            "旧文案（来自已删的哨兵）不许再出现：{bad_err}"
        );

        // ---- UNLOCK（全新锁定态主连接 -> 按盒子重开这个空间）----
        let mut locked = Connection::open_in_memory().unwrap();
        locked.execute_batch(&format!("ATTACH DATABASE '{meta_sql}' AS meta KEY \"\"")).unwrap();
        unlock_encryption_impl(&mut locked, &dir, "pass1234".to_string()).unwrap();
        assert_eq!(LOCKED.load(Ordering::SeqCst), false);
        let n: i64 = locked.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // User data is lossless across the encrypt->unlock round trip.
        let ws_name: String = locked.query_row("SELECT name FROM workspaces WHERE id='default'", [], |r| r.get(0)).unwrap();
        assert_eq!(ws_name, "默认空间");
        let title: String = locked.query_row("SELECT title FROM pages WHERE id='p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(title, "hello");

        // ---- DISABLE（按空间换回明文）----
        crate::space_crypto::disable_space(&mut locked, &dir, "default").unwrap();
        assert!(!space_db_is_encrypted(&space_path));
        let n: i64 = locked.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        assert!(!encryption_enabled(&locked));
        assert!(!crate::space_crypto::keyring().unwrap().has("default"), "盒子要扔掉");
        let title2: String = locked.query_row("SELECT title FROM pages WHERE id='p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(title2, "hello");
        drop(locked);

        LOCKED.store(false, Ordering::SeqCst);
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ **老 schema 的空间库也要能开加密**（owner 2026-09-24 现场抓到的真 bug）。
    ///
    /// 现场：`开启加密失败：拷贝表 workspaces 失败: table main.workspaces has 9 columns but 8
    /// values were supplied`。根因：`convert_space_db` 的逐表拷贝原来写的是 `SELECT *`，
    /// 而**源库是老 schema**（这个空间文件很久没被打开过 ⇒ 还缺 09-23 才加的那一列），
    /// 目标是 `migrate()` 刚建出来的当前 schema ⇒ 两边列数不同就当场失败 ——
    /// 而这是**现在唯一的加密开关**，等于那个空间加不了密。
    ///
    /// ⚠️ 以前判据全绿，因为夹具都是"刚 migrate 过的新库"；**又一类只有老库才会中的缺陷**
    /// （与 `meta.workspaces.kind` 那次同一个教训，所以这条夹具**刻意手写老表结构**）。
    #[test]
    fn convert_space_db_tolerates_an_old_schema_space_file() {
        let _g = SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(uniq_tmp("oldschema"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let space = dir.join("old-space.db");
        // 手工造"老 schema"：`workspaces` 只有最早那 4 列（不含 kind 等后加的列），
        // `pages` 也停在当时的形态（没有 db_rule / sync_seq / dirty / text_stale）。
        {
            let c = Connection::open(&space).unwrap();
            c.execute_batch(
                "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, \
                 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); \
                 CREATE TABLE pages (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, parent_id TEXT, \
                 title TEXT NOT NULL DEFAULT '', content_json TEXT NOT NULL DEFAULT '{}', \
                 content_text TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'page', \
                 sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, \
                 updated_at INTEGER NOT NULL, deleted_at INTEGER);",
            )
            .unwrap();
            c.execute_batch(
                "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('old-space','老空间',1,1);\
                 INSERT INTO pages (id, workspace_id, title, content_text, created_at, updated_at) \
                 VALUES ('p1','old-space','hello','hello',1,1);",
            )
            .unwrap();
        }

        let key = crypto::derive_key("hunter2", &crypto::random_salt()).unwrap();
        // ★ 老库 ⇒ 也必须转得动（改前这里报 "has 9 columns but 8 values were supplied"）
        convert_space_db(&space, true, Some(&key)).unwrap();
        assert!(space_db_is_encrypted(&space), "转换后应当是密文");

        // 数据没丢，而且**新列取目标默认值**（不是被"补"成源里的东西）
        crate::space_crypto::set_space_box_for_test("old-space", &key, "pw");
        {
            let c = Connection::open(&space).unwrap();
            key_space_conn(&c, &space).unwrap();
            let title: String = c.query_row("SELECT title FROM pages WHERE id='p1'", [], |r| r.get(0)).unwrap();
            assert_eq!(title, "hello", "★ 老库转换后数据没丢");
            let name: String = c.query_row("SELECT name FROM workspaces WHERE id='old-space'", [], |r| r.get(0)).unwrap();
            assert_eq!(name, "老空间");
            // 目标 schema 的后加列都在（老库缺的那一列由迁移补上）
            let kind: String = c.query_row("SELECT COALESCE(kind,'') FROM workspaces WHERE id='old-space'", [], |r| r.get(0)).unwrap();
            assert_eq!(kind, "", "老库缺的列取默认值（空串＝未分类）");
        }
        // 也能转回来（两个方向同一段拷贝代码）
        convert_space_db(&space, false, Some(&key)).unwrap();
        assert!(!space_db_is_encrypted(&space));
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
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
        crate::space_crypto::set_space_box_for_test("default", &key, "pw");
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
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
        // enable（按空间）-> encrypted + keyed
        crate::space_crypto::enable_space(&mut conn, &dir, "default", Some("pass1234")).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // lock -> connection becomes in-memory+meta, space NOT readable
        lock_encryption_impl(&mut conn, &dir).unwrap();
        assert_eq!(LOCKED.load(Ordering::SeqCst), true);
        assert!(conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0)).is_err());
        // meta is still accessible (app shell) —— ★ 而且**公开材料**也读得到：
        // 这正是"锁定态还能说清自己为什么打不开"的前提（旧版这里看的是应用级标志，已删）。
        assert!(
            crate::space_crypto::stored_material(&conn).unwrap().is_some(),
            "锁定时 meta 里的公开材料仍须可读（界面要靠它说清状态）"
        );
        // ★ `enabled` 的读数也不再依赖那个应用级标志：锁定时主连接是内存库 ⇒ 看**活动空间自己**
        //   （`encryption_status` 就是这么算的，界面靠它决定要不要出解锁屏）。
        assert!(
            space_db_is_encrypted(&space_path),
            "库文件是密文 ⇒ 状态读数应当说「这个空间已加密」"
        );
        // unlock -> reopens keyed space, readable again
        unlock_encryption_impl(&mut conn, &dir, "pass1234".to_string()).unwrap();
        assert_eq!(LOCKED.load(Ordering::SeqCst), false);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        drop(conn);
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 造"这个空间按钥匙袋加密"的会话态（老助手 `enable_meta` 的**按空间**替代）：
    /// 袋子里放**这个空间自己的**盒子 ＋ 会话装上主密钥。
    ///
    /// ⚠️ owner 第三轮拍板之后，"已解锁的加密空间"**只有这一种造法** —— 应用级那把钥匙、
    /// 那个应用级标志、以及那个哨兵都已经删掉了，任何"再造一条应用级状态"的写法都是**假的**。
    fn enable_space_meta(c: &Connection, space_id: &str, pass: &str) -> (crypto::AppKeys, [u8; 32]) {
        let key = crypto::random_32();
        let master = crate::space_crypto::set_space_box_for_test(space_id, &key, pass);
        // 公开材料也写进 meta（真机那条路是 `store_keyring`）—— 让夹具更接近真实形态。
        let kr = crate::space_crypto::keyring().unwrap();
        sync::set_meta_state(c, crate::space_crypto::META_KEYRING, &kr.to_json().unwrap()).unwrap();
        LOCKED.store(false, Ordering::SeqCst);
        (master, key)
    }

    #[test]
    fn payload_roundtrip_when_enabled() {
        let _g = SEC_LOCK.lock().unwrap();
        let (_t, c) = temp_ws();
        // ★ 「按空间」的形态：袋子里的盒子 ＋ 会话主密钥（`temp_ws()` 的连接开的正是 `default.db`）
        let (_master, space_key) = enable_space_meta(&c, "default", "supersecret");
        let plain = r#"{"id":"p1","content_json":"hello","content_text":"hi"}"#;
        let enc = encrypt_payload(&c, plain).unwrap();
        assert_ne!(enc, plain);
        let dec = decrypt_payload(&c, &enc).unwrap();
        assert_eq!(dec, plain);
        // 写出去的确实是**这个空间自己的**钥匙（而不是任何全局钥匙）
        assert_eq!(
            crypto::decrypt_str(&enc, &crypto::AppKeys::legacy_only(space_key)).unwrap(),
            plain
        );
        // key is only in session, never persisted anywhere.
        // ★ 既然"应用级加密"那套（`ENC_ENABLED`/`ENC_SALT`/`ENC_VERIFY`/`ENC_KEY` 四个 meta 键）
        //   已经整条删掉，这里改成直接钉**更强**的那件事：**裸空间钥匙不许出现在任何落盘的地方**
        //   （meta 里的公开材料只该有盒子；base `sync_state` 里什么都不该有）。
        let key_hex = crypto::key_hex(&space_key);
        let material =
            sync::get_meta_state(&c, crate::space_crypto::META_KEYRING).unwrap_or_default();
        assert!(!material.contains(&key_hex), "meta 的公开材料里出现了裸空间钥匙");
        let leaked: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM sync_state WHERE value LIKE ?1",
                [format!("%{key_hex}%")],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(leaked, 0, "base sync_state 里出现了裸空间钥匙");
        // ♻️ 清掉进程级全局
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
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
        enable_space_meta(&c, "default", "supersecret");
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
    fn lock_gates_key_and_sync() {
        let _g = SEC_LOCK.lock().unwrap();
        let (_t, c) = temp_ws();
        // ★ 「按空间」的形态（原来是 `enable_meta` 造的那套应用级状态）
        enable_space_meta(&c, "default", "supersecret");
        assert!(key_if_enabled(&c).is_some());
        assert!(sync_gate(&c).is_ok());

        LOCKED.store(true, Ordering::SeqCst);
        assert!(key_if_enabled(&c).is_none());
        assert!(sync_gate(&c).is_err());

        LOCKED.store(false, Ordering::SeqCst);
        assert!(key_if_enabled(&c).is_some());
        assert!(sync_gate(&c).is_ok());
        // ♻️ 清掉进程级全局
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
    }

    // ── P1：国密构建下的路径覆盖（§7 验收：附件 / 导出包 / 同步载荷逐条勾）──
    //
    // ⚠️ 这一组**只在 `--features sm-crypto` 下编**。它盯的是"路径覆盖"，不是算法本身
    //    （算法由 `crypto_sm` 的 GM/T 向量用例与对拍门禁盯）。
    //
    // ★★ owner 第三轮拍板（2026-09-24）**改写** —— 这一条原来盯的三条路都走"应用级派生出来的
    //    那一对 SM 密钥"，而那套已经删了。现在按**真实存在**的两条密钥来源分别钉：
    //      (a) **口令派生的主密钥**（钥匙袋那条）⇒ 在国密构建里**确实是 v2**：盒子就是用它包的
    //          ⇒ 所以"国密覆盖"这件事现在落在**盒子**上（下面 ③ 钉它，含双读）；
    //      (b) **空间钥匙**是随机 32 字节 ⇒ 没有"口令 ⇒ SM 那一对"的派生链 ⇒ 这个空间的
    //          **附件/载荷一律 v1（XChaCha20）**，这是**刻意**的（见 `space_app_keys_for_path` 注释），
    //          不是漏做 —— 下面 ② 把这条事实钉死，免得下一个人以为它是 bug。
    #[cfg(feature = "sm-crypto")]
    #[test]
    fn national_crypto_covers_the_paths_it_still_has_and_the_space_path_stays_v1() {
        let _g = SEC_LOCK.lock().unwrap();
        let (_t, c) = temp_ws();
        // 用**真**派生（不是 legacy_only）⇒ 手里有国密那一对密钥，写出去的就是 v2。
        let salt = crypto::random_salt();
        let keys = crypto::derive_app_keys("supersecret", &salt).unwrap();
        assert!(keys.sm.is_some(), "国密构建的派生结果里必须有国密那一对");

        // ① 附件静置（含同步上传/下载共用的那条入口）：拿**真派生**的钥匙 ⇒ 必须是 v2
        let att = b"attachment bytes for the national-crypto path";
        let enc = encrypt_attachment_bytes(Some(&keys), att).unwrap();
        assert_eq!(&enc[..2], &[crypto::MAGIC, crypto::VERSION_SM4], "附件没写成国密");
        assert_eq!(decrypt_attachment_bytes(Some(&keys), &enc).unwrap(), att);

        // ② **空间级**路径（同步载荷）刻意是 v1：空间钥匙是随机的 32 字节，没有 SM 派生链。
        let space_key = crate::keyring::random_space_key();
        crate::space_crypto::set_space_box_for_test("default", &space_key, "supersecret");
        LOCKED.store(false, Ordering::SeqCst);
        let payload = r#"{"id":"p1","content_text":"空间级载荷"}"#;
        let wire = encrypt_payload(&c, payload).unwrap();
        let wire_bytes = crypto::b64_decode(&wire).unwrap();
        assert_eq!(
            &wire_bytes[..2],
            &[crypto::MAGIC, crypto::VERSION_XCHACHA],
            "空间钥匙是随机 32 字节 ⇒ 这一条按设计就是 v1（不是漏做国密；要改它得先给空间级定 SM 派生）"
        );
        assert_eq!(decrypt_payload(&c, &wire).unwrap(), payload);
        assert_eq!(
            crypto::decrypt(&wire_bytes, &crypto::AppKeys::legacy_only(space_key)).unwrap(),
            payload.as_bytes(),
            "空间载荷必须能被**空间钥匙**解开（字符串/二进制两条路径同一套编码）"
        );

        // ③ **口令派生的主密钥在国密构建里走 v2**，而且**双读**成立：
        //    老（v1）盒子在国密构建里也解得开 —— 老袋子升级后不会打不开（§4 第 6 条）。
        let mut modern = crate::keyring::Keyring::new();
        let master = modern.kdf.derive_master("supersecret").unwrap();
        modern.wrap(&master, "盒-a", &crate::keyring::random_space_key()).unwrap();
        let v2_box = hex::decode(&modern.spaces["盒-a"].box_hex).unwrap();
        assert_eq!(
            &v2_box[..2],
            &[crypto::MAGIC, crypto::VERSION_SM4],
            "国密构建里包出来的盒子应当是 v2（盒子用的是口令派生的主密钥）"
        );
        // 同一个空间钥匙，用**老构建那种 v1 盒子**包起来 ⇒ 国密构建仍要解得开
        let mut legacy = crate::keyring::Keyring::new();
        legacy
            .wrap(&crypto::AppKeys::legacy_only(master.legacy), "盒-a", &space_key)
            .unwrap();
        let v1_box = hex::decode(&legacy.spaces["盒-a"].box_hex).unwrap();
        assert_eq!(
            &v1_box[..2],
            &[crypto::MAGIC, crypto::VERSION_XCHACHA],
            "这一份夹具本身应当是 v1（否则下面那条双读就没在判它）"
        );
        assert_eq!(
            legacy.unwrap_key(&master, "盒-a").unwrap(),
            space_key,
            "国密构建解不开 v1 盒子 ⇒ 老袋子升级后打不开（双读必须成立）"
        );

        // ♻️ 清掉进程级全局
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
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

    /// ★★ **生成"老库"夹具**（默认不跑；`--ignored` 手动跑；owner 2026-09-24 拍板）。
    ///
    /// 为什么要它：连着三个 bug 都是"**只有老库才会中**"（`meta.workspaces.kind` 漏 ALTER、
    /// 空间 schema 的 kind 列、`convert_space_db` 的 `SELECT *` 拷贝），而判据夹具一律是
    /// "刚 migrate 过的新库" ⇒ **全绿也抓不到**。⇒ 把两份"老库"**钉成仓库里的字节**
    /// （同 `gen_backend_fixture` 那一族的做法），让
    /// `legacy_databases_survive_the_real_migrations` 每次都拿真文件过一遍真实迁移路径。
    ///
    /// ⚠️ 夹具**刻意取最早的列集**（meta 的 workspaces 只有 4 列、空间库的 pages 停在 11 列），
    /// 也就是比任何真实历史文件都更老 —— 判据要的正是"迁移必须把缺的列**一个不落**地补上"。
    /// ⚠️ 重生成前先想清楚：这两份文件是**判据的输入**，改了它们等于换了判据。
    #[test]
    #[ignore = "夹具生成器（手动跑；须确认 DDL 就是想要的\"老库\"形状）"]
    fn gen_legacy_db_fixtures() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
        // ① 老 meta.db：workspaces 只有最早的 4 列（kind/encrypted/cipher_format/theme/… 都没有）
        let meta = dir.join("legacy-meta.db");
        let _ = std::fs::remove_file(&meta);
        {
            let c = Connection::open(&meta).unwrap();
            c.execute_batch(
                "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, \
                 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); \
                 CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); \
                 INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('legacy-a', '老空间 A', 1, 1); \
                 INSERT INTO sync_state (key, value) VALUES ('active_workspace', 'legacy-a'); \
                 INSERT INTO sync_state (key, value) VALUES ('device_id', 'legacy-device');",
            )
            .unwrap();
            c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        }
        // ② 老空间库：workspaces 4 列、pages 停在当时的形态（没有 db_rule/sync_seq/dirty/text_stale）
        let space = dir.join("legacy-space.db");
        let _ = std::fs::remove_file(&space);
        {
            let c = Connection::open(&space).unwrap();
            c.execute_batch(
                "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, \
                 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); \
                 CREATE TABLE pages (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, parent_id TEXT, \
                 title TEXT NOT NULL DEFAULT '', content_json TEXT NOT NULL DEFAULT '{}', \
                 content_text TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'page', \
                 sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, \
                 updated_at INTEGER NOT NULL, deleted_at INTEGER); \
                 INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('legacy-a', '老空间 A', 1, 1); \
                 INSERT INTO pages (id, workspace_id, title, content_json, content_text, created_at, updated_at) \
                 VALUES ('legacy-p1', 'legacy-a', '老页面', '{\"root\":{}}', '老页面正文', 1, 1);",
            )
            .unwrap();
            c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        }
        for (p, min) in [(&meta, "legacy-meta.db"), (&space, "legacy-space.db")] {
            let n = std::fs::metadata(p).unwrap().len();
            println!("老库夹具已生成：{}（{n} 字节）", p.display());
            assert!(n > 2048, "{min} 太小，像个空库：{n} 字节");
        }
    }

    /// ★★ **老库过一遍真实迁移路径之后，必须处处与"新库"一致**（通用兜底，owner 2026-09-24 拍板）。
    ///
    /// 判据的形状（**故意的通用写法**：不是逐个断言"某列在不在"，而是**逐表逐列对比**）：
    ///   ① 把 `tests/legacy-meta.db` / `tests/legacy-space.db` 复制成一个真实 app 目录；
    ///   ② 走**真实入口** `db::open_meta_conn_at` / `db::open_space_conn_at`（它们会跑完整迁移）；
    ///   ③ 与"全新库迁移后"的 schema **逐表逐列**对比：**新库有的列，老库迁移后必须都有**
    ///      ⇒ 以后任何一次"加了列却忘了幂等 ALTER"都会在这里当场红；
    ///   ④ 再验几件**功能面**：老数据还在、分类能写、开/关加密转得动（老 schema 的拷贝路径）。
    ///
    /// 这正是前三个 bug 缺的那道网：`meta.workspaces.kind` 漏 ALTER（③ 会红）、
    /// 空间 schema 的 kind 列（③ 对空间库同样查）、`convert_space_db` 的 `SELECT *`（④ 会红）。
    #[test]
    fn legacy_databases_survive_the_real_migrations() {
        let _g = SEC_LOCK.lock().unwrap();

        // ---- ① 老库落地成一个真实 app 目录 ----
        let old = std::env::temp_dir().join(uniq_tmp("legacy"));
        let _ = std::fs::remove_dir_all(&old);
        std::fs::create_dir_all(crate::db::spaces_dir(&old)).unwrap();
        std::fs::write(
            crate::db::meta_path(&old),
            include_bytes!("../tests/legacy-meta.db"),
        )
        .unwrap();
        let old_space_path = space_db_path(&old, "legacy-a");
        std::fs::write(&old_space_path, include_bytes!("../tests/legacy-space.db")).unwrap();

        // ---- ② 走真实入口（＝跑完整迁移）----
        let old_meta = crate::db::open_meta_conn_at(&old).unwrap();
        let old_space = crate::db::open_space_conn_at("legacy-a", &old).unwrap();

        // ---- ③ 通用兜底：与"全新库"逐表逐列对比 ----
        let fresh = std::env::temp_dir().join(uniq_tmp("fresh"));
        let _ = std::fs::remove_dir_all(&fresh);
        std::fs::create_dir_all(crate::db::spaces_dir(&fresh)).unwrap();
        let fresh_meta = crate::db::open_meta_conn_at(&fresh).unwrap();
        let fresh_space = crate::db::open_space_conn_at("legacy-a", &fresh).unwrap();

        for (what, fresh_c, old_c) in [
            ("meta.db", &fresh_meta, &old_meta),
            ("spaces/legacy-a.db", &fresh_space, &old_space),
        ] {
            let fresh_tables = schema_tables(fresh_c);
            assert!(!fresh_tables.is_empty(), "{what} 的新库里一个表都没有？");
            for t in &fresh_tables {
                let want = table_columns(fresh_c, &format!("\"{t}\"")).unwrap();
                let got = table_columns(old_c, &format!("\"{t}\"")).unwrap_or_default();
                let missing: Vec<&String> =
                    want.iter().filter(|c| !got.iter().any(|g| g.eq_ignore_ascii_case(c))).collect();
                assert!(
                    missing.is_empty(),
                    "★ {what} 的表 {t} 迁移后缺列 {missing:?} —— 多半是「加了列却忘了幂等 ALTER」\
                     （新库有、老库没有；这正是连着三次踩的那一类）。新库列={want:?} 老库列={got:?}"
                );
            }
        }

        // ---- ④ 功能面 ----
        // (a) 老数据还在
        let title: String = old_space
            .query_row("SELECT title FROM pages WHERE id = 'legacy-p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "老页面", "迁移不能动数据");
        let ws_name: String = old_meta
            .query_row("SELECT name FROM workspaces WHERE id = 'legacy-a'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ws_name, "老空间 A");
        // (b) 分类写得进（`meta.workspaces.kind` 那条漏 ALTER 就是死在这一步）。
        //     ⚠️ 用**空间连接**（它 ATTACH 了 meta ⇒ `meta.workspaces` 才是那张表）；
        //     `old_meta` 是 meta-only 连接，那里 `meta` 这个 schema 并不存在。
        assert_eq!(
            crate::space_crypto::space_kind(&old_space, "legacy-a"),
            crate::space_crypto::SpaceKind::Unknown,
            "老库补的列取默认值＝未分类（行为一字不变）"
        );
        crate::space_crypto::set_space_kind(&old_space, "legacy-a", crate::space_crypto::SpaceKind::Personal)
            .unwrap();
        assert_eq!(
            crate::space_crypto::space_kind(&old_space, "legacy-a"),
            crate::space_crypto::SpaceKind::Personal
        );
        // (c) 开/关加密转得动（`SELECT *` 那条拷贝就是死在这一步）。
        //     ⚠️ 转换前必须**让开这个空间的连接**（Windows 上文件被占用 ⇒ `os error 5`）。
        drop(old_space);
        let key = crypto::derive_key("hunter2", &crypto::random_salt()).unwrap();
        convert_space_db(&old_space_path, true, Some(&key)).unwrap();
        assert!(space_db_is_encrypted(&old_space_path));
        crate::space_crypto::set_space_box_for_test("legacy-a", &key, "pw");
        {
            let c = Connection::open(&old_space_path).unwrap();
            key_space_conn(&c, &old_space_path).unwrap();
            let n: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 1, "老库加密之后数据仍读得到");
        }
        convert_space_db(&old_space_path, false, Some(&key)).unwrap();
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();

        // `old_space` 已经在上面（转换之前）drop 掉了 —— 这里只剩其余三个。
        drop(old_meta);
        drop(fresh_space);
        drop(fresh_meta);
        let _ = std::fs::remove_dir_all(&old);
        let _ = std::fs::remove_dir_all(&fresh);
    }

    /// 一个库里的**真实用户表**（排除 sqlite_* 与 FTS5 的虚拟表/影子表族）。
    fn schema_tables(c: &Connection) -> Vec<String> {
        let mut stmt = c
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' \
                 AND name NOT LIKE 'page_fts%' AND name NOT LIKE 'chunk_fts%' ORDER BY name",
            )
            .unwrap();
        let rows = stmt.query_map([], |r| r.get(0)).unwrap();
        rows.map(|r| r.unwrap()).collect()
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
