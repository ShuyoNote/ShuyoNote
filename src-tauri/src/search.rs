use crate::db::Db;
use crate::models::SearchResult;
use rusqlite::{params, Connection};
use serde::Deserialize;
use tauri::State;

// Sync the FTS index for a page (upsert = delete + insert).
pub fn sync_fts(c: &Connection, id: &str, title: &str, body: &str) -> Result<(), String> {
    c.execute("DELETE FROM page_fts WHERE page_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    c.execute(
        "INSERT INTO page_fts (page_id, title, body) VALUES (?1, ?2, ?3)",
        params![id, title, body],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn remove_fts(c: &Connection, id: &str) -> Result<(), String> {
    c.execute("DELETE FROM page_fts WHERE page_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn build_like_snippet(text: &str, query: &str, max_len: usize) -> String {
    let lower = text.to_lowercase();
    let q = query.to_lowercase();
    if let Some(pos) = lower.find(&q) {
        // Build snippet around the first match, on char boundaries.
        let start = pos.saturating_sub(20);
        let end = (pos + q.len() + 40).min(text.len());
        let mut out = String::new();
        if start > 0 {
            out.push('…');
        }
        out.push_str(&text[start..end]);
        if end < text.len() {
            out.push('…');
        }
        truncate(&out, max_len)
    } else {
        truncate(text, max_len)
    }
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max_chars).collect();
        out.push('…');
        out
    }
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

#[derive(Deserialize)]
pub struct SearchArgs {
    pub query: String,
    pub limit: Option<usize>,
}

#[tauri::command]
pub fn search(db: State<Db>, args: SearchArgs) -> Result<Vec<SearchResult>, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    let query = args.query.trim();
    let limit = args.limit.unwrap_or(50).min(200);
    if query.is_empty() {
        return Ok(vec![]);
    }

    // trigram tokenizer needs >=3 chars to match; fall back to LIKE for short queries.
    if query.chars().count() < 3 {
        return search_like(&c, query, limit);
    }
    search_fts(&c, query, limit)
}

fn search_fts(c: &Connection, query: &str, limit: usize) -> Result<Vec<SearchResult>, String> {
    // Wrap as a phrase for substring matching; strip embedded double quotes.
    let phrase = format!("\"{}\"", query.replace('"', ""));
    let mut stmt = c
        .prepare(
            "SELECT page_id, title,
                    snippet(page_fts, 2, '[[', ']]', '…', 24) AS body_snip,
                    snippet(page_fts, 1, '[[', ']]', '…', 12) AS title_snip
             FROM page_fts WHERE page_fts MATCH ?1 ORDER BY rank LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![phrase, limit as i64], |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let body_snip: String = row.get(2)?;
            let title_snip: String = row.get(3)?;
            let snippet = if body_snip.trim().is_empty() {
                if title_snip.trim().is_empty() {
                    title.clone()
                } else {
                    title_snip
                }
            } else {
                body_snip
            };
            Ok(SearchResult { id, title, snippet })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn search_like(c: &Connection, query: &str, limit: usize) -> Result<Vec<SearchResult>, String> {
    let pattern = format!("%{}%", escape_like(query));
    let mut stmt = c
        .prepare(
            "SELECT id, title, content_text FROM pages
             WHERE deleted_at IS NULL AND (title LIKE ?1 ESCAPE '\\' OR content_text LIKE ?1 ESCAPE '\\')
             ORDER BY updated_at DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;

    let q = query.to_string();
    let rows = stmt
        .query_map(params![pattern, limit as i64], move |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let text: String = row.get(2)?;
            let snippet = build_like_snippet(&text, &q, 120);
            Ok(SearchResult { id, title, snippet })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}
