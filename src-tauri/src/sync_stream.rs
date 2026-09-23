//! 桌面「近实时」流通道的**纯函数内核**（设计稿 §4.1 / §7 第 1 步：**先有判据**）。
//!
//! 这里只放**不碰网络、不碰 Tauri**的两件事 —— 它们是最容易写错、也最值得先钉住的部分：
//!   ① **SSE 帧解析**：半帧/粘包/`\r\n\r\n`/注释帧（keep-alive）/多行 `data:`；
//!   ② **重连退避表**：`1s → 2s → 4s → … → 30s` 封顶。
//!
//! 设计稿：`docs/plans/2026-09-23-desktop-near-realtime-stream-design.md`（§5 判据 1/2）。
//!
//! ## 两条口径（与设计稿逐条对应，别在这里"顺手优化"）
//!
//! 1. **半帧必须留在缓冲里**：SSE 是流式协议，一次 `read` 回来的可能是"半个事件"
//!    ⇒ 本模块收**累计缓冲**、吐**切出来的帧 ＋ 新的剩余缓冲**，调用方负责把剩余缓冲带进下一次。
//! 2. **注释帧不算事件、但算"连接活着"**：服务端 axum 的 `KeepAlive` 约 15s 发一条 `:`
//!    注释帧。⇒ `drain_sse_frames` 只切它、不产出载荷；而"收到任何字节就重置退避"这条由
//!    **调用方**按"这一次 read 成功"来判（不是按"有没有帧"）—— 这里如实写清，免得接线时搞反。
//!
//! ⚠️ **`ping` 不是心跳**（设计稿 §6.2）：服务端在订阅者**落后**（broadcast 容量 64）时发的
//! `{"type":"ping"}` 意味着**可能漏了事件** ⇒ 调用方必须**立刻拉一次**，与收到 `push` 同待遇。
//! `frame_kind` 只负责把它**分类**（给事件载荷里的 `kind` 用），**不**决定"拉不拉"。

use serde_json::Value;

/// 退避起点（第 0 次失败后的等待）。
pub const BACKOFF_START_MS: u64 = 1_000;
/// 退避封顶：再久也不超过它（否则一次网络抖动会变成"半小时不同步"）。
pub const BACKOFF_MAX_MS: u64 = 30_000;

/// 第 `attempt` 次**连续**失败后该等多久（`attempt` 从 0 起：0 ⇒ 1s，1 ⇒ 2s …）。
///
/// 纯函数 ⇒ 可判据；`attempt` 很大时不溢出（先按指数算，再夹到封顶）。
pub fn backoff_ms(attempt: u32) -> u64 {
    // 用 `checked_shl` 挡住 `1u64 << 64` 这类溢出（`attempt` 是网络侧来的计数，不该让进程 panic）。
    let factor = 1u64.checked_shl(attempt).unwrap_or(u64::MAX);
    BACKOFF_START_MS.saturating_mul(factor).min(BACKOFF_MAX_MS)
}

/// 一帧里的 `data:` 行 ⇒ 载荷（**没有 `data:` 行 ⇒ `None`**，例如纯注释帧）。
///
/// 照 SSE 规范：`data:` 后**可有可无一个空格**；一帧里**多行 `data:`** 用 `\n` 连接；
/// 以 `:` 开头的行是注释（keep-alive）。
fn frame_data(frame: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for line in frame.split('\n') {
        if line.starts_with(':') {
            continue; // 注释帧（keep-alive）
        }
        if let Some(v) = line.strip_prefix("data:") {
            parts.push(v.strip_prefix(' ').unwrap_or(v));
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

/// **切帧**：输入累计缓冲 ⇒ `(切出来的载荷列表, 新的剩余缓冲)`。
///
/// - 只认 **空行**分帧（`\n\n`）；**`\r\n\r\n` 也认** —— 中间会经过代理，行尾被改写是常态
///   （`\r\n` 跨两次 read 被劈开也照样对：每次都在**拼接后的**缓冲上归一）；
/// - **注释帧切掉但不产出**（`None`）；
/// - **半帧留在剩余缓冲里**（调用方必须把它带进下一次）。
pub fn drain_sse_frames(buf: &str) -> (Vec<String>, String) {
    let norm = buf.replace("\r\n", "\n");
    let mut frames: Vec<String> = Vec::new();
    let mut rest: &str = &norm;
    while let Some(i) = rest.find("\n\n") {
        let raw = &rest[..i];
        rest = &rest[i + 2..];
        if let Some(d) = frame_data(raw) {
            frames.push(d);
        }
    }
    (frames, rest.to_string())
}

/// 帧载荷 ⇒ 事件 `kind`（**只给读数/事件载荷用**，不决定"拉不拉"）。
///
/// - `"push"`：服务端 `publish_space_change` 发的正常变更信号；
/// - `"ping"`：服务端在订阅者**落后**时发的 —— 语义是"**可能漏了事件**"，调用方必须立刻拉一次；
/// - `"other"`：认不出来（**不猜**它是什么，但照样按"有帧就拉"处理）。
pub fn frame_kind(payload: &str) -> &'static str {
    match serde_json::from_str::<Value>(payload) {
        Ok(v) => match v.get("type").and_then(Value::as_str) {
            Some("push") => "push",
            Some("ping") => "ping",
            _ => "other",
        },
        Err(_) => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 判据 1：**半帧留在缓冲里**（不能"收到就 parse"）；补齐后正好吐一帧。
    #[test]
    fn half_frame_stays_in_the_buffer() {
        let (frames, rest) = drain_sse_frames("data: {\"type\":\"pu");
        assert!(frames.is_empty(), "半个事件不该被当成一帧：{frames:?}");
        assert_eq!(rest, "data: {\"type\":\"pu");

        let (frames, rest) = drain_sse_frames(&format!("{rest}sh\"}}\n\n"));
        assert_eq!(frames, vec!["{\"type\":\"push\"}".to_string()]);
        assert_eq!(rest, "", "切完之后不该有余料");
    }

    /// 判据 1：**一次 read 里粘了好几帧**都要切出来（不能一次只切一帧）。
    #[test]
    fn sticky_frames_are_all_drained() {
        let (frames, rest) = drain_sse_frames("data: a\n\ndata: b\n\ndata: c\n\n");
        assert_eq!(frames, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
        assert_eq!(rest, "");
    }

    /// 判据 1：`\r\n\r\n` 也要认，**并且跨 read 被劈开的 `\r\n` 也要认**（代理改写行尾是常态）。
    #[test]
    fn crlf_frames_and_split_crlf() {
        let (frames, rest) = drain_sse_frames("data: x\r\n\r\ndata: y\r\n\r\n");
        assert_eq!(frames, vec!["x".to_string(), "y".to_string()]);
        assert_eq!(rest, "");

        // `\r` 与 `\n` 分属两次 read
        let (f1, r1) = drain_sse_frames("data: z\r");
        assert!(f1.is_empty());
        let (f2, r2) = drain_sse_frames(&format!("{r1}\n\r\n"));
        assert_eq!(f2, vec!["z".to_string()], "劈开的 CRLF 必须也能切出来");
        assert_eq!(r2, "");
    }

    /// 判据 1：**注释帧不算事件**（keep-alive），但也不许把它当成"半帧"卡住后面的帧。
    #[test]
    fn comment_frames_are_dropped_not_stalled() {
        let (frames, rest) = drain_sse_frames(": keep-alive\n\ndata: real\n\n");
        assert_eq!(frames, vec!["real".to_string()]);
        assert_eq!(rest, "");
        // 纯注释帧单独来一次 ⇒ 没有任何载荷
        let (frames, rest) = drain_sse_frames(": ka\n\n");
        assert!(frames.is_empty());
        assert_eq!(rest, "");
    }

    /// 判据 1：`data:` 后**可有可无一个空格**；一帧**多行 `data:`** 用 `\n` 连接（SSE 规范）。
    #[test]
    fn data_line_spacing_and_multi_line() {
        let (frames, _) = drain_sse_frames("data:a\n\n");
        assert_eq!(frames, vec!["a".to_string()]);
        let (frames, _) = drain_sse_frames("data: a\n\n");
        assert_eq!(frames, vec!["a".to_string()]);
        let (frames, _) = drain_sse_frames("data: line1\ndata: line2\n\n");
        assert_eq!(frames, vec!["line1\nline2".to_string()]);
        // 只多一个空格以内：`data:  x`（两个空格）⇒ SSE 规范里只吃掉一个
        let (frames, _) = drain_sse_frames("data:  x\n\n");
        assert_eq!(frames, vec![" x".to_string()]);
    }

    /// 判据 2：退避表 `1s → 2s → 4s → … → 30s` 封顶；`attempt` 再大也不溢出。
    #[test]
    fn backoff_table_is_capped_and_never_overflows() {
        assert_eq!(backoff_ms(0), 1_000);
        assert_eq!(backoff_ms(1), 2_000);
        assert_eq!(backoff_ms(2), 4_000);
        assert_eq!(backoff_ms(4), 16_000);
        assert_eq!(backoff_ms(5), 30_000, "32s 应当被夹到 30s");
        assert_eq!(backoff_ms(6), 30_000);
        assert_eq!(backoff_ms(64), 30_000, "移位溢出不许 panic/回绕");
        assert_eq!(backoff_ms(u32::MAX), 30_000);
    }

    /// 判据 2 的配套：**`ping` 要被分类出来**（它意味着"可能漏了事件" ⇒ 调用方立刻拉一次）。
    #[test]
    fn frame_kind_classifies_push_ping_and_unknown() {
        assert_eq!(frame_kind(r#"{"type":"push","space_id":"sp","accepted":3}"#), "push");
        // 服务端订阅者落后时发的就是它：**不是心跳**，是"你漏了事件"
        assert_eq!(frame_kind(r#"{"type":"ping"}"#), "ping");
        assert_eq!(frame_kind(r#"{"type":"whatever"}"#), "other");
        assert_eq!(frame_kind("不是 JSON"), "other", "认不出来 ⇒ other，**不猜**");
        assert_eq!(frame_kind(""), "other");
    }
}
