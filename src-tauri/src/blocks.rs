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

pub(crate) fn parse_json(content_json: &str) -> Result<Value, String> {
    serde_json::from_str(content_json).map_err(|e| e.to_string())
}

pub(crate) fn root_children(v: &Value) -> Vec<&Value> {
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

pub(crate) fn node_text(node: &Value) -> String {
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

    let page = crate::doc_content::read(&c, &page_id)?
        .ok_or_else(|| "页面不存在".to_string())?;

    let snippet = snippet_for_block(&page.json, &block_id);
    let content = block_text(&page.json, &block_id)
        .map(|t| t.trim().to_string())
        .unwrap_or_default();
    Ok(BlockInfo {
        block_id,
        page_id,
        page_title: page.title,
        snippet,
        content,
    })
}

/// 顶层块提取 —— `get_page_blocks` 的**唯一实现**（纯函数 ⇒ **可单测** ✓）。
///
/// ⚠️ 为什么抽出来：2026-10-10 这里犯过一个**用户可见的错** ✗ ——
/// 旧实现要求顶层块**必须有 `blockId`**，而**真实存下来的普通页面根本没有这个字段** ✗
/// （实测：`root.children.length = 1`，而该子节点的键里没有 `blockId` ✓）⇒ 过滤后**永远返回空** ✗，
/// 手机档 04 阅读屏于是对**有正文的页**显示「这一页还没有内容」✗。
///
/// ⚠️ **同语义的另一半在 web 侧** ✓：`src/lib/platform/pageBlocks.ts::pageBlocksFromDoc`
/// —— 两处**必须同语义**（`blockId` 有就用、没有按位置回退；空文本的块不收 ✓），
/// 否则"桌面能看、手机看不到"这类不一致会再长回来 ✗。`blockId` 只在块被引用/嵌入时才存在
/// （见 `src/lib/blockIdentity.ts`）⇒ 它**不能**当"有没有正文"的判据 ✗。
pub(crate) fn page_blocks_from_doc(content_json: &str) -> Result<Vec<PageBlock>, String> {
    let v = parse_json(content_json)?;
    let mut blocks = Vec::new();
    // ⚠️ `i` 是**顶层块的位置**（含被跳过的空块），用作没有 `blockId` 时的回退 id ✓。
    let mut i: usize = 0;
    for child in root_children(&v) {
        let text = node_text(child).trim().to_string();
        // 空文本块不收 ✓（与 web 侧 `pageBlocksFromDoc` 同语义 ✓）。
        if !text.is_empty() {
            // ⭐ `blockId` 是**可选字段** —— 只在块被引用/嵌入时才存在（见 `src/lib/blockIdentity.ts` ✓）。
            //    ⛔ 它**不能**当"有没有正文"的判据 ✗：真实存下来的普通页面根本没有这个键，
            //    这么写会让**有正文的页永远返回空** ✗（2026-10-10 的用户可见错：手机阅读屏显示
            //    「这一页还没有内容。」✗）。⇒ 没有就**按位置回退** ✓。
            let block_id = child
                .get("blockId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("block-{}", i));
            blocks.push(PageBlock { block_id, text });
        }
        i += 1;
    }
    Ok(blocks)
}

#[tauri::command]
pub async fn get_page_blocks(db: State<'_, Db>, page_id: String) -> Result<Vec<PageBlock>, String> {
    let c = db.0.lock().expect("db mutex poisoned");

    let content_json = crate::doc_content::read(&c, &page_id)?
        .ok_or_else(|| "页面不存在".to_string())?
        .json;

    page_blocks_from_doc(&content_json)
}

#[tauri::command]
pub fn search_blocks(db: State<'_, Db>, query: String) -> Result<Vec<SearchBlock>, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    // 查询侧归一化（§15.9）：与 `search.rs` 同一口径 —— 块搜索也是查询入口，
    // 少了这一步会变成"全库搜得到、块搜搜不到"这种最难查的不一致。
    let q = crate::textnorm::normalize_for_match(query.trim());
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
    // ★ 读出口走「文档内容」那一层（阶段 0 接口收口）：谓词与原 SQL **逐字相同**（`deleted_at IS NULL`）。
    //   读不到（页不存在/已软删）仍按**搬运前的语义**退化成 `"{}"`（不是报错）——
    //   这条"缺页给空文档"是调用方契约的一部分，搬动时不许改。
    let target_json: String = crate::doc_content::read(&c, &page_id)?
        .map(|d| d.json)
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

/// **CRDT 之后的"落盘形态"喂进块图/FTS** 这条实跑（我 2026-09-19 在
/// `crdt-spike-q2-second-slice.reply-1` §一-② 里认下的那格，AMD 把输入前提钉住了）：
///
/// 前提（AMD 实测）：模型形态（`shuyo-paragraph` + id）过 `toLegacyDoc` ⇒
/// **id 仍在顶层**、`type` 回到老形态、产物里没有 `shuyo-paragraph`。
/// ⇒ 本判据要证明的是：**那样一份 JSON 真的喂进去，块表/块图/FTS 都正常**，
/// 而不是"从形状看应该正常"。
#[cfg(test)]
mod crdt_legacy_input_tests {
    use super::*;
    use crate::search::sync_fts;
    use rusqlite::Connection;
    use serde_json::json;

    const SPACE: &str = "space-crdt-input";
    const TARGET_BLOCK: &str = "22222222-2222-4222-8222-222222222222";
    const SOURCE_BLOCK: &str = "11111111-1111-4111-8111-111111111111";
    /// 只出现在**嵌套**里 —— 用来钉住"索引只取顶层块"（嵌套块不给身份）。
    const NESTED_BLOCK: &str = "33333333-3333-4333-8333-333333333333";

    /// 目标页：只有一个块，供块引用/嵌入指向。
    fn target_doc() -> String {
        json!({ "root": { "children": [
            { "type": "paragraph", "blockId": TARGET_BLOCK,
              "children": [{ "type": "text", "text": "目标块" }] }
        ]}})
        .to_string()
    }

    /// 源页：**老形态**（`type` 是 `paragraph`/`heading`/…，不是 `shuyo-*`），顶层各带 `blockId`；
    /// 含一条块引用、一条块嵌入、一个嵌套块（带 id 但**不该**被索引）以及表格/列表/代码块。
    fn source_doc() -> String {
        json!({ "root": { "children": [
            { "type": "paragraph", "blockId": SOURCE_BLOCK, "children": [
                { "type": "text", "text": "见 " },
                { "type": "blockref", "targetId": TARGET_BLOCK },
                { "type": "text", "text": " 与下面的嵌入" }
            ]},
            { "type": "blockembed", "blockId": "44444444-4444-4444-8444-444444444444",
              "targetId": TARGET_BLOCK },
            { "type": "heading", "tag": "h2", "blockId": "55555555-5555-4555-8555-555555555555",
              "children": [{ "type": "text", "text": "标题" }] },
            { "type": "list", "listType": "bullet", "blockId": "66666666-6666-4666-8666-666666666666",
              "children": [
                { "type": "listitem", "blockId": NESTED_BLOCK,
                  "children": [{ "type": "text", "text": "项" }] }
              ]},
            { "type": "code", "language": "rust", "blockId": "77777777-7777-4777-8777-777777777777",
              "children": [{ "type": "code-highlight",
                "children": [{ "type": "code-highlight__text", "text": "fn main() {}" }] }] },
            { "type": "table", "blockId": "88888888-8888-4888-8888-888888888888",
              "children": [{ "type": "tablerow", "children": [{ "type": "tablecell", "children": [
                { "type": "paragraph", "children": [{ "type": "text", "text": "单元格" }] }
              ]}]}]}
        ]}})
        .to_string()
    }

    fn space_db() -> Connection {
        let c = Connection::open_in_memory().expect("内存库");
        c.pragma_update(None, "foreign_keys", "ON").expect("开 FK");
        crate::db::migrate(&c, SPACE).expect("建 schema");
        for (id, title) in [("p-source", "源页"), ("p-target", "目标页")] {
            c.execute(
                "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at) \
                 VALUES (?1, ?2, NULL, ?3, '{\"root\":{}}', '', 'page', 0, 1, 1, NULL)",
                rusqlite::params![id, SPACE, title],
            )
            .expect("插页");
        }
        c
    }

    #[test]
    fn legacy_shape_json_is_indexed_by_top_level_ids_only() {
        let c = space_db();
        upsert_blocks(&c, "p-target", &target_doc()).expect("目标页入索引");
        let src = source_doc();

        // `extract_block_ids` 是块表的输入口：**只取顶层**、顺序按文档顺序。
        let ids = extract_block_ids(&src).expect("抽 id");
        assert_eq!(ids.first().map(String::as_str), Some(SOURCE_BLOCK));
        assert_eq!(ids.len(), 6, "顶层 6 个块：{ids:?}");
        assert!(!ids.contains(&NESTED_BLOCK.to_string()), "嵌套块的 id **不该**被索引：{ids:?}");

        upsert_blocks(&c, "p-source", &src).expect("源页入索引");
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM blocks WHERE page_id = 'p-source'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 6, "块表行数应等于顶层块数");
        let nested: i64 = c
            .query_row("SELECT COUNT(*) FROM blocks WHERE block_id = ?1", [NESTED_BLOCK], |r| r.get(0))
            .unwrap();
        assert_eq!(nested, 0, "嵌套块不许进块表");
    }

    #[test]
    fn rebuild_block_graph_records_block_level_backlinks() {
        let c = space_db();
        upsert_blocks(&c, "p-target", &target_doc()).expect("目标页入索引");
        let src = source_doc();
        // `content_text` 用普通正文即可：它服务的是**页级**反链，不在本判据的断言范围里。
        rebuild_block_graph(&c, "p-source", &src, "见 与下面的嵌入 标题").expect("重建块图");

        let rows: Vec<(String, String)> = {
            let mut st = c
                .prepare("SELECT kind, target_block_id FROM backlinks WHERE source_page_id = 'p-source' AND source_block_id != '' ORDER BY kind")
                .unwrap();
            let it = st
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .unwrap();
            it.map(|r| r.unwrap()).collect()
        };
        assert_eq!(
            rows,
            vec![("embed".to_string(), TARGET_BLOCK.to_string()), ("link".to_string(), TARGET_BLOCK.to_string())],
            "块引用与块嵌入各应记一条（按 kind 排序）"
        );
        // 幂等：再跑一次不该翻倍（`DELETE … WHERE source_block_id != ''` 那一步的承重判据）。
        rebuild_block_graph(&c, "p-source", &src, "见 与下面的嵌入 标题").expect("重建块图（第二次）");
        let again: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM backlinks WHERE source_page_id = 'p-source' AND source_block_id != ''",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(again, 2, "重建应当幂等，不许翻倍");
    }

    #[test]
    fn fts_row_is_written_for_the_same_page() {
        let c = space_db();
        sync_fts(&c, "p-source", "源页", "见 与下面的嵌入").expect("写 FTS");
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM page_fts WHERE page_id = 'p-source'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "FTS 应当有且只有一行");
    }
}

/// `get_page_blocks` 的**顶层块提取** —— 2026-10-10 那次用户可见的错 ✗ 的回归判据。
///
/// ⭐ 主判据与**前端** `pageBlocksFromDoc` 那条**同形** ✓：
///   「**顶层块没有 `blockId` ⇒ 块数 > 0 且文本非空**」✓
/// （修前它必红 ✓：旧实现要求顶层块有 `blockId`，而**真实文档里普通页面没有它** ✗
///   ⇒ 返回空 ⇒ 手机档 04 阅读屏显示「这一页还没有内容」✗。）
#[cfg(test)]
mod page_blocks_tests {
    use super::*;
    use serde_json::json;

    /// **实测抓到的真实形状**：顶层 `paragraph` **没有** `blockId` ✗（键与线上一致 ✓）。
    fn real_shape_doc() -> String {
        json!({ "root": {
            "type": "root", "version": 1, "direction": "ltr", "format": "", "indent": 0,
            "children": [
                { "type": "paragraph", "version": 1, "direction": "ltr", "format": "",
                  "indent": 0, "textFormat": 0, "textStyle": "",
                  "children": [{ "type": "text", "text": "The apple is red.", "version": 1 }] }
            ]}})
        .to_string()
    }

    #[test]
    fn real_page_without_block_id_still_yields_blocks() {
        let blocks = page_blocks_from_doc(&real_shape_doc()).expect("应能解析");
        assert!(
            !blocks.is_empty(),
            "有正文的页必须给出块 —— 修前这里是 **0 块** ✗（就是那个用户可见的错）"
        );
        assert_eq!(blocks[0].text, "The apple is red.");
        assert!(!blocks[0].block_id.is_empty(), "回退 id 不许是空串");
    }

    #[test]
    fn block_id_is_kept_when_present() {
        let doc = json!({ "root": { "children": [
            { "type": "paragraph", "blockId": "b-real-1",
              "children": [{ "type": "text", "text": "有 id 的块" }] }
        ]}})
        .to_string();
        let blocks = page_blocks_from_doc(&doc).expect("应能解析");
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].block_id, "b-real-1");
        assert_eq!(blocks[0].text, "有 id 的块");
    }

    #[test]
    fn empty_text_blocks_are_skipped() {
        let doc = json!({ "root": { "children": [
            { "type": "paragraph", "children": [{ "type": "text", "text": "甲" }] },
            { "type": "paragraph", "children": [] },
            { "type": "paragraph", "children": [{ "type": "text", "text": "乙" }] }
        ]}})
        .to_string();
        let texts: Vec<String> = page_blocks_from_doc(&doc)
            .expect("应能解析")
            .into_iter()
            .map(|b| b.text)
            .collect();
        assert_eq!(texts, vec!["甲".to_string(), "乙".to_string()]);
    }

    #[test]
    fn bad_json_is_an_error_not_a_panic() {
        assert!(page_blocks_from_doc("{ not json").is_err());
    }
}
