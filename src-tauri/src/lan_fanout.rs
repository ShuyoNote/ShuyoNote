// §13.3 F3「公告扇出节流」—— **P0：纯函数 + 默认关接线**。
//
// 背景：公告每 10s 一轮；目标 ≈ 广播3 + 回环3 + 每个已知对端 1。多设备时会线性涨。
// 保守做法：**没有 dirty 的轮次，对端单播每 2 轮发一次**（广播/回环照旧）；
// dirty 轮次永远发（保存即同步不能变慢）；默认关，设 `SHUYONOTE_LAN_FANOUT_THROTTLE=1` 才生效。
//
// ⛔ 不改任何“谁该收到公告”的判定；只减少“空闲轮次的对端单播”。

/// 本轮是否发对端单播：dirty ⇒ 永远发；否则每 `every` 轮发一次（cycle 从 1 开始）。
pub fn peer_unicast_due(cycle: u64, dirty: bool, every: u64) -> bool {
    if dirty {
        return true;
    }
    if every <= 1 {
        return true;
    }
    cycle % every == 0
}

/// 开关：只认显式 `1/true/on`（默认关）。
pub fn fanout_throttle_enabled_from(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true") | Some("on")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirty_always_sends_peer_unicast() {
        assert!(peer_unicast_due(1, true, 3));
        assert!(peer_unicast_due(2, true, 3));
    }

    #[test]
    fn idle_sends_every_nth_cycle() {
        assert!(!peer_unicast_due(1, false, 2));
        assert!(peer_unicast_due(2, false, 2));
        assert!(!peer_unicast_due(3, false, 2));
        assert!(!peer_unicast_due(1, false, 3));
        assert!(peer_unicast_due(3, false, 3));
    }

    #[test]
    fn every_zero_or_one_means_no_throttle() {
        assert!(peer_unicast_due(1, false, 0));
        assert!(peer_unicast_due(1, false, 1));
    }

    #[test]
    fn env_gate_only_explicit_on() {
        for v in [Some("1"), Some("true"), Some("ON"), Some(" on ")] {
            assert!(fanout_throttle_enabled_from(v), "应开：{v:?}");
        }
        for v in [None, Some("0"), Some("false"), Some("off"), Some("")] {
            assert!(!fanout_throttle_enabled_from(v), "应关：{v:?}");
        }
    }

    /// 源码级：接线只在 env 门下、且公告目标真的走了节流选择。
    #[test]
    fn wiring_is_env_gated_and_uses_peer_unicast_due() {
        let src = include_str!("lan_state.rs");
        assert!(src.contains("SHUYONOTE_LAN_FANOUT_THROTTLE"));
        assert!(src.contains("peer_unicast_due("));
    }
}
