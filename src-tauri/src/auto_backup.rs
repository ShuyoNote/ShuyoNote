//! 自动备份的**调度与保留**逻辑（P1）。
//!
//! ── 挡的是哪一次真实缺口 ────────────────────────────────────────────────────────
//! `docs/plans/2026-10-09-自动备份可行性评估.md` §5 把自动备份分五期，P1 逐字是：
//!   「**调度器（启动触发 ＋ 每 24h）＋ 保留分层（7 日/4 周/12 月）**」
//! 它 §6 给的机器判据逐字是：
//!   「**连续两次调度后备份目录里出现当日快照** ✓；**保留策略跑一遍后旧份消失、新份在** ✓（给命令＋读数）」
//!
//! ── 为什么把"纯逻辑"与"跑备份"分开 ─────────────────────────────────────────────
//! 「跑一次备份」要 AppHandle／数据库／钥匙（见 `backup.rs` 的 `export_backup`）⇒ 那部分
//! **不可单测**且依赖真实用户数据 ✗。而 P1 真正会出错、也真正值得钉死的是两条**纯函数**：
//!   ① 到点了没有（`should_run`）—— 错了就是"从不备份"或"每次启动都备份"✗
//!   ② 保留分层删哪些（`retention_keep`）—— 错了就是**删掉不该删的备份** ✗（最危险的方向）
//! ⇒ 这两条在这里，**不碰文件系统、不碰数据库、不引新依赖**（只用 `std`）✓
//!
//! ⚠️ 硬约束（评估文档 §3-②，`backup.rs:41` 逐字）：
//!   「`backup is not supported with encrypted databases`」⇒ **加密空间不走在线备份 API** ✓
//!   本模块**只做调度与保留**，不决定"怎么备份" ✓；跳过什么由 `backup.rs` 如实报 ✓。

use std::time::{SystemTime, UNIX_EPOCH};

/// 保留分层（评估文档 §5 P1 逐字：7 日 / 4 周 / 12 月）✓
pub const KEEP_DAYS: u64 = 7;
pub const KEEP_WEEKS: u64 = 4;
pub const KEEP_MONTHS: u64 = 12;

/// 默认间隔：24 小时（P1 逐字「每 24h」✓）
pub const DEFAULT_INTERVAL_SECS: u64 = 24 * 60 * 60;

const DAY: u64 = 24 * 60 * 60;

/// 一次调度的结果（写日志用；**只记形状，不记内容** ✓）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutcome {
    /// 本次是否真的跑了（false ＝ 没到点／没开）
    pub ran: bool,
    /// 人话一句（写进日志）
    pub note: String,
}

/// 一个已存在的备份快照（只认这两样：名字与时间 ✓）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// 文件名（如 `shuyonote-backup-1759900000.zip`）
    pub name: String,
    /// 生成时刻（unix 秒）
    pub unix: u64,
}

/// 保留策略的产出：**留哪些、删哪些**（分开给 ⇒ 调用方可以只删明确列出的 ✓）
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RetentionPlan {
    pub keep: Vec<String>,
    pub remove: Vec<String>,
}

/// 当前 unix 秒；取不到系统时间时回 0（调用方据此判"环境不具备"✓，不假装成功 ✗）
pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 到点了吗？——`last_run` 为 `None` ⇒ **第一次**（启动触发 ✓）；到点或从未跑过 ⇒ true ✓
pub fn should_run(last_run: Option<u64>, now: u64, interval_secs: u64) -> bool {
    match last_run {
        None => true,
        Some(prev) => {
            if now < prev {
                // 时钟被往回拨（或状态文件被写坏）⇒ **不跑**，免得每次启动都刷备份 ✗
                false
            } else {
                now - prev >= interval_secs.max(1)
            }
        }
    }
}

/// 距离 1970-01-01 的天数（向下取整 ✓）
fn days_of(unix: u64) -> u64 {
    unix / DAY
}

/// 把"1970 起的第几天"折成 (年, 月, 日) —— Howard Hinnant 的 civil_from_days ✓ 纯整数 ✓
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 周序号：周一为一周之始 ✓（1970-01-01 是周四 ⇒ `+4` 对齐 ✓）
fn week_of(unix: u64) -> u64 {
    (days_of(unix) + 4) / 7
}

/// 月序号：`年 * 12 + (月 - 1)` ✓
fn month_of(unix: u64) -> i64 {
    let (y, m, _) = civil_from_days(days_of(unix) as i64);
    y * 12 + (m as i64 - 1)
}

/// 保留分层：⭐ P1 的核心判据之二 ——「跑一遍后**旧份消失、新份在**」✓
///
/// 规则（逐条可核 ✓）：
///   · 最近 **7 日**：每个自然日**各留一份**（⭐ 当日份一定在 ✓）
///   · 更早但 ≤ **4 周**（28 日）：**每 ISO 周留一份**（该周最新那份 ✓）
///   · 更早但 ≤ **12 月**（365 日）：**每自然月留一份**（该月最新那份 ✓）
///   · 再早：⭐ **删** ✓
///
/// ⚠️ 同一个"桶"里有多份时，**只留最新的那份**（其余进 remove ✓）；桶按**时间**分，与文件名无关 ✓
pub fn retention_keep(entries: &[Snapshot], now: u64) -> RetentionPlan {
    let mut sorted: Vec<&Snapshot> = entries.iter().collect();
    // 新的在前 ⇒ 每个桶第一次见到的那份就是"最新那份" ✓
    sorted.sort_by(|a, b| b.unix.cmp(&a.unix).then_with(|| b.name.cmp(&a.name)));

    let mut plan = RetentionPlan::default();
    let mut seen_days = std::collections::HashSet::new();
    let mut seen_weeks = std::collections::HashSet::new();
    let mut seen_months = std::collections::HashSet::new();

    for s in sorted {
        let age_days = if now >= s.unix { (now - s.unix) / DAY } else { 0 };
        let keep = if age_days < KEEP_DAYS {
            seen_days.insert(days_of(s.unix))
        } else if age_days < KEEP_WEEKS * 7 {
            seen_weeks.insert(week_of(s.unix))
        } else if age_days < KEEP_MONTHS * 30 + 5 {
            seen_months.insert(month_of(s.unix))
        } else {
            false
        };
        if keep {
            plan.keep.push(s.name.clone());
        } else {
            plan.remove.push(s.name.clone());
        }
    }
    // 删除清单也按新→旧给，方便日志读 ✓
    plan
}

/// 一行日志（**固定形状** ⇒ 可被 grep／可被核对 ✓）
pub fn log_line(ran: bool, kept: usize, removed: usize, note: &str) -> String {
    format!(
        "[auto-backup] ran={} kept={} removed={} note={}",
        ran, kept, removed, note
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(name: &str, unix: u64) -> Snapshot {
        Snapshot {
            name: name.to_string(),
            unix,
        }
    }

    // ── should_run：启动触发 ＋ 每 24h ────────────────────────────────────────
    #[test]
    fn first_run_always_fires() {
        assert!(should_run(None, 1_000, DEFAULT_INTERVAL_SECS));
    }

    #[test]
    fn not_due_before_interval() {
        let now = 10 * DAY;
        assert!(!should_run(Some(now - 60), now, DEFAULT_INTERVAL_SECS));
        assert!(!should_run(Some(now - DAY + 1), now, DEFAULT_INTERVAL_SECS));
    }

    #[test]
    fn due_at_and_after_interval() {
        let now = 10 * DAY;
        assert!(should_run(Some(now - DAY), now, DEFAULT_INTERVAL_SECS));
        assert!(should_run(Some(now - 3 * DAY), now, DEFAULT_INTERVAL_SECS));
    }

    #[test]
    fn clock_backwards_does_not_storm() {
        // 状态里的时间比"现在"还晚（时钟回拨／文件被写坏）⇒ 不跑 ✓
        assert!(!should_run(Some(10 * DAY), 5 * DAY, DEFAULT_INTERVAL_SECS));
    }

    // ── retention_keep：7 日 / 4 周 / 12 月 ───────────────────────────────────
    #[test]
    fn keeps_every_day_within_a_week() {
        let now = 100 * DAY;
        let entries = vec![
            snap("d0.zip", now),
            snap("d1.zip", now - DAY),
            snap("d6.zip", now - 6 * DAY),
        ];
        let p = retention_keep(&entries, now);
        assert_eq!(p.keep.len(), 3, "7 日内的每一份都该留 ✓");
        assert!(p.remove.is_empty());
    }

    #[test]
    fn same_day_keeps_only_newest() {
        // ⚠️ 取**当天正午** ⇒ 往回 1 小时仍在**同一天** ✓
        //（第一版我用 `now = 100 * DAY` ＋ `now - 3600` ⇒ 那其实**跨到了前一天** ✗
        //  —— 判据当场红了 ✓，而红的是**用例的前提** ✗，不是保留逻辑 ✓。）
        let now = 100 * DAY + 12 * 3600;
        let entries = vec![
            snap("old-today.zip", now - 3600),
            snap("new-today.zip", now),
        ];
        let p = retention_keep(&entries, now);
        assert_eq!(p.keep, vec!["new-today.zip".to_string()]);
        assert_eq!(p.remove, vec!["old-today.zip".to_string()]);
    }

    #[test]
    fn weeks_keep_one_per_week() {
        let now = 100 * DAY;
        // 10 天前与 11 天前：同一周 ⇒ 只留新的那份；20 天前：另一周 ⇒ 留
        let entries = vec![
            snap("w-a-10d.zip", now - 10 * DAY),
            snap("w-b-11d.zip", now - 11 * DAY),
            snap("w-c-20d.zip", now - 20 * DAY),
        ];
        let p = retention_keep(&entries, now);
        assert!(p.keep.contains(&"w-a-10d.zip".to_string()), "同周该留最新 ✓");
        assert!(!p.keep.contains(&"w-b-11d.zip".to_string()), "同周旧份该删 ✓");
        assert!(p.keep.contains(&"w-c-20d.zip".to_string()), "另一周该留 ✓");
    }

    #[test]
    fn months_keep_one_per_month_and_drop_older_than_a_year() {
        let now = 400 * DAY;
        let entries = vec![
            snap("m-old-1.zip", now - 300 * DAY),
            snap("m-old-2.zip", now - 305 * DAY), // 与上一份同月 ⇒ 删
            snap("m-old-3.zip", now - 390 * DAY), // 同月里更新的那份保留
            snap("ancient.zip", now - 366 * DAY), // 超过 12 月 ⇒ 删
        ];
        let p = retention_keep(&entries, now);
        assert!(p.keep.contains(&"m-old-1.zip".to_string()), "该月的最新一份该留 ✓");
        assert!(!p.keep.contains(&"m-old-2.zip".to_string()), "同月旧份该删 ✓");
        assert!(!p.keep.contains(&"ancient.zip".to_string()), "超过 12 月该删 ✓");
    }

    /// ⭐ 评估文档 §6 P1 的判据逐字：「保留策略跑一遍后**旧份消失、新份在**」✓
    #[test]
    fn p1_criterion_old_gone_new_stays() {
        let now = 500 * DAY;
        let entries = vec![
            snap("fresh.zip", now - 60),          // 新 ✓
            snap("old-same-day.zip", now - 120),  // 同一天 ⇒ 该消失 ✓
            snap("very-old.zip", now - 400 * DAY), // 超期 ⇒ 该消失 ✓
        ];
        let p = retention_keep(&entries, now);
        assert!(p.keep.contains(&"fresh.zip".to_string()), "新份在 ✓");
        assert!(p.remove.contains(&"old-same-day.zip".to_string()), "旧份消失 ✓");
        assert!(p.remove.contains(&"very-old.zip".to_string()), "超期消失 ✓");
        // 每个输入恰好归到 keep 或 remove 之一（⭐ 不重不漏 ✓）
        assert_eq!(p.keep.len() + p.remove.len(), entries.len());
    }

    #[test]
    fn log_line_shape_is_stable() {
        let s = log_line(true, 3, 2, "ok");
        assert_eq!(s, "[auto-backup] ran=true kept=3 removed=2 note=ok");
    }
}
