//! 丙-③-b：**对等交换面** —— 客户端之间**直接**收发带戳的记录（没有中枢、没有号牌、没有账本）。
//!
//! ## 它替掉的是什么
//!
//! 甲档的交换是"客户端 ↔ 中枢/服务端"：`POST /push` ＋ `GET /pull?since=<服务端发的 seq>`，
//! 而那个 `seq` **只能由一处发**（简报 §0 的那句总结）。丙 把那条链路换成**每两台设备之间各拉各的**：
//!
//! - **游标**是**发送方自己的** `device_seq`（它那台设备的自增计数）—— ⚠️ 它是**游标，不是号牌**：
//!   **判序完全靠戳**（③-a 已经按戳判页级胜负）。用 `device_seq` 而不是戳当游标只有一个理由：
//!   它**已经是列**、单调、且**不用解析载荷**就能分页（戳在载荷里）。
//! - **服务侧只服务"我自己产生的"记录**（`WHERE device_id = 我`）—— 这就是"**没有账本**"：
//!   你不需要替别人保管历史，因为别人自己也在线上、也能被直接找到。
//! - **不转发、不中继**（简报 §7 不承诺中继）：某台离线时，它那部分等它回来说。
//!
//! ## ★ 承重判据（简报 §6 丙那一格）
//!
//! 「**没有任何设备发号牌也能收敛**：N 个对端乱序 ＋ 重复投递后，两侧投影逐字节相同；
//! 且**去掉中枢进程**之后仍然收敛。」—— 本模块末尾那条 ★★ 判据就是它：
//! 两台客户端各起一个窗口、**没有任何服务端进程**、TCP 走真环回，互换一笔改动后两侧投影逐字节相同。
//!
//! ## ⚠️ 已知缺口（写在这里，别当它不存在）
//!
//! 网格路径塞给既有 `apply` 的那个 `seq` 是**发送方自己的** `device_seq`（与今天服务端那个 `seq`
//! 同一种东西、同一个量级）。**它不参与页级胜负**（两边都带戳时按戳判），但它仍被两处**本机记账**
//! 用到：`page_crdt_pending` 的键、以及「待取回远端版本」的比较。那两处**假设 seq 全局单调**，
//! 而网格路径下**不同对端的号不可比** —— 这是 ③-b 的已知缺口，不是笔误。
//!
//! ## 本片**没做**的
//!
//! - **没有接线进应用**：谁开窗、开在哪个端口、什么时候交换，都还没有产品入口
//!   （`lib.rs` 里那行 `#[allow(dead_code)]` 就是收据）；
//! - 不做 NAT 穿透 / 跨网段 / 中继 / Web 参与（简报 §7 一字不改）；
//! - 不做附件的对端选择（简报 §13 的 ④）。

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::hlc;

/// 一次 pull 最多回多少条（对端可以要更少，但不许要更多）。
pub const MAX_LIMIT: i64 = 1_000;
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 8 * 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(20);

// ─────────────────────────── 过网形状（**没有号牌**） ───────────────────────────

/// 一条要发给对端的记录 —— 与客户端 `do_push` 装进 `PushRequest` 的那一项**逐字段同形**。
///
/// ⚠️ **没有 `seq`**：丙里没有那个"只能由一处发"的号。戳**在载荷里**（`_hlc` 那一项），
/// 所以这里**不再重复一份**：两个地方各存一次真相，迟早会漂（`hlc::stamp_of_payload` 是唯一读者）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeshRow {
    /// 发送方**自己的** `device_seq` —— **游标**，不是号牌（见模块头）。
    pub device_seq: i64,
    pub entity: String,
    pub entity_id: String,
    pub op: String,
    pub payload: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PullResponse {
    records: Vec<MeshRow>,
}

/// 服务侧：**只服务我自己产生的**记录里、游标之后的那一批（按 `device_seq` 升序）。
///
/// ★ 这条 SQL 就是"没有账本"：
/// · `device_id = ?1`（**我自己**）⇒ 别推给别人的历史不在这里，**也不需要在这里**；
/// · `device_seq > ?2` ⇒ 游标是**发送方自己的**计数；
/// · `ORDER BY … ASC LIMIT` ⇒ 一次一批、**前缀**（收侧因此可以把水位推到批尾而不漏）。
pub fn serve_own_records(
    c: &Connection,
    own_device: &str,
    since: i64,
    limit: i64,
) -> Result<Vec<MeshRow>, String> {
    let limit = if limit <= 0 { MAX_LIMIT } else { limit.min(MAX_LIMIT) };
    let mut stmt = c
        .prepare(
            "SELECT device_seq, entity, entity_id, op, payload, updated_at FROM changes
             WHERE device_id = ?1 AND device_seq > ?2
             ORDER BY device_seq ASC LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![own_device, since, limit], |r| {
            Ok(MeshRow {
                device_seq: r.get(0)?,
                entity: r.get(1)?,
                entity_id: r.get(2)?,
                op: r.get(3)?,
                payload: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// ─────────────────────────── per-peer 水位（KV，不新开列） ───────────────────────────

fn cursor_key(space_id: &str, peer_device: &str) -> String {
    format!("mesh_cursor:{space_id}:{peer_device}")
}

/// 「我见过这台设备到哪儿了」—— 键按 **(空间, 对端设备)** 分开 ⇒ **一条对等体一个水位**。
pub fn peer_cursor(c: &Connection, space_id: &str, peer_device: &str) -> i64 {
    crate::sync::get_meta_state(c, &cursor_key(space_id, peer_device))
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0)
}

/// 推水位。**只许前进**（倒退会让已经收下的记录被再拉一遍 —— 幂等所以不错，但纯属浪费；
/// 更糟的是"水位倒退"往往是别的 bug 的症状，这里当场挡住并报出来）。
pub fn set_peer_cursor(
    c: &Connection,
    space_id: &str,
    peer_device: &str,
    seq: i64,
) -> Result<(), String> {
    let now = peer_cursor(c, space_id, peer_device);
    if seq < now {
        return Err(format!(
            "对端 {peer_device} 的水位不许倒退：现在 {now}，要写成 {seq}（挡在这里，别静默吞掉）"
        ));
    }
    crate::sync::set_meta_state(c, &cursor_key(space_id, peer_device), &seq.to_string())
}

// ─────────────────────────── 收下（走 ③-a 那条 apply 路径） ───────────────────────────

/// 把对端给的一批收下并应用。返回 `(这一批里被应用了几条, 批尾的 device_seq)`。
///
/// ★ 复用 `sync::apply_pulled_changes`（**不在这里长第二份 apply**）：它带着 ③-a 的按戳判序、
/// "一条坏变更不许连坐"、"失败要归档不留白"这些口径。
///
/// ⚠️ 交给它的 `seq`：**有戳 ⇒ 用戳的毫秒；没戳 ⇒ 用发送方的 `device_seq`**。
/// 理由与缺口见模块头「已知缺口」那一段。
pub fn absorb_peer_batch(c: &Connection, rows: &[MeshRow]) -> Result<(usize, i64), String> {
    if rows.is_empty() {
        return Ok((0, 0));
    }
    let incoming: Vec<crate::sync::IncomingChange> = rows
        .iter()
        .map(|r| {
            let seq = match r.payload.as_deref().map(hlc::stamp_of_payload) {
                Some(hlc::PayloadStamp::Ok(s)) => s.wall_ms(),
                _ => r.device_seq,
            };
            crate::sync::IncomingChange {
                seq,
                entity: r.entity.clone(),
                entity_id: r.entity_id.clone(),
                op: r.op.clone(),
                payload: r.payload.clone(),
                updated_at: r.updated_at,
            }
        })
        .collect();
    let out = crate::sync::apply_pulled_changes(c, incoming, 0, crate::db::now_ms())?;
    let tail = rows.iter().map(|r| r.device_seq).max().unwrap_or(0);
    Ok((out.count, tail))
}

// ─────────────────────────── 纯函数：这次要拉哪些对端 ───────────────────────────

/// 一个可以被直接拉的对等体。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeshPeer {
    pub device_id: String,
    pub base: String,
}

/// 从发现层那张表里挑出**这次要拉的对象** —— 纯函数（判据不打桩、不看真实网络）。
///
/// 三条过滤：**不是我自己** · **它代言这个空间**（`hub_spaces` 含这个空间）·
/// **它的基址是局域网地址**（`lan::is_lan_base`；公网地址一律不当网格对端 —— 简报 §7 的边界）。
///
/// ⚠️ 这里用的是甲-1 那块砖（`LanAnnounce` 的 `hub_base` / `hub_spaces`）：**发现层三档共用**，
/// 丙 只是把"谁在代言"读成"谁可以被直接拉"。
pub fn mesh_peers(space_id: &str, my_device: &str, peers: &[crate::lan::Peer]) -> Vec<MeshPeer> {
    let want = space_id.trim();
    if want.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<MeshPeer> = Vec::new();
    for p in peers {
        let id = p.announce.device_id.trim();
        if id.is_empty() || id == my_device.trim() {
            continue;
        }
        if !p.announce.hub_spaces.iter().any(|s| s.trim() == want) {
            continue;
        }
        let Some(base) = p.announce.hub_base.as_deref().map(str::trim).filter(|b| !b.is_empty()) else {
            continue;
        };
        if !crate::lan::is_lan_base(base) {
            continue;
        }
        let base = base.trim_end_matches('/').to_string();
        if out.iter().any(|q| q.device_id == id || q.base == base) {
            continue; // 同一台 / 同一个地址只拉一次
        }
        out.push(MeshPeer { device_id: id.to_string(), base });
    }
    out.sort_by(|a, b| a.device_id.cmp(&b.device_id)); // 确定性（判据要能逐字节比）
    out
}

// ─────────────────────────── 拉的那一侧 ───────────────────────────

/// 拉一台对端**自己**的记录（游标之后的那一批）。
pub async fn pull_from_peer(
    client: &reqwest::Client,
    peer: &MeshPeer,
    space_id: &str,
    since: i64,
    token: Option<&str>,
) -> Result<Vec<MeshRow>, String> {
    let url = format!(
        "{}/mesh/pull?space_id={}&since={}&limit={}",
        peer.base.trim_end_matches('/'),
        space_id,
        since,
        MAX_LIMIT
    );
    let mut req = client.get(&url);
    if let Some(t) = token.map(str::trim).filter(|t| !t.is_empty()) {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.map_err(|e| format!("拉对端 {} 失败：{e}", peer.device_id))?;
    if !resp.status().is_success() {
        return Err(format!("对端 {} 回了 {}", peer.device_id, resp.status()));
    }
    let body: PullResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(body.records)
}

/// 一轮对等交换的结果（给人看的读数，不是业务数据）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerPullReport {
    pub peer: String,
    pub fetched: usize,
    pub applied: usize,
    pub cursor: i64,
}

/// 跟**一台**对端交换一轮：读水位 ⇒ 拉 ⇒ 收下 ⇒ **水位推进到批尾**。
///
/// ⚠️ 锁**不跨 `await`**：读一次、放掉、拉完再拿一次（否则一次网络卡顿会把整个库锁住）。
pub async fn pull_and_absorb(
    conn: &Arc<Mutex<Connection>>,
    client: &reqwest::Client,
    peer: &MeshPeer,
    space_id: &str,
    token: Option<&str>,
) -> Result<PeerPullReport, String> {
    let since = {
        let g = conn.lock().map_err(|_| "空间库的锁被毒掉了".to_string())?;
        peer_cursor(&g, space_id, &peer.device_id)
    };
    let rows = pull_from_peer(client, peer, space_id, since, token).await?;
    let fetched = rows.len();
    let g = conn.lock().map_err(|_| "空间库的锁被毒掉了".to_string())?;
    let (applied, tail) = absorb_peer_batch(&g, &rows)?;
    if tail > since {
        set_peer_cursor(&g, space_id, &peer.device_id, tail)?;
    }
    Ok(PeerPullReport { peer: peer.device_id.clone(), fetched, applied, cursor: tail.max(since) })
}

// ─────────────────────────── 供的那一侧（最小 HTTP/1.1，不引依赖） ───────────────────────────

/// 一条请求去哪个处理函数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// `GET /mesh/pull`
    Pull,
    /// 同步协议里**有**、但**不是网格这一档**的端点 ⇒ `501` ＋ 一句人话。
    NotYet(&'static str),
    /// 协议里根本没有这个路径 ⇒ `404`。
    Unknown,
}

pub fn route(method: &str, target: &str) -> Route {
    let path = target.split('?').next().unwrap_or("");
    let path = if path.len() > 1 { path.trim_end_matches('/') } else { path };
    match method.to_ascii_uppercase().as_str() {
        "GET" if path == "/mesh/pull" => Route::Pull,
        _ => match not_yet(path) {
            Some(what) => Route::NotYet(what),
            None => Route::Unknown,
        },
    }
}

/// 中枢那一套端点在网格窗口里**有名有姓**地回答"这一档不支持"（不是 404 让人自己猜）。
fn not_yet(path: &str) -> Option<&'static str> {
    match path {
        "/push" | "/pull" | "/spaces" => return Some("中枢 / 服务端那一套交换端点"),
        "/lineage-claim" => return Some("CRDT 血统 claim"),
        "/auth/register" | "/auth/login" | "/auth/me" | "/auth/logout" => return Some("账号"),
        _ => {}
    }
    if path.starts_with("/notifications") {
        return Some("通知");
    }
    if path.ends_with("/attachments") || path.contains("/attachments/") {
        return Some("附件同步");
    }
    if let Some(rest) = path.strip_prefix("/spaces/") {
        let mut segs = rest.split('/');
        let _space = segs.next();
        return match segs.next() {
            Some("changes-stream") => Some("近实时推流（SSE）"),
            Some("presence") | Some("online") => Some("在线态"),
            Some("members") => Some("成员管理"),
            Some("keyring") => Some("钥匙袋（换设备的公开材料）"),
            Some("pages") => Some("评论"),
            _ => None,
        };
    }
    None
}

// ─── 只绑内网（与甲-2 同一口径；丙里更紧张：**每台都开窗**） ───

/// 这个地址是不是"只在本网段可达"。
pub fn is_lan_only(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

/// 解析 ＋ 把关：公网地址**拒绝启动**（不是提醒一下）。
pub fn checked_bind(bind: &str) -> Result<SocketAddr, String> {
    let bind = bind.trim();
    if bind.is_empty() {
        return Err("网格窗口必须显式给一个监听地址（`IP:端口`）—— 不留默认值".to_string());
    }
    let addr: SocketAddr = if let Some(port) = bind.strip_prefix("localhost:") {
        let port: u16 = port.parse().map_err(|_| format!("端口读不出来：{bind}"))?;
        SocketAddr::from((Ipv4Addr::LOCALHOST, port))
    } else {
        bind.parse()
            .map_err(|_| format!("监听地址只能写字面 `IP:端口`（或 `localhost:端口`）：{bind}"))?
    };
    if !is_lan_only(addr.ip()) {
        return Err(format!(
            "拒绝启动：{addr} 不是内网地址（简报 §7 的边界：网格只在自己网段里）。\
             局域网请用 192.168.x.x / 10.x.x.x / 172.16-31.x.x，本机自测用 127.0.0.1。"
        ));
    }
    Ok(addr)
}

struct State {
    conn: Arc<Mutex<Connection>>,
    cfg: MeshConfig,
}

/// 一个网格窗口的配置。
#[derive(Debug, Clone)]
pub struct MeshConfig {
    pub bind: String,
    pub space_id: String,
    /// 本机对外自称的 `device_id` —— 窗口**只服务它自己的记录**。
    pub device_id: String,
    /// 对端要带的口令。`None` ⇒ 任何请求都收（启动时**大声**说一次）。
    pub token: Option<String>,
}

pub struct MeshHandle {
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl MeshHandle {
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }
}

impl Drop for MeshHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

/// 起一个网格窗口（阻塞式 accept 线程 ＋ 每连接一个线程；**不引任何依赖**）。
pub fn start(cfg: MeshConfig, conn: Arc<Mutex<Connection>>) -> Result<MeshHandle, String> {
    let addr = checked_bind(&cfg.bind)?;
    let listener = TcpListener::bind(addr).map_err(|e| format!("网格窗口绑不上 {addr}：{e}"))?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    if cfg.token.as_deref().map(str::trim).unwrap_or("").is_empty() {
        eprintln!(
            "[mesh] ⚠️ 网格窗口**没有设口令**（{bound}，空间 {}）：能连上这个地址的人都能拉走该空间的密文记录。",
            cfg.space_id
        );
    }
    eprintln!("[mesh] 网格窗口已启动：{bound} ｜ 空间 {} ｜ 自称 {}", cfg.space_id, cfg.device_id);

    let state = Arc::new(State { conn, cfg });
    let stop = Arc::new(AtomicBool::new(false));
    let stop_in = stop.clone();
    let join = std::thread::Builder::new()
        .name("mesh".to_string())
        .spawn(move || {
            while !stop_in.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((sock, _)) => {
                        let st = state.clone();
                        std::thread::spawn(move || {
                            let _ = handle_conn(sock, st);
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(POLL),
                    Err(_) => std::thread::sleep(POLL),
                }
            }
        })
        .map_err(|e| format!("网格窗口线程起不来：{e}"))?;
    Ok(MeshHandle { addr: bound, stop, join: Some(join) })
}

struct Request {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

fn read_request(sock: &mut TcpStream) -> Result<Request, String> {
    let _ = sock.set_read_timeout(Some(IO_TIMEOUT));
    let _ = sock.set_write_timeout(Some(IO_TIMEOUT));
    let mut raw: Vec<u8> = Vec::new();
    let mut buf = [0u8; 4096];
    let head_end = loop {
        if let Some(p) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break p + 4;
        }
        if raw.len() > MAX_HEAD {
            return Err("请求头太大".to_string());
        }
        let n = sock.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("半截请求".to_string());
        }
        raw.extend_from_slice(&buf[..n]);
    };
    let head = String::from_utf8_lossy(&raw[..head_end - 4]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    if method.is_empty() || target.is_empty() {
        return Err(format!("请求行读不出来：{request_line}"));
    }
    let mut headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let want: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    if want > MAX_BODY {
        return Err(format!("请求体太大：{want}"));
    }
    let mut body = raw[head_end..].to_vec();
    while body.len() < want {
        let n = sock.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("半截请求".to_string());
        }
        body.extend_from_slice(&buf[..n]);
    }
    body.truncate(want);
    Ok(Request { method, target, headers, body })
}

fn respond(sock: &mut TcpStream, code: u16, reason: &str, body: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.as_bytes().len()
    );
    sock.write_all(head.as_bytes())?;
    sock.write_all(body.as_bytes())?;
    sock.flush()
}

fn json_error(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

fn handle_conn(mut sock: TcpStream, state: Arc<State>) -> Result<(), String> {
    let req = match read_request(&mut sock) {
        Ok(r) => r,
        Err(e) => {
            let _ = respond(&mut sock, 400, "Bad Request", &json_error(&format!("请求读不出来：{e}")));
            return Ok(());
        }
    };
    let (code, reason, body) = dispatch(&state, &req);
    respond(&mut sock, code, reason, &body).map_err(|e| e.to_string())
}

fn dispatch(state: &State, req: &Request) -> (u16, &'static str, String) {
    if !authorized(state, req) {
        return (401, "Unauthorized", json_error("这个网格窗口要口令（Authorization: Bearer …），对不上"));
    }
    match route(&req.method, &req.target) {
        Route::Pull => handle_pull(state, &req.target),
        Route::NotYet(what) => (
            501,
            "Not Implemented",
            serde_json::json!({
                "error": format!("网格窗口（丙-③）不提供「{what}」"),
                "endpoint": format!("{} {}", req.method, req.target),
                "hint": "这是**明确的不支持**（不是网络故障、也不是空结果）：中心那一套端点在网格这一档里没有位置。",
            })
            .to_string(),
        ),
        Route::Unknown => (
            404,
            "Not Found",
            json_error("这个路径不在网格协议里（'协议里有但这一档没有'是另一回事，那种回 501）"),
        ),
    }
}

fn authorized(state: &State, req: &Request) -> bool {
    let Some(want) = state.cfg.token.as_deref().map(str::trim).filter(|t| !t.is_empty()) else {
        return true;
    };
    req.header("authorization")
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|got| got.trim() == want)
        .unwrap_or(false)
}

/// 查询串 → `(键, 值)`；出现需要 URL 解码的字符就**当场拒绝**（不猜着解码）。
fn query_get(target: &str, key: &str) -> Result<Option<String>, String> {
    let Some(q) = target.split_once('?').map(|(_, q)| q) else {
        return Ok(None);
    };
    for pair in q.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k.contains('%') || v.contains('%') || k.contains('+') || v.contains('+') {
            return Err("查询参数里出现了 `%` / `+` —— 本窗口不做 URL 解码：如实拒绝，不猜".to_string());
        }
        if k == key {
            return Ok(Some(v.to_string()));
        }
    }
    Ok(None)
}

fn handle_pull(state: &State, target: &str) -> (u16, &'static str, String) {
    let space = match query_get(target, "space_id") {
        Ok(v) => v,
        Err(e) => return (400, "Bad Request", json_error(&e)),
    };
    if let Some(space) = space {
        if space != state.cfg.space_id {
            return (
                403,
                "Forbidden",
                json_error(&format!("这个窗口只服务空间 {}（收到 {space}）", state.cfg.space_id)),
            );
        }
    }
    let since = match query_get(target, "since") {
        Ok(Some(v)) => v.parse::<i64>().unwrap_or(0),
        Ok(None) => 0,
        Err(e) => return (400, "Bad Request", json_error(&e)),
    };
    let limit = match query_get(target, "limit") {
        Ok(Some(v)) => v.parse::<i64>().unwrap_or(MAX_LIMIT),
        Ok(None) => MAX_LIMIT,
        Err(e) => return (400, "Bad Request", json_error(&e)),
    };
    let g = match state.conn.lock() {
        Ok(g) => g,
        Err(_) => return (500, "Internal Server Error", json_error("空间库的锁被毒掉了")),
    };
    match serve_own_records(&g, &state.cfg.device_id, since, limit) {
        Ok(records) => (200, "OK", serde_json::json!({ "records": records }).to_string()),
        Err(e) => (500, "Internal Server Error", json_error(&e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hlc::Hlc;
    use crate::lan::{LanAnnounce, Peer};
    use crate::models::PageDetail;

    // ── 两台"客户端栈"：各自一份空间库（带 meta），各自一个网格窗口

    fn space_conn(device: &str) -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c, "ws").unwrap();
        c.execute_batch("ATTACH DATABASE ':memory:' AS meta").unwrap();
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta.sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS meta.sync_profiles (
                 ws_id TEXT PRIMARY KEY,
                 server_url TEXT NOT NULL DEFAULT '',
                 token TEXT NOT NULL DEFAULT '',
                 space_id TEXT NOT NULL DEFAULT '',
                 last_pushed_seq INTEGER NOT NULL DEFAULT 0,
                 last_pulled_seq INTEGER NOT NULL DEFAULT 0,
                 sync_attachments INTEGER NOT NULL DEFAULT 1
             );",
        )
        .unwrap();
        crate::sync::set_meta_state(&c, "device_id", device).unwrap();
        c
    }

    fn stamp_of(device: &str, wall: i64) -> Hlc {
        let mut h = Hlc::genesis(device);
        h.tick(wall)
    }

    fn page(id: &str, text: &str, updated_at: i64) -> PageDetail {
        PageDetail {
            id: id.to_string(),
            workspace_id: "ws".to_string(),
            parent_id: None,
            title: "页".to_string(),
            content_json: serde_json::json!({ "root": { "children": [
                { "type": "paragraph", "blockId": "b1", "blockRev": 1,
                  "children": [{ "type": "text", "text": text }] } ] } })
            .to_string(),
            content_text: text.to_string(),
            cover: String::new(),
            icon: String::new(),
            cover_height: 300,
            cover_pos: 50.0,
            kind: "page".to_string(),
            sort_order: 0.0,
            created_at: 1,
            updated_at,
        }
    }

    /// 本机改一页 —— 与产品保存路径同形：**先落本机那一行，再记进 outbox**（outbox 那条带本机戳）。
    ///
    /// ⚠️ 落本机借的是那一层的**远端写入口**（`doc_content::upsert_remote`）：它落的列集就是同一组，
    /// 免得判据手写 `INSERT` 去猜 `pages` 的 NOT NULL 列。它会把 `dirty` 写 0 ——
    /// **本判据不依赖 `dirty`**（网格里两边都带戳 ⇒ 页级按戳判），所以不碍事。
    fn local_edit(c: &Connection, pg: &PageDetail) {
        crate::doc_content::upsert_remote(c, pg, 0).unwrap();
        crate::sync::record_page_upsert(c, pg).unwrap();
    }

    fn content_of(c: &Connection, id: &str) -> String {
        c.query_row("SELECT content_json FROM pages WHERE id = ?1", params![id], |r| r.get(0))
            .unwrap_or_else(|e| panic!("{id} 应当已经在库里：{e}"))
    }

    /// 这一页的**投影**：规范化之后的内容（去 `blockRev` ＋ 键排序）。
    ///
    /// 口径与 `mesh_sim` 那条"投影逐字节相同"**同一个**：**键序不是内容**（`block_rev` 文件头口径 3）。
    /// 两侧可能一份是本地写的、一份是合并落库的 ⇒ 序列化形态天然会差一点，
    /// 拿原始字节比就是在比"谁经手过哪条代码路径"，那不是判据要守的东西。
    fn projection_of(c: &Connection, id: &str) -> String {
        let v: serde_json::Value = serde_json::from_str(&content_of(c, id)).unwrap();
        crate::block_rev::canonical_content(&v)
    }

    fn mesh_peer(device: &str, base: &str) -> MeshPeer {
        MeshPeer { device_id: device.to_string(), base: base.to_string() }
    }

    fn announced(device: &str, base: &str, spaces: &[&str]) -> Peer {
        Peer {
            announce: LanAnnounce {
                v: crate::lan::WIRE_VERSION,
                device_id: device.to_string(),
                device_name: String::new(),
                hub_base: Some(base.to_string()),
                hub_spaces: spaces.iter().map(|s| s.to_string()).collect(),
                fp: device.to_string(),
            },
            addr: "192.168.1.9".to_string(),
            seen_at_ms: 0,
        }
    }

    // ─────────────────────────── 服务侧：没有账本 ───────────────────────────

    /// ★ 「**没有账本**」的可断言形态：窗口**只服务它自己产生的**记录。
    /// 别人推给它的行（`device_id` 不是它）**一条都不许出去** —— 它就是靠这条不需要账本。
    #[test]
    fn the_window_serves_only_its_own_records_so_it_needs_no_ledger() {
        let c = space_conn("A");
        local_edit(&c, &page("p1", "A 自己写的", 10));
        // 往同一张表里塞一条"别人的"记录（模拟它收到过的对端记录 / 别人的 outbox 行）
        crate::sync::set_meta_state(&c, "device_id", "B").unwrap();
        local_edit(&c, &page("p2", "B 写的", 20));
        crate::sync::set_meta_state(&c, "device_id", "A").unwrap();

        let served = serve_own_records(&c, "A", 0, 500).unwrap();
        assert_eq!(served.len(), 1, "只该有 A 自己那一条：{served:#?}");
        assert_eq!(served[0].entity_id, "p1");

        // 分页：游标是**发送方自己的** device_seq，一次一批、是**前缀**（收侧推进到批尾不漏）
        let first = serve_own_records(&c, "A", 0, 1).unwrap();
        assert_eq!(first.len(), 1);
        let tail = first[0].device_seq;
        assert!(serve_own_records(&c, "A", tail, 500).unwrap().is_empty(), "批尾之后没有了");
    }

    #[test]
    fn the_cursor_only_moves_forward_and_refuses_to_go_back() {
        let c = space_conn("A");
        assert_eq!(peer_cursor(&c, "space-x", "B"), 0, "没见过 ⇒ 0");
        set_peer_cursor(&c, "space-x", "B", 7).unwrap();
        assert_eq!(peer_cursor(&c, "space-x", "B"), 7);
        set_peer_cursor(&c, "space-x", "B", 7).unwrap(); // 原地不动是允许的
        assert!(set_peer_cursor(&c, "space-x", "B", 6).is_err(), "水位倒退要当场挡住");
        // 每个对端一个水位（互不串味）
        assert_eq!(peer_cursor(&c, "space-x", "C"), 0);
    }

    // ─────────────────────────── 挑对端（纯函数） ───────────────────────────

    #[test]
    fn only_peers_that_serve_this_space_over_lan_are_mesh_peers() {
        let peers = vec![
            announced("me", "http://192.168.1.2:8787", &["space-x"]),      // 我自己
            announced("B", "http://192.168.1.3:8787", &["space-x"]),        // ✅
            announced("C", "http://192.168.1.4:8787", &["other"]),          // 不服务这个空间
            announced("D", "http://203.0.113.7:8787", &["space-x"]),        // 公网地址
            announced("E", "http://192.168.1.5:8787", &[]),                 // 谁都不代言
            announced("B", "http://192.168.1.3:8787", &["space-x"]),        // 重复
        ];
        let got = mesh_peers("space-x", "me", &peers);
        assert_eq!(got, vec![mesh_peer("B", "http://192.168.1.3:8787")], "{got:#?}");
        assert!(mesh_peers("", "me", &peers).is_empty(), "没绑空间 ⇒ 不拉任何对端");
    }

    // ─────────────────────────── 路由：显式不支持 ───────────────────────────

    #[test]
    fn central_endpoints_are_answered_explicitly_rather_than_404() {
        assert_eq!(route("GET", "/mesh/pull?space_id=s&since=1"), Route::Pull);
        for t in ["/push", "/pull", "/spaces", "/lineage-claim", "/spaces/s/keyring", "/auth/login"] {
            assert!(matches!(route("POST", t), Route::NotYet(_)) || matches!(route("GET", t), Route::NotYet(_)), "{t}");
        }
        for t in ["/", "/healthz", "/mesh", "/mesh/pull/extra"] {
            assert_eq!(route("GET", t), Route::Unknown, "{t}");
        }
        assert_eq!(route("POST", "/mesh/pull"), Route::Unknown, "方法不对不算认识");
    }

    #[test]
    fn the_window_refuses_to_listen_on_a_public_address() {
        for ok in ["127.0.0.1:0", "localhost:8788", "192.168.1.5:8788", "10.1.2.3:1", "[::1]:8788"] {
            assert!(checked_bind(ok).is_ok(), "{ok}");
        }
        for bad in ["0.0.0.0:8788", "8.8.8.8:8788", "example.com:8788", "", "127.0.0.1"] {
            assert!(checked_bind(bad).is_err(), "{bad} 不该被放行");
        }
    }

    // ─────────────────────────── ★★ 判据：去掉中枢仍然收敛 ───────────────────────────

    /// ★★ 简报 §6 丙那一格：**没有任何设备发号牌、也没有中枢进程**，两台客户端直接交换带戳的记录，
    /// 互换一笔改动后**两侧投影逐字节相同**。
    ///
    /// 拓扑就是真实拓扑：**每台客户端各起一个网格窗口**（各自服务**自己**的记录），
    /// 另一台直接去拉它 —— **全程没有第三个进程、没有服务端、没有 `seq` 号牌**。
    /// TCP 走**真环回**，两个客户端各有一份**独立的空间库**。
    #[tokio::test]
    async fn two_clients_converge_over_real_loopback_with_no_hub_and_no_server() {
        let a = Arc::new(Mutex::new(space_conn("A")));
        let b = Arc::new(Mutex::new(space_conn("B")));

        // 各起一个窗口（**每台都开窗** —— 这就是丙与甲在拓扑上的差别）
        let win_a = start(
            MeshConfig {
                bind: "127.0.0.1:0".into(),
                space_id: "space-x".into(),
                device_id: "A".into(),
                token: Some("lan-token".into()),
            },
            a.clone(),
        )
        .unwrap();
        let win_b = start(
            MeshConfig {
                bind: "127.0.0.1:0".into(),
                space_id: "space-x".into(),
                device_id: "B".into(),
                token: Some("lan-token".into()),
            },
            b.clone(),
        )
        .unwrap();

        // ① A 本地改一页（本机戳 ⇒ 记进它自己的 outbox）
        {
            let c = a.lock().unwrap();
            local_edit(&c, &page("p1", "甲写的", 1_000));
        }
        // ② B 去拉 A（**没有中枢**，直接拉）
        let client = reqwest::Client::new();
        let report = pull_and_absorb(
            &b,
            &client,
            &mesh_peer("A", &format!("http://{}", win_a.addr())),
            "space-x",
            Some("lan-token"),
        )
        .await
        .unwrap();
        assert_eq!((report.fetched, report.applied), (1, 1), "{report:?}");
        assert_eq!(projection_of(&b.lock().unwrap(), "p1"), projection_of(&a.lock().unwrap(), "p1"), "一侧一致");

        // ③ B 接着改同一页，A 去拉 B（**互换**的另一半）
        {
            let c = b.lock().unwrap();
            local_edit(&c, &page("p1", "乙接着写的", 2_000));
        }
        pull_and_absorb(
            &a,
            &client,
            &mesh_peer("B", &format!("http://{}", win_b.addr())),
            "space-x",
            Some("lan-token"),
        )
        .await
        .unwrap();

        // ④ 两侧投影**逐字节相同**，而且是**因果上更后**的那一版（两边都带戳 ⇒ 按戳判）
        let ca = projection_of(&a.lock().unwrap(), "p1");
        let cb = projection_of(&b.lock().unwrap(), "p1");
        assert_eq!(ca, cb, "两侧投影必须逐字节相同");
        assert!(ca.contains("乙接着写的"), "更晚的戳必须赢：{ca}");

        // ⑤ 重复投递（再拉一遍）：**水位没动 ⇒ 什么都不该再发生**（幂等）
        let again = pull_and_absorb(
            &b,
            &client,
            &mesh_peer("A", &format!("http://{}", win_a.addr())),
            "space-x",
            Some("lan-token"),
        )
        .await
        .unwrap();
        assert_eq!(again.fetched, 0, "水位已经到批尾 ⇒ 不该再拉回东西：{again:?}");
    }

    /// ★ 服务出去的那一批**必须带戳** —— 丙 的判序全靠它。
    /// （不带戳的记录仍然会被服务，但收侧只能按今天那条路判；那一路由 `sync` 的判据守着。）
    #[test]
    fn the_served_records_carry_the_stamp_that_the_ordering_depends_on() {
        let c = space_conn("A");
        local_edit(&c, &page("p1", "带戳的", 10));
        let served = serve_own_records(&c, "A", 0, 500).unwrap();
        assert_eq!(served.len(), 1);
        let payload = served[0].payload.as_deref().expect("页 upsert 必须有载荷");
        match hlc::stamp_of_payload(payload) {
            hlc::PayloadStamp::Ok(s) => assert_eq!(s.device_id(), "A"),
            other => panic!("服务出去的记录必须带本机戳：{other:?}"),
        }
        // 顺带钉住"戳在载荷里、行上不重复一份"（两处各存一次真相迟早会漂）
        let json: serde_json::Value = serde_json::from_str(&serde_json::to_string(&served[0]).unwrap()).unwrap();
        assert!(json.get("stamp").is_none(), "行上不该再有一份戳：{json}");
        assert!(json["payload"].as_str().unwrap().contains(hlc::HLC_PAYLOAD_FIELD));
    }

    /// 对端窗口**不服务别人的记录**，所以"收到过谁的东西"不会从这里漏出去 ——
    /// 一处直接的判据（配合上面那条"没有账本"）。
    #[test]
    fn a_batch_from_a_peer_is_applied_and_the_cursor_lands_on_the_batch_tail() {
        let c = space_conn("B");
        let src = space_conn("A");
        local_edit(&src, &page("p1", "甲", 10));
        local_edit(&src, &page("p2", "乙", 20));
        let rows = serve_own_records(&src, "A", 0, 500).unwrap();
        assert_eq!(rows.len(), 2);

        let (applied, tail) = absorb_peer_batch(&c, &rows).unwrap();
        assert_eq!(applied, 2);
        assert_eq!(tail, rows.iter().map(|r| r.device_seq).max().unwrap());
        // 重复收同一批：幂等（内容不再变）
        let before = content_of(&c, "p1");
        let (applied2, _) = absorb_peer_batch(&c, &rows).unwrap();
        assert_eq!(content_of(&c, "p1"), before);
        assert_eq!(applied2, 2, "仍然走完 apply（幂等），但内容一字不变");
    }

    /// 窗口设了口令 ⇒ 对不上的一律 401；中枢那一套端点 ⇒ **501 ＋ 人话**（不是 404、不是空 200）。
    #[test]
    fn an_unimplemented_endpoint_answers_explicitly_over_real_http() {
        let c = Arc::new(Mutex::new(space_conn("A")));
        let win = start(
            MeshConfig {
                bind: "127.0.0.1:0".into(),
                space_id: "space-x".into(),
                device_id: "A".into(),
                token: Some("right".into()),
            },
            c,
        )
        .unwrap();
        let (code, body) = http_get(win.addr(), "/mesh/pull?space_id=space-x&since=0", Some("right"));
        assert_eq!(code, 200, "{body}");

        let (code, body) = http_get(win.addr(), "/push", Some("right"));
        assert_eq!(code, 501, "中枢端点必须**显式**说不支持：{code} {body}");
        assert!(body.contains("明确的不支持"), "{body}");

        let (code, _) = http_get(win.addr(), "/healthz", Some("right"));
        assert_eq!(code, 404);

        let (code, _) = http_get(win.addr(), "/mesh/pull?space_id=space-x", Some("wrong"));
        assert_eq!(code, 401);
        let (code, _) = http_get(win.addr(), "/mesh/pull?space_id=space-x", None);
        assert_eq!(code, 401);
    }

    /// 一个**手写的**最小 GET（判据不依赖被测的那一侧自己写的客户端）。
    fn http_get(addr: SocketAddr, target: &str, token: Option<&str>) -> (u16, String) {
        let mut sock = TcpStream::connect(addr).expect("connect");
        let auth = match token {
            Some(t) => format!("Authorization: Bearer {t}\r\n"),
            None => String::new(),
        };
        let req = format!("GET {target} HTTP/1.1\r\nHost: x\r\n{auth}Connection: close\r\n\r\n");
        sock.write_all(req.as_bytes()).unwrap();
        sock.flush().unwrap();
        let mut raw = Vec::new();
        sock.read_to_end(&mut raw).unwrap();
        let text = String::from_utf8_lossy(&raw).to_string();
        let code = text.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
        (code, body)
    }

    /// ⚠️ **变异实测**：把服务侧那条 SQL 的 `device_id = 我自己` 去掉 ⇒ "没有账本"那条判据
    /// 与 ★★ 判据都会红（别人的行会被服务出去）。这里只用**纯 SQL** 复算一遍这个后果，
    /// 免得将来有人以为那个 `WHERE` 是可有可无的优化。
    #[test]
    fn without_the_own_device_filter_the_window_would_leak_other_devices_rows() {
        let c = space_conn("A");
        local_edit(&c, &page("p1", "A 的", 10));
        crate::sync::set_meta_state(&c, "device_id", "B").unwrap();
        local_edit(&c, &page("p2", "B 的", 20));
        crate::sync::set_meta_state(&c, "device_id", "A").unwrap();

        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM changes WHERE device_seq > 0", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2, "库里确实有两条（一条是我的、一条不是）");
        assert_eq!(serve_own_records(&c, "A", 0, 500).unwrap().len(), 1, "而我只服务我自己的那条");
    }
}
