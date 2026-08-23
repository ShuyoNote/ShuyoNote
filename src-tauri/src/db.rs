use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::OnceLock;

/// App-level (meta) DB path inside the app data dir.
pub const META_DB: &str = "meta.db";
/// Key for the active workspace id in meta.sync_state.
pub const ACTIVE_KEY: &str = "active_workspace_id";

pub struct Db(pub Mutex<Connection>);

static APP_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Resolve data paths for the app-data dir.
pub(crate) fn meta_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(META_DB)
}
pub(crate) fn spaces_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("spaces")
}
pub(crate) fn space_db_path(app_data_dir: &Path, space_id: &str) -> PathBuf {
    spaces_dir(app_data_dir).join(format!("{space_id}.db"))
}

/// Reopen the main (active space) connection to point at `space_id`'s DB file,
/// re-attaching meta.db. Used when creating/switching/deleting a workspace.
pub(crate) fn reopen_space(c: &mut Connection, space_id: &str) -> Result<(), String> {
    let dir = APP_DATA_DIR
        .get()
        .ok_or_else(|| "app data dir not initialised".to_string())?;
    let _ = std::mem::replace(c, Connection::open(space_db_path(dir, space_id)).map_err(|e| e.to_string())?);
    c.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
    c.pragma_update(None, "synchronous", "NORMAL").map_err(|e| e.to_string())?;
    c.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
    migrate(c, space_id).map_err(|e| e.to_string())?;
    let meta = meta_path(dir).display().to_string().replace('\'', "''");
    c.execute(&format!("ATTACH DATABASE '{meta}' AS meta"), [])
        .map_err(|e| format!("attach meta failed: {e}"))?;
    Ok(())
}

pub fn init(app_data_dir: PathBuf) -> Result<Connection, rusqlite::Error> {
    let _ = APP_DATA_DIR.set(app_data_dir.clone());
    std::fs::create_dir_all(&app_data_dir).expect("failed to create app data dir");
    std::fs::create_dir_all(spaces_dir(&app_data_dir)).ok();

    // meta.db: app-level shared state (workspaces / sync_state / templates / plugin_state).
    {
        let meta_conn = Connection::open(meta_path(&app_data_dir))?;
        meta_migrate(&meta_conn)?;
        let count: i64 = meta_conn
            .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
            .unwrap_or(0);
        if count == 0 {
            let now = now_ms();
            meta_conn.execute(
                "INSERT INTO workspaces (id, name, theme, icon, sort_order, created_at, updated_at) VALUES ('default','默认空间','#3370FF','',1,?1,?1)",
                params![now],
            )?;
        }
        let active: String = meta_conn
            .query_row(
                "SELECT value FROM sync_state WHERE key = ?1",
                params![ACTIVE_KEY],
                |r| r.get(0),
            )
            .ok()
            .unwrap_or_else(|| {
                meta_conn
                    .query_row("SELECT id FROM workspaces ORDER BY created_at ASC, id ASC LIMIT 1", [], |r| r.get(0))
                    .unwrap_or_else(|_| "default".to_string())
            });
        meta_conn
            .execute(
                "INSERT INTO sync_state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![ACTIVE_KEY, active],
            )
            .ok();
        // App-level device id lives in meta (shared across every space), so the
        // sync outbox from all spaces claims the SAME physical device.
        let dev_count: i64 = meta_conn
            .query_row("SELECT COUNT(*) FROM sync_state WHERE key = 'device_id'", [], |r| r.get(0))
            .unwrap_or(0);
        if dev_count == 0 {
            meta_conn.execute(
                "INSERT INTO sync_state (key, value) VALUES ('device_id', ?1)",
                params![uuid::Uuid::new_v4().to_string()],
            )?;
        }
    }

    // Open the active space's DB as the MAIN connection, then ATTACH meta.db as `meta`.
    let active: String = {
        let meta_conn = Connection::open(meta_path(&app_data_dir))?;
        meta_conn
            .query_row(
                "SELECT value FROM sync_state WHERE key = ?1",
                params![ACTIVE_KEY],
                |r| r.get(0),
            )
            .map_err(|_| rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(1),
                Some("no active workspace".to_string()),
            ))?
    };
    let conn = Connection::open(space_db_path(&app_data_dir, &active))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn, &active)?;
    let meta = meta_path(&app_data_dir).display().to_string().replace('\'', "''");
    conn.execute(&format!("ATTACH DATABASE '{meta}' AS meta"), [])
        .map_err(|e| {
            eprintln!("failed to attach meta db: {e}");
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(1),
                Some(format!("attach meta failed: {e}")),
            )
        })?;
    Ok(conn)
}

/// Schema for the app-level `meta.db` (cross-workspace shared state).
fn meta_migrate(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS workspaces (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            theme       TEXT,
            icon        TEXT NOT NULL DEFAULT '',
            sort_order  REAL NOT NULL DEFAULT 0,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL,
            deleted_at  INTEGER
        );
        CREATE TABLE IF NOT EXISTS sync_state (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS templates (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            category      TEXT NOT NULL DEFAULT '我的模板',
            kind          TEXT NOT NULL DEFAULT 'page',
            icon          TEXT NOT NULL DEFAULT '',
            cover         TEXT NOT NULL DEFAULT '',
            summary       TEXT NOT NULL DEFAULT '',
            content_json  TEXT NOT NULL DEFAULT '{}',
            content_text  TEXT NOT NULL DEFAULT '',
            props_json    TEXT NOT NULL DEFAULT '{}',
            database_json TEXT NOT NULL DEFAULT '{}',
            tags          TEXT NOT NULL DEFAULT '[]',
            built_in      INTEGER NOT NULL DEFAULT 0,
            space_id      TEXT,
            sort_order    REAL NOT NULL DEFAULT 0,
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS plugin_state (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )?;
    Ok(())
}

pub(crate) fn migrate(conn: &Connection, space_id: &str) -> Result<(), rusqlite::Error> {
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
            kind         TEXT NOT NULL DEFAULT 'page',
            sort_order   REAL NOT NULL DEFAULT 0,
            created_at   INTEGER NOT NULL,
            updated_at   INTEGER NOT NULL,
            deleted_at   INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(workspace_id, parent_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_pages_updated ON pages(updated_at);

        CREATE TABLE IF NOT EXISTS templates (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            category      TEXT NOT NULL DEFAULT '我的模板',
            kind          TEXT NOT NULL DEFAULT 'page',
            icon          TEXT NOT NULL DEFAULT '',
            cover         TEXT NOT NULL DEFAULT '',
            summary       TEXT NOT NULL DEFAULT '',
            content_json  TEXT NOT NULL DEFAULT '{}',
            content_text  TEXT NOT NULL DEFAULT '',
            props_json    TEXT NOT NULL DEFAULT '{}',
            database_json TEXT NOT NULL DEFAULT '{}',
            tags          TEXT NOT NULL DEFAULT '[]',
            built_in      INTEGER NOT NULL DEFAULT 0,
            space_id      TEXT,          -- NULL = 应用级（内置）；非空 = 某空间的「我的模板」
            sort_order    REAL NOT NULL DEFAULT 0,
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_templates_space ON templates(space_id);

        CREATE TABLE IF NOT EXISTS db_views (
            id          TEXT PRIMARY KEY,
            db_page_id  TEXT NOT NULL,
            name        TEXT NOT NULL,
            view_type   TEXT NOT NULL,             -- table|kanban|gallery|list|calendar|timeline|directory
            config      TEXT NOT NULL DEFAULT '{}', -- {filter,sort,board_group_attr}
            sort_order  REAL NOT NULL DEFAULT 0,
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_db_views_page ON db_views(db_page_id);

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

        CREATE TABLE IF NOT EXISTS attachments (
            id         TEXT PRIMARY KEY,
            page_id    TEXT,
            name       TEXT NOT NULL,
            hash       TEXT NOT NULL,
            mime       TEXT NOT NULL,
            size       INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_attachments_hash ON attachments(hash);
        CREATE INDEX IF NOT EXISTS idx_attachments_page ON attachments(page_id);

        CREATE TABLE IF NOT EXISTS backlinks (
            source_page_id  TEXT NOT NULL,
            source_block_id TEXT NOT NULL DEFAULT '',
            target_page_id  TEXT NOT NULL,
            target_block_id TEXT NOT NULL DEFAULT '',
            kind            TEXT NOT NULL DEFAULT 'link',
            PRIMARY KEY (source_page_id, source_block_id, target_page_id, target_block_id)
        );

        CREATE TABLE IF NOT EXISTS blocks (
            block_id   TEXT PRIMARY KEY,
            page_id    TEXT NOT NULL REFERENCES pages(id),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_blocks_page ON blocks(page_id);

        CREATE TABLE IF NOT EXISTS attr_defs (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL UNIQUE,
            type       TEXT NOT NULL DEFAULT 'text',
            options    TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS page_props (
            page_id TEXT NOT NULL REFERENCES pages(id),
            attr_id TEXT NOT NULL REFERENCES attr_defs(id),
            value   TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (page_id, attr_id)
        );
        CREATE INDEX IF NOT EXISTS idx_page_props_attr ON page_props(attr_id);

        CREATE TABLE IF NOT EXISTS database_columns (
            db_page_id TEXT NOT NULL REFERENCES pages(id),
            attr_id    TEXT NOT NULL REFERENCES attr_defs(id),
            sort_order REAL NOT NULL DEFAULT 0,
            PRIMARY KEY (db_page_id, attr_id)
        );

        CREATE TABLE IF NOT EXISTS tags (
            id   TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS page_tags (
            page_id TEXT NOT NULL,
            tag_id  TEXT NOT NULL,
            PRIMARY KEY (page_id, tag_id)
        );
        CREATE INDEX IF NOT EXISTS idx_page_tags_tag ON page_tags(tag_id);

        CREATE TABLE IF NOT EXISTS page_versions (
            id           TEXT PRIMARY KEY,
            page_id      TEXT NOT NULL,
            title        TEXT NOT NULL DEFAULT '',
            content_json TEXT NOT NULL DEFAULT '{}',
            content_text TEXT NOT NULL DEFAULT '',
            created_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_page_versions_page ON page_versions(page_id, created_at DESC);
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

    // Add kind column for existing databases (idempotent).
    let has_kind: bool = {
        let mut stmt = conn.prepare("PRAGMA table_info(pages)")?;
        let mut cols = stmt.query_map([], |row| row.get::<_, String>(1))?;
        cols.any(|c| c.map(|name| name == "kind").unwrap_or(false))
    };
    if !has_kind {
        conn.execute(
            "ALTER TABLE pages ADD COLUMN kind TEXT NOT NULL DEFAULT 'page'",
            [],
        )?;
    }

    // Migrate backlinks from the legacy page-level schema (source_id, target_id)
    // to the block-granular schema (source_page_id, source_block_id, ...).
    let has_old_backlinks: bool = {
        let mut stmt = conn.prepare("PRAGMA table_info(backlinks)")?;
        let mut cols = stmt.query_map([], |row| row.get::<_, String>(1))?;
        cols.any(|c| c.map(|name| name == "source_id").unwrap_or(false))
    };
    if has_old_backlinks {
        conn.execute_batch(
            r#"
            ALTER TABLE backlinks RENAME TO backlinks_old;
            CREATE TABLE backlinks (
                source_page_id  TEXT NOT NULL,
                source_block_id TEXT NOT NULL DEFAULT '',
                target_page_id  TEXT NOT NULL,
                target_block_id TEXT NOT NULL DEFAULT '',
                kind            TEXT NOT NULL DEFAULT 'link',
                PRIMARY KEY (source_page_id, source_block_id, target_page_id, target_block_id)
            );
            INSERT INTO backlinks (source_page_id, source_block_id, target_page_id, target_block_id, kind)
            SELECT source_id, '', target_id, '', 'link' FROM backlinks_old;
            DROP TABLE backlinks_old;
            "#,
        )?;
    }

    // Soft-delete column for workspaces (deleting a space is recoverable).
    let ws_has_deleted: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('workspaces') WHERE name = 'deleted_at'",
        [],
        |row| row.get(0),
    )?;
    if ws_has_deleted == 0 {
        conn.execute("ALTER TABLE workspaces ADD COLUMN deleted_at INTEGER", [])?;
    }

    // Per-workspace settings columns (accent color / icon / sort order).
    let ws_has_theme: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('workspaces') WHERE name = 'theme'",
        [],
        |row| row.get(0),
    )?;
    if ws_has_theme == 0 {
        conn.execute("ALTER TABLE workspaces ADD COLUMN theme TEXT", [])?;
    }
    let ws_has_icon: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('workspaces') WHERE name = 'icon'",
        [],
        |row| row.get(0),
    )?;
    if ws_has_icon == 0 {
        conn.execute("ALTER TABLE workspaces ADD COLUMN icon TEXT NOT NULL DEFAULT ''", [])?;
    }
    let ws_has_sort: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('workspaces') WHERE name = 'sort_order'",
        [],
        |row| row.get(0),
    )?;
    if ws_has_sort == 0 {
        conn.execute("ALTER TABLE workspaces ADD COLUMN sort_order REAL NOT NULL DEFAULT 0", [])?;
    }

    // Membership rule for database pages (query-type database: auto-collect by rule).
    let pages_has_db_rule: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('pages') WHERE name = 'db_rule'",
        [],
        |row| row.get(0),
    )?;
    if pages_has_db_rule == 0 {
        conn.execute("ALTER TABLE pages ADD COLUMN db_rule TEXT NOT NULL DEFAULT '{}'", [])?;
    }

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_backlinks_target ON backlinks(target_page_id, target_block_id)",
        [],
    )?;

    // Seed the workspace row for THIS space DB. Each space DB is single-space,
    // so pages.workspace_id = space_id must satisfy the FK (pages references
    // workspaces). Previously this hard-coded 'default', which broke create_workspace.
    let count: i64 =
        conn.query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))?;
    if count == 0 {
        let now = now_ms();
        conn.execute(
            "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![space_id, "默认空间", now, now],
        )?;
    }

    // Migrate legacy placeholder/space names to the neutral space wording
    // (including the app-brand name that was previously used as a default).
    conn.execute(
        "UPDATE workspaces SET name = ?1, updated_at = ?2 WHERE name IN (?3, ?4)",
        params!["默认空间", now_ms(), "默认工作区", "数友笔记"],
    )?;

    Ok(())
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_adds_workspace_settings_columns() {
        let conn = Connection::open_in_memory().unwrap();
        // Fresh DB: workspaces has only id/name/created_at/updated_at initially.
        migrate(&conn, "default").unwrap();
        for col in ["theme", "icon", "sort_order", "deleted_at"] {
            let has: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('workspaces') WHERE name = ?1",
                    params![col],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(has, 1, "workspaces missing expected column: {col}");
        }
        // migrate is idempotent (re-run does not error).
        migrate(&conn, "default").unwrap();
    }

    // A fresh space DB (migrate'd) must accept a page whose workspace_id is the
    // space's own id — create_workspace inserts the home page that way. With
    // foreign_keys=ON this previously failed because migrate only seeded 'default'.
    #[test]
    fn fresh_space_db_accepts_own_workspace_id_page() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn, "ws-abc123").unwrap();
        conn.execute(
            "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at)
             VALUES ('p', 'ws-abc123', NULL, 'start', '{}', '', 'page', 0, 1, 1, NULL)",
            [],
        )
        .unwrap();
        // The page also appears when queried.
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM pages WHERE workspace_id = 'ws-abc123'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    // End-to-end: init meta+default, then reopen_space to a SECOND space and insert
    // that space's home page — the exact path create_workspace takes. Previously this
    // violated the pages.workspace_id FK because migrate only seeded 'default'.
    #[test]
    fn reopen_to_second_space_then_insert_home_page() {
        let dir = std::env::temp_dir().join(format!("shuyonote-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = init(dir.clone()).unwrap();

        let second = "ws-second";
        let mut c = conn;
        reopen_space(&mut c, second).unwrap();
        c.execute(
            "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at)
             VALUES ('home', ?1, NULL, 'start', '{}', '', 'page', 0, 1, 1, NULL)",
            params![second],
        )
        .unwrap();
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM pages WHERE workspace_id = ?1", params![second], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
