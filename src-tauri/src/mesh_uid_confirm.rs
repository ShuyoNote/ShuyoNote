//! ⭐ 2026-11-10（owner 批 B）：「同名但 `space_uid` 不同」的**人确认一次**入口。
//!
//! 背景（真机）：两台机器上都有一个同名空间（如「山焦招标」），但 `space_uid` 不同 ⇒
//! 融合闸 `RefuseDifferentUid` **每轮都拒绝**、水位不前进，而**没有任何确认入口** ⇒ 用户看着
//! 就是“同名空间永远同步不过去”。
//!
//! 口径（owner 2026-11-10 拍 B）：
//! * **保留** uid 闸门（不把两个碰巧同名的空间自动并掉）；
//! * 但把冲突**记下来**（供界面列出），并允许用户点一次「确认是同一空间」；
//! * 确认后 ⇒ 对该 `(peer_device, peer_uid)` **放行一次**（之后按正常融合走、可回滚靠融合账本）。
//!
//! ⚠️ 只存**元数据**（设备 id / 对端空间 uid / 名字 / 时刻）—— ⛔ 不存任何页面正文 ✗。
//! ⛔ 本模块不碰加密、不碰网络：只读写当前空间库里的两张小表。

use rusqlite::Connection;

/// 一条待确认的冲突（只含元数据）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshUidConflict {
    /// 对端设备 id。
    pub peer_device: String,
    /// 对端那一侧空间报的 `space_uid`。
    pub peer_uid: String,
    /// 本机这个空间的名字（用于界面文案）。
    pub local_name: String,
    /// 对端载荷里报的空间名。
    pub peer_name: String,
    /// 最近一次看到冲突的时刻（毫秒）。
    pub last_seen_at: i64,
}

/// 建表（幂等；空间库打开时也会建，这里再保一道 —— 老库升级后第一次就会用上）。
pub fn ensure_schema(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS mesh_uid_candidates (
             peer_device  TEXT NOT NULL,
             peer_uid     TEXT NOT NULL,
             local_name   TEXT NOT NULL DEFAULT '',
             peer_name    TEXT NOT NULL DEFAULT '',
             last_seen_at INTEGER NOT NULL,
             PRIMARY KEY (peer_device, peer_uid)
         );
         CREATE TABLE IF NOT EXISTS mesh_uid_confirmations (
             peer_device  TEXT NOT NULL,
             peer_uid     TEXT NOT NULL,
             confirmed_at INTEGER NOT NULL,
             PRIMARY KEY (peer_device, peer_uid)
         );",
    )
}

/// 记一条冲突候选（同 `(peer_device, peer_uid)` 只更新最近时刻/名字）。
pub fn record_candidate(
    c: &Connection,
    peer_device: &str,
    peer_uid: &str,
    local_name: &str,
    peer_name: &str,
    now_ms: i64,
) -> rusqlite::Result<()> {
    ensure_schema(c)?;
    c.execute(
        "INSERT INTO mesh_uid_candidates (peer_device, peer_uid, local_name, peer_name, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(peer_device, peer_uid) DO UPDATE SET
             local_name = excluded.local_name,
             peer_name = excluded.peer_name,
             last_seen_at = excluded.last_seen_at",
        rusqlite::params![peer_device, peer_uid, local_name, peer_name, now_ms],
    )?;
    Ok(())
}

/// 列出待确认冲突（按最近看到时间倒序；⛔ 不含正文）。
pub fn list_candidates(c: &Connection) -> rusqlite::Result<Vec<MeshUidConflict>> {
    ensure_schema(c)?;
    let mut stmt = c.prepare(
        "SELECT peer_device, peer_uid, local_name, peer_name, last_seen_at
         FROM mesh_uid_candidates ORDER BY last_seen_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(MeshUidConflict {
            peer_device: r.get(0)?,
            peer_uid: r.get(1)?,
            local_name: r.get(2)?,
            peer_name: r.get(3)?,
            last_seen_at: r.get(4)?,
        })
    })?;
    rows.collect()
}

/// ⭐ **A3（2026-11-21）**：用户**勾选的一条**要确认的键（前端只送勾选的那些，⛔ 不含名字/正文）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshUidKey {
    pub peer_device: String,
    pub peer_uid: String,
}

/// ⭐ **A3（2026-11-21）**：批量确认的**纯函数计划** —— 「选择 ⇒ 哪些键要写」× 同 uid 传播。
///
/// ⚠️ 它**只算**：⛔ 不碰库、⛔ 不读时钟、⛔ 不发包。命令层照这份清单在**一个事务**里写。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BatchConfirmPlan {
    /// 要写进 `mesh_uid_confirmations` 的键（去重、排序；＝ 勾选命中 ＋ 同 uid 传播）。
    pub write: Vec<(String, String)>,
    /// 其中**来自传播**（uid 相同、自己没被勾）的条数（界面用它说"另外几对也一并确认"）。
    pub propagated: usize,
}

/// ⭐ **A3（2026-11-21）**：`mesh_uid_confirm_batch` 的读数（只回数量，⛔ 不回任何 uid/正文）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshUidBatchDone {
    /// 真正写进确认表的对数。
    pub written: usize,
    /// 其中来自传播（同 uid、未被勾选）的条数。
    pub propagated: usize,
}

/// ⭐ **A3（2026-11-21）**：**纯函数** —— 勾选 ＋ 候选表 ⇒ 要写哪些确认键。
///
/// 三条判据（命令层与前端各自只负责其中一段，两边判据同名）：
/// 1. **`batch-selected-only`**：批量阶段只从**勾选**里出发 —— 候选表里没有的键一行都不写
///    （⛔ 不替调用方猜；与 `mesh_create_spaces`「只认候选表里有的名字」同一口径）；
/// 2. **`propagate-same-uid-only`**：确认后把结论传播到**同一个 `space_uid`** 的候选，
///    ⛔ uid 不同 ⇒ **绝不传播**（哪怕同一台设备）。
///    ⚠️ 传播**只看 uid、不看设备**：`(peer_device, peer_uid)` 是候选表主键 ⇒
///    "同一台设备的同一个 uid"不可能有第二条候选；能传播到的必然是**别的设备报了同一个
///    uid** ＝ 同一个空间身份（这正是"每对设备各点一次"要省掉的那一半）。
/// 3. **`empty-selection-writes-nothing`**：空选／全是空键／没有候选 ⇒ 空计划
///    （命令层据此**不开库、不写行**）。
pub fn plan_batch_confirm(
    candidates: &[MeshUidConflict],
    selected: &[MeshUidKey],
) -> BatchConfirmPlan {
    // ---- ① 批量：只认"勾了 **且** 候选表里真有"的键（trim 后比较；空键一律丢，⛔ 不猜）----
    let mut picked: Vec<(String, String)> = Vec::new();
    for k in selected {
        let (dev, uid) = (k.peer_device.trim(), k.peer_uid.trim());
        if dev.is_empty() || uid.is_empty() {
            continue;
        }
        if !candidates
            .iter()
            .any(|c| c.peer_device.trim() == dev && c.peer_uid.trim() == uid)
        {
            continue;
        }
        if !picked.iter().any(|(d, u)| d == dev && u == uid) {
            picked.push((dev.to_string(), uid.to_string()));
        }
    }
    // ③ 空选 / 一个都没命中 ⇒ 空计划（⛔ 不发请求、不写库）。
    if picked.is_empty() {
        return BatchConfirmPlan::default();
    }
    // ---- ② 传播：只沿 **uid 相同** 扩散；uid 不同的一行都不带 ----
    // 先把"这一批勾中的 uid"拷成自有集合 —— `picked` 随后要被 move 成 `write`。
    let wanted: std::collections::HashSet<String> = picked.iter().map(|(_, u)| u.clone()).collect();
    let mut write = picked;
    let mut propagated = 0usize;
    for c in candidates {
        let (dev, uid) = (c.peer_device.trim(), c.peer_uid.trim());
        if uid.is_empty() || !wanted.contains(uid) {
            continue;
        }
        if write.iter().any(|(d, u)| d == dev && u == uid) {
            continue;
        }
        write.push((dev.to_string(), uid.to_string()));
        propagated += 1;
    }
    // 稳定顺序：同一个勾选集合永远算出同一份清单（判据/事务都按它走）。
    write.sort();
    BatchConfirmPlan { write, propagated }
}

/// 用户确认「这一台对端的这个 uid 就是我这台同名空间」。
///
/// 幂等：重复确认只刷新时刻；同时把冲突候选移出列表。
pub fn confirm(
    c: &Connection,
    peer_device: &str,
    peer_uid: &str,
    now_ms: i64,
) -> rusqlite::Result<()> {
    ensure_schema(c)?;
    c.execute(
        "INSERT INTO mesh_uid_confirmations (peer_device, peer_uid, confirmed_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(peer_device, peer_uid) DO UPDATE SET confirmed_at = excluded.confirmed_at",
        rusqlite::params![peer_device, peer_uid, now_ms],
    )?;
    c.execute(
        "DELETE FROM mesh_uid_candidates WHERE peer_device = ?1 AND peer_uid = ?2",
        rusqlite::params![peer_device, peer_uid],
    )?;
    Ok(())
}

/// 这一对 `(peer_device, peer_uid)` 是否已被用户确认过。
pub fn is_confirmed(c: &Connection, peer_device: &str, peer_uid: &str) -> bool {
    if ensure_schema(c).is_err() {
        // 建不了表 ⇒ 当"没确认"（保守方向：仍然拒绝，不猜）。
        return false;
    }
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM mesh_uid_confirmations WHERE peer_device = ?1 AND peer_uid = ?2)",
        rusqlite::params![peer_device, peer_uid],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n != 0)
    .unwrap_or(false)
}

/// 融合闸 × 确认记录的**唯一接线入口**（在 `mesh.rs` 的融合决策里调用）。
///
/// 行为：
/// * 非 `RefuseDifferentUid` ⇒ **原样返回**（确认不影响其它拒绝）；
/// * `RefuseDifferentUid` ＋ 已确认 ⇒ `Allow`；
/// * `RefuseDifferentUid` ＋ 未确认 ⇒ 记一条候选（供界面列出）后原样返回拒绝。
pub fn decide(
    c: &Connection,
    gate: crate::mesh_merge_ledger::MergeGate,
    peer_device: &str,
    peer_uid: Option<&str>,
    local_name: &str,
    peer_name: &str,
    now_ms: i64,
) -> crate::mesh_merge_ledger::MergeGate {
    use crate::mesh_merge_ledger::MergeGate;
    if !matches!(gate, MergeGate::RefuseDifferentUid) {
        return gate;
    }
    let Some(uid) = peer_uid.map(str::trim).filter(|u| !u.is_empty()) else {
        // 没有对端 uid 就谈不上"确认哪一对"（回到原拒绝）。
        return gate;
    };
    if is_confirmed(c, peer_device, uid) {
        return MergeGate::Allow;
    }
    let _ = record_candidate(c, peer_device, uid, local_name, peer_name, now_ms);
    gate
}

/// 纯函数：融合闸结果 ×「是否已确认」⇒ 最终是否放行。
///
/// 只有一种情况会因确认而放行：**原本是 `RefuseDifferentUid`**（同名但 uid 不同）。
/// 其它拒绝（身份判不出 / 不同人 / 名字不同）**一律不放行** —— ⛔ 确认不绕过身份闸。
pub fn apply_confirmation(
    gate: crate::mesh_merge_ledger::MergeGate,
    confirmed: bool,
) -> crate::mesh_merge_ledger::MergeGate {
    use crate::mesh_merge_ledger::MergeGate;
    if confirmed && matches!(gate, MergeGate::RefuseDifferentUid) {
        MergeGate::Allow
    } else {
        gate
    }
}

/// ⭐ **P0-2（2026-11-11）**：本机对某台对端确认记录里保存的“对端 uid” —— 随 pull 请求带给它。
///
/// 用法：A 在本机点过“确认是同一空间”后，下一轮 A 拉 B 时把 `(A 的空间 uid, B 的空间 uid)`
/// 带在请求里；B 验签通过且确认 `B 的空间 uid` 与自己对得上 ⇒ B 也记一条确认（一次确认双向放行）。
pub fn confirmed_peer_uid(c: &Connection, peer_device: &str) -> Option<String> {
    if ensure_schema(c).is_err() {
        return None;
    }
    c.query_row(
        "SELECT peer_uid FROM mesh_uid_confirmations WHERE peer_device = ?1 ORDER BY confirmed_at DESC LIMIT 1",
        [peer_device],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh_merge_ledger::MergeGate;

    /// ⭐ A3（2026-11-21）判据 ① **`batch-selected-only`**：批量只写**勾了且候选表里有**的键。
    ///
    /// 未勾的不写；勾了但候选表里没有的（过期/伪造的键）也**不写**（⛔ 不替调用方猜）。
    #[test]
    fn batch_只写勾选且候选表里真有的键() {
        let cands = vec![
            cand("dev-a", "uid-1"),
            cand("dev-b", "uid-1"),
            cand("dev-a", "uid-2"),
        ];
        let plan = plan_batch_confirm(&cands, &[key("dev-a", "uid-1")]);
        assert_eq!(
            plan.write,
            vec![
                ("dev-a".to_string(), "uid-1".to_string()),
                ("dev-b".to_string(), "uid-1".to_string()),
            ],
            "勾一对一 ⇒ 写这一对 ＋ 同 uid 的另一台；⛔ 不写未勾的 uid-2"
        );
        assert_eq!(plan.propagated, 1, "另一台那条走的是传播");

        // 勾一个候选表里根本不存在的键 ⇒ 一行都不写（⛔ 不替调用方猜）
        let plan = plan_batch_confirm(&cands, &[key("dev-z", "uid-404")]);
        assert_eq!(plan, BatchConfirmPlan::default());

        // 同一键勾两次 ⇒ 只写一行
        let plan = plan_batch_confirm(&cands, &[key("dev-a", "uid-2"), key("dev-a", "uid-2")]);
        assert_eq!(
            plan.write,
            vec![("dev-a".to_string(), "uid-2".to_string())],
            "去重；且 uid-2 没有同 uid 的别的候选"
        );
        assert_eq!(plan.propagated, 0);
    }

    /// ⭐ A3 判据 ② **`propagate-same-uid-only`**：传播只沿**同一个 uid**；
    /// ⛔ uid 不同 ⇒ 绝不传播（哪怕同一台设备、同一个名字）。
    #[test]
    fn 传播只认_uid_相同_不同的一行都不带() {
        let cands = vec![
            cand("dev-a", "uid-1"),
            // 同一台设备、同名、但 uid 不同 ⇒ ⛔ 绝不传播
            cand("dev-a", "uid-2"),
            // 另一台设备、同一个 uid ⇒ 同一空间身份 ⇒ 传播
            cand("dev-b", "uid-1"),
            // 另一台设备、不同 uid ⇒ ⛔ 不带
            cand("dev-b", "uid-9"),
        ];
        let plan = plan_batch_confirm(&cands, &[key("dev-a", "uid-1")]);
        assert_eq!(
            plan.write,
            vec![
                ("dev-a".to_string(), "uid-1".to_string()),
                ("dev-b".to_string(), "uid-1".to_string()),
            ],
            "只有 uid-1 那两条被写"
        );
        assert_eq!(plan.propagated, 1);
        assert!(
            !plan.write.iter().any(|(_, u)| u == "uid-2" || u == "uid-9"),
            "⛔ uid 不同的一行都不许出现：{:?}",
            plan.write
        );
    }

    /// ⭐ A3 判据 ③ **`empty-selection-writes-nothing`**：空选／空键／没有候选 ⇒ 空计划。
    #[test]
    fn 空选或没有候选_产出空计划() {
        let cands = vec![cand("dev-a", "uid-1")];
        for selected in [
            vec![],
            vec![key("", "")],
            vec![key("  ", "uid-1")],
            vec![key("dev-a", "   ")],
        ] {
            assert_eq!(
                plan_batch_confirm(&cands, &selected),
                BatchConfirmPlan::default(),
                "空选/空键 ⇒ 不写：{selected:?}"
            );
        }
        // 没有候选 ⇒ 哪怕勾了东西也不写
        assert_eq!(
            plan_batch_confirm(&[], &[key("dev-a", "uid-1")]),
            BatchConfirmPlan::default()
        );
    }

    /// ⭐ A3（端到端那一半）：把计划**逐条**落进确认表 ⇒ 只有计划里的键被确认，
    /// 同 uid 的另一台也放行，uid 不同的仍然拒绝。
    #[test]
    fn 计划落库后_同_uid_放行_不同_uid_仍然拒绝() {
        let c = conn();
        record_candidate(&c, "dev-a", "uid-1", "山焦招标", "山焦招标", 1).unwrap();
        record_candidate(&c, "dev-b", "uid-1", "山焦招标", "山焦招标", 1).unwrap();
        record_candidate(&c, "dev-a", "uid-2", "山焦招标", "山焦招标", 1).unwrap();
        let cands = list_candidates(&c).unwrap();
        let plan = plan_batch_confirm(&cands, &[key("dev-a", "uid-1")]);
        for (dev, uid) in &plan.write {
            confirm(&c, dev, uid, 10).unwrap();
        }
        assert!(is_confirmed(&c, "dev-a", "uid-1"));
        assert!(is_confirmed(&c, "dev-b", "uid-1"), "同 uid 的那台也被写");
        assert!(
            !is_confirmed(&c, "dev-a", "uid-2"),
            "⛔ uid 不同 ⇒ 绝不传播"
        );
        assert_eq!(plan.write.len(), 2, "只写两行");
    }

    fn key(dev: &str, uid: &str) -> MeshUidKey {
        MeshUidKey {
            peer_device: dev.into(),
            peer_uid: uid.into(),
        }
    }

    fn cand(dev: &str, uid: &str) -> MeshUidConflict {
        MeshUidConflict {
            peer_device: dev.into(),
            peer_uid: uid.into(),
            local_name: "山焦招标".into(),
            peer_name: "山焦招标".into(),
            last_seen_at: 1,
        }
    }

    #[test]
    fn 对端_uid_读得回_没确认过就是_none() {
        let c = conn();
        assert_eq!(confirmed_peer_uid(&c, "dev-b"), None);
        confirm(&c, "dev-b", "uid-b", 10).unwrap();
        assert_eq!(confirmed_peer_uid(&c, "dev-b"), Some("uid-b".to_string()));
        assert_eq!(confirmed_peer_uid(&c, "dev-other"), None);
    }

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        ensure_schema(&c).unwrap();
        c
    }

    #[test]
    fn 确认只对_uid_不同放行_其它拒绝一律不动() {
        assert_eq!(
            apply_confirmation(MergeGate::RefuseDifferentUid, true),
            MergeGate::Allow
        );
        for g in [
            MergeGate::Allow,
            MergeGate::RefuseDifferentName,
            MergeGate::RefuseUnknownIdentity,
            MergeGate::RefuseDifferentPerson,
        ] {
            assert_eq!(apply_confirmation(g, true), g, "确认不得绕过 {g:?}");
        }
        assert_eq!(
            apply_confirmation(MergeGate::RefuseDifferentUid, false),
            MergeGate::RefuseDifferentUid
        );
    }

    #[test]
    fn 候选_确认_幂等_且只含元数据() {
        let c = conn();
        record_candidate(&c, "dev-a", "uid-peer-1", "山焦招标", "山焦招标", 1000).unwrap();
        record_candidate(&c, "dev-a", "uid-peer-1", "山焦招标", "山焦招标", 2000).unwrap();
        let list = list_candidates(&c).unwrap();
        assert_eq!(list.len(), 1, "同 (设备, uid) 只留一条");
        assert_eq!(list[0].last_seen_at, 2000);
        assert!(!is_confirmed(&c, "dev-a", "uid-peer-1"));

        confirm(&c, "dev-a", "uid-peer-1", 3000).unwrap();
        assert!(is_confirmed(&c, "dev-a", "uid-peer-1"));
        assert!(list_candidates(&c).unwrap().is_empty(), "确认后候选要移除");
        // 幂等：重复确认不报错
        confirm(&c, "dev-a", "uid-peer-1", 4000).unwrap();
        assert!(is_confirmed(&c, "dev-a", "uid-peer-1"));
    }

    /// ⭐ 2026-11-11（真机：点确认报 `missing required key peerDevice`）：
    /// 列表命令的 JSON **键必须是 camelCase** —— 前端 `MeshUidConflict` 读的是
    /// `peerDevice`／`localName`；少了 `rename_all` ⇒ 界面字段全 `undefined`
    /// ⇒ 点确认时参数被 JSON 丢掉 ⇒ 后端报缺 key。
    #[test]
    fn conflict_row_serializes_with_camel_case_keys_for_the_panel() {
        let row = MeshUidConflict {
            peer_device: "dev-a".into(),
            peer_uid: "uid-1".into(),
            local_name: "山焦招标".into(),
            peer_name: "山焦招标".into(),
            last_seen_at: 7,
        };
        let json = serde_json::to_string(&row).unwrap();
        for key in [
            "\"peerDevice\"",
            "\"peerUid\"",
            "\"localName\"",
            "\"peerName\"",
            "\"lastSeenAt\"",
        ] {
            assert!(json.contains(key), "缺 {key}：{json}");
        }
        assert!(!json.contains("peer_device"), "⛔ 不许 snake_case：{json}");
    }
}
