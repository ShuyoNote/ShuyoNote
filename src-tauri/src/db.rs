use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);

pub fn init(app_data_dir: PathBuf) -> Result<Connection, rusqlite::Error> {
    let db_path = app_data_dir.join("shuyonote.db");
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).expect("failed to create app data dir");
    }

    let conn = Connection::open(&db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;

    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS workspaces (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pages (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id),
            parent_id    TEXT REFERENCES pages(id),
            title        TEXT NOT NULL DEFAULT '',
            content_json TEXT NOT NULL DEFAULT '{}',
            content_text TEXT NOT NULL DEFAULT '',
            sort_order   REAL NOT NULL DEFAULT 0,
            created_at   INTEGER NOT NULL,
            updated_at   INTEGER NOT NULL,
            deleted_at   INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(workspace_id, parent_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_pages_updated ON pages(updated_at);

        CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(
            page_id UNINDEXED,
            title,
            body,
            tokenize='trigram'
        );

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

        CREATE TABLE IF NOT EXISTS sync_state (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )?;

    // Backfill FTS index if it was just created (empty) but pages already exist.
    let fts_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM page_fts", [], |row| row.get(0))?;
    if fts_count == 0 {
        conn.execute(
            "INSERT INTO page_fts (page_id, title, body)
             SELECT id, title, content_text FROM pages WHERE deleted_at IS NULL",
            [],
        )?;
    }

    // Ensure a default workspace exists.
    let count: i64 =
        conn.query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))?;
    if count == 0 {
        let now = now_ms();
        conn.execute(
            "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params!["default", "默认工作区", now, now],
        )?;
    }

    // Ensure a persistent device id exists.
    let device_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM sync_state WHERE key = 'device_id'", [], |row| {
            row.get(0)
        })?;
    if device_count == 0 {
        let device_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO sync_state (key, value) VALUES ('device_id', ?1)",
            params![device_id],
        )?;
    }

    Ok(())
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
