use crate::db::Db;
use crate::models::PageMeta;
use rusqlite::{params, Connection, OptionalExtension};
use tauri::State;

// Extract [[Title]] references from plain text.
fn extract_titles(text: &str) -> Vec<String> {
    let mut titles = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i + 1 < chars.len() {
        if chars[i] == '[' && chars[i + 1] == '[' {
            let mut j = i + 2;
            let mut title = String::new();
            let mut closed = false;
            while j < chars.len() {
                if chars[j] == ']' && j + 1 < chars.len() && chars[j + 1] == ']' {
                    closed = true;
                    break;
                }
                title.push(chars[j]);
                j += 1;
            }
            if closed {
                let trimmed = title.trim();
                if !trimmed.is_empty() {
                    titles.push(trimmed.to_string());
                }
                i = j + 2;
            } else {
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    titles
}

// Rebuild backlinks for a source page: remove stale, resolve titles to page ids, insert.
pub fn rebuild_backlinks(c: &Connection, source_id: &str, content_text: &str) -> Result<(), String> {
    c.execute("DELETE FROM backlinks WHERE source_id = ?1", params![source_id])
        .map_err(|e| e.to_string())?;

    for title in extract_titles(content_text) {
        let target_id: Option<String> = c
            .query_row(
                "SELECT id FROM pages WHERE title = ?1 AND kind = 'page' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1",
                params![title],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        if let Some(target_id) = target_id {
            if target_id != source_id {
                c.execute(
                    "INSERT OR IGNORE INTO backlinks (source_id, target_id) VALUES (?1, ?2)",
                    params![source_id, target_id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

// Remove all backlinks involving a set of page ids (as source or target).
pub fn remove_backlinks(c: &Connection, ids: &[String]) -> Result<(), String> {
    for id in ids {
        c.execute("DELETE FROM backlinks WHERE source_id = ?1 OR target_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_backlinks(db: State<'_, Db>, id: String) -> Result<Vec<PageMeta>, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    let mut stmt = c
        .prepare(
            "SELECT p.id, p.workspace_id, p.parent_id, p.title, p.kind, p.sort_order, p.created_at, p.updated_at, p.deleted_at
             FROM backlinks b JOIN pages p ON b.source_id = p.id
             WHERE b.target_id = ?1 AND p.deleted_at IS NULL
             ORDER BY p.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![id], |row| {
            Ok(PageMeta {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                parent_id: row.get(2)?,
                title: row.get(3)?,
                kind: row.get(4)?,
                sort_order: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                deleted_at: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::extract_titles;

    #[test]
    fn test_extract_titles() {
        assert_eq!(extract_titles("见 [[项目A]] 和 [[B]]"), vec!["项目A", "B"]);
        assert_eq!(extract_titles("无引用"), Vec::<String>::new());
        assert_eq!(extract_titles("[[未闭合"), Vec::<String>::new());
    }
}
