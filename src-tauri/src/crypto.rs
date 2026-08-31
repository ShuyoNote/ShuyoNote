use argon2::Argon2;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand_core::OsRng;
use rand_core::RngCore;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;

/// `sync_state` keys for the opt-in per-workspace encryption.
pub const ENC_ENABLED: &str = "encryption_enabled";
pub const ENC_SALT: &str = "encryption_salt";
pub const ENC_KEY: &str = "encryption_key";
/// Sentinel ciphertext used to verify the passphrase on unlock (no key persisted at rest).
pub const ENC_VERIFY: &str = "encryption_verify";

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
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Decrypt `nonce(24) || ciphertext` produced by [`encrypt`].
pub fn decrypt(data: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if data.len() < NONCE_LEN {
        return Err("密文格式无效".to_string());
    }
    let (nonce_bytes, ct) = data.split_at(NONCE_LEN);
    let nonce = XNonce::try_from(nonce_bytes).map_err(|_| "nonce 长度无效".to_string())?;
    let key = Key::try_from(key.as_slice()).map_err(|_| "密钥长度无效".to_string())?;
    let cipher = XChaCha20Poly1305::new(&key);
    cipher
        .decrypt(&nonce, ct)
        .map_err(|e| format!("解密失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn wrong_key_fails() {
        let salt = random_salt();
        let k1 = derive_key("a", &salt).unwrap();
        let k2 = derive_key("b", &salt).unwrap();
        let ct = encrypt(b"secret", &k1).unwrap();
        assert!(decrypt(&ct, &k2).is_err());
    }
}
