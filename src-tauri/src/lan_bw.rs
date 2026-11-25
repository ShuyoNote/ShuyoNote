// §13.3 F3-b「带宽自适应（第一刀）」—— **纯函数 + 默认关接线**。
//
// 背景：F3-a 的公告扇出节流（`lan_fanout.rs`）把**空闲轮次**的对端单播固定成"每 2 轮一次"；
// 但 2 是拍出来的常数，与链路忙不忙无关。`[sync-metrics] ... bytes=` 落地后（2026-11-22），
// 终于有"这一轮到底搬了多少字节"这个读数 ⇒ 可以用它决定**公告扇出该多稀**。
//
// 口径（与 F3-a 同族，缺一不算）：
//   1) **默认关**：不设 `SHUYONOTE_LAN_BW_ADAPT=1` ⇒ 一次都不读、不衰减，行为与今天**逐字节相同**；
//   2) **只减少公告单播**：⛔ 不改"谁该收到公告"，⛔ 不碰 dirty 轮（保存即同步不能变慢）；
//   3) **会自然衰减**：每次取档位把上一轮字节数减半 ⇒ 传输量降下来后自己回到 2 轮/次；
//   4) 回滚 = 去掉环境变量（不迁数据、不改库结构）。
//
// ⚠️ 本刀**不做**：按实测带宽（bps）估算、按丢包/时延自适应、按设备数加权 —— 那些要真机读数，
//    见 `docs/plans/2026-11-25-f3-bandwidth-adaptive.md` §5。

use std::sync::atomic::{AtomicU64, Ordering};

/// 上一轮（任一空间 × 任一对端的 pull）搬了多少**变更行**字节。0 = 还没量到过。
static LAST_ROUND_BYTES: AtomicU64 = AtomicU64::new(0);

/// 上一轮搬了多少**附件**字节。0 = 这轮没有附件。
///
/// ⚠️ 2026-11-25 真机实测：`[sync-metrics] … bytes=` **不包含附件**（它只累加变更行的
/// payload+sealed，附件走 `/mesh/attachment` 另一条路）⇒ 6 MiB 附件同步成功时
/// `bytes=` 全程最大只有 59 KB。所以附件字节必须**单独记**（新读数
/// `[sync-metrics-attach]`），再由 [`take_round_fanout_every`] 与变更行字节相加 ——
/// ⛔ 不改 `bytes=` 的既有口径（那条读数有它自己的用途与历史）。
static LAST_ROUND_ATTACH_BYTES: AtomicU64 = AtomicU64::new(0);

/// 上一次 pull 的变更行传输量（字节）。`mesh.rs` 在打 `[sync-metrics] ... bytes=` 的同一处记一笔。
pub fn note_round_bytes(bytes: usize) {
    LAST_ROUND_BYTES.store(bytes as u64, Ordering::Relaxed);
}

/// 这一轮又搬回了多少**附件**字节（累加；一轮可能有多件）。`sync.rs` 在附件取回成功处记一笔。
pub fn note_attachment_bytes(bytes: usize) {
    if bytes == 0 {
        return;
    }
    LAST_ROUND_ATTACH_BYTES.fetch_add(bytes as u64, Ordering::Relaxed);
}

/// 本轮公告对端单播的"每 N 轮一次"。**会消耗一次衰减**（读-改-写；调用点只有一个）。
///
/// 输入 = 变更行字节 ＋ 附件字节（两者都会衰减一半）。
pub fn take_round_fanout_every() -> u64 {
    let changes = LAST_ROUND_BYTES.load(Ordering::Relaxed);
    let attach = LAST_ROUND_ATTACH_BYTES.load(Ordering::Relaxed);
    LAST_ROUND_BYTES.store(decayed_bytes(changes), Ordering::Relaxed);
    LAST_ROUND_ATTACH_BYTES.store(decayed_bytes(attach), Ordering::Relaxed);
    fanout_every_from_bytes(total_round_bytes(changes, attach))
}

/// 一轮的"带宽"输入：变更行 ＋ 附件（饱和相加，不溢出）。
pub fn total_round_bytes(changes: u64, attachments: u64) -> u64 {
    changes.saturating_add(attachments)
}

/// 传输量 → 扇出档位。**越大越稀**；下限仍是 2（与 F3-a 的节流档一致）。
///
/// 阈值取整档（KiB/MiB），不是拟合出来的 —— 先立一个可回滚的保守档位，
/// 等真机读数（`measure-sync-baseline.mjs` 的「传输字节」段）再谈拟合。
pub fn fanout_every_from_bytes(bytes: u64) -> u64 {
    const KIB: u64 = 1024;
    const MIB: u64 = 1024 * 1024;
    if bytes >= 4 * MIB {
        8
    } else if bytes >= 512 * KIB {
        4
    } else {
        2
    }
}

/// 衰减：每用掉一次档位，字节数减半（⇒ 传输量降下来后自己回到 2）。
pub fn decayed_bytes(bytes: u64) -> u64 {
    bytes / 2
}

/// 开关：只认显式 `1/true/on`（默认关）。与 `lan_fanout::fanout_throttle_enabled_from` 同口径。
pub fn bw_adapt_enabled_from(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true") | Some("on")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_payload_keeps_the_f3a_gear() {
        assert_eq!(fanout_every_from_bytes(0), 2);
        assert_eq!(fanout_every_from_bytes(1), 2);
        assert_eq!(fanout_every_from_bytes(512 * 1024 - 1), 2);
    }

    #[test]
    fn gear_steps_up_at_the_documented_thresholds() {
        assert_eq!(fanout_every_from_bytes(512 * 1024), 4);
        assert_eq!(fanout_every_from_bytes(4 * 1024 * 1024 - 1), 4);
        assert_eq!(fanout_every_from_bytes(4 * 1024 * 1024), 8);
        assert_eq!(fanout_every_from_bytes(u64::MAX), 8);
    }

    #[test]
    fn decay_halves_and_bottoms_out_at_zero() {
        assert_eq!(decayed_bytes(8 * 1024 * 1024), 4 * 1024 * 1024);
        assert_eq!(decayed_bytes(1), 0);
        assert_eq!(decayed_bytes(0), 0);
    }

    #[test]
    fn total_is_changes_plus_attachments_without_overflow() {
        assert_eq!(total_round_bytes(0, 0), 0);
        assert_eq!(total_round_bytes(59_379, 6_291_456), 6_350_835);
        assert_eq!(total_round_bytes(u64::MAX, 1), u64::MAX);
    }

    /// ⭐ 2026-11-25 真机那条原样立成判据：**6 MiB 附件必须能把档位抬到 8**。
    ///
    /// 当时 `bytes=` 只有 59,379 B（附件不计入）⇒ 一直停在 2 档；补了附件读数之后，
    /// 同一轮的真实输入 = 变更行 59,379 ＋ 附件 6,291,456 ⇒ 必须 ≥4 MiB ⇒ 8 档。
    #[test]
    fn a_six_mib_attachment_alone_lifts_the_gear_to_eight() {
        let real_round = total_round_bytes(59_379, 6_291_456);
        assert_eq!(fanout_every_from_bytes(real_round), 8);
        // 反例：只看变更行的话，同一轮只有 2 档 —— 正是真机上观测到的那个"不触发"。
        assert_eq!(fanout_every_from_bytes(59_379), 2);
    }

    /// 衰减会把档位从 8 一路带回 2：字节数每轮减半，够几轮就落回低档。
    #[test]
    fn repeated_decay_returns_to_the_low_gear() {
        let mut b = 8 * 1024 * 1024u64;
        let mut gears = Vec::new();
        for _ in 0..8 {
            gears.push(fanout_every_from_bytes(b));
            b = decayed_bytes(b);
        }
        assert_eq!(gears[0], 8);
        assert_eq!(gears[1], 8); // 4 MiB 仍在最高档
        assert_eq!(gears[2], 4); // 2 MiB
        assert_eq!(*gears.last().unwrap(), 2);
    }

    #[test]
    fn env_gate_only_explicit_on() {
        for v in [Some("1"), Some("true"), Some("ON"), Some(" on ")] {
            assert!(bw_adapt_enabled_from(v), "应开：{v:?}");
        }
        for v in [None, Some("0"), Some("false"), Some("off"), Some("")] {
            assert!(!bw_adapt_enabled_from(v), "应关：{v:?}");
        }
    }

    /// 源码级：接线在 env 门下 ＋ 量过的字节真的用上了 ＋ 只在公告单播处生效。
    #[test]
    fn wiring_is_env_gated_and_uses_the_measured_bytes() {
        let lan = include_str!("lan_state.rs");
        assert!(
            lan.contains("SHUYONOTE_LAN_BW_ADAPT"),
            "开关必须在 lan_state 里读"
        );
        assert!(
            lan.contains("take_round_fanout_every("),
            "公告单播处必须真的用上自适应档位"
        );
        let mesh = include_str!("mesh.rs");
        assert!(
            mesh.contains("note_round_bytes("),
            "must record the measured bytes next to [sync-metrics] bytes="
        );
        let sync = include_str!("sync.rs");
        assert!(
            sync.contains("note_attachment_bytes("),
            "附件字节必须在附件取回成功处记一笔（否则输入永远看不见附件）"
        );
        assert!(
            sync.contains("[sync-metrics-attach]"),
            "附件字节要有一条**独立**读数（⛔ 不改 bytes= 的既有口径）"
        );
    }
}
