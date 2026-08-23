use crate::crypto;
use crate::db::Db;
use crate::sync;
use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

fn conn<'a>(db: &'a State<'_, Db>) -> std::sync::MutexGuard<'a, Connection> {
    db.0.lock().expect("db mutex poisoned")
}

/// Read the derived key (if encryption is enabled) from sync_state.
pub fn key_if_enabled(c: &Connection) -> Option<[u8; 32]> {
    if sync::get_state(c, crypto::ENC_ENABLED).as_deref() != Some("1") {
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
    sync::set_state(&c, crypto::ENC_SALT, &crypto::b64_encode(&salt))?;
    sync::set_state(&c, crypto::ENC_KEY, &crypto::b64_encode(&key))?;
    sync::set_state(&c, crypto::ENC_ENABLED, "1")?;
    Ok(())
}

#[derive(Serialize)]
pub struct EncryptionStatus {
    pub enabled: bool,
}

#[tauri::command]
pub fn encryption_status(db: State<Db>) -> Result<EncryptionStatus, String> {
    let c = conn(&db);
    Ok(EncryptionStatus {
        enabled: sync::get_state(&c, crypto::ENC_ENABLED).as_deref() == Some("1"),
    })
}

#[tauri::command]
pub fn disable_encryption(db: State<Db>) -> Result<(), String> {
    let c = conn(&db);
    sync::set_state(&c, crypto::ENC_ENABLED, "0")?;
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
}
