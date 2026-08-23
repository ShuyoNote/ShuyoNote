use argon2::Argon2;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand_core::OsRng;
use rand_core::RngCore;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;

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
