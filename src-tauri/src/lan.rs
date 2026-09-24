//! **局域网发现（甲-1 · 纯函数内核）**：在同一网段里找到「**本空间的中枢**」，
//! 并把基址从「配置的公网 URL」换成「局域网地址」。
//!
//! ## 这一层为什么先做纯函数
//!
//! 上位是[决策简报](docs/plans/2026-09-24-lan-p2p-topology-decision.md) §5／§10 与
//! [甲-1 施工单](docs/plans/2026-09-24-lan-discovery-workorder.md)：本片**不改 wire 形状、
//! 不动 schema、不内嵌服务端**。真正会出错的只有两件事 —— **地址怎么选**（`resolve_base`）
//! 与**别人塞进来的报文要不要信**（`decode_announce` / `is_lan_base`）。这两件都是纯函数，
//! 所以先落它们 ＋ 判据，UDP 收发与「代言」在下一片接线。
//!
//! ## 三条口径（判据钉着）
//!
//! 1. **匹配用远端 `space_id`，不是本地 `ws_id`**：档案里绑的那个 `space_id` 才是服务端的
//!    空间身份，公告里的 `hub_spaces` 同理。拿 `ws_id` 去比会在两台设备上恰好相等时**误连**。
//! 2. **公告里的地址必须是私有网段**（`is_lan_base`）：局域网发现只该产出局域网地址；
//!    一条公告声称自己在公网 ⇒ **不当直连用**（否则「发现层」成了被别人指哪打哪的入口）。
//! 3. **发现不到不许变得更差**：没有中枢时照旧用配置的地址（`Configured`）—— 发现层是**加分项**，
//!    它挂了不能让本来能同步的用户同步不了。
//!
//! ## ⚠️ 还没接线
//!
//! 除 `#[cfg(test)]` 外，本模块**还没有调用方**：纯函数内核（公告 / 路由）与运行时
//! （`PeerTable` / `bind_listener` / `announce_once` / `recv_into`）都已就位，
//! 但**启动时拉起监听、把解析结果用进 6 处 URL、状态行**都在接线那一片。
//! 所以整个模块显式放行 `dead_code` —— **接线那一片必须把这行删掉**（留着它会盖住真死码）。
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use tokio::net::UdpSocket;

/// 所有设备在网段里**收发公告的固定 UDP 端口**。
///
/// ⚠️ 为什么一个进程独占它、还不用 `SO_REUSEADDR`：本应用装了
/// `tauri-plugin-single-instance`（见 `Cargo.toml`）⇒ **同一台机器上不会有两个实例**。
/// 判据要造「两个实例」时用的是**显式单播目标 ＋ 临时端口**（见 §判据 ⑦），不依赖端口复用。
pub const LAN_PORT: u16 = 47821;

/// 对端表的存活期：超过这么久没再发声 ⇒ 视为已离开（对端表不是只增不减的历史）。
pub const PEER_TTL_MS: i64 = 90_000;

/// 公告的**线版本**。不认识 ⇒ **不猜**（如实丢弃，绝不按老版本解）。
///
/// 与 CRDT 那条 wire（`crdt_wire` / `wireConstants.ts`）是同一个纪律：三方（桌面/移动/将来）
/// 共用一个数字，各写各的字面量迟早漂。
pub const WIRE_VERSION: u32 = 1;

/// 单条公告的**字节上限**。UDP 报文本来就不该大；超过一律丢弃（防被灌爆）。
pub const MAX_ANNOUNCE_BYTES: usize = 8 * 1024;

/// 一条**公告**：某台设备在这个网段里喊「我是谁 ＋ 我替哪个服务端代言（可选）」。
///
/// `hub_base` / `hub_spaces` 是**代言**这一侧的字段：常开的那台设备广播「本网段的服务端在
/// `<hub_base>`，它服务这些空间」。⚠️ 它**只转述地址、不服务请求**（所以不撞许可墙，见施工单 §2 ③）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LanAnnounce {
    /// 线版本，见 [`WIRE_VERSION`]。
    pub v: u32,
    /// 设备身份（`device_id`，与同步档案同一套）。
    pub device_id: String,
    /// 设备名（给人看的状态行用；缺失不影响路由）。
    #[serde(default)]
    pub device_name: String,
    /// 代言的服务端基址（如 `http://192.168.1.5:8787`）。不代言 ⇒ `None`。
    #[serde(default)]
    pub hub_base: Option<String>,
    /// 该 `hub_base` 服务的空间（**远端 `space_id`**，见模块头口径 1）。
    #[serde(default)]
    pub hub_spaces: Vec<String>,
    /// 身份指纹。本片只透传与展示（配对/防呆留给 B 片）。
    #[serde(default)]
    pub fp: String,
}

/// 丢弃一条公告的**原因**（如实报，不静默）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnnounceReject {
    /// 超过 [`MAX_ANNOUNCE_BYTES`]。
    TooLong,
    /// 不是合法 JSON / 字段类型不对。
    BadJson,
    /// `v` 不是 [`WIRE_VERSION`]（**不猜**）。
    UnknownVersion,
    /// `device_id` 空（没有身份的公告无法归因）。
    NoDeviceId,
}

impl AnnounceReject {
    /// 给人看的原因（状态行/日志用）。
    pub fn reason(self) -> &'static str {
        match self {
            AnnounceReject::TooLong => "报文超过上限",
            AnnounceReject::BadJson => "不是合法公告",
            AnnounceReject::UnknownVersion => "版本不认识",
            AnnounceReject::NoDeviceId => "公告没有设备身份",
        }
    }
}

/// 编码一条公告。返回 `Result` 而不是静默空串：**发出去的东西不许无声地变成空**。
pub fn encode_announce(a: &LanAnnounce) -> Result<String, String> {
    serde_json::to_string(a).map_err(|e| format!("公告编码失败：{e}"))
}

/// 解码一条公告。**任何不合法都如实丢弃**（返回原因），绝不"尽力而为"地解一半。
pub fn decode_announce(raw: &str) -> Result<LanAnnounce, AnnounceReject> {
    if raw.len() > MAX_ANNOUNCE_BYTES {
        return Err(AnnounceReject::TooLong);
    }
    let a: LanAnnounce = serde_json::from_str(raw).map_err(|_| AnnounceReject::BadJson)?;
    if a.v != WIRE_VERSION {
        return Err(AnnounceReject::UnknownVersion);
    }
    if a.device_id.trim().is_empty() {
        return Err(AnnounceReject::NoDeviceId);
    }
    Ok(a)
}

/// 一个**发现到的对端**：公告 ＋ 它是从哪个地址来的（诊断与状态行用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    pub announce: LanAnnounce,
    /// 收到这条公告的来源地址（`ip`，不含端口）。
    pub addr: String,
    /// 最后一次听到它的时刻（毫秒）—— 过 [`PEER_TTL_MS`] 就不再算数。
    pub seen_at_ms: i64,
}

/// 基址是**怎么来的** —— 状态行必须说得出这一档（施工单 §2 ④）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    /// 局域网里发现到的中枢。
    Lan,
    /// 用户在同步设置里配的那个地址。
    Configured,
}

impl LinkKind {
    /// **前端契约**：状态行按这两个字面量分支（改字面量必须同时改前端）。
    pub fn as_str(self) -> &'static str {
        match self {
            LinkKind::Lan => "lan",
            LinkKind::Configured => "configured",
        }
    }
}

/// 一次同步要用的基址。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    /// 已经 `trim` 掉尾部 `/` 的基址（拼 `/push`、`/pull` 用）。
    pub url: String,
    pub kind: LinkKind,
}

/// ★ **本片的承重函数**：这次同步走哪个地址。
///
/// 规则（顺序即优先级）：
/// 1. 有 `space_id` 且**发现到服务它的局域网中枢** ⇒ 用它（[`LinkKind::Lan`]）；
/// 2. 否则用配置的地址（[`LinkKind::Configured`]）；
/// 3. 两者都没有 ⇒ `None`（尚未绑定，调用方保持今天的行为）。
///
/// ⚠️ 第 1 步只认**私有网段**的 `hub_base`（模块头口径 2）；公告说自己在公网 ⇒ 跳过它，
/// 继续找下一个对端（不是整体失败）。
pub fn resolve_base(space_id: &str, configured_url: &str, peers: &[Peer]) -> Option<Route> {
    let want = space_id.trim();
    if !want.is_empty() {
        for p in peers {
            if !p.announce.hub_spaces.iter().any(|s| s.trim() == want) {
                continue;
            }
            let Some(base) = p.announce.hub_base.as_deref() else {
                continue;
            };
            let base = base.trim().trim_end_matches('/');
            if !is_lan_base(base) {
                continue;
            }
            return Some(Route { url: base.to_string(), kind: LinkKind::Lan });
        }
    }
    let configured = configured_url.trim().trim_end_matches('/');
    if configured.is_empty() {
        return None;
    }
    Some(Route { url: configured.to_string(), kind: LinkKind::Configured })
}

/// 这个基址是不是**局域网**地址（`http://<私有 IPv4>[:port]`）。
///
/// 口径：**只认 http ＋ 私有 IPv4**。刻意不支持 IPv6 与主机名 —— 它们要额外解析一步，
/// 而"解析出来的地址属于谁"在这条路上没有能验证的凭据（B 片才引入指纹/配对）。
/// ⇒ 宁可**少认**：认不出的不当直连用（发现层是加分项，不是唯一通道）。
pub fn is_lan_base(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    // 只看 host[:port]；基址理论上不带路径，带了也忽略（不影响连通性判断）。
    let hostport = rest.split('/').next().unwrap_or("");
    if hostport.is_empty() || hostport.chars().any(char::is_whitespace) {
        return false;
    }
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (hostport, None),
    };
    if let Some(p) = port {
        if p.is_empty() || p.parse::<u16>().is_err() {
            return false;
        }
    }
    is_private_ipv4(host)
}

/// RFC 1918 三段 ＋ 链路本地（`169.254/16`）。`127/8` **不算**：回环不是"网段里的别人"。
fn is_private_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    let mut octets = [0u8; 4];
    for (i, p) in parts.iter().enumerate() {
        // ⚠️ 只认十进制、不许前导 `+`/空白：`u8::from_str` 已经挡掉这些。
        match p.parse::<u8>() {
            Ok(v) => octets[i] = v,
            Err(_) => return false,
        }
    }
    match octets {
        [10, ..] => true,
        [172, b, ..] if (16..=31).contains(&b) => true,
        [192, 168, ..] => true,
        [169, 254, ..] => true,
        _ => false,
    }
}

// ── 运行时（甲-1 第二片）：真的收发 ＋ 对端表 ────────────────────────────────────────────
//
// 这一层只做三件事：**收**（解不开就丢）、**记**（按 `device_id` 去重 ＋ TTL）、**发**。
// 刻意**不做**任何路由判断 —— 那是上面 `resolve_base` 的活（纯函数、判据在那儿）。
// ⚠️ 也刻意**不在这里读配置/写库**：本层不知道 `SyncProfile`，接线那一片才把两边接起来。

/// 网段里的**对端表**。按 `device_id` 去重：同一台设备再发声就是**刷新**，不是新增一行。
pub struct PeerTable {
    local_device_id: String,
    inner: Mutex<HashMap<String, Peer>>,
}

impl PeerTable {
    /// `local_device_id` 用来**挡掉自己**：发给回环的公告会原样回到自己手上，
    /// 不挡的话每台设备都会把自己当中枢。
    pub fn new(local_device_id: String) -> Self {
        Self { local_device_id, inner: Mutex::new(HashMap::new()) }
    }

    /// 记一条。返回 `false` ＝ **这条是我自己的**（不许进表）。
    pub fn upsert(&self, p: Peer) -> bool {
        if p.announce.device_id == self.local_device_id {
            return false;
        }
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.insert(p.announce.device_id.clone(), p);
        true
    }

    /// 还在发声的那些（`now_ms` 由调用方给 ⇒ 判据能造"时间过去了"）。
    pub fn live(&self, now_ms: i64) -> Vec<Peer> {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<Peer> = g
            .values()
            .filter(|p| now_ms.saturating_sub(p.seen_at_ms) <= PEER_TTL_MS)
            .cloned()
            .collect();
        // 顺序稳定（HashMap 的顺序不定）：按 device_id 排，免得状态行/判据抖。
        out.sort_by(|a, b| a.announce.device_id.cmp(&b.announce.device_id));
        out
    }

    /// 表里现在有什么（**不过滤 TTL**，给诊断用）。
    pub fn snapshot(&self) -> Vec<Peer> {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<Peer> = g.values().cloned().collect();
        out.sort_by(|a, b| a.announce.device_id.cmp(&b.announce.device_id));
        out
    }

    /// 腾掉过期的行（别让表随着"设备来过又走了"无限长）。
    pub fn sweep(&self, now_ms: i64) -> usize {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let before = g.len();
        g.retain(|_, p| now_ms.saturating_sub(p.seen_at_ms) <= PEER_TTL_MS);
        before - g.len()
    }
}

/// 绑监听口并打开广播（`255.255.255.255` 需要它；不开的话发广播会直接报错）。
pub async fn bind_listener(port: u16) -> Result<UdpSocket, String> {
    let sock = UdpSocket::bind(("0.0.0.0", port))
        .await
        .map_err(|e| format!("监听 UDP {port} 失败：{e}"))?;
    sock.set_broadcast(true)
        .map_err(|e| format!("打开 UDP 广播失败：{e}"))?;
    Ok(sock)
}

/// 默认要发的目标：**广播**（网段里的别人）＋ **回环**（同一台机器上的另一个进程/窗口）。
///
/// ⚠️ 回环那一条是**能自验**的关键：判据与"两个实例同机互看"都靠它，
/// 而广播在 CI/受限网段里未必可用 ⇒ 两条一起发，**任何一条成功就算发出去**。
pub fn default_targets(port: u16) -> Vec<SocketAddr> {
    let mut out = Vec::new();
    if let Ok(a) = format!("255.255.255.255:{port}").parse::<SocketAddr>() {
        out.push(a);
    }
    if let Ok(a) = format!("127.0.0.1:{port}").parse::<SocketAddr>() {
        out.push(a);
    }
    out
}

/// 把一条公告发给这些目标。返回**成功发出去的条数**；
/// 一条都没成功才报错（某一条目标不可达 —— 例如广播被禁 —— 不该让整轮发现失败）。
pub async fn announce_once(
    sock: &UdpSocket,
    targets: &[SocketAddr],
    a: &LanAnnounce,
) -> Result<usize, String> {
    let raw = encode_announce(a)?;
    let mut sent = 0usize;
    let mut last_err: Option<String> = None;
    for t in targets {
        match sock.send_to(raw.as_bytes(), t).await {
            Ok(_) => sent += 1,
            Err(e) => last_err = Some(e.to_string()),
        }
    }
    if sent == 0 {
        return Err(format!(
            "一条公告都没发出去：{}",
            last_err.unwrap_or_else(|| "没有目标地址".into())
        ));
    }
    Ok(sent)
}

/// 收**一条**并入库。三种结果，故意分得清清楚楚：
///
/// - `Ok(Some(peer))` ＝ 收了、记了；
/// - `Ok(None)` ＝ 是我自己的公告（回环回来的），**忽略**（不是错误）；
/// - `Err(原因)` ＝ 报文不合法，**丢弃**且**不入表**（原因从 [`AnnounceReject::reason`] 来）。
pub async fn recv_into(
    sock: &UdpSocket,
    table: &PeerTable,
    now_ms: i64,
) -> Result<Option<Peer>, String> {
    // 缓冲比上限多 1 字节 ⇒ 超长能被**识别成超长**，而不是被截断后误判成"不是 JSON"。
    let mut buf = vec![0u8; MAX_ANNOUNCE_BYTES + 1];
    let (n, from) = sock
        .recv_from(&mut buf)
        .await
        .map_err(|e| format!("收公告失败：{e}"))?;
    if n > MAX_ANNOUNCE_BYTES {
        return Err(AnnounceReject::TooLong.reason().to_string());
    }
    let raw = std::str::from_utf8(&buf[..n])
        .map_err(|_| AnnounceReject::BadJson.reason().to_string())?;
    let announce = decode_announce(raw).map_err(|r| r.reason().to_string())?;
    let peer = Peer {
        announce,
        addr: from.ip().to_string(),
        seen_at_ms: now_ms,
    };
    if !table.upsert(peer.clone()) {
        return Ok(None);
    }
    Ok(Some(peer))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(device: &str, base: Option<&str>, spaces: &[&str]) -> Peer {
        Peer {
            announce: LanAnnounce {
                v: WIRE_VERSION,
                device_id: device.to_string(),
                device_name: format!("{device} 的机器"),
                hub_base: base.map(|s| s.to_string()),
                hub_spaces: spaces.iter().map(|s| s.to_string()).collect(),
                fp: "fp".into(),
            },
            addr: "192.168.1.9".into(),
            seen_at_ms: 0,
        }
    }

    /// ★ 判据 ①：发现到**服务本空间**的中枢 ⇒ 基址是**局域网地址**且 `kind == Lan`。
    #[test]
    fn a_discovered_lan_hub_wins_over_the_configured_public_url() {
        let peers = vec![peer("dev-a", Some("http://192.168.1.5:8787"), &["sp-1"])];
        let got = resolve_base("sp-1", "https://shuyo.cn/sync", &peers).unwrap();
        assert_eq!(got.url, "http://192.168.1.5:8787");
        assert_eq!(got.kind, LinkKind::Lan, "发现到中枢就必须走局域网那一档");
    }

    /// ★ 判据 ②：网段里**没有**中枢 ⇒ 照旧用配置的公网地址。
    /// （发现层是加分项：它找不到东西时，不许让本来能同步的用户同步不了。）
    #[test]
    fn with_no_hub_in_sight_the_configured_url_is_still_used() {
        // 三种"没有"：对端表空、对端不代言、对端代言但服务别的空间。
        for peers in [
            vec![],
            vec![peer("dev-a", None, &["sp-1"])],
            vec![peer("dev-a", Some("http://192.168.1.5:8787"), &["sp-other"])],
        ] {
            let got = resolve_base("sp-1", "https://shuyo.cn/sync", &peers).unwrap();
            assert_eq!(got.url, "https://shuyo.cn/sync", "没有中枢时不许改变原来的地址");
            assert_eq!(got.kind, LinkKind::Configured);
        }
    }

    /// ★ 判据 ③：公告里**不服务这个空间**的对端**不许**成为路由。
    /// 匹配键是**远端 `space_id`**（模块头口径 1）：拿本地 `ws_id` 去比会在两台设备上
    /// 恰好相等时误连 —— 这正是本条要挡住的那类事故。
    #[test]
    fn a_peer_that_does_not_serve_this_space_is_not_a_route() {
        let peers = vec![
            peer("dev-a", Some("http://192.168.1.5:8787"), &["sp-2", "sp-3"]),
            peer("dev-b", Some("http://192.168.1.6:8787"), &["sp-1"]),
        ];
        let got = resolve_base("sp-1", "https://shuyo.cn/sync", &peers).unwrap();
        assert_eq!(got.url, "http://192.168.1.6:8787", "要跳过不服务本空间的那台");
        // 没有任何一台服务它 ⇒ 回落配置地址。
        let got = resolve_base("sp-9", "https://shuyo.cn/sync", &peers).unwrap();
        assert_eq!(got.kind, LinkKind::Configured);
    }

    /// 判据 ④：**配对**一条公告要能往返；不合法/截断/超长/版本不认识 ⇒ **如实丢弃并给出原因**。
    #[test]
    fn an_announce_is_dropped_when_it_is_malformed_or_from_another_version() {
        let a = peer("dev-a", Some("http://192.168.1.5:8787"), &["sp-1"]).announce;
        let raw = encode_announce(&a).unwrap();
        assert_eq!(decode_announce(&raw).unwrap(), a, "自己的公告要能原样解回来");

        // 截断（JSON 不完整）
        assert_eq!(decode_announce(&raw[..raw.len() - 3]), Err(AnnounceReject::BadJson));
        // 不是 JSON
        assert_eq!(decode_announce("hello"), Err(AnnounceReject::BadJson));
        // 版本不认识：**不猜**
        let mut other = a.clone();
        other.v = WIRE_VERSION + 1;
        assert_eq!(
            decode_announce(&encode_announce(&other).unwrap()),
            Err(AnnounceReject::UnknownVersion)
        );
        // 没有身份
        let mut anon = a.clone();
        anon.device_id = "  ".into();
        assert_eq!(
            decode_announce(&encode_announce(&anon).unwrap()),
            Err(AnnounceReject::NoDeviceId)
        );
        // 超长（一个合法的 JSON，但超过了字节上限）
        let mut huge = a.clone();
        huge.device_name = "x".repeat(MAX_ANNOUNCE_BYTES);
        let raw = encode_announce(&huge).unwrap();
        assert!(raw.len() > MAX_ANNOUNCE_BYTES);
        assert_eq!(decode_announce(&raw), Err(AnnounceReject::TooLong));
        // 四种原因都要能说出来（别只给一个 bool）
        for r in [
            AnnounceReject::TooLong,
            AnnounceReject::BadJson,
            AnnounceReject::UnknownVersion,
            AnnounceReject::NoDeviceId,
        ] {
            assert!(!r.reason().is_empty());
        }
    }

    /// 判据 ⑤：公告里声称的**公网**地址**永远不许**变成局域网直连
    /// （否则"发现层"就是被别人指哪打哪的入口）。跳过它，而不是整体失败。
    #[test]
    fn a_public_base_in_an_announce_never_counts_as_a_lan_route() {
        for bad in [
            "https://evil.example.com",
            "http://8.8.8.8:8787",
            "http://127.0.0.1:8787",   // 回环不是"网段里的别人"
            "http://192.168.1.5:notaport",
            "http://192.168.1.5:8787/x", // 带路径：host 解析照旧，但下面这条另测
        ] {
            let peers = vec![peer("dev-a", Some(bad), &["sp-1"])];
            let got = resolve_base("sp-1", "https://shuyo.cn/sync", &peers).unwrap();
            if bad == "http://192.168.1.5:8787/x" {
                // 带路径的仍是合法私有基址（路径被忽略）；其余一律跳过 ⇒ 回落配置地址。
                assert_eq!(got.url, "http://192.168.1.5:8787/x");
                assert_eq!(got.kind, LinkKind::Lan);
                continue;
            }
            assert_eq!(got.kind, LinkKind::Configured, "{bad} 不许当直连用");
            assert_eq!(got.url, "https://shuyo.cn/sync");
        }
        // `is_lan_base` 自己的正反例（它是上面那条的判别器）
        assert!(is_lan_base("http://10.0.0.7:8787"));
        assert!(is_lan_base("http://172.16.3.4:8787"));
        assert!(is_lan_base("http://169.254.1.1:8787"));
        assert!(is_lan_base("http://192.168.1.5")); // 无端口也算（默认端口由拼 URL 那一侧决定）
        assert!(!is_lan_base("http://172.32.0.1:8787")); // 出了 172.16/12
        assert!(!is_lan_base("http://192.168.1.256")); // 非法八位组
        assert!(!is_lan_base("http://192.168.1.5:8787:9")); // 两个冒号
        assert!(!is_lan_base("http://192.168.1 .5:8787")); // 空白
    }

    /// 判据 ⑥（契约）：`LinkKind` 的两个字面量是**前端状态行的分支依据**，钉住它们。
    #[test]
    fn the_link_kind_is_what_the_status_line_shows() {
        assert_eq!(LinkKind::Lan.as_str(), "lan");
        assert_eq!(LinkKind::Configured.as_str(), "configured");
    }

    // ---- 运行时（甲-1 第二片）----

    fn announce_of(device: &str, base: Option<&str>, spaces: &[&str]) -> LanAnnounce {
        LanAnnounce {
            v: WIRE_VERSION,
            device_id: device.to_string(),
            device_name: format!("{device} 的机器"),
            hub_base: base.map(|s| s.to_string()),
            hub_spaces: spaces.iter().map(|s| s.to_string()).collect(),
            fp: "fp".into(),
        }
    }

    /// ★ 判据 ⑦：**真的**走一次 UDP 收发（显式单播 ＋ 临时端口，不依赖广播与端口复用），
    /// 并且**从收进对端表一路串到地址解析** —— 这条把"纯函数内核"与"传输层"接起来验：
    /// 收侧表里有它 ⇒ `resolve_base` 当场给出局域网路由。
    #[tokio::test]
    async fn two_instances_find_each_other_over_a_real_datagram() {
        let a = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let b = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let b_addr = b.local_addr().unwrap();
        let table = PeerTable::new("dev-b".to_string());

        let ann = announce_of("dev-a", Some("http://192.168.1.5:8787"), &["sp-1"]);
        assert_eq!(announce_once(&a, &[b_addr], &ann).await.unwrap(), 1);

        let got = recv_into(&b, &table, 1_000).await.unwrap().expect("应当收到对端");
        assert_eq!(got.announce.device_id, "dev-a");
        assert_eq!(got.addr, "127.0.0.1", "来源地址要如实记下（诊断用）");
        assert_eq!(got.seen_at_ms, 1_000);

        // ★ 打通：收进来的公告**真的**能让这一轮的地址解析走局域网。
        let route = resolve_base("sp-1", "https://shuyo.cn/sync", &table.live(1_000)).unwrap();
        assert_eq!(route.url, "http://192.168.1.5:8787");
        assert_eq!(route.kind, LinkKind::Lan);
    }

    /// 判据 ⑧：坏报文**永远不许**进对端表，而且**原因说得出来**。
    #[tokio::test]
    async fn a_garbled_datagram_never_enters_the_peer_table() {
        let a = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let b = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let table = PeerTable::new("dev-b".to_string());

        // 不是 JSON
        a.send_to(b"hello", b.local_addr().unwrap()).await.unwrap();
        assert_eq!(
            recv_into(&b, &table, 1_000).await.unwrap_err(),
            AnnounceReject::BadJson.reason()
        );
        // 版本不认识（合法 JSON，但 v 不是我们的）
        let mut other = announce_of("dev-a", None, &[]);
        other.v = WIRE_VERSION + 1;
        a.send_to(
            encode_announce(&other).unwrap().as_bytes(),
            b.local_addr().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            recv_into(&b, &table, 1_000).await.unwrap_err(),
            AnnounceReject::UnknownVersion.reason()
        );

        assert!(table.snapshot().is_empty(), "坏报文不许留下任何痕迹");
    }

    /// 判据 ⑨：**自己的公告**不许成为对端（回环会把我们发的原样送回来，
    /// 不挡的话每台设备都会把自己当成中枢）。
    #[tokio::test]
    async fn my_own_announce_never_becomes_a_peer() {
        let a = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let b = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let table = PeerTable::new("dev-a".to_string()); // ← 表的主人就是发公告这台
        let ann = announce_of("dev-a", Some("http://192.168.1.5:8787"), &["sp-1"]);
        announce_once(&a, &[b.local_addr().unwrap()], &ann).await.unwrap();

        assert!(recv_into(&b, &table, 1_000).await.unwrap().is_none(), "自己的公告要回 None");
        assert!(table.snapshot().is_empty());
    }

    /// 判据 ⑩：不再发声的对端会过期；表不是只增不减的（同一台再发声则是**刷新**）。
    #[test]
    fn a_peer_that_stopped_announcing_expires() {
        let table = PeerTable::new("dev-me".to_string());
        assert!(table.upsert(peer("dev-a", Some("http://192.168.1.5:8787"), &["sp-1"])));
        // `peer()` 造的 seen_at_ms = 0
        assert_eq!(table.live(PEER_TTL_MS).len(), 1, "还没到 TTL 就算还在");
        assert!(table.live(PEER_TTL_MS + 1).is_empty(), "过了 TTL 就不该再算数");
        assert_eq!(table.snapshot().len(), 1, "snapshot 不过滤 TTL（诊断要看得见）");
        assert_eq!(table.sweep(PEER_TTL_MS + 1), 1, "sweep 要把过期的腾掉");
        assert!(table.snapshot().is_empty());

        // 同一台再发声 ⇒ 刷新时刻，不新增行
        let mut again = peer("dev-a", Some("http://192.168.1.5:8787"), &["sp-1"]);
        again.seen_at_ms = 5_000;
        assert!(table.upsert(again));
        assert_eq!(table.live(5_000).len(), 1);
        assert_eq!(table.live(5_000)[0].seen_at_ms, 5_000);
    }

    /// 判据 ⑪：默认目标要**同时**含广播与回环 —— 广播在受限网段未必可用，
    /// 回环是"同一台机器上也能自验"的那一条（两条都发，任一成功即算发出）。
    #[test]
    fn the_default_targets_cover_broadcast_and_loopback() {
        let t = default_targets(LAN_PORT);
        assert!(t.iter().any(|a| a.ip().to_string() == "255.255.255.255"), "要发广播");
        assert!(t.iter().any(|a| a.ip().is_loopback()), "要有回环那条");
        assert!(t.iter().all(|a| a.port() == LAN_PORT));
    }
}
