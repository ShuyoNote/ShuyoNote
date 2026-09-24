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
//! ## ⚠️ 本片未接线
//!
//! 除 `#[cfg(test)]` 外，本模块**还没有调用方**（UDP 广播/监听、对端表、状态行都在下一片）。
//! 所以整个模块显式放行 `dead_code` —— **接线那一片必须把这行删掉**（留着它会盖住真死码）。
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

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
}
