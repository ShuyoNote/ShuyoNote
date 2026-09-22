//! 「块版本」这一层（Rust 侧）：`blockRev`（每块的 **Lamport 计数器**）的**读 / 定 / 写** —— 纯函数，JSON → JSON。
//!
//! 与前端 `src/lib/blockRev.ts` **逐条对应**（改一边必须同时看另一边，用例也一样）。
//! 裁定与判定表：`docs/plans/2026-09-19-stage1-block-lww-readiness.md` §6/§7；
//! 本层的口径与"未改的块也要有 rev"那条见 §9。
//!
//! ## 这一层在整条链上的位置
//!
//! 编辑器（内存模型）──序列化──▶ 这一版 JSON ──`assign_block_revs(上一版, 这一版)`──▶ 带 rev 的落盘 JSON。
//! 判定（块级合并那一层）只读**落盘/远端**的 JSON ⇒ 本层是"rev 从哪来"的唯一出处。
//!
//! ## ★ 三条口径（与前端那份同一份清单）
//!
//! 1. **只认顶层块**（与今天的落盘形态、`extract_block_ids` 一致：只有顶层块有身份）；
//! 2. **没有 `blockId` 的块不写 `rev`** —— 身份还没补种 ⇒ 不猜、不造；
//! 3. **比较"内容变没变"时，`blockRev` 字段本身要排除、且**键序无关**（见 `canonical_content`）：
//!    不排除 ⇒ 还没带声明字段的节点类每次保存都被判成"改过了"；不管键序 ⇒ 编辑器重排一次键序就被
//!    判成"改过" ⇒ **本地那份旧内容会被当成"更新的"赢过远端真实的新编辑**（静默丢更新）。
//!
//! ## ★ 一条裁定没写、但阶段 1 的承诺要求它成立的口径：未改的块也要有 rev
//!
//! 裁定只说了"编辑一块 ⇒ `rev = max(整页见过的 rev) + 1`"，没说**没改过**的块怎么办。
//! 若"未改的块不写 rev"：两台设备各改**不同块**后（A 的 X=1、B 的 X 没有 rev），合并时 X 落进
//! "缺 rev ⇒ 冲突" ⇒ **每一页都弹提示**（正是阶段 1 要消灭的场景）。
//! ⇒ 采用：**有身份 ⇒ 一定有 rev** —— 未改的块写回它已知的 rev；**从没见过 rev 的老块写 `0`**。
//! 于是"缺 `rev`"在合并表里只剩"老客户端产物"这一种真实含义（与裁定 (iii) 的本意一致）。
//! 代价（如实写）：老块被盖上 `0` = 声明"它老到不能再老" ⇒ 对方只要**真的**改过那一块，就取对方那一版。
//! 那不是"静默丢更新"（对方确实改过、本地确实没改），但**这条要 owner/两边点头**（已写进协同信）。
//!
//! ## 本层今天**没有调用方**（接线清单见 §9）
//!
//! 接线要动保存路径（桌面 `commands::save_page`、Web `platform/web.ts::save_page`）与分栏子编辑器，
//! 且应**与块级判定同时上线**（否则只是往 JSON 里加一个没人读的字段）。属单独一片。

use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// 一个顶层块的 `(blockId, rev)`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopLevelBlockRev {
    pub block_id: String,
    /// 落盘 JSON 里那个 `blockRev`；缺失/不是非负整数 ⇒ `None`（= **老客户端产物**）。
    pub rev: Option<i64>,
}

/// 解析成文档对象（要有 `root` 且是对象）；否则 `None`（调用方原样返回输入，绝不抛）。
fn parse_doc(doc_json: &str) -> Option<Value> {
    let parsed: Value = serde_json::from_str(doc_json).ok()?;
    if !parsed.is_object() {
        return None;
    }
    match parsed.get("root") {
        Some(root) if root.is_object() => Some(parsed),
        _ => None,
    }
}

/// 顶层块（`root.children` 里的对象项）。
fn top_children(doc: &Value) -> Vec<Value> {
    doc.pointer("/root/children")
        .and_then(|children| children.as_array())
        .map(|items| items.iter().filter(|item| item.is_object()).cloned().collect())
        .unwrap_or_default()
}

fn block_id_of(node: &Value) -> String {
    node.get("blockId").and_then(|v| v.as_str()).unwrap_or_default().to_string()
}

/// 读一个块对象的 `blockRev`（只认**非负整数**；其余一律 `None` —— 与前端那份同一口径）。
pub fn block_rev_of(node: &Value) -> Option<i64> {
    node.get("blockRev").and_then(|v| v.as_i64()).filter(|rev| *rev >= 0)
}

/// **规范化内容**：把 `blockRev` 字段（任意层级）去掉，并把对象的键**排序**后序列化。
///
/// 只给"这一块变没变"的比较用，**不是**落盘形态。理由见文件头口径 3。
pub fn canonical_content(value: &Value) -> String {
    fn strip(value: &Value) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(strip).collect()),
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().filter(|key| key.as_str() != "blockRev").collect();
                keys.sort();
                let mut out = Map::new();
                for key in keys {
                    out.insert(key.clone(), strip(&map[key]));
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }
    strip(value).to_string()
}

/// 顶层块的 `(blockId, rev)`（按顺序；**没有身份的块也在里面**，`block_id` 为空串）。
pub fn read_top_level_block_revs(doc_json: &str) -> Vec<TopLevelBlockRev> {
    match parse_doc(doc_json) {
        Some(doc) => top_children(&doc)
            .iter()
            .map(|child| TopLevelBlockRev { block_id: block_id_of(child), rev: block_rev_of(child) })
            .collect(),
        None => Vec::new(),
    }
}

/// 这一页**见过的**最大 `rev`（读不出来 ⇒ `0`）。
///
/// ⚠️ 它是"整页"的量，不是"这一块"的量 —— 与裁定 §7 的 `max(整页见过的 rev) + 1` 同一口径。
pub fn max_block_rev(doc_json: &str) -> i64 {
    read_top_level_block_revs(doc_json).iter().filter_map(|b| b.rev).max().unwrap_or(0)
}

/// ★ **rev 的写入口**：拿"上一版"（baseline）与"这一版"比一遍，给每个**有身份的顶层块**写 `blockRev`。
///
/// | 情形 | 写什么 |
/// |---|---|
/// | 有身份、且与 baseline 里同 id 的块**内容相同** | baseline 已有的 rev；baseline 里**没见过** rev（老块）⇒ `0` |
/// | 有身份、但内容变了 / baseline 里没有这个 id（新块） | `maxSeen + 1`（`maxSeen` = 两侧见过的最大 rev，至少 0） |
/// | **没有身份**（`blockId` 空/缺失） | **不写**（不猜身份） |
///
/// ⚠️ **删除不在这里**：baseline 有、这一版没有的块 ⇒ 它就不在产物里了（本层不写墓碑）。
/// ⚠️ 解析不出来 ⇒ **原样返回 `next_json`**：本层在保存路径上，不能因为一条脏数据把保存变成写空文档。
pub fn assign_block_revs(prev_json: &str, next_json: &str) -> String {
    let Some(mut doc) = parse_doc(next_json) else {
        return next_json.to_string();
    };

    let mut prev_by_id: HashMap<String, Value> = HashMap::new();
    if let Some(prev) = parse_doc(prev_json) {
        for child in top_children(&prev) {
            let id = block_id_of(&child);
            if !id.is_empty() {
                prev_by_id.insert(id, child);
            }
        }
    }

    let max_seen = max_block_rev(prev_json).max(max_block_rev(next_json));

    if let Some(children) = doc.pointer_mut("/root/children").and_then(|c| c.as_array_mut()) {
        for node in children.iter_mut() {
            if !node.is_object() {
                continue;
            }
            let id = block_id_of(node);
            if id.is_empty() {
                continue; // 口径 2：没身份就不写
            }
            let prev = prev_by_id.get(&id);
            let unchanged =
                prev.map(|p| canonical_content(p) == canonical_content(node)).unwrap_or(false);
            let rev = if unchanged {
                prev.and_then(block_rev_of).or_else(|| block_rev_of(node)).unwrap_or(0)
            } else {
                max_seen + 1 // 改了 / 新块
            };
            if let Some(obj) = node.as_object_mut() {
                obj.insert("blockRev".to_string(), json!(rev));
            }
        }
    }

    doc.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一份文档（顶层就是这几个块）。
    fn doc(blocks: Vec<Value>) -> String {
        json!({ "root": { "children": blocks } }).to_string()
    }

    /// 一个段落块（`rev` 用 `Option`：`None` = **字段不存在**）。
    fn para(block_id: &str, text: &str, rev: Option<i64>) -> Value {
        let mut node = json!({
            "type": "paragraph",
            "blockId": block_id,
            "children": [{ "type": "text", "text": text }],
        });
        if let Some(rev) = rev {
            node["blockRev"] = json!(rev);
        }
        node
    }

    /// 读成 `block_id -> rev`（好断言）。
    fn revs_of(json_str: &str) -> Vec<(String, Option<i64>)> {
        read_top_level_block_revs(json_str)
            .into_iter()
            .map(|b| (b.block_id, b.rev))
            .collect()
    }

    fn rev_of(json_str: &str, block_id: &str) -> Option<i64> {
        revs_of(json_str).into_iter().find(|(id, _)| id == block_id).and_then(|(_, rev)| rev)
    }

    #[test]
    fn unchanged_block_keeps_the_baseline_rev() {
        let prev = doc(vec![para("b1", "没动", Some(5))]);
        let next = doc(vec![para("b1", "没动", None)]);
        assert_eq!(revs_of(&assign_block_revs(&prev, &next)), vec![("b1".to_string(), Some(5))]);
    }

    #[test]
    fn legacy_block_never_seen_with_rev_gets_zero() {
        // 老客户端产物：没有 blockRev 字段。有身份 ⇒ 一定有 rev ⇒ 盖 0。
        let prev = doc(vec![para("b1", "老内容", None)]);
        let next = doc(vec![para("b1", "老内容", None)]);
        assert_eq!(rev_of(&assign_block_revs(&prev, &next), "b1"), Some(0));
    }

    #[test]
    fn changed_block_gets_max_seen_plus_one_and_others_stay() {
        let prev = doc(vec![para("b1", "旧", Some(7)), para("b2", "没动", Some(3))]);
        let next = doc(vec![para("b1", "新", None), para("b2", "没动", None)]);
        let out = assign_block_revs(&prev, &next);
        assert_eq!(rev_of(&out, "b1"), Some(8));
        assert_eq!(rev_of(&out, "b2"), Some(3));
    }

    #[test]
    fn new_block_gets_max_seen_plus_one_and_deleted_block_disappears() {
        let prev = doc(vec![para("b1", "留着", Some(2)), para("b-gone", "被删了", Some(2))]);
        let next = doc(vec![para("b1", "留着", None), para("b-new", "新来的", None)]);
        let out = assign_block_revs(&prev, &next);
        assert_eq!(rev_of(&out, "b1"), Some(2));
        assert_eq!(rev_of(&out, "b-new"), Some(3));
        assert!(rev_of(&out, "b-gone").is_none());
    }

    #[test]
    fn block_without_identity_gets_no_rev() {
        let prev = doc(vec![para("b1", "有身份", Some(1))]);
        let next = doc(vec![para("b1", "有身份", None), json!({ "type": "paragraph", "children": [] })]);
        let out: Value = serde_json::from_str(&assign_block_revs(&prev, &next)).unwrap();
        assert!(out.pointer("/root/children/1/blockRev").is_none());
    }

    #[test]
    fn rev_field_is_not_content() {
        // 还没带声明字段的节点类序列化时会把这个字段丢掉 —— 不许因此判成"改过了"。
        let prev = doc(vec![para("b1", "一样", Some(4))]);
        let next = doc(vec![para("b1", "一样", None)]);
        assert_eq!(rev_of(&assign_block_revs(&prev, &next), "b1"), Some(4));
    }

    #[test]
    fn key_order_is_not_content() {
        let prev = doc(vec![para("b1", "一样", Some(4))]);
        let next = json!({
            "root": { "children": [{
                "children": [{ "text": "一样", "type": "text" }],
                "blockId": "b1",
                "type": "paragraph",
            }] }
        })
        .to_string();
        assert_eq!(rev_of(&assign_block_revs(&prev, &next), "b1"), Some(4));
        // 规范化只给比较用：产物仍是原始形态（能直接读回 blockId）
        assert!(assign_block_revs(&prev, &next).contains("\"blockId\":\"b1\""));
    }

    #[test]
    fn max_seen_comes_from_both_sides() {
        let prev = doc(vec![para("b1", "旧", Some(9))]);
        let next = doc(vec![para("b2", "全新的", None)]);
        assert_eq!(rev_of(&assign_block_revs(&prev, &next), "b2"), Some(10));
    }

    #[test]
    fn assignment_is_idempotent() {
        let prev = doc(vec![para("b1", "旧", Some(2)), para("b2", "没动", Some(2))]);
        let next = doc(vec![para("b1", "新", None), para("b2", "没动", None)]);
        let once = assign_block_revs(&prev, &next);
        assert_eq!(assign_block_revs(&once, &once), once);
    }

    #[test]
    fn dirty_input_is_returned_unchanged() {
        let prev = doc(vec![para("b1", "x", Some(1))]);
        for bad in ["not json", "{}", "{\"root\":null}", "{\"root\":{\"children\":\"nope\"}}"] {
            assert_eq!(assign_block_revs(&prev, bad), bad);
        }
        assert!(assign_block_revs("not json", &doc(vec![para("b1", "x", None)])).contains("blockRev"));
    }

    #[test]
    fn stage1_promise_holds_at_this_layer() {
        // 两台设备各改**不同块** ⇒ 两边每个块都有 rev，且各改的那块更大（⇒ 判定层不会落进"缺 rev ⇒ 冲突"）。
        let base = doc(vec![para("b1", "原始一", None), para("b2", "原始二", None)]);
        let a = assign_block_revs(&base, &doc(vec![para("b1", "A 改的", None), para("b2", "原始二", None)]));
        let b = assign_block_revs(&base, &doc(vec![para("b1", "原始一", None), para("b2", "B 改的", None)]));

        assert_eq!(rev_of(&a, "b1"), Some(1));
        assert_eq!(rev_of(&a, "b2"), Some(0));
        assert_eq!(rev_of(&b, "b1"), Some(0));
        assert_eq!(rev_of(&b, "b2"), Some(1));

        for id in ["b1", "b2"] {
            assert!(rev_of(&a, id).is_some(), "{id} 在 A 侧必须有 rev");
            assert!(rev_of(&b, id).is_some(), "{id} 在 B 侧必须有 rev");
        }
        assert!(rev_of(&a, "b1").unwrap() > rev_of(&b, "b1").unwrap());
        assert!(rev_of(&b, "b2").unwrap() > rev_of(&a, "b2").unwrap());
    }

    #[test]
    fn rev_reading_only_accepts_non_negative_integers() {
        assert_eq!(block_rev_of(&json!({ "blockRev": "3" })), None);
        assert_eq!(block_rev_of(&json!({ "blockRev": null })), None);
        assert_eq!(block_rev_of(&json!({ "blockRev": 3.5 })), None);
        assert_eq!(block_rev_of(&json!({ "blockRev": -1 })), None);
        assert_eq!(block_rev_of(&json!({ "blockRev": 0 })), Some(0));
    }

    #[test]
    fn max_block_rev_reads_zero_when_unreadable() {
        assert_eq!(max_block_rev("not json"), 0);
        assert_eq!(max_block_rev(&doc(vec![para("b1", "x", None)])), 0);
        assert_eq!(max_block_rev(&doc(vec![para("b1", "x", Some(3)), para("b2", "y", Some(9))])), 9);
    }

    #[test]
    fn canonical_content_drops_rev_at_any_depth_and_sorts_keys() {
        assert_eq!(
            canonical_content(&json!({ "b": 1, "a": { "blockRev": 9, "x": 1 } })),
            canonical_content(&json!({ "a": { "x": 1 }, "b": 1 }))
        );
    }
}
