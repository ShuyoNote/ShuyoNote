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
/// 当前写入的版本。字符串与二进制路径都是它。
pub const CURRENT_FORMAT: u8 = 1;
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

/// Encrypt a UTF-8 string; result is base64 `nonce(24)||ciphertext`.
pub fn encrypt_str(s: &str, key: &[u8; 32]) -> Result<String, String> {
    Ok(B64.encode(encrypt(s.as_bytes(), key)?))
}
/// Decrypt a base64 `nonce||ciphertext` produced by [`encrypt_str`].
pub fn decrypt_str(s: &str, key: &[u8; 32]) -> Result<String, String> {
    let bytes = b64_decode(s)?;
    let plain = decrypt(&bytes, key)?;
    String::from_utf8(plain).map_err(|e| format!("解密结果非 UTF-8: {e}"))
}

/// Derive a 256-bit key from a passphrase + salt (Argon2id, default params).
pub fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| format!("密钥派生失败: {e}"))?;
    Ok(key)
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
pub fn encrypt(plaintext: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
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
    out.push(CURRENT_FORMAT);
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

/// Decrypt either the current headered format (`magic || version || nonce || ct`)
/// or a **legacy headerless** payload (`nonce || ct`, i.e. everything written before P0).
///
/// 分派规则与两条边界（都是刻意的，见 `decrypt` 的测试）：
///   · 头是 `magic + 当前版本` ⇒ 走 v1；
///   · **其余一律先按 v0 试** —— 因为"无头老数据永远可读"比"认出未来版本"重要；
///   · 因此 v1 解不开时会**再按 v0 试一次**：老数据的头 24 字节是随机 nonce，其首字节恰好是
///     `MAGIC`、次字节恰好是 `1` 的概率是 1/65536 —— 概率小，但那是**真实存在**的一类附件，
///     把它们判成"损坏"就等于让用户打不开旧文件；
///   · 两条都失败、且看着像"更高的版本"时，给一条**可操作**的错误（提示来自更新的应用版本），
///     而不是笼统的"解密失败"。
pub fn decrypt(data: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let looks_headered = data.len() >= HEADER_LEN && data[0] == MAGIC && data[1] == CURRENT_FORMAT;
    if looks_headered {
        match open_aead(&data[HEADER_LEN..], key) {
            Ok(pt) => return Ok(pt),
            Err(e) => {
                // ★ 回退：老数据首字节撞上 magic+version 的情况（见上面的注释）。
                if let Ok(pt) = open_aead(data, key) {
                    return Ok(pt);
                }
                return Err(e);
            }
        }
    }
    match open_aead(data, key) {
        Ok(pt) => Ok(pt),
        Err(e) => {
            if data.len() >= HEADER_LEN && data[0] == MAGIC && data[1] > CURRENT_FORMAT {
                return Err(format!(
                    "密文版本 {} 不受支持（本机支持到 {CURRENT_FORMAT}）——这段数据可能来自更新的应用版本，请升级后再打开",
                    data[1]
                ));
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

        for c in &fx.cases {
            assert!(!hex::decode(&c.nonce_hex).unwrap().is_empty(), "用例「{}」没有 nonce", c.name);
            if c.kind == "str" {
                let b64 = c.cipher_b64.as_ref().unwrap_or_else(|| panic!("用例「{}」缺 cipherB64", c.name));
                let got = decrypt_str(b64, &key).unwrap_or_else(|e| panic!("用例「{}」解不开：{e}", c.name));
                assert_eq!(&got, c.expect_plaintext.as_ref().unwrap(), "用例「{}」明文不一致", c.name);
            } else if c.kind == "bytes" {
                let blob = hex::decode(
                    c.cipher_hex.as_ref().unwrap_or_else(|| panic!("用例「{}」缺 cipherHex", c.name)),
                )
                .unwrap();
                let got = decrypt(&blob, &key).unwrap_or_else(|e| panic!("用例「{}」解不开：{e}", c.name));
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
        let key = derive_key("hunter2", &salt).unwrap();
        let ct = encrypt(b"hello shuyonote", &key).unwrap();
        let pt = decrypt(&ct, &key).unwrap();
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
        let key = derive_key("pw", &random_salt()).unwrap();
        let bin = encrypt(b"payload", &key).unwrap();
        assert_eq!(&bin[..HEADER_LEN], &[MAGIC, CURRENT_FORMAT], "二进制路径没带版本头");
        let text = encrypt_str("payload", &key).unwrap();
        let decoded = b64_decode(&text).unwrap();
        assert_eq!(&decoded[..HEADER_LEN], &[MAGIC, CURRENT_FORMAT], "字符串路径没带版本头（应当 base64(同一套编码)）");
        assert_eq!(decrypt_str(&text, &key).unwrap(), "payload");
    }

    /// ★ **无头老数据永远可读**（P0 的第一约束：它比"认出未来版本"重要）。
    /// 老格式 = `nonce(24) ‖ ct`，由 `seal_v0` 复刻。
    #[test]
    fn legacy_headerless_data_still_reads() {
        let key = derive_key("pw", &random_salt()).unwrap();
        let nonce = [7u8; NONCE_LEN]; // 首字节不是 MAGIC ⇒ 走"先按 v0 试"这条路
        let v0 = seal_v0("上一年写的附件".as_bytes(), &key, nonce);
        assert_eq!(decrypt(&v0, &key).unwrap(), "上一年写的附件".as_bytes());
        // 文本路径同样（老数据是 base64(nonce‖ct)）
        assert_eq!(decrypt_str(&B64.encode(&v0), &key).unwrap(), "上一年写的附件");
    }

    /// ★★ 最容易漏的一条：老数据的头 24 字节是**随机 nonce**，所以"首字节 == MAGIC、次字节 == 1"
    /// 是**真实存在**的一类记录（1/65536）。它会被误判成 v1 ⇒ 必须有回退，
    /// 否则这类用户**打不开自己的旧附件**，而且报错是"解密失败"（看起来像损坏）。
    #[test]
    fn legacy_data_whose_first_two_bytes_look_like_the_header_still_reads() {
        let key = derive_key("pw", &random_salt()).unwrap();
        let mut nonce = [9u8; NONCE_LEN];
        nonce[0] = MAGIC;
        nonce[1] = CURRENT_FORMAT; // 刻意撞上头
        let v0 = seal_v0(b"collision case", &key, nonce);
        assert_eq!(&v0[..HEADER_LEN], &[MAGIC, CURRENT_FORMAT], "构造失败：这段老数据没撞上头");
        assert_eq!(
            decrypt(&v0, &key).unwrap(),
            b"collision case",
            "撞上头的老数据被判成损坏了 —— 这条回退不许删"
        );
    }

    /// 未来版本（本机还不认识）⇒ **可操作**的错误，而不是笼统的"解密失败"：
    /// 用户看到的应当是"来自更新的应用版本，请升级"，而不是"你的数据坏了"。
    #[test]
    fn unknown_future_version_gets_an_actionable_error() {
        let key = derive_key("pw", &random_salt()).unwrap();
        let mut v1 = encrypt(b"from the future", &key).unwrap();
        v1[1] = 9; // 假装这是 9.0 版应用写的
        let err = decrypt(&v1, &key).unwrap_err();
        assert!(err.contains("版本 9"), "错误里没写出版本号：{err}");
        assert!(err.contains("升级"), "错误不可操作（没告诉用户该怎么办）：{err}");
    }

    #[test]
    fn wrong_key_fails() {
        let salt = random_salt();
        let k1 = derive_key("a", &salt).unwrap();
        let k2 = derive_key("b", &salt).unwrap();
        let ct = encrypt(b"secret", &k1).unwrap();
        assert!(decrypt(&ct, &k2).is_err());
    }
}
