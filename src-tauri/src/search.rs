use crate::db::Db;
use crate::models::SearchResult;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
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
        // Build snippet around the first match, on char boundaries. pos/q are byte
        // indices; text may be multi-byte UTF-8 (Chinese), so align start/end to
        // char boundaries BEFORE slicing, else `&text[start..end]` panics
        // ("byte index is not a char boundary") — the search crash on中文内容.
        let start = text.floor_char_boundary(pos.saturating_sub(20));
        let end = text.floor_char_boundary((pos + q.len() + 40).min(text.len()));
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
                workspace_id: None,
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
    // 多词（含空格）用 LIKE AND——trigram 对 2 字中文词（会议/安排）索引不可靠，
    // FTS phrase 匹配不到；子串 LIKE 可靠。单词仍走 FTS(≥3字)/LIKE(<3字)。
    let multi: Vec<&str> = text.split_whitespace().filter(|w| !w.is_empty()).collect();
    let mut results = if text.is_empty() {
        list_pages_brief(c, 200)?
    } else if multi.len() > 1 {
        search_like_multi(c, &multi, limit)?
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
    // 用带超时的 client：Client::new() 无默认 timeout，embed 服务不可达/慢时
    // req.send().await 会无限挂起 → 桌面搜索卡「搜索中...」。设 8s 超时，
    // 超时/失败返回 Ok(None) 走 FTS 兜底（不卡死，回退普通搜索）。
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.post(&url).json(&body);
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
            workspace_id: None,
            score: s,
        })
        .collect())
}

/// 命令入口的查询准备：trim → 属性过滤 → **查询侧归一化**（契约 §15.9）。
///
/// 为什么归一化在这一层、而不是在 `search_in_conn` 里：下游拿到的是**同一份**文本 ——
/// 分词、FTS/LIKE、snippet 高亮、以及查询向量。任何一处漏掉都会变成"某些入口搜不到"，
/// 而那种不一致最难查（单跑那条路径还是绿的）。
///
/// 为什么要归一化：抽取层在落库前会把「康熙部首 ⼀(U+2F00)」折成「一」，
/// 用户从 PDF 里粘一个兼容形来搜，若不折就是**搜不到**（索引归一了、查询没归一）。
fn prepare_query(raw: &str) -> (String, Vec<(String, String)>) {
    let (text, filters) = parse_prop_filters(raw.trim());
    (crate::textnorm::normalize_for_match(&text), filters)
}

#[tauri::command]
pub async fn search(db: State<'_, Db>, args: SearchArgs) -> Result<Vec<SearchResult>, String> {
    let limit = args.limit.unwrap_or(50).min(200);
    let (text, filters) = prepare_query(&args.query);
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
                if h.workspace_id.is_none() {
                    h.workspace_id = Some(sid.clone());
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
    // 空格分词：多关键词【都出现】（AND），每词包 phrase 避免 FTS 特殊字符误解析。
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|t| t.replace('"', "").trim().to_string())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"", t))
        .collect();
    let phrase = if terms.is_empty() { "\"\"".to_string() } else { terms.join(" AND ") };
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
            workspace_id: None,
            score: 0.0,
        })
    };

    let rows = stmt
        .query_map(params![phrase, limit as i64], map_row)
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// 多关键词：空格分词，每个词 (title LIKE %词% OR content_text LIKE %词%) 之间 AND——
// 都出现（子串匹配，不受 trigram 对短中文词不可靠影响）。
fn search_like_multi(c: &Connection, words: &[&str], limit: usize) -> Result<Vec<SearchResult>, String> {
    if words.is_empty() {
        return Ok(vec![]);
    }
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<String> = Vec::new();
    for w in words {
        let pat = format!("%{}%", escape_like(w));
        clauses.push("(p.title LIKE ? ESCAPE '\\' OR p.content_text LIKE ? ESCAPE '\\')".to_string());
        params.push(pat.clone());
        params.push(pat);
    }
    let mut sql = String::from(
        "SELECT p.id, p.title, p.content_text, w.name FROM pages p
         JOIN meta.workspaces w ON w.id = p.workspace_id
         WHERE p.deleted_at IS NULL AND ",
    );
    sql.push_str(&clauses.join(" AND "));
    sql.push_str(" ORDER BY p.updated_at DESC LIMIT ?");
    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let q = words.join(" ");
    let limit_i64: i64 = limit as i64;
    let mut binds: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
    binds.push(&limit_i64 as &dyn rusqlite::ToSql);
    let rows = stmt
        .query_map(rusqlite::params_from_iter(binds), |r| {
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
                workspace_id: None,
                score: 0.0,
            })
        })
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
                workspace_id: None,
                score: 0.0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}


// ---------------------------------------------------------------------------
// 块级检索（**只读**）—— 接口与判据见信箱 `2026-09-17-retrieval-query-normalization.reply-1`。
//
// 为什么第一片只做"读"：`chunks` / `chunk_embeddings` 的**写入**语义已经在 TS 侧收口
// （`id = <ownerKey>#<ord>` 稳定、`hash = fnv1a32(text)`、整体替换不留孤儿），而读能立刻产生价值
// （AI 的 `files.search`、块级召回）。所以：
//   · **不动 DDL**（真 BM25 要一张 FTS5 表 + 同步触发器，而 schema 在两处：TS `extract/schema.ts` 与
//     本文件所在的桌面库 —— 那是共享改动，得契约所有者点头；这版先用"关键词覆盖 + 向量"的混合分）；
//   · **不写 `chunk_embeddings`**（"什么时候嵌、用哪个模型配置"是另一条口径）；
//   · `chunks` 表不存在（老库/没迁移）⇒ **空结果**，不报红（向前兼容）。
// ---------------------------------------------------------------------------

/// 命令面 `search_chunks` 的 `limit` 默认值。
///
/// ⚠️ **这是"命令面"（UI 与直接调用）的默认值，与能力面 `files.search` 的默认值（10，注册表）
/// 是**两个面各自的契约**，刻意不互相"对齐"** —— Windows 裁定（2026-09-18）：
/// "两个面、两拨用户，各自在注册表/文档写清即可；别再把它对齐，那会把人在看的列表变得太短"
/// （同一条裁定也适用于 `pages.search`：能力面 8/100 与 UI 命令面 50/200）。
///
/// 历史：AMD 2026-09-18 发现"注册表 10 / TS wrapper 10 / 这里 20"三处不同**且没有判据守着**。
/// 处置：① 默认值各自写在**一处**并写明归属（本常量＝命令面；`intArg(args,"limit",10,…)`＝能力面）；
/// ② 真正会出事的是**下界**（原来只有 `.min(MAX)`，`limit=0` 返回 0 条，而能力面是 1）⇒ 已补 `clamp`。
const CHUNK_LIMIT_DEFAULT: usize = 20;
const CHUNK_LIMIT_MAX: usize = 100;

/// 命令面的 `limit` 口径：默认 20（见上面的裁定），**两端都夹取**（与能力面同一条夹取语义，
/// 但默认值是两个面各自的契约）。
///
/// 抽成纯函数只为能被判据直接钉住（原来那一行 `.min(MAX)` 没有下界，`limit=0` 会返回 0 条命中，
/// 而能力面 `0 ⇒ 1`；两面对同一个逻辑调用的边界语义不该不同）。
fn chunk_limit_or_default(limit: Option<usize>) -> usize {
    limit.unwrap_or(CHUNK_LIMIT_DEFAULT).clamp(1, CHUNK_LIMIT_MAX)
}
/// 向量加分上限：**不主导**关键词（与页面级的 `VECTOR_BONUS` 同一个思路）。
const CHUNK_VECTOR_BONUS: f32 = 6.0;
/// BM25 加分上限：与向量同一个思路 —— **有界、不主导**关键词覆盖分。
///
/// 为什么不做成"用 BM25 取代关键词分"：那会改**召回集**（trigram 命中但关键词覆盖为 0 的块
/// 会新进结果），而召回变化是用户可见的、该有自己的一组判据与跨机复核。
/// 这一版只做**排序**（候选集一字不动）⇒ 可证：启用/不启用索引，命中的块**完全相同**。
const CHUNK_BM25_BONUS: f32 = 3.0;
/// 片段长度（与页面级 `build_like_snippet` 的调用口径一致）。
const CHUNK_SNIPPET_LEN: usize = 120;

/// 把归一化后的查询变成 FTS5 的 `MATCH` 表达式：**每个词加双引号**（否则 `-` / `*` / `:` /
/// `NEAR` / `OR` 这些会被当成语法，用户的普通输入会让查询报错），引号本身双写转义。
///
/// 返回 `None` = "没有可用检索词"（空查询）⇒ 调用方**跳过** FTS 那一路，不是错误。
/// 词之间用空格 = FTS5 的隐式 AND（与关键词覆盖"每个词都要出现"的口径一致）。
fn chunk_match_expr(query: &str) -> Option<String> {
    let parts: Vec<String> = query
        .split_whitespace()
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{}\"", w.replace('"', "\"\"")))
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

/// 块级 FTS 索引**自愈**：表在就查、**计数对不上就重建**（派生索引可重建是这一层的纪律）。
///
/// 什么时候会"对不上"：索引是 2026-09-19 才加的，**老库**里 `chunks` 已有行而 `chunk_fts` 是空的；
/// 或者历史上某次写入发生在触发器建立之前。判据用计数比较（两张表都很小，代价可忽略），
/// 重建 = 清空 + 从 `chunks` 整体灌一遍 —— 与"派生索引不入同步/备份"的口径一致。
///
/// ⚠️ 缺 `chunks` 表（老库没迁到派生层）⇒ **直接返回，不报错**（向前兼容，与 `read_chunks` 同口径）。
fn ensure_chunk_fts(c: &Connection) -> Result<(), String> {
    if !table_exists(c, "chunks") {
        return Ok(());
    }
    if !table_exists(c, "chunk_fts") {
        return Ok(()); // 触发器/表由 `db::migrate` 建；这里不越权改 schema
    }
    let count = |t: &str| -> Result<i64, String> {
        c.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
            .map_err(|e| e.to_string())
    };
    let chunks = count("chunks")?;
    let indexed = count("chunk_fts")?;
    if chunks == indexed {
        return Ok(());
    }
    c.execute("DELETE FROM chunk_fts", []).map_err(|e| e.to_string())?;
    c.execute(
        "INSERT INTO chunk_fts(chunk_id, text) SELECT id, text FROM chunks",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 读 BM25 分数（**只对候选块算**，键 = chunk id，值归一化到 0..1）。
///
/// `bm25()` 在 SQLite 里是"越小越相关"的负数 ⇒ 取负后按 `x/(1+x)` 压到 `[0,1)`，
/// 这样它只能当**有界加分**，不会盖过关键词覆盖分。
/// 任何一步失败（缺表/表达式不给/MATCH 语法）都返回空表 ⇒ 退化成"没有 BM25 那一路"，
/// **搜索本身不能因为索引出问题而失败**。
fn read_chunk_bm25(c: &Connection, query: &str, wanted: &HashSet<&str>) -> HashMap<String, f32> {
    let mut out = HashMap::new();
    let Some(expr) = chunk_match_expr(query) else { return out };
    if !table_exists(c, "chunk_fts") {
        return out;
    }
    let Ok(mut stmt) = c.prepare("SELECT chunk_id, bm25(chunk_fts) FROM chunk_fts WHERE chunk_fts MATCH ?1") else {
        return out;
    };
    let Ok(iter) = stmt.query_map(params![expr], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
    }) else {
        return out;
    };
    for (id, raw) in iter.flatten() {
        if !wanted.contains(id.as_str()) {
            continue;
        }
        out.insert(id, normalize_bm25(raw));
    }
    out
}

/// BM25 原始分 → `[0,1)` 的**有界**加分（`bm25()` 越小越相关 ⇒ 取负后按 `x/(1+x)` 压紧）。
///
/// 抽成函数有两个理由：① 判据能直接钉"上界严格小于 1、且随相关性单调"；
/// ② 补掉我第一版判据的漏洞 —— 当时只断言"落在 [0,1]"，**把这层归一化去掉它照样绿**
/// （小夹具上原始分恰好 ≤1）。变异实测抓到的，所以这里必须是一个能被单独钉住的函数。
fn normalize_bm25(raw: f64) -> f32 {
    let x = (-raw).max(0.0) as f32;
    x / (1.0 + x)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchChunksArgs {
    pub query: String,
    #[serde(default)]
    pub limit: Option<usize>,
    /// 与 `search` 同一个类型：前端传（用户配了嵌入模型才有）。不给 ⇒ 纯关键词。
    #[serde(default)]
    pub embedding: Option<EmbedCfg>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkHit {
    pub chunk_id: String,
    /// 两类 owner 各占一个字段（`page:<pageId>` 与 `att:<attId>`）—— 消费方要能回链，
    /// 所以**两个都带出来**，而不是塞一个 `owner` 字符串让调用方自己拆。
    pub page_id: Option<String>,
    pub att_id: Option<String>,
    pub ord: i64,
    pub loc: String,
    pub snippet: String,
    pub score: f64,
}

/// 块级查询的准备：trim + **查询侧归一化**（与 `prepare_query` 同口径）。
///
/// 不归一化的后果和页面级一样、但更难查：会出现"**全库搜得到、块搜搜不到**"
/// （`blocks.rs` 上已经踩过一次同类的坑）。
pub(crate) fn prepare_chunk_query(raw: &str) -> String {
    crate::textnorm::normalize_for_match(raw.trim())
}

/// `sqlite_master` 里有没有这张表（老库可能还没迁移；缺表要**当空结果**，不是错误）。
fn table_exists(c: &Connection, name: &str) -> bool {
    c.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |_| Ok(()),
    )
    .is_ok()
}

/// `chunk_embeddings` 里那条向量**能不能用**：模型必须一致，且 `hash` 必须与**块自己的 hash** 一致。
///
/// 抽成纯函数就是为了能直接测这条规则本身 —— hash 对不上却仍用那条向量，等于"改了内容还在用旧向量"，
/// 而那正是 `hash` 这一列存在的理由。
fn chunk_vector_usable(row_model: &str, row_hash: &str, chunk_hash: &str, want_model: &str) -> bool {
    row_model == want_model && !row_hash.is_empty() && row_hash == chunk_hash
}

struct ChunkRow {
    id: String,
    page_id: Option<String>,
    att_id: Option<String>,
    ord: i64,
    loc: String,
    text: String,
    hash: String,
}

fn read_chunks(c: &Connection) -> Result<Vec<ChunkRow>, String> {
    if !table_exists(c, "chunks") {
        return Ok(Vec::new());
    }
    let mut stmt = c
        .prepare("SELECT id, page_id, att_id, ord, loc, text, hash FROM chunks")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ChunkRow {
                id: r.get(0)?,
                page_id: r.get(1)?,
                att_id: r.get(2)?,
                ord: r.get(3)?,
                loc: r.get(4)?,
                text: r.get(5)?,
                hash: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// 纯排序：关键词覆盖分（复用页面级同一个 `keyword_score`）+ **有界**的 BM25 加分 + **有界**向量加分。
///
/// ⚠️ **候选集与"没有 BM25"那一版完全一致**：BM25 与向量两条加分都**只在 `kw > 0` 时**生效
/// （两个 `if kw > 0.0`），所以"哪些块进结果"没有被这次改动改变 —— 变的是**同分块之间的先后**。
/// 这是有意的：召回变化该有自己的一组判据，不该混在"加个 BM25"里悄悄发生。
/// 排序稳定：同分按 `(page_id, att_id, ord, id)` 兜底 —— 否则同一查询两次调用顺序可能不同，测试必然 flake。
fn rank_chunks(
    query: &str,
    rows: Vec<ChunkRow>,
    vectors: &HashMap<String, Vec<f32>>,
    query_vec: Option<&[f32]>,
    bm25: &HashMap<String, f32>,
) -> Vec<(ChunkRow, f32)> {
    let mut scored: Vec<(ChunkRow, f32)> = Vec::new();
    for row in rows {
        let kw = keyword_score(query, "", &row.text);
        let mut score = kw;
        if kw > 0.0 {
            if let Some(b) = bm25.get(&row.id) {
                score += CHUNK_BM25_BONUS * b;
            }
            if let (Some(qv), Some(cv)) = (query_vec, vectors.get(&row.id)) {
                score += CHUNK_VECTOR_BONUS * cosine_sim(qv, cv);
            }
        }
        if score <= 0.0 {
            continue;
        }
        scored.push((row, score));
    }
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.page_id.cmp(&b.0.page_id))
            .then_with(|| a.0.att_id.cmp(&b.0.att_id))
            .then_with(|| a.0.ord.cmp(&b.0.ord))
            .then_with(|| a.0.id.cmp(&b.0.id))
    });
    scored
}

/// 读 `chunk_embeddings`（表在就全读；用不到的行直接丢掉，`chunk_vector_usable` 决定）。
fn read_chunk_vectors(
    c: &Connection,
    rows: &[ChunkRow],
    model: Option<&str>,
) -> std::collections::HashMap<String, Vec<f32>> {
    let mut out = std::collections::HashMap::new();
    let Some(model) = model else { return out };
    if !table_exists(c, "chunk_embeddings") {
        return out;
    }
    let by_id: std::collections::HashMap<&str, &str> =
        rows.iter().map(|r| (r.id.as_str(), r.hash.as_str())).collect();
    let Ok(mut stmt) = c.prepare("SELECT chunk_id, model, vector, hash FROM chunk_embeddings") else {
        return out;
    };
    let Ok(iter) = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    }) else {
        return out;
    };
    for row in iter.flatten() {
        let (id, row_model, vec_s, row_hash) = row;
        let Some(chunk_hash) = by_id.get(id.as_str()) else { continue };
        if !chunk_vector_usable(&row_model, &row_hash, chunk_hash, model) {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Vec<f32>>(&vec_s) {
            if !v.is_empty() {
                out.insert(id, v);
            }
        }
    }
    out
}

pub(crate) fn search_chunks_in_conn(
    c: &Connection,
    query: &str,
    limit: usize,
    query_vec: Option<&[f32]>,
    model: Option<&str>,
) -> Result<Vec<ChunkHit>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let rows = read_chunks(c)?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    // 索引自愈 + BM25：两步都**不阻断**搜索（索引出问题 ⇒ 退化成"没有 BM25 那一路"，
    // 而不是让 AI 的检索整条失败 —— 派生索引只是加速/排序，不是真相来源）。
    let _ = ensure_chunk_fts(c);
    let wanted: HashSet<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    let bm25 = read_chunk_bm25(c, query, &wanted);
    let vectors = read_chunk_vectors(c, &rows, model);
    let hits = rank_chunks(query, rows, &vectors, query_vec, &bm25);
    Ok(hits
        .into_iter()
        .take(limit)
        .map(|(row, score)| ChunkHit {
            chunk_id: row.id.clone(),
            page_id: row.page_id.clone(),
            att_id: row.att_id.clone(),
            ord: row.ord,
            loc: row.loc.clone(),
            snippet: build_like_snippet(&row.text, query, CHUNK_SNIPPET_LEN),
            score: score as f64,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// 附件**派生文本**的读取（分页）—— 能力面 `files.read` 用（见信箱 reply-17 承接的草案）。
//
// 为什么放在 `search.rs`：这一族（`chunks` / `attachment_text`）都是"派生文本"，
// 而块级检索的读函数也在这里；放在一处，两个读者共用同一张表的口径（列名、`extractor` 语义、缺表处理）。
//
// ⚠️ 三条刻意的取舍：
//  1. **只给派生文本，不给原文字节** —— 派生文本是"只读、可重建、以原件为准"的缓存（§6.1）；
//     字节是另一类风险（体积/隐私/沙箱），要做成单独能力单独评审。
//  2. **"不存在" 与 "还没抽过" 必须分开**：前者 `None`（调用方回 `null`），后者空数组 + total 0。
//     合成一种（都返回空）就会让 AI 把"还没索引"读成"文件里没有"。
//  3. **多抽取器的行不替调用方挑一个**：`replace()` 是**按 (att_id, extractor)** 整体替换的
//     ⇒ 换过抽取器时旧行会与新的并存。这里按 `(extractor, seq)` 全列出来，并把 `extractor` 一并带出
//     —— 替调用方挑，就是静默丢内容（§15.10 同一条原则）。
// ---------------------------------------------------------------------------

/// 一页派生文本的上限（与注册表里 `limit` 的 desc 一致）。
pub(crate) const MAX_ATT_TEXT_LIMIT: usize = 1000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentTextSegment {
    /// 哪条抽取器产出的这一段（换过抽取器时，同一附件会有两组行）。
    pub extractor: String,
    pub kind: String,
    pub text: String,
    pub loc: String,
}

/// 某个抽取器上一次报的**覆盖度**（§15.10：成功 ≠ 抽全了）。
///
/// `coverage` 是**原始 JSON 字符串**，`""` ＝ **没有这一格**（旧数据 / 那个抽取器没报）。
/// ⚠️ 这里**不解析**：解析口径（空串或坏 JSON ⇒ 未知，而未知**不是**完整）只在 TS 的
/// `extract/store.ts::storedCoverageFrom` 一处（两个平台共用）。Rust 侧再解析一次就是给同一件事
/// 写第二份实现，而它漂移的后果是"把没抽全读成抽全了"。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentTextCoverageRow {
    pub extractor: String,
    pub coverage: String,
}

/// `(extractor, coverage)` 读数 —— **这一族的唯一一处 SQL**。
///
/// 为什么抽出来：这条读数有**两个**读者（能力面/命令面的 `read_attachment_text` 页面，与运输层的
/// `attachmentTextCoverage` 查询）。两处各写一份 SQL 就会长出两种语义（去重与否、排序、缺列怎么办），
/// 而它们的**漂移不会报错** —— 只会让桌面与 Web 给出不同的覆盖度读数。
///
/// 三条口径（与 TS 的 `store.ts::coverageOf` 逐条对齐）：
/// 1. `DISTINCT`：一行一段，但覆盖度是**每次抽取一份** ⇒ 必须去重；
/// 2. `ORDER BY extractor`：稳定顺序（调用方不必再排）；
/// 3. **缺列 ⇒ 空**：老库没跑过迁移时 `coverage` 列不存在，此时答复"**没有覆盖度信息**"
///    （未知），而不是让整条读失败 —— 读不到读数与没有读数是两件事，但对着"未知"这条语义
///    它们是同一个答复；把整条读变成错误才是更坏的那个选择。
pub(crate) fn read_attachment_text_coverage_in_conn(
    c: &Connection,
    att_id: &str,
) -> Result<Vec<AttachmentTextCoverageRow>, String> {
    let mut stmt = match c
        .prepare("SELECT DISTINCT extractor, coverage FROM attachment_text WHERE att_id = ?1 ORDER BY extractor ASC")
    {
        Ok(s) => s,
        Err(_) => return Ok(Vec::new()), // 老库没有 coverage 列 ⇒ 未知（见上面第 3 条）
    };
    let rows = stmt
        .query_map(params![att_id], |r| {
            Ok(AttachmentTextCoverageRow { extractor: r.get(0)?, coverage: r.get(1)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentTextPage {
    pub segments: Vec<AttachmentTextSegment>,
    /// **总段数**（不是本页条数）：没有它，调用方没法知道"自己只看到了一部分"。
    pub total: i64,
    pub truncated: bool,
    /// 每个抽取器上次报的覆盖度（可能为空 ＝ 未知）。
    ///
    /// 为什么跟段一起给：`truncated` 只说"这一页没给全"，覆盖度说的是"**抽取本身**就没抽全"
    /// —— 两件事都会被读成"内容就这些"。§15.10 的"成功 ≠ 抽全了"要落到读侧才算数。
    pub coverage: Vec<AttachmentTextCoverageRow>,
}

/// 读某个附件的派生文本（分页）。
///
/// 返回值语义（调用方按此回 `null` / 空数组）：
/// - `Ok(None)`：**这个附件不存在**（`attachments` 里没有它）；
/// - `Ok(Some(page))` 且 `segments` 为空：存在，但**还没有派生文本**（没抽过 / 没有抽取器认领 / 抽取失败）
///   —— 这是"没内容"，不是错误。
pub(crate) fn read_attachment_text_in_conn(
    c: &Connection,
    att_id: &str,
    offset: usize,
    limit: usize,
) -> Result<Option<AttachmentTextPage>, String> {
    let exists: Option<String> = c
        .query_row("SELECT id FROM attachments WHERE id = ?1", params![att_id], |r| r.get(0))
        .ok();
    if exists.is_none() {
        return Ok(None);
    }
    if !table_exists(c, "attachment_text") {
        // 老库没迁移过这张表 ⇒ 与"还没抽过"同一种答复（不是错误）
        return Ok(Some(AttachmentTextPage {
            segments: Vec::new(),
            total: 0,
            truncated: false,
            coverage: Vec::new(),
        }));
    }

    let total: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM attachment_text WHERE att_id = ?1",
            params![att_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let mut stmt = c
        .prepare(
            "SELECT extractor, kind, text, loc FROM attachment_text
             WHERE att_id = ?1 ORDER BY extractor ASC, seq ASC LIMIT ?2 OFFSET ?3",
        )
        .map_err(|e| e.to_string())?;
    let segments = stmt
        .query_map(params![att_id, limit as i64, offset as i64], |r| {
            Ok(AttachmentTextSegment {
                extractor: r.get(0)?,
                kind: r.get(1)?,
                text: r.get(2)?,
                loc: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let truncated = (offset as i64 + segments.len() as i64) < total;
    let coverage = read_attachment_text_coverage_in_conn(c, att_id)?;
    Ok(Some(AttachmentTextPage { segments, total, truncated, coverage }))
}

/// `read_attachment_text` 的参数（命令面；能力面走 `plugins.rs::cap_files_read`，同一条读函数）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadAttachmentTextArgs {
    pub id: String,
    #[serde(default)]
    pub offset: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
}

/// 命令面：读附件的派生文本（只读、分页）。
///
/// ⚠️ 与能力面（`cap_files_read`）**共用同一个读函数** —— 两处各写一份 SQL 就会长出两种语义
/// （一处按 `(extractor, seq)` 排序、另一处忘了排序 ⇒ 段落顺序不同却没人发现）。
/// 两面的差别只在"谁做权限/空间判定"：命令面拿的是主连接（活动空间），能力面走 `with_read_conn`。
#[tauri::command]
pub async fn read_attachment_text(
    db: State<'_, Db>,
    args: ReadAttachmentTextArgs,
) -> Result<Option<AttachmentTextPage>, String> {
    if args.id.trim().is_empty() {
        return Err("bad_args: id 不能为空".to_string());
    }
    let off = args.offset.unwrap_or(0).max(0) as usize;
    let lim = args.limit.unwrap_or(200).clamp(1, MAX_ATT_TEXT_LIMIT as i64) as usize;
    let c = db.0.lock().expect("db mutex poisoned");
    read_attachment_text_in_conn(&c, &args.id, off, lim)
}

/// 块级检索命令（只读）。
///
/// ⚠️ 三处刻意的选择：①查询先归一化再分派；②嵌入在**取锁之前**算完（不跨 await 持 `MutexGuard`）；
/// ③嵌入没配/调用失败 ⇒ 静默退回关键词（与页面级 `search_semantic_async` 同口径，绝不因此报错）。
#[tauri::command]
pub async fn search_chunks(
    db: State<'_, Db>,
    args: SearchChunksArgs,
) -> Result<Vec<ChunkHit>, String> {
    let query = prepare_chunk_query(&args.query);
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = chunk_limit_or_default(args.limit);

    let mut query_vec: Option<Vec<f32>> = None;
    let mut model: Option<String> = None;
    if let Some(cfg) = args.embedding.as_ref() {
        model = Some(cfg.model.clone());
        query_vec = embed_text(cfg, &query).await.unwrap_or(None);
    }

    let c = db.0.lock().expect("db mutex poisoned");
    search_chunks_in_conn(&c, &query, limit, query_vec.as_deref(), model.as_deref())
}

#[cfg(test)]
mod tests {

    /// 命令面 `limit` 的三个读数：默认值（命令面自己的 20）、下界、上界。
    #[test]
    fn chunk_limit_follows_the_registry_default_and_clamps_both_ends() {
        assert_eq!(
            chunk_limit_or_default(None),
            20,
            "命令面默认值（不是注册表那个 10 —— 两个面各自的契约，见 CHUNK_LIMIT_DEFAULT 的注释）"
        );
        assert_eq!(chunk_limit_or_default(Some(0)), 1, "0 是合法值，夹到下界（与能力面 clamp(1,100) 一致）");
        assert_eq!(chunk_limit_or_default(Some(1)), 1);
        assert_eq!(chunk_limit_or_default(Some(37)), 37);
        assert_eq!(chunk_limit_or_default(Some(CHUNK_LIMIT_MAX)), CHUNK_LIMIT_MAX);
        assert_eq!(chunk_limit_or_default(Some(9999)), CHUNK_LIMIT_MAX, "超上限夹到上限");
    }

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

    /// 入口归一化：用户从 PDF 粘来的兼容形必须被折成统一表意字。
    #[test]
    fn prepare_query_folds_compat_ideographs() {
        let (text, _) = prepare_query("  第\u{2F00}段  ");
        assert_eq!(text, "第一段");
        // 属性过滤那一段不能被归一化搞坏（它有自己的语法：`prop:名称=值`；
        // 注意过滤器里的值**不折** —— 它是属性值，不是检索文本）
        let (text, filters) = prepare_query("第\u{2F00}段 prop:状态=进行中");
        assert_eq!(text, "第一段");
        assert_eq!(filters, vec![("状态".to_string(), "进行中".to_string())]);
    }

    /// **先证伪再修**的端到端：正文里存的是折叠后的「第一段」，用户粘兼容形来搜 ——
    /// 不归一化搜不到（先断言这条），走入口归一化就搜得到（再断言这条）。
    /// 用真 SQLite 的 LIKE 路径跑：`search_like` 就是"<3 字走 LIKE"那条分支的实现。
    #[test]
    fn compat_ideograph_query_matches_folded_body_end_to_end() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "ATTACH DATABASE ':memory:' AS meta;
             CREATE TABLE meta.workspaces (id TEXT PRIMARY KEY, name TEXT);
             INSERT INTO meta.workspaces (id, name) VALUES ('ws1', '空间一');
             CREATE TABLE pages (
               id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT,
               content_text TEXT, updated_at INTEGER, deleted_at INTEGER
             );
             INSERT INTO pages VALUES ('p1', 'ws1', '题目', '第一段，第二段。', 1, NULL);",
        )
        .unwrap();

        let raw = "第\u{2F00}段"; // 兼容形：康熙部首 ⼀
        assert!(
            search_like(&c, raw, 10).unwrap().is_empty(),
            "原样查询居然命中了 —— 那这条 e2e 就证明不了任何事（先证伪这一步失效）"
        );

        let (folded, _) = prepare_query(raw);
        let hits = search_like(&c, &folded, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "p1");
        // snippet 也必须能找到（否则高亮在已折叠的正文里落空）
        assert!(hits[0].snippet.contains("第一段"), "snippet={}", hits[0].snippet);
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

    // ---- 块级检索（只读）：接口与判据见信箱 2026-09-17-retrieval-query-normalization.reply-1 ----

    /// 查 chunk 用的最小库：`chunks` + `chunk_embeddings`（与 TS 侧 DDL 同形的那几列）。
    fn chunks_conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE chunks (
               id TEXT PRIMARY KEY, page_id TEXT, att_id TEXT, ord INTEGER NOT NULL,
               loc TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL DEFAULT '',
               text TEXT NOT NULL, hash TEXT NOT NULL
             );
             CREATE TABLE chunk_embeddings (
               chunk_id TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL,
               vector TEXT NOT NULL, hash TEXT NOT NULL, updated_at INTEGER NOT NULL,
               PRIMARY KEY (chunk_id, model)
             );",
        )
        .unwrap();
        c
    }

    fn add_chunk(c: &Connection, id: &str, page: Option<&str>, att: Option<&str>, ord: i64, loc: &str, text: &str, hash: &str) {
        c.execute(
            "INSERT INTO chunks (id, page_id, att_id, ord, loc, lang, text, hash) VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7)",
            params![id, page, att, ord, loc, text, hash],
        )
        .unwrap();
    }

    // ---- 块级 BM25（P2 的"混合检索"那半，2026-09-19 AMD）----
    //
    // 索引是**桌面专属**（`sql.js` 没编 FTS5，见 `db::CHUNK_FTS_DDL` 的注释），
    // 建表与触发器都在 `db::migrate` 里。这三条判据守的是"索引真的跟着写走"与
    // "BM25 只改排序、不改召回"。

    /// 建库时**用真正会执行的那份 DDL**（`db::CHUNK_FTS_DDL`），不抄一份。
    fn chunks_conn_with_fts() -> Connection {
        let c = chunks_conn();
        c.execute_batch(crate::db::CHUNK_FTS_DDL).unwrap();
        c
    }

    fn fts_hits(c: &Connection, term: &str) -> Vec<String> {
        let mut stmt = c
            .prepare("SELECT chunk_id FROM chunk_fts WHERE chunk_fts MATCH ?1 ORDER BY chunk_id")
            .unwrap();
        let out = stmt
            .query_map(params![format!("\"{term}\"")], |r| r.get::<_, String>(0))
            .unwrap()
            .flatten()
            .collect();
        out
    }

    /// ★ 判据 1：**三个触发器**让索引跟着任何写入方走（不需要写入方记得刷索引）。
    ///
    /// 失败面：少了触发器 ⇒ 索引停在建表那一刻，检索"看不见新内容"（而且没有信号）。
    #[test]
    fn chunk_index_follows_writes_through_triggers() {
        let c = chunks_conn_with_fts();
        add_chunk(&c, "p:p1#0", Some("p1"), None, 0, "", "制度第三十七条 报销流程", "h1");
        assert_eq!(fts_hits(&c, "第三十七条"), vec!["p:p1#0"], "INSERT 后应当能检索到");

        // UPDATE：旧文本必须**不再**命中，新文本要命中（只删不插或只插不删都会在这里露出来）。
        c.execute("UPDATE chunks SET text = '制度第三十八条 差旅标准' WHERE id = 'p:p1#0'", []).unwrap();
        assert!(fts_hits(&c, "第三十七条").is_empty(), "UPDATE 后旧文本不该还命中");
        assert_eq!(fts_hits(&c, "差旅标准"), vec!["p:p1#0"], "UPDATE 后新文本该命中");

        // DELETE：整条记录必须从索引里消失（否则会返回一个已经不存在的块 id）。
        c.execute("DELETE FROM chunks WHERE id = 'p:p1#0'", []).unwrap();
        assert!(fts_hits(&c, "差旅标准").is_empty(), "DELETE 后不该还有残留");
    }

    /// ★ 判据 2：老库（先有 `chunks`、后加索引）由 `ensure_chunk_fts` **自愈**重建。
    ///
    /// 失败面：不做自愈 ⇒ 升级上来的库里 BM25 永远空（且看上去"就是没有匹配"）。
    #[test]
    fn ensure_chunk_fts_backfills_a_stale_index() {
        let c = chunks_conn();
        // 先写数据、**后**建索引 —— 正是升级路径的形状。
        add_chunk(&c, "p:p1#0", Some("p1"), None, 0, "", "报销流程 第一条", "h1");
        add_chunk(&c, "p:p1#1", Some("p1"), None, 1, "", "差旅标准 第二条", "h2");
        c.execute_batch(crate::db::CHUNK_FTS_DDL).unwrap();
        assert!(fts_hits(&c, "报销流程").is_empty(), "刚建好的索引是空的（触发器不追溯历史行）");

        ensure_chunk_fts(&c).unwrap();
        assert_eq!(fts_hits(&c, "报销流程"), vec!["p:p1#0"]);
        assert_eq!(fts_hits(&c, "差旅标准"), vec!["p:p1#1"]);

        // 再跑一次：计数已平 ⇒ 幂等，不做无谓重建。
        ensure_chunk_fts(&c).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM chunk_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }

    /// 判据 3：`MATCH` 表达式必须**给每个词加引号**（否则 `-`、`*`、`:`、`OR` 这些会被当语法，
    /// 用户随手输入的普通字符串会让查询报错），引号自身双写转义。
    #[test]
    fn chunk_match_expr_quotes_terms_and_rejects_empty() {
        assert_eq!(chunk_match_expr("报销 流程").as_deref(), Some("\"报销\" \"流程\""));
        assert_eq!(chunk_match_expr("a-b").as_deref(), Some("\"a-b\""));
        assert_eq!(chunk_match_expr("a\"b").as_deref(), Some("\"a\"\"b\""));
        assert_eq!(chunk_match_expr("   "), None, "空白查询 ⇒ None（跳过 FTS，不是错误）");
        assert_eq!(chunk_match_expr(""), None);
    }

    /// ★ 判据 4：BM25 加分**有界**且**不改召回集**。
    ///
    /// 为什么把它当判据：把 BM25 做成"取代关键词分"会悄悄改变"哪些块进结果"，
    /// 而召回变化是用户可见的。这条钉住：给任何 bm25 表，命中的 **id 集合**都不变，
    /// 且加分确实**只增不减**（下界 0、上界 `CHUNK_BM25_BONUS`）。
    #[test]
    fn bm25_boost_is_bounded_and_never_changes_the_hit_set() {
        let c = chunks_conn_with_fts();
        add_chunk(&c, "p:p1#0", Some("p1"), None, 0, "", "报销流程 报销流程", "h1");
        add_chunk(&c, "p:p1#1", Some("p1"), None, 1, "", "报销流程 附件清单", "h2");
        add_chunk(&c, "p:p1#2", Some("p1"), None, 2, "", "与查询无关的内容", "h3");
        let rows = read_chunks(&c).unwrap();
        let wanted: HashSet<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        let bm25 = read_chunk_bm25(&c, "报销流程", &wanted);
        assert!(!bm25.is_empty(), "FTS 命中的块应当拿到 BM25 分");
        assert!(bm25.values().all(|v| *v >= 0.0 && *v <= 1.0), "归一化后必须落在 [0,1]");

        // ★ 归一化的**形状**也要钉住（第一版只钉了区间 ⇒ 去掉归一化仍绿，变异实测抓到）：
        //   逐块把原始分读出来，断言映射值 == normalize_bm25(原始分)。
        for id in ["p:p1#0", "p:p1#1"] {
            let raw: f64 = c
                .query_row(
                    "SELECT bm25(chunk_fts) FROM chunk_fts WHERE chunk_fts MATCH ?1 AND chunk_id = ?2",
                    params!["\"报销流程\"", id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(bm25.get(id).copied(), Some(normalize_bm25(raw)), "{id} 必须是归一化后的值");
        }
        // 上界是**严格**小于 1（原始分再大也不会到 1），且随原始分单调。
        assert!(normalize_bm25(-3.0) < 1.0, "上界必须严格小于 1");
        assert!(normalize_bm25(-3.0) > normalize_bm25(-1.0), "原始分越大（越相关）映射值越大");
        assert_eq!(normalize_bm25(0.0), 0.0);
        assert_eq!(normalize_bm25(5.0), 0.0, "正的 bm25（不该出现）夹到 0，不产生负加分");

        let ids = |hits: &[(ChunkRow, f32)]| {
            let mut v: Vec<String> = hits.iter().map(|(r, _)| r.id.clone()).collect();
            v.sort();
            v
        };
        let without = rank_chunks("报销流程", read_chunks(&c).unwrap(), &HashMap::new(), None, &HashMap::new());
        let with = rank_chunks("报销流程", read_chunks(&c).unwrap(), &HashMap::new(), None, &bm25);
        assert_eq!(ids(&without), ids(&with), "BM25 只许改排序，不许改命中集");

        // 加分只增不减：同一个块，带 bm25 的分数 ≥ 不带。
        let score_of = |hits: &[(ChunkRow, f32)], id: &str| {
            hits.iter().find(|(r, _)| r.id == id).map(|(_, s)| *s).unwrap_or(f32::NAN)
        };
        for id in ["p:p1#0", "p:p1#1"] {
            assert!(
                score_of(&with, id) >= score_of(&without, id),
                "{id} 的分数不该因为 BM25 变小"
            );
        }
    }

    /// `hash` 对不上就不能用那条向量 —— 否则"改了内容还在用旧向量"，而 `hash` 这列的存在就是为了防这个。
    #[test]
    fn chunk_vector_is_rejected_when_model_or_hash_disagrees() {        assert!(chunk_vector_usable("m1", "abc", "abc", "m1"));
        assert!(!chunk_vector_usable("m1", "abc", "abc", "m2"), "模型换了就不能用旧向量");
        assert!(!chunk_vector_usable("m1", "abc", "def", "m1"), "块内容变了（hash 变）就不能用旧向量");
        assert!(!chunk_vector_usable("m1", "", "abc", "m1"), "空 hash 视为不可用");
    }

    /// 查询侧归一化与页面级同口径（否则会"全库搜得到、块搜搜不到"）。
    #[test]
    fn chunk_query_is_normalized_like_page_search() {
        assert_eq!(prepare_chunk_query("  第\u{2F00}段  "), "第一段");
    }

    /// 两类 owner 都要能命中，且都要把回链信息带出来。
    #[test]
    fn chunk_search_hits_both_owners_and_carries_backlinks() {
        let c = chunks_conn();
        add_chunk(&c, "page:p1#0", Some("p1"), None, 0, "L1", "周会纪要：本周排期", "h1");
        add_chunk(&c, "att:a1#0", None, Some("a1"), 0, "p.3", "扫描件里的周会纪要", "h2");
        add_chunk(&c, "page:p2#0", Some("p2"), None, 0, "L1", "与此无关的内容", "h3");

        let hits = search_chunks_in_conn(&c, "周会纪要", 10, None, None).unwrap();
        assert_eq!(hits.len(), 2, "无关的块不该进结果：{:#?}", hits.iter().map(|h| &h.chunk_id).collect::<Vec<_>>());
        let page_hit = hits.iter().find(|h| h.chunk_id == "page:p1#0").unwrap();
        assert_eq!(page_hit.page_id.as_deref(), Some("p1"));
        assert_eq!(page_hit.att_id, None);
        assert_eq!(page_hit.loc, "L1");
        let att_hit = hits.iter().find(|h| h.chunk_id == "att:a1#0").unwrap();
        assert_eq!(att_hit.att_id.as_deref(), Some("a1"));
        assert_eq!(att_hit.loc, "p.3");
        assert!(!page_hit.snippet.is_empty());
    }

    /// 兼容表意字：库里存的是折叠后的「第一段」，用兼容形查也要命中（与页面级同一口径）。
    #[test]
    fn chunk_search_matches_compat_ideograph_query() {
        let c = chunks_conn();
        add_chunk(&c, "page:p1#0", Some("p1"), None, 0, "L1", "第一段，第二段。", "h1");
        // 先证伪：不归一化的查询搜不到
        assert!(search_chunks_in_conn(&c, "第\u{2F00}段", 10, None, None).unwrap().is_empty());
        // 走入口归一化后能搜到
        let q = prepare_chunk_query("第\u{2F00}段");
        assert_eq!(search_chunks_in_conn(&c, &q, 10, None, None).unwrap().len(), 1);
    }

    #[test]
    fn chunk_search_empty_query_or_missing_table_is_empty_not_error() {
        let c = chunks_conn();
        add_chunk(&c, "page:p1#0", Some("p1"), None, 0, "L1", "周会纪要", "h1");
        assert!(search_chunks_in_conn(&c, "", 10, None, None).unwrap().is_empty());

        // 老库没迁移过 `chunks` ⇒ 空结果（向前兼容），不是报错
        let bare = Connection::open_in_memory().unwrap();
        assert!(search_chunks_in_conn(&bare, "周会纪要", 10, None, None).unwrap().is_empty());
    }

    /// 过期的向量（hash 对不上）**不许**影响排序：结果必须与"纯关键词"完全一致。
    #[test]
    fn stale_chunk_vector_does_not_change_ranking() {
        let c = chunks_conn();
        add_chunk(&c, "page:p1#0", Some("p1"), None, 0, "L1", "周会纪要", "h1");
        add_chunk(&c, "page:p2#0", Some("p2"), None, 0, "L1", "周会", "h2");
        let kw_only: Vec<String> = search_chunks_in_conn(&c, "周会", 10, None, None).unwrap().into_iter().map(|h| h.chunk_id).collect();

        // 给 p2 塞一条"很相似"的向量，但 hash 是**旧的**
        c.execute(
            "INSERT INTO chunk_embeddings (chunk_id, model, dim, vector, hash, updated_at) VALUES (?1, ?2, 3, ?3, ?4, 0)",
            params!["page:p2#0", "m1", "[1.0,0.0,0.0]", "stale-hash"],
        )
        .unwrap();
        let with_stale: Vec<String> = search_chunks_in_conn(&c, "周会", 10, Some(&[1.0, 0.0, 0.0]), Some("m1"))
            .unwrap()
            .into_iter()
            .map(|h| h.chunk_id)
            .collect();
        assert_eq!(kw_only, with_stale, "hash 对不上的向量不该被采用");

        // 反过来：hash 一致时，向量加分应当生效（否则这条判据证明不了任何事）
        c.execute("UPDATE chunk_embeddings SET hash = 'h2' WHERE chunk_id = 'page:p2#0'", []).unwrap();
        let hits = search_chunks_in_conn(&c, "周会", 10, Some(&[1.0, 0.0, 0.0]), Some("m1")).unwrap();
        let p2 = hits.iter().find(|h| h.chunk_id == "page:p2#0").unwrap();
        let p1 = hits.iter().find(|h| h.chunk_id == "page:p1#0").unwrap();
        assert!(p2.score > p1.score, "hash 一致时向量加分要生效：p2={} p1={}", p2.score, p1.score);
    }

    /// 同分时顺序必须稳定（否则测试会 flake、UI 也会看到顺序忽变）。
    #[test]
    fn chunk_ranking_is_stable_on_ties() {
        let c = chunks_conn();
        add_chunk(&c, "page:p2#0", Some("p2"), None, 0, "L1", "周会", "h1");
        add_chunk(&c, "page:p1#0", Some("p1"), None, 0, "L1", "周会", "h2");
        add_chunk(&c, "page:p1#1", Some("p1"), None, 1, "L2", "周会", "h3");
        let a: Vec<String> = search_chunks_in_conn(&c, "周会", 10, None, None).unwrap().into_iter().map(|h| h.chunk_id).collect();
        let b: Vec<String> = search_chunks_in_conn(&c, "周会", 10, None, None).unwrap().into_iter().map(|h| h.chunk_id).collect();
        assert_eq!(a, b);
        // 同分按 (page_id, ord) 兜底
        assert_eq!(a, vec!["page:p1#0".to_string(), "page:p1#1".to_string(), "page:p2#0".to_string()]);
    }

    // ---- 附件派生文本的读取（`files.read` / `read_attachment_text` 共用那一条函数）----
    //
    // 补这组判据的理由：`read_attachment_text_in_conn` 此前**一条判据都没有** ——
    // Web 侧有行为判据（`derivedText.test.ts`），桌面侧只有"命令在不在"的契约级覆盖。
    // 而这一族最要紧的两条语义（"不存在" ≠ "还没抽过"、覆盖度只是**未知**时不许当成完整）
    // 都只在读侧才看得见。

    /// 用**真 DDL**（`db::DERIVED_SCHEMA_DDL`，含 `coverage` 列）建派生三表 + 一张最小 `attachments`。
    /// 不手抄列：抄一份就有一份会漂，而漂的症状是"判据绿、真库红"。
    fn att_text_conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE attachments (id TEXT PRIMARY KEY);").unwrap();
        for stmt in crate::db::DERIVED_SCHEMA_DDL {
            c.execute_batch(stmt).unwrap();
        }
        c
    }

    fn add_att_text(c: &Connection, att: &str, extractor: &str, seq: i64, text: &str, coverage: &str) {
        c.execute(
            "INSERT INTO attachment_text (att_id, extractor, seq, kind, text, loc, src_hash, updated_at, coverage) \
             VALUES (?1, ?2, ?3, 'para', ?4, '', 'h1', 1, ?5)",
            params![att, extractor, seq, text, coverage],
        )
        .unwrap();
    }

    /// ★ 判据：`read_attachment_text_in_conn` 的三种答复**必须分开**，且覆盖度原样带出。
    ///
    /// 失败面（这条就是为它写的）：把"附件不存在"与"还没抽过"合成一种（都回空）⇒
    /// AI 会把"还没索引"读成"文件里没有相关内容"；而覆盖度丢了 ⇒ 读侧无法区分
    /// "抽取本身没抽全"与"内容就这些"（§15.10）。
    #[test]
    fn read_attachment_text_separates_missing_from_empty_and_carries_coverage() {
        let c = att_text_conn();
        // ① 不存在 ⇒ None（调用方回 null），**不是**空页
        assert!(read_attachment_text_in_conn(&c, "没有这个附件", 0, 200).unwrap().is_none());

        // ② 存在但还没抽过 ⇒ 空段 + total 0 + **没有覆盖度读数**
        c.execute("INSERT INTO attachments (id) VALUES ('a1')", []).unwrap();
        let page = read_attachment_text_in_conn(&c, "a1", 0, 200).unwrap().unwrap();
        assert!(page.segments.is_empty());
        assert_eq!(page.total, 0);
        assert!(!page.truncated);
        assert!(page.coverage.is_empty(), "没抽过 ⇒ 没有覆盖度（既不是 complete 也不是空字符串一条）");

        // ③ 抽过：两段同一个抽取器（覆盖度去重成**一条**）+ 另一个抽取器没报覆盖度（空串 ⇒ 未知）
        c.execute("INSERT INTO attachments (id) VALUES ('a2')", []).unwrap();
        add_att_text(&c, "a2", "pdf.text@1", 0, "第一段", r#"{"complete":false,"gapIndexes":[2]}"#);
        add_att_text(&c, "a2", "pdf.text@1", 1, "第二段", r#"{"complete":false,"gapIndexes":[2]}"#);
        add_att_text(&c, "a2", "pdf.ocr@1", 0, "OCR 段", "");
        let page = read_attachment_text_in_conn(&c, "a2", 0, 200).unwrap().unwrap();
        assert_eq!(page.total, 2 + 1);
        assert_eq!(page.segments.len(), 3);
        assert_eq!(page.coverage.len(), 2, "覆盖度是每次抽取一份：两段不许出两条");
        assert_eq!(page.coverage[0].extractor, "pdf.ocr@1", "按 extractor 稳定排序");
        assert_eq!(page.coverage[0].coverage, "", "没报 ⇒ 空串（未知），**不是** complete");
        assert_eq!(page.coverage[1].extractor, "pdf.text@1");
        assert_eq!(
            page.coverage[1].coverage, r#"{"complete":false,"gapIndexes":[2]}"#,
            "原样字符串：Rust 不解析（解析口径只在 TS 那一处）"
        );

        // ④ 分页只影响段，**不影响覆盖度**（覆盖度是整次抽取的读数，不是本页的）
        let head = read_attachment_text_in_conn(&c, "a2", 0, 1).unwrap().unwrap();
        assert_eq!(head.segments.len(), 1);
        assert!(head.truncated, "还有没给的段");
        assert_eq!(head.coverage.len(), 2, "翻到哪一页，覆盖度读数都该是同一份");
        let tail = read_attachment_text_in_conn(&c, "a2", 5, 200).unwrap().unwrap();
        assert!(tail.segments.is_empty());
        assert!(!tail.truncated, "越界不报错，truncated 为假");
        assert_eq!(tail.coverage.len(), 2);
    }

    /// ★ 判据：**老库没有 `coverage` 列**时，读取仍要能工作，且覆盖度答复是"**没有读数**"。
    ///
    /// 为什么单列一条：`migrate` 会给老库补这一列，但"没跑过迁移的库"照样能被读到（比如直接打开一个
    /// 旧文件）。此时的正确答复是"未知"（空读数），**不是**让 `files.read` 整条失败 ——
    /// 前者是"我们不知道抽全没有"，后者是"连内容都读不出来"。
    #[test]
    fn read_attachment_text_tolerates_an_old_table_without_the_coverage_column() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE attachments (id TEXT PRIMARY KEY);
             CREATE TABLE attachment_text (
               att_id TEXT NOT NULL, extractor TEXT NOT NULL, seq INTEGER NOT NULL,
               kind TEXT NOT NULL, text TEXT NOT NULL, loc TEXT NOT NULL DEFAULT '',
               src_hash TEXT NOT NULL, updated_at INTEGER NOT NULL,
               PRIMARY KEY (att_id, extractor, seq)
             );
             INSERT INTO attachments (id) VALUES ('a1');
             INSERT INTO attachment_text (att_id, extractor, seq, kind, text, loc, src_hash, updated_at)
               VALUES ('a1', 'pdf.text@1', 0, 'para', '老库里的段', '', 'h1', 1);",
        )
        .unwrap();

        let page = read_attachment_text_in_conn(&c, "a1", 0, 200).unwrap().unwrap();
        assert_eq!(page.segments.len(), 1, "段照样读得出来（不许因为少了覆盖度列就整条失败）");
        assert_eq!(page.segments[0].text, "老库里的段");
        assert!(page.coverage.is_empty(), "缺列 ⇒ 没有覆盖度读数（未知），不是 complete");
        assert!(read_attachment_text_coverage_in_conn(&c, "a1").unwrap().is_empty());
    }
}
