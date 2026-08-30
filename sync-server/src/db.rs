// Shared app state + SQLite initialisation (schema + migrations) + attachment
// dir helper. S2 adds the team-edition schema — users / sessions / spaces /
// space_members / audit_log, plus `changes.space_id` — behind an idempotent,
// versioned migration so legacy single-user databases upgrade in place and
// re-running `init_db` is a no-op.
use rusqlite::Connection;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

/// Base schema shipped since v1.0.0 (single-user change log + attachment meta).
/// Kept as a constant so tests can build an in-memory DB through the same path.
const BASE_SCHEMA: &str = r#"
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
"#;

/// Shared, clonable server state handed to every handler via axum `State`.
#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub attachments_dir: Arc<PathBuf>,
}

/// Open/create the SQLite database, apply the base schema, then run migrations.
pub fn init_db(path: &PathBuf) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("failed to create db dir");
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute_batch(BASE_SCHEMA)?;
    migrate(&conn)?;
    Ok(conn)
}

/// Apply migrations whose version is above the live one. Each migration inserts
/// its version into `schema_version`, so re-running is a no-op (idempotent).
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);")?;
    let current: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_version",
        [],
        |row| row.get(0),
    )?;
    // v1 — team-edition schema (S2): users / sessions / spaces / space_members /
    // audit_log + `changes.space_id` + the per-space change cursor index.
    if current < 1 {
        migrate_v1(conn)?;
    }
    Ok(())
}

fn migrate_v1(conn: &Connection) -> rusqlite::Result<()> {
    // `changes.space_id` is added via a guarded ALTER because databases created
    // before S2 predate the column. New rows default to '' so legacy single-user
    // data remains readable, and the guard keeps the migration idempotent.
    if !column_exists(conn, "changes", "space_id")? {
        conn.execute_batch("ALTER TABLE changes ADD COLUMN space_id TEXT NOT NULL DEFAULT '';")?;
    }
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS users (
            id          TEXT PRIMARY KEY,
            email       TEXT UNIQUE NOT NULL,
            display     TEXT,
            password    TEXT NOT NULL,
            role        TEXT DEFAULT 'member',
            created_at  INTEGER,
            disabled_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token      TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL,
            created_at INTEGER,
            expires_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS spaces (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            owner_id   TEXT NOT NULL,
            created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS space_members (
            space_id TEXT NOT NULL,
            user_id  TEXT NOT NULL,
            role     TEXT DEFAULT 'editor',
            PRIMARY KEY (space_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS audit_log (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            space_id  TEXT,
            user_id   TEXT,
            action    TEXT,
            entity    TEXT,
            entity_id TEXT,
            detail    TEXT,
            at        INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_changes_space_seq ON changes(space_id, seq);
        INSERT INTO schema_version (version) VALUES (1);
        "#,
    )?;
    Ok(())
}

/// Whether `table` currently has a column named `column` (via `PRAGMA table_info`).
fn column_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_creates_team_schema_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(BASE_SCHEMA).unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap(); // second run must be a no-op

        for table in [
            "users",
            "sessions",
            "spaces",
            "space_members",
            "audit_log",
            "schema_version",
        ] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "expected table {table}");
        }
        assert!(column_exists(&conn, "changes", "space_id").unwrap());

        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 1);
    }

    #[test]
    fn legacy_changes_row_backfilled_with_empty_space_id() {
        let conn = Connection::open_in_memory().unwrap();
        // Simulate a pre-S2 database: `changes` without `space_id` and one row.
        conn.execute_batch(
            "CREATE TABLE changes (
                seq         INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id   TEXT NOT NULL,
                device_seq  INTEGER NOT NULL,
                entity      TEXT NOT NULL,
                entity_id   TEXT NOT NULL,
                op          TEXT NOT NULL,
                payload     TEXT,
                updated_at  INTEGER NOT NULL,
                UNIQUE(device_id, device_seq)
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO changes (device_id, device_seq, entity, entity_id, op, payload, updated_at)
             VALUES ('dev-1', 1, 'page', 'p1', 'upsert', NULL, 0)",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let space: String = conn
            .query_row(
                "SELECT space_id FROM changes WHERE device_id = 'dev-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(space, "");
    }
}
