use crate::db::{now_ms, Db};
use crate::models::{AttrDef, PageProp};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::sync::MutexGuard;
use tauri::State;

fn conn<'a>(db: &'a State<'_, Db>) -> MutexGuard<'a, Connection> {
    db.0.lock().expect("db mutex poisoned")
}

pub(crate) fn parse_options(json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(json).unwrap_or_default()
}

fn attr_type(c: &Connection, attr_id: &str) -> Result<Option<String>, String> {
    c.query_row("SELECT type FROM attr_defs WHERE id = ?1", params![attr_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

fn page_tags_joined(c: &Connection, page_id: &str) -> Result<String, String> {
    let mut stmt = c
        .prepare(
            "SELECT t.name FROM page_tags pt JOIN tags t ON t.id = pt.tag_id
             WHERE pt.page_id = ?1 ORDER BY t.name",
        )
        .map_err(|e| e.to_string())?;
    let names: Vec<String> = stmt
        .query_map(params![page_id], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(names.join(", "))
}

fn parse_tag_names(value: &str) -> Vec<String> {
    value
        .split(|c: char| c == ',' || c == '，')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

// Write a page's tags from a comma-separated value (get-or-create each tag).
fn sync_page_tags(c: &Connection, page_id: &str, value: &str) -> Result<(), String> {
    c.execute("DELETE FROM page_tags WHERE page_id = ?1", params![page_id])
        .map_err(|e| e.to_string())?;
    for name in parse_tag_names(value) {
        let tag_id: Option<String> = c
            .query_row("SELECT id FROM tags WHERE name = ?1", params![name], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        let tag_id = match tag_id {
            Some(id) => id,
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                c.execute("INSERT INTO tags (id, name) VALUES (?1, ?2)", params![id, name])
                    .map_err(|e| e.to_string())?;
                id
            }
        };
        c.execute(
            "INSERT OR IGNORE INTO page_tags (page_id, tag_id) VALUES (?1, ?2)",
            params![page_id, tag_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_attr_defs(db: State<'_, Db>) -> Result<Vec<AttrDef>, String> {
    let c = conn(&db);
    let mut stmt = c
        .prepare("SELECT id, name, type, options FROM attr_defs ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AttrDef {
                id: r.get(0)?,
                name: r.get(1)?,
                attr_type: r.get(2)?,
                options: parse_options(&r.get::<_, String>(3)?),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct CreateAttrArgs {
    pub name: String,
    #[serde(default = "default_type")]
    pub attr_type: String,
    #[serde(default)]
    pub options: Vec<String>,
}

fn default_type() -> String {
    "text".to_string()
}

#[tauri::command]
pub fn create_attr(db: State<'_, Db>, args: CreateAttrArgs) -> Result<AttrDef, String> {
    let c = conn(&db);
    let name = args.name.trim().to_string();
    if name.is_empty() {
        return Err("属性名不能为空".to_string());
    }
    let exists: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM attr_defs WHERE name = ?1",
            params![name],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists > 0 {
        return Err("属性已存在".to_string());
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let options_json =
        serde_json::to_string(&args.options).unwrap_or_else(|_| "[]".to_string());

    c.execute(
        "INSERT INTO attr_defs (id, name, type, options, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, args.attr_type, options_json, now, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(AttrDef {
        id,
        name,
        attr_type: args.attr_type,
        options: args.options,
    })
}

#[derive(Deserialize)]
pub struct UpdateAttrArgs {
    pub id: String,
    #[serde(default)]
    pub options: Vec<String>,
}

#[tauri::command]
pub fn update_attr(db: State<'_, Db>, args: UpdateAttrArgs) -> Result<AttrDef, String> {
    let c = conn(&db);
    let options_json = serde_json::to_string(&args.options).unwrap_or_else(|_| "[]".to_string());
    let now = now_ms();
    c.execute(
        "UPDATE attr_defs SET options = ?1, updated_at = ?2 WHERE id = ?3",
        params![options_json, now, args.id],
    )
    .map_err(|e| e.to_string())?;

    let (id, name, attr_type): (String, String, String) = c
        .query_row(
            "SELECT id, name, type FROM attr_defs WHERE id = ?1",
            params![args.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "属性不存在".to_string())?;

    Ok(AttrDef {
        id,
        name,
        attr_type,
        options: args.options,
    })
}

#[tauri::command]
pub fn delete_attr(db: State<'_, Db>, id: String) -> Result<(), String> {
    let c = conn(&db);
    c.execute("DELETE FROM page_props WHERE attr_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    c.execute("DELETE FROM attr_defs WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Deserialize)]
pub struct SetPagePropArgs {
    pub page_id: String,
    pub attr_id: String,
    #[serde(default)]
    pub value: String,
}

pub(crate) fn set_page_prop_impl(c: &Connection, page_id: &str, attr_id: &str, value: &str) -> Result<(), String> {
    if attr_type(c, attr_id)?.as_deref() == Some("tag") {
        // `tag` type is a view over the real tags system.
        sync_page_tags(c, page_id, value)?;
    } else {
        c.execute(
            "INSERT INTO page_props (page_id, attr_id, value) VALUES (?1, ?2, ?3)
             ON CONFLICT(page_id, attr_id) DO UPDATE SET value = excluded.value",
            params![page_id, attr_id, value],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_page_prop(db: State<'_, Db>, args: SetPagePropArgs) -> Result<(), String> {
    let c = conn(&db);
    set_page_prop_impl(&c, &args.page_id, &args.attr_id, &args.value)
}

pub(crate) fn remove_page_prop_impl(c: &Connection, page_id: &str, attr_id: &str) -> Result<(), String> {
    if attr_type(c, attr_id)?.as_deref() == Some("tag") {
        sync_page_tags(c, page_id, "")?;
    } else {
        c.execute(
            "DELETE FROM page_props WHERE page_id = ?1 AND attr_id = ?2",
            params![page_id, attr_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn remove_page_prop(db: State<'_, Db>, page_id: String, attr_id: String) -> Result<(), String> {
    let c = conn(&db);
    remove_page_prop_impl(&c, &page_id, &attr_id)
}

pub(crate) fn get_page_props_impl(c: &Connection, page_id: &str) -> Result<Vec<PageProp>, String> {
    let mut props: Vec<PageProp> = {
        let mut stmt = c
            .prepare(
                "SELECT a.id, a.name, a.type, a.options, p.value
                 FROM page_props p JOIN attr_defs a ON a.id = p.attr_id
                 WHERE p.page_id = ?1 AND a.type != 'tag'",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![page_id], |r| {
                Ok(PageProp {
                    attr_id: r.get(0)?,
                    name: r.get(1)?,
                    attr_type: r.get(2)?,
                    options: parse_options(&r.get::<_, String>(3)?),
                    value: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };

    // `tag` type attributes are views over the real tags system.
    let tags_joined = page_tags_joined(c, page_id)?;
    let mut stmt = c
        .prepare("SELECT id, name, type, options FROM attr_defs WHERE type = 'tag' ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (attr_id, name, attr_type, options_json) = row.map_err(|e| e.to_string())?;
        props.push(PageProp {
            attr_id,
            name,
            attr_type,
            options: parse_options(&options_json),
            value: tags_joined.clone(),
        });
    }

    props.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(props)
}

#[tauri::command]
pub fn get_page_props(db: State<'_, Db>, page_id: String) -> Result<Vec<PageProp>, String> {
    let c = conn(&db);
    get_page_props_impl(&c, &page_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn setup() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE pages (id TEXT PRIMARY KEY);
             CREATE TABLE attr_defs (
               id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
               type TEXT NOT NULL DEFAULT 'text', options TEXT NOT NULL DEFAULT '[]',
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
             );
             CREATE TABLE page_props (
               page_id TEXT NOT NULL REFERENCES pages(id),
               attr_id TEXT NOT NULL REFERENCES attr_defs(id),
               value TEXT NOT NULL DEFAULT '',
               PRIMARY KEY (page_id, attr_id)
             );",
        )
        .unwrap();
        c.execute("INSERT INTO pages (id) VALUES ('p1')", []).unwrap();
        c.execute(
            "INSERT INTO attr_defs (id, name, type, options, created_at, updated_at) VALUES ('a1','名称','text','[]',0,0)",
            [],
        )
        .unwrap();
        c
    }

    #[test]
    fn page_props_set_get_delete() {
        let c = setup();
        // set
        c.execute(
            "INSERT INTO page_props (page_id, attr_id, value) VALUES ('p1','a1','hello')
             ON CONFLICT(page_id, attr_id) DO UPDATE SET value = excluded.value",
            [],
        )
        .unwrap();
        let v: String = c
            .query_row("SELECT value FROM page_props WHERE page_id='p1' AND attr_id='a1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, "hello");

        // update
        c.execute(
            "INSERT INTO page_props (page_id, attr_id, value) VALUES ('p1','a1','world')
             ON CONFLICT(page_id, attr_id) DO UPDATE SET value = excluded.value",
            [],
        )
        .unwrap();
        let v2: String = c
            .query_row("SELECT value FROM page_props WHERE page_id='p1' AND attr_id='a1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v2, "world");

        // delete
        let n = c
            .execute("DELETE FROM page_props WHERE page_id='p1' AND attr_id='a1'", [])
            .unwrap();
        assert_eq!(n, 1);
        let count: i64 = c
            .query_row("SELECT COUNT(*) FROM page_props WHERE page_id='p1' AND attr_id='a1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    // End-to-end against the REAL migrate() schema with FKs enforced, using the
    // actual command impl functions. This is ground truth for the property
    // persistence path.
    #[test]
    fn real_schema_prop_roundtrip() {
        use crate::db::migrate;
        use crate::models::PageProp;

        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "synchronous", "NORMAL").unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();

        let now = 1_000_000_000i64;
        // workspace (pages has FK to workspaces)
        conn.execute(
            "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws','默认空间',?1,?1)",
            params![now],
        )
        .unwrap();
        let page_id = "p1";
        conn.execute(
            "INSERT INTO pages (id, workspace_id, title, created_at, updated_at) VALUES (?1,'ws','测试页',?2,?2)",
            params![page_id, now],
        )
        .unwrap();
        let attr_id = "a1";
        conn.execute(
            "INSERT INTO attr_defs (id, name, type, options, created_at, updated_at) VALUES (?1,'标题属性','text','[]',?2,?2)",
            params![attr_id, now],
        )
        .unwrap();

        // set
        set_page_prop_impl(&conn, page_id, attr_id, "hello").unwrap();
        let props = get_page_props_impl(&conn, page_id).unwrap();
        assert_eq!(
            props.iter().map(|p: &PageProp| (p.attr_id.as_str(), p.value.as_str())).collect::<Vec<_>>(),
            vec![("a1", "hello")]
        );

        // update
        set_page_prop_impl(&conn, page_id, attr_id, "world").unwrap();
        let props = get_page_props_impl(&conn, page_id).unwrap();
        assert_eq!(props[0].value, "world");

        // delete -> gone
        remove_page_prop_impl(&conn, page_id, attr_id).unwrap();
        let props = get_page_props_impl(&conn, page_id).unwrap();
        assert!(props.is_empty());

        // delete idempotent (silent no-op, no error)
        remove_page_prop_impl(&conn, page_id, attr_id).unwrap();

        // tag-type attr -> remove clears page_tags, doesn't delete the attr view
        let tag_attr = "t1";
        conn.execute(
            "INSERT INTO attr_defs (id, name, type, options, created_at, updated_at) VALUES (?1,'归档','tag','[]',?2,?2)",
            params![tag_attr, now],
        )
        .unwrap();
        set_page_prop_impl(&conn, page_id, tag_attr, "进行中").unwrap();
        let props = get_page_props_impl(&conn, page_id).unwrap();
        assert!(props.iter().any(|p| p.attr_type == "tag" && p.value == "进行中"));
        remove_page_prop_impl(&conn, page_id, tag_attr).unwrap();
        let tags_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM page_tags WHERE page_id = ?1", params![page_id], |r| r.get(0))
            .unwrap();
        assert_eq!(tags_after, 0);
        // the tag property view is still synthesized (attr still in attr_defs)
        let props = get_page_props_impl(&conn, page_id).unwrap();
        assert!(props.iter().any(|p| p.attr_type == "tag"));
    }
}
