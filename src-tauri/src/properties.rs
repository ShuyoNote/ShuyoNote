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

#[tauri::command]
pub fn set_page_prop(db: State<'_, Db>, args: SetPagePropArgs) -> Result<(), String> {
    let c = conn(&db);
    c.execute(
        "INSERT INTO page_props (page_id, attr_id, value) VALUES (?1, ?2, ?3)
         ON CONFLICT(page_id, attr_id) DO UPDATE SET value = excluded.value",
        params![args.page_id, args.attr_id, args.value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_page_prop(db: State<'_, Db>, page_id: String, attr_id: String) -> Result<(), String> {
    let c = conn(&db);
    c.execute(
        "DELETE FROM page_props WHERE page_id = ?1 AND attr_id = ?2",
        params![page_id, attr_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_page_props(db: State<'_, Db>, page_id: String) -> Result<Vec<PageProp>, String> {
    let c = conn(&db);
    let mut stmt = c
        .prepare(
            "SELECT a.id, a.name, a.type, a.options, p.value
             FROM page_props p JOIN attr_defs a ON a.id = p.attr_id
             WHERE p.page_id = ?1
             ORDER BY a.name",
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
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}
