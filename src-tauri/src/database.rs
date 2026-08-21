use crate::db::Db;
use crate::models::{AttrDef, BoardGroup, DatabaseQuery, DatabaseRow, PageMeta};
use crate::properties::parse_options;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::MutexGuard;
use tauri::State;

fn conn<'a>(db: &'a State<'_, Db>) -> MutexGuard<'a, Connection> {
    db.0.lock().expect("db mutex poisoned")
}

fn db_columns(c: &Connection, db_page_id: &str) -> Result<Vec<AttrDef>, String> {
    let mut stmt = c
        .prepare(
            "SELECT a.id, a.name, a.type, a.options
             FROM database_columns dc JOIN attr_defs a ON a.id = dc.attr_id
             WHERE dc.db_page_id = ?1
             ORDER BY dc.sort_order, a.name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![db_page_id], |r| {
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

#[tauri::command]
pub fn get_db_columns(db: State<'_, Db>, db_page_id: String) -> Result<Vec<AttrDef>, String> {
    let c = conn(&db);
    db_columns(&c, &db_page_id)
}

#[derive(Deserialize)]
pub struct DbColumnArgs {
    pub db_page_id: String,
    pub attr_id: String,
}

#[tauri::command]
pub fn add_db_column(db: State<'_, Db>, args: DbColumnArgs) -> Result<Vec<AttrDef>, String> {
    let c = conn(&db);
    let sort_order: f64 = c
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM database_columns WHERE db_page_id = ?1",
            params![args.db_page_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    c.execute(
        "INSERT OR IGNORE INTO database_columns (db_page_id, attr_id, sort_order) VALUES (?1, ?2, ?3)",
        params![args.db_page_id, args.attr_id, sort_order],
    )
    .map_err(|e| e.to_string())?;
    db_columns(&c, &args.db_page_id)
}

#[tauri::command]
pub fn remove_db_column(db: State<'_, Db>, args: DbColumnArgs) -> Result<Vec<AttrDef>, String> {
    let c = conn(&db);
    c.execute(
        "DELETE FROM database_columns WHERE db_page_id = ?1 AND attr_id = ?2",
        params![args.db_page_id, args.attr_id],
    )
    .map_err(|e| e.to_string())?;
    db_columns(&c, &args.db_page_id)
}

#[tauri::command]
pub fn query_database(db: State<'_, Db>, db_page_id: String) -> Result<DatabaseQuery, String> {
    let c = conn(&db);
    let columns = db_columns(&c, &db_page_id)?;
    let attr_ids: Vec<String> = columns.iter().map(|a| a.id.clone()).collect();

    let mut stmt = c
        .prepare(
            "SELECT id, title FROM pages WHERE kind = 'page' AND deleted_at IS NULL ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let pages: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    // Load all props once, filter to the column attributes.
    let mut pstmt = c
        .prepare("SELECT page_id, attr_id, value FROM page_props")
        .map_err(|e| e.to_string())?;
    let all_props: Vec<(String, String, String)> = pstmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let mut prop_map: HashMap<String, HashMap<String, String>> = HashMap::new();
    for (page_id, attr_id, value) in all_props {
        if attr_ids.contains(&attr_id) {
            prop_map
                .entry(page_id)
                .or_default()
                .insert(attr_id, value);
        }
    }

    let rows: Vec<DatabaseRow> = pages
        .into_iter()
        .map(|(page_id, title)| DatabaseRow {
            values: prop_map.remove(&page_id).unwrap_or_default(),
            page_id,
            title,
        })
        .collect();

    Ok(DatabaseQuery { columns, rows })
}

fn list_page_metas(c: &Connection) -> Result<Vec<PageMeta>, String> {
    let mut stmt = c
        .prepare(
            "SELECT id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at
             FROM pages WHERE kind = 'page' AND deleted_at IS NULL
             ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PageMeta {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                parent_id: r.get(2)?,
                title: r.get(3)?,
                kind: r.get(4)?,
                sort_order: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
                deleted_at: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// Board grouped by a `select` attribute: one column per option + an "unset" column.
#[tauri::command]
pub fn board_by_attr(db: State<'_, Db>, attr_id: String) -> Result<Vec<BoardGroup>, String> {
    let c = conn(&db);
    let options_json: String = c
        .query_row(
            "SELECT options FROM attr_defs WHERE id = ?1",
            params![attr_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "属性不存在".to_string())?;
    let options = parse_options(&options_json);

    let pages = list_page_metas(&c)?;

    let mut stmt = c
        .prepare("SELECT page_id, value FROM page_props WHERE attr_id = ?1")
        .map_err(|e| e.to_string())?;
    let values: HashMap<String, String> = stmt
        .query_map(params![attr_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let mut groups: Vec<BoardGroup> = options
        .iter()
        .map(|o| BoardGroup {
            id: o.clone(),
            name: o.clone(),
            pages: Vec::new(),
        })
        .collect();
    let mut unset: Vec<PageMeta> = Vec::new();

    for page in pages {
        match values.get(&page.id) {
            Some(v) if !v.is_empty() => {
                if let Some(g) = groups.iter_mut().find(|g| g.id == *v) {
                    g.pages.push(page);
                }
            }
            _ => unset.push(page),
        }
    }

    groups.push(BoardGroup {
        id: "__none".to_string(),
        name: "未设置".to_string(),
        pages: unset,
    });
    Ok(groups)
}
