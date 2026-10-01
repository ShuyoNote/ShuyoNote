//! `activity.rs` —— S3 第三片：**块级活动明细**（**只读** ✓；主体是纯函数 ✓）。
//!
//! 它回答的问题：「这些天**改了哪几段**」✓ —— 数据来源是同步的变更日志 `changes`：
//! 每条 `page/upsert` 的**载荷**就是那一刻的 `PageDetail`（里面那段正文 JSON 就是块树）✓，
//! 把**相邻两条载荷**的块树比一遍 ⇒ 新增／改过／删掉 ✓。
//!
//! ## 三条定死的口径
//! 1. **只读**：本模块只解析**已有**载荷 —— 不写任何表、不碰内容列 ✓（S3 第①条 ✓）。
//! 2. **块的身份与"变没变"复用既有那套** ✓：`doc_content::block_snapshots`（顶层块 ＋ 去掉 `blockRev`
//!    ＋ 键排序）＋ `block_rev::canonical_content` ⇒ 与同步／合并用的是**同一份判定** ✓。
//!    不另造一套"内容变了吗" ✗ —— 否则同一次改动在时间轴与合并提示里会有两种说法 ✓。
//!    ⚠️ 由此得到一条**刻意**的语义：只有 `blockRev` 变了而内容逐字相同的，**不算一次改动** ✓
//!    （rev 是管道值，不是内容 ✓ —— 与合并那边"不提示"同一条理由 ✓）。
//! 3. **判不了就不报** ✓：载荷不是合法 JSON、或某个块没有身份 ⇒ `block_snapshots` 给 `None` ⇒
//!    那一条**不产生**明细（照实留空 ✓），而不是猜一条出来 ✗（宁可少报，不假报 ✓）。
//!
//! ## 本模块不做（照实）
//! · 不做时间分桶 ✓ —— 时间口径**只有一处**（前端 `src/lib/kbTimeline.ts` 的 `TIMELINE_DAY_BUCKET`）；
//!   这里只吐**时间戳**与差异 ✓。
//! · 不做嵌套层的细粒度 ✓ —— 块身份是**顶层块**（与合并／FTS／反链一致 ✓）。

use std::collections::{HashMap, HashSet};

/// 块的三种变化 ✓。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockChangeKind {
    /// 这一版里**新出现**的块 ✓
    Added,
    /// 两版都有，但**规范化内容不同** ✓（`blockRev` 的差别不算 —— 见模块头第 2 条 ✓）
    Edited,
    /// 上一版有、这一版**没有了** ✓
    Removed,
}

/// 一处块级变化 ✓（`block_id` 是顶层块的身份 ✓）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockChange {
    pub block_id: String,
    pub kind: BlockChangeKind,
}

/// 相邻两版页面 JSON ⇒ 块级差异 ✓。
///
/// 顺序是**确定的**：先按**新版**文档顺序给 `Added`/`Edited` ✓，再按**旧版**顺序补 `Removed` ✓
/// （便于断言，也让界面上的顺序与正文一致 ✓）。
///
/// `prev_json` 为 `None` ⇒ 这是这一页的**第一版** ⇒ 所有块都算 `Added` ✓。
pub fn changed_blocks(prev_json: Option<&str>, next_json: &str) -> Vec<BlockChange> {
    // 新版读不出来 ⇒ 判不了 ⇒ 空（不猜 ✓）
    let Some(next) = crate::doc_content::block_snapshots(next_json) else {
        return Vec::new();
    };
    // 旧版读不出来（或本来就没有）⇒ 全算新增 ✓
    let prev = prev_json
        .and_then(crate::doc_content::block_snapshots)
        .unwrap_or_default();
    let prev_by_id: HashMap<&str, &crate::doc_content::BlockSnapshot> =
        prev.iter().map(|b| (b.block_id.as_str(), b)).collect();
    let next_ids: HashSet<&str> = next.iter().map(|b| b.block_id.as_str()).collect();

    let mut out: Vec<BlockChange> = Vec::new();
    for b in &next {
        match prev_by_id.get(b.block_id.as_str()) {
            None => out.push(BlockChange {
                block_id: b.block_id.clone(),
                kind: BlockChangeKind::Added,
            }),
            // `json` 在 `block_snapshots` 里已经是**规范化**的（去 rev ＋ 键排序 ✓）⇒ 直接比 ✓
            Some(old) if old.json != b.json => out.push(BlockChange {
                block_id: b.block_id.clone(),
                kind: BlockChangeKind::Edited,
            }),
            Some(_) => {} // 内容逐字相同（只有 rev 不同也算相同 ✓）⇒ 不算一次改动 ✓
        }
    }
    for b in &prev {
        if !next_ids.contains(b.block_id.as_str()) {
            out.push(BlockChange {
                block_id: b.block_id.clone(),
                kind: BlockChangeKind::Removed,
            });
        }
    }
    out
}

/// 相邻两条**载荷** ⇒ 块级差异 ✓（把"载荷 ⇒ 正文 JSON"这一步也包进来，调用方少一处出错的地方 ✓）。
///
/// ⚠️ 解析载荷那一步走 `doc_content::doc_json_of_payload`（**那一层**的活 ✓）—— 本模块不许自己再拼一遍键名 ✗
/// （判据 `check-doc-content-access.mjs`：直接提那个字段名的地方只许减 ✓）。
pub fn changed_blocks_between_payloads(prev_payload: Option<&str>, next_payload: &str) -> Vec<BlockChange> {
    let next = match crate::doc_content::doc_json_of_payload(next_payload) {
        Some(j) => j,
        None => return Vec::new(),
    };
    let prev = prev_payload.and_then(crate::doc_content::doc_json_of_payload);
    changed_blocks(prev.as_deref(), &next)
}

// ---------------------------------------------------------------------------
// 命令面（**只读** ✓）：`activity_feed`
// ---------------------------------------------------------------------------

/// 一处块级变化（**线上形状** ✓ —— `kind` 是这三个字符串，与 Web 侧逐字相同 ✓）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityBlockChange {
    pub block_id: String,
    /// `"added"` ／ `"edited"` ／ `"removed"` ✓
    pub kind: &'static str,
}

/// 一条活动：同一页**相邻两条载荷**之间发生的事 ✓（页面级一行 ＋ 块级明细 ✓）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub page_id: String,
    /// 载荷里的标题（取不到就是空串 ✓，由界面兜底显示「未命名」✓）
    pub title: String,
    /// **时间戳**（毫秒 ✓）—— ⚠️ 分天**不在这里**做：时间口径只有一处（前端 `TIMELINE_DAY_BUCKET` ✓）
    pub at_ms: i64,
    /// 原样带出 `"upsert"` ／ `"delete"` ✓（不翻译成别的词 ✓）
    pub op: String,
    /// 块级明细 ✓（`delete` 那条为空 ✓）
    pub changes: Vec<ActivityBlockChange>,
}

fn kind_str(k: BlockChangeKind) -> &'static str {
    match k {
        BlockChangeKind::Added => "added",
        BlockChangeKind::Edited => "edited",
        BlockChangeKind::Removed => "removed",
    }
}

/// 载荷里的 `title` ✓（解析不了就给空串 —— 明细照样给，不因为标题读不到就整条丢掉 ✓）。
fn payload_title(payload: &str) -> String {
    serde_json::from_str::<serde_json::Value>(payload)
        .ok()
        .and_then(|v| v.get("title").and_then(|t| t.as_str()).map(str::to_string))
        .unwrap_or_default()
}

/// **只读**命令：读变更日志 `changes` 里最近 `days` 天的**页面活动**，带块级明细 ✓。
///
/// * 只碰 `changes`（SELECT ✓）—— 本命令**不写任何表** ✓（S3 第①条 ✓）。
/// * `days` 默认 30、夹到 `[1, 365]` ✓；`limit` 默认 300、夹到 `[1, 2000]` ✓（夹法照本仓既有的宽容口径 ✓）。
/// * ⚠️ 载荷逐页**按 `seq` 升序**比相邻两条 ✓ —— 这正是"这次改了什么"的意思 ✓；顺序错了就会把
///   老版本当新版比（那会得出**反的**明细：新增与删掉互换 ✗）。
#[tauri::command]
pub fn activity_feed(
    db: tauri::State<'_, crate::db::Db>,
    days: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<ActivityEvent>, String> {
    let days = days.unwrap_or(30).clamp(1, 365);
    let limit = limit.unwrap_or(300).clamp(1, 2000);
    let since = crate::db::now_ms() - days * 24 * 60 * 60 * 1000;
    let c = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = c
        .prepare(
            "SELECT entity_id, op, payload, updated_at FROM changes
             WHERE entity = 'page' AND updated_at >= ?1 ORDER BY seq ASC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![since, limit as i64], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    // 逐页保留**上一条载荷** ⇒ 相邻两条之间才是"这次改了什么" ✓
    let mut prev: HashMap<String, String> = HashMap::new();
    let mut out: Vec<ActivityEvent> = Vec::new();
    for row in rows {
        let (page_id, op, payload, at_ms) = row.map_err(|e| e.to_string())?;
        let payload = payload.unwrap_or_default();
        let is_upsert = op == "upsert" && !payload.is_empty();
        let changes = if is_upsert {
            let before = prev.get(&page_id).map(String::as_str);
            changed_blocks_between_payloads(before, &payload)
        } else {
            Vec::new() // 删除那一条：载荷里没有块树 ⇒ 没有块级明细（页面级那条仍然给 ✓）
        };
        if is_upsert {
            prev.insert(page_id.clone(), payload.clone());
        }
        out.push(ActivityEvent {
            page_id,
            title: payload_title(&payload),
            at_ms,
            op,
            changes: changes
                .into_iter()
                .map(|ch| ActivityBlockChange {
                    block_id: ch.block_id,
                    kind: kind_str(ch.kind),
                })
                .collect(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个顶层块（`rev` 可缺 ⇒ 老客户端产物 ✓）。
    fn para(block_id: Option<&str>, rev: Option<i64>, text: &str) -> String {
        let id = block_id.map(|b| format!("\"blockId\":\"{b}\",")).unwrap_or_default();
        let rv = rev.map(|r| format!("\"blockRev\":{r},")).unwrap_or_default();
        format!("{{ \"type\":\"paragraph\",{id}{rv} \"children\":[{{\"type\":\"text\",\"text\":\"{text}\"}}] }}")
    }

    fn doc(blocks: &[String]) -> String {
        format!("{{ \"root\": {{ \"children\": [{}] }} }}", blocks.join(","))
    }

    fn ids_of(changes: &[BlockChange]) -> Vec<(String, BlockChangeKind)> {
        changes.iter().map(|c| (c.block_id.clone(), c.kind)).collect()
    }

    #[test]
    fn first_version_marks_every_block_added() {
        let next = doc(&[para(Some("b1"), Some(1), "甲"), para(Some("b2"), Some(1), "乙")]);
        assert_eq!(
            ids_of(&changed_blocks(None, &next)),
            vec![
                ("b1".to_string(), BlockChangeKind::Added),
                ("b2".to_string(), BlockChangeKind::Added)
            ]
        );
    }

    #[test]
    fn text_edit_is_reported_as_edited() {
        let prev = doc(&[para(Some("b1"), Some(1), "甲"), para(Some("b2"), Some(1), "乙")]);
        let next = doc(&[para(Some("b1"), Some(2), "甲改了"), para(Some("b2"), Some(1), "乙")]);
        assert_eq!(
            ids_of(&changed_blocks(Some(&prev), &next)),
            vec![("b1".to_string(), BlockChangeKind::Edited)]
        );
    }

    /// ⚠️ 刻意语义（模块头第 2 条）：只有 `blockRev` 变了、内容逐字相同 ⇒ **不算**一次改动 ✓。
    #[test]
    fn rev_only_bump_with_identical_content_is_not_a_change() {
        let prev = doc(&[para(Some("b1"), Some(1), "甲")]);
        let next = doc(&[para(Some("b1"), Some(7), "甲")]);
        assert!(changed_blocks(Some(&prev), &next).is_empty());
    }

    #[test]
    fn added_and_removed_blocks_are_reported() {
        let prev = doc(&[para(Some("b1"), Some(1), "甲"), para(Some("b2"), Some(1), "乙")]);
        let next = doc(&[para(Some("b1"), Some(1), "甲"), para(Some("b3"), Some(1), "丙")]);
        assert_eq!(
            ids_of(&changed_blocks(Some(&prev), &next)),
            vec![
                ("b3".to_string(), BlockChangeKind::Added),   // 新版顺序在前 ✓
                ("b2".to_string(), BlockChangeKind::Removed)  // 再补旧版里没了的 ✓
            ]
        );
    }

    #[test]
    fn unparsable_or_identity_less_documents_report_nothing() {
        assert!(changed_blocks(Some("{}"), "不是 JSON").is_empty(), "坏 JSON ⇒ 判不了 ⇒ 不报 ✓");
        // 块没有身份 ⇒ `block_snapshots` 给 None ⇒ 不报 ✓（照实留空，不猜 ✓）
        let no_id = doc(&[para(None, Some(1), "甲")]);
        assert!(changed_blocks(None, &no_id).is_empty());
    }

    #[test]
    fn payload_extraction_reads_content_json_and_tolerates_extras() {
        let payload = r#"{"id":"p1","title":"页","content_json":"{\"root\":{\"children\":[]}}","crdt_wire":"xxx","stamp":7}"#;
        assert_eq!(
            crate::doc_content::doc_json_of_payload(payload).as_deref(),
            Some(r#"{"root":{"children":[]}}"#)
        );
        // 对象形态也收 ✓；没有这一项 ⇒ None ✓
        assert!(crate::doc_content::doc_json_of_payload(r#"{"content_json":{"root":{}}}"#).is_some());
        assert_eq!(crate::doc_content::doc_json_of_payload(r#"{"id":"p1"}"#), None);
        assert_eq!(crate::doc_content::doc_json_of_payload("不是 JSON"), None);
    }

    #[test]
    fn payload_level_diff_walks_from_payload_to_blocks() {
        let prev = format!(r#"{{"id":"p1","content_json":{}}}"#, serde_json::to_string(&doc(&[para(Some("b1"), Some(1), "甲")])).unwrap());
        let next = format!(r#"{{"id":"p1","content_json":{}}}"#, serde_json::to_string(&doc(&[para(Some("b1"), Some(2), "甲改了")])).unwrap());
        assert_eq!(
            ids_of(&changed_blocks_between_payloads(Some(&prev), &next)),
            vec![("b1".to_string(), BlockChangeKind::Edited)]
        );
        assert!(changed_blocks_between_payloads(Some(&prev), r#"{"id":"p1"}"#).is_empty());
    }

    // ---- 跨语言夹具（S3 第三片）----
    //
    // 与 Web 侧 `src/lib/activityBlocks.test.ts` 读**同一份** `tests/activity-parity.json`、
    // 断**同一组**期望值 ✓ ⇒ 两侧语义相等是**传递**出来的 ✓（不是两边各记一份现状 ✗）。
    const ACTIVITY_PARITY_JSON: &str = include_str!("../../tests/activity-parity.json");

    fn wire(changes: &[BlockChange]) -> Vec<(String, String)> {
        changes
            .iter()
            .map(|c| (c.block_id.clone(), kind_str(c.kind).to_string()))
            .collect()
    }

    #[test]
    fn differences_match_the_shared_cross_language_fixture() {
        let fx: serde_json::Value =
            serde_json::from_str(ACTIVITY_PARITY_JSON).expect("夹具必须是合法 JSON");
        let cases = fx["cases"].as_array().expect("cases 数组");
        assert!(cases.len() >= 2, "夹具至少要两条用例（一条证明不了两侧一致 ✓）");
        let mut bad = Vec::new();
        for c in cases {
            let next = serde_json::to_string(&c["next"]).expect("next 可序列化");
            let prev = if c["prev"].is_null() {
                None
            } else {
                Some(serde_json::to_string(&c["prev"]).expect("prev 可序列化"))
            };
            let got = wire(&changed_blocks(prev.as_deref(), &next));
            let want: Vec<(String, String)> = c["expect"]
                .as_array()
                .expect("expect 数组")
                .iter()
                .map(|e| {
                    (
                        e["blockId"].as_str().expect("blockId").to_string(),
                        e["kind"].as_str().expect("kind").to_string(),
                    )
                })
                .collect();
            if got != want {
                bad.push(format!(
                    "「{}」：桌面={:?} 期望={:?}",
                    c["name"].as_str().unwrap_or(""),
                    got,
                    want
                ));
            }
        }
        assert!(
            bad.is_empty(),
            "块级明细与共享夹具（tests/activity-parity.json）不一致：\n{}",
            bad.join("\n")
        );
    }
}
