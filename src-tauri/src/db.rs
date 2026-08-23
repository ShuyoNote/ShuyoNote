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

pub(crate) fn migrate(conn: &Connection) -> Result<(), rusqlite::Error> {
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

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_backlinks_target ON backlinks(target_page_id, target_block_id)",
        [],
    )?;

    // Ensure a default workspace exists. The sidebar logo area shows the
    // workspace (space) name — not the app brand — so default to a neutral
    // space name that the user can rename.
    let count: i64 =
        conn.query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))?;
    if count == 0 {
        let now = now_ms();
        conn.execute(
            "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params!["default", "默认空间", now, now],
        )?;
    }

    // Migrate legacy placeholder/space names to the neutral space wording
    // (including the app-brand name that was previously used as a default).
    conn.execute(
        "UPDATE workspaces SET name = ?1, updated_at = ?2 WHERE name IN (?3, ?4)",
        params!["默认空间", now_ms(), "默认工作区", "数友笔记"],
    )?;

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
