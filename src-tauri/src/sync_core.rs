//! ⭐ **P3-1a 第三刀（task-55）**：Rust `sync_core` 调度器 —— **默认关闭**，仅 env 显式开启。
//!
//! ## 边界（本笔只做"能跑的调度器"，不改默认行为）
//! · **默认不启动**：`SHUYONOTE_SYNC_CORE` 不是 `1`/`true`/`on`（大小写不敏感、trim）⇒
//!   [`start_if_enabled`] **立刻返回**：不起任务、不起定时器、不发事件、不碰 DB；
//! · 前端 App 现有的定时器/闸门/退避**一个字不改**（本笔不碰 App.tsx/契约）；
//! · 每轮只调 [`crate::sync::sync_core_round_inner`]（与前端 `sync_core_round` 命令**同一实现**）；
//!   失败只日志、**继续**下一轮；每轮结束 emit `sync-core-round`（只计数、脱敏）。
//!
//! ## 调度公式（纯函数，判据够得着）
//! · 本轮**有变化**（server `pulled > 0`，或网格对端 `fetched/applied > 0` —— 与前端
//!   `roundWasEmpty` 同一把尺）⇒ 下一跳 = [`BASE_INTERVAL_MS`]（5s）；
//! · 本轮**空转/失败** ⇒ 指数退避：`5s × 2^empty_streak`，**上限** [`EMPTY_BACKOFF_MS`]（60s）。
//!   （空转第 1 次 10s、2 次 20s、3 次 40s、≥4 次 60s。）
//! · 暂停/关闭 ⇒ 不跑（[`should_run`]；暂停开关本笔未接，纯函数留给后续）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{Emitter, Manager};

use crate::sync::{sync_core_round_inner, SyncCoreRoundReport};

/// 有变化时的下一跳（5 秒）。
pub const BASE_INTERVAL_MS: u64 = 5_000;
/// 空转退避上限（60 秒）。
pub const EMPTY_BACKOFF_MS: u64 = 60_000;

/// ⭐ **P3-1a 第六刀（task-68）**：网络闸门拒绝后的下一跳（固定 60s；**不**增加 empty_streak）。
pub const GATE_BACKOFF_MS: u64 = 60_000;
/// 闸门拒绝日志限频（每分钟最多一行）。
pub const GATE_LOG_INTERVAL_MS: u64 = 60_000;
/// 上次打"被闸门挡下"日志的时刻（Unix ms；0＝从未）。
static LAST_GATE_LOG_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// ⭐ **纯函数**：C2 网络闸门（与 `src/lib/syncGate.ts` **逐条同口径**）：
/// * `wifi_only=false` ⇒ 放行（用户明确允许非 Wi-Fi）；
/// * `kind == "n/a"` ⇒ 放行（桌面端闸门不适用；⛔ 不能当 unknown 拦掉）；
/// * `kind == "wifi" | "ethernet"` ⇒ 放行；
/// * 其余（含 `unknown`/`cellular`/空）⇒ **拒绝**（fail-safe：宁可少跑，不偷跑流量）。
/// ⚠️ 与 JS 一样**只认小写字面量**（Android 契约返回值；⛔ 不做大小写兜底，否则两端会漂）。
pub fn auto_sync_gate(wifi_only: bool, kind: &str) -> bool {
    if !wifi_only {
        return true;
    }
    let kind = kind.trim();
    kind == "n/a" || kind == "wifi" || kind == "ethernet"
}

/// ⭐ 纯函数：闸门拒绝日志限频（距上次 ≥60s 才打；`last=0`＝第一次）。
pub fn should_log_gate(now_ms: u64, last_ms: u64) -> bool {
    last_ms == 0 || now_ms.saturating_sub(last_ms) >= GATE_LOG_INTERVAL_MS
}

/// 当前 Unix ms（限频/日志用）。
fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 调度器是否在跑（默认 false；`start_if_enabled` 真的起了任务才 true）。
static RUNNING: AtomicBool = AtomicBool::new(false);
/// ⭐ **P3-1a 第五刀（task-58）**：**runtime 开关**（命令面 `sync_core_set_enabled` 控；默认 false）。
static RUNTIME_ENABLED: AtomicBool = AtomicBool::new(false);
/// 关掉时唤醒睡眠中的调度循环 ⇒ **下一轮立刻不跑**（当前轮可跑完）。
static WAKE: std::sync::OnceLock<tokio::sync::Notify> = std::sync::OnceLock::new();

fn wake() -> &'static tokio::sync::Notify {
    WAKE.get_or_init(tokio::sync::Notify::new)
}
/// 最近一轮的脱敏汇总（给调试/判据读；不落盘、不含正文）。
static LAST_ROUND: Mutex<Option<SyncCoreRoundEvent>> = Mutex::new(None);

/// 环境变量名（唯一出处）。
pub const ENV_SYNC_CORE: &str = "SHUYONOTE_SYNC_CORE";

/// ⭐ 纯函数：env 值算不算"开启"（`1`/`true`/`on`，trim ＋ 大小写不敏感；缺省/其它 ⇒ false）。
pub fn enabled_from_env_value(value: Option<&str>) -> bool {
    let Some(v) = value else { return false };
    matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "on")
}

/// 读进程环境变量（唯一读点）。
pub fn enabled_from_env() -> bool {
    enabled_from_env_value(std::env::var(ENV_SYNC_CORE).ok().as_deref())
}

/// ⭐ runtime 开关（默认 false；命令面设置）。
pub fn runtime_enabled() -> bool {
    RUNTIME_ENABLED.load(Ordering::SeqCst)
}

/// ⭐ **有效开关**：`env OR runtime`（env=1 仍强制开启；runtime 是桌面 App 默认走的那条）。
pub fn enabled_now() -> bool {
    enabled_from_env() || runtime_enabled()
}

/// ⭐ **P3-1a 第五刀（task-58）**：runtime 开关（命令体唯一入口）——设置后立即返回状态快照。
///
/// * `enabled=true`：置位；**任务没起就懒启动一次**（已跑 ⇒ 不重复起）；
/// * `enabled=false`：清位 ＋ **唤醒睡眠**（下一轮检查到关闭就退出循环，当前轮可跑完）。
pub fn set_runtime_enabled(app: &tauri::AppHandle, enabled: bool) -> SyncCoreStatus {
    RUNTIME_ENABLED.store(enabled, Ordering::SeqCst);
    if enabled {
        start_loop(app.clone());
    } else {
        wake().notify_waiters();
    }
    snapshot()
}

/// ⭐ 纯函数：本轮到底要不要跑（关闭/暂停 ⇒ 不跑）。
pub fn should_run(enabled: bool, paused: bool) -> bool {
    enabled && !paused
}

/// ⭐ **纯函数**：下一跳延迟（毫秒）。
///
/// 有变化 ⇒ [`BASE_INTERVAL_MS`]；空转/失败 ⇒ `BASE × 2^streak`，夹到 [`EMPTY_BACKOFF_MS`]。
pub fn next_delay_ms(empty_streak: u32, last_had_changes: bool) -> u64 {
    if last_had_changes {
        return BASE_INTERVAL_MS;
    }
    let exp = empty_streak.min(16); // 防移位溢出（16 次早就顶到上限了）
    BASE_INTERVAL_MS
        .saturating_mul(1u64 << exp)
        .min(EMPTY_BACKOFF_MS)
}

/// ⭐ **纯函数**：本轮有没有"真的换到东西"（与前端 `roundWasEmpty` 同一把尺：只看拉/收）。
pub fn round_had_changes(report: &SyncCoreRoundReport) -> bool {
    if report.server.iter().any(|r| r.pulled > 0) {
        return true;
    }
    report.mesh.spaces.iter().any(|s| {
        s.report
            .as_ref()
            .map(|r| r.peers.iter().any(|p| p.fetched > 0 || p.applied > 0))
            .unwrap_or(false)
    })
}

/// 发给前端的**每轮事件**（`sync-core-round`；脱敏：只有计数，无空间名/hash/路径/正文）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCoreRoundEvent {
    pub server_spaces: usize,
    pub server_errors: usize,
    pub mesh_spaces: usize,
    pub mesh_ok: usize,
    pub mesh_failed: usize,
    pub mesh_applied: usize,
    pub had_changes: bool,
    /// 到本轮为止连续空转的次数（有变化 ⇒ 0）。
    pub empty_streak: u32,
    /// 算出来的下一跳（毫秒）—— 与定时器实际 sleep 用的是同一个数。
    pub next_delay_ms: u64,
}

/// ⭐ **P3-1a 第四刀（task-57）**：`sync_core_status` 的返回（**只读、脱敏**：只有计数）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCoreStatus {
    /// **有效**开关（`env OR runtime`；默认 false）。
    pub enabled: bool,
    /// ⭐ task-58：runtime 开关（命令面；默认 false）。
    pub runtime_enabled: bool,
    /// 调度任务是否真的在跑（默认 false）。
    pub running: bool,
    /// 最近一轮的脱敏汇总（没有 ⇒ null）。
    pub last_round: Option<SyncCoreRoundEvent>,
}

/// ⭐ 纯函数：读一次状态快照（命令只委托它，判据够得着）。
pub fn snapshot() -> SyncCoreStatus {
    SyncCoreStatus {
        enabled: enabled_now(),
        runtime_enabled: runtime_enabled(),
        running: running(),
        last_round: last_round(),
    }
}

/// ⭐ **P3-1a 第四刀（task-57）**：只读状态命令（**不新增任何写操作**）。
#[tauri::command]
pub fn sync_core_status() -> SyncCoreStatus {
    snapshot()
}

/// ⭐ **P3-1a 第五刀（task-58）**：runtime 开关（桌面 App 默认用它按闸门启停 Core；
/// 移动端/闸门拒绝时 App 会把它关掉并回退前端定时器）。**不新增任何写库操作**。
#[tauri::command]
pub fn sync_core_set_enabled(app: tauri::AppHandle, enabled: bool) -> SyncCoreStatus {
    set_runtime_enabled(&app, enabled)
}

/// ⭐ 纯函数：汇总 → 事件载荷（脱敏）。
pub fn round_event(report: &SyncCoreRoundReport, empty_streak: u32) -> SyncCoreRoundEvent {
    let had_changes = round_had_changes(report);
    let streak = if had_changes { 0 } else { empty_streak };
    SyncCoreRoundEvent {
        server_spaces: report.server.len(),
        server_errors: report.server.iter().filter(|r| r.error.is_some()).count(),
        mesh_spaces: report.mesh.spaces.len(),
        mesh_ok: report.mesh.ok,
        mesh_failed: report.mesh.failed,
        mesh_applied: report.mesh.applied,
        had_changes,
        empty_streak: streak,
        next_delay_ms: next_delay_ms(streak, had_changes),
    }
}

/// 调度器是否在跑（判据/调试用）。
pub fn running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

/// 最近一轮的脱敏汇总（没有 ⇒ None）。
pub fn last_round() -> Option<SyncCoreRoundEvent> {
    LAST_ROUND.lock().map(|g| g.clone()).unwrap_or_default()
}

/// ⭐ **入口（默认关闭）**：env 开启时才起一个 tokio 循环。
///
/// ⚠️ **默认行为零变化**：env 缺省 ⇒ 第一行就返回（不起任务、不碰 app/DB、不发事件）。
pub fn start_if_enabled(app: &tauri::AppHandle) {
    if !enabled_now() {
        eprintln!(
            "[sync-core] 未启用（{ENV_SYNC_CORE} 不是 1/true/on 且 runtime 未开）⇒ 不启动调度器（默认行为不变）"
        );
        return;
    }
    start_loop(app.clone());
}

/// ⭐ **懒启动的唯一实现**：`RUNNING.swap` 保证**不重复起**任务；循环第一件事检查有效开关，
/// 被关掉就退出（`sync_core_set_enabled(false)` 还会 `wake()` 把它从睡眠里叫醒）。
fn start_loop(app: tauri::AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return; // 已经起过
    }
    eprintln!(
        "[sync-core] 已启用：有变化 {BASE_INTERVAL_MS}ms / 空转退避上限 {EMPTY_BACKOFF_MS}ms"
    );
    tauri::async_runtime::spawn(async move {
        let mut empty_streak: u32 = 0;
        loop {
            // ⭐ task-58：被 runtime 关掉 ⇒ **下一轮立刻不跑**并退出循环（当前轮已跑完）。
            if !enabled_now() {
                RUNNING.store(false, Ordering::SeqCst);
                eprintln!("[sync-core] 已关闭（runtime/env 都关）⇒ 调度循环退出（当前轮已跑完）");
                break;
            }
            // ⭐ **task-68**：**先过 C2 网络闸门，再跑 round**（前端闸门保留兜底；本处是 Core 自己的闸）。
            //   · `wifi_only` 读设备级预算（读不到 DB/锁坏 ⇒ 按 JS 口径**放行**）：`read_budget` 缺键回默认；
            //   · `network_type` 复用既有命令实现（桌面 = `n/a` ⇒ 放行；Android 才可能 cellular/unknown）；
            //   · 拒绝 ⇒ **不跑 round**、**不增加 empty_streak**、下一跳固定 60s、日志限频 1/分钟。
            let wifi_only = match app.try_state::<crate::db::Db>() {
                Some(db) => {
                    db.0.lock()
                        .map(|c| crate::sync::read_budget(&c).wifi_only)
                        .unwrap_or(false)
                }
                None => false,
            };
            let kind =
                crate::net::network_type(app.clone()).unwrap_or_else(|_| "unknown".to_string());
            if !auto_sync_gate(wifi_only, &kind) {
                let now = now_unix_ms();
                let last = LAST_GATE_LOG_MS.load(Ordering::SeqCst);
                if should_log_gate(now, last) {
                    LAST_GATE_LOG_MS.store(now, Ordering::SeqCst);
                    eprintln!(
                        "[sync-core] 网络闸门拒绝：wifi_only=true / network_type={kind} ⇒ 这一轮不跑（{GATE_BACKOFF_MS}ms 后再看；不增加空转计数）"
                    );
                }
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_millis(GATE_BACKOFF_MS)) => {}
                    _ = wake().notified() => {}
                }
                continue;
            }
            let result = match app.try_state::<crate::db::Db>() {
                Some(db) => sync_core_round_inner(&app, &db).await,
                None => Err("Db 还没托管（这一轮跳过）".to_string()),
            };
            let event = match result {
                Ok(report) => {
                    let ev = round_event(&report, empty_streak.saturating_add(1));
                    empty_streak = ev.empty_streak;
                    Some(ev)
                }
                Err(e) => {
                    // 失败只日志、**继续**下一轮（⛔ 不退出循环）。
                    eprintln!("[sync-core] 这一轮失败（下一跳再试）：{e}");
                    empty_streak = empty_streak.saturating_add(1);
                    None
                }
            };
            if let Some(ev) = event {
                let delay = ev.next_delay_ms;
                if let Ok(mut g) = LAST_ROUND.lock() {
                    *g = Some(ev.clone());
                }
                // 事件失败只记日志（前端本笔还不消费）。
                if let Err(e) = app.emit("sync-core-round", &ev) {
                    eprintln!("[sync-core] emit sync-core-round 失败（不影响下一轮）：{e}");
                }
                // 关闭时会 `wake()` ⇒ 不用等满退避就能退出（下一轮顶部检查开关）。
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_millis(delay)) => {}
                    _ = wake().notified() => {}
                }
            } else {
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_millis(next_delay_ms(
                        empty_streak,
                        false,
                    ))) => {}
                    _ = wake().notified() => {}
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::MeshSyncAllReport;

    fn empty_mesh() -> MeshSyncAllReport {
        MeshSyncAllReport {
            spaces: Vec::new(),
            total: 0,
            ok: 0,
            failed: 0,
            applied: 0,
            candidates: 0,
        }
    }

    fn report_with(
        server: Vec<crate::sync::WorkspaceSyncResult>,
        mesh: MeshSyncAllReport,
    ) -> SyncCoreRoundReport {
        SyncCoreRoundReport { server, mesh }
    }

    fn server_row(pulled: usize) -> crate::sync::WorkspaceSyncResult {
        crate::sync::WorkspaceSyncResult {
            ws_id: "ws-a".to_string(),
            pushed: 0,
            pulled,
            last_pushed_seq: 0,
            last_pulled_seq: 0,
            error: None,
            conflicts: Vec::new(),
            block_conflict_pages: 0,
            pending_remote_pages: 0,
            attachments_paused: false,
            attachments_skipped_upload: 0,
            attachments_skipped_download: 0,
            attachments_paused_reason: String::new(),
            attachments_skipped_too_large: 0,
            attachments_failed: 0,
            attachments_bytes_downloaded: 0,
        }
    }

    #[test]
    fn env_is_off_unless_exactly_1_true_on() {
        for off in [
            None,
            Some(""),
            Some("0"),
            Some("false"),
            Some("no"),
            Some("off"),
            Some("  "),
        ] {
            assert!(
                !enabled_from_env_value(off),
                "{off:?} 不许算开启（默认关闭）"
            );
        }
        for on in ["1", "true", "TRUE", "on", " On ", "  1  "] {
            assert!(enabled_from_env_value(Some(on)), "{on:?} 应当算开启");
        }
        // 默认关闭：**不看环境**的纯函数 `should_run(enabled=false, ..)` 一定不跑。
        assert!(!should_run(false, false));
        assert!(!should_run(true, true), "暂停 ⇒ 不跑");
        assert!(should_run(true, false));
    }

    #[test]
    fn delay_is_5s_with_changes_and_backs_off_to_60s_when_empty() {
        assert_eq!(next_delay_ms(0, true), BASE_INTERVAL_MS, "有变化 ⇒ 5s");
        assert_eq!(
            next_delay_ms(99, true),
            BASE_INTERVAL_MS,
            "有变化 ⇒ 不受空转计数影响"
        );
        // 空转：10s → 20s → 40s → 60s 封顶。
        assert_eq!(next_delay_ms(1, false), 10_000);
        assert_eq!(next_delay_ms(2, false), 20_000);
        assert_eq!(next_delay_ms(3, false), 40_000);
        assert_eq!(next_delay_ms(4, false), EMPTY_BACKOFF_MS);
        assert_eq!(
            next_delay_ms(99, false),
            EMPTY_BACKOFF_MS,
            "永远不超 60s 上限"
        );
    }

    #[test]
    fn only_pulled_or_mesh_fetched_counts_as_changes() {
        // 空报告 ⇒ 没变化。
        assert!(!round_had_changes(&report_with(Vec::new(), empty_mesh())));
        // 服务端：pulled > 0 ⇒ 有变化（pushed-only 与前端 `roundWasEmpty` 同尺：不算）。
        assert!(round_had_changes(&report_with(
            vec![server_row(1)],
            empty_mesh()
        )));
        assert!(!round_had_changes(&report_with(
            vec![server_row(0)],
            empty_mesh()
        )));
        // 网格：对端 fetched/applied > 0 ⇒ 有变化（这里用空 mesh 证明不加戏）。
        assert!(!round_had_changes(&report_with(
            Vec::new(),
            MeshSyncAllReport {
                spaces: Vec::new(),
                total: 1,
                ok: 0,
                failed: 1,
                applied: 0,
                candidates: 0,
            }
        )));
    }

    #[test]
    fn event_is_sanitized_and_carries_next_delay() {
        let ev = round_event(&report_with(vec![server_row(2)], empty_mesh()), 7);
        assert!(ev.had_changes);
        assert_eq!(ev.empty_streak, 0, "有变化 ⇒ 空转清零");
        assert_eq!(ev.next_delay_ms, BASE_INTERVAL_MS);
        assert_eq!(ev.server_spaces, 1);
        assert_eq!(ev.server_errors, 0);
        let json = serde_json::to_string(&ev).unwrap();
        for forbidden in ["ws-a", "hash", "content", "path"] {
            assert!(
                !json.contains(forbidden),
                "事件必须脱敏，不许含 {forbidden}：{json}"
            );
        }

        let empty = round_event(&report_with(Vec::new(), empty_mesh()), 3);
        assert!(!empty.had_changes);
        assert_eq!(empty.empty_streak, 3);
        assert_eq!(empty.next_delay_ms, 40_000);
    }

    /// 源码级默认关闭：setup 只在 env 开启时启动；`start_if_enabled` 第一段就是"不启用就返回"。
    #[test]
    fn the_scheduler_is_off_by_default_and_wired_only_through_the_env_gate() {
        let src = include_str!("sync_core.rs");
        let lib = include_str!("lib.rs");
        assert!(
            lib.contains("sync_core::start_if_enabled(app.handle())"),
            "lib.rs setup 必须调用 `start_if_enabled`（它自己按 env 自门控）"
        );
        assert!(
            src.contains("if !enabled_from_env() {") && src.contains("不启动调度器"),
            "默认关闭：env 缺省必须在第一段就返回"
        );
        assert!(
            src.contains("if RUNNING.swap(true, Ordering::SeqCst)"),
            "重复启动要幂等（不重复起任务）"
        );
        // ⛔ 不许在别处无条件 spawn 调度器（默认行为零变化）。
        assert!(
            !lib.contains("async_runtime::spawn(async move {\n            let mut empty_streak"),
            "⛔ 不许在 lib.rs 里另起一份调度循环"
        );
    }

    /// 全局 runtime 开关是进程级的 ⇒ 会改它的判据必须串行（并行会让 status 判据偶发红）。
    static RUNTIME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn status_shape_is_sanitized_and_defaults_to_not_running() {
        let _g = RUNTIME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let st = snapshot();
        // `enabled` = env OR runtime（判据不依赖外部 env 的具体值，只要求与纯函数一致）。
        assert_eq!(st.enabled, enabled_from_env() || runtime_enabled());
        assert_eq!(st.runtime_enabled, runtime_enabled());
        // 测试进程里没启动调度器 ⇒ running=false（默认关闭的又一条读数）。
        assert!(!st.running, "测试进程没有启动调度器 ⇒ running 必须 false");
        assert!(
            st.last_round.is_none(),
            "没跑过 ⇒ lastRound=null（⛔ 不编造）"
        );
        let json = serde_json::to_string(&st).unwrap();
        for key in [
            "\"enabled\":",
            "\"runtimeEnabled\":",
            "\"running\":",
            "\"lastRound\":null",
        ] {
            assert!(json.contains(key), "status 字段形状：{json}");
        }
        // 脱敏：状态里不许出现空间名/正文/路径/hash 一类内容。
        for forbidden in ["content", "path", "/Users/", ".db", "hash"] {
            assert!(
                !json.contains(forbidden),
                "status 必须脱敏，不许含 {forbidden}：{json}"
            );
        }
    }

    #[test]
    fn last_round_event_can_be_reported_without_leaking_ids() {
        let _g = RUNTIME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // 直接构造事件（与调度器写入 LAST_ROUND 的形状相同）。
        let ev = round_event(
            &SyncCoreRoundReport {
                server: Vec::new(),
                mesh: MeshSyncAllReport {
                    spaces: Vec::new(),
                    total: 0,
                    ok: 0,
                    failed: 0,
                    applied: 0,
                    candidates: 0,
                },
            },
            2,
        );
        let mut st = snapshot();
        st.last_round = Some(ev);
        let json = serde_json::to_string(&st).unwrap();
        assert!(json.contains("\"lastRound\":{"), "{json}");
        assert!(json.contains("\"emptyStreak\":2"), "{json}");
        for forbidden in ["ws-", "spaceId", "pageId", "content", "path"] {
            assert!(!json.contains(forbidden), "lastRound 必须脱敏：{json}");
        }
    }

    /// 源码级：命令已注册、只委托 `snapshot`，且**没有任何写操作**。
    #[test]
    fn the_status_command_is_registered_read_only_and_delegates_to_snapshot() {
        let src = include_str!("sync_core.rs");
        let lib = include_str!("lib.rs");
        assert!(
            lib.contains("sync_core::sync_core_status,"),
            "`sync_core_status` 必须注册进 generate_handler!"
        );
        let cmd = src
            .split("pub fn sync_core_status(")
            .nth(1)
            .expect("sync_core_status 必须在");
        let body = &cmd[..cmd.find("\n}").unwrap_or(cmd.len())];
        assert!(body.contains("snapshot()"), "命令只委托 snapshot()");
        for forbidden in ["set_meta_state", "write", "remove_file", "save", "delete"] {
            assert!(
                !body.contains(forbidden),
                "状态命令必须是只读：不许 {forbidden}"
            );
        }
    }

    #[test]
    fn runtime_toggle_is_idempotent_and_reflected_in_status() {
        let _g = RUNTIME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let before = runtime_enabled();
        // 默认 false（进程里从没开过）。
        if !enabled_from_env() {
            assert!(
                !runtime_enabled(),
                "默认 runtime=false（Core 由 env 或 App 显式开）"
            );
        }
        // 开 ⇒ status 立刻反映（enabled 是 env OR runtime；runtimeEnabled 是原值）。
        RUNTIME_ENABLED.store(true, Ordering::SeqCst);
        let on = snapshot();
        assert!(on.runtime_enabled);
        assert!(on.enabled);
        // 幂等：再置一次还是 true，不炸。
        RUNTIME_ENABLED.store(true, Ordering::SeqCst);
        assert!(runtime_enabled());
        // 关 ⇒ 下一轮不跑（有效开关在 env 也关时变 false）。
        RUNTIME_ENABLED.store(false, Ordering::SeqCst);
        assert!(!runtime_enabled());
        assert_eq!(snapshot().enabled, enabled_from_env());
        RUNTIME_ENABLED.store(before, Ordering::SeqCst);
    }

    /// 源码级：命令已注册、开关走同一个 runtime 位、true 时**懒启动且不重复起**、false 时唤醒退出。
    #[test]
    fn runtime_enable_command_lazily_starts_and_disable_wakes_the_loop() {
        let src = include_str!("sync_core.rs");
        let lib = include_str!("lib.rs");
        assert!(
            lib.contains("sync_core::sync_core_set_enabled,"),
            "`sync_core_set_enabled` 必须注册进 generate_handler!"
        );
        // 有效开关 = env OR runtime（默认关闭仍成立）。
        assert!(
            src.contains("enabled_from_env() || runtime_enabled()"),
            "有效开关必须是 env OR runtime"
        );
        // true ⇒ 懒启动（唯一实现 start_loop，RUNNING.swap 防重复）。
        assert!(src.contains("pub fn set_runtime_enabled("));
        assert!(src.contains("start_loop(app.clone())"));
        assert!(src.contains("if RUNNING.swap(true, Ordering::SeqCst)"));
        // false ⇒ 唤醒；循环顶部检查开关并退出（当前轮可跑完）。
        assert!(src.contains("wake().notify_waiters()"));
        assert!(src.contains("if !enabled_now() {"));
        assert!(src.contains("调度循环退出"));
        // 命令体只调 set_runtime_enabled（⛔ 不另写一份启动/停止逻辑）。
        let cmd = src
            .split("pub fn sync_core_set_enabled(")
            .nth(1)
            .expect("sync_core_set_enabled 必须在");
        let body = &cmd[..cmd.find("\n}").unwrap_or(cmd.len())];
        assert!(body.contains("set_runtime_enabled(&app, enabled)"));
        // ⛔ 不写库/不动 sync_state。
        for forbidden in ["set_meta_state", "write", "save", "delete"] {
            assert!(!body.contains(forbidden), "开关命令不许写数据：{forbidden}");
        }
    }

    // ── ⭐ task-68：C2 网络闸门（wifi_only ＋ network_type）────────────────────

    #[test]
    fn auto_sync_gate_matches_the_frontend_matrix() {
        // wifi_only 关 ⇒ 任何类型都放行（用户明确允许非 Wi-Fi）。
        for kind in ["n/a", "wifi", "ethernet", "cellular", "unknown", ""] {
            assert!(
                auto_sync_gate(false, kind),
                "wifi_only=false 必须放行：{kind}"
            );
        }
        // wifi_only 开：n/a（桌面不适用）/ wifi / ethernet ⇒ 放行。
        for kind in ["n/a", "wifi", "ethernet", " wifi ", "ethernet "] {
            assert!(auto_sync_gate(true, kind), "应放行：{kind:?}");
        }
        // 其余（含 unknown/空）⇒ 拒绝（fail-safe：不偷跑流量）。
        for kind in ["cellular", "unknown", "", "5g", "WIFI", "Ethernet"] {
            assert!(!auto_sync_gate(true, kind), "必须拒绝：{kind:?}");
        }
    }

    #[test]
    fn gate_rejection_log_is_rate_limited_to_once_a_minute() {
        assert!(should_log_gate(1_000, 0), "第一次一定打");
        assert!(!should_log_gate(1_000 + GATE_LOG_INTERVAL_MS - 1, 1_000));
        assert!(should_log_gate(1_000 + GATE_LOG_INTERVAL_MS, 1_000));
        assert!(should_log_gate(61_000, 1_000), "距离 ≥60s 也打");
        assert!(!should_log_gate(1_000, 1_000), "同一毫秒不重复打");
    }

    /// 源码级：循环里**先闸门后 round**；拒绝分支 `continue` 前不碰 `empty_streak`、退避固定 60s。
    #[test]
    fn the_loop_checks_the_network_gate_before_starting_a_round() {
        let src = include_str!("sync_core.rs");
        let prod = src.split("#[cfg(test)]").next().unwrap_or(src);
        let loop_at = prod.find("fn start_loop(").expect("start_loop 必须在");
        let loop_src = &prod[loop_at..];
        let gate_at = loop_src
            .find("if !auto_sync_gate(wifi_only, &kind)")
            .expect("循环必须先评估网络闸门");
        let round_at = loop_src
            .find("sync_core_round_inner(&app, &db)")
            .expect("循环必须在闸门之后才跑 round");
        assert!(gate_at < round_at, "⛔ 必须先闸门、后 round");
        // 读预算/网络类型的路径（不依赖前端）；读不到预算 ⇒ 放行（与 JS 口径一致）。
        assert!(loop_src.contains("crate::sync::read_budget(&c)"));
        assert!(loop_src.contains("crate::net::network_type("));
        assert!(
            loop_src.contains("unwrap_or(false)"),
            "读不到预算/锁坏 ⇒ 放行"
        );
        // 拒绝分支：不跑 round、退避 60s、日志限频、不增加空转计数。
        let blocked = &loop_src[gate_at..round_at];
        assert!(blocked.contains("GATE_BACKOFF_MS"), "拒绝后必须 60s 退避");
        assert!(blocked.contains("should_log_gate"), "日志必须限频");
        assert!(
            blocked.contains("continue"),
            "拒绝后必须 continue（不跑 round）"
        );
        assert!(
            !blocked.contains("empty_streak"),
            "⛔ 闸门拒绝不许增加 empty_streak（不是空转）"
        );
        // 拒绝日志只说原因码/类型，不打 token/正文（这里没有这些变量）。
        assert!(!blocked.contains("token"));
    }
}
