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
/// ⚠️ **目前没有调用方**（2026-10-06 M1 收口：启动与设置面板都改走 `is_enabled()` / `set_enabled()` ✓）——
///    但它仍是**环境变量那条路**的读取器（判据 `check-mcp-host-channel` ③ 要的「token 从文件读」就落在它里面 ✓），
///    删掉会让"env 优先"这条口径**无处可查** ✗ ⇒ 挂一张**带日期的收据**（`check-dead-code-receipts.mjs` 的口径 ✓）。
///    **删除条件**：`SHUYONOTE_MCP_*` 三个环境变量整体退役之后（桥改用配置片段里的文件路径 ⇒ 不再需要 env ✓）。
#[allow(dead_code)]
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
    //    （`mcp_host::tools_list_json(allow_write())` ⇒ `include_str!` 编译期内嵌 ✓）⇒ 与 JS 侧/注册表
    //    **同一份** ✓，⛔ 不在此另抄 ✗。桥把它翻成 MCP 的 `tools/list` 结果 ✓。
    if method == "__tools_list" {
        // ⭐ M2（Task W2）：写面**只在免确认开关开着时**才拼上去 ✓ —— 关着时外部 agent 连"看都看不到"写工具 ✓
        //    （⛔ 不是"看得到但一调就拒" ✗：面里出现用不了的东西，M1 已经在 `coverage.report` 上踩过一次 ✓）。
        return (200, format!("{{\"ok\":true,\"result\":{}}}", crate::mcp_host::tools_list_json(has_write_grant(&cfg.granted))));
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
    /// ⭐ **2026-10-08（R147）**：授权写那一档 —— **加上／收回／不拿写换读／幂等** ✓。
    ///
    /// 变异：把 `granted_after_write_grant` 里那句 `out.push(w)` 去掉 ⇒ 前半**必红** ✓
    /// （而它正是"空开关"的真因：清单里永远没有 `write:pages` ⇒ 写能力永远被拒 ✗）。
    #[test]
    /// ⭐ **R152**：档位 ⇒ `(enabled, granted, allow_write)` 的**表驱动**判据 ✓。
    ///
    /// 变异：让「可写（每次确认）」把 `allow_write` 置真 ⇒ **本表必红** ✓（那就是"没问就写" ✗）。
    #[test]
    fn the_four_levels_map_to_exactly_three_fields() {
        let reads = default_read_scopes();
        let with_write = {
            let mut v = reads.clone();
            v.push(WRITE_SCOPE.to_string());
            v
        };
        let table = [
            (McpLevel::Off, false, reads.clone(), false),
            (McpLevel::Read, true, reads.clone(), false),
            (McpLevel::WriteConfirm, true, with_write.clone(), false),
            (McpLevel::WriteAuto, true, with_write.clone(), true),
        ];
        for (level, en, gr, aw) in table {
            let (e, g, a) = level_to_config(level, &[]);
            assert_eq!(e, en, "enabled 不对：{level:?}");
            assert_eq!(g, gr, "granted 不对：{level:?}");
            assert_eq!(a, aw, "allow_write 不对：{level:?} ⛔ 可写待确认档绝不许置真 ✗");
        }
        let (_, g, _) = level_to_config(McpLevel::WriteAuto, &["read:pages".into(), "delete:everything".into()]);
        assert!(!g.iter().any(|s| s == "delete:everything"), "授权面不许被放大 ✗");
        assert_eq!(g.len(), 4, "只该是读三项 ＋ write:pages ✓");
        assert_eq!(level_of(false, &with_write, true), McpLevel::Off);
        assert_eq!(level_of(true, &reads, false), McpLevel::Read);
        assert_eq!(level_of(true, &with_write, false), McpLevel::WriteConfirm);
        assert_eq!(level_of(true, &with_write, true), McpLevel::WriteAuto);
    }

    /// ⭐ **R152 接线**：换档必须**换令牌**（R147 的教训 ✓）＋ 命令进 `lib.rs` ✓。
    /// 变异：删掉 `write_new_token(&cfg.granted)` 那句 ⇒ **本半必红** ✓。
    #[test]
    /// ⭐ **R152 判据（端到端验出来的真缺陷 ✓）**：`tools/list` 那条路必须按**权限**过滤 ✓
    /// （`has_write_grant()` ✓），**不许**按 `allow_write()` ✗ —— 后者是"要不要人确认" ✓。
    /// 变异：把那处换回 `allow_write()` ⇒ **本半必红** ✓（「可写（每次确认）」档写工具会被误藏 ✓）。
    #[test]
    fn the_tool_list_follows_the_write_grant_not_the_confirm_policy() {
        let src = include_str!("mcp_channel.rs");
        // ⚠️ 只找**代码行** ✓ —— 头注里也写着 `tools_list_json(allow_write())` 那句（当反例引文 ✓），
        //   第一版没跳注释 ⇒ 判据自己对着注释报红 ✗（我实测栽过一次 ✓）。
        let line = src
            .lines()
            .find(|l| l.contains("tools_list_json(") && !l.trim_start().starts_with("//"))
            .expect("那行改了就要同步改这里 ✓");
        assert!(
            line.contains("has_write_grant(&cfg.granted)"),
            "工具清单必须跟**权限**走 ✓（现在这行是：{line}）—— 按 allow_write 过滤会把\"可写待确认\"档的写工具误藏 ✗"
        );
        assert!(!line.contains("allow_write()"), "⛔ 不许按 allow_write() 过滤清单 ✗（那是落库策略 ✓）");
        // ⚠️ 也不许在这里 `resolve_config()` 重解析 ✗ —— app 进程没有那两个环境变量 ⇒ 它会回 None
        //    ⇒ `granted=[]` ⇒ 写工具被误藏 ✓（2026-10-08 真机实测抓到的就是这个 ✓）。
        assert!(!line.contains("resolve_config()"), "⛔ 清单要用这次请求自己的 cfg ✓，不许重解析 ✗");
    }

    fn changing_the_level_reissues_the_token_and_is_wired() {
        let src = include_str!("mcp_channel.rs");
        let start = src.find("pub fn set_level(").expect("函数名改了就要同步改这里 ✓");
        let body = &src[start..];
        let end = body.find("\npub fn ").unwrap_or(body.len());
        assert!(
            body[..end].contains("write_new_token(&cfg.granted)"),
            "换档必须**换令牌** ✓（只写配置 ⇒ 面板读的 granted 来自令牌文件 ⇒ 会「点了没反应」✗）"
        );
        let lib = include_str!("lib.rs");
        assert!(lib.contains("mcp_channel::mcp_set_level"), "命令必须在 lib.rs 注册 ✓");
    }

    fn the_write_grant_adds_and_removes_exactly_the_write_scope() {
        let read_only = vec![
            "read:pages".to_string(),
            "read:files".to_string(),
            "read:backlinks".to_string(),
        ];
        let on = granted_after_write_grant(&read_only, true);
        assert!(
            on.contains(&WRITE_SCOPE.to_string()),
            "授权后必须含写 ✓（否则写面还是打不开 ✗）"
        );
        assert_eq!(on.len(), 4, "只该多出那一项 ✓");
        for s in &read_only {
            assert!(on.contains(s), "读三项不许被写挤掉 ✓：{s}");
        }
        let off = granted_after_write_grant(&on, false);
        assert!(!off.contains(&WRITE_SCOPE.to_string()), "收回后不许还有写 ✓");
        assert_eq!(off, read_only, "收回后应当**回到原样** ✓");
        // 旧配置文件可能没有 granted（空清单）⇒ 授权写也要把读三项补齐 ✓
        assert_eq!(granted_after_write_grant(&[], true).len(), 4, "空清单 ⇒ 读三项 ＋ 写一项 ✓");
        assert_eq!(granted_after_write_grant(&on, true), on, "重复授权不许重复加 ✓");
    }

    /// ⭐ **R147 的接线那一半**（函数对 ≠ 被调用 ✗）：命令面必须**落盘 config** ＋ **换令牌**，且**注册进 `lib.rs`** ✓。
    ///
    /// 变异：删掉 `set_write_grant` 里那句 `write_file_config(&cfg)` ⇒ 本条**必红** ✓
    /// （只改令牌文件的话，禁用再启用会被 `cfg.granted` 覆盖回只读 ✗）。
    #[test]
    fn the_write_grant_is_wired_to_the_config_and_to_a_token_reissue() {
        let src = include_str!("mcp_channel.rs");
        let start = src.find("pub fn set_write_grant(").expect("函数名改了就要同步改这里 ✓");
        let body = &src[start..];
        let end = body.find("\npub fn ").unwrap_or(body.len());
        let body = &body[..end];
        assert!(
            body.contains("write_file_config(&cfg)"),
            "授权必须**落盘** `config.json.granted` ✓（否则禁用再启用就被覆盖回只读 ✗）"
        );
        // ⚠️ 这里**必须**断 `write_new_token`，⛔ 不是 `set_enabled(true)` ✗ ——
        //   我第一版钉的正是后者，而它在"已经开着"时是**空操作** ⇒ **判据把 bug 也一起钉住了** ✗
        //   （2026-10-08 现场：owner 点了没反应，而这条判据当时是**绿的** ✓ ⇒ 绿得毫无意义 ✓）。
        assert!(
            body.contains("write_new_token(&cfg.granted)"),
            "开着时必须**显式换令牌** ✓（`set_enabled(true)` 只换「关→开」那一次跃迁 ⇒ 已开着时是空操作 ✗）"
        );
        let lib = include_str!("lib.rs");
        assert!(
            lib.contains("mcp_channel::mcp_set_write_grant"),
            "命令必须在 `lib.rs` 注册 ✓（否则面板点不到 ✓）"
        );
    }

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
    /// ⭐ M2（Task W2）：**免确认写**的显式开关 ✓ —— 默认 **false** ✓（R87 的原话是「可以开」，不是「默认开」✗）。
    /// ⚠️ `#[serde(default)]`：旧配置文件里没有这个键也要读得动 ✓（否则用户一升级就「开关整个读不出来」✗）。
    #[serde(default)]
    pub allow_write: bool,
}

impl Default for FileConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            // ⚠️ 默认只给**读**权限（M1 是只读接入 ✓）；写随 M2，且 R87 要求免确认写**必须留痕** ✓。
            granted: vec!["read:pages".to_string(), "read:files".to_string(), "read:backlinks".to_string()],
            // ⛔ 免确认写**默认关** ✓（R87：可以开，不是默认开 ✓）
            allow_write: false,
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

/// **免确认写允不允许**（M2 · Task W2 ✓）：env `SHUYONOTE_MCP_ALLOW_WRITE=on` 优先 ✓（判据/开发要能测 ✓），
/// 否则看配置文件 ✓；**默认 false** ✓。
/// ⭐ **R152**：**这一枚令牌有没有写权限** ✓（`granted` 里含 `write:pages` ✓）。
///
/// ⚠️ **收的是"这次请求自己的" `granted`** ✓（`cfg.granted` ✓）—— ⛔ 不许在这里 `resolve_config()` 重解析 ✗：
/// 那个函数要求**进程环境变量**（`SHUYONOTE_MCP_TOKEN_FILE` 等 ✓），而 app 进程里没有 ⇒ 它回 `None`
/// ⇒ `granted=[]` ⇒ 写工具被误藏 ✓。**实测抓到的就是这个** ✗（临时探针逐字
///
/// ⚠️ 与 [`allow_write`] 是**两件事** ✗：`allow_write` 是**落库策略**（要不要人确认 ✓），
/// 这一条是**权限**（能不能写 ✓）。现场（2026-10-08 端到端验出的真缺陷）：「可写（每次确认）」档
/// 令牌里**有** `write:pages` ✓，而工具清单按 `allow_write` 过滤 ✗ ⇒ **两个写工具被误藏** ✓
/// ⇒ 那一档根本用不了（用户连工具都看不到，谈何"待确认"✗）。
/// 口径：**面 = 此刻真能调的能力** ✓ ⇒ 有写权限 ⇒ 列出来 ✓；要不要人确认由落库那一刻管 ✓。
pub fn has_write_grant(granted: &[String]) -> bool {
    granted.iter().any(|s| s == WRITE_SCOPE)
}

pub fn allow_write() -> bool {
    std::env::var("SHUYONOTE_MCP_ALLOW_WRITE").ok().as_deref() == Some("on") || read_file_config().allow_write
}

/// 改「免确认写」开关（写配置 ✓ ＋ 若正在监听 ⇒ **按新清单重启**，否则刚开的写面要等下次启动才出现 ✗）。
pub fn set_allow_write(on: bool) -> Result<McpStatus, String> {
    let mut cfg = read_file_config();
    cfg.allow_write = on;
    write_file_config(&cfg)?;
    if is_enabled() {
        // 重启监听 ⇒ 端口/令牌都会刷一遍 ✓（与开开关同一条路 ✓）
        return set_enabled(true);
    }
    Ok(status())
}

/// ⭐ **2026-10-08（R147）**：**写权限那一项** ✓ —— 两条写能力（`pages.create`／`blocks.append`）都要它 ✓
/// （`capabilities_gen.rs` 里两条都是 `permission: "write:pages"` ✓，scope ＝ `current-space` ✓）。
/// ⚠️ 在此之前**全仓没有任何地方把它加进 `granted`** ✗ ⇒ 面板那个「免确认写」开关是个**空开关** ✓
/// （打开也只影响"草稿要不要自动落库" ✓，而它前面那道**授权门从来没开过** ✗）。
pub(crate) const WRITE_SCOPE: &str = "write:pages";

/// 默认的**读**三项 ✓ —— 与 `FileConfig::default()` 同一份口径 ✓（只读是 M1 的边界 ✓）。
pub(crate) fn default_read_scopes() -> Vec<String> {
    vec![
        "read:pages".to_string(),
        "read:files".to_string(),
        "read:backlinks".to_string(),
    ]
}

/// ⭐ **纯函数**：把「授权写」这一档施加到一份权限清单上 ✓ ——
/// 拆出来是为了**判据测得了** ✓（`set_write_grant` 要碰真实配置与令牌文件 ⇒ 端到端只能由界面上那一下验 ✓）。
///
/// 三条口径（都承重 ✓）：
/// · **读三项永远保留** ✓（授权写不是"拿写换读"✗）；
/// · `on=true` ⇒ 确保含 `write:pages` ✓（已有不重复 ✓）；`on=false` ⇒ **移除**它 ✓（收回 ✓）；
/// · **清单里别的东西一律不动** ✓（将来加了别的 scope 也不会被这一档吃掉 ✓）。
pub(crate) fn granted_after_write_grant(base: &[String], on: bool) -> Vec<String> {
    let mut out: Vec<String> = base.to_vec();
    for s in default_read_scopes() {
        if !out.contains(&s) {
            out.push(s);
        }
    }
    let w = WRITE_SCOPE.to_string();
    if on {
        if !out.contains(&w) {
            out.push(w);
        }
    } else {
        out.retain(|s| s != &w);
    }
    out
}

/// ⭐ **2026-10-08（R147；owner 选的形态＝「面板加『授权写』入口」✓）**：把写权限**授给这枚令牌**／收回 ✓。
///
/// ## 为什么必须**落盘 `config.json.granted`**（而不只是换一枚令牌 ✓）
///
/// `set_enabled(true)` 铸令牌时读的是 `cfg.granted` ✓ ⇒ 只改令牌文件的话，**禁用再启用就被覆盖回只读** ✗ ——
/// 「空开关」的根正是**这一格没有任何写者** ✓（`write_new_token(&cfg.granted)` 只是沿用 ✓）。
///
/// ## 语义与面板一致 ✓
///
/// 授权 ⇒ 立刻**换一枚新令牌**（旧那枚随之作废 ✓ —— 与面板「换一枚 ⇒ 旧的立刻作废」同一口径 ✓），
/// 走的就是 `set_allow_write` 那条**重启监听**的路 ✓（端口/令牌都刷一遍 ✓）。
pub fn set_write_grant(on: bool) -> Result<McpStatus, String> {
    let mut cfg = read_file_config();
    cfg.granted = granted_after_write_grant(&cfg.granted, on);
    write_file_config(&cfg)?;
    if is_enabled() {
        // ⚠️⚠️ **必须显式换令牌** ✗ —— `set_enabled(true)` 只在「**关 → 开**」那个**跃迁**上换令牌 ✓
        //   （刻意如此：App 每次启动都换 ⇒ 用户粘给 agent 的配置每次重启就失效 ✗）⇒
        //   **已经开着的时候它是`空操作`** ✗。
        //
        // ## 现场（owner 2026-10-08，逐字）
        //
        // 点「授权写」之后：`config.json` 里**有了** `write:pages` ✓（＝上面那步落盘成功 ✓），
        // 而 `token` 文件**没被换** ✗（mtime 还是几小时前 ✓、第 2 行仍是 `read:pages,read:files,read:backlinks` ✗）
        // ⇒ 面板读的 `granted` 来自**令牌文件** ✓ ⇒ 开关**看起来"点不开"** ✗（点了没有任何变化 ✓）。
        // ⚠️ 而且此时监听面那份 `ChannelConfig.granted` 已经跟着 `set_enabled` 重建、**含**写权限 ✗
        // ⇒ 「面板说不给、实际已经能给」——**状态不一致** ✓，比"完全不给"更坏 ✓。
        write_new_token(&cfg.granted)?;
        // 再走一次 `set_enabled`：它会把监听面那份 `ChannelConfig` 用**新清单**重建 ✓（它自己不会再换令牌 ✓）。
        return set_enabled(true);
    }
    Ok(status())
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
    /// ⭐ R152：当前档位（由三个底层字段**推导** ✓；面板据此显示 ✓）。
    pub level: McpLevel,
    pub granted: Vec<String>,
    /// ⭐ M2：免确认写开关的当前读数 ✓（面板要显示 ✓）
    pub allow_write: bool,
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
        level: level_of(is_enabled(), &granted, allow_write()),
        granted,
        allow_write: allow_write(),
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
/// * 开：确保有令牌 ⇒ 起监听；**已经在跑就先停**（换令牌要重启 ✓）；
///   ⭐ **关过再开 ⇒ 换一枚新令牌** ✓（工单 Task 6 那一格：关了之后"旧令牌仍可连"⇒ 红 ✓）；
/// * 关：停监听 ＋ 删端口文件 ⇒ **每个请求随后都会被 `disabled` 拒** ✓（旧令牌立刻失效 ✓）。
pub fn set_enabled(enabled: bool) -> Result<McpStatus, String> {
    if !enabled {
        // ⚠️ **必须把开关写进配置**，不能只停监听 ✗ —— `serve_one` 每个请求都会读 `is_enabled()` ✓：
        //    2026-10-06 实测（本模块新加的那条 Rust 生命周期测试当场抓到 ✓）：只 `stop_listener()`
        //    而不写文件时，`is_enabled()` 仍为真 ⇒ 那道"每请求再核一次开关"的闸门**等于不存在** ✗，
        //    面板上"关掉之后旧令牌立刻失效"这句就只靠"监听线程真停了"这一条撑着 ✓（能挡，但不是
        //    设计里那两道 ✓）⇒ 写文件是第一道、停监听是第二道 ✓。
        let mut cfg = read_file_config();
        cfg.enabled = false;
        write_file_config(&cfg)?;
        stop_listener();
        return Ok(status());
    }
    // ⚠️ `was_enabled` 必须在**写配置之前**取 ✓ —— 写完之后 `is_enabled()` 就恒为真了 ✓。
    //    为什么非换不可：关闭那一刻我们能做的只是"此后拒请求" ✗，而**已经发出去的那枚令牌
    //    还在别人手里** ✗ ⇒ 重新打开时换一枚，旧的那枚立刻作废 ✓（设置面板上也写着这句 ✓）。
    //    ⛔ **App 启动时不能换**（那时 `was_enabled` 已是真 ✓）：一换，用户粘给 agent 的配置
    //    就每次重启都失效 ✓ —— 所以只在"关 → 开"这个**跃迁**上换 ✓。
    let was_enabled = read_file_config().enabled;
    let mut cfg = read_file_config();
    cfg.enabled = true;
    write_file_config(&cfg)?;
    if !was_enabled || token_path().map(|p| p.exists()).unwrap_or(false) == false {
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

/// ⭐ M2：改「免确认写」开关（面板 ✓）—— 默认关 ✓；开着时**每一次写都必须留审计** ✓（Task W4 ✓）。
#[tauri::command]
pub fn mcp_set_allow_write(on: bool) -> Result<McpStatus, String> {
    set_allow_write(on)
}

/// ⭐ **R150**：把**前端那条路的落库结果**写到 `<应用数据>/mcp/apply.log` ✓。
///
/// ## 为什么必须有这一条
///
/// 外部那条路的响应里 `drafted:true` **与有没有真的落库无关** ✗ ——
/// 现场（owner 2026-10-08）：MCP 连发 20 次 `blocks_append`，每次都回 `auto_apply:true` ✓，
/// 而页里**一个字没多** ✗（正文长度不变、派生索引 `blocks` 的行数也不变 ✓），
/// 审计里那 20 笔却都是 `ok=True` ✓（审计只管能力层 ✓、看不见前端那一步 ✗）。
/// ⇒ 于是"看着成功、库里没动"这种形状**对调用方完全不可见** ✗ —— 我今天的假 R3 就是这么来的 ✓。
///
/// 这一条是**最小可诊断**的那半 ✓：前端把每条草稿的 `ok/message` 报回来 ✓，落到一个能读的文件 ✓；
/// 完整修法（把结果**回传进 MCP 响应** ✓）在它之上做 ✓。
///
/// ⚠️ 只写元数据与结果文案 ✓（**不写正文** ✗）；一行一条 ✓，超过 200 行就截掉老的一半 ✓（防无限长 ✓）。
#[tauri::command]
pub fn mcp_log_apply_result(line: String) -> Result<(), String> {
    let dir = mcp_dir().ok_or_else(|| "拿不到 mcp 目录".to_string())?;
    let path = dir.join("apply.log");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut old = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<&str> = old.lines().collect();
    if lines.len() > 200 {
        let keep = lines.split_off(lines.len() - 100);
        old = keep.join("\n") + "\n";
    }
    old.push_str(&format!("{stamp} {line}\n"));
    std::fs::write(&path, old).map_err(|e| format!("写 apply.log 失败：{e}"))
}

/// ⭐ **R152（owner 2026-10-08 选 A）**：面板那一档 —— **四档** ✓，它是 `enabled`／`granted`／`allow_write`
/// 三个底层字段的**唯一推导源** ✓（⛔ 不再让用户分别拨三个开关 ✗）。
///
/// ## 为什么合成一档（结构问题，不是审美 ✗）
///
/// 原先那三个开关**不是一个正交集合** ✗：②「免确认」与③「授权写入」**不独立** ✓ ——
/// ③ 关着 ⇒ 根本没有写工具 ⇒ ② 打开也**毫无作用** ✗（就是 2026-10-08 修掉的那个"空开关" ✓）；
/// ① 关着时 ②③ 都是**死 UI** ✗。⇒ **真状态只有 4 个** ✓，却用 3 个布尔（8 种）表达 ⇒
/// 一半组合是死的或骗人的 ✗，而面板得用**一整段话**去解释两个开关的关系 ✗。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpLevel {
    /// 不接：通道关掉（令牌作废 ✓、监听停 ✓）。
    Off,
    /// 只读：能读、**写能力会被明确拒** ✓（`permission_denied`）。
    Read,
    /// 可写、但**每次要人确认** ✓（草稿进"待确认"队列）。
    WriteConfirm,
    /// 可写、**免确认** ✓（直接落库；⚠️ 每一次写仍留一行审计 ✓）。
    WriteAuto,
}

/// ⭐ **纯函数**：档位 ⇒ `(enabled, granted, allow_write)` ✓（**表驱动**判据就钉它 ✓）。
///
/// 三条口径（都承重 ✓）：
/// · **只读三项永远在** ✓（任何档都不拿读换写 ✗）；
/// · **`granted` 只会是「读三项 ＋ 可选 `write:pages`」** ✓ —— 授权面**不许更大** ✗（MCP 面就两条增量能力 ✓）；
/// · `base` 里**认识**的项保留 ✓（向前兼容 ✓），⛔ 但不认识的 scope 一律**不放行** ✗。
pub(crate) fn level_to_config(level: McpLevel, base: &[String]) -> (bool, Vec<String>, bool) {
    let reads = default_read_scopes();
    let mut granted: Vec<String> = base
        .iter()
        .filter(|s| reads.contains(s) || s.as_str() == WRITE_SCOPE)
        .cloned()
        .collect();
    for r in &reads {
        if !granted.contains(r) {
            granted.push(r.clone());
        }
    }
    let wants_write = matches!(level, McpLevel::WriteConfirm | McpLevel::WriteAuto);
    let w = WRITE_SCOPE.to_string();
    if wants_write {
        if !granted.contains(&w) {
            granted.push(w);
        }
    } else {
        granted.retain(|s| s != &w);
    }
    match level {
        McpLevel::Off => (false, granted, false),
        McpLevel::Read => (true, granted, false),
        McpLevel::WriteConfirm => (true, granted, false),
        McpLevel::WriteAuto => (true, granted, true),
    }
}

/// 从现状**反推**档位（面板显示用 ✓；⛔ 只读三个字段 ✓，不猜 ✗）。
pub fn level_of(enabled: bool, granted: &[String], allow_write: bool) -> McpLevel {
    if !enabled {
        return McpLevel::Off;
    }
    match (granted.iter().any(|s| s == WRITE_SCOPE), allow_write) {
        (false, _) => McpLevel::Read,
        (true, false) => McpLevel::WriteConfirm,
        (true, true) => McpLevel::WriteAuto,
    }
}

/// ⭐ **R152**：把面板那**一档**落到三个底层字段上 ✓ —— 并**换一枚令牌** ✓。
///
/// ⚠️ **换档必须换令牌** ✗（不是只写配置 ✓）：R147 的教训 —— `set_enabled(true)` 在"已经开着"时是
/// **空操作** ✓，只写配置的话，面板读到的 `granted`（来自**令牌文件** ✓）永远不变 ✗ ⇒ 用户看到"点了没反应" ✓。
pub fn set_level(level: McpLevel) -> Result<McpStatus, String> {
    let mut cfg = read_file_config();
    let (enabled, granted, allow_write) = level_to_config(level, &cfg.granted);
    cfg.enabled = enabled;
    cfg.granted = granted;
    cfg.allow_write = allow_write;
    write_file_config(&cfg)?;
    if !enabled {
        stop_listener();
        return Ok(status());
    }
    write_new_token(&cfg.granted)?;
    set_enabled(true)
}

/// ⭐ **R147**：面板上的「**授权写入**（`write:pages`）」✓ —— 未授权 ⇒ 写能力**明确拒** ✓（逐字 `permission_denied` ✓）；
/// 授权 ⇒ 换一枚带写权限的新令牌 ✓（旧令牌立刻作废 ✓）。
#[tauri::command]
pub fn mcp_set_write_grant(on: bool) -> Result<McpStatus, String> {
    set_write_grant(on)
}

/// ⭐ **R152**：面板那**一档**（四档 ✓）—— 取代原先那三个开关 ✓。
#[tauri::command]
pub fn mcp_set_level(level: McpLevel) -> Result<McpStatus, String> {
    set_level(level)
}

// =====================================================================================
// 「开关生命周期」那几条 —— 工单 Task 6 的「会红证据」本来要的是：
//   把"关开关后旧 token 仍可连"做成**会红**的读数 ✓。这一格**必须真记账**（不靠读源码猜 ✗）：
//   起真监听、真换令牌、真看端口文件有没有被删 ✓。
//
// ⚠️ 本机跑法（Windows 上 `cargo test` 直接跑会 0xC0000139，见仓内 AGENTS.md §7）：
//   `powershell -ExecutionPolicy Bypass -File scripts\win-cargo-test.ps1 -Filter mcp_channel`
//   整组读数仍以 Linux(CI/WSL) 为准 ✓。
// =====================================================================================
#[cfg(test)]
mod switch_tests {
    use super::*;

    /// `<数据目录>/mcp` 里那两个文件的存档 ✓（只碰这两个 ✓；`port` 是运行期产物、不存档 ✓）。
    fn snapshot() -> (Option<Vec<u8>>, Option<Vec<u8>>) {
        let rd = |p: Option<PathBuf>| p.and_then(|p| std::fs::read(p).ok());
        (rd(config_path()), rd(token_path()))
    }

    /// 原样还回去 ✓（**无论测试目录还是别的目录** —— `ensure_test_app_data_dir()` 是幂等的，
    /// 若被别的测试先占成了真实目录，这一步保证不动用户的配置 ✓）。
    fn restore(snap: (Option<Vec<u8>>, Option<Vec<u8>>)) {
        let wr = |p: Option<PathBuf>, b: Option<Vec<u8>>| {
            if let (Some(p), Some(b)) = (p, b) {
                let _ = std::fs::write(p, b);
            }
        };
        wr(config_path(), snap.0);
        wr(token_path(), snap.1);
    }

    /// ⭐ 工单 Task 6：**关过再开 ⇒ 换新令牌**（旧的那枚立刻作废 ✓）；而"配置本来就开着"时
    /// （＝ App 重启那条路 ✓）**不许换**（否则用户粘给 agent 的配置每次重启都失效 ✗）。
    #[test]
    fn switch_lifecycle_rotates_token_on_reopen_but_not_on_restart() {
        let _dir = crate::db::ensure_test_app_data_dir();
        if let Some(d) = mcp_dir() {
            let _ = std::fs::create_dir_all(d);
        }
        let snap = snapshot();
        // 先归零：别的测试或上一次跑可能留了"开着"的状态 ✓
        let _ = set_enabled(false);

        // ① 开 ⇒ 监听**真起来** ＋ 有一枚令牌
        let s1 = set_enabled(true).expect("开开关");
        assert!(s1.running, "开着时必须真在听 ✓（工单 Task 6）");
        assert!(s1.port.is_some(), "开着时要有端口 ✓");
        let t1 = s1.token.clone().expect("开着必须有令牌 ✓");

        // ② 关 ⇒ `is_enabled()` 假（⇒ 每个请求会被 `disabled` 拒 ✓）＋ 端口文件被删 ✓
        set_enabled(false).expect("关开关");
        assert!(!is_enabled(), "关掉之后 `is_enabled()` 必须为假 ⇒ 请求会被 `disabled` 拒 ✓");
        assert!(
            port_path().map(|p| !p.exists()).unwrap_or(true),
            "关掉要删端口文件 ✓（桥照着它连 ⇒ 文件在就说明还在听 ✗）"
        );

        // ③ **关过再开** ⇒ 换一枚新令牌 ✓（← 这一条就是"旧 token 仍可连 ⇒ 红" ✓）
        let s2 = set_enabled(true).expect("再开");
        let t2 = s2.token.clone().expect("再开必须有令牌 ✓");
        assert_ne!(
            t1, t2,
            "关过再开必须换新令牌 ✗ —— 不换的话，关掉前发出去的那枚还能用 ⇒ 这条判据要红 ✓"
        );

        // ④ 但"配置本来就开着时再调一次"（＝ App 重启那条路 ✓）**不许**换 ✓
        let s3 = set_enabled(true).expect("再调一次");
        assert_eq!(
            s3.token.as_deref(),
            Some(t2.as_str()),
            "配置本来就开着时不换令牌 ✓（一换，用户粘给 agent 的配置每次重启就失效 ✗）"
        );

        // 收尾：关掉 ＋ 把存档还回去 ✓
        let _ = set_enabled(false);
        restore(snap);
    }
}
