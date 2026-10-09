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

// ---------------------------------------------------------------------------
// 调度器（P1 的另一半：**启动触发 ＋ 每 24h**）
// ---------------------------------------------------------------------------
//
// ⚠️ 为什么这里**不碰 Tauri／不碰数据库**：真跑一次备份要 AppHandle 与钥匙（见 `backup.rs`）
// ⇒ 那是**不可单测**的一侧 ✗。这里只留"**什么时候跑**"这一层，真跑的动作由调用方
// 以闭包传进来（`run`）⇒ 于是"到点没有／失败怎么记"这两件最容易出错的事都能被单测钉住 ✓。

/// 一次真实备份的结果（由调用方填；本模块只消费它 ✓）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunResult {
    /// 跑成功了：kept/removed 由保留策略给出 ✓
    Ok { kept: usize, removed: usize, note: String },
    /// 没跑（例如加密空间不支持在线备份 ⇒ 如实跳过，**不假装成功** ✓）
    Skipped { note: String },
    /// 跑了但失败（错误必须进日志 ✓）
    Failed { note: String },
}

/// "上一次跑在什么时候"——调用方负责持久化（这里只给窄接口 ⇒ 好测 ✓）
pub trait LastRunStore {
    fn get(&self) -> Option<u64>;
    fn set(&mut self, unix: u64);
}

/// 现在几点（注入 ⇒ 测试不必等 24 小时 ✓）
pub trait Clock {
    fn now(&self) -> u64;
}

/// 真时间的实现（生产用 ✓）
pub struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> u64 {
        now_unix()
    }
}

impl RunResult {
    /// 一行说明（写日志用 ✓）——`RunOutcome.note` 是**结果行**，本方法是**原因** ✓
    pub fn note(&self) -> &str {
        match self {
            RunResult::Ok { note, .. } => note,
            RunResult::Skipped { note } => note,
            RunResult::Failed { note } => note,
        }
    }
}
/// 这个文件算不算「一份有效快照」？⭐ P1 的保留判据用它 ⇒ **半个包不算** ✓
///（0 字节 ＝ 没写完 ✗ ／ `.part` ＝ 正在写 ✗ ／ 别的名字不受我们管 ✓）
pub fn is_valid_snapshot(name: &str, size: u64) -> bool {
    name.starts_with("shuyonote-backup-") && name.ends_with(".zip") && size > 0
}

/// 进程内的"上次跑在什么时候" ✓
///
/// ⚠️ 刻意**不落盘**：P1 的语义是「**启动触发** ＋ 每 24h」✓ ⇒ 每次启动跑一轮**正是规格** ✓
/// （落盘会让"重启后 24 小时内不跑"变成默认行为 ⇒ 与 P1 逐字相反 ✗）。
#[derive(Debug, Default)]
pub struct MemoryStore {
    last: Option<u64>,
}
impl LastRunStore for MemoryStore {
    fn get(&self) -> Option<u64> {
        self.last
    }
    fn set(&mut self, unix: u64) {
        self.last = Some(unix);
    }
}
/// 一轮调度：**到点就跑一次**，把结果记成一行日志 ✓
///
/// ⚠️ 三条行为写死在这里（都能被单测钉住 ✓）：
///   ① 不到点 ⇒ `ran=false`，**绝不调用 `run`** ✓（否则每次 tick 都刷一份备份 ✗）
///   ② 到点且跑过 ⇒ 无论成败都**写入"刚刚跑过"** ✓（否则失败会变成每 tick 重试风暴 ✗）
///   ③ 失败 ⇒ 日志行里带 `Failed` 与原因 ✓（跳过要如实报 ✓）
pub fn tick<S, C, F>(
    store: &mut S,
    clock: &C,
    interval_secs: u64,
    run: &mut F,
) -> RunOutcome
where
    S: LastRunStore,
    C: Clock,
    F: FnMut() -> RunResult,
{
    let now = clock.now();
    if !should_run(store.get(), now, interval_secs) {
        return RunOutcome {
            ran: false,
            note: log_line(false, 0, 0, "not-due"),
        };
    }
    let outcome = run();
    store.set(now);
    let note = match outcome {
        RunResult::Ok {
            kept,
            removed,
            note,
        } => log_line(true, kept, removed, &note),
        RunResult::Skipped { note } => log_line(true, 0, 0, &format!("skipped: {note}")),
        RunResult::Failed { note } => log_line(true, 0, 0, &format!("failed: {note}")),
    };
    RunOutcome { ran: true, note }
}

/// 起一个后台线程：**启动时先跑一轮**，然后每 `tick_secs` 走一次 `tick` ✓
///
/// ⚠️ 只做"睡 → tick"这件事；`store` 的读写与真备份都在调用方给的闭包里 ✓
pub fn spawn_loop<S, F>(mut store: S, interval_secs: u64, tick_secs: u64, mut run: F) -> std::thread::JoinHandle<()>
where
    S: LastRunStore + Send + 'static,
    F: FnMut() -> RunResult + Send + 'static,
{
    std::thread::spawn(move || {
        // ⚠️ 下限只防忙等（1s ⇒ 本机能用环境变量把端到端判据跑出来 ✓；生产默认 3600s ✓）
        let step = tick_secs.max(1);
        loop {
            let _ = tick(&mut store, &SystemClock, interval_secs, &mut run);
            std::thread::sleep(std::time::Duration::from_secs(step));
        }
    })
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

    // ── 调度器：tick 的三条行为 ────────────────────────────────────────────
    struct FakeStore(Option<u64>);
    impl LastRunStore for FakeStore {
        fn get(&self) -> Option<u64> {
            self.0
        }
        fn set(&mut self, unix: u64) {
            self.0 = Some(unix);
        }
    }
    struct FixedClock(u64);
    impl Clock for FixedClock {
        fn now(&self) -> u64 {
            self.0
        }
    }

    #[test]
    fn tick_not_due_does_not_call_run() {
        let mut store = FakeStore(Some(100 * DAY));
        let clock = FixedClock(100 * DAY + 60);
        let mut calls = 0;
        let out = tick(&mut store, &clock, DEFAULT_INTERVAL_SECS, &mut || {
            calls += 1;
            RunResult::Ok { kept: 0, removed: 0, note: "x".into() }
        });
        assert!(!out.ran, "不到点不该跑 ✓");
        assert_eq!(calls, 0, "⭐ 不到点**绝不能**调用 run（否则每次 tick 都刷备份 ✗）");
        assert!(out.note.contains("not-due"), "日志要明说没到点 ✓");
    }

    #[test]
    fn tick_due_runs_and_records_success() {
        let mut store = FakeStore(Some(100 * DAY));
        let clock = FixedClock(101 * DAY);
        let out = tick(&mut store, &clock, DEFAULT_INTERVAL_SECS, &mut || RunResult::Ok {
            kept: 3,
            removed: 2,
            note: "ok".into(),
        });
        assert!(out.ran, "到点该跑 ✓");
        assert!(out.note.contains("ran=true kept=3 removed=2"), "成功读数要进日志 ✓");
        assert_eq!(store.get(), Some(101 * DAY), "跑过之后要记下『刚刚跑过』✓");
    }

    #[test]
    fn tick_records_last_run_even_on_failure() {
        let mut store = FakeStore(Some(100 * DAY));
        let clock = FixedClock(101 * DAY);
        let out = tick(&mut store, &clock, DEFAULT_INTERVAL_SECS, &mut || RunResult::Failed {
            note: "磁盘满".into(),
        });
        assert!(out.ran);
        assert!(out.note.contains("failed: 磁盘满"), "失败原因必须进日志 ✓");
        assert_eq!(store.get(), Some(101 * DAY), "⭐ 失败也要记账（否则会变成每 tick 重试风暴 ✗）");
    }

    #[test]
    fn tick_skipped_is_reported_not_silently_ok() {
        let mut store = FakeStore(None);
        let clock = FixedClock(50 * DAY);
        let out = tick(&mut store, &clock, DEFAULT_INTERVAL_SECS, &mut || RunResult::Skipped {
            note: "加密空间不支持在线备份".into(),
        });
        assert!(out.ran);
        assert!(out.note.contains("skipped:"), "⭐ 跳过要**如实报**，不许静默算成功 ✓");
        assert!(out.note.contains("加密空间"), "跳过原因要写清 ✓");

    }

    // ── 有效快照判据（⭐ 半个包不算一份 ✓） ──────────────────────────────
    #[test]
    fn valid_snapshot_requires_zip_name_and_nonzero_size() {
        assert!(is_valid_snapshot("shuyonote-backup-1.zip", 10));
        assert!(!is_valid_snapshot("shuyonote-backup-1.zip", 0), "⭐ 0 字节 = 半个包 ⇒ 不算 ✓");
        assert!(!is_valid_snapshot("shuyonote-backup-1.zip.part", 10), "⭐ 正在写 ⇒ 不算 ✓");
        assert!(!is_valid_snapshot("别人的备份.zip", 10), "⭐ 别人的名字不受我们管 ⇒ 不算 ✓");
    }

}

// ---------------------------------------------------------------------------
// P3：无头 `--backup-once`（⭐ 让"应用关着"也能备份）
// ---------------------------------------------------------------------------
//
// 评估文档 §3-③ 逐字点名这一块是**独立工作**：「`main.rs` 无参数解析 ✗ ⇒ 要做：参数解析 ✓
// ＋ **不建窗口的启动路径** ✓ ＋ 三平台计划任务/launchd/systemd 的**注册与撤销** ✓ ＋ 用户可见开关 ✓」。
// §6 给 P3 的判据逐字：「无头进程在**没有窗口**的情况下产出一份可校验的包 ✓；
//                       注册/撤销计划任务各一次都干净 ✓」。
//
// ⚠️ 本条只落**纯逻辑**（⭐ 可单测的那一半 ✓）：
//   · 参数判定（`cli_mode` ✓）—— 错了就是"关着的时候不备份"或"开窗口时把备份跑两遍" ✗
//   · systemd 单元文件文本（`systemd_units` ✓）—— ⭐ **Linux 那半按分工归 AMD** ✓
// ⛔ `main.rs` 的接线与"注册/撤销"动作**不在本笔** ✗（⭐ 动 `main.rs` 要先发信 ✓）。

/// 启动模式（⭐ 纯数据 ⇒ 可断言 ✓）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliMode {
    /// 正常启动（建窗口 ✓）
    Normal,
    /// ⭐ 无头：跑一次备份就退出（⛔ 不建窗口 ✓）
    BackupOnce,
}

/// 那条命令行开关（⭐ 只此一条 ⇒ 判据也只有一条 ✓）
pub const BACKUP_ONCE_FLAG: &str = "--backup-once";

/// systemd 单元基名（⭐ `.service` 与 `.timer` 共用 ✓）
pub const SYSTEMD_UNIT: &str = "shuyonote-backup";

/// 从 argv 判模式（⭐ **纯函数** ⇒ 可单测 ✓）
///
/// ⚠️ 口径（照实）：⭐ 只认 `--backup-once` ✓；⭐ 其余参数**不报错、也不吞** ✓
///    —— 本仓 `main.rs` 现在完全不解析参数 ✓，所以"多一个不认识的参数"必须**照旧正常启动** ✓
///    （⛔ 不能因为看见 `--help` 就不建窗口 ✗：那会让用户以为应用坏了 ✓）。
pub fn cli_mode<I, S>(args: I) -> CliMode
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    for a in args {
        if a.as_ref() == BACKUP_ONCE_FLAG {
            return CliMode::BackupOnce;
        }
    }
    CliMode::Normal
}

/// 生成 systemd 两个单元文件（⭐ **纯函数**、返回 (service, timer) ⇒ 可逐行断言 ✓）
///
/// ⭐ 我这一半（Linux）的判据：⭐ 单元文件里必须
///   · `ExecStart=<exe> --backup-once` ✓（⭐ 无头入口 ✓）
///   · `Type=oneshot` ✓（⭐ 跑完就退 ✓）
///   · `OnUnitActiveSec=24h` ＋ `Persistent=true` ✓（⭐ 每天一次；⭐ 关机错过也补 ✓）
pub fn systemd_units(exe_path: &str, interval_secs: u64) -> (String, String) {
    let interval = format!("{}s", interval_secs.max(60));
    let service = format!(
        "[Unit]\n\
         Description=ShuyoNote automatic backup (headless, no window)\n\
         After=default.target\n\n\
         [Service]\n\
         Type=oneshot\n\
         ExecStart={exe} {flag}\n\
         # no window: the app exits as soon as the package is written\n",
        exe = exe_path,
        flag = BACKUP_ONCE_FLAG
    );
    let timer = format!(
        "[Unit]\n\
         Description=ShuyoNote automatic backup (daily)\n\n\
         [Timer]\n\
         OnBootSec=5min\n\
         OnUnitActiveSec={interval}\n\
         Persistent=true\n\
         Unit={unit}.service\n\n\
         [Install]\n\
         WantedBy=timers.target\n",
        interval = interval,
        unit = SYSTEMD_UNIT
    );
    (service, timer)
}

/// 两个单元的**文件名**（⭐ 与 systemd 约定一致 ✓）
pub fn systemd_unit_files() -> (String, String) {
    (
        format!("{SYSTEMD_UNIT}.service"),
        format!("{SYSTEMD_UNIT}.timer"),
    )
}

#[cfg(test)]
mod p3_tests {
    use super::*;

    #[test]
    fn cli_mode_recognises_backup_once_at_any_position() {
        assert_eq!(cli_mode([BACKUP_ONCE_FLAG]), CliMode::BackupOnce);
        assert_eq!(
            cli_mode(["shuyonote.exe", BACKUP_ONCE_FLAG]),
            CliMode::BackupOnce
        );
        assert_eq!(
            cli_mode(["shuyonote.exe", "--other", BACKUP_ONCE_FLAG, "x"]),
            CliMode::BackupOnce,
            "⭐ 位置任意都要认（⭐ 平台传参方式不同 ✓）"
        );
    }

    #[test]
    fn cli_mode_defaults_to_normal_and_never_swallows_unknown() {
        assert_eq!(cli_mode(Vec::<String>::new()), CliMode::Normal);
        assert_eq!(cli_mode(["shuyonote.exe"]), CliMode::Normal);
        assert_eq!(
            cli_mode(["--help"]),
            CliMode::Normal,
            "⭐ 不认识的参数必须照旧正常启动（⛔ 不能因此不建窗口 ✗）"
        );
    }

    #[test]
    fn systemd_service_runs_headless_once() {
        let (svc, _) = systemd_units("/opt/shuyonote/shuyonote", DEFAULT_INTERVAL_SECS);
        assert!(svc.contains("Type=oneshot"), "⭐ 跑完就退 ✓：{svc}");
        assert!(
            svc.contains(&format!("ExecStart=/opt/shuyonote/shuyonote {BACKUP_ONCE_FLAG}")),
            "⭐ 无头入口必须是 `--backup-once` ✓：{svc}"
        );
        assert!(
            !svc.contains("[Install]"),
            "⭐ service 不该带 [Install]（⭐ 由 timer 拉起 ✓）"
        );
    }

    #[test]
    fn systemd_timer_is_daily_and_catches_up() {
        let (_, timer) = systemd_units("/opt/shuyonote/shuyonote", DEFAULT_INTERVAL_SECS);
        assert!(timer.contains("OnUnitActiveSec=86400s"), "⭐ 每天一次 ✓：{timer}");
        assert!(timer.contains("Persistent=true"), "⭐ 关机错过要补 ✓：{timer}");
        assert!(timer.contains("Unit=shuyonote-backup.service"), "⭐ 拉起哪个 unit ✓");
        assert!(timer.contains("WantedBy=timers.target"), "⭐ 装到哪一档 ✓");
    }

    #[test]
    fn systemd_unit_files_have_conventional_names() {
        let (svc, tmr) = systemd_unit_files();
        assert_eq!(svc, "shuyonote-backup.service");
        assert_eq!(tmr, "shuyonote-backup.timer");
    }

    #[test]
    fn systemd_interval_has_a_floor() {
        let (_, t) = systemd_units("/x", 1);
        assert!(
            t.contains("OnUnitActiveSec=60s"),
            "⭐ 给个下限（⭐ 免得有人填 1 秒把盘写满 ✗）：{t}"
        );
    }
}
