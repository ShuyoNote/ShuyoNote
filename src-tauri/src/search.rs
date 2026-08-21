use crate::db::Db;
use crate::models::SearchResult;
use rusqlite::{params, Connection};
use serde::Deserialize;
use std::collections::HashSet;
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

// Split a query into a text part + `prop:名称=值` filters.
fn parse_prop_filters(query: &str) -> (String, Vec<(String, String)>) {
    let mut text = Vec::new();
    let mut filters = Vec::new();
    for token in query.split_whitespace() {
        if let Some(rest) = token.strip_prefix("prop:") {
            if let Some((name, value)) = rest.split_once('=') {
                let name = name.trim();
                let value = value.trim();
                if !name.is_empty() {
                    filters.push((name.to_string(), value.to_string()));
                    continue;
                }
            }
        }
        text.push(token);
    }
    (text.join(" "), filters)
}

// Page ids matching ALL the given prop filters (intersection).
fn pages_matching_filters(
    c: &Connection,
    filters: &[(String, String)],
) -> Result<HashSet<String>, String> {
    let mut stmt = c
        .prepare(
            "SELECT pp.page_id
             FROM page_props pp JOIN attr_defs a ON a.id = pp.attr_id
             WHERE a.name = ?1 AND pp.value = ?2",
        )
        .map_err(|e| e.to_string())?;
    let mut result: Option<HashSet<String>> = None;
    for (name, value) in filters {
        let ids: HashSet<String> = stmt
            .query_map(params![name, value], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        result = match result {
            None => Some(ids),
            Some(prev) => Some(prev.intersection(&ids).cloned().collect()),
        };
    }
    Ok(result.unwrap_or_default())
}

// All pages as brief search results (used when only prop filters are given).
fn list_pages_brief(c: &Connection, limit: usize) -> Result<Vec<SearchResult>, String> {
    let mut stmt = c
        .prepare(
            "SELECT id, title, content_text FROM pages
             WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit as i64], |r| {
            let id: String = r.get(0)?;
            let title: String = r.get(1)?;
            let text: String = r.get(2)?;
            Ok(SearchResult {
                id,
                title,
                snippet: truncate(&text, 120),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search(db: State<Db>, args: SearchArgs) -> Result<Vec<SearchResult>, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    let limit = args.limit.unwrap_or(50).min(200);
    let (text, filters) = parse_prop_filters(args.query.trim());
    if text.is_empty() && filters.is_empty() {
        return Ok(vec![]);
    }

    // Base results: by text (FTS/LIKE), or all pages when only filters given.
    let mut results = if text.is_empty() {
        list_pages_brief(&c, 200)?
    } else if text.chars().count() < 3 {
        search_like(&c, &text, limit)?
    } else {
        search_fts(&c, &text, limit)?
    };

    if !filters.is_empty() {
        let ids = pages_matching_filters(&c, &filters)?;
        results.retain(|r| ids.contains(&r.id));
    }

    results.truncate(limit);
    Ok(results)
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
