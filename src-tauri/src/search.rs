use crate::db::Db;
use crate::models::SearchResult;
use rusqlite::{params, Connection};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
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
    /// When true, search across all workspaces (results carry their space name).
    pub all_spaces: Option<bool>,
    /// Optional embedding config (frontend-local read, passed in) — enables the
    /// vector semantic re-rank on the desktop side, mirroring web.ts. Absent when
    /// the user hasn't configured an embedding model.
    #[serde(default)]
    pub embedding: Option<EmbedCfg>,
}

/// Embedding provider config forwarded from the frontend (read from localStorage).
/// Mirrors `src/lib/semanticEmbed.ts`'s EmbedConfig (camelCase JSON keys).
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EmbedCfg {
    pub provider: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
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
// Results carry the workspace name from meta (app-level workspace list).
fn list_pages_brief(c: &Connection, limit: usize) -> Result<Vec<SearchResult>, String> {
    let sql = "SELECT p.id, p.title, p.content_text, w.name FROM pages p
         JOIN meta.workspaces w ON w.id = p.workspace_id
         WHERE p.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT ?1";
    let mut stmt = c.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit as i64], |r| {
            let id: String = r.get(0)?;
            let title: String = r.get(1)?;
            let text: String = r.get(2)?;
            let space: String = r.get(3)?;
            Ok(SearchResult {
                id,
                title,
                snippet: truncate(&text, 120),
                space: Some(space),
                score: 0.0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Run one search pass against a single connection (a single space's DB).
fn search_in_conn(
    c: &Connection,
    text: &str,
    filters: &[(String, String)],
    limit: usize,
) -> Result<Vec<SearchResult>, String> {
    let mut results = if text.is_empty() {
        list_pages_brief(c, 200)?
    } else if text.chars().count() < 3 {
        search_like(c, text, limit)?
    } else {
        search_fts(c, text, limit)?
    };
    if !filters.is_empty() {
        let ids = pages_matching_filters(c, filters)?;
        results.retain(|r| ids.contains(&r.id));
    }
    results.truncate(limit);
    Ok(results)
}

/// Bounded vector bonus (mirrors web.ts VECTOR_BONUS) — a positive embedding hit
/// adds to the keyword/relevance score without dominating it.
const VECTOR_BONUS: f32 = 3.0;
/// Max content chars embedded per page (keeps cache/cost bounded).
const EMBED_TEXT_CAP: usize = 500;

/// The exact text embedded for a page (title + capped content). Must be the same
/// in both the hash and the network call, so a changed page invalidates the cache.
fn embedding_text(title: &str, content: &str) -> String {
    let cap: String = content.chars().take(EMBED_TEXT_CAP).collect();
    format!("{} {}", title, cap)
}

/// FNV-1a (32-bit) hash, used to detect content drift for cache invalidation.
fn embed_hash(s: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h
}

/// Cosine similarity (dot / (|a|·|b|)). 0 for empty / length-mismatched input.
fn cosine_sim(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum();
    let nb: f32 = b.iter().map(|x| x * x).sum();
    let n = na.sqrt() * nb.sqrt();
    if n <= 0.0 {
        0.0
    } else {
        dot / n
    }
}

/// Simple keyword relevance (0..1): fraction of query tokens found (case-insensitive)
/// in the title or content. Mirrors the "keyword" signal in web.ts (not exact TF,
/// but the same effect) so pages that match literal terms keep a head start.
fn keyword_score(query: &str, title: &str, content: &str) -> f32 {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return 0.0;
    }
    let title_l = title.to_lowercase();
    let content_l = content.to_lowercase();
    let tokens: Vec<&str> = q.split_whitespace().filter(|s| !s.is_empty()).collect();
    if tokens.is_empty() {
        return if title_l.contains(&q) || content_l.contains(&q) { 1.0 } else { 0.0 };
    }
    let hits = tokens.iter().filter(|t| title_l.contains(**t) || content_l.contains(**t)).count();
    hits as f32 / tokens.len() as f32
}

/// Embed one text via the provider. Returns Ok(None) on any non-success / unreachable /
/// unparseable response so the caller degrades to keyword ranking.
async fn embed_text(cfg: &EmbedCfg, text: &str) -> Result<Option<Vec<f32>>, String> {
    let base = cfg.base_url.trim_end_matches('/');
    if base.is_empty() {
        return Ok(None);
    }
    let (url, body) = if cfg.provider == "openai" {
        (
            format!("{}/v1/embeddings", base),
            serde_json::json!({ "model": cfg.model, "input": [text] }),
        )
    } else {
        (
            format!("{}/api/embed", base),
            serde_json::json!({ "model": cfg.model, "input": text }),
        )
    };
    let mut req = reqwest::Client::new().post(&url).json(&body);
    if let Some(k) = cfg.api_key.as_deref() {
        if !k.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", k));
        }
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    if !resp.status().is_success() {
        return Ok(None);
    }
    let v: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let arr = if cfg.provider == "openai" {
        v["data"][0]["embedding"].as_array()
    } else {
        v["embeddings"][0].as_array()
    };
    let vec: Vec<f32> = arr
        .map(|a| a.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect())
        .unwrap_or_default();
    Ok(if vec.is_empty() { None } else { Some(vec) })
}

/// Read a cached embedding vector, gated by model + content hash. None on miss/stale.
fn cached_vector(c: &Connection, page_id: &str, model: &str, hash: u32) -> Option<Vec<f32>> {
    let row: Option<(String, String, String)> = c
        .query_row(
            "SELECT model, vector, hash FROM page_embeddings WHERE page_id = ?1",
            params![page_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    let (m, vec_s, h) = row?;
    if m != model || h != format!("{:x}", hash) {
        return None;
    }
    serde_json::from_str::<Vec<f64>>(&vec_s)
        .ok()
        .map(|v| v.iter().map(|x| *x as f32).collect())
}

/// Upsert a cached embedding vector for a page.
fn write_vector(c: &Connection, page_id: &str, model: &str, vec: &[f32], hash: u32, now: i64) {
    let dim = vec.len() as i64;
    let json = serde_json::to_string(vec).unwrap_or_else(|_| "[]".to_string());
    let _ = c.execute(
        "INSERT OR REPLACE INTO page_embeddings (page_id, model, dim, vector, hash, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![page_id, model, dim, json, format!("{:x}", hash), now],
    );
}

/// Read all non-deleted pages (id, title, content_text) from a space connection.
fn read_all_pages(c: &Connection) -> Result<Vec<(String, String, String)>, String> {
    let mut stmt = c
        .prepare("SELECT id, title, content_text FROM pages WHERE deleted_at IS NULL")
        .map_err(|e| e.to_string())?;
    let x = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(x)
}

/// Semantic (vector-aware) search over a broad candidate set, mirroring web.ts:
/// keyword relevance is the backbone, then a bounded vector bonus from a cached /
/// lazily-computed embedding. Does ALL connection I/O in scoped sync blocks and only
/// awaits on owned data, so the future is Send (required by Tauri commands). The
/// embedding cache is keyed by content hash, so repeated queries make just the query
/// embed call; changed/new pages are lazily re-embedded once and cached.
async fn search_semantic_async(
    db: &Db,
    text: &str,
    filters: &[(String, String)],
    limit: usize,
    emb: &EmbedCfg,
) -> Result<Vec<SearchResult>, String> {
    // Phase 1 (sync, brief lock): read pages + pre-resolve cached vectors.
    let (pages, cached, filter_ids) = {
        let c = db.0.lock().expect("db mutex poisoned");
        let pages = read_all_pages(&c)?;
        let filter_ids = if filters.is_empty() {
            None
        } else {
            Some(pages_matching_filters(&c, filters)?)
        };
        let mut cached: HashMap<String, Vec<f32>> = HashMap::new();
        for (id, title, content) in &pages {
            if let Some(v) =
                cached_vector(&c, id, &emb.model, embed_hash(&embedding_text(title, content)))
            {
                cached.insert(id.clone(), v);
            }
        }
        (pages, cached, filter_ids)
    };

    // Phase 2 (async, NO lock held): embed the query + any dirty pages.
    let qv = embed_text(emb, text).await?.filter(|v| !v.is_empty());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut scored: Vec<(f32, String, String, String)> = Vec::new();
    let mut to_write: Vec<(String, String, Vec<f32>, u32, i64)> = Vec::new();
    for (id, title, content_text) in &pages {
        if let Some(ids) = &filter_ids {
            if !ids.contains(id) {
                continue;
            }
        }
        let mut score = keyword_score(text, title, content_text);
        if let Some(q) = &qv {
            let et = embedding_text(title, content_text);
            let h = embed_hash(&et);
            let mut vec = cached.get(id).cloned();
            if vec.is_none() {
                if let Some(v) = embed_text(emb, &et).await? {
                    to_write.push((id.clone(), emb.model.clone(), v.clone(), h, now));
                    vec = Some(v);
                }
            }
            if let Some(v) = vec {
                score += VECTOR_BONUS * cosine_sim(q, &v);
            }
        }
        scored.push((score, id.clone(), title.clone(), build_like_snippet(content_text, text, 120)));
    }

    // Phase 3 (sync, brief lock): write newly-computed cache rows.
    if !to_write.is_empty() {
        let c = db.0.lock().expect("db mutex poisoned");
        for (pid, model, v, h, t) in to_write {
            write_vector(&c, &pid, &model, &v, h, t);
        }
    }

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);
    Ok(scored
        .into_iter()
        .map(|(s, id, title, snippet)| SearchResult {
            id,
            title,
            snippet,
            space: None,
            score: s,
        })
        .collect())
}

#[tauri::command]
pub async fn search(db: State<'_, Db>, args: SearchArgs) -> Result<Vec<SearchResult>, String> {
    let limit = args.limit.unwrap_or(50).min(200);
    let (text, filters) = parse_prop_filters(args.query.trim());
    if text.is_empty() && filters.is_empty() {
        return Ok(vec![]);
    }
    let emb = args.embedding;

    // Determine target space(s). all_spaces -> iterate every non-deleted space's
    // own DB and merge (cross-space aggregation). Otherwise search only the
    // active space's DB (the main connection).
    if args.all_spaces.unwrap_or(false) {
        // Collect (workspace_id, name) from meta.
        let spaces: Vec<(String, String)> = {
            let c = db.0.lock().expect("db mutex poisoned");
            let mut stmt = c
                .prepare("SELECT id, name FROM meta.workspaces WHERE deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC, id ASC")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };

        let mut out: Vec<SearchResult> = Vec::new();
        // Each space gets a fair share of the global limit (integer ceiling).
        let n = spaces.len().max(1);
        let per_limit = (limit + n - 1) / n;
        for (sid, sname) in spaces {
            let conn = crate::db::open_space_conn(&sid)?;
            let mut hits = if let Some(e) = emb.as_ref() {
                // Cross-space vector alignment: each space's connection is wrapped
                // in a Db so it reuses the same cache-aware semantic ranking.
                let space_db = Db(std::sync::Mutex::new(conn));
                search_semantic_async(&space_db, &text, &filters, per_limit, e).await?
            } else {
                search_in_conn(&conn, &text, &filters, per_limit)?
            };
            for h in hits.iter_mut() {
                if h.space.is_none() {
                    h.space = Some(sname.clone());
                }
            }
            out.append(&mut hits);
        }
        out.truncate(limit);
        return Ok(out);
    }

    let results = if let Some(e) = emb.as_ref() {
        search_semantic_async(db.inner(), &text, &filters, limit, e).await?
    } else {
        let c = db.0.lock().expect("db mutex poisoned");
        let mut r = search_in_conn(&c, &text, &filters, limit)?;
        r.truncate(limit);
        r
    };
    Ok(results)
}

fn search_fts(
    c: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, String> {
    // Wrap as a phrase for substring matching; strip embedded double quotes.
    let phrase = format!("\"{}\"", query.replace('"', ""));
    let sql = "SELECT f.page_id, f.title, w.name,
                snippet(f, 2, '[[', ']]', '…', 24) AS body_snip,
                snippet(f, 1, '[[', ']]', '…', 12) AS title_snip
         FROM page_fts f
         JOIN pages p ON p.id = f.page_id
         JOIN meta.workspaces w ON w.id = p.workspace_id
         WHERE f.page_fts MATCH ?1 AND p.deleted_at IS NULL
         ORDER BY rank LIMIT ?2";
    let mut stmt = c.prepare(sql).map_err(|e| e.to_string())?;

    let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<SearchResult> {
        let id: String = row.get(0)?;
        let title: String = row.get(1)?;
        let space: String = row.get(2)?;
        let body_snip: String = row.get(3)?;
        let title_snip: String = row.get(4)?;
        let snippet = if body_snip.trim().is_empty() {
            if title_snip.trim().is_empty() {
                title.clone()
            } else {
                title_snip
            }
        } else {
            body_snip
        };
        Ok(SearchResult {
            id,
            title,
            snippet,
            space: Some(space),
            score: 0.0,
        })
    };

    let rows = stmt
        .query_map(params![phrase, limit as i64], map_row)
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn search_like(
    c: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, String> {
    let pattern = format!("%{}%", escape_like(query));
    let sql = "SELECT p.id, p.title, p.content_text, w.name FROM pages p
         JOIN meta.workspaces w ON w.id = p.workspace_id
         WHERE p.deleted_at IS NULL
           AND (p.title LIKE ?1 ESCAPE '\\' OR p.content_text LIKE ?1 ESCAPE '\\')
         ORDER BY p.updated_at DESC LIMIT ?2";
    let mut stmt = c.prepare(sql).map_err(|e| e.to_string())?;

    let q = query.to_string();
    let rows = stmt
        .query_map(params![pattern, limit as i64], move |r| {
            let id: String = r.get(0)?;
            let title: String = r.get(1)?;
            let text: String = r.get(2)?;
            let space: String = r.get(3)?;
            let snippet = build_like_snippet(&text, &q, 120);
            Ok(SearchResult {
                id,
                title,
                snippet,
                space: Some(space),
                score: 0.0,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embed_hash_is_deterministic_and_drift_sensitive() {
        let a = embed_hash("会议纪要");
        let b = embed_hash("会议纪要");
        let c = embed_hash("项目计划");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(a != 0);
    }

    #[test]
    fn embedding_text_is_bounded_and_prefixes_title() {
        let t = embedding_text("标题", &"x".repeat(600));
        assert!(t.starts_with("标题 "));
        // 标题 2 字 + 1 空格 + cap(500) = 503
        assert_eq!(t.chars().count(), 2 + 1 + EMBED_TEXT_CAP);
    }

    #[test]
    fn cosine_sim_orthogonal_is_zero() {
        assert!((cosine_sim(&[1.0, 0.0], &[0.0, 1.0])).abs() < 1e-6);
        assert!((cosine_sim(&[1.0, 2.0, 3.0], &[1.0, 2.0, 3.0]) - 1.0).abs() < 1e-6);
        assert_eq!(cosine_sim(&[], &[1.0]), 0.0);
    }

    #[test]
    fn keyword_score_matches_literal_tokens() {
        let s = keyword_score("会议纪要", "项目周报", "本周会议纪要，待办如下");
        assert!(s > 0.9, "s={}", s);
        let unrelated = keyword_score("会议纪要", "天气", "今天晴");
        assert_eq!(unrelated, 0.0);
    }

    // ---- Async integration tests against a mock embedding endpoint (no real model) ----

    use crate::db::Db;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Minimal HTTP/1.1 200 JSON responder. `respond` receives the POST body (JSON
    /// string) and returns the response body. Returns the bound port + server thread.
    fn spawn_mock_http<F: Fn(&str) -> String + Send + 'static>(respond: F) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut s = match stream {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let mut header = Vec::new();
                let mut byte = [0u8; 1];
                while header.len() < 16 * 1024 {
                    match s.read(&mut byte) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            header.push(byte[0]);
                            if header.ends_with(b"\r\n\r\n") {
                                break;
                            }
                        }
                    }
                }
                let header_str = String::from_utf8_lossy(&header);
                let content_len: usize = header_str
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").and_then(|v| v.trim().parse().ok()))
                    .unwrap_or(0);
                let mut body = vec![0u8; content_len];
                if content_len > 0 {
                    let _ = s.read_exact(&mut body);
                }
                let body = String::from_utf8_lossy(&body).to_string();
                let out = respond(&body);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    out.len(),
                    out
                );
                let _ = s.write_all(resp.as_bytes());
                let _ = s.flush();
            }
        });
        port
    }

    fn cfg(port: u16, provider: &str) -> EmbedCfg {
        EmbedCfg {
            provider: provider.to_string(),
            base_url: format!("http://127.0.0.1:{}", port),
            api_key: if provider == "openai" { Some("sk-test".into()) } else { None },
            model: "m".into(),
        }
    }

    #[tokio::test]
    async fn embed_text_calls_ollama_and_parses() {
        let port = spawn_mock_http(|_| r#"{"embeddings":[[0.1,0.2,0.3]]}"#.to_string());
        let vec = embed_text(&cfg(port, "ollama"), "hi").await.unwrap().unwrap();
        assert!((vec[0] - 0.1).abs() < 1e-6 && (vec[1] - 0.2).abs() < 1e-6 && (vec[2] - 0.3).abs() < 1e-6);
    }

    #[tokio::test]
    async fn embed_text_calls_openai_and_parses() {
        let port = spawn_mock_http(|_| r#"{"data":[{"embedding":[0.4,0.5]}]}"#.to_string());
        let vec = embed_text(&cfg(port, "openai"), "hi").await.unwrap().unwrap();
        assert!((vec[0] - 0.4).abs() < 1e-6 && (vec[1] - 0.5).abs() < 1e-6);
    }

    #[tokio::test]
    async fn search_semantic_ranks_semantically_with_mock_embedding() {
        // Fake embedding: dims [会议/纪要/周会, 项目, 天气]. Query「周会纪要」→ [1,0,0].
        let port = spawn_mock_http(|body| {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::json!({}));
            let input = v["input"]
                .as_str()
                .map(String::from)
                .or_else(|| v["input"][0].as_str().map(String::from))
                .unwrap_or_default();
            let mut d = [0.0; 3];
            if input.contains("会议") || input.contains("纪要") || input.contains("周会") {
                d[0] = 1.0;
            }
            if input.contains("项目") {
                d[1] = 1.0;
            }
            if input.contains("天气") {
                d[2] = 1.0;
            }
            format!("{{\"embeddings\":[{}]}}", d.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","))
        });

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn, "ws").unwrap();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        for (id, title, text) in [
            ("a", "会议安排", "本周会议纪要安排"),
            ("b", "项目计划", "开发排期项目进度"),
            ("c", "天气", "今天天气不错"),
        ] {
            conn.execute(
                "INSERT INTO pages (id, workspace_id, title, content_json, content_text, kind, sort_order, created_at, updated_at)
                 VALUES (?1, 'ws', ?2, '{}', ?3, 'page', 0, ?4, ?4)",
                rusqlite::params![id, title, text, now],
            )
            .unwrap();
        }

        let db = Db(std::sync::Mutex::new(conn));
        let results = search_semantic_async(&db, "周会纪要", &[], 10, &cfg(port, "ollama"))
            .await
            .unwrap();
        // 「会议安排」shares the [1,0,0] axis with the query (no literal keyword overlap
        // of 周会纪要), so the vector bonus lifts it above the unrelated pages.
        assert_eq!(results[0].title, "会议安排", "got: {:#?}", results.iter().map(|r| &r.title).collect::<Vec<_>>());
        let sem = results.iter().position(|r| r.title == "会议安排").unwrap();
        for name in ["项目计划", "天气"] {
            if let Some(i) = results.iter().position(|r| r.title == name) {
                assert!(i > sem, "{} should rank below the semantic hit", name);
            }
        }
    }
}
