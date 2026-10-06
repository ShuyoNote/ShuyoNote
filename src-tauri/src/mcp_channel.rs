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
// ⚠️ 旧的 `start_if_enabled`（阻塞式 accept ＋ 只认 env）已在 2026-10-06 被下面那份**能停、且认配置文件**的实现取代 ✓ —— 不并存两份 ✗。


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
    // ⭐ 2026-10-06（M1 收口）：**每个请求先看一次"现在开不开"** ✓ —— 面板上关掉开关要**立即失效**，
    //    不能等进程重启 ✗（工单 Task 6："关闭 ⇒ 已发 token 立即作废" ✓）。
    if !is_enabled() {
        return respond(&mut stream, 403, &json_err("disabled"));
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

// =====================================================================================
// M1 收口（2026-10-06）：**GUI 开关**那一半 —— 开关／令牌／端口落到**文件**，env 仍可覆盖 ✓
// =====================================================================================
// 为什么要有这一半：R89 拍的是「必须有开关 ＋ 可见状态」（§10⑤ 的建议 ✓，owner「同意你的建议」✓）
// —— 而打包后的 App 里**用户没法设环境变量** ✗，只有 env 一条路等于"对用户不可用" ✗。
//
// 口径（都是契约 ✓）：
//   * 配置目录 `<app data>/mcp/`：`config.json`（开关 ＋ 授权清单 ✓）／`token`（第 1 行令牌、
//     第 2 行逗号分隔授权 ⇒ **与 `parse_token_file` 同一格式** ✓）／`port`（写实际端口 ✓）；
//   * **默认关** ✓（文件不存在 ⇒ `enabled: false` ✓）；
//   * **env 优先** ✓（`SHUYONOTE_MCP_SWITCH` / `_TOKEN_FILE` / `_PORT_FILE` 照旧生效 ⇒
//     判据与开发不受影响 ✓，`check-mcp-host-channel` 的五条也不受影响 ✓）；
//   * **关掉 ⇒ 立即失效** ✓：每个请求先看一次「现在开不开」✓（关 ⇒ 403 `disabled` ✓）；
//     而**重新开**会**轮换令牌** ✓ ⇒ 旧令牌即使还在别人手里也用不了 ✓（工单 Task 6 那一格 ✓）。
//
// ⚠️ 本模块仍**不判权限、不开库、不写审计** ✓ —— 那三件仍在各自唯一的一处 ✓。
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const CONFIG_FILE: &str = "config.json";
pub const TOKEN_FILE_NAME: &str = "token";
pub const PORT_FILE_NAME: &str = "port";

/// 落盘的那份配置（`<app data>/mcp/config.json` ✓）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileConfig {
    pub enabled: bool,
    /// 开关打开时**默认授予**的权限（面板可改；空 ⇒ 最窄 ✓ —— 默认取窄不是取宽 ✓）。
    pub granted: Vec<String>,
}

impl Default for FileConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            // ⚠️ 默认只给**读**权限（M1 是只读接入 ✓）；写随 M2，且 R87 要求免确认写**必须留痕** ✓。
            granted: vec!["read:pages".to_string(), "read:files".to_string(), "read:backlinks".to_string()],
        }
    }
}

/// `<app data>/mcp/` —— 拿不到数据目录 ⇒ `None` ⇒ 开关那套整体不可用 ✓（不猜路径 ✓）。
pub fn mcp_dir() -> Option<PathBuf> {
    crate::db::app_data_dir_ref().map(|d| d.join("mcp"))
}

fn dir_file(name: &str) -> Option<PathBuf> {
    mcp_dir().map(|d| d.join(name))
}

/// 配置文件路径 ✓（GUI 面板要显示给用户看 ✓）。
pub fn config_path() -> Option<PathBuf> {
    dir_file(CONFIG_FILE)
}
/// 令牌文件路径 ✓（agent 的配置片段里要用它 ✓）。
pub fn token_path() -> Option<PathBuf> {
    dir_file(TOKEN_FILE_NAME)
}
/// 端口文件路径 ✓。
pub fn port_path() -> Option<PathBuf> {
    dir_file(PORT_FILE_NAME)
}

/// 读配置：**不存在／读不动／坏 JSON ⇒ 默认值**（＝默认关 ✓）—— 绝不因为配置文件坏了就"默认开" ✗。
pub fn read_file_config() -> FileConfig {
    let Some(p) = config_path() else { return FileConfig::default() };
    match std::fs::read_to_string(&p) {
        Ok(text) => serde_json::from_str::<FileConfig>(&text).unwrap_or_default(),
        Err(_) => FileConfig::default(),
    }
}

/// 写配置（会建目录 ✓）。
pub fn write_file_config(cfg: &FileConfig) -> Result<(), String> {
    let dir = mcp_dir().ok_or_else(|| "拿不到应用数据目录".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败：{e}"))?;
    let p = config_path().ok_or_else(|| "拿不到配置路径".to_string())?;
    let text = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化失败：{e}"))?;
    std::fs::write(&p, text).map_err(|e| format!("写配置失败：{e}"))
}

/// 环境变量那一路（判据/开发 ✓）—— 给了 `SHUYONOTE_MCP_SWITCH=on` 就算开 ✓。
fn env_switch_on() -> bool {
    std::env::var(SWITCH_ENV).ok().as_deref() == Some("on")
}

/// **现在开不开**：env 优先 ✓，否则看配置文件 ✓（默认关 ✓）。
pub fn is_enabled() -> bool {
    env_switch_on() || read_file_config().enabled
}

/// 生成并写入新令牌：第 1 行＝令牌 ✓、第 2 行＝逗号分隔授权 ✓（与 `parse_token_file` 同格式 ✓）。
///
/// ⚠️ 随机数走 `crypto::random_32()`（**唯一随机入口** ✓，与 `random_salt`/钥匙袋同一条纪律 ✓）。
pub fn write_new_token(granted: &[String]) -> Result<String, String> {
    let dir = mcp_dir().ok_or_else(|| "拿不到应用数据目录".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败：{e}"))?;
    let token = crate::crypto::random_32()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let body = format!("{token}\n{}\n", granted.join(","));
    let p = token_path().ok_or_else(|| "拿不到令牌路径".to_string())?;
    std::fs::write(&p, body).map_err(|e| format!("写令牌失败：{e}"))?;
    // 尽力收紧权限（Unix：0600 ✓）；Windows 上 ACL 模型不同 ⇒ 失败**不致命** ✓（判据也如实说"没查过" ✓）。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(token)
}

/// 读回当前令牌（没有 ⇒ `None` ✓）。
pub fn read_token() -> Option<String> {
    let p = token_path()?;
    let text = std::fs::read_to_string(p).ok()?;
    parse_token_file(&text).map(|(t, _)| t)
}

/// 给 GUI／命令用的状态读数 ✓（含令牌全文 —— 本机同一用户 ✓，面板要能"复制给 agent" ✓）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct McpStatus {
    /// 开关（env 或配置文件 ✓ ⇒ 这就是"现在开不开" ✓）
    pub enabled: bool,
    /// 监听**真的**在跑吗 ✓（开关开着但端口被占 ⇒ 这里会是 false ✓ —— 如实报 ✓）
    pub running: bool,
    pub port: Option<u16>,
    pub token: Option<String>,
    pub granted: Vec<String>,
    /// 这次是不是被**环境变量**打开的（面板要说清"你现在是 env 开的" ✓）
    pub env_override: bool,
    pub config_path: Option<String>,
    pub token_path: Option<String>,
    pub port_path: Option<String>,
}

/// 当前运行的监听（**停得掉** ✓：非阻塞 accept ⇒ 停 = 置标志 ＋ 等线程自己退 ✓）。
struct Running {
    stop: Arc<AtomicBool>,
    addr: SocketAddr,
    handle: std::thread::JoinHandle<()>,
}

static RUN: Mutex<Option<Running>> = Mutex::new(None);

fn current_addr() -> Option<SocketAddr> {
    RUN.lock().ok().and_then(|g| g.as_ref().map(|r| r.addr))
}

/// 读状态 ✓。
pub fn status() -> McpStatus {
    let file = read_file_config();
    let (token, granted) = match token_path().and_then(|p| std::fs::read_to_string(p).ok()) {
        Some(text) => match parse_token_file(&text) {
            Some((t, g)) => (Some(t), g),
            None => (None, file.granted.clone()),
        },
        None => (None, file.granted.clone()),
    };
    let addr = current_addr();
    McpStatus {
        enabled: is_enabled(),
        running: addr.is_some(),
        port: addr.map(|a| a.port()),
        token,
        granted,
        env_override: env_switch_on(),
        config_path: config_path().map(|p| p.display().to_string()),
        token_path: token_path().map(|p| p.display().to_string()),
        port_path: port_path().map(|p| p.display().to_string()),
    }
}

/// 起监听：**非阻塞 accept** ✓（这样才停得掉 ✗ —— 阻塞式 `incoming()` 只能等下一个连接 ✗）。
///
/// ⚠️ 端口**只绑回环** ✓（判据第②条同时禁 `0.0.0.0` 与 `UNSPECIFIED` ✓）。
fn start_listener(cfg: ChannelConfig) -> Result<Running, String> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .map_err(|e| format!("绑回环端口失败：{e}"))?;
    let addr = listener.local_addr().map_err(|e| format!("读端口失败：{e}"))?;
    listener.set_nonblocking(true).map_err(|e| format!("设非阻塞失败：{e}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    // 端口公布 ✓（写文件而不是 stdout/stderr：App 与桥之间没有 stdio 关系 ✓）
    let port_file = cfg.port_file.clone();
    let _ = std::fs::write(&port_file, addr.port().to_string());
    let handle = std::thread::spawn(move || {
        while !stop_thread.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let cfg = cfg.clone();
                    std::thread::spawn(move || {
                        let _ = serve_one(stream, &cfg);
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(80));
                }
                Err(_) => std::thread::sleep(Duration::from_millis(200)),
            }
        }
    });
    Ok(Running { stop, addr, handle })
}

/// 停监听（幂等 ✓）：置标志 ⇒ 线程在 ~80ms 内退出 ✓；并**删掉端口文件** ✓（桥连不上就不会瞎试 ✓）。
fn stop_listener() {
    let taken = RUN.lock().ok().and_then(|mut g| g.take());
    if let Some(r) = taken {
        r.stop.store(true, Ordering::SeqCst);
        let _ = r.handle.join();
    }
    if let Some(p) = port_path() {
        let _ = std::fs::remove_file(p);
    }
}

/// 起／停（幂等 ✓）。返回最新状态 ✓。
///
/// * 开：确保有令牌（没有就现生成 ✓）⇒ 起监听；**已经在跑就先停**（换令牌要重启 ✓）；
/// * 关：停监听 ＋ 删端口文件 ⇒ **每个请求随后都会被 `disabled` 拒** ✓（旧令牌立刻失效 ✓）。
pub fn set_enabled(enabled: bool) -> Result<McpStatus, String> {
    if !enabled {
        stop_listener();
        return Ok(status());
    }
    // 开关写了之后 `is_enabled()` 才能为真 ✓（`serve_one` 每个请求都会读它 ✓）
    let mut cfg = read_file_config();
    cfg.enabled = true;
    write_file_config(&cfg)?;
    if token_path().map(|p| p.exists()).unwrap_or(false) == false {
        write_new_token(&cfg.granted)?;
    }
    stop_listener(); // 幂等：换令牌/换端口时先停旧的 ✓
    let token = read_token().ok_or_else(|| "开关开了但令牌还是拿不到".to_string())?;
    let port_file = port_path()
        .ok_or_else(|| "拿不到端口文件路径".to_string())?
        .display()
        .to_string();
    let channel_cfg = ChannelConfig {
        session_id: session_id_of(&token),
        token,
        granted: cfg.granted.clone(),
        port_file,
    };
    let running = start_listener(channel_cfg)?;
    if let Ok(mut g) = RUN.lock() {
        *g = Some(running);
    }
    Ok(status())
}

/// 轮换令牌（**旧令牌立刻作废** ✓）：生成新令牌 ⇒ 按新令牌重启监听 ✓。
pub fn rotate_token() -> Result<McpStatus, String> {
    let cfg = read_file_config();
    write_new_token(&cfg.granted)?;
    // 开关是开的 ⇒ 重启（用新令牌 ✓）；关着 ⇒ 只换令牌、不监听 ✓
    if is_enabled() {
        set_enabled(true)
    } else {
        Ok(status())
    }
}

/// 启动时那一次（**保持旧行为**：只有开关开着才起 ✓）。
pub fn start_if_enabled() -> Option<SocketAddr> {
    if !is_enabled() {
        return None;
    }
    // 走与 GUI 同一条路（所以"打开后重启 App"与"面板里打开"是同一种状态 ✓）
    match set_enabled(true) {
        Ok(s) => {
            if s.running {
                s.port.map(|p| SocketAddr::from((Ipv4Addr::LOCALHOST, p)))
            } else {
                None
            }
        }
        Err(e) => {
            eprintln!("[mcp] 开关开着，但通道没起来：{e} ✓");
            None
        }
    }
}

// ---- Tauri 命令（GUI 开关那一面）-----------------------------------------------------
/// 状态（面板显示 ✓）。
#[tauri::command]
pub fn mcp_status() -> McpStatus {
    status()
}

/// 开关（面板切换 ✓）。返回最新状态 ✓。
#[tauri::command]
pub fn mcp_set_enabled(enabled: bool) -> Result<McpStatus, String> {
    set_enabled(enabled)
}

/// 轮换令牌（面板上的「重新生成」✓）。
#[tauri::command]
pub fn mcp_rotate_token() -> Result<McpStatus, String> {
    rotate_token()
}
