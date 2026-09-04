use crate::db::Db;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use tauri::State;

#[derive(Debug, Serialize)]
pub struct GraphProp {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
pub struct GraphPage {
    pub id: String,
    pub title: String,
    pub tags: Vec<String>,
    pub props: Vec<GraphProp>,
}

#[derive(Debug, Serialize)]
pub struct GraphBlock {
    pub id: String,
    pub label: String,
    pub page_id: String,
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
    /// Page-level edges (aggregated `[[...]]` + block references/embeds).
    pub edges: Vec<GraphEdge>,
    /// Block nodes that participate in block-level references.
    pub blocks: Vec<GraphBlock>,
    /// Block-level edges: block→block (link/embed) + block→page (belongs).
    pub block_edges: Vec<GraphEdge>,
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

// The relationship graph: pages + blocks as nodes; backlinks as edges. The
// page-level edges power the default graph; blocks/block_edges power the
// optional block-level layer.
#[tauri::command]
pub fn get_graph(db: State<'_, Db>) -> Result<GraphData, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    let active = crate::workspaces::active_workspace_id(&c)?;

    // --- Page nodes ---
    let mut stmt = c
        .prepare("SELECT id, title FROM pages WHERE workspace_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;
    let mut pages: Vec<GraphPage> = stmt
        .query_map(params![active], |r| {
            Ok(GraphPage {
                id: r.get(0)?,
                title: r.get(1)?,
                tags: Vec::new(),
                props: Vec::new(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    // Attach tags to each page.
    let mut tags_map: HashMap<String, Vec<String>> = HashMap::new();
    let mut stmt = c
        .prepare(
            "SELECT pt.page_id, t.name
             FROM page_tags pt
             JOIN tags t ON t.id = pt.tag_id
             JOIN pages p ON p.id = pt.page_id
             WHERE p.workspace_id = ?1 AND p.deleted_at IS NULL",
        )
        .map_err(|e| e.to_string())?;
    let tag_rows: Vec<(String, String)> = stmt
        .query_map(params![active], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for (page_id, name) in tag_rows {
        tags_map.entry(page_id).or_default().push(name);
    }
    for p in pages.iter_mut() {
        if let Some(tags) = tags_map.remove(&p.id) {
            p.tags = tags;
        }
    }

    // Attach select-type attribute values (categorical, for graph filter/color).
    let mut props_map: HashMap<String, Vec<GraphProp>> = HashMap::new();
    let mut stmt = c
        .prepare(
            "SELECT pp.page_id, a.name, pp.value
             FROM page_props pp
             JOIN attr_defs a ON a.id = pp.attr_id
             WHERE a.type = 'select' AND pp.value != ''",
        )
        .map_err(|e| e.to_string())?;
    let prop_rows: Vec<(String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for (page_id, name, value) in prop_rows {
        props_map
            .entry(page_id)
            .or_default()
            .push(GraphProp { name, value });
    }
    for p in pages.iter_mut() {
        if let Some(props) = props_map.remove(&p.id) {
            p.props = props;
        }
    }

    // --- Page-level edges (aggregated) ---
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
    // `ref`-type property values are graph edges too (database ↔ graph, 图谱贯通).
    let mut stmt = c
        .prepare(
            "SELECT pp.page_id, substr(pp.value, 3) FROM page_props pp
             JOIN attr_defs a ON a.id = pp.attr_id
             WHERE a.type = 'ref' AND pp.value LIKE 'p:%'",
        )
        .map_err(|e| e.to_string())?;
    let ref_rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for (source, target) in ref_rows {
        if source == target {
            continue;
        }
        let key = (source, target);
        match best.get_mut(&key) {
            Some(existing) => {
                if edge_kind_priority("ref") > edge_kind_priority(existing.as_str()) {
                    *existing = "ref".to_string();
                }
            }
            None => {
                best.insert(key, "ref".to_string());
            }
        }
    }

    let edges: Vec<GraphEdge> = best
        .into_iter()
        .map(|((source, target), kind)| GraphEdge { source, target, kind })
        .collect();

    // --- Block-level layer ---
    let mut stmt = c
        .prepare(
            "SELECT source_block_id, target_block_id, kind FROM backlinks
             WHERE target_block_id != '' AND source_block_id != ''",
        )
        .map_err(|e| e.to_string())?;
    let block_rows: Vec<(String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let mut block_ids: HashSet<String> = HashSet::new();
    let mut block_edges: Vec<GraphEdge> = Vec::new();
    for (source_block_id, target_block_id, kind) in block_rows {
        block_ids.insert(source_block_id.clone());
        block_ids.insert(target_block_id.clone());
        block_edges.push(GraphEdge {
            source: source_block_id,
            target: target_block_id,
            kind,
        });
    }

    // Resolve each block to its page + a display label, and add a "belongs" edge.
    let mut blocks: Vec<GraphBlock> = Vec::new();
    let mut json_cache: HashMap<String, String> = HashMap::new();
    for block_id in block_ids {
        let page_id: Option<String> = c
            .query_row(
                "SELECT page_id FROM blocks WHERE block_id = ?1",
                params![block_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(page_id) = page_id else { continue };

        let content_json = if let Some(j) = json_cache.get(&page_id) {
            j.clone()
        } else {
            let j: String = c
                .query_row(
                    "SELECT content_json FROM pages WHERE id = ?1 AND deleted_at IS NULL",
                    params![page_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| "{}".to_string());
            json_cache.insert(page_id.clone(), j.clone());
            j
        };

        let label = crate::blocks::snippet_for_block(&content_json, &block_id);
        blocks.push(GraphBlock {
            id: block_id.clone(),
            label,
            page_id: page_id.clone(),
        });
        block_edges.push(GraphEdge {
            source: block_id,
            target: page_id,
            kind: "belongs".to_string(),
        });
    }

    Ok(GraphData {
        pages,
        edges,
        blocks,
        block_edges,
    })
}
