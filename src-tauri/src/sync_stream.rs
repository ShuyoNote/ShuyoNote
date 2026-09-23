//! 桌面「近实时」流通道：**纯函数内核**（设计稿 §7 第 1 步）＋ **订阅任务与命令面**（第 2 步）。
//!
//! 纯函数那一半（`drain_sse_frames` / `backoff_ms` / `frame_kind` / `stream_url`）**不碰网络、不碰
//! Tauri** —— 它们是最容易写错、也最值得先钉住的部分；下半段（`sync_stream_*` 三条命令）只负责
//! "把字节流接起来、把状态如实说出来"。
//!
//! 设计稿：`docs/plans/2026-09-23-desktop-near-realtime-stream-design.md`（判据 1/2/3/6/7）。
//!
//! ## 三条口径（与设计稿逐条对应，别在这里"顺手优化"）
//!
//! 1. **半帧必须留在缓冲里**：SSE 是流式协议，一次 `read` 回来的可能是"半个事件"
//!    ⇒ 纯函数收**累计缓冲**、吐**切出来的帧 ＋ 新的剩余缓冲**；调用方（本文件下半段）把剩余带进下一次。
//! 2. **注释帧不算事件、但算"连接活着"**：服务端 axum 的 `KeepAlive` 约 15s 发一条 `:`
//!    注释帧 ⇒ 只切它、不产出载荷；退避在"连上了"那一刻就清零（不是按"有没有帧"）。
//! 3. ⚠️ **`ping` 不是心跳**（设计稿 §6.2）：服务端在订阅者**落后**（broadcast 容量 64）时发的
//!    `{"type":"ping"}` 意味着**可能漏了事件** ⇒ 调用方必须**立刻拉一次**，与收到 `push` 同待遇。
//!    `frame_kind` 只负责**分类**（给事件载荷里的 `kind` 用），**不**决定"拉不拉"。

use std::sync::{Mutex, OnceLock};

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::db::Db;

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

// =====================================================================================
// 订阅任务 ＋ 状态机 ＋ 命令面（设计稿 §4.1/§4.2/§7 第 2 步）
// =====================================================================================

/// 订阅地址（纯函数，方便判据）：`{server}/spaces/{space_id}/changes-stream`。
///
/// 与前端 `useSyncStream.ts` 拼的是**同一条路径**（服务端 `main.rs` 的 `sync_routes`）。
/// ⚠️ 服务端地址的结尾斜杠在这里归一（前端也是这么做的）；`space_id` 是服务端生成的十六进制，
/// **不需要**百分号编码（与前端 `encodeURIComponent` 的效果一致，这里不为它引一层依赖）。
pub fn stream_url(server: &str, space_id: &str) -> String {
    format!("{}/spaces/{}/changes-stream", server.trim_end_matches('/'), space_id)
}

/// 发给前端的事件载荷：**只是"有变更"这个信号**，不含任何页面内容（与服务端一致）。
#[derive(Debug, Clone, Serialize)]
pub struct StreamChange {
    pub ws_id: String,
    pub server: String,
    /// `push` / `ping` / `other`（见 `frame_kind`）。
    pub kind: String,
}

/// 订阅的**读数**（界面/排错要看的就是这几个数，别让它石沉大海）。
#[derive(Debug, Clone, Default, Serialize)]
pub struct StreamStatus {
    pub running: bool,
    pub ws_id: String,
    pub server: String,
    /// 最近一次收到帧的时刻（ms；`0` ＝ 还没收到过）。
    pub last_event_at: i64,
    /// 当前这轮**连续**重连次数（成功收到帧后清零）。
    pub reconnects: u32,
    /// 最近一次失败的原因 —— **不静默**：界面要能说出"为什么没有近实时"。
    /// 没有同步配置时它是空的（那不是错误，是**正常情况**）。
    pub last_error: String,
    /// 为什么没在跑（正常情况也走它）：`"no-binding"` / `""`。
    pub reason: String,
}

struct Running {
    status: StreamStatus,
    handle: tokio::task::JoinHandle<()>,
}

fn slot() -> &'static Mutex<Option<Running>> {
    static SLOT: OnceLock<Mutex<Option<Running>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 读一份当前状态（`None` 的槽位 ⇒ "没在跑"，不是错误）。
fn snapshot() -> StreamStatus {
    let guard = slot().lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().map(|r| r.status.clone()).unwrap_or_default()
}

/// 就地改状态（**只做极短的锁内操作**，绝不在持锁时 await —— 那是本仓踩过的坑）。
fn with_status<F: FnOnce(&mut StreamStatus)>(f: F) {
    let mut guard = slot().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(r) = guard.as_mut() {
        f(&mut r.status);
    }
}

/// 停掉当前订阅（幂等）。返回停止**之后**的状态。
fn stop_locked() -> StreamStatus {
    let mut guard = slot().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(r) = guard.take() {
        r.handle.abort();
    }
    StreamStatus::default()
}

/// **起（或重起）订阅**：`ws_id` ⇒ 复用 `sync::claim_config` 解析绑定。
///
/// ⚠️ **没绑定/绑不全 ⇒ 不起流、也不抛**（＝"用不了"，不是错误 —— 与 claim / 第 38 轮那条同一口径）。
/// 返回的状态里 `running=false` ＋ `reason="no-binding"`，界面据此**如实**说"没配同步"。
#[tauri::command]
pub async fn sync_stream_start(
    app: AppHandle,
    db: State<'_, Db>,
    ws_id: String,
) -> Result<StreamStatus, String> {
    // ① 解析绑定（锁只在**同步**代码里，不跨 await）
    let resolved = {
        let c = db.0.lock().expect("db mutex poisoned");
        crate::sync::claim_config(&c, &ws_id)?
    };
    let Some((server, token, space_id)) = resolved else {
        stop_locked();
        return Ok(StreamStatus {
            running: false,
            ws_id,
            reason: "no-binding".to_string(),
            ..Default::default()
        });
    };

    // ② 停掉旧的，装上新的
    stop_locked();
    let url = stream_url(&server, &space_id);
    let status = StreamStatus {
        running: true,
        ws_id: ws_id.clone(),
        server: server.clone(),
        ..Default::default()
    };
    let app2 = app.clone();
    let ws2 = ws_id.clone();
    let server2 = server.clone();
    let handle = tokio::spawn(async move {
        let mut attempt: u32 = 0;
        loop {
            let client = reqwest::Client::new();
            let mut req = client.get(&url);
            if !token.is_empty() {
                req = req.bearer_auth(&token);
            }
            let outcome: Result<(), String> = match req.send().await {
                Ok(resp) if resp.status().is_success() => {
                    with_status(|s| {
                        s.reconnects = 0;
                        s.last_error.clear();
                    });
                    attempt = 0;
                    let mut buf = String::new();
                    let mut stream = resp.bytes_stream();
                    let mut err = None;
                    while let Some(chunk) = stream.next().await {
                        match chunk {
                            Ok(bytes) => {
                                buf.push_str(&String::from_utf8_lossy(&bytes));
                                let (frames, rest) = drain_sse_frames(&buf);
                                buf = rest;
                                for f in frames {
                                    let kind = frame_kind(&f).to_string();
                                    let _ = app2.emit(
                                        "sync-stream-change",
                                        StreamChange {
                                            ws_id: ws2.clone(),
                                            server: server2.clone(),
                                            kind,
                                        },
                                    );
                                    with_status(|s| s.last_event_at = now_ms());
                                }
                            }
                            Err(e) => {
                                err = Some(e.to_string());
                                break;
                            }
                        }
                    }
                    match err {
                        Some(e) => Err(e),
                        None => Err("连接被服务端关闭".to_string()),
                    }
                }
                Ok(resp) => Err(format!("HTTP {}", resp.status())),
                Err(e) => Err(e.to_string()),
            };

            if let Err(e) = outcome {
                // **不静默**：留痕（界面能读到 `last_error`），然后退避重连。
                with_status(|s| s.last_error = e);
            }
            // 退避后重连（`stop` 会 abort 掉这个任务本身，所以这里不必再查"该不该继续"）。
            attempt = attempt.saturating_add(1);
            with_status(|s| s.reconnects = attempt);
            tokio::time::sleep(std::time::Duration::from_millis(backoff_ms(attempt - 1))).await;
        }
    });

    {
        let mut guard = slot().lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(Running { status: status.clone(), handle });
    }
    Ok(status)
}

/// **断开且不再重连**（用户关开关、退出登录、切工作空间时调）。幂等。
#[tauri::command]
pub fn sync_stream_stop() -> StreamStatus {
    stop_locked()
}

/// 当前读数（界面排错用）。没在跑 ⇒ 全默认（`running=false`）。
#[tauri::command]
pub fn sync_stream_status() -> StreamStatus {
    snapshot()
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

    /// 判据 3（前半）：**订谁的地址** —— 与前端拼的是同一条路径，且结尾斜杠要归一。
    #[test]
    fn stream_url_matches_the_web_side_and_normalizes_slashes() {
        assert_eq!(
            stream_url("https://shuyo.cn/sync", "ab12"),
            "https://shuyo.cn/sync/spaces/ab12/changes-stream"
        );
        assert_eq!(
            stream_url("https://shuyo.cn/sync/", "ab12"),
            "https://shuyo.cn/sync/spaces/ab12/changes-stream",
            "结尾斜杠要被归一（与前端 `server.replace(/\\/+$/,'')` 同一效果）"
        );
        assert_eq!(stream_url("http://127.0.0.1:8787", "sp"), "http://127.0.0.1:8787/spaces/sp/changes-stream");
    }

    /// 判据 6/7（可判的那一半）：**没在跑时读数是"全默认"**（`running=false`），
    /// 而 `reason` 能说出"为什么没在跑"（`no-binding` 是**正常情况**，不是错误）。
    #[test]
    fn status_defaults_say_not_running_and_can_explain_why() {
        let s = StreamStatus::default();
        assert!(!s.running);
        assert_eq!(s.last_event_at, 0);
        assert_eq!(s.reconnects, 0);
        assert!(s.last_error.is_empty(), "没跑 ≠ 有错");
        let s = StreamStatus {
            reason: "no-binding".to_string(),
            ..Default::default()
        };
        assert_eq!(s.reason, "no-binding");
    }
}
