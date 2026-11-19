//! 页级**血统冲突**：两条独立编辑历史撞在一起时的**留痕 ＋ 裁决**（冲刺 §13.3 第 2 条）。
//!
//! ## 为什么它不能复用块级那张表
//!
//! 块级 `page_conflicts` 记的是"**同一块**被判成两版" —— 可以逐块选一侧，另一侧仍在版本历史里；
//! 而这里撞上的是**两条独立创建的血统**：Yjs 结构上就不是同一棵树，**合并在数学上做不到**
//! （S1 红线：硬合 ⇒ 顶层块变成两份、`blockId` 重复）。所以真实选项只有三条：
//! **① 留本机 ② 用对端 ③ 两个都要（一页变两页）**，其中只有 ③ 不丢数据。
//!
//! ## 为什么必须有 `remote_doc` 这一列
//!
//! "拒绝合并"发生在**打开页面**那一刻，而待并状态在这一步之后会被 `clearPending` **清掉** ⇒
//! 不在这里留一份**对端那一版的投影**，用户事后点"另存为新页"时**已经无米下锅**。
//!
//! ## 三条纪律（与 `page_conflicts` 同族）
//!
//! 1. **本地证据**：别的设备没有这行、服务端也没有这张表 —— 别拿它解释跨机器的差异；
//! 2. `resolved_at` 为空 ＝ **未决**；界面不许读成"已处理"（判据守着这一条）；
//! 3. **不默认选边**：`choice` 只认两个字面量，其余**报错**（与 `resolve_page_conflict` 同一纪律）。

use rusqlite::{params, Connection, OptionalExtension};

/// 一条页级血统冲突（`page_lineage_conflicts` 的一行）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PageLineageConflict {
    pub id: String,
    pub page_id: String,
    /// 本机这条血统的指纹（`lineageClientIds` 的 client id，逗号分隔、已排序）。
    pub mine_fp: String,
    /// 对端那条血统的指纹。
    pub remote_fp: String,
    /// 对端那一版的**整页投影 JSON**（"另存为新页"靠它 —— 待并状态会被清掉）。
    pub remote_doc: String,
    pub detected_at: i64,
    pub resolved_at: Option<i64>,
    pub resolved_choice: Option<String>,
}

/// 裁决选"留本机"（＝我知道了，别管它）。
pub const CHOICE_LOCAL: &str = "local";
/// 裁决选"把对端那一版另存为新页"（★ 唯一**不丢数据**的那条路）。
pub const CHOICE_SAVED_AS_NEW: &str = "saved-as-new";

/// ★ 2026-09-29（owner 裁定 R77）：**采用对端那一版**（本机这版让位）。
/// 加它的理由写在 `src/components/LineageConflictBanner.tsx` 文件头：页级冲突的真实选项有**三条**
/// （留本机／用对端／两个都要），而"用对端"此前**没做** ✗ ⇒ 用户只能被告知、不能选 ✓
pub const CHOICE_REMOTE: &str = "remote";

/// 记一次页级血统冲突。返回**是否真的新建了一行**（`false` ＝ 这一对指纹已经记过/已裁决过）。
///
/// 去重口径（**同一对指纹只提一次**，这是"不许每开一次页面就打扰一次"的落脚点）：
/// · 同一 `(page_id, mine_fp, remote_fp)` **已有未决** ⇒ 只把快照刷新成最新那一版（对端可能又推了新的）；
/// · 同一对**已裁决过** ⇒ **不再提**（用户已经处理过这件事了）；
/// · 否则：先把这一页**别的**未决行删掉（旧指纹对已被新事实取代，避免堆积），再插一条。
pub fn record_lineage_conflict(
    c: &Connection,
    page_id: &str,
    mine_fp: &str,
    remote_fp: &str,
    remote_doc: &str,
    now: i64,
) -> Result<bool, String> {
    let existing: Option<(String, Option<i64>)> = c
        .query_row(
            "SELECT id, resolved_at FROM page_lineage_conflicts
             WHERE page_id = ?1 AND mine_fp = ?2 AND remote_fp = ?3
             ORDER BY detected_at DESC LIMIT 1",
            params![page_id, mine_fp, remote_fp],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match existing {
        Some((id, None)) => {
            // 未决：刷新快照与时间（同一件事又发生了一次，不是新的一件）
            c.execute(
                "UPDATE page_lineage_conflicts SET remote_doc = ?1, detected_at = ?2 WHERE id = ?3",
                params![remote_doc, now, id],
            )
            .map_err(|e| e.to_string())?;
            Ok(false)
        }
        Some((_, Some(_))) => Ok(false), // 已裁决过这一对 ⇒ 不再提
        None => {
            c.execute(
                "DELETE FROM page_lineage_conflicts WHERE page_id = ?1 AND resolved_at IS NULL",
                params![page_id],
            )
            .map_err(|e| e.to_string())?;
            c.execute(
                "INSERT INTO page_lineage_conflicts
                   (id, page_id, mine_fp, remote_fp, remote_doc, detected_at, resolved_at, resolved_choice)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    page_id,
                    mine_fp,
                    remote_fp,
                    remote_doc,
                    now,
                ],
            )
            .map_err(|e| e.to_string())?;
            Ok(true)
        }
    }
}

fn row_of(r: &rusqlite::Row<'_>) -> rusqlite::Result<PageLineageConflict> {
    Ok(PageLineageConflict {
        id: r.get(0)?,
        page_id: r.get(1)?,
        mine_fp: r.get(2)?,
        remote_fp: r.get(3)?,
        remote_doc: r.get(4)?,
        detected_at: r.get(5)?,
        resolved_at: r.get(6)?,
        resolved_choice: r.get(7)?,
    })
}

const COLS: &str =
    "id, page_id, mine_fp, remote_fp, remote_doc, detected_at, resolved_at, resolved_choice";

/// 这一页**未决**的页级冲突（**至多一条** —— 记的时候就把旧的未决删了）。
pub fn unresolved_lineage_conflict(
    c: &Connection,
    page_id: &str,
) -> Result<Option<PageLineageConflict>, String> {
    c.query_row(
        &format!(
            "SELECT {COLS} FROM page_lineage_conflicts
             WHERE page_id = ?1 AND resolved_at IS NULL ORDER BY detected_at DESC LIMIT 1"
        ),
        params![page_id],
        row_of,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// 这一页**全部**页级冲突（含已裁决；给判据与排错用 —— 界面只读未决那条，所以这里是 `cfg(test)`）。
#[cfg(test)]
pub fn lineage_conflicts_of(
    c: &Connection,
    page_id: &str,
) -> Result<Vec<PageLineageConflict>, String> {
    let mut stmt = c
        .prepare(&format!(
            "SELECT {COLS} FROM page_lineage_conflicts WHERE page_id = ?1 ORDER BY detected_at, id"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![page_id], row_of)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// ⭐ **2026-11-19（owner 拍 A）**：**对端那版与本页正文是否已经一样** —— 一样就"没什么可裁决的"。
///
/// 来由（真机 2026-11-19）：冲突**还没裁决**，页面正文却已经被对端版本覆盖了（合并那一侧先写了），
/// 于是 `remote_doc` 与当前页**逐字相同**，而冲突行一直挂着 ⇒ 横幅**永不消失**、同一页被反复检出。
///
/// 口径（⛔ 三条都不许猜）：
/// ① 两边都按 JSON **解析**后逐值比较（对象键序无关、空白无关）；
/// ② **任一侧解析不了 ⇒ `false`**（解析不了就不敢说"一样"，宁可继续问用户）；
/// ③ 页面不存在/读不到 ⇒ `false`（同上）。
pub fn projection_equals_page(
    c: &Connection,
    page_id: &str,
    remote_doc: &str,
) -> Result<bool, String> {
    // ⚠️ 走「文档内容层」读（`doc_content::read`）—— ⛔ 不许在这里自己拼 SQL 读落盘正文列
    //   （`check-doc-content-access` 判的是**文件级**直接访问，只减不增）。
    let Some(local) = crate::doc_content::read(c, page_id)? else {
        return Ok(false);
    };
    let (Ok(a), Ok(b)) = (
        serde_json::from_str::<serde_json::Value>(&local.json),
        serde_json::from_str::<serde_json::Value>(remote_doc),
    ) else {
        return Ok(false);
    };
    Ok(a == b)
}

/// ★ **裁决一条**：`choice` 只认 `local` / `saved-as-new`，其余**报错**（**不默认选边** ——
/// 与 `resolve_page_conflict` 同一纪律）；已裁决的再裁决也**报错**（不静默成功）。
pub fn resolve_lineage_conflict(
    c: &Connection,
    id: &str,
    choice: &str,
    now: i64,
) -> Result<(), String> {
    if choice != CHOICE_LOCAL && choice != CHOICE_SAVED_AS_NEW && choice != CHOICE_REMOTE {
        return Err(format!(
            "choice 只能是 {CHOICE_LOCAL}／{CHOICE_SAVED_AS_NEW}／{CHOICE_REMOTE}，收到 {choice}"
        ));
    }
    let n = c
        .execute(
            "UPDATE page_lineage_conflicts SET resolved_at = ?1, resolved_choice = ?2
             WHERE id = ?3 AND resolved_at IS NULL",
            params![now, choice, id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("冲突不存在或已裁决".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真 schema 的临时库（照 `doc_content::tests::conflict_conn` 同一手法：
    /// **别手抄最小表** —— 这里虽然只用这一张，但手工 schema 会掩盖迁移问题）。
    fn conn(tag: &str) -> (Connection, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("shuyonote-lineage-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        let c = crate::db::open_space_conn_at("s1", &dir).unwrap();
        (c, dir)
    }

    fn page(c: &Connection, id: &str) {
        c.execute(
            "INSERT INTO pages (id, workspace_id, title, content_json, content_text, kind, created_at, updated_at, deleted_at, dirty) \
             VALUES (?1, 's1', '页', '{}', '', 'page', 0, 0, NULL, 0)",
            params![id],
        )
        .unwrap();
    }

    /// ⭐ **2026-11-19（owner 拍 A）**：`projection_equals_page` 的三条口径 ——
    /// 逐值相等（键序/空白无关）⇒ `true`；不同/解析不了/页不存在 ⇒ `false`（⛔ 不猜）。
    #[test]
    fn projection_equals_page_only_says_true_on_real_equality() {
        let (c, dir) = conn("eq");
        page(&c, "p1");
        // ⚠️ 正文也走「文档内容层」写（`doc_content::write`）—— 判据文件同样受
        //   `check-doc-content-access` 管（直接拼 SQL 写落盘列会被判红）。
        crate::doc_content::write(
            &c,
            "p1",
            &crate::doc_content::DocContent {
                title: "页".to_string(),
                json: r#"{"root":{"children":[{"text":"来自mac的冲突测试"}]}}"#.to_string(),
                text: String::new(),
            },
            1,
        )
        .unwrap();
        // ① 键序/空白不同但内容相同 ⇒ 一样（这是真机那种"已经被对端覆盖过"的形态）
        assert!(projection_equals_page(
            &c,
            "p1",
            "{ \"root\" : { \"children\" : [ { \"text\" : \"来自mac的冲突测试\" } ] } }"
        )
        .unwrap());
        // ② 内容不同 ⇒ 不一样（继续问用户）
        assert!(
            !projection_equals_page(&c, "p1", r#"{"root":{"children":[{"text":"别的"}]}}"#)
                .unwrap()
        );
        // ③ 对端那份不是合法 JSON / 页不存在 ⇒ 一律 false（⛔ 不许当成"一样"而替用户结案）
        assert!(!projection_equals_page(&c, "p1", "not json").unwrap());
        assert!(!projection_equals_page(&c, "missing", r#"{"root":{}}"#).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn records_once_per_fingerprint_pair_and_refreshes_the_snapshot() {
        let (c, dir) = conn("record");
        page(&c, "p1");
        assert!(
            record_lineage_conflict(&c, "p1", "7", "42", "{\"v\":1}", 10).unwrap(),
            "第一次要落一行"
        );
        // 同一对再来 ⇒ **不新建**，但快照刷新（对端可能又推了新的一版）
        assert!(!record_lineage_conflict(&c, "p1", "7", "42", "{\"v\":2}", 11).unwrap());
        let row = unresolved_lineage_conflict(&c, "p1")
            .unwrap()
            .expect("应当有未决");
        assert_eq!(row.remote_doc, "{\"v\":2}", "快照要刷新成最新那一版");
        assert_eq!(row.mine_fp, "7");
        assert_eq!(row.remote_fp, "42");
        assert_eq!(row.resolved_at, None);
        // 换了指纹对（对端另起了一条新血统）⇒ 旧的未决被取代，只剩一条
        assert!(record_lineage_conflict(&c, "p1", "7", "99", "{\"v\":3}", 12).unwrap());
        assert_eq!(
            lineage_conflicts_of(&c, "p1").unwrap().len(),
            1,
            "同一页只留一条未决"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_already_resolved_pair_is_not_raised_again() {
        // ★ 这条就是"同一对指纹只提一次"：不然用户每开一次页面就被打扰一次
        let (c, dir) = conn("resolved");
        page(&c, "p1");
        record_lineage_conflict(&c, "p1", "7", "42", "{}", 10).unwrap();
        let id = unresolved_lineage_conflict(&c, "p1").unwrap().unwrap().id;
        resolve_lineage_conflict(&c, &id, CHOICE_SAVED_AS_NEW, 11).unwrap();

        assert!(
            !record_lineage_conflict(&c, "p1", "7", "42", "{}", 12).unwrap(),
            "已裁决过 ⇒ 不再提"
        );
        assert!(
            unresolved_lineage_conflict(&c, "p1").unwrap().is_none(),
            "未决列表必须干净"
        );
        // 但**换一条新血统**（新的指纹对）⇒ 那是一件新事，要提
        assert!(record_lineage_conflict(&c, "p1", "7", "100", "{}", 13).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_accepts_the_three_literals_refuses_a_fourth_and_refuses_a_second_time() {
        let (c, dir) = conn("resolve");

        // ★ 三个字面量**各建一行、各裁一次、各验一次**（2026-09-29：`remote` 从"拒"改成"收" ✓
        //   —— 它对应 UI 的「采用对端那一版」：owner 裁定要这个选项 ✓）
        // ⚠️ 2026-09-29 订正（合入 dev 时并入的另一侧同一处改动）：原来的坏值表里有 `"remote"`，
        //    而 `575a58c6` 已把它放开成**合法值**（见本文件 `CHOICE_REMOTE` 与 :165 那个校验）
        //    ⇒ 这条判据自那天起就是红的。**「合法值不许出现在坏值表里」**——这是同一条纪律的另一面。
        for (i, choice) in [CHOICE_LOCAL, CHOICE_SAVED_AS_NEW, CHOICE_REMOTE]
            .into_iter()
            .enumerate()
        {
            let pid = format!("p{i}");
            page(&c, &pid);
            record_lineage_conflict(&c, &pid, "7", "42", "{}", 10).unwrap();
            let id = unresolved_lineage_conflict(&c, &pid)
                .unwrap()
                .expect("应当有未决")
                .id;
            resolve_lineage_conflict(&c, &id, choice, 11).unwrap();
            let all = lineage_conflicts_of(&c, &pid).unwrap();
            assert_eq!(all.len(), 1);
            assert_eq!(
                all[0].resolved_choice.as_deref(),
                Some(choice),
                "{choice:?} 应被收下并如实存起来 ✓"
            );
            // 裁决时间要落上、且要落成**实际传进去的那个值** ✓（另一侧更严的断言：`is_some()` 会漏掉"落成别的值"）
            assert_eq!(all[0].resolved_at, Some(11), "裁决时间要落上 ✓");
            // 已裁决的**不能再裁决** ✓
            assert!(
                resolve_lineage_conflict(&c, &id, choice, 12).is_err(),
                "已裁决的再裁决要报错"
            );
        }

        // ★ 不默认选边：**第四个**值与"看起来像"的写法一律报错 ✓
        page(&c, "pbad");
        record_lineage_conflict(&c, "pbad", "1", "2", "{}", 10).unwrap();
        let idbad = unresolved_lineage_conflict(&c, "pbad")
            .unwrap()
            .expect("应当有未决")
            .id;
        for bad in [
            "",
            "whatever",
            "use-remote",
            "LOCAL",
            "saved_as_new",
            "Remote",
        ] {
            assert!(
                resolve_lineage_conflict(&c, &idbad, bad, 13).is_err(),
                "{bad:?} 不该被接受"
            );
        }
        // 而合法值仍能收 ⇒ 证明上面那一串拒的是**值本身**，不是"这一行坏了" ✓
        resolve_lineage_conflict(&c, &idbad, CHOICE_REMOTE, 14).unwrap();
        assert_eq!(
            lineage_conflicts_of(&c, "pbad").unwrap()[0]
                .resolved_choice
                .as_deref(),
            Some(CHOICE_REMOTE)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_page_has_no_conflict_and_other_pages_are_not_disturbed() {
        let (c, dir) = conn("scope");
        page(&c, "p1");
        page(&c, "p2");
        record_lineage_conflict(&c, "p1", "1", "2", "{}", 10).unwrap();
        assert!(unresolved_lineage_conflict(&c, "nope").unwrap().is_none());
        assert!(
            unresolved_lineage_conflict(&c, "p2").unwrap().is_none(),
            "别把冲突记到别的页上"
        );
        assert_eq!(lineage_conflicts_of(&c, "p2").unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
