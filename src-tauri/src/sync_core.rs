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

/// 调度器是否在跑（默认 false；`start_if_enabled` 真的起了任务才 true）。
static RUNNING: AtomicBool = AtomicBool::new(false);
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
#[derive(Debug, Clone, serde::Serialize)]
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
    if !enabled_from_env() {
        eprintln!(
            "[sync-core] 未启用（{ENV_SYNC_CORE} 不是 1/true/on）⇒ 不启动调度器（默认行为不变）"
        );
        return;
    }
    if RUNNING.swap(true, Ordering::SeqCst) {
        return; // 已经起过
    }
    eprintln!(
        "[sync-core] 已启用：有变化 {BASE_INTERVAL_MS}ms / 空转退避上限 {EMPTY_BACKOFF_MS}ms"
    );
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut empty_streak: u32 = 0;
        loop {
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
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            } else {
                tokio::time::sleep(std::time::Duration::from_millis(next_delay_ms(
                    empty_streak,
                    false,
                )))
                .await;
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
}
