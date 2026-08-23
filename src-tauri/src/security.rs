use crate::crypto;
use crate::db::Db;
use crate::sync;
use rusqlite::Connection;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::State;

/// App-session "locked" flag: gating pushes/pulls until the passphrase is re-entered.
static LOCKED: AtomicBool = AtomicBool::new(false);

/// Constant encrypted as the verify sentinel so `unlock_encryption` can validate the passphrase
/// without persisting the key at rest.
const VERIFY_MSG: &str = "shuyonote-encryption-verify";

fn conn<'a>(db: &'a State<'_, Db>) -> std::sync::MutexGuard<'a, Connection> {
    db.0.lock().expect("db mutex poisoned")
}

/// Whether encryption is turned on for the current workspace.
fn encryption_enabled(c: &Connection) -> bool {
    sync::get_state(c, crypto::ENC_ENABLED).as_deref() == Some("1")
}

/// Read the derived key (if encryption is enabled and session currently unlocked) from sync_state.
pub fn key_if_enabled(c: &Connection) -> Option<[u8; 32]> {
    if !encryption_enabled(c) || LOCKED.load(Ordering::SeqCst) {
        return None;
    }
    let s = sync::get_state(c, crypto::ENC_KEY)?;
    let b = crypto::b64_decode(&s).ok()?;
    b.as_slice().try_into().ok()
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

#[tauri::command]
pub fn set_encryption(db: State<Db>, passphrase: String) -> Result<(), String> {
    if passphrase.trim().len() < 8 {
        return Err("口令至少 8 位".to_string());
    }
    let c = conn(&db);
    let salt = crypto::random_salt();
    let key = crypto::derive_key(&passphrase, &salt)?;
    let verify = crypto::encrypt_str(VERIFY_MSG, &key)?;
    sync::set_state(&c, crypto::ENC_SALT, &crypto::b64_encode(&salt))?;
    sync::set_state(&c, crypto::ENC_KEY, &crypto::b64_encode(&key))?;
    sync::set_state(&c, crypto::ENC_VERIFY, &verify)?;
    sync::set_state(&c, crypto::ENC_ENABLED, "1")?;
    LOCKED.store(false, Ordering::SeqCst);
    Ok(())
}

/// Gate sync: when encryption is enabled but the session is locked, refuse to sync rather than
/// silently sending/accepting plaintext on the wire.
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

#[tauri::command]
pub fn lock_encryption(db: State<Db>) -> Result<(), String> {
    let c = conn(&db);
    if !encryption_enabled(&c) {
        return Err("未开启端到端加密".to_string());
    }
    LOCKED.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn unlock_encryption(db: State<Db>, passphrase: String) -> Result<(), String> {
    let c = conn(&db);
    if !encryption_enabled(&c) {
        return Err("未开启端到端加密".to_string());
    }
    let salt_b64 = sync::get_state(&c, crypto::ENC_SALT).ok_or("加密状态缺失".to_string())?;
    let salt = crypto::b64_decode(&salt_b64).map_err(|e| format!("盐值无效: {e}"))?;
    let key = crypto::derive_key(&passphrase, &salt)?;
    let verify = sync::get_state(&c, crypto::ENC_VERIFY).ok_or("加密状态缺失".to_string())?;
    let msg = crypto::decrypt_str(&verify, &key).map_err(|_| "口令不正确".to_string())?;
    if msg != VERIFY_MSG {
        return Err("口令不正确".to_string());
    }
    LOCKED.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn disable_encryption(db: State<Db>) -> Result<(), String> {
    let c = conn(&db);
    sync::set_state(&c, crypto::ENC_ENABLED, "0")?;
    LOCKED.store(false, Ordering::SeqCst);
    Ok(())
}

// ---- round-trip test ----
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::now_ms;

    fn mem_conn() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        c
    }

    #[test]
    fn payload_roundtrip_when_enabled() {
        let mut c = mem_conn();
        // ensure the session is not locked (cross-test safety for the global flag)
        LOCKED.store(false, Ordering::SeqCst);
        // simulate set_encryption
        let salt = crypto::random_salt();
        let key = crypto::derive_key("supersecret", &salt).unwrap();
        sync::set_state(&c, crypto::ENC_SALT, &crypto::b64_encode(&salt)).unwrap();
        sync::set_state(&c, crypto::ENC_KEY, &crypto::b64_encode(&key)).unwrap();
        sync::set_state(&c, crypto::ENC_ENABLED, "1").unwrap();

        let plain = r#"{"id":"p1","content_json":"hello","content_text":"hi"}"#;
        let enc = encrypt_payload(&c, plain).unwrap();
        assert_ne!(enc, plain);
        let dec = decrypt_payload(&c, &enc).unwrap();
        assert_eq!(dec, plain);
    }

    #[test]
    fn payload_passthrough_when_disabled() {
        let c = mem_conn();
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
        // Right passphrase decrypts to the verify message.
        assert_eq!(crypto::decrypt_str(&sentinel, &key).unwrap(), VERIFY_MSG);
        // Wrong passphrase fails.
        assert!(crypto::decrypt_str(&sentinel, &wrong).is_err());
    }

    #[test]
    fn lock_gates_key_and_sync() {
        let mut c = mem_conn();
        // enable encryption (+ key persisted) and unlock by default
        let salt = crypto::random_salt();
        let key = crypto::derive_key("supersecret", &salt).unwrap();
        sync::set_state(&c, crypto::ENC_SALT, &crypto::b64_encode(&salt)).unwrap();
        sync::set_state(&c, crypto::ENC_KEY, &crypto::b64_encode(&key)).unwrap();
        sync::set_state(&c, crypto::ENC_ENABLED, "1").unwrap();
        LOCKED.store(false, Ordering::SeqCst);
        assert!(key_if_enabled(&c).is_some());
        assert!(sync_gate(&c).is_ok());

        // lock -> key unavailable, sync refused
        LOCKED.store(true, Ordering::SeqCst);
        assert!(key_if_enabled(&c).is_none());
        assert!(sync_gate(&c).is_err());

        // unlock -> key available, sync allowed again
        LOCKED.store(false, Ordering::SeqCst);
        assert!(key_if_enabled(&c).is_some());
        assert!(sync_gate(&c).is_ok());
    }
}
