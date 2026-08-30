// Shared app state + SQLite initialisation (schema) + attachment dir helper.
// Kept separate so auth/space/sync/attachments modules can share `AppState`.
use rusqlite::Connection;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

/// Shared, clonable server state handed to every handler via axum `State`.
#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub attachments_dir: Arc<PathBuf>,
}

/// Open/create the SQLite database and ensure the base schema exists.
pub fn init_db(path: &PathBuf) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("failed to create db dir");
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS changes (
            seq         INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id   TEXT NOT NULL,
            device_seq  INTEGER NOT NULL,
            entity      TEXT NOT NULL,
            entity_id   TEXT NOT NULL,
            op          TEXT NOT NULL,
            payload     TEXT,
            updated_at  INTEGER NOT NULL,
            UNIQUE(device_id, device_seq)
        );
        CREATE INDEX IF NOT EXISTS idx_changes_seq ON changes(seq);

        CREATE TABLE IF NOT EXISTS attachment_meta (
            hash TEXT PRIMARY KEY,
            mime TEXT NOT NULL
        );
        "#,
    )?;
    Ok(conn)
}

/// Resolve the attachment directory as a sibling of the DB file (or `attachments`
/// under CWD when the DB path has no parent), creating it if missing.
pub fn init_attachment_dir(db_path: &Path) -> PathBuf {
    let dir = db_path
        .parent()
        .map(|p| p.join("attachments"))
        .unwrap_or_else(|| PathBuf::from("attachments"));
    std::fs::create_dir_all(&dir).expect("failed to create attachments dir");
    dir
}
