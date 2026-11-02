//! `shuyonote-mcp` —— ShuyoNote 的**本机 MCP 桥**（Rust 版，随安装包分发）。
//!
//! 这是 `tools/shuyonote-mcp/index.mjs`（Node 版）的等价重写，目的只有一个：
//! **用户机器上不需要装 Node、也不需要联网**。外部 AI 客户端把这一颗 exe 当 stdio MCP server。
//!
//! ## 它只做两件事（和 Node 版逐条对齐，判据见本文件 `#[cfg(test)]`）
//! 1. **stdio 帧**：MCP 是「行分隔 JSON-RPC over stdio」—— stdin 一行一条请求，stdout 一行一条响应。
//!    ⚠️ **stdout 只许出现协议行**：所有日志一律走 stderr（Node 版同一条纪律）。
//! 2. **转发**：`tools/list` / `tools/call` ⇒ POST 到 App 的本机通道
//!    （`src-tauri/src/mcp_channel.rs`：默认关、只绑回环、token 从文件读、Origin/Host 必须回环）。
//!
//! ## ⛔ 桥不做什么（和 Node 版同一个红线）
//! 不碰库、不判权限、不写审计、不自己编工具清单（清单由 App 原样吐出注册表生成物）。
//! 桥一旦"聪明"，唯一鉴权点与同一本审计账会同时被绕开。
//!
//! ## 连接信息（**不配也能连**）
//! * 默认去应用数据目录下找 `…/cn.shuyo.shuyonote/mcp/{port,token}`（与 `tools/shuyonote-mcp/paths.mjs`
//!   和 Tauri 的 `app_data_dir` 同口径：Windows `%APPDATA%`、macOS `~/Library/Application Support`、
//!   Linux `$XDG_DATA_HOME` 或 `~/.local/share`）；
//! * `SHUYONOTE_MCP_HOME` 可整体改道；`SHUYONOTE_MCP_PORT_FILE` / `SHUYONOTE_MCP_TOKEN_FILE` 单独覆盖优先。
//!
//! 人工看帧：`echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | shuyonote-mcp`
//! 退出码：0 正常结束（stdin EOF 且已处理完）／2 起不来（当前实现不会走 2：stdin 坏了只打日志退出）。
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "shuyonote-bridge";
const SERVER_VERSION: &str = "0.1.0";
/// 应用标识（与 `tauri.conf.json` 的 `identifier` 同值）。
const APP_ID: &str = "cn.shuyo.shuyonote";
/// App 的 `/call` 只认这一条路径（Node 版注释里记着那次真端到端事故：post `/` ⇒ 每条都 404）。
const CALL_PATH: &str = "/call";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const READ_TIMEOUT: Duration = Duration::from_secs(120);

/// 日志一律走 stderr（stdout 只许协议行）。
fn log(msg: &str) {
    let _ = writeln!(std::io::stderr(), "{msg}");
}

/// 读连接信息的两个文件：显式 env > `SHUYONOTE_MCP_HOME` > 平台默认。
#[derive(Debug, Clone)]
struct BridgeConfig {
    port_file: PathBuf,
    token_file: PathBuf,
}

impl BridgeConfig {
    fn from_env() -> Self {
        let base = env::var_os("SHUYONOTE_MCP_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(default_mcp_dir);
        let port_file = env::var_os("SHUYONOTE_MCP_PORT_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| base.join("port"));
        let token_file = env::var_os("SHUYONOTE_MCP_TOKEN_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| base.join("token"));
        Self {
            port_file,
            token_file,
        }
    }
}

/// 平台默认的 `mcp/` 目录（与 `tools/shuyonote-mcp/paths.mjs` / Tauri `app_data_dir` 同口径）。
fn default_mcp_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let appdata = env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(|| env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("AppData").join("Roaming")))
            .unwrap_or_default();
        appdata.join(APP_ID).join("mcp")
    }
    #[cfg(target_os = "macos")]
    {
        let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        home.join("Library")
            .join("Application Support")
            .join(APP_ID)
            .join("mcp")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let data = env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                env::var_os("HOME")
                    .map(|h| PathBuf::from(h).join(".local").join("share"))
                    .unwrap_or_default()
            });
        data.join(APP_ID).join("mcp")
    }
}

/// `{ ok: true, port, token }` 或 `{ ok: false, why }` —— **原因要说清**（别静默当"没工具"）。
struct Endpoint {
    port: u16,
    token: String,
}

fn read_endpoint(cfg: &BridgeConfig) -> Result<Endpoint, String> {
    let port_text = fs::read_to_string(&cfg.port_file).map_err(|_| {
        format!(
            "读不到端口文件（{}）—— ShuyoNote 里的「外部 AI 接入」开关是不是没开？",
            cfg.port_file.display()
        )
    })?;
    let token_text = fs::read_to_string(&cfg.token_file)
        .map_err(|_| format!("读不到 token 文件（{}）—— 同上，先开开关", cfg.token_file.display()))?;
    let port_text = port_text.trim().to_string();
    let token = token_text.lines().next().unwrap_or("").trim().to_string();
    let port: u16 = port_text
        .parse()
        .ok()
        .filter(|p| *p > 0)
        .ok_or_else(|| format!("端口文件内容不是合法端口（{port_text:?}）"))?;
    if token.is_empty() {
        return Err("token 文件是空的".to_string());
    }
    Ok(Endpoint { port, token })
}

/// 把一次调用 POST 给 App 的通道（**只搬运**：不判权限、不重试、不缓存）。
fn call_app(cfg: &BridgeConfig, method: &str, args: &Value) -> Result<Value, String> {
    let ep = read_endpoint(cfg).map_err(|why| format!("通道未开：{why}"))?;
    let body = json!({ "method": method, "args": args }).to_string();
    let request = format!(
        "POST {CALL_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nAuthorization: Bearer {token}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
        token = ep.token,
        len = body.len(),
    );
    let mut stream = TcpStream::connect(("127.0.0.1", ep.port))
        .map_err(|e| format!("连不上 App 的通道（127.0.0.1:{}）：{e}", ep.port))?;
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CONNECT_TIMEOUT));
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("写 App 通道失败：{e}"))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("读 App 通道失败：{e}"))?;
    let text = String::from_utf8_lossy(&raw).to_string();
    let body_start = text
        .find("\r\n\r\n")
        .map(|i| i + 4)
        .ok_or_else(|| "App 通道回的不是 HTTP（没有响应头）".to_string())?;
    let body_text = &text[body_start..];
    let parsed: Value = serde_json::from_str(body_text).map_err(|_| {
        format!(
            "App 通道回的不是 JSON：{}",
            body_text.chars().take(120).collect::<String>()
        )
    })?;
    if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        let err = parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("App 通道回了 ok=false")
            .to_string();
        return Err(err);
    }
    Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
}

/// 工具清单：**由 App 给的清单现算**（⛔ 不写死工具名）。
fn list_tools(cfg: &BridgeConfig) -> Result<Vec<Value>, String> {
    let raw = call_app(cfg, "__tools_list", &json!({}))?;
    let entries = if let Some(arr) = raw.as_array() {
        arr.clone()
    } else if let Some(arr) = raw.get("tools").and_then(Value::as_array) {
        arr.clone()
    } else {
        Vec::new()
    };
    Ok(entries
        .iter()
        .map(|t| {
            json!({
                "name": t.get("name").and_then(Value::as_str).unwrap_or(""),
                "description": t.get("description").and_then(Value::as_str).unwrap_or(""),
                "inputSchema": t.get("inputSchema").cloned().unwrap_or_else(|| json!({"type": "object", "properties": {}})),
                // 非 MCP 规范字段，但对得上"能力 id" ⇒ 调用时原样带回去（桥不解释它）
                "x-shuyonote-capability": t.get("capabilityId").and_then(Value::as_str).unwrap_or(""),
            })
        })
        .collect())
}

fn send<W: Write>(out: &mut W, obj: &Value) {
    // stdout 唯一的出口：每行都是可 parse 的 JSON
    if let Ok(line) = serde_json::to_string(obj) {
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
}

/// 回一条成功结果（通知不回包）。
fn reply_ok<W: Write>(out: &mut W, id: &Option<Value>, result: Value) {
    if id.is_some() && *id != Some(Value::Null) {
        send(
            out,
            &json!({"jsonrpc": "2.0", "id": id.clone().unwrap_or(Value::Null), "result": result}),
        );
    }
}

/// 回一条错误（通知不回包）。
fn reply_err<W: Write>(out: &mut W, id: &Option<Value>, code: i64, message: String) {
    if id.is_some() && *id != Some(Value::Null) {
        send(
            out,
            &json!({
                "jsonrpc": "2.0",
                "id": id.clone().unwrap_or(Value::Null),
                "error": {"code": code, "message": message}
            }),
        );
    }
}

/// 处理一条 MCP 消息（通知不回；未知方法回 -32601）。
fn handle<W: Write>(msg: &Value, out: &mut W, cfg: &BridgeConfig) {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");

    match method {
        "initialize" => reply_ok(
            out,
            &id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            }),
        ),
        "notifications/initialized" | "initialized" => {}
        "ping" => reply_ok(out, &id, json!({})),
        "tools/list" => match list_tools(cfg) {
            Ok(tools) => {
                log(&format!("tools/list：{} 条（来自 App 的能力注册表）", tools.len()));
                reply_ok(out, &id, json!({"tools": tools}));
            }
            Err(e) => {
                // 连不上时回空清单 ＋ 原因写 stderr（别假装"有 0 个工具"，也别把错误塞进 result）
                log(&format!("tools/list：没有工具可列 —— {e}"));
                reply_ok(out, &id, json!({"tools": []}));
            }
        },
        "tools/call" => {
            let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match list_tools(cfg) {
                Err(e) => reply_err(out, &id, -32000, e),
                Ok(tools) => {
                    let Some(tool) = tools
                        .iter()
                        .find(|t| t.get("name").and_then(Value::as_str) == Some(name.as_str()))
                    else {
                        reply_err(out, &id, -32602, format!("未知工具：{name}（清单见 tools/list）"));
                        return;
                    };
                    let capability_id = tool
                        .get("x-shuyonote-capability")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&name)
                        .to_string();
                    match call_app(cfg, &capability_id, &args) {
                        Ok(result) => reply_ok(
                            out,
                            &id,
                            json!({
                                "content": [{"type": "text", "text": serde_json::to_string(&result).unwrap_or_default()}]
                            }),
                        ),
                        Err(e) => reply_err(out, &id, -32000, e),
                    }
                }
            }
        }
        _ => reply_err(out, &id, -32601, format!("method not found: {method}")),
    }
}

/// 主循环：stdin 一行一条；EOF ⇒ 处理完（顺序处理，天然不会丢在途响应）。
fn run<R: BufRead, W: Write>(mut input: R, mut output: W, cfg: &BridgeConfig) {
    let mut line = String::new();
    loop {
        line.clear();
        match input.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => {
                log(&format!("读 stdin 失败：{e}"));
                break;
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => {
                log("丢弃非 JSON 行（stdout 只许协议行，这一行也不往外写）");
                continue;
            }
        };
        handle(&msg, &mut output, cfg);
    }
}

fn main() {
    let cfg = BridgeConfig::from_env();
    match read_endpoint(&cfg) {
        Ok(ep) => log(&format!("通道已就绪：127.0.0.1:{}（token 从文件读，校验由 App 做）", ep.port)),
        Err(why) => log(&format!(
            "通道未就绪：{why}（stdio 帧仍可用：tools/list 回空清单、tools/call 回原因）"
        )),
    }
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    run(BufReader::new(stdin.lock()), stdout.lock(), &cfg);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    /// 假 App 通道：只认 `POST /call`，按请求里的 method 回一条 JSON（与 `serve_one` 同形状：
    /// HTTP/1.1 + Content-Length + Connection: close）。
    fn fake_app(port_file: PathBuf, token_file: PathBuf) -> mpsc::Receiver<String> {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        fs::write(&port_file, format!("{port}\n")).expect("write port");
        fs::write(&token_file, "tok-test\nsecond-line\n").expect("write token");
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let req = loop {
                    let n = stream.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break String::new();
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some(pos) = text.find("\r\n\r\n") {
                        let head = &text[..pos];
                        let len: usize = head
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length: ").map(|v| v.trim().parse().unwrap_or(0)))
                            .unwrap_or(0);
                        if buf.len() >= pos + 4 + len {
                            break text;
                        }
                    }
                };
                if req.is_empty() {
                    continue;
                }
                let body = req
                    .split("\r\n\r\n")
                    .nth(1)
                    .unwrap_or("")
                    .to_string();
                let _ = tx.send(req.clone());
                let v: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({}));
                let method = v.get("method").and_then(Value::as_str).unwrap_or("");
                let reply = match method {
                    "__tools_list" => json!({"ok": true, "result": [
                        {"name": "pages_get", "capabilityId": "pages.get", "description": "读一页", "inputSchema": {"type": "object", "properties": {"pageId": {"type": "string"}}}}
                    ]}),
                    "pages.get" => json!({"ok": true, "result": {"title": "第一页"}}),
                    _ => json!({"ok": false, "error": "unknown capability"}),
                };
                let body = reply.to_string();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        rx
    }

    fn temp_cfg(name: &str) -> BridgeConfig {
        // ⚠️ 不用 `std::env::temp_dir()`：本机实测测试进程写 `%TEMP%` 会被拒（os error 5，
        //    疑似系统策略/安全软件只放行"已知程序"写用户临时目录）。改用 **crate 自己 target/ 下**的
        //    目录 —— 它本来就可写，也不污染用户临时目录（CI 里同样适用）。
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(format!("{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap_or_else(|e| panic!("mkdir {dir:?} 失败：{e}"));
        BridgeConfig {
            port_file: dir.join("port"),
            token_file: dir.join("token"),
        }
    }

    fn run_one(msg: &Value, cfg: &BridgeConfig) -> Vec<Value> {
        let input = format!("{}\n", serde_json::to_string(msg).unwrap());
        let mut out = Vec::new();
        run(BufReader::new(input.as_bytes()), &mut out, cfg);
        String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).expect("每行都必须是 JSON"))
            .collect()
    }

    #[test]
    fn initialize_returns_protocol_and_server_info() {
        let cfg = temp_cfg("init");
        let out = run_one(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize"}), &cfg);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["id"], 1);
        assert_eq!(out[0]["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(out[0]["result"]["serverInfo"]["name"], SERVER_NAME);
        assert_eq!(out[0]["result"]["capabilities"]["tools"], json!({}));
    }

    #[test]
    fn notifications_get_no_reply_and_ping_does() {
        let cfg = temp_cfg("notify");
        let out = run_one(
            &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            &cfg,
        );
        assert!(out.is_empty(), "通知不许回包");
        let out = run_one(&json!({"jsonrpc": "2.0", "id": "p", "method": "ping"}), &cfg);
        assert_eq!(out[0]["result"], json!({}));
    }

    #[test]
    fn unknown_method_returns_method_not_found() {
        let cfg = temp_cfg("unknown");
        let out = run_one(&json!({"jsonrpc": "2.0", "id": 2, "method": "nope"}), &cfg);
        assert_eq!(out[0]["error"]["code"], -32601);
    }

    #[test]
    fn tools_list_is_passed_through_from_app() {
        let cfg = temp_cfg("list");
        let _rx = fake_app(cfg.port_file.clone(), cfg.token_file.clone());
        let out = run_one(&json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}), &cfg);
        let tools = out[0]["result"]["tools"].as_array().expect("tools");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "pages_get");
        assert_eq!(tools[0]["x-shuyonote-capability"], "pages.get");
    }

    #[test]
    fn tools_call_maps_tool_name_to_capability_id() {
        let cfg = temp_cfg("call");
        let rx = fake_app(cfg.port_file.clone(), cfg.token_file.clone());
        let out = run_one(
            &json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                    "params": {"name": "pages_get", "arguments": {"pageId": "p1"}}}),
            &cfg,
        );
        let text = out[0]["result"]["content"][0]["text"].as_str().expect("text");
        assert_eq!(serde_json::from_str::<Value>(text).unwrap()["title"], "第一页");
        // 桥真的把 capabilityId 发了出去（不是把 MCP 工具名当能力 id）
        let mut saw = String::new();
        while let Ok(req) = rx.try_recv() {
            saw.push_str(&req);
        }
        assert!(saw.contains("\"method\":\"pages.get\""), "请求里应带能力 id: {saw}");
        assert!(saw.contains("Bearer tok-test"), "应带 Bearer token（取 token 文件第一行）");
        assert!(saw.contains("POST /call"), "必须 POST /call");
    }

    #[test]
    fn unknown_tool_returns_invalid_params() {
        let cfg = temp_cfg("unknowntool");
        let _rx = fake_app(cfg.port_file.clone(), cfg.token_file.clone());
        let out = run_one(
            &json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "nope"}}),
            &cfg,
        );
        assert_eq!(out[0]["error"]["code"], -32602);
    }

    #[test]
    fn missing_endpoint_files_still_speak_protocol() {
        let cfg = temp_cfg("noendpoint");
        // 不启动假 App ⇒ 端口文件不存在
        let out = run_one(
            &json!({"jsonrpc": "2.0", "id": 6, "method": "tools/list"}),
            &cfg,
        );
        assert_eq!(out[0]["result"]["tools"], json!([]));
        let out = run_one(
            &json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "x"}}),
            &cfg,
        );
        assert_eq!(out[0]["error"]["code"], -32000);
        assert!(out[0]["error"]["message"].as_str().unwrap().contains("通道未开"));
    }

    #[test]
    fn non_json_line_is_dropped_without_output() {
        let cfg = temp_cfg("badline");
        let mut out = Vec::new();
        run(
            BufReader::new(b"not json\n{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"ping\"}\n" as &[u8]),
            &mut out,
            &cfg,
        );
        let text = String::from_utf8(out).expect("utf8");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 1, "非 JSON 行不许产生 stdout 行");
        assert_eq!(serde_json::from_str::<Value>(lines[0]).unwrap()["id"], 8);
    }
}
