use crate::db::Db;
use crate::models::{AttrDef, BoardGroup, DatabaseQuery, DatabaseRow, DbViewMeta, PageMeta};
use crate::properties::parse_options;
use crate::db::now_ms;
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

    let mut rows: Vec<DatabaseRow> = pages
        .into_iter()
        .map(|(page_id, title)| DatabaseRow {
            values: prop_map.remove(&page_id).unwrap_or_default(),
            page_id,
            title,
        })
        .collect();

    // `tag` type columns read from the real tags system.
    let tag_cols: Vec<String> = columns
        .iter()
        .filter(|c| c.attr_type == "tag")
        .map(|c| c.id.clone())
        .collect();
    if !tag_cols.is_empty() {
        let mut stmt = c
            .prepare(
                "SELECT pt.page_id, t.name FROM page_tags pt JOIN tags t ON t.id = pt.tag_id
                 ORDER BY t.name",
            )
            .map_err(|e| e.to_string())?;
        let tag_rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let mut tag_map: HashMap<String, Vec<String>> = HashMap::new();
        for (page_id, name) in tag_rows {
            tag_map.entry(page_id).or_default().push(name);
        }
        for row in rows.iter_mut() {
            if let Some(names) = tag_map.get(&row.page_id) {
                let joined = names.join(", ");
                for col_id in &tag_cols {
                    row.values.insert(col_id.clone(), joined.clone());
                }
            }
        }
    }

    // Membership rule (query-type database): keep only pages matching the rule.
    if let Some(ids) = matching_page_ids(&c, &db_rule(&c, &db_page_id)?)? {
        rows.retain(|r| ids.contains(&r.page_id));
    }

    Ok(DatabaseQuery { columns, rows })
}

fn db_rule(c: &Connection, db_page_id: &str) -> Result<String, String> {
    let v = c
        .query_row("SELECT db_rule FROM pages WHERE id = ?1", params![db_page_id], |r| r.get::<_, String>(0))
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "{}".to_string());
    Ok(v)
}

fn set_intersect(cur: Option<Vec<String>>, next: Vec<String>) -> Option<Vec<String>> {
    match cur {
        None => Some(next),
        Some(prev) => Some(prev.into_iter().filter(|id| next.contains(id)).collect()),
    }
}

fn prop_page_ids(c: &Connection, name: &str, value: &str) -> Result<Vec<String>, String> {
    let mut stmt = c
        .prepare(
            "SELECT pp.page_id FROM page_props pp JOIN attr_defs a ON a.id = pp.attr_id
             WHERE a.name = ?1 AND pp.value = ?2",
        )
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map(params![name, value], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(ids)
}

fn tag_page_ids(c: &Connection, tag: &str) -> Result<Vec<String>, String> {
    let mut stmt = c
        .prepare(
            "SELECT pt.page_id FROM page_tags pt JOIN tags t ON t.id = pt.tag_id
             WHERE t.name = ?1",
        )
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map(params![tag], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(ids)
}

/// Evaluate a rule JSON `{ "prop": {name,value}, "tag": "name" }` (AND) into the
/// set of matching page ids; `None` when no rule is set (no filter).
fn matching_page_ids(c: &Connection, rule: &str) -> Result<Option<Vec<String>>, String> {
    let trimmed = rule.trim();
    if trimmed.is_empty() || trimmed == "{}" {
        return Ok(None);
    }
    let parsed: serde_json::Value = serde_json::from_str(trimmed).map_err(|e| e.to_string())?;
    let mut all: Option<Vec<String>> = None;
    if let Some(prop) = parsed.get("prop") {
        let name = prop.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let value = prop.get("value").and_then(|v| v.as_str()).unwrap_or("");
        if !name.is_empty() {
            all = set_intersect(all, prop_page_ids(c, name, value)?);
        }
    }
    if let Some(tag) = parsed.get("tag").and_then(|v| v.as_str()) {
        if !tag.is_empty() {
            all = set_intersect(all, tag_page_ids(c, tag)?);
        }
    }
    Ok(all)
}

#[tauri::command]
pub fn set_db_rule(db: State<'_, Db>, db_page_id: String, rule: String) -> Result<(), String> {
    let c = conn(&db);
    serde_json::from_str::<serde_json::Value>(&rule)
        .map_err(|e| format!("规则格式错误: {e}"))?;
    let n = c
        .execute(
            "UPDATE pages SET db_rule = ?1 WHERE id = ?2 AND kind = 'database'",
            params![rule, db_page_id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("该数据库页不存在".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn get_db_rule(db: State<'_, Db>, db_page_id: String) -> Result<String, String> {
    let c = conn(&db);
    db_rule(&c, &db_page_id)
}

/// Resolve page-reference values (`p:<id>`) to their target page titles.
#[tauri::command]
pub fn resolve_refs(db: State<'_, Db>, values: Vec<String>) -> Result<HashMap<String, String>, String> {
    let c = conn(&db);
    let mut out: HashMap<String, String> = HashMap::new();
    for v in values {
        if let Some(pid) = v.strip_prefix("p:") {
            let title: Option<String> = c
                .query_row(
                    "SELECT title FROM pages WHERE id = ?1 AND deleted_at IS NULL",
                    params![pid],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let label = title
                .map(|t| format!("⇄ {t}"))
                .unwrap_or_else(|| "已失效引用".to_string());
            out.insert(v, label);
        } else {
            out.insert(v.clone(), v);
        }
    }
    Ok(out)
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

fn row_to_view(row: &rusqlite::Row) -> rusqlite::Result<DbViewMeta> {
    Ok(DbViewMeta {
        id: row.get(0)?,
        db_page_id: row.get(1)?,
        name: row.get(2)?,
        view_type: row.get(3)?,
        config: row.get(4)?,
        sort_order: row.get(5)?,
        created_at: row.get(6)?,
    })
}

#[tauri::command]
pub fn list_db_views(db: State<'_, Db>, db_page_id: String) -> Result<Vec<DbViewMeta>, String> {
    let c = conn(&db);
    let mut stmt = c
        .prepare(
            "SELECT id, db_page_id, name, view_type, config, sort_order, created_at
             FROM db_views WHERE db_page_id = ?1 ORDER BY sort_order ASC, created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let mapped = stmt
        .query_map(params![db_page_id], |row| row_to_view(row))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in mapped {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[derive(Deserialize)]
pub struct SaveDbViewArgs {
    pub db_page_id: String,
    pub name: String,
    pub view_type: String,
    pub config: String,
}

#[tauri::command]
pub fn save_db_view(db: State<'_, Db>, args: SaveDbViewArgs) -> Result<DbViewMeta, String> {
    let c = conn(&db);
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let next: f64 = c
        .query_row(
            "SELECT COALESCE(MAX(sort_order),0) + 1 FROM db_views WHERE db_page_id = ?1",
            params![args.db_page_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    c.execute(
        "INSERT INTO db_views (id, db_page_id, name, view_type, config, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, args.db_page_id, args.name, args.view_type, args.config, next, now],
    )
    .map_err(|e| e.to_string())?;
    c.query_row(
        "SELECT id, db_page_id, name, view_type, config, sort_order, created_at FROM db_views WHERE id = ?1",
        params![id],
        |row| row_to_view(row),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_db_view(db: State<'_, Db>, id: String) -> Result<(), String> {
    let c = conn(&db);
    c.execute("DELETE FROM db_views WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
