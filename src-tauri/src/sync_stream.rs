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
/// ⚠️ `server` 现在是**已经解析好的基址**（甲-1 接线：局域网发现到的中枢优先，见
/// `sync::effective_base_for`）—— 本函数**不**自己去查对端表：它要保持纯函数（有判据），
/// 而"这一轮走哪个地址"必须与 push/pull/附件**同源**（"基址只出一处"）。
///
/// 与前端 `useSyncStream.ts` 拼的是**同一条路径**（服务端 `main.rs` 的 `sync_routes`）。
/// ⚠️ 服务端地址的结尾斜杠在这里归一（前端也是这么做的）；`space_id` 是服务端生成的十六进制，
/// **不需要**百分号编码（与前端 `encodeURIComponent` 的效果一致，这里不为它引一层依赖）。
pub fn stream_url(server: &str, space_id: &str) -> String {
    format!("{}/spaces/{}/changes-stream", server.trim_end_matches('/'), space_id)
}

// -------------------------------------------------------------------------------------
// **一次连接** 与 **重连循环**（设计稿 §4.1；判据 5 就靠这两个函数被直接驱动）
//
// 为什么要把它们从命令里抽出来：命令那一半要 `AppHandle` 才能跑（发事件），而"连上 ⇒ 收帧 ⇒ 断开 ⇒
// 退避 ⇒ 重连 ⇒ 再收帧"这条**语义**才是判据 5 要钉的东西。抽成两个吃**回调**的函数之后，
// 端到端判据可以喂给它一个**假的 SSE 服务端**（本文件 `tests` 里那个），确定性拿到读数 ——
// 不必起一个 Tauri 应用。命令那一半只是把这些回调接到"全局状态 ＋ `app.emit`"上。
// -------------------------------------------------------------------------------------

/// **一次连接**：读到断开为止；每次成功连上 ⇒ 回调一次"连上了"，每切出一帧 ⇒ 回调一次载荷。
///
/// 返回 `Err` ＝ 这一轮**没连上或读断了**（调用方据此**留痕**并退避重连）——
/// 注意"服务端正常关闭"也走 `Err`（那就是"该重连了"）。
///
/// ⚠️ 回调上那个 `+ Send` 不是装饰：命令那一半要把循环 `tokio::spawn` 出去
/// （`spawn` 要求 future `Send`），而 `&mut dyn FnMut(..)` 不带 `Send` 时整条 future 就不是 `Send`
/// —— 编译期会报"future cannot be sent between threads safely"（第一版就是这么被挡下的）。
pub async fn read_stream_once(
    url: &str,
    token: &str,
    on_connected: &mut (dyn FnMut() + Send),
    on_frame: &mut (dyn FnMut(&str) + Send),
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let mut req = client.get(url);
    if !token.is_empty() {
        req = req.bearer_auth(token);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    // 连上了才回调（调用方用它清"连续重连计数"与 `last_error`）。
    on_connected();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        let (frames, rest) = drain_sse_frames(&buf);
        buf = rest;
        for f in frames {
            on_frame(&f);
        }
    }
    Err("连接被服务端关闭".to_string())
}

/// **重连循环**：连不上/断了 ⇒ 退避（1s→2s→…→30s）再试，直到 `should_stop()` 说停。
///
/// `should_stop` 是给**判据**用的（跑够两轮就收工）；生产那条路靠 `stop()` abort 任务本身。
pub async fn run_stream_with_reconnect(
    url: &str,
    token: &str,
    on_connected: &mut (dyn FnMut() + Send),
    on_frame: &mut (dyn FnMut(&str) + Send),
    on_error: &mut (dyn FnMut(&str) + Send),
    on_retry: &mut (dyn FnMut(u32) + Send),
    should_stop: &mut (dyn FnMut() -> bool + Send),
) {
    let mut attempt: u32 = 0;
    loop {
        if should_stop() {
            return;
        }
        if let Err(e) = read_stream_once(url, token, on_connected, on_frame).await {
            on_error(&e);
        }
        if should_stop() {
            return;
        }
        attempt = attempt.saturating_add(1);
        on_retry(attempt);
        tokio::time::sleep(std::time::Duration::from_millis(backoff_ms(attempt - 1))).await;
    }
}

/// 把「一次连接 / 重连循环」接到 **全局状态** 上，并把每帧交给 `notify` 去"告诉前端"。
///
/// 抽出来的理由（照本文件上半段那条同一逻辑）：**状态那几笔账**（`reconnects` 清零、
/// `last_error` 留痕、`last_event_at` 记时刻）与 `StreamChange` 的构造是**语义**，
/// 而"发给谁"只是**出口**。生产那条路传的是 `|ch| app.emit("sync-stream-change", ch)`；
/// 判据里没有 `AppHandle`，于是传一个"只记 kind"的闭包 —— 这样**判据 6 走的就不是复制品**：
/// 起流、收帧、`reconnects/last_error` 这几笔账全是生产那一份代码，只有出口被换掉。
///
/// `notify` 是 `Fn + Send + 'static`：它会被移进 `on_frame`（那个闭包要满足
/// `read_stream_once` 的 `+ Send` 约束 —— 见那边的注释）。
pub async fn run_stream_task<F>(url: String, token: String, ws_id: String, server: String, notify: F)
where
    F: Fn(StreamChange) + Send + 'static,
{
    let mut on_connected = || {
        with_status(|s| {
            s.reconnects = 0;
            s.last_error.clear();
        });
    };
    let mut on_frame = move |payload: &str| {
        let kind = frame_kind(payload).to_string();
        notify(StreamChange {
            ws_id: ws_id.clone(),
            server: server.clone(),
            kind,
        });
        with_status(|s| s.last_event_at = now_ms());
    };
    let mut on_error = |e: &str| {
        // **不静默**：留痕（界面能读到 `last_error`），随后由循环退避重连。
        with_status(|s| s.last_error = e.to_string());
    };
    let mut on_retry = |n: u32| {
        with_status(|s| s.reconnects = n);
    };
    // `stop()` 用 abort 停这条任务本身 ⇒ 这里不需要第二个停止条件。
    let mut should_stop = || false;
    run_stream_with_reconnect(
        &url,
        &token,
        &mut on_connected,
        &mut on_frame,
        &mut on_error,
        &mut on_retry,
        &mut should_stop,
    )
    .await;
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
    // ① 解析绑定 ＋ 基址（锁只在**同步**代码里，不跨 await）
    let resolved = {
        let c = db.0.lock().expect("db mutex poisoned");
        crate::sync::claim_config(&c, &ws_id)?.map(|(server, token, space_id)| {
            // ★ 甲-1 接线：订流也走**解析后的基址**（局域网中枢优先）—— 它与 push/pull/附件
            //   必须同源，否则"push 走局域网、流还连着公网"，而那种漂**只有真机拔网线才看得出来**。
            // ⚠️ 凭证仍按**配置地址**取（`claim_config` 就是这么取的），只有地址换档。
            let base = crate::sync::effective_base_for(&c, &space_id, &server)
                .unwrap_or_else(|| server.clone());
            (base, token, space_id)
        })
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
    let handle = tokio::spawn(run_stream_task(url, token, ws_id.clone(), server.clone(), move |ch| {
        // 出口：把"有变更"这个信号发给前端（**不带内容**）。语义在 `run_stream_task` 里（有判据）。
        let _ = app2.emit("sync-stream-change", ch);
    }));

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

    // ---------------------------------------------------------------------------------
    // 判据 5（客户端那一半）：端到端 —— **断开 ⇒ 退避 ⇒ 重连 ⇒ 恢复**
    //
    // 为什么能在单测里做：`run_stream_with_reconnect` 吃的是**回调**（见文件上半段），所以这里喂它一个
    // **假的 SSE 服务端**就够 —— 那个小服务端每接受一次连接就发一帧、然后**关掉连接**
    // （＝模拟"被代理掐断/网络抖动"），于是循环必须退避后再连一次，才能拿到第二帧。
    // 这样"重连并恢复"是**确定性**读数，不需要停真服务端、也不需要起 Tauri 应用。
    // ---------------------------------------------------------------------------------

    /// 假 SSE 服务端：`frames.len()` 次"接受 ⇒ 发一帧 ⇒ 关闭"。
    /// 返回 `(port, 句柄)`。用裸 TCP（tokio `net`）写最小的 HTTP 响应，不引额外依赖。
    async fn fake_sse_server(frames: Vec<String>) -> (u16, tokio::task::JoinHandle<()>) {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let handle = tokio::spawn(async move {
            for f in frames {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                // 先读掉请求（免得对端写阻塞）；这里只读一次，够用。
                let mut buf = [0u8; 1024];
                let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await;
                let body = format!("data: {f}\n\n");
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(body.as_bytes()).await;
                let _ = sock.flush().await;
                // ⚠️ **关掉连接** —— 这一步就是"拔网"的替身：循环必须自己退避重连。
                drop(sock);
            }
            // 帧发完了：保持 listener 活着，别让客户端连出"端口拒绝"（那是另一种失败，另有判据）。
            loop {
                let Ok((sock, _)) = listener.accept().await else { return };
                drop(sock);
            }
        });
        (port, handle)
    }

    /// ★ 判据 5：**断开 ⇒ 退避（≥ 一个退避窗口）⇒ 重连 ⇒ 第二帧照样收到**。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reconnects_after_a_drop_and_recovers() {
        let (port, server) = fake_sse_server(vec![
            r#"{"type":"push","accepted":1}"#.to_string(),
            r#"{"type":"push","accepted":2}"#.to_string(),
        ])
        .await;
        let url = stream_url(&format!("http://127.0.0.1:{port}"), "sp");

        let got: std::sync::Arc<std::sync::Mutex<Vec<(i64, String)>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let connects = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let retries = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u32>::new()));
        let errors = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

        let (g, c, r, e, s) = (got.clone(), connects.clone(), retries.clone(), errors.clone(), stop.clone());
        let mut on_connected = || {
            c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        };
        let mut on_frame = |p: &str| {
            let mut v = g.lock().unwrap();
            v.push((now_ms(), p.to_string()));
            if v.len() >= 2 {
                // 两帧都到手 ⇒ 让循环收工（判据不该靠超时结束）
                s.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        };
        let mut on_error = |msg: &str| {
            e.lock().unwrap().push(msg.to_string());
        };
        let mut on_retry = |n: u32| {
            r.lock().unwrap().push(n);
        };
        let mut should_stop = || s.load(std::sync::atomic::Ordering::SeqCst);

        let started = now_ms();
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            run_stream_with_reconnect(
                &url,
                "tk",
                &mut on_connected,
                &mut on_frame,
                &mut on_error,
                &mut on_retry,
                &mut should_stop,
            ),
        )
        .await
        .expect("10s 内应当收满两帧（重连循环没停）");

        let frames = got.lock().unwrap().clone();
        let retry_seq = retries.lock().unwrap().clone();
        let errs = errors.lock().unwrap().clone();
        let connects = connects.load(std::sync::atomic::Ordering::SeqCst);
        server.abort();

        println!(
            "【判据 5 实测】连接 {connects} 次 · 帧 {} 条 · 重试序列 {retry_seq:?} · 首条错 {:?} · 两帧间隔 {}ms",
            frames.len(),
            errs.first(),
            frames.get(1).map(|f| f.0 - frames[0].0).unwrap_or(-1)
        );

        assert_eq!(frames.len(), 2, "两帧都要收到（第二帧只在重连之后才可能到）");
        assert_eq!(frame_kind(&frames[0].1), "push");
        assert_eq!(frame_kind(&frames[1].1), "push");
        assert!(connects >= 2, "必须**重连**过一次（连接数 ≥ 2），实际 {connects}");
        assert_eq!(retry_seq.first(), Some(&1), "第一次断开后应当记一次重试（从 1 开始）");
        assert!(
            !errs.is_empty(),
            "断开必须**有痕**（`on_error` 被调到）—— 静默重连是本仓最忌的形状"
        );
        let gap = frames[1].0 - frames[0].0;
        assert!(
            gap >= 900,
            "两帧之间必须**真的退避过**（≈1s 起步），实际间隔 {gap}ms —— 小于它就是紧凑重连（打服务端）"
        );
        assert!(frames[1].0 - started < 10_000, "恢复要在 10s 内");
    }

    /// 判据 5：**连不上 ⇒ `Err` 且带原因**（"有痕"，不是静默死循环）。
    ///
    /// 用 127.0.0.1:1（保留端口，必然拒绝）当"拔网"的替身。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unreachable_server_surfaces_an_error() {
        let mut connected = || panic!("不该连上");
        let mut frames = |_: &str| panic!("不该收到帧");
        let err = read_stream_once("http://127.0.0.1:1/spaces/sp/changes-stream", "tk", &mut connected, &mut frames)
            .await
            .expect_err("连不上就该是 Err");
        println!("【判据 5 实测】连不上时的原因 = {err}");
        assert!(!err.is_empty(), "错误文本不能空（界面要能说出来）");
    }

    // ---------------------------------------------------------------------------------
    // 判据 6 的**真行为**：连上、收到帧之后关开关 ⇒ 立刻断、状态翻 false、**不再重连/不再收帧**
    //
    // 与判据 5 同一个手法（假 SSE 服务端），但这次服务端**保持连接、持续推**：
    // 于是"关掉之后还收不收得到帧"是可判的 —— 如果 `abort` 没真的把任务停掉，
    // 帧计数会继续涨（连接还开着，循环也不会"重连"，所以只有这条断言抓得住它）。
    // ---------------------------------------------------------------------------------

    /// 持续推送的假 SSE 服务端：一条连接上每 `interval_ms` 发一帧、**不主动关闭**。
    ///
    /// 记账（判据读它）：`connects` = 一共接受了几次连接（**"有没有重连"就看它**）、
    /// `sent` = 成功写出去了几帧。写失败（对端断开/任务被 abort 后 socket 关闭）⇒ 只结束**这条**
    /// 连接，外层继续 `accept` —— 这样"关掉之后又连回来了"会被 `connects` 抓住。
    async fn streaming_sse_server(
        interval_ms: u64,
        connects: std::sync::Arc<std::sync::atomic::AtomicU32>,
        sent: std::sync::Arc<std::sync::atomic::AtomicU32>,
    ) -> (u16, tokio::task::JoinHandle<()>) {
        use std::sync::atomic::Ordering::SeqCst;
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                connects.fetch_add(1, SeqCst);
                let sent2 = sent.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await;
                    // ⚠️ 没有 `Content-Length` + `Connection: close` ⇒ hyper 按"读到 EOF 为止"收流，
                    //    于是每帧写完就能被 `bytes_stream()` 立刻吐出来（不需要自己拼 chunked 分块）。
                    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
                    if sock.write_all(head.as_bytes()).await.is_err() || sock.flush().await.is_err() {
                        return;
                    }
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
                        let n = sent2.load(SeqCst) + 1;
                        let body = format!("data: {{\"type\":\"push\",\"accepted\":{n}}}\n\n");
                        if sock.write_all(body.as_bytes()).await.is_err() || sock.flush().await.is_err() {
                            return; // 对端关了 ⇒ 这条连接结束（外层继续等下一次连接）
                        }
                        sent2.fetch_add(1, SeqCst);
                    }
                });
            }
        });
        (port, handle)
    }

    /// ★ 判据 6（**真行为**）：连上并收到帧之后关开关 ⇒ 立刻断、`running=false`、不再收帧、不再重连。
    ///
    /// 走的是**生产那一份代码**：`run_stream_task`（状态那几笔账 ＋ `StreamChange` 构造）
    /// ＋ `sync_stream_stop`（真正的停止路径，`stop_locked` 里 `abort` 任务）。
    /// 唯一被替掉的只有 `app.emit` 那个**出口**（单测里没有 `AppHandle`，喂一个只记 `kind` 的闭包）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stop_while_streaming_disconnects_and_stops_reconnecting() {
        use std::sync::atomic::{AtomicU32, Ordering::SeqCst};
        let connects = std::sync::Arc::new(AtomicU32::new(0));
        let sent = std::sync::Arc::new(AtomicU32::new(0));
        let (port, server) = streaming_sse_server(60, connects.clone(), sent.clone()).await;
        let server_url = format!("http://127.0.0.1:{port}");
        let url = stream_url(&server_url, "sp");

        // 按生产的方式"装上"：状态进槽位、任务跑 `run_stream_task`
        let kinds: std::sync::Arc<std::sync::Mutex<Vec<String>>> = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let k2 = kinds.clone();
        let status = StreamStatus {
            running: true,
            ws_id: "ws-1".to_string(),
            server: server_url.clone(),
            ..Default::default()
        };
        let handle = tokio::spawn(run_stream_task(url.clone(), "tk".to_string(), "ws-1".to_string(), server_url.clone(), move |ch: StreamChange| {
            k2.lock().unwrap().push(ch.kind);
        }));
        {
            let mut g = slot().lock().unwrap_or_else(|e| e.into_inner());
            *g = Some(Running { status, handle });
        }

        // ① 连上并**正在流**（等到 ≥2 帧 —— 一帧也可能只是"刚好收到"，两帧才说明流是活的）
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline && kinds.lock().unwrap().len() < 2 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let before = snapshot();
        assert!(before.running, "起流之后状态必须 running=true");
        assert_eq!(before.ws_id, "ws-1", "状态要如实说出订的是哪个工作空间");
        assert_eq!(before.server, server_url, "状态要如实说出连的是哪个服务端");
        assert!(before.last_event_at > 0, "收到帧要记下时刻（界面排错靠它）");
        assert!(kinds.lock().unwrap().len() >= 2, "持续推送的服务端应当已经送来 ≥2 帧");
        assert_eq!(connects.load(SeqCst), 1, "只该连一次（还没发生任何断开）");

        // ② 关开关（**生产命令**）
        let after = sync_stream_stop();
        let frames_at_stop = kinds.lock().unwrap().len();
        let sent_at_stop = sent.load(SeqCst);
        assert!(!after.running, "关掉之后**返回的**状态必须 running=false");
        assert!(!sync_stream_status().running, "槽位也要真的清空（`sync_stream_status` 读的就是它）");

        // ③ 再等 500ms（服务端还在推：这条连接每 60ms 一帧，5 倍以上窗口）
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let frames_later = kinds.lock().unwrap().len();
        let connects_later = connects.load(SeqCst);
        let sent_later = sent.load(SeqCst);
        server.abort();

        println!(
            "【判据 6 实测】关前：running=true · 已收 {frames_at_stop} 帧 · 连接 1 次；\
             关后 500ms：帧仍 {frames_later} 条（服务端那 500ms 里只又写出去 {} 帧就写不动了）\
              · 连接仍 {connects_later} 次 ⇒ **立刻断、不重连、不再收帧**",
            sent_later - sent_at_stop
        );

        assert_eq!(
            frames_later, frames_at_stop,
            "关掉之后**不许再收到帧**（`abort` 必须真的停掉任务；否则连接还开着，帧会继续到）"
        );
        assert_eq!(connects_later, 1, "关掉之后**不许重连**（实际连接 {connects_later} 次）");
        // "立刻断"不只是"回调没人调了"：socket 也得真的关掉 —— 服务端那边**写不进去**了，
        // 所以停掉之后它最多再写成 1 帧（可能正在写的那一帧进了内核缓冲），之后所有写都失败。
        assert!(
            sent_later - sent_at_stop <= 1,
            "关掉之后服务端居然还能写出去 {} 帧 ⇒ 连接没真的断（`abort` 没关掉 socket）",
            sent_later - sent_at_stop
        );
    }

    /// 判据 5（**与真服务端**的那一半）：注册 ⇒ 建空间 ⇒ 订阅 ⇒ `/push` 一笔 ⇒ **收到推送**。
    ///
    /// ⚠️ **自报跳过**：没设 `SHUYONOTE_STREAM_E2E_SERVER`（例如 `http://127.0.0.1:8787`）就跳过 ——
    /// 与 `rust-sm-wired` / artifact 组同一条纪律：**宁可自报跳过，也不假装绿**。
    /// 本机跑法（设计稿 §5 有记）：先起本地服务端，再
    /// `SHUYONOTE_STREAM_E2E_SERVER=http://127.0.0.1:8787 win-cargo-test.ps1 -Filter e2e_`。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn e2e_receives_a_push_from_a_real_server() {
        let Ok(server) = std::env::var("SHUYONOTE_STREAM_E2E_SERVER") else {
            eprintln!("[自报跳过] 没设 SHUYONOTE_STREAM_E2E_SERVER ⇒ 与真服务端的端到端判据**未跑**");
            return;
        };
        let server = server.trim_end_matches('/').to_string();
        let client = reqwest::Client::new();
        let uniq = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        // ① 注册（老服务端可能不要 display / register_code，两种都试）
        let email = format!("stream-e2e-{uniq}@test.local");
        let body = serde_json::json!({ "email": email, "password": "stream-e2e-pass", "display": "streamE2E" });
        let reg = client
            .post(format!("{server}/auth/register"))
            .json(&body)
            .send()
            .await
            .expect("register 请求发出");
        assert!(reg.status().is_success(), "注册失败：HTTP {}", reg.status());
        let token = reg.json::<Value>().await.expect("register 返回 JSON")["token"]
            .as_str()
            .expect("register 返回 token")
            .to_string();
        // ② 建空间
        let sp = client
            .post(format!("{server}/spaces"))
            .bearer_auth(&token)
            .json(&serde_json::json!({ "name": "stream-e2e" }))
            .send()
            .await
            .expect("create space 请求发出");
        assert!(sp.status().is_success(), "建空间失败：HTTP {}", sp.status());
        let space = sp.json::<Value>().await.expect("space JSON")["id"]
            .as_str()
            .expect("space id")
            .to_string();

        // ③ 订阅（后台任务）：收到帧就记时间
        let url = stream_url(&server, &space);
        let got: std::sync::Arc<std::sync::Mutex<Vec<(i64, String)>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (g, s) = (got.clone(), stop.clone());
        let (u, t) = (url.clone(), token.clone());
        let sub = tokio::spawn(async move {
            let mut on_connected = || {};
            let mut on_frame = |p: &str| {
                let mut v = g.lock().unwrap();
                v.push((now_ms(), p.to_string()));
                s.store(true, std::sync::atomic::Ordering::SeqCst);
            };
            let mut on_error = |_e: &str| {};
            let mut on_retry = |_n: u32| {};
            let mut should_stop = || s.load(std::sync::atomic::Ordering::SeqCst);
            run_stream_with_reconnect(
                &u,
                &t,
                &mut on_connected,
                &mut on_frame,
                &mut on_error,
                &mut on_retry,
                &mut should_stop,
            )
            .await;
        });

        // 订阅是"连接建立后才挂到服务端 broadcast 上"的 ⇒ 给一点时间再推（与 JS 回归脚本同一手法）
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        let sent = now_ms();
        let pushed = client
            .post(format!("{server}/push"))
            .bearer_auth(&token)
            .json(&serde_json::json!({
                "device_id": format!("dev-{uniq}"),
                "space_id": space,
                "changes": [{
                    "device_seq": 1, "entity": "page", "entity_id": "page-stream-e2e",
                    "op": "upsert", "payload": "{}", "updated_at": uniq,
                }],
            }))
            .send()
            .await
            .expect("push 请求发出");
        assert!(pushed.status().is_success(), "push 失败：HTTP {}", pushed.status());

        // ④ 断言"2s 内收到"（判据 5 的延迟口径）
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline && got.lock().unwrap().is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let frames = got.lock().unwrap().clone();
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        sub.abort();
        assert!(!frames.is_empty(), "订阅 2s 内**没有**收到推送（判据 5 红）");
        let latency = frames[0].0 - sent;
        println!("【判据 5 实测·真服务端】订阅 ⇒ 推送 ⇒ 收到：**{latency}ms**；帧 = {}", frames[0].1);
        assert!(latency >= 0 && latency < 2000, "延迟要在 2s 内（实际 {latency}ms）");
        assert_eq!(frame_kind(&frames[0].1), "push");
    }
}
