use crate::db::Db;
use serde::Serialize;
use std::collections::HashMap;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct GraphPage {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Serialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub kind: String,
}

#[derive(Debug, Serialize)]
pub struct GraphData {
    pub pages: Vec<GraphPage>,
    pub edges: Vec<GraphEdge>,
}

// Priority for aggregating multiple backlinks between the same two pages:
// embed > link > page.
fn edge_kind_priority(kind: &str) -> u8 {
    match kind {
        "embed" => 3,
        "link" => 2,
        _ => 1,
    }
}

// The relationship graph: every page is a node; every backlink (page-level
// `[[...]]`, block reference `((...))`, or block embed `{{...}}`) is an edge
// between pages, colored by kind.
#[tauri::command]
pub fn get_graph(db: State<'_, Db>) -> Result<GraphData, String> {
    let c = db.0.lock().expect("db mutex poisoned");

    let mut stmt = c
        .prepare("SELECT id, title FROM pages WHERE deleted_at IS NULL ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;
    let pages: Vec<GraphPage> = stmt
        .query_map([], |r| {
            Ok(GraphPage {
                id: r.get(0)?,
                title: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let mut stmt = c
        .prepare("SELECT source_page_id, target_page_id, kind, target_block_id FROM backlinks")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, String)> = stmt
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    // Aggregate to page-level edges, deduping (source, target) by kind priority.
    let mut best: HashMap<(String, String), String> = HashMap::new();
    for (source, target, kind, target_block_id) in rows {
        if source == target {
            continue;
        }
        let k = if target_block_id.is_empty() {
            "page".to_string()
        } else {
            kind
        };
        let key = (source, target);
        match best.get_mut(&key) {
            Some(existing) => {
                if edge_kind_priority(&k) > edge_kind_priority(existing.as_str()) {
                    *existing = k;
                }
            }
            None => {
                best.insert(key, k);
            }
        }
    }

    let edges: Vec<GraphEdge> = best
        .into_iter()
        .map(|((source, target), kind)| GraphEdge { source, target, kind })
        .collect();

    Ok(GraphData { pages, edges })
}
