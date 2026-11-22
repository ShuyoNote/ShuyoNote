// §13.2 S1「连接监督器」—— **P0：心跳策略纯函数**（⛔ 未接线、默认零行为变化）。
//
// 为什么先只做纯函数：真心跳会新增网络流量与耗电，属用户可见行为，按仓规需 owner 拍板；
// 但「什么算前台、多久探一次、失败怎么退避」本身可以先用判据钉死。
// 接线时只在 `SHUYONOTE_LAN_HEARTBEAT=1/true/on` 下生效，默认逐字节保持今天的行为。
//
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
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff_after_fail(0), 10_000);
        assert_eq!(backoff_after_fail(1), 20_000);
        assert_eq!(backoff_after_fail(2), 40_000);
        assert_eq!(backoff_after_fail(3), 80_000);
        assert_eq!(backoff_after_fail(4), 160_000);
        assert_eq!(backoff_after_fail(5), 300_000);
        assert_eq!(backoff_after_fail(99), 300_000, "封顶不回绕");
    }
}
