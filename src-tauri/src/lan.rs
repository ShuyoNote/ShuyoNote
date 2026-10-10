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
//! ## 接线现状（甲-1 接线那一片）
//!
//! 纯函数内核（公告编解码 / 路由 [`resolve_base`] / **代言的产出侧** [`announce_for_own_hub`] /
//! **状态行文本** [`status_line`]）与运行时（[`PeerTable`] / [`bind_listener`] /
//! [`announce_once`] / [`recv_into`]）**都已经有调用方**：
//!   · 地址解析：`sync::effective_base`（push／pull／附件）与 `sync::effective_base_for`
//!     （`lineage-claim` 与 SSE 订流）—— 基址只从这两处出；
//!   · 状态行：`sync::lan_status`（接界面）；
//!   · 收发：`lan_state::start` 那条循环（周期广播 ＋ 收报入库 ＋ 腾过期行）。
//!
//! ⚠️ 因此**模块顶上的 `#![allow(dead_code)]` 已经删掉**（它是接线前的临时放行；留着会盖住真死码）。
//! 本文件里没有"只给判据用"的旁路：生产路径与判据走的是**同一批函数**
//! （`PeerTable` 那几个访问器经 `LanState` 被 `lan_state::start` 与 `sync::effective_base` 用到）。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
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
    /// 身份指纹。★ **＝ `device_id`**（owner 2026-09-25 拍板，B 片施工单 §8.3）：
    /// 填的是**应用级事实**（设备标识），**不是**"设备密钥材料的指纹" ——
    /// 它要挡的是**掉包**，不是"同一台设备换了钥匙"。语义不许悄悄改（真需要后者时另立字段）。
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
            if !serves_space(space_id, p) {
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

/// ★ 这条公告**服务不服务**这个空间 —— **唯一的一把尺**，凡是"某台设备认不认这个空间"都走它。
///
/// 口径：`hub_spaces` 里含这个空间的**去空白字面量相等**（不看格式 —— 网格不检查 `space_id` 是
/// 哪来的，`lan.rs:181` 的既有口径）。空 `space_id` ⇒ **一律不认**（"没指定空间"不是"谁都算"）。
///
/// ⚠️ 为什么必须抽成一个函数（而不是各处写一遍 `iter().any(|s| s.trim() == want)`）：
/// 丙档有**三处**要问这句话 —— 地址解析（[`resolve_base`]）、谁可以被直接拉（`mesh::invitable_base`）、
/// 以及界面上那一条"服务 项目A"（`sync::NearbyPeer::serves_current`）。
/// 三处各写一遍就会漂，而**漂了不炸、不报错、单测全绿**：现场是"列表说它服务这个空间，
/// 可它就是拉不动"（或反过来）。
pub fn serves_space(space_id: &str, p: &Peer) -> bool {
    let want = space_id.trim();
    !want.is_empty() && p.announce.hub_spaces.iter().any(|s| s.trim() == want)
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

/// RFC 1918 三段 ＋ 链路本地（`169.254/16`）＋ **CGNAT 共享段（`100.64/10`）**。
/// `127/8` **不算**：回环不是"网段里的别人"。
///
/// ⚠️ 最后那一段是 **owner 2026-09-30 拍 D14（放行 CGNAT）**：`100.64.0.0/10`（RFC 6598）
/// **Tailscale 默认就用它**，而它**不是** RFC 1918、也**不是**链路本地 ⇒ 不放行 ⇒
/// 对端的 `hub_base` 会被 [`resolve_base`] 静默跳过。
/// ⚠️ **这是与 `mesh::is_lan_only` 成对的第二把尺**：两张表**必须同时放宽**
/// （作者注释见 [`announce_for_own_hub`]），判据 `mesh::tests::the_two_lan_range_tables_agree`
/// 逐地址比对两者，防"只改一把"。⚠️ std 的 `Ipv4Addr::is_shared()` 在 MSRV 1.94 与 stable 1.98
/// 上都还是 unstable（`E0658` / issue #27709）⇒ 手写这一段。
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
        [100, 64..=127, ..] => true, // ⚠️ D14：`100.64.0.0/10`（含两端）
        _ => false,
    }
}

/// ★ **代言的产出侧**：我这台设备该不该替某个地址代言？该 ⇒ 产出那条公告。
///
/// 常开的那台桌面版**自己就是照着某个基址在同步的** ⇒ 如果那个基址本身就是局域网地址，
/// 它就有资格替它代言（**只转述地址、不服务请求** —— 施工单 §2 ③，所以不撞许可墙）。
///
/// ⚠️ **这里必须和消费侧用同一把尺**（[`is_lan_base`]）。若产出侧改用一把更松的尺
/// （比如"只要是非空 http 就行"），公告**发得出去、却永远被 [`resolve_base`] 跳过** ——
/// 现象是「代言开着，网段里却没人被找到」，而它**没有编译期信号、单测也照绿**。
/// 判据 ⑫（`an_announce_we_produce_is_always_one_we_would_accept`）钉的就是这条**往返性质**。
///
/// 取 `Option` 而不是"尽力产出"：**没资格时代言就该是空的** —— 往网段里灌一条永远不会被
/// 采纳的公告，会让别人状态行里的「发现 N 台」虚高。
///
/// ★ **`fp` ＝ `device_id`**（owner 2026-09-25 拍板，B 片施工单 §8.3）：字段注释原话说"本片只透传
/// 与展示（配对/防呆留给 B 片）"，现在这一半补上了。⚠️ **它填的是应用级事实 `device_id`，不是
/// "设备密钥材料的指纹"** —— 理由三条：① 它已经在服务端与公告里流通，不是新暴露面；
/// ② 稳定（轮换钥匙不会让用户看到"设备名变了"）；③ 它要挡的是**掉包**，不是"同一台设备换了钥匙"。
/// 真需要后者时那是**另一条判据、另立字段**，不许把 `fp` 的语义悄悄改掉。
pub fn announce_for_own_hub(
    local_device_id: &str,
    device_name: &str,
    configured_url: &str,
    space_id: &str,
) -> Option<LanAnnounce> {
    let base = configured_url.trim().trim_end_matches('/');
    // ① 自己用的地址都不是局域网地址 ⇒ 没什么可代言的。
    if !is_lan_base(base) {
        return None;
    }
    let dev = local_device_id.trim();
    let space = space_id.trim();
    // ② 没有设备身份 / 没有空间身份 ⇒ 代言不成立：`resolve_base` 的匹配键就是 `hub_spaces`
    //    （模块头口径 1），空身份只会产出没人能用的公告。
    if dev.is_empty() || space.is_empty() {
        return None;
    }
    Some(LanAnnounce {
        v: WIRE_VERSION,
        device_id: dev.to_string(),
        device_name: device_name.trim().to_string(),
        hub_base: Some(base.to_string()),
        hub_spaces: vec![space.to_string()],
        // ★ 见上面那段：`fp` ＝ 应用级事实 `device_id`（B 片施工单 §8.3 的收口）。
        fp: dev.to_string(),
    })
}

/// ★ **状态行**：如实说出这次走的是哪一档，以及网段里看到了什么。
///
/// 口径（施工单 §2 ④ ／ 简报 §7）：**「没走成直连」必须是一个可断言的结果，不是静默降级**。
/// 用户要能分辨三件**处置完全不同**的事：
///   ① 走了局域网（`Lan`）；
///   ② 网段里**根本没有**别的设备（没辙）；
///   ③ 网段里有设备，但**都不服务这个空间**（配置/身份不匹配 —— 有得救）。
/// ②③ 长得一样正是这条要堵的：只说一句「公网」，两件事就分不开了。
///
/// ⚠️ **档位只能由 [`Route`] 决定**，状态行**不许自己再判一次**（判据 ⑭ 钉这条）：
/// 用户把配置地址直接填成 `http://192.168.1.5:8787` 是常见事，而网段里一个对端都没有时
/// `resolve_base` 给的是 `Configured`；若这里按"地址形状"自己判，就会说出「局域网」。
///
/// `seen` 是**活着**的对端数、`observed` 是表里一共有过多少台（诊断用，不过滤 TTL）——
/// 两者不等时状态行会**如实**把"来过又走了"说出来，而不是让"N 台"这个数悄悄变来变去。
pub fn status_line(
    route: Option<&Route>,
    peers: &[Peer],
    space_id: &str,
    observed: usize,
) -> String {
    let Some(route) = route else {
        return "同步地址：尚未绑定".to_string();
    };

    let seen = peers.len();
    let want = space_id.trim();
    // 代言人 = 公告里的 `hub_base` 正好是当前基址的那一台（`Lan` 档一定找得到它）。
    let hub = peers.iter().find_map(|p| {
        let base = p.announce.hub_base.as_deref()?.trim().trim_end_matches('/');
        let name = p.announce.device_name.trim();
        (base == route.url && !name.is_empty()).then(|| name.to_string())
    });

    let mut line = match route.kind {
        LinkKind::Lan => format!("同步地址：直连（同一网络）{}", route.url),
        LinkKind::Configured => format!("同步地址：公网 {}", route.url),
    };
    line.push_str(&format!(" ｜ 附近发现 {seen} 台"));
    if observed > seen {
        // ⚠️ 只说事实（"还见过 N 台，现在不发声了"），不替用户下结论（那可能是关机、也可能只是丢包）。
        line.push_str(&format!("（还见过 {} 台，现在不发声了）", observed - seen));
    }

    if route.kind == LinkKind::Lan {
        match hub {
            Some(name) => line.push_str(&format!(" ｜ 中枢：{name}")),
            // 找到了地址、但那一台没报名字 ⇒ **如实说没报**，不编一个。
            None => line.push_str(" ｜ 中枢：只报了地址"),
        }
    } else if seen > 0
        && !want.is_empty()
        && !peers
            .iter()
            .any(|p| p.announce.hub_spaces.iter().any(|s| s.trim() == want))
    {
        line.push_str(" ｜ 其中没有服务这个空间的中枢");
    }
    line
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
    ///
    /// ⚠️ 生产路径**不直接调它**：上层是 `LanState::observed_all`（同一个语义，但走那条路
    /// 才说得清"诊断读数"与"能用的对端"是两件事，见 `lan_state.rs` 口径 3）。
    pub(crate) fn snapshot(&self) -> Vec<Peer> {
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

/// 绑监听口，**绑不上就退避重试，直到绑上**（★ 2026-10-04 加）。
///
/// ## 为什么要有它（真机实测）
///
/// Windows 上「上一个实例的 UDP socket 还没释放、新实例已经启动」会给出
/// **`os error 10048`（地址已被占用）**。本机那份 dev 日志（`%LOCALAPPDATA%\Temp\shuyonote-dev.log`）
/// 从 09-22 到 10-04 的 **12 天里记了 9 次**这种失败 —— 全是**偶发**，不是端口被谁长期占着
/// （⭐ 实测：探针随时都绑得上 ✓）。
///
/// ⚠️ 而 [`bind_listener`] 的调用方原先**失败就 `return`** ✗，加上
/// [`crate::lan_state::LanState`] 的启动有 `OnceLock` 幂等 ⇒ ⭐ **首次一失败，这次会话就永久没有发现层**
/// ✗（占用者两秒后退出也不会再试 ✓）—— 症状是"面板上那行设备直连一直不出现"，
/// 而**界面完全不报**（只有日志一行 ✓）。
///
/// ## 退避与日志
///
/// 1s → 2s → 4s → … → 上限 **30s**，**无限重试**（发现层是加分项，晚点起来也值得 ✓）。
/// ⚠️ 日志**只在退避值变化时**打一行 ⇒ 天然限流（封顶后 30s 一行，不会刷屏 ✓）；
/// 绑上时若曾重试过，补一行"起来了"（⭐ 免得日志里只剩失败、看不出它最终成功了 ✓）。
pub async fn bind_listener_with_retry(port: u16) -> UdpSocket {
    const MAX_DELAY_MS: u64 = 30_000;
    let mut delay_ms: u64 = 1_000;
    let mut retries: u32 = 0;
    let mut last_logged: u64 = 0;
    loop {
        match bind_listener(port).await {
            Ok(sock) => {
                if retries > 0 {
                    eprintln!("[lan] 发现层起来了（UDP {port} 已绑定，重试 {retries} 次之后）");
                }
                return sock;
            }
            Err(e) => {
                retries += 1;
                if last_logged != delay_ms {
                    eprintln!("[lan] 绑不上 UDP {port}（{delay_ms}ms 后重试，同步照旧）：{e}");
                    last_logged = delay_ms;
                }
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                delay_ms = (delay_ms * 2).min(MAX_DELAY_MS);
            }
        }
    }
}

#[cfg(test)]
mod bind_retry_tests {
    use super::*;

    /// 取一个**空闲的**临时端口号（⭐ 不用 47821 ✗ —— 那会打扰本机真跑着的那份发现层 ✓）。
    async fn free_port() -> u16 {
        let probe = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        port
    }

    /// ★ 判据（2026-10-04 加）：**首次绑不上时不许放弃** ✗ —— 要等到占用者释放后自己绑上 ✓。
    ///
    /// 做法：先占住那个端口，200ms 后释放；`bind_listener_with_retry` 必须**最终**成功 ✓。
    /// ⚠️ 这条正是"那次 10048 之后永久没发现层"的反向判据：⭐ 旧写法在这里会**直接返回** ✗。
    #[tokio::test]
    async fn retries_until_the_port_frees_up() {
        let port = free_port().await;
        let squatter = UdpSocket::bind(("0.0.0.0", port))
            .await
            .expect("占用者要能绑上这个端口");
        let release = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            drop(squatter);
        });
        let sock = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            bind_listener_with_retry(port),
        )
        .await
        .expect("10 秒内必须绑上 —— 超时说明它没有重试（旧写法的症状）");
        assert_eq!(sock.local_addr().unwrap().port(), port);
        release.await.unwrap();
    }

    /// ★ 反向判据：**端口空着时不许无谓重试** ✓（第一次就成功 ⇒ 立刻返回 ✓）。
    #[tokio::test]
    async fn binds_immediately_when_the_port_is_free() {
        let port = free_port().await;
        let sock = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            bind_listener_with_retry(port),
        )
        .await
        .expect("空闲端口应当立刻绑上（2 秒内）");
        assert_eq!(sock.local_addr().unwrap().port(), port);
    }
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

/// ★★ 2026-09-26（真机抓到的**单向发现**）：这一轮公告到底发到哪些地址。
///
/// = [`default_targets`]（广播 ＋ 回环）**＋ 已经认识的对端各自的地址（单播）**。
///
/// ## 为什么必须补单播那一条（现场：Mate 40 看得见 MIX 2，MIX 2 看不见 Mate 40）
///
/// `255.255.255.255` 是**受限广播**：它按**默认路由**挑出口。热点**主机**（Mate 40）的默认路由是
/// **蜂窝**（`network_type` 实测就是 `cellular`）⇒ 那条广播发到蜂窝上去了，**热点底下的客户端
/// 永远收不到**；而客户端（MIX 2）的默认路由就是 wlan0 ⇒ 它的广播主机收得到 ⇒ 于是**只有单向**。
/// 单播那一条把方向补回来：客户端先被主机听见（它的表里就有了客户端的地址），
/// 主机下一轮把公告**直接发回那个地址** ⇒ 客户端也听得见主机。
///
/// ⚠️ **代价如实写**：冷启动那一次（表还空着）仍然只能靠广播 ⇒ 单向的那一半最多要等
/// **一个广播间隔**（`ANNOUNCE_INTERVAL_MS`，30 秒）才被补上。这不影响收敛，只影响"多久露面"。
/// ⚠️ 台数上限：目标里每多一台就多一条 UDP（30 秒一轮）——网段里 N 台时是 N 条，噪音可控。
/// ⚠️ 解析不出来的 `addr`（空串 / 非 IP）**跳过**：公告的来路是外部输入，不许在这里 panic。
pub fn announce_targets(port: u16, peers: &[Peer]) -> Vec<SocketAddr> {
    let mut out = default_targets(port);
    for p in peers {
        let ip = p.addr.trim();
        if ip.is_empty() {
            continue;
        }
        // 只认字面 IPv4/IPv6（`addr` 是**报文来源**，不是我们编的）。
        let Ok(ip) = ip.parse::<IpAddr>() else { continue };
        let a = SocketAddr::new(ip, port);
        if !out.contains(&a) {
            out.push(a);
        }
    }
    out
}

/// 把一条公告发给这些目标。返回**这一次到底发生了什么**；
/// 一条都没成功才报错（某一条目标不可达 —— 例如广播被禁 —— 不该让整轮发现失败）。
///
/// ⭐ **2026-10-09（task-8）**：返回值从 `usize` 换成 [`AnnounceOutcome`] —— ⛔ 原来的形状
/// **部分失败是静默的** ✗（只留 `last_err`、只在**全部**失败时用它 ✓）⇒ 「要发 5 条只出去 1 条」
/// 这种最难查的形状在日志里**一个字都没有** ✓ ⇒ 现在**逐条**记下是哪一条失败、为什么 ✓。
pub async fn announce_once(
    sock: &UdpSocket,
    targets: &[SocketAddr],
    a: &LanAnnounce,
) -> Result<AnnounceOutcome, String> {
    let raw = encode_announce(a)?;
    let mut failures: Vec<(SocketAddr, String)> = Vec::new();
    for t in targets {
        if let Err(e) = sock.send_to(raw.as_bytes(), t).await {
            failures.push((*t, e.to_string()));
        }
    }
    let sent = targets.len().saturating_sub(failures.len());
    if sent == 0 {
        let why = failures
            .first()
            .map(|(t, e)| format!("{t} ← {e}"))
            .unwrap_or_else(|| "没有目标地址".into());
        return Err(format!("一条公告都没发出去：{why}"));
    }
    Ok(AnnounceOutcome { targets: targets.to_vec(), failures })
}

/// ⭐ **2026-10-09（task-8）**：一条公告**发出去之后**的读数。
///
/// ⚠️ 逐条记失败（⛔ 不是"只记最后一条"✗）：真机上"发出去几条"这一格今天**除了日志没有别的观测面**
/// （`47821` 被应用独占 ⇒ 外部绑不上 ✗）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnnounceOutcome {
    /// 这一轮要发给哪些目标（含广播/回环 ✓）。
    pub targets: Vec<SocketAddr>,
    /// ⭐ **失败的那些**：`(目标地址, 错误原文)` ✓。
    pub failures: Vec<(SocketAddr, String)>,
}

impl AnnounceOutcome {
    /// 成功发出去的条数 ✓。
    pub fn sent(&self) -> usize {
        self.targets.len().saturating_sub(self.failures.len())
    }
}

/// ⭐ **task-12（owner/Lead 已批）**：日志行的**本地时刻**（`HH:MM:SS` ✓）。
///
/// ⛔ 没有它，**两边的日志对不上时刻** ✗ —— 今天正是需要对齐"我方某一刻失败"与"同一刻对端在说什么"
/// 而做不到 ✓（Lead 原话：这条**已经在咬我们** ✓）。格式刻意与 `sync_history.at` 的展示口径一致 ✓。
pub fn log_stamp() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

/// ⭐ **2026-10-09（task-8）**：发送那一行的**人话** —— 纯函数（判据够得着 ✓，与 `mesh_history_message` 同一形状 ✓）。
///
/// 三样都要在：**成功/共几条** ✓、**目标长什么样** ✓、**空间**（打码 ✓）；
/// 而 ⭐ **部分失败逐条点名 ＋ 带上错误原文** ✓ —— 那正是今天判不了的那一格 ✓。
/// 改这一处时守住：⛔ 失败一条都不许吞 ✗、⛔ 空间名不许整串打出来 ✗（只给前几位 ✓）。
pub fn announce_send_line(o: &AnnounceOutcome, space: &str) -> String {
    // ⚠️ 目标**如实分类**（⛔ 不猜"哪些是对端"✗ —— `announce_targets` 里既有广播/回环、也有已知对端，
    //    而本函数拿不到那张分表 ✓ ⇒ 只按**地址本身**说得出的那三类报 ✓）。
    let bcast255 = o
        .targets
        .iter()
        .filter(|t| matches!(t.ip(), IpAddr::V4(v) if v.is_broadcast()))
        .count();
    let loopback = o.targets.iter().filter(|t| t.ip().is_loopback()).count();
    let other = o.targets.len().saturating_sub(bcast255 + loopback);
    let mut line = format!(
        "[{}] [mesh] 公告：发出 {}/{}（目标 {} 条：受限广播 {} ｜ 回环 {} ｜ 其它 {}）｜ 空间 {}",
        log_stamp(),
        o.sent(),
        o.targets.len(),
        o.targets.len(),
        bcast255,
        loopback,
        other,
        mask_space(space)
    );
    // ⭐ 部分失败逐条点名 ＋ 错误原文 ✓（⛔ 一条都不许吞 ✗）—— 这正是"发出去了几条"这一格的关键 ✓。
    for (t, e) in &o.failures {
        line.push_str(&format!(" ｜ ⚠️ {t} 发送失败：{e}"));
    }
    line
}

/// 空间名**打码**：只给前几位 ✓（日志里没有任何理由出现完整空间标识 ✓）。
pub fn mask_space(s: &str) -> String {
    let s = s.trim();
    if s.is_empty() {
        return "(无)".to_string();
    }
    format!("{}…", s.chars().take(4).collect::<String>())
}

/// device_id **前 8 位**（日志里点得到名、又不必整串 ✓）。
fn short_id(s: &str) -> String {
    s.trim().chars().take(8).collect()
}

/// ⭐ **2026-10-09（task-8）**：收到一条公告之后的那一行 —— 纯函数 ✓。
///
/// ⚠️ ⭐ **"收到但不会进网格候选"必须说得出为什么** ✗：真机上「公告到底有没有到」「到了为什么没用上」
/// 是**两件事**，而它们今天在日志里完全同形（都是"什么都没有"）✗ ⇒ 这一行把 **来源 ＋ 对端 ＋ 它代言的空间
/// ＋ 与本机空间匹配与否** 一次说清 ✓。
pub fn announce_recv_line(peer: &Peer, our_spaces: &[String]) -> String {
    let theirs = &peer.announce.hub_spaces;
    let matched = theirs
        .iter()
        .any(|s| our_spaces.iter().any(|o| o.trim() == s.trim()));
    // ⭐ 这一句就是"收到了但不会进网格候选"的**原因** ✓（⛔ 不许含糊成"收到了一条"✗）。
    let verdict = if our_spaces.is_empty() {
        "⛔ 本机现在**没有**在用/代言的网格空间 ⇒ 它不会成为网格对端"
    } else if matched {
        "✅ 与本机空间**匹配** ⇒ 可以成为网格对端"
    } else {
        "⛔ 与本机空间**不匹配** ⇒ 不会成为网格对端"
    };
    let theirs_shown: Vec<String> = theirs.iter().map(|s| mask_space(s)).collect();
    let ours_shown: Vec<String> = our_spaces.iter().map(|s| mask_space(s)).collect();
    // ⭐ **task-12（Lead 批）**：⭐ **把 `hub_base` 也打出来** ✗ —— 因为 `mesh_peers` **拨的就是它** ✓
    //   ⇒ 哪天出现"公告说 A、拨的却是 B"，没有这一格**看不出来** ✓（"两个东西同名"那一族 ✓）。
    //   ⚠️ 它是**我们自己的地址**（不是秘密 ✓）⇒ 可以打全 ✓。
    let base = peer
        .announce
        .hub_base
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .unwrap_or("(不代言)");
    format!(
        "[{}] [mesh] 收到公告：来源 {} ｜ 对端 {} ｜ 它代言 {} 个空间 [{}] ｜ 它报的地址 {} ｜ {}（本机空间 [{}]）",
        log_stamp(),
        peer.addr,
        short_id(&peer.announce.device_id),
        theirs.len(),
        if theirs_shown.is_empty() { "无".to_string() } else { theirs_shown.join("、") },
        base,
        verdict,
        if ours_shown.is_empty() { "无".to_string() } else { ours_shown.join("、") }
    )
}

/// ⭐ **2026-10-09（task-8）**：收到**但没进表**时的那一行 —— 纯函数 ✓。
///
/// ⚠️ ⭐ 它存在的理由就一句：**"收到了但被丢掉"与"根本没收到"必须分得开** ✗ ——
/// 今天 `lan_state` 把 `recv_into_within` 的返回值**整个丢掉**（`let _ = …` ✓）⇒ 坏报文、
/// 自己的回环报文、超长报文，全都**无声** ✓。
pub fn announce_drop_line(addr: &str, reason: &str) -> String {
    format!("[{}] [mesh] 收到但**没进表**：来源 {addr} ｜ 原因：{reason}", log_stamp())
}

/// 收**一条**的结果 —— ⛔ 三件事必须**分得开**（以前 `Option` 把前两件混成一个 `None` ✗）。
///
/// ⭐ **2026-10-09（task-8）**：为什么必须分：真机上「**收到但没进表**」与「**根本没收到**」
/// 在调用方看来以前是**同一个** `Ok(None)` ✗ ⇒ 日志里两件完全不同的事同形 ✓ ——
/// 而这一格恰恰是"发现层到底通没通"的判据 ✓。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecvOutcome {
    /// 收了、入库了（`peer` 就是入库的那一条 ✓）。
    Peer(Peer),
    /// 收到的是**我自己**的公告（回环回来）⇒ **有意丢弃**（不是错误 ✓）。
    OwnAnnounce { from: String },
    /// 报文**不合法** ⇒ 丢弃且不入表（⚠️ 带上来源，否则日志说不清是谁在发坏包 ✓）。
    Rejected { from: String, reason: String },
    /// 这一片**什么都没收到**（超时 ✓）—— ⛔ 不是错误，也⛔ 不该打日志刷屏（每 1s 一次 ✓）。
    Nothing,
}

/// 收**一条**并入库。四种结果见 [`RecvOutcome`]（**故意分得清清楚楚**）。
///
/// ⚠️ 入库那一步走的是 `LanState::record_datagram`（**解码只有那一处**）—— 本函数只负责
/// "从 socket 收字节 ＋ 长报文那一关"，语义与状态在 `lan_state.rs`（那里是判据的主场）。
pub async fn recv_into(
    sock: &UdpSocket,
    state: &crate::lan_state::LanState,
    now_ms: i64,
) -> Result<RecvOutcome, String> {
    // 缓冲比上限多 1 字节 ⇒ 超长能被**识别成超长**，而不是被截断后误判成"不是 JSON"。
    let mut buf = vec![0u8; MAX_ANNOUNCE_BYTES + 1];
    let (n, from) = sock
        .recv_from(&mut buf)
        .await
        .map_err(|e| format!("收公告失败：{e}"))?;
    let from = from.ip().to_string();
    if n > MAX_ANNOUNCE_BYTES {
        return Ok(RecvOutcome::Rejected { from, reason: AnnounceReject::TooLong.reason().to_string() });
    }
    let raw = match std::str::from_utf8(&buf[..n]) {
        Ok(r) => r,
        Err(_) => {
            return Ok(RecvOutcome::Rejected {
                from,
                reason: AnnounceReject::BadJson.reason().to_string(),
            })
        }
    };
    match state.record_datagram(raw, &from, now_ms) {
        Ok(Some(p)) => Ok(RecvOutcome::Peer(p)),
        Ok(None) => Ok(RecvOutcome::OwnAnnounce { from }),
        Err(reason) => Ok(RecvOutcome::Rejected { from, reason }),
    }
}

/// [`recv_into`] 的**带超时**外壳：最多等 `slice_ms`；超时 ⇒ [`RecvOutcome::Nothing`]
/// （⚠️ **与"自己的公告"分得开** ✗ —— 旧版两件都回 `None` ✓，那正是判不了的那一格 ✓）。
pub async fn recv_into_within(
    sock: &UdpSocket,
    state: &crate::lan_state::LanState,
    slice_ms: u64,
) -> Result<RecvOutcome, String> {
    match tokio::time::timeout(
        std::time::Duration::from_millis(slice_ms),
        recv_into(sock, state, crate::db::now_ms()),
    )
    .await
    {
        Err(_) => Ok(RecvOutcome::Nothing),
        Ok(r) => r,
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

    /// 判据 ⑤：公告里声称的**公网**地址**永远不许**变成设备直连
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
        // ⚠️ **D14（owner 2026-09-30：放行 CGNAT）**：`100.64.0.0/10`（Tailscale 默认段）也算。
        assert!(is_lan_base("http://100.100.1.2:8787"));
        assert!(!is_lan_base("http://172.32.0.1:8787")); // 出了 172.16/12
        assert!(!is_lan_base("http://100.63.255.255:8787")); // 出了 100.64/10（下界外一格）
        assert!(!is_lan_base("http://100.128.0.1:8787")); // 出了 100.64/10（上界外一格）
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
        let st = crate::lan_state::LanState::new("dev-b".to_string());

        let ann = announce_of("dev-a", Some("http://192.168.1.5:8787"), &["sp-1"]);
        assert_eq!(announce_once(&a, &[b_addr], &ann).await.unwrap().sent(), 1);

        let got = match recv_into(&b, &st, 1_000).await.unwrap() {
            RecvOutcome::Peer(p) => p,
            other => panic!("应当收到对端，实际 {other:?}"),
        };
        assert_eq!(got.announce.device_id, "dev-a");
        assert_eq!(got.addr, "127.0.0.1", "来源地址要如实记下（诊断用）");
        assert_eq!(got.seen_at_ms, 1_000);

        // ★ 打通：收进来的公告**真的**能让这一轮的地址解析走局域网。
        // ⚠️ 这里连**开关**一起验（`peers` 尊重它）：未启用 ⇒ 看不见 ⇒ 解析照旧走配置地址。
        assert!(st.peers(1_000).is_empty(), "还没启用 ⇒ 看不见（口径 3）");
        st.set_enabled(true);
        let route = resolve_base("sp-1", "https://shuyo.cn/sync", &st.peers(1_000)).unwrap();
        assert_eq!(route.url, "http://192.168.1.5:8787");
        assert_eq!(route.kind, LinkKind::Lan);
    }

    /// ★★ **U7 缺的那半个：同网段两台「自动」互见**（个人版任务单 **T8** 新增 ✓，判据矩阵 U7 的 E2E 那一格 ✓）。
    ///
    /// 与判据 ⑦ 的区别**只在最关键的那一点**：⑦ 把对端地址**手填**（`&[b_addr]` ✗），
    /// 而本判据**一个对端地址都不填** —— 只调 [`default_targets`]（生产路径上那一轮真正会发的目标 ✓），
    /// 验的是「**不用人手配置就能被听见**」这条承诺（U7 原文：**局域网自动发现** ✓）。
    ///
    /// ⚠️ **本机验得到什么／验不到什么（如实 ✓）**：
    ///   · 验得到：① 自动目标里有**能落回本机**的那一条（回环 —— [`default_targets`] 的注释把它写成
    ///     「能自验的关键」✓）；② 真按自动目标发 ⇒ 对端**无需任何手工配置**就收到并**进表** ✓；
    ///     ③ 收到之后**下一轮的自动目标**里多出「该对端 ＋ 本端发现端口」✓（＝ 2026-09-26 真机那次
    ///     「**单向发现**」事故的反面 ✓）；④ 两侧的表各自 `resolve_base` ⇒ **都**走局域网路由（互见 ✓）。
    ///   · **验不到**：真实 UDP 广播在**真网段**上到不到（CI／受限网络里广播未必可用 ⇒ 回环那一条是替代品 ⚠️）
    ///     与「两台真机换网后仍互见」—— 那是任务单 §5 的 **M1／M2（要人手）** ✓，⛔ 不许写成通过 ✗。
    ///
    /// **变异（必须红）**：把 `announce_targets` 里「补上已认识对端的单播」那一段删掉（只留 `default_targets`）
    /// ⇒ 第 ③ 条立刻红 —— 那正是 2026-09-26 在真机上抓到的**单向发现**（热点主机收得到、底下的客户端收不到）✓。
    #[tokio::test]
    async fn two_instances_on_one_net_find_each_other_without_a_hand_filled_address() {
        // 「中枢」真的起一个发现监听（`0.0.0.0:P` —— 生产里两台用的是**同一个发现端口** ✓）
        let hub = bind_listener(0).await.expect("中枢要能监听");
        let port = hub.local_addr().unwrap().port();
        let joiner = UdpSocket::bind("127.0.0.1:0").await.unwrap();

        let st_hub = crate::lan_state::LanState::new("dev-hub".to_string());
        let st_join = crate::lan_state::LanState::new("dev-join".to_string());
        st_hub.set_enabled(true);
        st_join.set_enabled(true);

        // ① 自动目标里必须有一条**能落回本机**的入口 —— 这就是「不用手填」的前提 ✓
        let auto = default_targets(port);
        assert!(
            auto.iter().any(|t| t.ip().is_loopback()),
            "自动目标里没有回环那一条（本机就自验不了；它的注释把回环写成「能自验的关键」✓）：{auto:?}"
        );

        // ② 加入方**只按自动目标**发 —— 全程没有出现任何对端地址 ✓
        let sent = announce_once(
            &joiner,
            &auto,
            &announce_of("dev-join", Some("http://192.168.1.6:8787"), &["sp-1"]),
        )
        .await
        .expect("按自动目标应当至少发出去一条");
        assert!(sent.sent() >= 1);
        // ⚠️ 这个判据的 socket 只绑了回环 ⇒ 发 `255.255.255.255` 必然被系统拒（实测 **os error 10013**）✓
        //    ⭐ 而**"逐条看得见失败"正是本笔要的**（旧实现这一段是静默的 ✗）⇒ 这里只钉"回环那条不许失败" ✓。
        assert!(
            sent.failures.iter().all(|(t, _)| !t.ip().is_loopback()),
            "回环那一条不该失败：{:?}",
            sent.failures
        );

        // ③ 中枢**无需任何手工配置**就收到它（回环那一条把它送过来的 ✓）⇒ 而且**进表** ✓
        let got = match recv_into_within(&hub, &st_hub, 1_000).await.unwrap() {
            RecvOutcome::Peer(p) => p,
            other => panic!("中枢应当收到加入方，实际 {other:?}"),
        };
        assert_eq!(got.announce.device_id, "dev-join");
        assert_eq!(st_hub.peers(1_000).len(), 1, "收进来必须进表 ✓");

        // ④ 把「同一网段上的另一台」喂进中枢的表（`192.168.1.6` 是**同网段**地址 ✓），
        //    然后看**下一轮的自动目标**：必须多出「该对端 ＋ 本端发现端口」那一条 ✓
        //    ⚠️ 这一条判的是**决策**（真把它送出去要真网段 ⇒ 属 M1／M2 ✓）
        st_hub
            .record_datagram(
                &encode_announce(&announce_of("dev-peer", Some("http://192.168.1.6:8787"), &["sp-1"])).unwrap(),
                "192.168.1.6",
                1_000,
            )
            .expect("同网段那台的公告应当合法");
        let peers = st_hub.peers(1_000);
        assert_eq!(peers.len(), 2, "表里应当有两台：{peers:?}");
        let next = announce_targets(port, &peers);
        let want: SocketAddr = format!("192.168.1.6:{port}").parse().unwrap();
        assert!(
            next.contains(&want),
            "下一轮的自动目标里没有对端 {want} ⇒ 「单向发现」会复现（2026-09-26 真机事故 ✓）：{next:?}"
        );

        // ⑤ 两侧的表各自解析 ⇒ **都**走局域网路由（＝互见 ✓）
        let hub_route =
            resolve_base("sp-1", "https://shuyo.cn/sync", &peers).expect("中枢这一侧应当有局域网路由");
        assert_eq!(hub_route.kind, LinkKind::Lan);
        st_join
            .record_datagram(
                &encode_announce(&announce_of("dev-hub", Some("http://192.168.1.5:8787"), &["sp-1"])).unwrap(),
                "192.168.1.5",
                1_000,
            )
            .expect("中枢的公告应当合法");
        let join_route = resolve_base("sp-1", "https://shuyo.cn/sync", &st_join.peers(1_000))
            .expect("加入方这一侧也应当有局域网路由");
        assert_eq!(join_route.url, "http://192.168.1.5:8787");
        assert_eq!(join_route.kind, LinkKind::Lan);
    }

    /// 判据 ⑧：坏报文**永远不许**进对端表，而且**原因说得出来**。
    #[tokio::test]
    async fn a_garbled_datagram_never_enters_the_peer_table() {
        let a = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let b = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let st = crate::lan_state::LanState::new("dev-b".to_string());
        st.set_enabled(true); // 开着也照样不许进（坏报文那一关在解码，不在开关）

        // 不是 JSON
        a.send_to(b"hello", b.local_addr().unwrap()).await.unwrap();
        // ⭐ 2026-10-09（task-8）：坏报文不再是一个"没有来源的错误" ✗ —— ⭐ 现在**带回来源 ＋ 原因** ✓
        //    （日志那一行要靠它说清"谁在发坏包" ✓）。
        match recv_into(&b, &st, 1_000).await.unwrap() {
            RecvOutcome::Rejected { from, reason } => {
                assert_eq!(reason, AnnounceReject::BadJson.reason());
                assert_eq!(from, "127.0.0.1", "来源要如实带回来（日志靠它点名 ✓）");
            }
            other => panic!("坏报文必须是 Rejected，实际 {other:?}"),
        }
        // 版本不认识（合法 JSON，但 v 不是我们的）
        let mut other = announce_of("dev-a", None, &[]);
        other.v = WIRE_VERSION + 1;
        a.send_to(
            encode_announce(&other).unwrap().as_bytes(),
            b.local_addr().unwrap(),
        )
        .await
        .unwrap();
        match recv_into(&b, &st, 1_000).await.unwrap() {
            RecvOutcome::Rejected { reason, .. } => {
                assert_eq!(reason, AnnounceReject::UnknownVersion.reason())
            }
            other => panic!("不认识的版本必须是 Rejected，实际 {other:?}"),
        }

        assert!(st.observed_all().is_empty(), "坏报文不许留下任何痕迹");
        assert!(st.peers(1_000).is_empty());
    }

    /// 判据 ⑨：**自己的公告**不许成为对端（回环会把我们发的原样送回来，
    /// 不挡的话每台设备都会把自己当成中枢）。
    #[tokio::test]
    async fn my_own_announce_never_becomes_a_peer() {
        let a = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let b = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let st = crate::lan_state::LanState::new("dev-a".to_string()); // ← 主人就是发公告这台
        st.set_enabled(true);
        let ann = announce_of("dev-a", Some("http://192.168.1.5:8787"), &["sp-1"]);
        announce_once(&a, &[b.local_addr().unwrap()], &ann).await.unwrap();

        // ⭐ 2026-10-09（task-8）：⭐ 自己的公告**必须与"这一片什么都没收到"分得开** ✗
        //    （旧版两件都回 `None` ⇒ 日志里同形 ⇒ "收到了但没进表"根本判不出来 ✓）。
        assert!(
            matches!(recv_into(&b, &st, 1_000).await.unwrap(), RecvOutcome::OwnAnnounce { .. }),
            "自己的公告要回 OwnAnnounce（⛔ 不是 Nothing ✗）"
        );
        assert!(st.observed_all().is_empty());
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // ⭐⭐ task-8（2026-10-09）：**发现层的三行日志**（"发了几条／收了几条／为什么没进表"）
    //
    // 为什么要有它们（真机，逐字）：`47821` 被应用**独占** ⇒ 外部绑不上 ✗ ⇒ ⭐ **"应用到底发没发、
    // 收没收到"除了日志没有别的观测面** ✓；而当时两边**只有**「窗口启动」一行 ✗：
    //   · 发送侧：`announce_once` 只留 `last_err`、**只在全部失败时才报** ⇒ 部分失败**静默** ✗；
    //   · 接收侧：`lan_state` 把返回值**整个丢掉**（`let _ = …`）⇒ 坏报文／自己的回环报文全都**无声** ✗；
    //   · 而 `Ok(None)` 同时表示"超时没收到"与"收到了但是我自己的" ✗ ⇒ ⭐ **两件完全不同的事同形** ✓。
    // ─────────────────────────────────────────────────────────────────────────────

    /// ⭐ **判据 a**：⭐ **部分失败**必须**点名到哪一条 ＋ 带上错误原文** ✓。
    ///
    /// ⚠️ 未修时那一行只说"发出 1/2" ⇒ 哪一条失败了、为什么，**一个字都没有** ✗ ⇒ **必红** ✓。
    #[test]
    fn a_partially_failed_announce_names_every_target_that_failed() {
        let bad: SocketAddr = "255.255.255.255:47821".parse().unwrap();
        let ok: SocketAddr = "192.168.43.190:47821".parse().unwrap();
        let o = AnnounceOutcome {
            targets: vec![bad, ok],
            failures: vec![(bad, "Permission denied (os error 13)".to_string())],
        };
        let line = announce_send_line(&o, "123456789Ok,./");

        assert!(line.contains("发出 1/2"), "成功/共几条要在：{line}");
        assert!(
            line.contains("255.255.255.255:47821"),
            "⛔ 部分失败必须**点名到哪一条** ✗（旧实现只留最后一条错误 ＋ 只在全部失败时才报 ✓）：{line}"
        );
        assert!(line.contains("Permission denied"), "而且要带上**错误原文** ✓：{line}");
        assert!(line.contains("1234"), "空间要给（打码/前几位即可 ✓）：{line}");
        assert!(
            !line.contains("123456789Ok,./"),
            "⛔ 空间名不许整串打出来 ✗（这是日志，不是协议）：{line}"
        );
    }

    /// ⭐ **判据 b**：⭐ 收到一条**空间不匹配**的公告 ⇒ 那一行必须说清 **来源 ＋ 对端 ＋ 为什么不会用上** ✓。
    ///
    /// ⚠️ 未修时那一行只有"收到公告：来源 …" ⇒ **匹配与否一个字都没有** ✗ ⇒ **必红** ✓。
    #[test]
    fn a_received_announce_from_another_space_says_so_and_why() {
        let p = peer("94bfb27e-7d25-4b65-8b06-5846c561161c", Some("http://192.168.43.190:8788"), &["别的空间"]);
        let line = announce_recv_line(&p, &["123456789Ok,./".to_string()]);

        assert!(line.contains("192.168.1.9"), "来源 IP 要打（不然分不清谁在说话 ✓）：{line}");
        assert!(line.contains("94bfb27e"), "对端 device_id 前 8 位要打 ✓：{line}");
        assert!(
            line.contains("不匹配"),
            "⛔「收到了但不会进网格候选」必须说清**为什么** ✗（今天判不了的就是这一格 ✓）：{line}"
        );

        // 匹配那一支也要能说 ✓（⛔ 别写成"永远说好话"✗）
        let same = peer("dev-a", Some("http://192.168.1.5:8788"), &["123456789Ok,./"]);
        let ok = announce_recv_line(&same, &["123456789Ok,./".to_string()]);
        assert!(ok.contains("匹配") && !ok.contains("不匹配"), "同空间要说「匹配」✓：{ok}");
    }

    /// ⭐ **判据 c**：⭐ "收到了但没进表"那一行必须**说得出原因 ＋ 是谁** ✓（⛔ 不许静默 ✗）。
    #[test]
    fn a_dropped_datagram_names_its_source_and_reason() {
        let line = announce_drop_line("192.168.43.190", AnnounceReject::BadJson.reason());
        assert!(line.contains("192.168.43.190"), "来源要有：{line}");
        assert!(line.contains(AnnounceReject::BadJson.reason()), "原因原文要有：{line}");
        assert!(line.contains("没进表"), "而且要一眼看出**没有进表** ✓：{line}");
    }

    /// ⭐ **判据 d（回归闸）**：⭐ 四种收报结果**彼此分得开** ✓ ——
    /// ⛔ 尤其：⭐ **"这一片什么都没收到"（超时）绝不能与"收到了但是我自己的"同形** ✗
    /// （旧版两件都回 `None` ✓ ⇒ 那正是真机上判不出来的一格 ✓）。
    #[tokio::test]
    async fn the_receiver_keeps_timeout_own_and_rejected_apart() {
        let a = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let b = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let st = crate::lan_state::LanState::new("dev-b".to_string());
        st.set_enabled(true);

        // ① 空 socket ＋ 短超时 ⇒ **Nothing**（不是错误、也不打日志 ✓）
        assert_eq!(
            recv_into_within(&b, &st, 50).await.unwrap(),
            RecvOutcome::Nothing,
            "超时必须是 Nothing ✓"
        );

        // ② 自己的公告 ⇒ **OwnAnnounce**（⛔ 不是 Nothing ✗）
        let mine = announce_of("dev-b", Some("http://192.168.1.9:8788"), &["sp-1"]);
        a.send_to(encode_announce(&mine).unwrap().as_bytes(), b.local_addr().unwrap())
            .await
            .unwrap();
        assert!(
            matches!(recv_into(&b, &st, 1_000).await.unwrap(), RecvOutcome::OwnAnnounce { .. }),
            "自己的公告必须是 OwnAnnounce ✓"
        );

        // ③ 坏报文 ⇒ **Rejected{from, reason}**（带来源 ✓）
        a.send_to(b"{ not json", b.local_addr().unwrap()).await.unwrap();
        match recv_into(&b, &st, 1_000).await.unwrap() {
            RecvOutcome::Rejected { from, reason } => {
                assert_eq!(from, "127.0.0.1");
                assert_eq!(reason, AnnounceReject::BadJson.reason());
            }
            other => panic!("坏报文必须 Rejected，实际 {other:?}"),
        }
        assert!(st.observed_all().is_empty(), "以上三种都不许进表 ✓");
    }

    /// 判据 ⑩：不再发声的对端会过期；表不是只增不减的（同一台再发声则是**刷新**）。
    #[test]
    fn a_peer_that_stopped_announcing_expires() {
        let st = crate::lan_state::LanState::new("dev-me".to_string());
        st.set_enabled(true);
        assert!(st.observe(peer("dev-a", Some("http://192.168.1.5:8787"), &["sp-1"])));
        // `peer()` 造的 seen_at_ms = 0
        assert_eq!(st.peers(PEER_TTL_MS).len(), 1, "还没到 TTL 就算还在");
        assert!(st.peers(PEER_TTL_MS + 1).is_empty(), "过了 TTL 就不该再算数");
        assert_eq!(st.sweep(PEER_TTL_MS + 1), 1, "sweep 要把过期的腾掉");
        assert!(st.observed_all().is_empty(), "腾完表里就该是空的");

        // 同一台再发声 ⇒ 刷新时刻，不新增行
        let mut again = peer("dev-a", Some("http://192.168.1.5:8787"), &["sp-1"]);
        again.seen_at_ms = 5_000;
        assert!(st.observe(again));
        assert_eq!(st.peers(5_000).len(), 1);
        assert_eq!(st.peers(5_000)[0].seen_at_ms, 5_000);
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

    /// ★★ 2026-09-26（**真机抓到的单向发现**）：公告目标里必须**带上已知对端的单播地址**。
    ///
    /// 现场：Mate 40（热点主机）看得见 MIX 2，MIX 2 **看不见** Mate 40。机制是
    /// `255.255.255.255` 按**默认路由**挑出口，而热点主机的默认路由是**蜂窝**
    /// （`network_type` 实测就是 `cellular`）⇒ 那条广播到不了热点底下的客户端。
    /// 单播那一条把方向补回来 ⇒ **判据必须钉住"表里有对端时，目标里就有它的地址"**。
    /// 变异实测：把 `announce_targets` 退回只回 `default_targets` ⇒ 当场红。
    #[test]
    fn announce_targets_add_a_unicast_hop_to_every_peer_we_have_heard() {
        // 空表 ⇒ 就是默认那两条（老行为不变）
        let none = announce_targets(LAN_PORT, &[]);
        assert_eq!(none, default_targets(LAN_PORT));
        assert!(
            !none.iter().any(|a| a.ip().to_string().starts_with("192.168.")),
            "没听过谁的时候不许凭空造地址：{none:?}"
        );

        // 听过一台 ⇒ 目标里出现**它的单播地址**（这就是"热点主机也能被听见"的那条路）
        let mut p = peer("dev-client", Some("http://192.168.43.96:47832"), &["sp-1"]);
        p.addr = "192.168.43.96".to_string();
        let one = announce_targets(LAN_PORT, &[p.clone()]);
        assert!(
            one.iter().any(|a| a.to_string() == format!("192.168.43.96:{LAN_PORT}")),
            "已知对端的地址必须在目标里（否则单向发现照旧）：{one:?}"
        );
        assert!(one.iter().any(|a| a.ip().to_string() == "255.255.255.255"), "广播那条不许丢");
        // 同一台重复 / 回环重复 ⇒ 去重（别自己给自己刷同一条）
        let mut same = p.clone();
        same.announce.device_id = "dev-other".to_string();
        let mut loopback = p.clone();
        loopback.addr = "127.0.0.1".to_string();
        let multi = announce_targets(LAN_PORT, &[p, same, loopback]);
        let mut sorted = multi.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(multi.len(), sorted.len(), "目标里有重复 ⇒ 会往同一个地址刷两遍：{multi:?}");
        assert_eq!(multi.iter().filter(|a| a.ip().is_loopback()).count(), 1, "回环只留一条");

        // 报文来源是外部输入 ⇒ 解析不出来的地址**跳过**（不 panic、也不发出坏目标）
        let mut bad = peer("dev-bad", None, &[]);
        bad.addr = "不是地址".to_string();
        let mut with_port = peer("dev-with-port", None, &[]);
        with_port.addr = "192.168.43.7:9999".to_string();
        let safe = announce_targets(LAN_PORT, &[bad, with_port]);
        assert_eq!(safe, default_targets(LAN_PORT), "坏地址要被跳过：{safe:?}");
    }

    // ---- 代言（产出侧）＋ 状态行 ----

    /// ★ 判据 ⑫：**我们自己发出去的代言公告，必须是我们自己会采纳的那种**。
    ///
    /// 这是**往返性质**：`announce_for_own_hub` 与 `resolve_base` 必须用**同一把尺**
    /// （[`is_lan_base`]）。若产出侧改用一把更松的尺（例如"只要是非空 http"），公告发得出去、
    /// 却永远被消费侧跳过 ⇒ 现象是「代言开着，网段里却没人被找到」，**没有编译期信号、单测也照绿**。
    /// 退化了这条就红。
    #[test]
    fn an_announce_we_produce_is_always_one_we_would_accept() {
        let cases = [
            ("http://192.168.1.5:8787", true),  // 该代言
            ("http://10.0.0.7", true),          // 该代言（不带端口也认）
            ("http://169.254.1.1:8787", true),  // 该代言（链路本地）
            // ⚠️ **D14（owner 2026-09-30：放行 CGNAT）**：Tailscale 默认段也要能代言 ——
            //    **两把尺一起放宽**才保得住本判据（只改 `mesh::is_lan_only` ⇒ 这里立刻红）。
            ("http://100.100.1.2:8787", true),  // 该代言（CGNAT 共享段）
            ("https://shuyo.cn/sync", false),   // 公网 ⇒ 不许代言
            ("http://127.0.0.1:8787", false),   // 回环不是"网段里的别人" ⇒ 不许代言
            ("http://172.32.0.1:8787", false),  // 出了 172.16/12 ⇒ 不许代言
            ("http://100.128.0.1:8787", false), // 出了 100.64/10 ⇒ 不许代言（D14 不许写宽）
            ("", false),                        // 没配置 ⇒ 不许代言
        ];
        for (url, should_produce) in cases {
            let mine = announce_for_own_hub("dev-me", "本机", url, "sp-1");
            assert_eq!(
                mine.is_some(),
                should_produce,
                "该/不该代言判错了：{url:?}"
            );
            let Some(announce) = mine else { continue };
            // 产出侧的东西，交给消费侧 —— 必须被采纳成局域网路由。
            let peer = Peer { announce, addr: "192.168.1.5".into(), seen_at_ms: 0 };
            let got = resolve_base("sp-1", "https://shuyo.cn/sync", &[peer])
                .expect("有对端就该有路由");
            assert_eq!(got.kind, LinkKind::Lan, "自己发出去的公告被自己跳过了：{url:?}");
            assert_eq!(got.url, url.trim_end_matches('/'), "采纳的基址必须就是公告里那个");
        }

        // 没有设备身份 / 没有空间身份 ⇒ 代言不成立（空身份只会产出没人能用的公告）。
        assert!(announce_for_own_hub("", "本机", "http://192.168.1.5:8787", "sp-1").is_none());
        assert!(announce_for_own_hub("dev-me", "本机", "http://192.168.1.5:8787", "  ").is_none());
    }

    /// ★ 判据 ⑰（B 片施工单 §8.3 的收口）：**`fp` 真的填了，且填的是 `device_id`**。
    ///
    /// 这条口径是 owner 2026-09-25 拍的：`fp` ＝ **应用级事实 `device_id`**（设备标识），
    /// **不是**"设备密钥材料的指纹"。三个理由：① 它已经在服务端与公告里流通，不是新暴露面；
    /// ② 稳定（轮换钥匙不会让用户看到"设备名变了"）；③ 它要挡的是**掉包**。
    ///
    /// 为什么值得钉：字段一直在协议里、只是一直是空串 ⇒ **谁都没发现它没接线**。
    /// 而真需要"密钥材料指纹"时，那是**另一条判据、另立字段** —— 这条同时挡住
    /// "有人顺手把 `fp` 的语义换成密钥指纹"（那会让老接收方读到一串它解释不了的东西）。
    #[test]
    fn the_fingerprint_is_the_device_id_and_is_actually_filled() {
        let a = announce_for_own_hub("dev-me", "本机", "http://192.168.1.5:8787", "sp-1")
            .expect("该代言");
        assert_eq!(a.fp, "dev-me", "fp 必须就是 device_id（不是密钥材料指纹）");
        assert_eq!(a.fp, a.device_id, "两者是同一个应用级事实，不许各填一份");
        // 前后空白照 trim（与 device_id 同一把尺，免得出现"身份一样但 fp 字符串不同"）
        let b = announce_for_own_hub("  dev-me  ", "本机", "http://192.168.1.5:8787", "sp-1")
            .expect("该代言");
        assert_eq!(b.fp, "dev-me");
        assert_eq!(b.fp, b.device_id, "trim 之后两者也必须一致");
        // 空身份 ⇒ 根本产出不了公告（这条与判据 ⑫ 同一支），所以不存在"fp 是空串"的合法产出
        assert!(announce_for_own_hub("   ", "本机", "http://192.168.1.5:8787", "sp-1").is_none());
    }

    /// ★ 判据 ⑬：状态行要能把**三件处置不同的事**分开 —— 走了局域网 / 网段里什么都没有 /
    /// 网段里有人但**都不服务这个空间**。后者是配置或身份不匹配（有得救），前者是没辙；
    /// 「没走成直连」必须是**可断言的结果**，不能是静默降级（施工单 §2 ④）。
    #[test]
    fn the_status_line_tells_the_three_situations_apart() {
        // ① 走了局域网：点出中枢是谁
        let hub = peer("dev-hub", Some("http://192.168.1.5:8787"), &["sp-1"]);
        let route = resolve_base("sp-1", "https://shuyo.cn/sync", std::slice::from_ref(&hub)).unwrap();
        let line = status_line(Some(&route), std::slice::from_ref(&hub), "sp-1", 1);
        assert!(line.contains("同一网络"), "{line}");
        assert!(line.contains("dev-hub 的机器"), "要点出中枢是谁：{line}");

        // ② 网段里什么都没有 ⇒ 只是"公网"，**不许**说"有人但不服务本空间"
        let route = resolve_base("sp-1", "https://shuyo.cn/sync", &[]).unwrap();
        let line = status_line(Some(&route), &[], "sp-1", 0);
        assert!(line.contains("公网"), "{line}");
        assert!(line.contains("0 台"), "{line}");
        assert!(!line.contains("没有服务这个空间的中枢"), "一个对端都没有时不许说这句：{line}");

        // ③ 有对端、但都不服务本空间 ⇒ **必须说出来**（与 ② 分开）
        let other = peer("dev-other", Some("http://192.168.1.6:8787"), &["sp-9"]);
        let route = resolve_base("sp-1", "https://shuyo.cn/sync", std::slice::from_ref(&other)).unwrap();
        let line = status_line(Some(&route), std::slice::from_ref(&other), "sp-1", 1);
        assert!(
            line.contains("没有服务这个空间的中枢"),
            "「有人但都不是本空间的」必须与「没人」分得开：{line}"
        );

        // ④ 尚未绑定
        assert!(status_line(None, &[], "sp-1", 0).contains("尚未绑定"));
    }

    /// ★ 判据 ⑯：**"来过又走了"要如实说出来** —— 活着的是 `seen`，表里一共有过的是 `observed`。
    /// 两者不等时不许让"N 台"这个数悄悄变来变去（用户看到 3 台变 0 台会以为坏了，
    /// 而那句"还见过 N 台，现在不发声了"才说得清那是**别人走了**）。
    #[test]
    fn the_line_tells_apart_seen_now_from_seen_before() {
        let other = peer("dev-other", Some("http://192.168.1.6:8787"), &["sp-9"]);
        let route = resolve_base("sp-1", "https://shuyo.cn/sync", &[]).unwrap();
        // 还活着：不许多出那句
        let line = status_line(Some(&route), std::slice::from_ref(&other), "sp-1", 1);
        assert!(line.contains("发现 1 台"), "{line}");
        assert!(!line.contains("还见过"), "活着的不许算进'来过又走了'：{line}");
        // 已经走了（表里还在、但不发声了）：如实说
        let line = status_line(Some(&route), &[], "sp-1", 1);
        assert!(line.contains("发现 0 台"), "{line}");
        assert!(line.contains("还见过 1 台"), "{line}");
    }

    /// ★ 判据 ⑭（同源）：**档位只能由 [`Route`] 决定**，状态行不许自己再判一次。
    ///
    /// 反例非常常见：用户把配置地址直接填成 `http://192.168.1.5:8787`（本来就是私有网段），
    /// 而网段里一个对端都没有 ⇒ `resolve_base` 给的是 `Configured`。
    /// 此时若状态行按"地址是不是私有网段"自己判，它会说「局域网」—— **与真实走的路由矛盾**，
    /// 正是简报 §7 要堵的"口径不成立"。
    #[test]
    fn the_line_never_claims_lan_the_route_did_not_take() {
        let route = resolve_base("sp-1", "http://192.168.1.5:8787", &[]).unwrap();
        assert_eq!(route.kind, LinkKind::Configured, "没发现到中枢就不是直连档");
        let line = status_line(Some(&route), &[], "sp-1", 0);
        assert!(
            !line.contains("同一网络"),
            "档位只能来自 Route；状态行自己按地址形状再判一次就会说出与路由矛盾的档：{line}"
        );
    }

    /// ★ 判据 ⑱（接线那一片的**端到端**）：**两台"设备"在真 socket 上互相发现，并一路走到地址解析**。
    ///
    /// 与判据 ⑦（`two_instances_find_each_other_over_a_real_datagram`）的差别：那条只验**一次**
    /// 收发；这条把**生产那几件**串起来跑 —— `lan_state::announces_for`（产出侧，含
    /// `bound_profile_count` / `announce_due` 那套口径）→ `announce_once`（真发）→
    /// `recv_into_within`（真收，带超时）→ `LanState` 开关 → `resolve_base`（真路由）。
    ///
    /// ⚠️ 为什么值得单立一条：单测里每一件都绿，**接起来**却可能什么都不发生
    /// （`fp` 空串那次就是"协议里那一格是空的而全线绿"的现实样本）。
    /// ⚠️ 边界要说清：这里走的是**显式单播 ＋ 回环**（`127.0.0.1`），**不证明"广播在真网段里能到"**
    /// —— 那要两台真机（见本文件 §判据 ⑦ 与施工单 §9 末尾那条如实记录）。
    #[tokio::test]
    async fn two_devices_discover_each_other_through_the_production_path() {
        use crate::lan_state::{announce_due, announces_for, bound_profile_count, ANNOUNCE_INTERVAL_MS};

        let a = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let b = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let a_addr = a.local_addr().unwrap();
        let b_addr = b.local_addr().unwrap();

        // 两台设备各自的档案：地址是**私有网段** ⇒ 有资格代言（`announce_for_own_hub` 的尺）。
        let profiles = vec![("sp-1".to_string(), "http://192.168.1.5:8787".to_string(), "ws".to_string())];
        assert!(bound_profile_count(&profiles) > 0, "有绑定才该发声");

        let st_a = crate::lan_state::LanState::new("dev-a".to_string());
        let st_b = crate::lan_state::LanState::new("dev-b".to_string());
        st_a.set_enabled(true);
        st_b.set_enabled(true);

        // ① 产出侧：两台各产一条（第一轮就该发 —— `announce_due(0, …)` 为真）。
        let out_a = announces_for("dev-a", "A 的机器", &profiles);
        let out_b = announces_for("dev-b", "B 的机器", &profiles);
        assert_eq!(out_a.len(), 1);
        assert_eq!(out_b.len(), 1);
        assert!(announce_due(0, 1_000, ANNOUNCE_INTERVAL_MS), "第一轮必须发声");
        // ★ 产出侧带指纹（B 片 §8.3 的收口）：这条把"协议里那一格不是空的"也串进端到端。
        assert_eq!(out_a[0].fp, "dev-a");
        assert_eq!(out_b[0].fp, "dev-b");

        // ② 真发（显式单播到对端，避免依赖广播）+ ③ 真收。
        assert_eq!(announce_once(&a, &[b_addr], &out_a[0]).await.unwrap().sent(), 1);
        assert_eq!(announce_once(&b, &[a_addr], &out_b[0]).await.unwrap().sent(), 1);
        let got_b = match recv_into_within(&b, &st_b, 2_000).await.unwrap() {
            RecvOutcome::Peer(p) => p,
            other => panic!("B 应当收到 A，实际 {other:?}"),
        };
        assert_eq!(got_b.announce.device_id, "dev-a");
        assert_eq!(got_b.addr, "127.0.0.1");
        let got_a = match recv_into_within(&a, &st_a, 2_000).await.unwrap() {
            RecvOutcome::Peer(p) => p,
            other => panic!("A 应当收到 B，实际 {other:?}"),
        };
        assert_eq!(got_a.announce.device_id, "dev-b");

        // ④ 后置条件：生产代码判"还在不在"用的是**真实时钟**（`crate::db::now_ms()`）——
        //    这里不去推时钟，就按真的来（判据不该靠人造时间；TTL 那两支另有判据 ⑩）。
        let now = crate::db::now_ms();
        assert_eq!(st_a.peers(now).len(), 1, "A 的表里应当有 B（且开关是开的）");
        assert_eq!(st_b.peers(now).len(), 1);

        // ⑤ 一路走到路由：这次同步**真的**会走局域网那一档。
        let route = resolve_base("sp-1", "https://shuyo.cn/sync", &st_a.peers(now)).unwrap();
        assert_eq!(route.url, "http://192.168.1.5:8787");
        assert_eq!(route.kind, LinkKind::Lan);
        // 状态行也要如实说出"直连"与中枢名字（施工单 §2 ④）。
        let line = status_line(Some(&route), &st_a.peers(now), "sp-1", 1);
        assert!(line.contains("直连（同一网络）"), "{line}");
        assert!(line.contains("B 的机器"), "要点出中枢是谁：{line}");
    }

    /// ★ 判据 ⑮（接线那一片的收口）：**"关掉＝看不见"必须一路穿透到地址解析** ——
    /// 用**真的** `LanState`（不是假的对端列表）走一遍：没启用 ⇒ `peers()` 空 ⇒
    /// 解析结果与"网段里一个人都没有"**逐字节相同**。
    ///
    /// 这条钉的是接线那一片最容易出错的那种：`sync::effective_base` 若忘了尊重开关
    /// （比如直接读 `PeerTable` 而不是 `LanState::peers`），那么**用户没绑同步、我们从没广播过**，
    /// 却仍可能把上一次会话残留的一行当成路由 —— 而这种错**编译期没有信号、单测也照绿**。
    ///
    /// ⚠️ 用 `LanState::new`（**不碰进程级单例**）：`cargo test` 是同进程多线程，动单例会污染别的测试。
    #[test]
    fn a_disabled_state_resolves_exactly_as_if_nobody_were_on_the_network() {
        let st = crate::lan_state::LanState::new("dev-me".into());
        st.observe(peer("dev-hub", Some("http://192.168.1.5:8787"), &["sp-1"]));
        let want = resolve_base("sp-1", "https://shuyo.cn/sync", &[]).unwrap();
        // 关着：表里明明有那一台，解析也必须与"空网段"一模一样（口径 3 的实测）
        assert_eq!(resolve_base("sp-1", "https://shuyo.cn/sync", &st.peers(1_000)).unwrap(), want);
        assert!(!st.is_enabled());
        // 开着：同一张表立刻能当路由（开关是唯一的分叉）
        st.set_enabled(true);
        let got = resolve_base("sp-1", "https://shuyo.cn/sync", &st.peers(1_000)).unwrap();
        assert_eq!(got.url, "http://192.168.1.5:8787");
        assert_eq!(got.kind, LinkKind::Lan);
    }
}
