// §13.2 S2「网络变化即时反应」—— **P0：纯函数检测层**（⛔ 未接线、默认零行为变化）。
//
// 为什么先只做纯函数：真接线要改公告节拍（用户可见行为），按仓规需 owner 拍板；
// 而“什么算网络变化 / 什么时候该强制重播”本身是可以先用判据钉死的纯逻辑。
// 接线时只允许在 `SHUYONOTE_LAN_NETWATCH=1/true/on` 下生效，默认逐字节保持今天的行为。
//
// 口径（可核）：
// · 指纹只取 **IPv4**（去掉 loopback / unspecified / 非 IPv4），按 `name + ip` 排序后拼串；
// · 首个样本不算“变化”（还没有 prev）；相同指纹不算变化；
// · `force_due` 只在“已有强制点且距上次公告 ≥ 最小间隔”时放行，消费后由调用方清零。
//
// 接线计划（下一刀）：`lan_state::start` 的 1s 循环里每 2 拍采一次
// `mesh::local_addrs_named()`，连续 2 个相同的新指纹才算变化（去抖），置 `FORCE_ANNOUNCE_AT_MS`；
// 公告条件加 `|| force_due(...)`，成功发出广播后清零；env 未设则连采样都不做。

use std::net::IpAddr;

/// 一条网卡地址（网卡名 + IP）；只用于本机日志/指纹，⛔ 不外传。
pub type AddrSample = (String, IpAddr);

/// 本机地址 → 稳定指纹（只 IPv4，去 loopback/unspecified，排序）。
///
/// 空输入 ⇒ 固定串 `"none"`（⛔ 不返回空串，避免“没采到”和“没有地址”混在一起）。
pub fn fingerprint(addrs: &[AddrSample]) -> String {
    let mut items: Vec<String> = addrs
        .iter()
        .filter_map(|(name, ip)| match ip {
            IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_unspecified() => {
                Some(format!("{name}={v4}"))
            }
            _ => None,
        })
        .collect();
    items.sort();
    items.dedup();
    if items.is_empty() {
        "none".to_string()
    } else {
        items.join("|")
    }
}

/// 指纹是否变化：首个样本（prev=None）**不算**变化。
pub fn is_change(prev: Option<&str>, next: &str) -> bool {
    match prev {
        None => false,
        Some(p) => p != next,
    }
}

/// 强制重播是否到点：没有强制点 ⇒ false；已有强制点且距上次公告 ≥ `min_gap_ms` ⇒ true。
///
/// ⚠️ 调用方在**成功发出广播**之后必须把强制点清零（否则每拍都会重播）。
pub fn force_due(force_at_ms: i64, now_ms: i64, last_announce_ms: i64, min_gap_ms: i64) -> bool {
    if force_at_ms <= 0 {
        return false;
    }
    // 时钟回拨（now < last_announce）⇒ 不重播（⛔ 不出负数/风暴）
    if now_ms < last_announce_ms {
        return false;
    }
    now_ms.saturating_sub(last_announce_ms) >= min_gap_ms.max(0)
}

/// 开关解析（纯函数）：只有显式 `1/true/on`（大小写不敏感）才算开；其余一律关。
///
/// 与 `SHUYONOTE_MESH_AUTOSYNC=0` 同一套“只认显式值”的纪律：⛔ 拿不准不打开。
pub fn netwatch_enabled_from(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true") | Some("on")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(name: &str, ip: &str) -> AddrSample {
        (name.to_string(), ip.parse().unwrap())
    }

    #[test]
    fn fingerprint_sorts_and_ignores_loopback_and_ipv6() {
        let one = fingerprint(&[a("eth0", "192.168.1.5"), a("lo", "127.0.0.1")]);
        let two = fingerprint(&[a("eth0", "192.168.1.5"), a("lo", "127.0.0.1")]);
        assert_eq!(one, two, "同内容不同顺序 ⇒ 同指纹");
        assert!(!one.contains("127.0.0.1"), "loopback 不进指纹：{one}");
        let with_v6 = fingerprint(&[
            a("eth0", "192.168.1.5"),
            ("eth0".to_string(), "fe80::1".parse().unwrap()),
        ]);
        assert_eq!(with_v6, one, "IPv6 变化不影响指纹");
    }

    #[test]
    fn fingerprint_empty_is_none_not_empty_string() {
        assert_eq!(fingerprint(&[]), "none");
        assert_eq!(fingerprint(&[a("lo", "127.0.0.1")]), "none");
    }

    #[test]
    fn first_sample_is_not_a_change() {
        let fp = fingerprint(&[a("eth0", "192.168.1.5")]);
        assert!(!is_change(None, &fp));
        assert!(is_change(
            Some(&fp),
            &fingerprint(&[a("eth0", "192.168.1.6")])
        ));
        assert!(!is_change(Some(&fp), &fp));
    }

    #[test]
    fn env_gate_only_explicit_on_values_open_it() {
        for v in [Some("1"), Some("true"), Some("ON"), Some(" on ")] {
            assert!(netwatch_enabled_from(v), "应打开：{v:?}");
        }
        for v in [
            None,
            Some("0"),
            Some("false"),
            Some("off"),
            Some("yes"),
            Some(""),
        ] {
            assert!(!netwatch_enabled_from(v), "应关闭：{v:?}");
        }
    }

    /// 源码级：接线只在 env 门下、且公告条件真的用了 `force_due`（⛔ 默认路径不受影响）。
    #[test]
    fn wiring_is_env_gated_and_announce_uses_force_due() {
        let src = include_str!("lan_state.rs");
        assert!(src.contains("SHUYONOTE_LAN_NETWATCH"));
        assert!(src.contains("force_due("));
        assert!(src.contains("FORCE_ANNOUNCE_AT_MS"));
    }

    #[test]
    fn force_due_requires_a_point_and_respects_gap() {
        // 没有强制点 ⇒ 永不放行
        assert!(!force_due(0, 10_000, 0, 1_000));
        // 有强制点、距上次公告够久 ⇒ 放行
        assert!(force_due(1, 10_000, 5_000, 1_000));
        // 不够久 ⇒ 不放行
        assert!(!force_due(1, 10_500, 10_000, 1_000));
        // 时钟回拨 ⇒ 不放行（⛔ 不出负差/风暴）
        assert!(!force_due(1, 4_000, 5_000, 1_000));
    }
}
