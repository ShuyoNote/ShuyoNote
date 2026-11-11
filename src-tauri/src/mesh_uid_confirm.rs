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
}
