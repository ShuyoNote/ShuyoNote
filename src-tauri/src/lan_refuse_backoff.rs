//! ⭐ 2026-11-25：被「不融合（同名但 `space_uid` 不同）」拒绝之后，**退避窗口内不再打这一对**。
//!
//! ## 来由（真机实测，不是推想）
//! `工作` 空间与 `ZHAI-AMD` 同名但 uid 不同 ⇒ 融合闸**每轮都拒绝**；而拉取发生在闸门**之前**，
//! 所以每 10 秒把同一批（34,127 B）重新搬一遍 —— **≈0.3 GB/天**，直到用户去面板点确认。
//!
//! ## 这条改什么、不改什么
//! * ✅ 只改**多久试一次**：窗口内**整对跳过**（连网络都不打）；
//! * ⛔ 不改「该不该融」的判定（闸门一个字没动，确认语义也没动）；
//! * ✅ **确认后立刻清零**（[`clear_all`]，由「确认」命令调用）⇒ 用户点完**下一轮就恢复**，
//!   不用等一个退避窗口（这是"退避会不会拖慢确认后的同步"这个问题的答案）。
//!
//! ## 开关
//! `SHUYONOTE_LAN_REFUSE_BACKOFF_MS`：默认 **5 分钟**；显式 `0` ⇒ **关掉退避**（回到每轮重试）。
//!
//! ## 键
//! `(协议空间 id, 对端 device_id)` —— 只影响这一对；别的空间/别的对端照常拉。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// 默认窗口：5 分钟。
pub const DEFAULT_WINDOW_MS: i64 = 5 * 60 * 1000;

/// 窗口长度：只认显式数字；读不到/写坏 ⇒ 默认 5 分钟（⛔ 不因为一行 env 写错就关掉保护）。
pub fn window_ms_from(value: Option<&str>) -> i64 {
    match value.map(|v| v.trim().parse::<i64>()) {
        Some(Ok(n)) if n >= 0 => n,
        _ => DEFAULT_WINDOW_MS,
    }
}

fn window_ms() -> i64 {
    static W: OnceLock<i64> = OnceLock::new();
    *W.get_or_init(|| {
        window_ms_from(
            std::env::var("SHUYONOTE_LAN_REFUSE_BACKOFF_MS")
                .ok()
                .as_deref(),
        )
    })
}

fn map() -> &'static Mutex<HashMap<String, i64>> {
    static M: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key(space: &str, peer: &str) -> String {
    format!("{space}|{peer}")
}

/// 纯函数：`now` 这一刻是否还在退避窗口内。
///
/// * `window_ms == 0` ⇒ 永不跳过（退避被关掉）；
/// * `last_refused_ms == 0` ⇒ 从没被拒过 ⇒ 不跳过；
/// * 时间倒退（`now < last`）⇒ 按"刚拒过"处理（宁可不打，也⛔ 不因为时钟怪就疯狂重试）。
pub fn should_skip(now_ms: i64, last_refused_ms: i64, window_ms: i64) -> bool {
    if window_ms <= 0 || last_refused_ms <= 0 {
        return false;
    }
    match now_ms.checked_sub(last_refused_ms) {
        Some(d) => d < window_ms,
        None => true,
    }
}

/// 融合闸拒绝了一批 ⇒ 记下这一刻（调用点：`absorb_and_report` 的 `Refuse` 分支）。
pub fn note_refused(space: &str, peer: &str, now_ms: i64) {
    if window_ms() <= 0 {
        return;
    }
    if let Ok(mut m) = map().lock() {
        m.insert(key(space, peer), now_ms);
    }
}

/// 这一对现在是否该跳过（调用点：`round_candidates_inner` 在**并发抓取之前**）。
pub fn skip_now(space: &str, peer: &str, now_ms: i64) -> bool {
    let w = window_ms();
    if w <= 0 {
        return false;
    }
    let last = map()
        .lock()
        .ok()
        .and_then(|m| m.get(&key(space, peer)).copied())
        .unwrap_or(0);
    should_skip(now_ms, last, w)
}

/// 用户确认了（无论哪一对）⇒ **全部清零**。
///
/// 为什么是"全部"而不是"那一对"：确认命令只拿得到**本机工作空间 id**，而退避键用的是
/// **协议空间 id**，两者之间要再过一层解析才能对上；确认本身极少发生（人手点的），
/// 而多清一对的代价只是"下一轮多打一次"——远小于解析错一对的代价（那一对会一直退避）。
pub fn clear_all() {
    if let Ok(mut m) = map().lock() {
        m.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_refusal_never_skips() {
        assert!(!should_skip(1_000, 0, 60_000));
        assert!(!should_skip(0, 0, 60_000));
    }

    #[test]
    fn window_zero_disables_backoff() {
        assert!(!should_skip(1_000, 999, 0));
    }

    #[test]
    fn inside_the_window_skips_and_outside_retries() {
        let w = 60_000;
        assert!(should_skip(10_000, 10_000, w), "刚拒过 ⇒ 跳过");
        assert!(should_skip(69_999, 10_000, w), "窗口边界内 ⇒ 跳过");
        assert!(!should_skip(70_000, 10_000, w), "到点 ⇒ 再试");
        assert!(!should_skip(120_000, 10_000, w));
    }

    #[test]
    fn clock_going_backwards_is_treated_as_just_refused() {
        assert!(should_skip(5_000, 10_000, 60_000));
    }

    #[test]
    fn window_parsing_defaults_on_garbage() {
        assert_eq!(window_ms_from(Some("90000")), 90_000);
        assert_eq!(window_ms_from(Some("0")), 0);
        assert_eq!(window_ms_from(None), DEFAULT_WINDOW_MS);
        assert_eq!(window_ms_from(Some("abc")), DEFAULT_WINDOW_MS);
        assert_eq!(window_ms_from(Some("-5")), DEFAULT_WINDOW_MS);
    }

    /// 源码级：拒绝处记账 ＋ 抓取前跳过 ＋ 确认后清零，三处都得在（⛔ 写了没接 ✗）。
    #[test]
    fn wiring_is_present_in_all_three_places() {
        let mesh = include_str!("mesh.rs");
        assert!(mesh.contains("note_refused("), "拒绝分支必须记账");
        assert!(mesh.contains("skip_now("), "并发抓取之前必须跳过");
        let panel = include_str!("mesh_panel.rs");
        assert!(
            panel.contains("clear_all("),
            "确认命令必须清零（否则确认后要等一个窗口）"
        );
    }
}
