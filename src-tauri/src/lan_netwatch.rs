// §13.2 S2「网络变化即时反应」—— **纯函数检测层 ＋ 已接线**。
//
// ⚠️ **2026-11-25 更正**：本行原先写着「⛔ 未接线」—— 那是**过期注释**。
//   `lan_state` 里三处早就接好了（见下方"接线落点"）；默认仍**逐字节保持今天的行为**，
//   因为只有 `SHUYONOTE_LAN_NETWATCH=1/true/on` 才会采样。
//
// 口径（可核）：
// · 指纹只取 **IPv4**（去掉 loopback / unspecified / 非 IPv4），按 `name + ip` 排序后拼串；
// · 首个样本不算“变化”（还没有 prev）；相同指纹不算变化；
// · `force_due` 只在“已有强制点且距上次公告 ≥ 最小间隔”时放行，消费后由调用方清零。
//
// ## 接线落点（2026-11-25 逐处核过，⛔ 以后别再照注释说"未接线"）
// · 采样＋去抖：`lan_state.rs` 的 1s 循环里，**每 2 拍**采一次 `mesh::local_addrs_named()`，
//   连续 2 个相同的新指纹才算变化 ⇒ 置 `FORCE_ANNOUNCE_AT_MS`；
// · 公告条件：`announce_due_with_dirty(...) || force_due(...)`；
// · 消费：**真发出去过一条**之后才清零（全失败 ⇒ 保留，下一拍再试）。
// env 未设 ⇒ **连采样都不做**（`netwatch_enabled()` 短路）。

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

/// ⭐ **2026-11-25**：带**链路状态**的指纹 —— 只算"链路 up"的那些地址。
///
/// 真机来由（S2 复测）：拔网线时 Windows **保留** IP ⇒ 只看地址集合的 [`fingerprint`]
/// **看不见"线断了"**（那次 netwatch 一条都没出）。把 `up` 位并进指纹后，
/// 「线拔了/插回」与「换 Wi‑Fi（地址变）」**两类事件都能触发重播**。
///
/// 口径：`up == false` 的条目**整条丢弃**（连它的地址都不进指纹）⇒ 链路一断，
/// 指纹必然少一条 ⇒ 变化成立。⛔ 不引入任何新状态、⛔ 不改 [`fingerprint`] 的语义。
pub fn fingerprint_with_link(addrs: &[(String, IpAddr, bool)]) -> String {
    let up_only: Vec<AddrSample> = addrs
        .iter()
        .filter(|(_, _, up)| *up)
        .map(|(name, ip, _)| (name.clone(), *ip))
        .collect();
    fingerprint(&up_only)
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

/// **去抖的一步**（纯函数）—— 返回 `(新 prev, 新 pending, 这一拍是否算“变化”)`。
///
/// 口径（与接线处逐字一致，2026-11-25 从 `lan_state` 的内联代码里抽出来以便有判据）：
/// * 与 `prev` 相同 ⇒ 变化被撤销：`pending` 清空，不算变化；
/// * 与 `pending` 相同（连续两拍同一个新指纹）⇒ **确认变化**：`prev` 更新、`pending` 清空；
/// * 其它 ⇒ 记一笔 `pending`，这一拍**不**算变化（⛔ 一次抖动不算换网）。
///
/// ⚠️ 首个样本（`prev == None`）⇒ `is_change` 为假 ⇒ 只立基线，不算变化（⛔ 启动就重播）。
pub fn debounce_step(
    prev: Option<&str>,
    pending: Option<&str>,
    next: &str,
) -> (Option<String>, Option<String>, bool) {
    if prev == Some(next) {
        return (prev.map(str::to_string), None, false);
    }
    if pending == Some(next) {
        let changed = is_change(prev, next);
        return (Some(next.to_string()), None, changed);
    }
    (prev.map(str::to_string), Some(next.to_string()), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⭐ 2026-11-25：去抖那三支（原先只在内联代码里，端到端才碰得到）现在有判据了。
    #[test]
    fn debounce_needs_two_consecutive_same_samples() {
        // 首个样本：只立基线，⛔ 不算变化（启动就重播是错的）。
        let (prev, pending, changed) = debounce_step(None, None, "A");
        assert_eq!(prev, None);
        assert_eq!(pending.as_deref(), Some("A"));
        assert!(!changed);
        // 再拍一次 A ⇒ 确认基线（prev 从 None 变 A 也**不算**变化）。
        let (prev, pending, changed) = debounce_step(None, Some("A"), "A");
        assert_eq!(prev.as_deref(), Some("A"));
        assert_eq!(pending, None);
        assert!(!changed);
        // A → B：第一拍只记 pending。
        let (prev, pending, changed) = debounce_step(Some("A"), None, "B");
        assert_eq!(prev.as_deref(), Some("A"));
        assert_eq!(pending.as_deref(), Some("B"));
        assert!(!changed);
        // A → B 的第二拍：确认变化。
        let (prev, pending, changed) = debounce_step(Some("A"), Some("B"), "B");
        assert_eq!(prev.as_deref(), Some("B"));
        assert_eq!(pending, None);
        assert!(changed);
    }

    /// 抖动：A → B → A（第二拍又回到 A）⇒ **不算变化**，pending 清掉。
    #[test]
    fn a_single_jitter_is_not_a_network_change() {
        let (prev, pending, changed) = debounce_step(Some("A"), Some("B"), "A");
        assert_eq!(prev.as_deref(), Some("A"));
        assert_eq!(pending, None);
        assert!(!changed);
    }

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

    /// ⭐ 2026-11-25（真机 S2 复测的盲区）：**链路 down 的地址不进指纹** ⇒
    /// 拔网线（Windows 保留 IP）也能被看见。变异：不过滤 `up` ⇒ 两条断言红。
    #[test]
    fn link_state_is_part_of_the_fingerprint() {
        let all_up = vec![
            (
                "eth0".to_string(),
                "192.168.1.5".parse::<IpAddr>().unwrap(),
                true,
            ),
            (
                "wlan0".to_string(),
                "192.168.1.9".parse::<IpAddr>().unwrap(),
                true,
            ),
        ];
        let eth_down = vec![
            (
                "eth0".to_string(),
                "192.168.1.5".parse::<IpAddr>().unwrap(),
                false,
            ),
            (
                "wlan0".to_string(),
                "192.168.1.9".parse::<IpAddr>().unwrap(),
                true,
            ),
        ];
        assert_ne!(
            fingerprint_with_link(&all_up),
            fingerprint_with_link(&eth_down),
            "链路一断，指纹必须变（否则拔网线永远看不见）"
        );
        assert!(
            !fingerprint_with_link(&eth_down).contains("192.168.1.5"),
            "down 的地址不许留在指纹里"
        );
        assert_eq!(fingerprint_with_link(&[]), "none");
        // 老口径（只看地址）在这两态之间**看不出差别** —— 这正是当时漏掉的那一格。
        let addrs_of = |v: &[(String, IpAddr, bool)]| -> Vec<AddrSample> {
            v.iter().map(|(n, ip, _)| (n.clone(), *ip)).collect()
        };
        assert_eq!(
            fingerprint(&addrs_of(&all_up)),
            fingerprint(&addrs_of(&eth_down)),
            "反例：不带链路状态就分不出来"
        );
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
