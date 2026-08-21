use crate::db::Db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct BlockInfo {
    pub block_id: String,
    pub page_id: String,
    pub page_title: String,
    pub snippet: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct PageBlock {
    pub block_id: String,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct SearchBlock {
    pub block_id: String,
    pub page_id: String,
    pub page_title: String,
    pub snippet: String,
}

#[derive(Debug, Serialize)]
pub struct BlockBacklink {
    pub source_page_id: String,
    pub source_page_title: String,
    pub source_block_id: String,
    pub source_snippet: String,
    pub target_block_id: String,
    pub target_snippet: String,
    pub kind: String,
}

fn parse_json(content_json: &str) -> Result<Value, String> {
    serde_json::from_str(content_json).map_err(|e| e.to_string())
}

fn root_children(v: &Value) -> Vec<&Value> {
    v.get("root")
        .and_then(|r| r.get("children"))
        .and_then(|c| c.as_array())
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}

// Concatenate the text payload of every `text` node under `node` (breadth-first order).
fn collect_text(node: &Value, out: &mut String) {
    if let Some(t) = node.get("text").and_then(|v| v.as_str()) {
        out.push_str(t);
    }
    if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
        for child in children {
            collect_text(child, out);
        }
    }
}

fn node_text(node: &Value) -> String {
    let mut out = String::new();
    collect_text(node, &mut out);
    out
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    }
}

// Extract the stable block IDs of every top-level block from a serialized editor state.
pub fn extract_block_ids(content_json: &str) -> Result<Vec<String>, String> {
    let v = parse_json(content_json)?;
    let mut ids = Vec::new();
    for child in root_children(&v) {
        if let Some(id) = child.get("blockId").and_then(|v| v.as_str()) {
            if !id.is_empty() {
                ids.push(id.to_string());
            }
        }
    }
    Ok(ids)
}

// Rebuild the `blocks` index for a page: delete stale rows, upsert current blocks.
pub fn upsert_blocks(c: &Connection, page_id: &str, content_json: &str) -> Result<(), String> {
    let ids = extract_block_ids(content_json)?;
    let now = crate::db::now_ms();

    c.execute("DELETE FROM blocks WHERE page_id = ?1", params![page_id])
        .map_err(|e| e.to_string())?;

    for id in ids {
        c.execute(
            "INSERT INTO blocks (block_id, page_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(block_id) DO UPDATE SET page_id = excluded.page_id, updated_at = excluded.updated_at",
            params![id, page_id, now, now],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Collect block references/embeds under `node`, attributing each to its top-level block.
fn collect_block_refs(node: &Value, top_block_id: &str, out: &mut Vec<(String, String, String)>) {
    if let Some(ty) = node.get("type").and_then(|v| v.as_str()) {
        if ty == "blockref" || ty == "blockembed" {
            if let Some(target_id) = node.get("targetId").and_then(|v| v.as_str()) {
                let kind = if ty == "blockembed" { "embed" } else { "link" };
                out.push((top_block_id.to_string(), target_id.to_string(), kind.to_string()));
            }
        }
    }
    if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
        for child in children {
            collect_block_refs(child, top_block_id, out);
        }
    }
}

// Rebuild block-level backlinks: scan `((blockId))` / `{{blockId}}` references in the
// structured JSON and record (source block → target block) links.
pub fn rebuild_block_backlinks(
    c: &Connection,
    page_id: &str,
    content_json: &str,
) -> Result<(), String> {
    c.execute(
        "DELETE FROM backlinks WHERE source_page_id = ?1 AND source_block_id != ''",
        params![page_id],
    )
    .map_err(|e| e.to_string())?;

    let v = parse_json(content_json)?;
    let mut refs: Vec<(String, String, String)> = Vec::new();
    for child in root_children(&v) {
        let top_id = child
            .get("blockId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if top_id.is_empty() {
            continue;
        }
        collect_block_refs(child, &top_id, &mut refs);
    }

    for (source_block_id, target_block_id, kind) in refs {
        let target_page_id: Option<String> = c
            .query_row(
                "SELECT page_id FROM blocks WHERE block_id = ?1",
                params![target_block_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        if let Some(target_page_id) = target_page_id {
            c.execute(
                "INSERT OR IGNORE INTO backlinks (source_page_id, source_block_id, target_page_id, target_block_id, kind)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![page_id, source_block_id, target_page_id, target_block_id, kind],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// Rebuild the whole block graph for a page after a save: blocks index + page-level backlinks
// + block-level backlinks.
pub fn rebuild_block_graph(
    c: &Connection,
    page_id: &str,
    content_json: &str,
    content_text: &str,
) -> Result<(), String> {
    upsert_blocks(c, page_id, content_json)?;
    crate::backlinks::rebuild_backlinks(c, page_id, content_text)?;
    rebuild_block_backlinks(c, page_id, content_json)?;
    Ok(())
}

// Full text of a top-level block by id, if it exists in the serialized state.
fn block_text(content_json: &str, block_id: &str) -> Option<String> {
    let v = parse_json(content_json).ok()?;
    for child in root_children(&v) {
        if child.get("blockId").and_then(|v| v.as_str()) == Some(block_id) {
            return Some(node_text(child));
        }
    }
    None
}

pub(crate) fn snippet_for_block(content_json: &str, block_id: &str) -> String {
    match block_text(content_json, block_id) {
        Some(text) => {
            let trimmed = text.trim().to_string();
            if trimmed.is_empty() {
                "(空块)".to_string()
            } else {
                truncate_chars(&trimmed, 200)
            }
        }
        None => "(块已删除)".to_string(),
    }
}

#[tauri::command]
pub fn resolve_block(db: State<'_, Db>, block_id: String) -> Result<BlockInfo, String> {
    let c = db.0.lock().expect("db mutex poisoned");

    let page_id: String = c
        .query_row(
            "SELECT page_id FROM blocks WHERE block_id = ?1",
            params![block_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "块不存在".to_string())?;

    let (title, content_json): (String, String) = c
        .query_row(
            "SELECT title, content_json FROM pages WHERE id = ?1 AND deleted_at IS NULL",
            params![page_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "页面不存在".to_string())?;

    let snippet = snippet_for_block(&content_json, &block_id);
    let content = block_text(&content_json, &block_id)
        .map(|t| t.trim().to_string())
        .unwrap_or_default();
    Ok(BlockInfo {
        block_id,
        page_id,
        page_title: title,
        snippet,
        content,
    })
}

#[tauri::command]
pub fn get_page_blocks(db: State<'_, Db>, page_id: String) -> Result<Vec<PageBlock>, String> {
    let c = db.0.lock().expect("db mutex poisoned");

    let content_json: String = c
        .query_row(
            "SELECT content_json FROM pages WHERE id = ?1 AND deleted_at IS NULL",
            params![page_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "页面不存在".to_string())?;

    let v = parse_json(&content_json)?;
    let mut blocks = Vec::new();
    for child in root_children(&v) {
        if let Some(id) = child.get("blockId").and_then(|v| v.as_str()) {
            blocks.push(PageBlock {
                block_id: id.to_string(),
                text: node_text(child).trim().to_string(),
            });
        }
    }
    Ok(blocks)
}

#[tauri::command]
pub fn search_blocks(db: State<'_, Db>, query: String) -> Result<Vec<SearchBlock>, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }

    let pattern = format!(
        "%{}%",
        q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    );
    let mut stmt = c
        .prepare(
            "SELECT id, title, content_json FROM pages
             WHERE deleted_at IS NULL AND (title LIKE ?1 ESCAPE '\\' OR content_text LIKE ?1 ESCAPE '\\')
             ORDER BY updated_at DESC LIMIT 50",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<(String, String, String)> = stmt
        .query_map(params![pattern], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let ql = q.to_lowercase();
    let mut results = Vec::new();
    for (page_id, page_title, content_json) in rows {
        let v = match parse_json(&content_json) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for child in root_children(&v) {
            if let Some(block_id) = child.get("blockId").and_then(|v| v.as_str()) {
                let text = node_text(child);
                if text.to_lowercase().contains(&ql) {
                    results.push(SearchBlock {
                        block_id: block_id.to_string(),
                        page_id: page_id.clone(),
                        page_title: page_title.clone(),
                        snippet: truncate_chars(text.trim(), 120),
                    });
                }
            }
        }
    }
    Ok(results)
}

#[tauri::command]
pub fn list_block_backlinks(db: State<'_, Db>, page_id: String) -> Result<Vec<BlockBacklink>, String> {
    let c = db.0.lock().expect("db mutex poisoned");

    // Target snippets all live in the current page.
    let target_json: String = c
        .query_row(
            "SELECT content_json FROM pages WHERE id = ?1 AND deleted_at IS NULL",
            params![page_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "{}".to_string());

    let mut stmt = c
        .prepare(
            "SELECT b.source_page_id, p.title, b.source_block_id, b.target_block_id, b.kind,
                    (SELECT content_json FROM pages WHERE id = b.source_page_id) AS source_json
             FROM backlinks b
             JOIN pages p ON p.id = b.source_page_id
             WHERE b.target_page_id = ?1 AND b.target_block_id != ''
             ORDER BY p.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<(String, String, String, String, String, Option<String>)> = stmt
        .query_map(params![page_id], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for (source_page_id, source_page_title, source_block_id, target_block_id, kind, source_json) in rows {
        let source_snippet = source_json
            .as_deref()
            .map(|j| snippet_for_block(j, &source_block_id))
            .unwrap_or_default();
        let target_snippet = snippet_for_block(&target_json, &target_block_id);
        out.push(BlockBacklink {
            source_page_id,
            source_page_title,
            source_block_id,
            source_snippet,
            target_block_id,
            target_snippet,
            kind,
        });
    }
    Ok(out)
}
