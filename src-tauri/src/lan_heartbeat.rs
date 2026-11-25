// §13.2 S1「连接监督器」—— **心跳策略纯函数（部分已接线）**。
//
// ⚠️ **2026-11-25 核实并写准**：本行原先笼统写「⛔ 未接线」，但实际是**一半接了**：
//   · ✅ 已接线（诊断/补救两格）：`loop_gap_ms` / `is_wake_gap` 在 `lan_state` 的 1s 循环里被调用
//     （打 `[loop-gap] gap_ms=…`）；`wake_resync_enabled_from` 被 `SHUYONOTE_LAN_WAKE_RESYNC` 门控使用
//     （唤醒后立即补一轮，默认关）。
//   · ⛔ **未接线（策略四格）**：`tier_for` / `heartbeat_interval_ms` / `probe_due` / `backoff_after_fail`
//     —— 全仓**零生产调用点**（2026-11-25 `grep` 实测）。它们要动"多久探一次/失败怎么退避"，
//     属**用户可见行为**（流量与耗电），按仓规需 **owner 拍板**才接；接线必须只在该 env 下生效。
// 口径（可核）：
// · Active（前台 / 插电 / 最近活动）⇒ 10s；Idle ⇒ 60s（与 F3 的 60s 空闲退避同量级）；
// · 探测到点：还没探过 ⇒ 立即；时钟回拨 ⇒ 不探（⛔ 不出负差/风暴）；
// · 失败退避：10s 起、逐次翻倍、300s 封顶（⛔ 不回绕、不无限增长）。

/// 心跳档位。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Active,
    Idle,
}

/// 前台 / 插电 / 最近活动，任一成立 ⇒ Active；否则 Idle。
pub fn tier_for(foreground: bool, on_ac: bool, recent_activity: bool) -> Tier {
    if foreground || on_ac || recent_activity {
        Tier::Active
    } else {
        Tier::Idle
    }
}

/// 这一档的心跳间隔（毫秒）。
pub fn heartbeat_interval_ms(tier: Tier) -> i64 {
    match tier {
        Tier::Active => 10_000,
        Tier::Idle => 60_000,
    }
}

/// 是否到点探测：没探过（`last<=0`）⇒ 是；时钟回拨 ⇒ 否。
pub fn probe_due(last_probe_ms: i64, now_ms: i64, interval_ms: i64) -> bool {
    if last_probe_ms <= 0 {
        return true;
    }
    if now_ms < last_probe_ms {
        return false;
    }
    now_ms.saturating_sub(last_probe_ms) >= interval_ms.max(0)
}

/// 连续失败后的下次探测间隔：10s 起、翻倍、300s 封顶。
pub fn backoff_after_fail(fails: u32) -> i64 {
    let ms = 10_000i64.saturating_mul(1i64 << fails.min(5));
    ms.min(300_000)
}

/// 两次循环 tick 的间隔（毫秒）：时钟回拨/首次 ⇒ 0（⛔ 不出负数，避免假 wake）。
pub fn loop_gap_ms(last_tick_ms: i64, now_ms: i64) -> i64 {
    if last_tick_ms <= 0 || now_ms < last_tick_ms {
        0
    } else {
        now_ms - last_tick_ms
    }
}

/// 是否算“睡醒/长暂停”：间隔 ≥ 阈值（默认 5s；1s 切片远小于它）。
pub fn is_wake_gap(gap_ms: i64, threshold_ms: i64) -> bool {
    gap_ms >= threshold_ms.max(0)
}

/// 唤醒后立即补一轮的开关：只有显式 `1/true/on` 才开（默认关）。
pub fn wake_resync_enabled_from(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true") | Some("on")
    )
}

/// ⭐ **S1 接线（2026-11-25）**：心跳策略的开关（默认关）。
pub fn heartbeat_enabled_from(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true") | Some("on")
    )
}

/// 「最近有本地活动」的窗口：2 分钟（窗口内算 Active ⇒ 10s；超过 ⇒ Idle ⇒ 60s）。
pub const ACTIVE_WINDOW_MS: i64 = 120_000;

/// 纯函数：`last_ms` 这一刻的活动是否还在窗口内。
///
/// * `last_ms <= 0`（从没保存过）⇒ false；
/// * 时钟回拨（`now < last`）⇒ **false**（⛔ 不把"时间倒流"读成"刚刚活动"）；
/// * 边界：恰好等于窗口 ⇒ false（窗口是**左闭右开**，与 `probe_due` 的 `>=` 同尺）。
pub fn recent_activity(last_ms: i64, now_ms: i64, window_ms: i64) -> bool {
    if last_ms <= 0 || now_ms < last_ms {
        return false;
    }
    now_ms.saturating_sub(last_ms) < window_ms.max(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_is_active_when_any_signal_is_true() {
        assert_eq!(tier_for(true, false, false), Tier::Active);
        assert_eq!(tier_for(false, true, false), Tier::Active);
        assert_eq!(tier_for(false, false, true), Tier::Active);
        assert_eq!(tier_for(false, false, false), Tier::Idle);
    }

    #[test]
    fn intervals_are_10s_active_and_60s_idle() {
        assert_eq!(heartbeat_interval_ms(Tier::Active), 10_000);
        assert_eq!(heartbeat_interval_ms(Tier::Idle), 60_000);
    }

    #[test]
    fn first_probe_is_immediate_and_clock_rollback_is_safe() {
        assert!(probe_due(0, 100, 10_000));
        assert!(probe_due(10_000, 20_000, 10_000));
        assert!(!probe_due(10_000, 19_999, 10_000));
        assert!(!probe_due(10_000, 9_000, 10_000), "时钟回拨不探");
    }

    #[test]
    fn loop_gap_handles_first_tick_and_clock_rollback() {
        assert_eq!(loop_gap_ms(0, 100_000), 0, "首次不算 gap");
        assert_eq!(loop_gap_ms(100_000, 99_000), 0, "时钟回拨不出负数");
        assert_eq!(loop_gap_ms(100_000, 107_500), 7_500);
    }

    #[test]
    fn wake_gap_threshold_and_env_gate() {
        assert!(!is_wake_gap(4_999, 5_000));
        assert!(is_wake_gap(5_000, 5_000));
        for v in [Some("1"), Some("true"), Some("ON"), Some(" on ")] {
            assert!(wake_resync_enabled_from(v), "应打开：{v:?}");
        }
        for v in [None, Some("0"), Some("false"), Some("off"), Some("")] {
            assert!(!wake_resync_enabled_from(v), "应关闭：{v:?}");
        }
    }

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff_after_fail(0), 10_000);
        assert_eq!(backoff_after_fail(1), 20_000);
        assert_eq!(backoff_after_fail(2), 40_000);
        assert_eq!(backoff_after_fail(3), 80_000);
        assert_eq!(backoff_after_fail(4), 160_000);
        assert_eq!(backoff_after_fail(5), 300_000);
        assert_eq!(backoff_after_fail(99), 300_000, "封顶不回绕");
    }

    /// ⭐ 2026-11-25（S1 接线）：最近活动的判定 ＋ 开关 ＋ **接线在岗**。
    #[test]
    fn recent_activity_window_and_env_gate() {
        let w = ACTIVE_WINDOW_MS;
        assert!(recent_activity(1_000, 1_000, w), "刚保存过 ⇒ 窗口内");
        assert!(recent_activity(1_000, 1_000 + w - 1, w), "边界内");
        assert!(
            !recent_activity(1_000, 1_000 + w, w),
            "恰好等于窗口 ⇒ 不算（左闭右开）"
        );
        assert!(!recent_activity(0, 5_000, w), "从没保存过 ⇒ 不算");
        assert!(
            !recent_activity(9_000, 1_000, w),
            "时钟回拨 ⇒ 不算（⛔ 别读成刚刚活动）"
        );
        for v in [Some("1"), Some("true"), Some("ON"), Some("on ")] {
            assert!(heartbeat_enabled_from(v), "应打开：{v:?}");
        }
        for v in [None, Some("0"), Some("false"), Some("off"), Some("")] {
            assert!(!heartbeat_enabled_from(v), "应关闭：{v:?}");
        }
    }

    /// 源码级：开关与两处调用必须真的在 `lan_state` 里（⛔ 写了没接 ✗）。
    #[test]
    fn wiring_is_env_gated_and_uses_the_heartbeat_interval() {
        let src = include_str!("lan_state.rs");
        assert!(src.contains("SHUYONOTE_LAN_HEARTBEAT"));
        assert!(
            src.contains("heartbeat_interval_ms("),
            "基础间隔必须来自心跳纯函数"
        );
        assert!(
            src.contains("background_round_due_with_base("),
            "心跳档位必须真的进『该不该跑』的判定"
        );
    }
}
