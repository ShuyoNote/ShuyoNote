//! `mcp_channel.rs` —— MCP **宿主面那半**「本机通道」：**方向 ②（桥 → App，App 当服务端）** ✓
//!
//! 判据：`scripts/check-mcp-host-channel.mjs`（五条：默认关／只绑回环／token 从文件读／
//! `Origin`·`Host` **恰好回环**／必须走唯一入口 ✓）。裁定与执行顺序见
//! `_workspace/notes/2026-10-01-task5-host-face-plan-windows.md` §8 ✓。
//!
//! ## 这套东西的形状（都是**契约**，不是随手定的 ✓）
//! * **默认关** ✓：`MCP_CHANNEL_ENABLED = false` ＋ 只在 `SHUYONOTE_MCP_SWITCH=on` 时才起监听 ✓。
//!   "默认开着、只是别人不知道"不算默认关 ✗。
//! * **只绑回环** ✓：`127.0.0.1:0`（临时端口 ✓）—— 同网段任何设备都连不上 ✓。
//! * **per-session token 从文件读** ✓：`SHUYONOTE_MCP_TOKEN_FILE` 指向一个 0600 文件 ✓，
//!   第 1 行＝本次会话令牌 ✓；第 2 行（可选）＝逗号分隔的**被授予权限** ✓（不写 ⇒ 空 ⇒ 能力调用会被
//!   唯一鉴权点按 `permission_denied` 拒 ✓ —— 默认取最窄，不是最宽 ✓）。
//! * **`Origin`／`Host` 必须恰好回环** ✓ —— **不许前缀匹配** ✗：本仓真栽过
//!   「CORS 前缀匹配放过 `http://127.0.0.1.evil.com`」（`docs/SECURITY.md` 低危项逐字 ✓）。
//! * **端口公布**：生效后把实际端口写进 `SHUYONOTE_MCP_PORT_FILE`（缺省＝令牌文件同目录的
//!   `mcp-channel.port` ✓）—— 桥（客户端那侧）照它连 ✓；写成文件而不是 stdout/stderr ✓，
//!   因为 App 与桥之间**没有** stdio 关系 ✓。
//! * **唯一入口** ✓：收到请求只调 `mcp_host::handle_external_call` ✓；
//!   本模块**不判权限、不开库、不写审计** ✓（那些都只有一处 ✓）。
//!
//! ## 本模块**不做**什么（照实 ✓）
//! * 不是通用 HTTP 服务器 ✗：只认 `POST /call` ＋ `Content-Length` ＋ 关连接 ✓（够本机一跳用 ✓）。
//! * 不做 TLS ✗（只绑回环 ⇒ 出不了本机 ✓）。
//! * 不动 TLS/会话层之外的任何状态 ✓（每次调用都当**新的一次外部调用** ✓，会话号由令牌派生 ✓）。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

/// ⚠️ **默认关** ✓ —— 判据 `check-mcp-host-channel` 的第①条就钉这个声明与它的初值 ✓。
pub const MCP_CHANNEL_ENABLED: bool = false;

const SWITCH_ENV: &str = "SHUYONOTE_MCP_SWITCH";
const TOKEN_FILE_ENV: &str = "SHUYONOTE_MCP_TOKEN_FILE";
const PORT_FILE_ENV: &str = "SHUYONOTE_MCP_PORT_FILE";
/// 只绑回环 ✓（判据第②条同时禁止 `0.0.0.0` 与 `Ipv4Addr::UNSPECIFIED` ✓）。
const LOOPBACK: &str = "127.0.0.1";
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// 本次会话的通道配置（**只在开关打开且令牌可读时**才存在 ✓）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelConfig {
    /// 会话令牌（**不进审计** ✓ —— 审计里用的是由它派生的会话号 ✓）
    pub token: String,
    /// 这次会话**被授予**的权限 ✓（空 ⇒ 默认最窄 ✓）
    pub granted: Vec<String>,
    /// 端口公布文件 ✓
    pub port_file: String,
    /// 由令牌派生的会话号（进审计 `source = external:<它>` ✓，**不含令牌本身** ✓）
    pub session_id: String,
}

/// 由令牌派生一个**短会话号** ✓（FNV-1a ⇒ 稳定、不可逆、够短 ✓）。
///
/// 为什么不直接用令牌当会话号 ✗：审计环是给**人看**的（"谁读过我的库" ✓），
/// 把令牌原文写进去等于把secret 落进审计 ✓ —— 那正是本仓禁止的形状 ✓。
pub fn session_id_of(token: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in token.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("mcp-{:08x}", (h & 0xffff_ffff) as u32)
}

/// 解析令牌文件：第 1 行＝令牌 ✓；第 2 行（可选）＝逗号分隔的权限 ✓。
pub fn parse_token_file(text: &str) -> Option<(String, Vec<String>)> {
    let mut lines = text.lines();
    let token = lines.next().unwrap_or("").trim().to_string();
    if token.is_empty() {
        return None;
    }
    let granted = lines
        .next()
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    Some((token, granted))
}

/// `Origin` 必须**恰好**是回环 http 源 ✓ —— `http://127.0.0.1[:port]` ／ `http://localhost[:port]` ✓。
///
/// ⚠️ 刻意**不用**前缀匹配 ✗：`http://127.0.0.1.evil.com` 前缀一样、却**不是**回环 ✓（本仓真栽过 ✓）。
pub fn origin_ok(origin: Option<&str>) -> bool {
    let Some(o) = origin else { return true }; // 原生客户端（桥）可能不发 `Origin` ✓（但 `Host` 仍要核 ✓）
    if o.is_empty() {
        return true;
    }
    let Some(rest) = o.strip_prefix("http://") else { return false };
    loopback_host_port_ok(rest)
}

/// `Host` 必须是回环（防 DNS rebinding ✓）：`127.0.0.1[:port]` ／ `localhost[:port]` ✓。
pub fn host_ok(host: Option<&str>) -> bool {
    match host {
        Some(h) if !h.is_empty() => loopback_host_port_ok(h),
        _ => false, // Host 缺失 ⇒ 拒 ✓（这是与 Origin 不同的地方：Origin 可缺、Host 不可缺 ✓）
    }
}

/// `host[:port]` 恰好是回环吗 ✓（**逐字符**比主机名，绝不用前缀 ✓）。
fn loopback_host_port_ok(hostport: &str) -> bool {
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (hostport, None),
    };
    let host_exact = host == LOOPBACK || host == "localhost";
    if !host_exact {
        return false;
    }
    match port {
        None => true,
        Some(p) => !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()),
    }
}

/// `Authorization: Bearer <token>` 恰好等于本次会话令牌吗 ✓（定长比较 ⇒ 不做提前返回 ✓）。
pub fn bearer_ok(auth: Option<&str>, token: &str) -> bool {
    let Some(a) = auth else { return false };
    let Some(got) = a.strip_prefix("Bearer ") else { return false };
    let (a, b) = (got.as_bytes(), token.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// 从环境变量解析配置 ✓（**默认关** ⇒ 没显式打开就返回 `None` ✓）。
pub fn resolve_config() -> Option<ChannelConfig> {
    if !MCP_CHANNEL_ENABLED && std::env::var(SWITCH_ENV).ok().as_deref() != Some("on") {
        return None;
    }
    let token_file = std::env::var(TOKEN_FILE_ENV).ok()?;
    let text = std::fs::read_to_string(&token_file).ok()?;
    let (token, granted) = parse_token_file(&text)?;
    let port_file = std::env::var(PORT_FILE_ENV).ok().unwrap_or_else(|| {
        let dir = std::path::Path::new(&token_file).parent().map(|p| p.to_path_buf()).unwrap_or_default();
        dir.join("mcp-channel.port").to_string_lossy().to_string()
    });
    Some(ChannelConfig { session_id: session_id_of(&token), token, granted, port_file })
}

/// 一次请求的判定与执行 ✓（**纯函数形态**：给定配置 ＋ 请求头 ＋ 请求体 ⇒ 状态码 ＋ 响应体 ✓）。
pub fn handle_request(cfg: &ChannelConfig, origin: Option<&str>, host: Option<&str>, auth: Option<&str>, body: &str) -> (u16, String) {
    if !host_ok(host) {
        return (403, json_err("bad_host"));
    }
    if !origin_ok(origin) {
        return (403, json_err("bad_origin"));
    }
    if !bearer_ok(auth, &cfg.token) {
        return (401, json_err("bad_token"));
    }
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return (400, json_err("bad_args")),
    };
    let Some(method) = v.get("method").and_then(|m| m.as_str()) else {
        return (400, json_err("bad_args"));
    };
    let args = v.get("args").cloned().unwrap_or_else(|| serde_json::json!({}));
    let args_json = args.to_string();
    // ⭐ 2026-10-06（M1 收口：把桥接上）：`__tools_list` 是**清单**，不是一次能力调用 ✓ ——
    //    它没有副作用、不碰任何空间/权限 ⇒ **不进** `dispatch_capability` ✓
    //    （那位的语义是"调一次能力" ✗，不是"给我工具表"）。清单**原样**吐生成物
    //    （`mcp_host::tools_list_json()` ⇒ `include_str!` 编译期内嵌 ✓）⇒ 与 JS 侧/注册表
    //    **同一份** ✓，⛔ 不在此另抄 ✗。桥把它翻成 MCP 的 `tools/list` 结果 ✓。
    if method == "__tools_list" {
        return (200, format!("{{\"ok\":true,\"result\":{}}}", crate::mcp_host::tools_list_json()));
    }
    match crate::mcp_host::handle_external_call(&cfg.session_id, &cfg.granted, method, &args_json) {
        Ok(result) => (200, format!("{{\"ok\":true,\"result\":{}}}", result)),
        Err(e) => (403, format!("{{\"ok\":false,\"error\":{}}}", serde_json::Value::String(e))),
    }
}

fn json_err(code: &str) -> String {
    format!("{{\"ok\":false,\"error\":{}}}", serde_json::Value::String(code.to_string()))
}

/// 起服务（**开关关着就什么都不做** ✓）。返回实际绑定地址（给测试与日志用 ✓）。
pub fn start_if_enabled() -> Option<SocketAddr> {
    let cfg = resolve_config()?;
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).ok()?;
    let addr = listener.local_addr().ok()?;
    let _ = std::fs::write(&cfg.port_file, addr.port().to_string());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let cfg = cfg.clone();
            std::thread::spawn(move || {
                let _ = serve_one(stream, &cfg);
            });
        }
    });
    Some(addr)
}

/// 读一条请求 ⇒ 判定 ⇒ 回应 ⇒ 关连接 ✓（本机一跳，不做 keep-alive ✓）。
fn serve_one(mut stream: TcpStream, cfg: &ChannelConfig) -> std::io::Result<()> {
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    stream.set_write_timeout(Some(READ_TIMEOUT))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(());
    }
    let method_path = line.trim_end().to_string();
    let mut origin = None;
    let mut host = None;
    let mut auth = None;
    let mut len: usize = 0;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 {
            break;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            let (k, v) = (k.trim().to_ascii_lowercase(), v.trim().to_string());
            match k.as_str() {
                "origin" => origin = Some(v),
                "host" => host = Some(v),
                "authorization" => auth = Some(v),
                "content-length" => len = v.parse().unwrap_or(0),
                _ => {}
            }
        }
    }
    if len > MAX_REQUEST_BYTES {
        return respond(&mut stream, 413, &json_err("too_large"));
    }
    let mut body = vec![0u8; len];
    if len > 0 {
        reader.read_exact(&mut body)?;
    }
    let body = String::from_utf8_lossy(&body).to_string();

    if !method_path.starts_with("POST /call") {
        return respond(&mut stream, 404, &json_err("not_found"));
    }
    let (code, out) = handle_request(cfg, origin.as_deref(), host.as_deref(), auth.as_deref(), &body);
    respond(&mut stream, code, &out)
}

fn respond(stream: &mut TcpStream, code: u16, body: &str) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let msg = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(msg.as_bytes())?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ChannelConfig {
        ChannelConfig {
            token: "tok-abc".to_string(),
            granted: vec!["read:pages".to_string()],
            port_file: "unused".to_string(),
            session_id: session_id_of("tok-abc"),
        }
    }

    #[test]
    fn default_is_off_and_only_env_on_opens_it() {
        assert!(!MCP_CHANNEL_ENABLED, "默认必须是关的 ✓（判据①）");
    }

    /// ⚠️ 前缀陷阱：`127.0.0.1.evil.com` 与 `127.0.0.10` **都不是**回环 ✓。
    #[test]
    fn origin_and_host_must_be_exactly_loopback() {
        assert!(origin_ok(Some("http://127.0.0.1")));
        assert!(origin_ok(Some("http://127.0.0.1:5173")));
        assert!(origin_ok(Some("http://localhost:8080")));
        assert!(origin_ok(None), "原生客户端可不发 Origin ✓");
        assert!(!origin_ok(Some("http://127.0.0.1.evil.com")), "前缀一样但不是回环 ✗");
        assert!(!origin_ok(Some("http://127.0.0.10")));
        assert!(!origin_ok(Some("https://127.0.0.1")), "只认 http（本机一跳 ✓）");
        assert!(!origin_ok(Some("http://evil.com")));

        assert!(host_ok(Some("127.0.0.1")));
        assert!(host_ok(Some("127.0.0.1:9000")));
        assert!(host_ok(Some("localhost:9000")));
        assert!(!host_ok(Some("127.0.0.1.evil.com")), "DNS rebinding 那一类 ✗");
        assert!(!host_ok(Some("127.0.0.10:9000")));
        assert!(!host_ok(None), "Host 缺失必须拒 ✓");
        assert!(!host_ok(Some("")));
    }

    #[test]
    fn bearer_must_match_exactly() {
        assert!(bearer_ok(Some("Bearer tok-abc"), "tok-abc"));
        assert!(!bearer_ok(Some("Bearer tok-abd"), "tok-abc"));
        assert!(!bearer_ok(Some("Bearer tok-abc "), "tok-abc"));
        assert!(!bearer_ok(Some("tok-abc"), "tok-abc"), "少了 Bearer 前缀 ✗");
        assert!(!bearer_ok(None, "tok-abc"));
    }

    #[test]
    fn token_file_parsing_and_session_id_stability() {
        let (t, g) = parse_token_file("tok-1\nread:pages, write:pages\n").expect("应能读出");
        assert_eq!(t, "tok-1");
        assert_eq!(g, vec!["read:pages".to_string(), "write:pages".to_string()]);
        let (t2, g2) = parse_token_file("tok-2\n").expect("只有令牌也合规 ✓");
        assert_eq!(t2, "tok-2");
        assert!(g2.is_empty(), "没写权限 ⇒ 空 ⇒ 默认最窄 ✓");
        assert!(parse_token_file("\n").is_none(), "空文件 ⇒ 没有令牌 ✓");
        assert_eq!(session_id_of("tok-1"), session_id_of("tok-1"));
        assert_ne!(session_id_of("tok-1"), session_id_of("tok-2"));
        assert!(!session_id_of("tok-1").contains("tok-1"), "会话号里不许出现令牌本身 ✓");
    }

    #[test]
    fn request_gate_orders_host_origin_token_then_args() {
        let cfg = cfg();
        assert_eq!(handle_request(&cfg, None, None, Some("Bearer tok-abc"), "{}").0, 403, "Host 必须在最前 ✓");
        assert_eq!(handle_request(&cfg, Some("http://evil.com"), Some("127.0.0.1"), Some("Bearer tok-abc"), "{}").0, 403);
        assert_eq!(handle_request(&cfg, None, Some("127.0.0.1"), Some("Bearer nope"), "{}").0, 401);
        assert_eq!(handle_request(&cfg, None, Some("127.0.0.1"), Some("Bearer tok-abc"), "不是 JSON").0, 400);
        assert_eq!(handle_request(&cfg, None, Some("127.0.0.1"), Some("Bearer tok-abc"), "{\"nope\":1}").0, 400);
        // 三个都过 ⇒ 真的走到唯一入口 ✓（未知能力 ⇒ 唯一鉴权点给 unknown_capability ⇒ 403 ＋ 留痕 ✓）
        let (code, body) = handle_request(&cfg, None, Some("127.0.0.1"), Some("Bearer tok-abc"), "{\"method\":\"nope.nope\",\"args\":{}}");
        assert_eq!(code, 403);
        assert!(body.contains("unknown_capability"), "错误码要原样透出 ✓：{body}");
    }
}
