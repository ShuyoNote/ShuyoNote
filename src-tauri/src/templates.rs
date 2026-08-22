use crate::db::{now_ms, Db};
use crate::models::TemplateMeta;
use rusqlite::{params, Connection};
use std::sync::MutexGuard;
use tauri::State;

fn conn<'a>(db: &'a State<'_, Db>) -> MutexGuard<'a, Connection> {
    db.0.lock().unwrap()
}

fn row_to_meta(row: &rusqlite::Row) -> rusqlite::Result<TemplateMeta> {
    Ok(TemplateMeta {
        id: row.get(0)?,
        name: row.get(1)?,
        category: row.get(2)?,
        kind: row.get(3)?,
        icon: row.get(4)?,
        cover: row.get(5)?,
        summary: row.get(6)?,
        content_json: row.get(7)?,
        content_text: row.get(8)?,
        built_in: row.get(9)?,
        space_id: row.get(10)?,
        sort_order: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

const COLS: &str = "id,name,category,kind,icon,cover,summary,content_json,content_text,built_in,space_id,sort_order,created_at,updated_at";

/// List user templates ("我的模板"), optionally scoped to a space.
/// Built-in templates live on the frontend (M9.1); this returns only `built_in=0`.
#[tauri::command]
pub fn list_templates(db: State<Db>, space_id: Option<String>) -> Result<Vec<TemplateMeta>, String> {
    let c = conn(&db);
    let sql = format!(
        "SELECT {COLS} FROM templates WHERE built_in = 0 AND (?1 IS NULL OR space_id = ?1) ORDER BY sort_order ASC, created_at ASC"
    );
    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let mapped = stmt
        .query_map(params![space_id], |row| row_to_meta(row))
        .map_err(|e| e.to_string())?;
    let mut out: Vec<TemplateMeta> = Vec::new();
    for row in mapped {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[derive(serde::Deserialize)]
pub struct SaveAsTemplateArgs {
    pub name: String,
    pub category: Option<String>,
    pub icon: Option<String>,
    pub cover: Option<String>,
    pub summary: Option<String>,
    pub content_json: String,
    pub content_text: Option<String>,
    pub space_id: Option<String>,
}

#[tauri::command]
pub fn save_as_template(db: State<Db>, args: SaveAsTemplateArgs) -> Result<TemplateMeta, String> {
    let c = conn(&db);
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let next_sort: f64 = c
        .query_row(
            "SELECT COALESCE(MAX(sort_order),0) + 1 FROM templates WHERE built_in = 0",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    c.execute(
        "INSERT INTO templates (id, name, category, kind, icon, cover, summary, content_json, content_text, props_json, database_json, tags, built_in, space_id, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'page', ?4, ?5, ?6, ?7, ?8, '{}', '{}', '[]', 0, ?9, ?10, ?11, ?12)",
        params![
            id,
            args.name,
            args.category.unwrap_or_else(|| "我的模板".to_string()),
            args.icon.unwrap_or_default(),
            args.cover.unwrap_or_default(),
            args.summary.unwrap_or_default(),
            args.content_json,
            args.content_text.unwrap_or_default(),
            args.space_id,
            next_sort,
            now,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    c.query_row(
        &format!("SELECT {COLS} FROM templates WHERE id = ?1"),
        params![id],
        |row| row_to_meta(row),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_template(db: State<Db>, id: String) -> Result<(), String> {
    let c = conn(&db);
    let n = c
        .execute("DELETE FROM templates WHERE id = ?1 AND built_in = 0", params![id])
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("模板不存在或为内置模板".to_string());
    }
    Ok(())
}
