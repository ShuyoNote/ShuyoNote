use argon2::Argon2;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand_core::OsRng;
use rand_core::RngCore;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;

// ── 密文格式版本化（P0，2026-09-19；方案 §0-A）────────────────────────────────────────
//
// 格式：`magic(1) || version(1) || nonce(24) || ciphertext`。
//
// 为什么现在就要它（不是"以后再说"）：P2/P3 把 KDF/HMAC 换成国密系之后，**旧库连页 HMAC 都验不过**
// —— 那时候如果没有"这段密文是哪一版"的显式标记，能做的只有"试一遍、失败就猜"，而猜错的代价是
// **用户打不开自己的数据**。所以先把标记加上，算法换不换都不影响。
//
// 两条铁律：
//   1. **字符串路径（base64）与二进制路径（附件/导出/同步载荷）共用同一套编码** ——
//      只给文本加前缀等于两套格式，二进制那条以后还得再设一套；
//   2. **无头的老数据永远按 v0 处理，且必须永远可读**（见 `decrypt` 里的回退分支）。
pub const MAGIC: u8 = 0x53; // 'S'
/// 版本 1 = **XChaCha20-Poly1305**（P0 起新数据的默认格式）。
pub const VERSION_XCHACHA: u8 = 1;
/// 版本 2 = **国密 SM4-CBC ＋ HMAC-SM3（EtM）**。⚠️ 只有 `--features sm-crypto` 才**写得出来**；
/// 没有那个 feature 的构建读到它必须给"请升级"的**可操作**错误（§0-C），而不是"数据损坏"。
pub const VERSION_SM4: u8 = 2;
/// 本构建**写新数据**用的版本。
///
/// 分派依据不是运行时开关，而是 §0-E 的编译期 feature：默认包继续写 v1（**字节层面与 P0 完全一致**，
/// 默认构建因此不承担任何国密构建链风险），`--features sm-crypto` 的国密版写 v2。
#[cfg(feature = "sm-crypto")]
pub const CURRENT_FORMAT: u8 = VERSION_SM4;
#[cfg(not(feature = "sm-crypto"))]
pub const CURRENT_FORMAT: u8 = VERSION_XCHACHA;
/// 头部长度（magic + version）。
pub const HEADER_LEN: usize = 2;

/// `sync_state` keys for the opt-in per-workspace encryption.
pub const ENC_ENABLED: &str = "encryption_enabled";
pub const ENC_SALT: &str = "encryption_salt";
/// Sentinel ciphertext used to verify the passphrase on unlock (no key persisted at rest).
pub const ENC_VERIFY: &str = "encryption_verify";
// `ENC_KEY` 只在测试里用来断言「密钥未落盘」（security.rs 单测）；非测试构建未被引用，属预期。
#[allow(dead_code)]
pub const ENC_KEY: &str = "encryption_key";

pub fn b64_encode(data: &[u8]) -> String {
    B64.encode(data)
}
pub fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    B64.decode(s).map_err(|e| e.to_string())
}

// ── 应用层密钥材料（P1，2026-09-19）─────────────────────────────────────────────────
//
// 为什么不是裸 `[u8; 32]`：国密那一套（§0-B）要求**两把独立密钥**（加密 / MAC），
// 而 v0/v1 的 XChaCha20 只要一把。把"这个会话手里有哪些密钥"收成一个类型，
// 好处是**版本分派有了依据**：写新数据用哪个格式，看的就是"手里有没有国密密钥"。
//
// ⚠️ `legacy` 那 32 字节**同时**是 SQLCipher 的原始密钥（`PRAGMA key = "x'<hex>'"`），
// 所以它必须**逐字节不变**（旧库全靠它打开）。守着这一点的是两条判据：
//   · `tests::legacy_v0_golden_fixture_still_decrypts` —— 现算的 key 必须等于夹具里记的 keyHex；
//   · `security::tests::national_crypto_covers_all_three_paths_and_keeps_the_library_key_unchanged`
//     —— 国密构建下 `PRAGMA key` 用的仍然必须是 legacy，而不是国密那一对。

/// 国密（v2）用的那一对独立密钥。切分口径见 `crypto_sm` 文件头（§0.1）。
///
/// ⚠️ **刻意不派生 `Debug`/`PartialEq`**：这是原始密钥材料，`{:?}` 一下就会把密钥写进日志、
/// panic 信息、错误上报里（那种泄漏一旦发生就收不回来）。要比对就在测试里比字段。
// 默认构建（不带国密 feature）里这两个字段**构造得出来但没人读** —— 刻意如此：
// `derive_sm_keys` 在那种构建下恒返回 `None`，而类型形状保持一致能让上层代码不分叉。
#[cfg_attr(not(feature = "sm-crypto"), allow(dead_code))]
#[derive(Clone, Copy)]
pub struct SmKeys {
    /// KDF 输出的前 32 字节；SM4 实际只用其中前 16 字节（SM4 是 128 位密钥）。
    pub enc: [u8; 32],
    /// KDF 输出的后 32 字节（HMAC-SM3）。
    pub mac: [u8; 32],
}

/// 一次会话手里的应用层密钥材料（同样**不派生 `Debug`**，理由见 `SmKeys`）。
#[cfg_attr(not(feature = "sm-crypto"), allow(dead_code))]
#[derive(Clone, Copy)]
pub struct AppKeys {
    /// v0/v1 的 XChaCha20 密钥；也是 SQLCipher 的原始密钥。
    pub legacy: [u8; 32],
    /// 国密那一对；**默认构建恒为 `None`**（不编国密代码 ⇒ 一律写 v1）。
    pub sm: Option<SmKeys>,
}

impl AppKeys {
    /// 只有老密钥（默认构建，或测试里只关心 v0/v1 路径时用）。写出来的是 v1。
    pub fn legacy_only(legacy: [u8; 32]) -> Self {
        Self { legacy, sm: None }
    }
}

impl From<[u8; 32]> for AppKeys {
    fn from(k: [u8; 32]) -> Self {
        Self::legacy_only(k)
    }
}

/// Encrypt a UTF-8 string; result is base64 of the same blob the binary path produces.
pub fn encrypt_str(s: &str, keys: &AppKeys) -> Result<String, String> {
    Ok(B64.encode(encrypt(s.as_bytes(), keys)?))
}
/// Decrypt a base64 blob produced by [`encrypt_str`].
pub fn decrypt_str(s: &str, keys: &AppKeys) -> Result<String, String> {
    let bytes = b64_decode(s)?;
    let plain = decrypt(&bytes, keys)?;
    String::from_utf8(plain).map_err(|e| format!("解密结果非 UTF-8: {e}"))
}

/// Derive a 256-bit key from a passphrase + salt (Argon2id, default params).
///
/// ⚠️ **这个函数的口径不许动**：它的输出就是 SQLCipher 的原始密钥，改了它 = 既有加密库全部打不开。
/// 国密的应用层 KDF 是**另一条**（`crypto_sm::derive_keys`，PBKDF2-HMAC-SM3），见 `derive_app_keys`。
pub fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| format!("密钥派生失败: {e}"))?;
    Ok(key)
}

/// 由口令 ＋ 盐派生**整套**会话密钥材料（`legacy` ＋ 国密那一对）。
///
/// 两条 KDF 并存是**刻意的**，不是漏改：
///   · `legacy` = Argon2id —— 它同时是 SQLCipher 的库级原始密钥，换掉 = 旧库全打不开；
///     库级 KDF 换 PBKDF2-HMAC-SM3 是 **P2-P3**（Tongsuo provider 那条线）的事，那时是由
///     SQLCipher 自己从 `PRAGMA key` 的值再派一次，届时才有"外层要不要换"这个问题；
///   · `sm` = PBKDF2-HMAC-SM3（§0.1 钉死的应用层 KDF），只喂应用层 AEAD。
/// 两条都用同一个 16 字节盐：域不同（Argon2id / PBKDF2-HMAC-SM3），复用不引入额外风险，
/// 而 §0.1 只钉了"盐 16 字节"，没钉"两个 KDF 必须用不同的盐"。
pub fn derive_app_keys(passphrase: &str, salt: &[u8]) -> Result<AppKeys, String> {
    let legacy = derive_key(passphrase, salt)?;
    Ok(AppKeys { legacy, sm: derive_sm_keys(passphrase, salt) })
}

#[cfg(feature = "sm-crypto")]
fn derive_sm_keys(passphrase: &str, salt: &[u8]) -> Option<SmKeys> {
    let (enc, mac) = crate::crypto_sm::derive_keys(passphrase, salt);
    Some(SmKeys { enc, mac })
}
#[cfg(not(feature = "sm-crypto"))]
fn derive_sm_keys(_passphrase: &str, _salt: &[u8]) -> Option<SmKeys> {
    None
}

/// 这段密钥材料**写新数据**时会用哪个版本。
///
/// "国密开关"**不是**运行时能随便翻的：默认构建里国密代码整个不存在（§0-E），
/// 所以这里看的是"本构建有没有国密实现（`CURRENT_FORMAT`）＋ 这次会话手里有没有那对密钥"。
pub fn active_format(keys: &AppKeys) -> u8 {
    #[cfg(feature = "sm-crypto")]
    if keys.sm.is_some() {
        return VERSION_SM4;
    }
    #[cfg(not(feature = "sm-crypto"))]
    let _ = keys;
    VERSION_XCHACHA
}

/// 只读**密文头**、不解密、不需要密钥 —— 用来在"动手之前"判断这段数据是哪一版。
///
/// §0-C 的落地点就是它：老端要在**整空间/整批同步之前**明确拒绝，而不是逐条解密失败。
/// 返回 `None` = "看着不像我们写的密文"（无头老数据 v0、或根本不是密文：明文 JSON、乱码……）。
/// ⚠️ 注意 `None` **不等于**"不支持"：无头老数据永远可读（见 `decrypt` 的回退分支）。
pub fn peek_format(data: &[u8]) -> Option<u8> {
    if data.len() >= HEADER_LEN && data[0] == MAGIC {
        Some(data[1])
    } else {
        None
    }
}

/// 本构建能不能解开这个版本。
///
/// · `None`（无头/不是密文）与 `Some(0)`（"撞头"的老数据）**都算能** —— `decrypt` 有回退分支；
/// · `v <= CURRENT_FORMAT` 能（v1 默认构建、v2 国密构建）；
/// · 未来版本 ⇒ **不能**。默认构建遇到 v2 也在这里被挡住 ⇒ 上层可以在动手前整批拒绝。
pub fn format_supported(version: Option<u8>) -> bool {
    match version {
        None => true,
        Some(v) => v <= CURRENT_FORMAT || (v == VERSION_SM4 && cfg!(feature = "sm-crypto")),
    }
}

/// 把"这个版本解不开"翻译成**可操作**的话（§0-C：不许说成"数据损坏"）。
pub fn unsupported_format_error(version: Option<u8>) -> String {
    match version {
        Some(v) if v == VERSION_SM4 => {
            "这段数据是国密（SM4-CBC ＋ HMAC-SM3，密文版本 2）格式，本机这版应用不含国密支持 —— 请换国密版应用后再打开".to_string()
        }
        Some(v) => format!(
            "这段数据是密文版本 {v}，本机支持到 {CURRENT_FORMAT} —— 它可能来自更新的应用版本，请升级后再打开"
        ),
        None => "无法判断这段数据的密文版本".to_string(),
    }
}

/// 版本号 → **稳定算法名**。只在这里定义一次：状态上报、日志、交付说明都引用它，
/// 免得同一个算法在三处出现三种写法（"SM4-CBC+HMAC-SM3" / "sm4cbc" / "国密"）。
pub fn format_name(format: u8) -> &'static str {
    match format {
        VERSION_XCHACHA => "xchacha20-poly1305",
        VERSION_SM4 => "sm4-cbc+hmac-sm3",
        _ => "unknown",
    }
}

/// Generate a fresh 16-byte salt (stored with the ciphertext or associated record).
pub fn random_salt() -> [u8; SALT_LEN] {
    let mut s = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut s);
    s
}

/// Lowercase hex of a 32-byte SQLCipher raw key, for
/// `PRAGMA key = "x'<hex>'";` when opening an encrypted space DB.
pub fn key_hex(key: &[u8; 32]) -> String {
    key.iter().map(|b| format!("{b:02x}")).collect()
}

/// Encrypt with XChaCha20-Poly1305; returns `nonce(24) || ciphertext`.
/// 写新数据。
///
/// · 默认构建 ⇒ v1（`magic | 1 | nonce(24) | XChaCha20-Poly1305`），**与 P0 的字节完全一致**；
/// · `--features sm-crypto` 且会话手里有国密密钥 ⇒ v2（`magic | 2 | iv(16) | SM4-CBC | HMAC-SM3`）。
/// 两条路径**共用同一套头**（§0-A），所以"这是哪一版"永远只看头，不靠猜。
pub fn encrypt(plaintext: &[u8], keys: &AppKeys) -> Result<Vec<u8>, String> {
    #[cfg(feature = "sm-crypto")]
    {
        if let Some(sm) = keys.sm.as_ref() {
            return crate::crypto_sm::encrypt(plaintext, &sm.enc, &sm.mac);
        }
    }
    seal_xchacha(plaintext, &keys.legacy)
}

/// v1 的实现：`magic | VERSION_XCHACHA | nonce(24) | ct`。
fn seal_xchacha(plaintext: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let key = Key::try_from(key.as_slice()).map_err(|_| "密钥长度无效".to_string())?;
    let cipher = XChaCha20Poly1305::new(&key);
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::try_from(nonce_bytes.as_slice()).map_err(|_| "nonce 长度无效".to_string())?;
    let ct = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| format!("加密失败: {e}"))?;
    let mut out = Vec::with_capacity(HEADER_LEN + NONCE_LEN + ct.len());
    // 头在前：`magic || version`。新数据**一定**带它（老数据没有 ⇒ 见 decrypt 的 v0 分支）。
    out.push(MAGIC);
    out.push(VERSION_XCHACHA);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// 解一段 `nonce(24) || ciphertext`（**不含**格式头）。v1 与 v0（老数据）共用它。
fn open_aead(payload: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if payload.len() < NONCE_LEN {
        return Err("密文格式无效".to_string());
    }
    let (nonce_bytes, ct) = payload.split_at(NONCE_LEN);
    let nonce = XNonce::try_from(nonce_bytes).map_err(|_| "nonce 长度无效".to_string())?;
    let key = Key::try_from(key.as_slice()).map_err(|_| "密钥长度无效".to_string())?;
    let cipher = XChaCha20Poly1305::new(&key);
    cipher.decrypt(&nonce, ct).map_err(|e| format!("解密失败: {e}"))
}

/// 解国密（v2）那一段。**报错也要可操作**：拿不到国密密钥时不能说"数据损坏"，
/// 要说清"这段是国密格式、而这版应用/这次会话打不开它，该怎么办"（§0-C）。
#[cfg(feature = "sm-crypto")]
fn open_sm(data: &[u8], keys: &AppKeys) -> Result<Vec<u8>, String> {
    match keys.sm.as_ref() {
        Some(sm) => crate::crypto_sm::decrypt(data, &sm.enc, &sm.mac),
        None => Err(
            "这段密文是国密（v2）格式，但当前会话里没有国密密钥 —— 请用国密版重新解锁本次会话".to_string(),
        ),
    }
}
#[cfg(not(feature = "sm-crypto"))]
fn open_sm(_data: &[u8], _keys: &AppKeys) -> Result<Vec<u8>, String> {
    Err("这段密文是国密（v2）格式，本机这版应用不含国密支持 —— 请换国密版应用后再打开".to_string())
}

/// Decrypt a v0 / v1 / v2 payload — **双读**，且**老数据永远可读**。
///
/// 分派规则与三条边界（都是刻意的，见 `decrypt` 的测试）：
///   · 头是 `magic + 1` ⇒ 走 v1（XChaCha20）；头是 `magic + 2` ⇒ 走 v2（国密）；
///   · **其余一律先按 v0 试** —— 因为"无头老数据永远可读"比"认出未来版本"重要；
///   · 因此认出的版本解不开时会**再按 v0 试一次**：老数据的头 24 字节是随机 nonce，其首字节恰好是
///     `MAGIC`、次字节恰好是**任一版本号**的概率是 1/65536 —— 概率小，但那是**真实存在**的一类附件，
///     把它们判成"损坏"就等于让用户打不开旧文件（v2 的头只多 16 字节，同一个道理）；
///   · 两条都失败、且看着像"更高的版本"时，给一条**可操作**的错误（提示来自更新的应用版本），
///     而不是笼统的"解密失败"。
pub fn decrypt(data: &[u8], keys: &AppKeys) -> Result<Vec<u8>, String> {
    let version = if data.len() >= HEADER_LEN && data[0] == MAGIC {
        Some(data[1])
    } else {
        None
    };

    // ① 认得出的版本：按版本分派。
    let dispatched = match version {
        Some(v) if v == VERSION_XCHACHA => Some(open_aead(&data[HEADER_LEN..], &keys.legacy)),
        Some(v) if v == VERSION_SM4 => Some(open_sm(data, keys)),
        _ => None,
    };
    match dispatched {
        Some(Ok(pt)) => return Ok(pt),
        Some(Err(primary)) => {
            // ★ 回退：老数据首字节撞上 magic+version 的情况（见上面的注释）。
            return open_aead(data, &keys.legacy).map_err(|_| primary);
        }
        None => {}
    }

    // ② 无头老数据（v0）：整段就是 `nonce || ct`。
    match open_aead(data, &keys.legacy) {
        Ok(pt) => Ok(pt),
        Err(e) => {
            if let Some(v) = version {
                if v > CURRENT_FORMAT {
                    return Err(format!(
                        "密文版本 {v} 不受支持（本机支持到 {CURRENT_FORMAT}）——这段数据可能来自更新的应用版本，请升级后再打开"
                    ));
                }
            }
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ★ **金标夹具**：P0 之前的无头（v0）密文**永远可读**。
    ///
    /// 夹具 `tests/crypto-legacy-v0.json` 里的密文是**真实产出**的（2026-09-19 由复刻旧实现的临时用例
    /// 生成、nonce 固定），不是手写常量。它守的是这条线最贵的一条性质：换 AEAD / 换 nonce 长度 /
    /// 换 KDF / P2-P3 的国密 provider —— 任何重构都必须先过这一份，红了就是"用户打不开自己的旧数据"，
    /// 而那种失败**在开发机上不会自己冒出来**（新数据一切正常）。
    ///
    /// 三格：文本路径 / ★首字节撞 magic+version 的那种 / 二进制路径。
    #[test]
    fn legacy_v0_golden_fixture_still_decrypts() {
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            kind: String,
            #[serde(rename = "nonceHex")]
            nonce_hex: String,
            #[serde(rename = "cipherB64", default)]
            cipher_b64: Option<String>,
            #[serde(rename = "cipherHex", default)]
            cipher_hex: Option<String>,
            #[serde(rename = "expectPlaintext", default)]
            expect_plaintext: Option<String>,
            #[serde(rename = "expectPlainHex", default)]
            expect_plain_hex: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct Fixture {
            passphrase: String,
            #[serde(rename = "saltHex")]
            salt_hex: String,
            #[serde(rename = "keyHex")]
            key_hex: String,
            cases: Vec<Case>,
        }
        let raw = include_str!("../tests/crypto-legacy-v0.json");
        let fx: Fixture = serde_json::from_str(raw).expect("夹具必须能解析");
        // 「空跑即红」：夹具为空、或缺字段，都要比"用例通过"更早暴露。
        assert!(fx.cases.len() >= 3, "夹具至少要有 3 格（文本/撞头/二进制），实际 {}", fx.cases.len());
        let salt = hex::decode(&fx.salt_hex).unwrap();
        let key = derive_key(&fx.passphrase, &salt).unwrap();
        // 夹具里记的 key 也必须与 KDF 现算的一致 —— 否则"换了 KDF"这件事会被静默吞掉。
        assert_eq!(key_hex(&key), fx.key_hex, "KDF 变了（夹具记录的 key 与现算不一致）");
        // ★ 夹具只用 legacy 密钥：国密构建（`--features sm-crypto`）也必须能读这份老数据。
        let keys = AppKeys::legacy_only(key);

        for c in &fx.cases {
            assert!(!hex::decode(&c.nonce_hex).unwrap().is_empty(), "用例「{}」没有 nonce", c.name);
            if c.kind == "str" {
                let b64 = c.cipher_b64.as_ref().unwrap_or_else(|| panic!("用例「{}」缺 cipherB64", c.name));
                let got = decrypt_str(b64, &keys).unwrap_or_else(|e| panic!("用例「{}」解不开：{e}", c.name));
                assert_eq!(&got, c.expect_plaintext.as_ref().unwrap(), "用例「{}」明文不一致", c.name);
            } else if c.kind == "bytes" {
                let blob = hex::decode(
                    c.cipher_hex.as_ref().unwrap_or_else(|| panic!("用例「{}」缺 cipherHex", c.name)),
                )
                .unwrap();
                let got = decrypt(&blob, &keys).unwrap_or_else(|e| panic!("用例「{}」解不开：{e}", c.name));
                assert_eq!(
                    hex::encode(&got),
                    *c.expect_plain_hex.as_ref().unwrap(),
                    "用例「{}」明文字节不一致",
                    c.name
                );
            } else {
                panic!("用例「{}」的 kind 不认识：{}", c.name, c.kind);
            }
        }
    }

    #[test]
    fn roundtrip() {
        let salt = random_salt();
        let keys = derive_app_keys("hunter2", &salt).unwrap();
        let ct = encrypt(b"hello shuyonote", &keys).unwrap();
        assert_eq!(&ct[..HEADER_LEN], &[MAGIC, active_format(&keys)], "写出来的版本与 active_format 不一致");
        let pt = decrypt(&ct, &keys).unwrap();
        assert_eq!(pt, b"hello shuyonote");
    }

    #[test]
    fn deterministic_key_for_same_salt() {
        let salt = random_salt();
        let k1 = derive_key("pw", &salt).unwrap();
        let k2 = derive_key("pw", &salt).unwrap();
        assert_eq!(k1, k2);
    }

    /// 造一段**老格式**（v0，无头）密文，nonce 显式给定 —— 用来模拟"P0 之前写下的数据"。
    /// 刻意复刻旧实现的那三行（nonce ‖ AEAD），**不复用现在的 `encrypt`**：复用的话
    /// 这条判据就变成拿实现验实现，"老数据仍可读"这句话会失去意义。
    fn seal_v0(plaintext: &[u8], key: &[u8; 32], nonce: [u8; NONCE_LEN]) -> Vec<u8> {
        let cipher = XChaCha20Poly1305::new(&Key::try_from(key.as_slice()).unwrap());
        let mut out = nonce.to_vec();
        let n = XNonce::try_from(nonce.as_slice()).unwrap();
        out.extend(cipher.encrypt(&n, plaintext).unwrap());
        out
    }

    /// ★ 新写的数据**一定**带版本头，且字符串路径与二进制路径是同一套编码
    /// （只给文本加前缀 = 两套格式，二进制那条以后还得再设一套 —— 方案 §0-A 的原始理由）。
    #[test]
    fn new_ciphertext_carries_the_version_header_on_both_paths() {
        let keys = derive_app_keys("pw", &random_salt()).unwrap();
        let want = [MAGIC, active_format(&keys)];
        let bin = encrypt(b"payload", &keys).unwrap();
        assert_eq!(&bin[..HEADER_LEN], &want, "二进制路径没带版本头");
        let text = encrypt_str("payload", &keys).unwrap();
        let decoded = b64_decode(&text).unwrap();
        assert_eq!(&decoded[..HEADER_LEN], &want, "字符串路径没带版本头（应当 base64(同一套编码)）");
        assert_eq!(decrypt_str(&text, &keys).unwrap(), "payload");
    }

    /// ★ **无头老数据永远可读**（P0 的第一约束：它比"认出未来版本"重要）。
    /// 老格式 = `nonce(24) ‖ ct`，由 `seal_v0` 复刻。
    #[test]
    fn legacy_headerless_data_still_reads() {
        let key = derive_key("pw", &random_salt()).unwrap();
        let keys = AppKeys::legacy_only(key);
        let nonce = [7u8; NONCE_LEN]; // 首字节不是 MAGIC ⇒ 走"先按 v0 试"这条路
        let v0 = seal_v0("上一年写的附件".as_bytes(), &key, nonce);
        assert_eq!(decrypt(&v0, &keys).unwrap(), "上一年写的附件".as_bytes());
        // 文本路径同样（老数据是 base64(nonce‖ct)）
        assert_eq!(decrypt_str(&B64.encode(&v0), &keys).unwrap(), "上一年写的附件");
    }

    /// ★★ 最容易漏的一条：老数据的头 24 字节是**随机 nonce**，所以"首字节 == MAGIC、次字节 == 版本号"
    /// 是**真实存在**的一类记录（1/65536）。它会被误判成 v1 **或 v2** ⇒ 必须有回退，
    /// 否则这类用户**打不开自己的旧附件**，而且报错是"解密失败"（看起来像损坏）。
    ///
    /// P1 起这条要对**两个**版本号各验一遍：v2 的载荷有最小长度（66 字节），
    /// 所以明文刻意取长一点，免得"长度不足"替这条回退挡了枪 —— 那会让判据看起来绿、实际没走回退。
    #[test]
    fn legacy_data_whose_first_two_bytes_look_like_the_header_still_reads() {
        let salt = random_salt();
        let key = derive_key("pw", &salt).unwrap();
        let keys = derive_app_keys("pw", &salt).unwrap();
        let plain = vec![b'x'; 80]; // ⇒ v0 密文 24+80+16 = 120 字节 > v2 的 66 字节下限
        for v in [VERSION_XCHACHA, VERSION_SM4] {
            let mut nonce = [9u8; NONCE_LEN];
            nonce[0] = MAGIC;
            nonce[1] = v; // 刻意撞上头
            let v0 = seal_v0(&plain, &key, nonce);
            assert_eq!(&v0[..HEADER_LEN], &[MAGIC, v], "构造失败：这段老数据没撞上 v{v} 的头");
            assert_eq!(
                decrypt(&v0, &keys).unwrap(),
                plain,
                "撞上 v{v} 头的老数据被判成损坏了 —— 这条回退不许删"
            );
        }
    }

    /// 未来版本（本机还不认识）⇒ **可操作**的错误，而不是笼统的"解密失败"：
    /// 用户看到的应当是"来自更新的应用版本，请升级"，而不是"你的数据坏了"。
    #[test]
    fn unknown_future_version_gets_an_actionable_error() {
        let keys = derive_app_keys("pw", &random_salt()).unwrap();
        let mut blob = encrypt(b"from the future", &keys).unwrap();
        blob[1] = 9; // 假装这是 9.0 版应用写的
        let err = decrypt(&blob, &keys).unwrap_err();
        assert!(err.contains("版本 9"), "错误里没写出版本号：{err}");
        assert!(err.contains("升级"), "错误不可操作（没告诉用户该怎么办）：{err}");
    }

    #[test]
    fn wrong_key_fails() {
        let salt = random_salt();
        let k1 = derive_app_keys("a", &salt).unwrap();
        let k2 = derive_app_keys("b", &salt).unwrap();
        let ct = encrypt(b"secret", &k1).unwrap();
        assert!(decrypt(&ct, &k2).is_err());
    }

    // ── P1：国密（v2）的判定 ────────────────────────────────────────────────────────
    //
    // 这两条是**同一件事的两面**，各自只在一种构建下编：
    //   · 国密构建：新数据是 v2，且**老数据（v0/v1）照旧能读**（双读，§4 第 2 条）；
    //   · 默认构建：**字节层面不许变**（新数据仍是 v1），但读到 v2 必须给"换国密版/升级"的可操作错误。

    /// 默认构建（不带 `--features sm-crypto`）：写的一律是 v1，且**永远写不出 v2**。
    #[cfg(not(feature = "sm-crypto"))]
    #[test]
    fn default_build_still_writes_v1_and_rejects_v2_with_an_actionable_error() {
        assert_eq!(CURRENT_FORMAT, VERSION_XCHACHA, "默认构建不写 v2 —— 国密版靠 feature 另发（§0-E）");
        let keys = derive_app_keys("pw", &random_salt()).unwrap();
        assert_eq!(active_format(&keys), VERSION_XCHACHA);
        let blob = encrypt(b"default stays v1", &keys).unwrap();
        assert_eq!(blob[1], VERSION_XCHACHA);

        // 伪造一段 v2：长度够、但本构建根本没有国密实现。
        let mut fake_v2 = blob.clone();
        fake_v2[1] = VERSION_SM4;
        let err = decrypt(&fake_v2, &keys).unwrap_err();
        assert!(err.contains("国密"), "没认出这是国密格式：{err}");
        assert!(
            err.contains("国密版") || err.contains("升级"),
            "错误不可操作（要点明怎么办）：{err}"
        );
    }

    /// 国密构建：新数据是 v2；**同时** v1 与 v0 的老数据必须照旧读得出来（双读）。
    #[cfg(feature = "sm-crypto")]
    #[test]
    fn sm_build_writes_v2_and_still_reads_v1_and_v0() {
        assert_eq!(CURRENT_FORMAT, VERSION_SM4, "国密构建写 v2");
        let salt = random_salt();
        let keys = derive_app_keys("pw", &salt).unwrap();
        assert!(keys.sm.is_some(), "国密构建派生出来的密钥材料里必须有那一对独立密钥");
        assert_eq!(active_format(&keys), VERSION_SM4);

        // ① 新数据：v2，且能往返。
        let v2 = encrypt(b"national crypto", &keys).unwrap();
        assert_eq!(&v2[..HEADER_LEN], &[MAGIC, VERSION_SM4]);
        assert_eq!(decrypt(&v2, &keys).unwrap(), b"national crypto");

        // ② 老数据 v1（P0 写下的）：同一把 legacy 密钥、同一个盐，必须照旧读得出。
        let v1 = seal_xchacha(b"written before P1", &keys.legacy).unwrap();
        assert_eq!(&v1[..HEADER_LEN], &[MAGIC, VERSION_XCHACHA]);
        assert_eq!(decrypt(&v1, &keys).unwrap(), b"written before P1");

        // ③ 老数据 v0（P0 之前）：无头，也必须照旧读得出。
        let v0 = seal_v0(b"before P0", &keys.legacy, [11u8; NONCE_LEN]);
        assert_eq!(decrypt(&v0, &keys).unwrap(), b"before P0");
    }

    /// §0-C：**不解密就能判断版本** —— 这是"整空间/整批同步之前先拒绝"的地基。
    /// 三格：无头（None，永远放行）/ v1 / v2；另加"未来版本"与"根本不是密文"两类。
    #[test]
    fn peek_format_reads_the_header_without_a_key() {
        let keys = derive_app_keys("pw", &random_salt()).unwrap();
        let v1 = seal_xchacha(b"x", &keys.legacy).unwrap();
        assert_eq!(peek_format(&v1), Some(VERSION_XCHACHA));
        // 无头老数据：不像我们写的密文 ⇒ None（**不是**"不支持"）
        let v0 = seal_v0(b"x", &keys.legacy, [3u8; NONCE_LEN]);
        assert_eq!(peek_format(&v0), None);
        // 明文 JSON / 空 / 太短：同样是 None
        assert_eq!(peek_format(br#"{"id":"p1"}"#), None);
        assert_eq!(peek_format(&[]), None);
        assert_eq!(peek_format(&[MAGIC]), None, "只有一个字节时不该硬读第二个");
        // 未来版本：解得出"是哪一版"，但本构建不支持
        let mut future = v1.clone();
        future[1] = 9;
        assert_eq!(peek_format(&future), Some(9));

        assert!(format_supported(None), "无头老数据永远可读");
        assert!(format_supported(Some(0)), "撞头的老数据走回退，同样放行");
        assert!(format_supported(Some(VERSION_XCHACHA)));
        assert_eq!(
            format_supported(Some(VERSION_SM4)),
            cfg!(feature = "sm-crypto"),
            "v2 的支持与否只取决于这个构建有没有编国密"
        );
        assert!(!format_supported(Some(9)), "未来版本必须判为不支持");
        // 报错必须**可操作**（点明"怎么办"），不能是"数据损坏"
        assert!(unsupported_format_error(Some(VERSION_SM4)).contains("国密版"));
        assert!(unsupported_format_error(Some(9)).contains("升级"));
    }

    #[cfg(feature = "sm-crypto")]
    #[test]
    fn sm_build_peeks_v2_as_supported() {
        let keys = derive_app_keys("pw", &random_salt()).unwrap();
        let v2 = encrypt(b"y", &keys).unwrap();
        assert_eq!(peek_format(&v2), Some(VERSION_SM4));
        assert!(format_supported(Some(VERSION_SM4)));
    }

    /// 国密构建下"只有 legacy 密钥"（例如某个只做老路径的调用方）⇒ 仍写 v1，
    /// **不许**因为构建带了国密就把没有国密密钥的会话写成 v2（那会写出谁都解不开的数据）。
    #[cfg(feature = "sm-crypto")]
    #[test]
    fn sm_build_without_sm_keys_falls_back_to_v1() {
        let keys = AppKeys::legacy_only([3u8; 32]);
        assert_eq!(active_format(&keys), VERSION_XCHACHA);
        let blob = encrypt(b"legacy session", &keys).unwrap();
        assert_eq!(blob[1], VERSION_XCHACHA);
        assert_eq!(decrypt(&blob, &keys).unwrap(), b"legacy session");
    }
}
