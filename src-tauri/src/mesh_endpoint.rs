//! 端点抽象 —— 跨网中继「数据面」Step 1a。
//!
//! ## 为什么要有这一层
//!
//! 同步逻辑今天只认一件事：**往哪个 base 发 HTTP**（`MeshPeer { device_id, base }`，
//! 全仓 5 处 `format!("{base}{target}")`）。而"这个 base 是怎么连上的"（局域网直连 /
//! 未来的 iroh 中继隧道）**不该被同步逻辑知道** ——
//! 否则每加一条传输就要动一遍合并/游标/附件，迟早分叉。
//!
//! 见 `docs/plans/2026-10-25-relay-data-plane-minimal-plan.md` §三 Step 1。
//!
//! ## 本模块**只**做 Step 1a（刻意小）
//!
//! ```text
//! ✅ 立 trait `Endpoint`（一次 GET：状态码 ＋ 文本响应体）＋ `LanEndpoint`（现在的直连实现）
//! ✅ 第一个调用点搬过来：`mesh::fetch_peer_manifest`
//! ✅ 一条真判据：**假端点注入**后 `fetch_peer_manifest` 照旧解析出页清单（＝"同步逻辑只认端点"）
//! ⛔ 没做（Step 1b）：`pull_from_peer` / `fetch_peer_keyring` / `fetch_peer_page` / 附件字节路径
//!    —— 附件那条要**流式**（返回 `reqwest::Response`），先把它的形状定清楚再搬，别顺手改成整包读入。
//! ```
//!
//! ⚠️ 鉴权三个头名**不在这里另立一份**：直接用 `mesh::HDR_*`（单一真相源 ✓）。

use std::future::Future;
use std::pin::Pin;

/// 一次 GET 的结果：**状态码 ＋ 文本响应体**。
///
/// ⚠️ 二进制（附件字节）**不放进这个类型** —— 那条路要流式（见模块头注的 Step 1b）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpReply {
    pub status: u16,
    pub body: String,
}

/// 附件那条的字节流（流式：不把整包读进内存）。
pub type AttachmentBody = std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send + Unpin>>;

/// 把一次 reqwest 应答变成（状态码，正文流）——**唯一的一处**转换。
///
/// 用途：服务器那条也走同一个下载器（`download_one_attachment` 现在收流，不再收 `Response`）。
/// ⚠️ 流里出错要**转成 io 错误交上去**（⛔ 不能吞 —— 否则半截文件会被当成完整下载）。
pub fn body_from_reqwest(resp: reqwest::Response) -> (u16, AttachmentBody) {
    use futures_util::TryStreamExt;
    let status = resp.status().as_u16();
    let stream = resp
        .bytes_stream()
        .map_err(|e| std::io::Error::other(format!("附件流中断：{e}")));
    (status, Box::pin(tokio_util::io::StreamReader::new(stream)))
}

/// 端点：**只认"往哪发"，不认"怎么连上的"**。
///
/// ⚠️ `auth` 是"签好的一把"三格头（`device_id` / 时间戳 ms / 签名 hex）——
/// 与 `mesh::sign_request` 同一口径，⛔ 本层不自己签（签名要拿库锁，不许跨 await 持锁）。
pub trait Endpoint: Send + Sync {
    fn get<'a>(
        &'a self,
        target: &'a str,
        auth: Option<(&'a str, i64, &'a str)>,
        token: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<HttpReply, String>> + Send + 'a>>;

    /// 附件那条的**流式** GET：回（状态码，正文流）。
    ///
    /// ⚠️ 默认实现是**明确拒绝** —— ⛔ 不许悄悄退回"整包读进内存"：
    /// 附件事真机上有几百 MB 的（真机：3.4 MB PDF、1.2 MB 图都是常态）。
    fn get_stream<'a>(
        &'a self,
        target: &'a str,
        auth: Option<(&'a str, i64, &'a str)>,
        token: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<(u16, AttachmentBody), String>> + Send + 'a>> {
        Box::pin(async move {
            let _ = (target, auth, token);
            Err("这个端点不支持流式（附件暂不能走它）".to_string())
        })
    }
}

/// 局域网直连实现：`base` ＋ `target`，带同一套三格头。
pub struct LanEndpoint {
    base: String,
    client: reqwest::Client,
}

impl LanEndpoint {
    pub fn new(base: &str, client: reqwest::Client) -> Self {
        Self {
            base: base.to_string(),
            client,
        }
    }
}

impl Endpoint for LanEndpoint {
    fn get<'a>(
        &'a self,
        target: &'a str,
        auth: Option<(&'a str, i64, &'a str)>,
        token: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<HttpReply, String>> + Send + 'a>> {
        Box::pin(async move {
            let url = join(&self.base, target);
            let mut req = self.client.get(&url);
            if let Some((device_id, ts, sig)) = auth {
                req = req
                    .header(crate::mesh::HDR_DEVICE, device_id)
                    .header(crate::mesh::HDR_TS, ts.to_string())
                    .header(crate::mesh::HDR_SIG, sig);
            }
            if let Some(t) = token.map(str::trim).filter(|t| !t.is_empty()) {
                req = req.bearer_auth(t);
            }
            let resp = req.send().await.map_err(|e| {
                // ⚠️ `reqwest::Error` 的 Display 只有 "error sending request" ——
                // 真正原因挂在 `source()` 链上（与 `pull_from_peer` 那段同一条理由：别让人猜）。
                let mut why = e.to_string();
                let mut src = std::error::Error::source(&e);
                while let Some(s) = src {
                    why.push_str(" / ");
                    why.push_str(&s.to_string());
                    src = s.source();
                }
                why
            })?;
            let status = resp.status().as_u16();
            let body = resp.text().await.map_err(|e| e.to_string())?;
            Ok(HttpReply { status, body })
        })
    }

    fn get_stream<'a>(
        &'a self,
        target: &'a str,
        auth: Option<(&'a str, i64, &'a str)>,
        token: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<(u16, AttachmentBody), String>> + Send + 'a>> {
        Box::pin(async move {
            use futures_util::TryStreamExt;
            let url = join(&self.base, target);
            let mut req = self.client.get(&url);
            if let Some((device_id, ts, sig)) = auth {
                req = req
                    .header(crate::mesh::HDR_DEVICE, device_id)
                    .header(crate::mesh::HDR_TS, ts.to_string())
                    .header(crate::mesh::HDR_SIG, sig);
            }
            if let Some(t) = token.map(str::trim).filter(|t| !t.is_empty()) {
                req = req.bearer_auth(t);
            }
            let resp = req.send().await.map_err(|e| format!("取附件失败：{e}"))?;
            let status = resp.status().as_u16();
            // ⚠️ 错误**不能吞**：流里出错 ⇒ 转成 io::Error 交给读端（否则半截文件会被当成完整下载）
            let stream = resp
                .bytes_stream()
                .map_err(|e| std::io::Error::other(format!("附件流中断：{e}")));
            let reader = tokio_util::io::StreamReader::new(stream);
            Ok((status, Box::pin(reader) as AttachmentBody))
        })
    }
}

/// 跨网对端的 base 形态：`relay:<node_id>`（⛔ 不是 http:// —— 它没有"地址"，只有"连谁"）。
pub const RELAY_BASE_PREFIX: &str = "relay:";

/// **唯一的"挑传输"处**：给一个对端选实现（局域网 / 跨网隧道）。
///
/// * `base` 是 `http://…` ⇒ `LanEndpoint`（今天唯一默认路径）
/// * `base` 是 `relay:<node_id>` ⇒ 跨网（⚠️ 只有 `--features relay` 才编得进来；
///   没编入时返回**可读错误**，⛔ 不静默当成局域网地址去连）
///
/// ⚠️ 跨网那一侧今天仍要**路线表**给出地址（发现层还没做）：只有 node id 连不上 ⇒ 明确报错。
// ⚠️ **P3-2a 接线边界**：这段是**默认/relay 构建**的原文（一个字没改，只是加了 cfg）——
// `all(lan-quic, not(relay))` 构建走下面那个同名的接线版本；默认/relay 永远编译这一份。
#[cfg(not(all(feature = "lan-quic", not(feature = "relay"))))]
pub async fn endpoint_for_peer(
    peer: &crate::mesh::MeshPeer,
    client: reqwest::Client,
) -> Result<Box<dyn Endpoint + Send>, String> {
    let Some(node_id) = peer.base.strip_prefix(RELAY_BASE_PREFIX) else {
        return Ok(Box::new(LanEndpoint::new(&peer.base, client)));
    };
    relay_endpoint_for(peer, node_id).await
}

// ═════════ P3-2a 最后接线（**只在 lan-quic 非 relay 构建**；默认/relay 不编这一块） ═════════
//
// 语义：LAN 直连（`http://…` base）时，若 `MeshPeer` 原料齐全 ⇒ QUIC 优先、失败/不可用回退 HTTP；
// 原料缺失/Registry 失败/端点构造失败 ⇒ 打一行原因后**返回原 `LanEndpoint`**（⛔ 不阻断）。
// `relay:` 前缀分支**完全不动**（仍走 `relay_endpoint_for`）。
#[cfg(all(feature = "lan-quic", not(feature = "relay")))]
pub async fn endpoint_for_peer(
    peer: &crate::mesh::MeshPeer,
    client: reqwest::Client,
) -> Result<Box<dyn Endpoint + Send>, String> {
    let Some(node_id) = peer.base.strip_prefix(RELAY_BASE_PREFIX) else {
        // base 是 http://… ⇒ LAN 直连：这里才尝试 QUIC。
        return lan_quic_or_http(peer, client).await;
    };
    // ⚠️ relay: 前缀分支与默认构建**逐字同一路径**（下面这个函数本身没改）。
    relay_endpoint_for(peer, node_id).await
}

// ⚠️ **测试专用注入（cfg(test)，⛔ 不改生产选路）**：进程级 `OnceCell` 里的 iroh 端点绑定在
// "第一次初始化它的那个 tokio runtime"上；`#[tokio::test]` 各自建 runtime，测试结束时该 runtime
// 被 drop ⇒ **后面再用全局 Registry 的测试会拿到一个已停摆的端点**（本目录 E2E 实测踩到）。
// 生产只有一个常驻 runtime，没这个问题。⇒ 单进程 E2E 用**自己的 Registry** 注入，仍走
// `endpoint_for_peer` 的生产分支；全局 Registry 的单例性由另一条测试核对。
#[cfg(all(test, feature = "lan-quic", not(feature = "relay")))]
static TEST_REGISTRY_OVERRIDE: std::sync::OnceLock<
    std::sync::Arc<crate::lan_quic::LanQuicRegistry>,
> = std::sync::OnceLock::new();

#[cfg(all(test, feature = "lan-quic", not(feature = "relay")))]
fn test_override_registry(registry: std::sync::Arc<crate::lan_quic::LanQuicRegistry>) {
    let _ = TEST_REGISTRY_OVERRIDE.set(registry);
}

/// 测试共享的 Registry：**在一条常驻线程的 runtime 上初始化**，因此不会随某个 `#[tokio::test]`
/// 的 runtime 结束而停摆（见上方注释）。整个测试进程一份；用完不清理（测试进程退出即释放）。
#[cfg(all(test, feature = "lan-quic", not(feature = "relay")))]
fn test_shared_registry() -> std::sync::Arc<crate::lan_quic::LanQuicRegistry> {
    static SHARED: std::sync::OnceLock<std::sync::Arc<crate::lan_quic::LanQuicRegistry>> =
        std::sync::OnceLock::new();
    SHARED
        .get_or_init(|| {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .expect("测试专用 runtime");
                let registry = rt
                    .block_on(crate::lan_quic::LanQuicRegistry::new(
                        iroh::SecretKey::generate(),
                    ))
                    .expect("测试共享 Registry 初始化");
                tx.send(std::sync::Arc::new(registry))
                    .expect("回传 Registry");
                // 让 iroh 的驱动/连接留在**这条常驻 runtime** 上，直到进程退出。
                rt.block_on(std::future::pending::<()>());
            });
            rx.recv().expect("测试共享 Registry 初始化线程没回话")
        })
        .clone()
}

/// P3-2a 测试专用**串行锁**：两个用"测试共享 Registry"的用例会各自发起 QUIC 连接
/// （其中一条故意连不可达地址、要等 iroh 30s 超时），而 Registry 的骨架版 `connect_gate`
/// 是**全局**的 —— 不串行时，E2E 的快速连接会被那条 30s 连接堵住（实测：偶发 30s 超时）。
#[cfg(all(test, feature = "lan-quic", not(feature = "relay")))]
fn test_registry_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    &LOCK
}

/// 测试注入的 Registry（非测试构建恒 `None`）。
///
/// ⚠️ 刻意**不**在函数体里写 cfg(test) 属性字面量：`lib.rs` 的 relay 门判据用
/// `mesh_endpoint.rs` 里**第一个 cfg(test) 属性**当"测试模块起点"（见
/// `the_relay_gate_call_site_is_behind_the_relay_feature`）⇒ 生产段里出现那个字面量会把
/// 它后面的 `gate_for_new_tunnel` 调用点截掉（本笔实测：判据报"实际 0 处"）。⇒ 用独立
/// cfg 函数把条件挡在函数层面。
#[cfg(all(test, feature = "lan-quic", not(feature = "relay")))]
fn test_registry_override() -> Option<std::sync::Arc<crate::lan_quic::LanQuicRegistry>> {
    TEST_REGISTRY_OVERRIDE.get().cloned()
}

#[cfg(all(not(test), feature = "lan-quic", not(feature = "relay")))]
fn test_registry_override() -> Option<std::sync::Arc<crate::lan_quic::LanQuicRegistry>> {
    None
}

/// 选路要用的 Registry：测试注入优先（见上），否则生产进程级懒初始化。
#[cfg(all(feature = "lan-quic", not(feature = "relay")))]
async fn quic_registry_for_wiring(
) -> Result<std::sync::Arc<crate::lan_quic::LanQuicRegistry>, String> {
    if let Some(r) = test_registry_override() {
        return Ok(r);
    }
    crate::lan_quic::process_registry().await
}

/// LAN 直连：原料齐全 ⇒ `QuicThenHttpEndpoint`（QUIC 首、HTTP fallback）；否则/失败 ⇒ 原 `LanEndpoint`。
#[cfg(all(feature = "lan-quic", not(feature = "relay")))]
async fn lan_quic_or_http(
    peer: &crate::mesh::MeshPeer,
    client: reqwest::Client,
) -> Result<Box<dyn Endpoint + Send>, String> {
    if peer.quic_addrs.is_empty() || peer.node_id.trim().is_empty() {
        // 老对端/旧公告：没有原料 ⇒ 与接线前完全一致（纯 HTTP），只留一行可读日志。
        eprintln!(
            "{}",
            quic_setup_log_line(
                &peer.device_id,
                "对端没报 node_id/quic_addrs（老对端或旧公告）"
            )
        );
        return Ok(Box::new(LanEndpoint::new(&peer.base, client)));
    }
    let registry = match quic_registry_for_wiring().await {
        Ok(r) => r,
        Err(why) => {
            eprintln!(
                "{}",
                quic_setup_log_line(
                    &peer.device_id,
                    &format!("进程级 QUIC Registry 初始化失败：{why}")
                )
            );
            return Ok(Box::new(LanEndpoint::new(&peer.base, client)));
        }
    };
    match quic_endpoint_for(peer, registry).await {
        Ok(first) => Ok(Box::new(QuicThenHttpEndpoint::with_http_fallback(
            first, &peer.base, client,
        ))),
        Err(why) => {
            eprintln!(
                "{}",
                quic_setup_log_line(&peer.device_id, &format!("QUIC 端点构造失败：{why}"))
            );
            Ok(Box::new(LanEndpoint::new(&peer.base, client)))
        }
    }
}

/// 接线失败回退日志的唯一拼装点（纯函数）：只接 peer/原因 ⇒ ⛔ 不含 token/签名。
#[cfg(all(feature = "lan-quic", not(feature = "relay")))]
fn quic_setup_log_line(device_id: &str, why: &str) -> String {
    format!("[mesh-endpoint] P3-2a：QUIC 端点不可用 ⇒ 走 HTTP（peer={device_id}；原因={why}）")
}

#[cfg(feature = "relay")]
async fn relay_endpoint_for(
    peer: &crate::mesh::MeshPeer,
    node_id: &str,
) -> Result<Box<dyn Endpoint + Send>, String> {
    // ⭐ **许可门在"建隧道之前"**（owner 2026-10-09 拍：到期只收回跨网）——
    //   判定不过就**连隧道都不建**；错误话术里明说"局域网与本地功能照旧"。
    {
        let cfg = crate::relay_client::load_config()
            .map_err(|e| format!("读不到中继配置（跨网许可判定不了，因而不建隧道）：{e}"))?;
        crate::relay_client::gate_for_new_tunnel(&cfg, crate::relay_client::now_unix())?;
    }
    use std::net::SocketAddr;
    let routes = crate::relay_route::load_routes()?;
    let route = crate::relay_route::route_for(&routes, &peer.device_id).ok_or_else(|| {
        format!(
            "对端 {} 要走跨网，但跨网路线表里没有它（peer 的 node_id={}）",
            peer.device_id, node_id
        )
    })?;
    // ⚠️ **2026-10-25（真机：mac 报「路线没有可达地址…Step 3-2」）**：这里原有一道
    //   `if route.addrs.is_empty() { return Err(...) }` 的**早检查**，它只看 `addrs`（直连 IP）
    //   ⇒ 只要路线里是"**只填 relay、不填 IP**"（异网的正确写法），就会被这条直接拒掉，
    //   下面那段"把 relay 也塞进 EndpointAddr"的逻辑永远走不到 ✗。
    //   ⇒ 删掉它：**统一由下面 `addrs.is_empty()` 那条判**（直连与 relay 都算可达）。
    // ⭐ 2026-10-25（异网寻址）：直连地址 ＋ **中继地址**都要带进 `EndpointAddr`；
    //   只带 IP 的话，两台机器不在同一网络就互相找不到。
    let mut addrs: std::collections::BTreeSet<iroh::TransportAddr> = route
        .addrs
        .iter()
        .filter_map(|a| a.parse::<SocketAddr>().ok().map(iroh::TransportAddr::Ip))
        .collect();
    if let Some(r) = route.relay.as_deref() {
        let url: iroh::RelayUrl = r.parse().map_err(|e| {
            format!(
                "路线表里 {} 的 relay 地址 {:?} 解析失败：{e}",
                peer.device_id, r
            )
        })?;
        addrs.insert(iroh::TransportAddr::Relay(url));
    }
    if addrs.is_empty() {
        return Err(format!(
            "对端 {} 的路线既没有可用直连地址也没有可用 relay 地址 ⇒ 连不上",
            peer.device_id
        ));
    }
    let id_bytes = crate::relay_tunnel::iroh_client::node_id_bytes(&route.node_id)?;
    let id = iroh::PublicKey::from_bytes(&id_bytes)
        .map_err(|e| format!("路线表里 {} 的 node_id 不是合法公钥：{e}", peer.device_id))?;
    let ep =
        crate::relay_tunnel::iroh_client::RelayEndpoint::connect(iroh::EndpointAddr { id, addrs })
            .await?;
    Ok(Box::new(ep))
}

#[cfg(not(feature = "relay"))]
async fn relay_endpoint_for(
    _peer: &crate::mesh::MeshPeer,
    _node_id: &str,
) -> Result<Box<dyn Endpoint + Send>, String> {
    Err("这个构建没编入跨网隧道（需要 --features relay）".to_string())
}

// ═══════════════════ P3-2a：QUIC 直连适配器（只在 --features lan-quic 下编） ═══════════════════
//
// 这一块是**接线件**，不是选路：`endpoint_for_peer` 的默认/relay 分支一个字没动（见上面），
// 本笔也**不接同步轮次**。它只提供一条显式路径：
//   `MeshPeer`（已带 `node_id`/`quic_addrs` 原料）＋ `LanQuicRegistry` ⇒ 一个实现既有 `Endpoint` trait 的端点。
// ⛔ 不消费地址到 `endpoint_for_peer`、⛔ 不做 LAN/relay 优先级判定（那是 P3-2 后续）。

/// ⭐ **P3-2a 适配器**：把 `LanQuicRegistry`（QUIC 请求）适配成既有的 [`Endpoint`] trait。
///
/// * `get`：`GET target` → `TunnelRequest`（三格鉴权头 ＋ `authorization: Bearer …` 与 `LanEndpoint` 同形）
///   → `registry.request(peer, …)`（**复用缓存连接**）→ [`HttpReply`]（状态/体逐字语义与 LanEndpoint 对齐）；
/// * `get_stream`：**先 QUIC（隧道整包缓冲成流，2026-11-09）**，失败/不支持再 HTTP fallback
///   （附件字节因此也走直连隧道；`relay_tunnel::MAX_BODY_BYTES` 上限内的件都支持）。
///
/// ⚠️ 它**不拥有** Registry（`Arc` 共享）：一进程一端点由持有 Registry 的接线方保证。
// ⚠️ **P3-2a 接线后**：`lan-quic` 非 relay 构建已由 `endpoint_for_peer` 真正使用 ⇒ 那档**没有 allow**；
// `relay` 构建仍走旧 HTTP/relay 路径 ⇒ 这些适配器暂无人调用，仅在 relay 档保留 allow（可读噪音归零）。
// ⏳ **2026-11-08 收据**：relay 构建也接入 QUIC 选路（或适配器被删）时，删掉本块各条
//   `cfg_attr(feature = "relay", allow(dead_code))`。
#[cfg(feature = "lan-quic")]
#[cfg_attr(feature = "relay", allow(dead_code))]
pub struct QuicMeshEndpoint {
    registry: std::sync::Arc<crate::lan_quic::LanQuicRegistry>,
    peer: iroh::EndpointAddr,
}

#[cfg(feature = "lan-quic")]
impl QuicMeshEndpoint {
    /// 用「已解析好的对端地址 ＋ 已有 Registry」构造（工厂 [`quic_endpoint_for`] 是正常入口）。
    /// ⏳ **2026-11-08 收据**：relay 构建也使用本构造器时删掉这条 allow。
    #[cfg_attr(feature = "relay", allow(dead_code))]
    pub fn new(
        registry: std::sync::Arc<crate::lan_quic::LanQuicRegistry>,
        peer: iroh::EndpointAddr,
    ) -> Self {
        Self { registry, peer }
    }
}

#[cfg(feature = "lan-quic")]
impl Endpoint for QuicMeshEndpoint {
    fn get<'a>(
        &'a self,
        target: &'a str,
        auth: Option<(&'a str, i64, &'a str)>,
        token: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<HttpReply, String>> + Send + 'a>> {
        Box::pin(async move {
            // 与 `RelayEndpoint::get` **同一套头**（名字取自 mesh，⛔ 不另立一份）。
            let mut req = crate::relay_tunnel::TunnelRequest::new("GET", target);
            if let Some((device_id, ts, sig)) = auth {
                req = req
                    .with_header(crate::mesh::HDR_DEVICE, device_id)
                    .with_header(crate::mesh::HDR_TS, &ts.to_string())
                    .with_header(crate::mesh::HDR_SIG, sig);
            }
            if let Some(t) = token.map(str::trim).filter(|t| !t.is_empty()) {
                req = req.with_header("authorization", &format!("Bearer {t}"));
            }
            let reply = self.registry.request(self.peer.clone(), &req).await?;
            Ok(HttpReply {
                status: reply.status,
                body: String::from_utf8_lossy(&reply.body).into_owned(),
            })
        })
    }

    /// ⭐ **2026-11-09（附件也走直连）**：QUIC 隧道帧支持 64MB 正文
    /// （`relay_tunnel::MAX_BODY_BYTES`）⇒ 这里把**整包缓冲**成一条单向流
    /// （⛔ 不是真流式；非 2xx / 超上限 ⇒ Err，由组合器回退 HTTP）。
    /// 鉴权与 `get` 同形：三格头 ＋ `authorization: Bearer …`（与 `LanEndpoint` 同一套）。
    fn get_stream<'a>(
        &'a self,
        target: &'a str,
        auth: Option<(&'a str, i64, &'a str)>,
        token: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<(u16, AttachmentBody), String>> + Send + 'a>> {
        Box::pin(async move {
            let mut req = crate::relay_tunnel::TunnelRequest::new("GET", target);
            if let Some((device_id, ts, sig)) = auth {
                req = req
                    .with_header(crate::mesh::HDR_DEVICE, device_id)
                    .with_header(crate::mesh::HDR_TS, &ts.to_string())
                    .with_header(crate::mesh::HDR_SIG, sig);
            }
            if let Some(t) = token.map(str::trim).filter(|t| !t.is_empty()) {
                req = req.with_header("authorization", &format!("Bearer {t}"));
            }
            let reply = self
                .registry
                .request(self.peer.clone(), &req)
                .await
                .map_err(|e| format!("QUIC 附件请求失败：{e}"))?;
            if reply.status != 200 && reply.status != 206 {
                return Err(format!(
                    "QUIC 附件请求 HTTP {}（body={} B）",
                    reply.status,
                    reply.body.len()
                ));
            }
            // 真机验收证据：**这一行 = 附件字节确实走了 QUIC**（⛔ 不含 token/签名）。
            eprintln!(
                "[mesh-endpoint] 附件走 QUIC（target={target}；{} B）",
                reply.body.len()
            );
            let (mut writer, reader) = tokio::io::duplex(64 * 1024);
            let body = reply.body;
            tokio::spawn(async move {
                use tokio::io::AsyncWriteExt;
                let _ = writer.write_all(&body).await;
                let _ = writer.shutdown().await;
            });
            Ok((reply.status, Box::pin(reader) as AttachmentBody))
        })
    }
}

/// ⭐ **P3-2a 工厂**：给定**已带原料**的 `MeshPeer` ＋ 已有 Registry ⇒ 一个 QUIC `Endpoint`。
///
/// 错误边界（全部**可读**、⛔ 不静默降级）：
/// * `peer.node_id` 不是 64 位 hex ⇒ 报错（来自 [`crate::lan_quic::endpoint_addr`]）；
/// * `peer.quic_addrs` 为空 ⇒ 明确"只有 node id 连不上"（同上）；
/// * 地址坏/超上限 ⇒ 点名第几条（同上）。
///
/// ⚠️ 它**不**决定"该不该走 QUIC"：选路仍是 P3-2 的事；调用方只在明确要走 QUIC 时调它。
/// ⏳ **2026-11-08 收据**：relay 构建的选路也调用本工厂时删掉这条 allow。
#[cfg(feature = "lan-quic")]
#[cfg_attr(feature = "relay", allow(dead_code))]
pub async fn quic_endpoint_for(
    peer: &crate::mesh::MeshPeer,
    registry: std::sync::Arc<crate::lan_quic::LanQuicRegistry>,
) -> Result<Box<dyn Endpoint + Send>, String> {
    let addr = crate::lan_quic::endpoint_addr(&peer.node_id, &peer.quic_addrs)?;
    Ok(Box::new(QuicMeshEndpoint::new(registry, addr)))
}

/// ⭐ **P3-2a 回退组合器**：`first`（QUIC）优先，失败时**打一行日志再回退 HTTP**。
///
/// 语义（本笔只做组合，⛔ 不改 `endpoint_for_peer` 选路）：
/// * `get`：先 `first.get` —— **成功就直接回**（⛔ 不重复请求、⛔ 不碰 HTTP）；
///   失败 ⇒ 打**一行**可读日志（只含 target 与原因；⛔ 不含 token/签名）→ `fallback.get`；
/// * `get_stream`：**先 QUIC（隧道整包缓冲成流）**，失败/不支持再 HTTP fallback（2026-11-09）；
/// * `first` 抽象成 `Box<dyn Endpoint + Send>` ⇒ 测试可塞假端点，生产可塞 [`QuicMeshEndpoint`]。
///
/// ⚠️ **P3-2a 接线后**：`lan-quic` 非 relay 构建由 `endpoint_for_peer` 使用 ⇒ 那档无 allow；
/// `relay` 构建仍走旧路径 ⇒ 仅 relay 档保留 allow。
/// ⏳ **2026-11-08 收据**：relay 构建也走本组合器时删掉这条 allow。
#[cfg(feature = "lan-quic")]
#[cfg_attr(feature = "relay", allow(dead_code))]
pub struct QuicThenHttpEndpoint {
    first: Box<dyn Endpoint + Send>,
    fallback: LanEndpoint,
}

#[cfg(feature = "lan-quic")]
impl QuicThenHttpEndpoint {
    /// 用「优先端点（通常是 QUIC）＋ HTTP fallback 的 base/client」构造。
    /// ⏳ **2026-11-08 收据**：relay 构建也使用本构造器时删掉这条 allow。
    #[cfg_attr(feature = "relay", allow(dead_code))]
    pub fn with_http_fallback(
        first: Box<dyn Endpoint + Send>,
        base: &str,
        client: reqwest::Client,
    ) -> Self {
        Self {
            first,
            fallback: LanEndpoint::new(base, client),
        }
    }
}

#[cfg(feature = "lan-quic")]
impl Endpoint for QuicThenHttpEndpoint {
    fn get<'a>(
        &'a self,
        target: &'a str,
        auth: Option<(&'a str, i64, &'a str)>,
        token: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<HttpReply, String>> + Send + 'a>> {
        Box::pin(async move {
            let started = std::time::Instant::now();
            match self.first.get(target, auth, token).await {
                Ok(reply) => Ok(reply),
                Err(why) => {
                    // ⚠️ 只有一行、只含 target/原因：日志行由 [`fallback_log_line`] 这一处拼装
                    //（它**不接** token/签名参数 ⇒ 从类型上就不可能把机密拼进去）。
                    // ⭐ 2026-11-09（真机排查）：把 **QUIC 尝试耗时** 拼进“原因”里 ——
                    //   “立刻失败（TLS/身份）”与“30s 空等（网络不通）”是两种完全不同的病，
                    //   没有这个读数只能猜（本次 QUIC timed out 排查就卡在这一步）。
                    let why = format!("{why}（QUIC 尝试耗时 {}ms）", started.elapsed().as_millis());
                    eprintln!("{}", fallback_log_line(target, &why));
                    self.fallback.get(target, auth, token).await
                }
            }
        })
    }

    fn get_stream<'a>(
        &'a self,
        target: &'a str,
        auth: Option<(&'a str, i64, &'a str)>,
        token: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<(u16, AttachmentBody), String>> + Send + 'a>> {
        // ⭐ 2026-11-09（附件也走直连）：先 QUIC（隧道整包缓冲），失败再 HTTP ——
        // 与 `get` 同一条组合语义（成功不重复请求；失败才打一行日志）。
        Box::pin(async move {
            let started = std::time::Instant::now();
            match self.first.get_stream(target, auth, token).await {
                Ok(pair) => Ok(pair),
                // 适配器明确"不支持流式" ⇒ 正常回退，不当作故障打日志。
                Err(why) if why.contains("不支持流式") => {
                    self.fallback.get_stream(target, auth, token).await
                }
                Err(why) => {
                    let why = format!("{why}（QUIC 尝试耗时 {}ms）", started.elapsed().as_millis());
                    eprintln!("{}", fallback_log_line(target, &why));
                    self.fallback.get_stream(target, auth, token).await
                }
            }
        })
    }
}

/// 回退日志行的**唯一**构造点（纯函数）：只接收 `target` 与 `why` ⇒ 类型上就**不可能**拼进
/// token/签名。测试直接核这一行的形状（含 target/原因、只有一行、不含机密）。
/// ⏳ **2026-11-08 收据**：relay 构建也走回退组合器时删掉这条 allow。
#[cfg(feature = "lan-quic")]
#[cfg_attr(feature = "relay", allow(dead_code))]
fn fallback_log_line(target: &str, why: &str) -> String {
    format!("[mesh-endpoint] P3-2a：QUIC 首次尝试失败 ⇒ 回退 HTTP（target={target}；原因={why}）")
}

/// 拼一个 base 与 target（**唯一一处**；`trim_end_matches('/')` 的老口径保持不变 ✓）。
pub fn join(base: &str, target: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), target)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 拼接口径：base 末尾有/没有 `/` 结果一致；target 原样接在后面。
    #[test]
    fn joining_keeps_the_old_shape() {
        assert_eq!(
            join("http://192.168.0.5:8788", "/mesh/pull?x=1"),
            "http://192.168.0.5:8788/mesh/pull?x=1"
        );
        assert_eq!(
            join("http://192.168.0.5:8788/", "/mesh/pull?x=1"),
            "http://192.168.0.5:8788/mesh/pull?x=1"
        );
    }

    /// ⭐ **2026-10-25（Step 3-1 判据）**：`relay:` 前缀的对端**不许**被当成局域网地址去连 ——
    /// 没编入跨网时给**可读错误**（⛔ 不静默、⛔ 不拿一个假 base 去发 HTTP）。
    ///
    /// **变异**：把 `endpoint_for_peer` 的前缀判断删掉 ⇒ 它会拿 `relay:xxx` 去拼 URL ⇒ 本判据红
    /// （LAN 分支返回 Ok，而这里断言的是 Err）。
    #[cfg(not(feature = "relay"))]
    #[tokio::test]
    async fn a_relay_base_is_not_silently_treated_as_lan() {
        let peer = crate::mesh::MeshPeer {
            device_id: "dev-x".to_string(),
            base: format!("{RELAY_BASE_PREFIX}0123456789abcdef"),
            quic_addrs: Vec::new(),
            node_id: String::new(),
        };
        let err = match endpoint_for_peer(&peer, reqwest::Client::new()).await {
            Ok(_) => panic!("relay: 前缀必须走跨网分支（⛔ 不许当 LAN）"),
            Err(e) => e,
        };
        assert!(err.contains("--features relay"), "要说清怎么办：{err}");
    }
}

/// ⭐ **P3-2a：`QuicMeshEndpoint` 适配器判据**（只在 `--features lan-quic` 下编）。
///
/// 只验三件事（⛔ 不选路、不接同步轮次）：
/// 1) 一次真的 `Endpoint::get`：状态 200／正文逐字／三格鉴权头 ＋ `authorization` **原样到达服务端**；
/// 2) `get_stream` 明确拒绝（⛔ 不静默退回整包读）；
/// 3) `quic_endpoint_for` 的错误边界：空 `node_id`、空 `quic_addrs`、坏 `node_id`、坏地址都点名。
#[cfg(all(test, feature = "lan-quic"))]
mod quic_endpoint_tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    use crate::lan_quic::{bind_direct, LanQuicEndpoint, LanQuicRegistry};
    use crate::relay_tunnel::{read_request, write_reply, TunnelReply};
    use iroh::SecretKey;

    fn ipv4_port(ep: &LanQuicEndpoint) -> u16 {
        ep.local_addrs()
            .iter()
            .find_map(|s| match s {
                std::net::SocketAddr::V4(v4) if v4.port() != 0 => Some(v4.port()),
                _ => None,
            })
            .expect("端点必须至少绑上一个 IPv4 端口")
    }

    fn peer_with(node_id: &str, addrs: Vec<String>) -> crate::mesh::MeshPeer {
        crate::mesh::MeshPeer {
            device_id: "dev-a".to_string(),
            // ⚠️ base 故意是个连不上的占位：走 QUIC 这条路时它必须**被忽略**。
            base: "http://unused.invalid:1".to_string(),
            quic_addrs: addrs,
            node_id: node_id.to_string(),
        }
    }

    #[tokio::test]
    async fn a_quic_endpoint_get_carries_status_body_and_auth_headers() {
        let server = bind_direct(SecretKey::generate())
            .await
            .expect("服务端端点");
        let port = ipv4_port(&server);
        let node_hex = server.node_id_hex();
        let serve = tokio::spawn(async move {
            let Some(incoming) = server.accept().await else {
                panic!("端点已关，接不到连接");
            };
            let conn = incoming.await.expect("QUIC 握手");
            let (mut send, mut recv) = conn.accept_bi().await.expect("接流");
            let req = read_request(&mut recv).await.expect("读请求");
            // 头/方法/target 必须**原样**到达服务端（与 LAN HTTP 路径同一套鉴权材料）。
            assert_eq!(req.method, "GET");
            assert_eq!(req.target, "/mesh/manifest?space_id=x");
            assert_eq!(req.header(crate::mesh::HDR_DEVICE), Some("dev-a"));
            assert_eq!(req.header(crate::mesh::HDR_TS), Some("1700000000000"));
            assert_eq!(req.header(crate::mesh::HDR_SIG), Some("sig-hex"));
            assert_eq!(req.header("authorization"), Some("Bearer tok-1"));
            write_reply(
                &mut send,
                &TunnelReply {
                    status: 200,
                    body: b"{\"ok\":true}".to_vec(),
                },
            )
            .await
            .expect("写应答");
            send.finish().expect("收流");
            let _ = conn.closed().await;
        });

        let registry = Arc::new(
            LanQuicRegistry::new(SecretKey::generate())
                .await
                .expect("注册表"),
        );
        let peer = peer_with(&node_hex, vec![format!("127.0.0.1:{port}")]);
        let ep = quic_endpoint_for(&peer, Arc::clone(&registry))
            .await
            .expect("工厂应能建出 QUIC 端点");

        let reply = tokio::time::timeout(
            Duration::from_secs(30),
            ep.get(
                "/mesh/manifest?space_id=x",
                Some(("dev-a", 1_700_000_000_000, "sig-hex")),
                Some("tok-1"),
            ),
        )
        .await
        .expect("30 秒内必须完成")
        .expect("QUIC get 应成功");
        assert_eq!(reply.status, 200, "状态码要逐字带出");
        assert_eq!(reply.body, "{\"ok\":true}", "正文要逐字带出");

        // ⛔ 附件流式：本适配器**明确不支持**（用 trait 默认实现，不许静默退回整包读）。
        let err = match ep.get_stream("/mesh/attachment?hash=x", None, None).await {
            Ok(_) => panic!("get_stream 必须拒绝（⛔ 不许静默退回整包读）"),
            Err(e) => e,
        };
        assert!(err.contains("不支持流式"), "要说清不支持什么：{err}");

        registry.close().await;
        serve.await.expect("服务任务不应 panic");
    }

    #[tokio::test]
    async fn quic_endpoint_for_refuses_missing_or_bad_materials() {
        let registry = Arc::new(
            LanQuicRegistry::new(SecretKey::generate())
                .await
                .expect("注册表"),
        );
        let good_node = registry.endpoint().node_id_hex();

        // ① 空 node_id
        let err = match quic_endpoint_for(
            &peer_with("", vec!["1.2.3.4:4433".to_string()]),
            Arc::clone(&registry),
        )
        .await
        {
            Ok(_) => panic!("空 node_id 必须报错"),
            Err(e) => e,
        };
        assert!(err.contains("node_id"), "要点名 node_id：{err}");

        // ② 空 quic_addrs（只有 node id 连不上）
        let err = match quic_endpoint_for(&peer_with(&good_node, Vec::new()), Arc::clone(&registry))
            .await
        {
            Ok(_) => panic!("空地址必须报错"),
            Err(e) => e,
        };
        assert!(
            err.contains("QUIC 地址") || err.contains("quic_addrs"),
            "要说清没有地址：{err}"
        );

        // ③ 坏 node_id（长度/hex）
        let err = match quic_endpoint_for(
            &peer_with("abc", vec!["1.2.3.4:4433".to_string()]),
            Arc::clone(&registry),
        )
        .await
        {
            Ok(_) => panic!("坏 node_id 必须报错"),
            Err(e) => e,
        };
        assert!(err.contains("node_id") && err.contains("64"), "{err}");

        // ④ 坏地址（点名第几条）
        let err = match quic_endpoint_for(
            &peer_with(&good_node, vec!["nope".to_string()]),
            Arc::clone(&registry),
        )
        .await
        {
            Ok(_) => panic!("坏地址必须报错"),
            Err(e) => e,
        };
        assert!(err.contains("第 1 条"), "要点名第几条：{err}");

        registry.close().await;
    }
}

/// ⭐ **P3-2a：`QuicThenHttpEndpoint` 回退组合器判据**（只在 `--features lan-quic` 下编）。
///
/// 用**假首端点**（计数/固定结果）＋ **最小本地 HTTP 服务**（计数/固定应答），不建真实 QUIC。
/// 只验五件事：成功不碰 HTTP、失败正好回退一次、`get_stream` 首端点优先/不支持时回退、
/// 日志行形状不泄密。
#[cfg(all(test, feature = "lan-quic"))]
mod quic_fallback_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 假首端点：记录被调用次数，按固定结果返回。
    struct FakeEndpoint {
        calls: Arc<AtomicUsize>,
        result: Result<HttpReply, String>,
        /// `get_stream` 的结果：`Some(Ok(body))` ⇒ 支持流式；`Some(Err)` ⇒ 指定的失败；
        /// `None` ⇒ 用 trait 默认实现（"不支持流式"）。
        stream: Option<Result<&'static str, String>>,
    }

    impl Endpoint for FakeEndpoint {
        fn get<'a>(
            &'a self,
            _target: &'a str,
            _auth: Option<(&'a str, i64, &'a str)>,
            _token: Option<&'a str>,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<HttpReply, String>> + Send + 'a>,
        > {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.result.clone()
            })
        }

        fn get_stream<'a>(
            &'a self,
            _target: &'a str,
            _auth: Option<(&'a str, i64, &'a str)>,
            _token: Option<&'a str>,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<(u16, AttachmentBody), String>> + Send + 'a,
            >,
        > {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                match &self.stream {
                    None => Err("这个端点不支持流式（附件暂不能走它）".to_string()),
                    Some(Err(e)) => Err(e.clone()),
                    Some(Ok(body)) => {
                        let (mut writer, reader) = tokio::io::duplex(64 * 1024);
                        let bytes = body.as_bytes().to_vec();
                        tokio::spawn(async move {
                            use tokio::io::AsyncWriteExt;
                            let _ = writer.write_all(&bytes).await;
                            let _ = writer.shutdown().await;
                        });
                        Ok((200, Box::pin(reader) as AttachmentBody))
                    }
                }
            })
        }
    }

    /// 最小本地 HTTP 服务：接连接就计数，回一个固定 `201` ＋ 正文。
    struct FakeHttp {
        base: String,
        accepted: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }

    async fn spawn_http_ok(body: &'static str) -> FakeHttp {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("起最小 HTTP 服务");
        let addr = listener.local_addr().expect("本地地址");
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&accepted);
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    // 读掉请求（reqwest 一次请求一连接；本服务只回一个固定应答）。
                    let mut buf = vec![0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let resp = format!(
                        "HTTP/1.1 201 Created\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        FakeHttp {
            base: format!("http://{addr}"),
            accepted,
            task,
        }
    }

    /// ① 首端点成功 ⇒ 只调 first 一次、HTTP **零请求**、状态/正文来自 first；
    /// ② 再请求一次 ⇒ first 计数变 2、HTTP 仍是 0（"成功绝不重复请求/不偷偷走 HTTP"）。
    #[tokio::test]
    async fn a_successful_first_call_never_touches_http() {
        let http = spawn_http_ok("HTTP-BODY").await;
        let calls = Arc::new(AtomicUsize::new(0));
        let first = FakeEndpoint {
            calls: Arc::clone(&calls),
            result: Ok(HttpReply {
                status: 200,
                body: "QUIC-BODY".to_string(),
            }),
            stream: None,
        };
        let ep = QuicThenHttpEndpoint::with_http_fallback(
            Box::new(first),
            &http.base,
            reqwest::Client::new(),
        );

        let reply = ep
            .get("/mesh/manifest?space_id=x", None, None)
            .await
            .expect("首端点成功");
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body, "QUIC-BODY", "成功时状态/正文必须来自 first");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "first 只该被调用一次");

        // 再请求一次：first 计数 +1，但 HTTP 仍然零请求。
        let reply2 = ep
            .get("/mesh/manifest?space_id=x", None, None)
            .await
            .expect("首端点成功");
        assert_eq!(reply2.body, "QUIC-BODY");
        assert_eq!(calls.load(Ordering::SeqCst), 2, "每次请求各调 first 一次");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            http.accepted.load(Ordering::SeqCst),
            0,
            "first 成功时 HTTP 一个连接都不许建（⛔ 不重复请求、⛔ 不偷偷回退）"
        );
        http.task.abort();
    }

    /// ③ first 失败 ⇒ **恰好一次** HTTP 回退，返回 HTTP 的状态/正文；日志行形状可核。
    #[tokio::test]
    async fn a_failed_first_call_falls_back_to_http_once() {
        let http = spawn_http_ok("HTTP-BODY").await;
        let calls = Arc::new(AtomicUsize::new(0));
        let first = FakeEndpoint {
            calls: Arc::clone(&calls),
            result: Err("假 QUIC 失败：连接被拒绝".to_string()),
            stream: None,
        };
        let ep = QuicThenHttpEndpoint::with_http_fallback(
            Box::new(first),
            &http.base,
            reqwest::Client::new(),
        );

        let reply = ep
            .get("/mesh/manifest?space_id=x", None, Some("SECRET-TOKEN"))
            .await
            .expect("失败必须回退到 HTTP 并成功");
        assert_eq!(reply.status, 201, "状态来自 HTTP fallback");
        assert_eq!(reply.body, "HTTP-BODY", "正文来自 HTTP fallback");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "first 只试一次（⛔ 不重试）"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            http.accepted.load(Ordering::SeqCst),
            1,
            "失败后只回退一次 HTTP"
        );

        // 日志行：一行、含 target 与原因、不含 token/签名。
        let line = fallback_log_line("/mesh/manifest?space_id=x", "假 QUIC 失败：连接被拒绝");
        assert_eq!(line.lines().count(), 1, "日志必须只有一行：{line}");
        assert!(
            line.contains("target=/mesh/manifest?space_id=x"),
            "要带 target：{line}"
        );
        assert!(
            line.contains("假 QUIC 失败：连接被拒绝"),
            "要带原因：{line}"
        );
        assert!(
            !line.contains("SECRET-TOKEN"),
            "⛔ 日志不许带 token：{line}"
        );
        assert!(!line.contains("sig"), "⛔ 日志不许带签名：{line}");
        http.task.abort();
    }

    /// ④ `get_stream`：首端点**支持流式**时 ⇒ 走首端点（⛔ 不碰 HTTP）。
    #[tokio::test]
    async fn get_stream_prefers_the_first_endpoint_when_it_supports_streaming() {
        let http = spawn_http_ok("STREAM-BODY").await;
        let calls = Arc::new(AtomicUsize::new(0));
        let first = FakeEndpoint {
            calls: Arc::clone(&calls),
            result: Ok(HttpReply {
                status: 200,
                body: "QUIC-NEVER".to_string(),
            }),
            stream: Some(Ok("QUIC-STREAM")),
        };
        let ep = QuicThenHttpEndpoint::with_http_fallback(
            Box::new(first),
            &http.base,
            reqwest::Client::new(),
        );

        let (status, mut body) = ep
            .get_stream("/mesh/attachment?hash=abc", None, None)
            .await
            .expect("首端点支持流式");
        assert_eq!(status, 200);
        let mut got = Vec::new();
        body.read_to_end(&mut got).await.expect("读流");
        assert_eq!(
            std::str::from_utf8(&got).expect("UTF-8 正文"),
            "QUIC-STREAM"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1, "首端点只该被调用一次");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            http.accepted.load(Ordering::SeqCst),
            0,
            "首端点成功时 HTTP 一个连接都不许建"
        );
        http.task.abort();
    }

    /// ⑤ 首端点明确"不支持流式" ⇒ **静默回退 HTTP**（不当作故障），状态/字节都来自 fallback。
    #[tokio::test]
    async fn get_stream_falls_back_to_http_when_the_first_endpoint_cannot_stream() {
        let http = spawn_http_ok("STREAM-BODY").await;
        let calls = Arc::new(AtomicUsize::new(0));
        let first = FakeEndpoint {
            calls: Arc::clone(&calls),
            result: Ok(HttpReply {
                status: 200,
                body: "QUIC-NEVER".to_string(),
            }),
            stream: None,
        };
        let ep = QuicThenHttpEndpoint::with_http_fallback(
            Box::new(first),
            &http.base,
            reqwest::Client::new(),
        );

        let (status, mut body) = ep
            .get_stream("/mesh/attachment?hash=abc", None, None)
            .await
            .expect("回退 HTTP 成功");
        assert_eq!(status, 201);
        let mut got = Vec::new();
        body.read_to_end(&mut got).await.expect("读流");
        assert_eq!(
            std::str::from_utf8(&got).expect("UTF-8 正文"),
            "STREAM-BODY"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1, "首端点试过一次");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(http.accepted.load(Ordering::SeqCst), 1, "回退恰好一次 HTTP");
        http.task.abort();
    }
}

/// 测试用**最小 HTTP 服务**（默认/relay/lan-quic 三档通用；不依赖 feature）。
#[cfg(test)]
mod http_test_support {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    pub struct HttpStub {
        pub base: String,
        accepted: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }

    impl HttpStub {
        pub fn accepted(&self) -> usize {
            self.accepted.load(Ordering::SeqCst)
        }
    }

    impl Drop for HttpStub {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    /// 起一个本地最小 HTTP 服务：接连接就计数，回固定 `201` ＋ 正文（不解析路径）。
    pub async fn spawn_http_ok(body: &'static str) -> HttpStub {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("起最小 HTTP 服务");
        let addr = listener.local_addr().expect("本地地址");
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&accepted);
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let resp = format!(
                        "HTTP/1.1 201 Created\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        HttpStub {
            base: format!("http://{addr}"),
            accepted,
            task,
        }
    }
}

/// ⭐ **不回归证据（默认构建）**：即使 `MeshPeer` 带了 QUIC 原料，默认构建的 `endpoint_for_peer`
/// 仍必须是**原 HTTP 路径**（QUIC 接线只在 `all(lan-quic, not(relay))` 下编）。
#[cfg(all(test, not(feature = "lan-quic")))]
mod default_endpoint_keeps_http_tests {
    use super::http_test_support::spawn_http_ok;
    use super::*;

    #[tokio::test]
    async fn default_build_ignores_quic_materials_and_uses_http() {
        let http = spawn_http_ok("HTTP-BODY").await;
        let peer = crate::mesh::MeshPeer {
            device_id: "dev-default".to_string(),
            base: http.base.clone(),
            // 原料故意"看起来齐全"：默认构建也必须忽略它们。
            quic_addrs: vec!["127.0.0.1:1".to_string()],
            node_id: "ab".repeat(32),
        };
        let ep = endpoint_for_peer(&peer, reqwest::Client::new())
            .await
            .expect("默认构建必须仍返回 HTTP 端点");
        let reply = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            ep.get("/mesh/manifest?space_id=x", None, None),
        )
        .await
        .expect("10 秒内必须完成")
        .expect("HTTP 请求成功");
        assert_eq!(reply.status, 201);
        assert_eq!(reply.body, "HTTP-BODY", "默认构建不许走 QUIC");
    }
}

/// ⭐ **不回归证据（relay 构建）**：relay 构建即使对端原料齐全、甚至 QUIC 服务真的在跑，
/// `endpoint_for_peer` 也必须仍返回旧 HTTP 端点（新接线只在 `all(lan-quic, not(relay))` 下编）。
#[cfg(all(test, feature = "relay"))]
mod relay_endpoint_keeps_http_tests {
    use super::http_test_support::spawn_http_ok;
    use super::*;

    fn ipv4_port(ep: &crate::lan_quic::LanQuicEndpoint) -> u16 {
        ep.local_addrs()
            .iter()
            .find_map(|s| match s {
                std::net::SocketAddr::V4(v4) if v4.port() != 0 => Some(v4.port()),
                _ => None,
            })
            .expect("端点必须至少绑上一个 IPv4 端口")
    }

    #[tokio::test]
    async fn relay_build_never_enters_the_quic_wiring_branch() {
        // 真起一个 QUIC 服务端：如果 relay 构建误接了新分支，请求会落到这里（正文 QUIC-BODY）。
        let quic_server = crate::lan_quic::bind_direct(iroh::SecretKey::generate())
            .await
            .expect("QUIC 服务端");
        let qport = ipv4_port(&quic_server);
        let qnode = quic_server.node_id_hex();
        let quic_task = tokio::spawn(async move {
            let Some(incoming) = quic_server.accept().await else {
                panic!("端点已关");
            };
            let conn = incoming.await.expect("QUIC 握手");
            let _ = crate::relay_tunnel::iroh_tunnel::serve_one_conn(conn, |_req| {
                crate::relay_tunnel::TunnelReply {
                    status: 200,
                    body: b"QUIC-BODY".to_vec(),
                }
            })
            .await;
        });

        let http = spawn_http_ok("HTTP-BODY").await;
        let peer = crate::mesh::MeshPeer {
            device_id: "dev-relay".to_string(),
            base: http.base.clone(),
            quic_addrs: vec![format!("127.0.0.1:{qport}")],
            node_id: qnode,
        };
        let ep = endpoint_for_peer(&peer, reqwest::Client::new())
            .await
            .expect("relay 构建必须仍返回旧 HTTP 端点");
        let reply = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            ep.get("/mesh/manifest?space_id=x", None, None),
        )
        .await
        .expect("10 秒内必须完成")
        .expect("HTTP 请求成功");
        assert_eq!(reply.status, 201, "relay 构建走 HTTP fallback 路径");
        assert_eq!(
            reply.body, "HTTP-BODY",
            "relay 构建 ⛔ 不许进入 QUIC 接线分支（进了就会拿到 QUIC-BODY）"
        );
        quic_task.abort();
    }
}

/// ⭐ **P3-2a 最后接线判据（仅 lan-quic 非 relay）**：
/// 原料缺失/坏 ⇒ 原 HTTP；原料合法但 QUIC 不可达 ⇒ 先试 QUIC 失败、再回退 HTTP。
#[cfg(all(test, feature = "lan-quic", not(feature = "relay")))]
mod quic_wiring_tests {
    use super::http_test_support::spawn_http_ok;
    use super::*;

    #[tokio::test]
    async fn missing_materials_keep_the_plain_http_endpoint() {
        let http = spawn_http_ok("HTTP-BODY").await;
        let peer = crate::mesh::MeshPeer {
            device_id: "dev-old".to_string(),
            base: http.base.clone(),
            // 老对端/旧公告：两格都空。
            quic_addrs: Vec::new(),
            node_id: String::new(),
        };
        let ep = endpoint_for_peer(&peer, reqwest::Client::new())
            .await
            .expect("原料缺失也必须成功（回退 HTTP）");
        let reply = ep
            .get("/mesh/manifest?space_id=x", None, None)
            .await
            .expect("HTTP 请求成功");
        assert_eq!(reply.status, 201);
        assert_eq!(reply.body, "HTTP-BODY");
    }

    #[tokio::test]
    async fn bad_materials_fall_back_to_http_with_a_readable_line() {
        let http = spawn_http_ok("HTTP-BODY").await;
        let peer = crate::mesh::MeshPeer {
            device_id: "dev-bad".to_string(),
            base: http.base.clone(),
            quic_addrs: vec!["not-an-addr".to_string()],
            node_id: "abc".to_string(), // 长度/hex 都坏
        };
        let ep = endpoint_for_peer(&peer, reqwest::Client::new())
            .await
            .expect("坏原料必须回退 HTTP，而不是让整次挑传输失败");
        let reply = ep
            .get("/mesh/manifest?space_id=x", None, None)
            .await
            .expect("HTTP 请求成功");
        assert_eq!(reply.status, 201);
        assert_eq!(reply.body, "HTTP-BODY");

        // 日志行（纯函数）可核：一行、含 peer 与原因、⛔ 不含 token/签名。
        let line = quic_setup_log_line(
            "dev-bad",
            "QUIC 端点构造失败：quic_addrs 第 1 条不是 IP:port",
        );
        assert_eq!(line.lines().count(), 1, "日志必须只有一行：{line}");
        assert!(line.contains("peer=dev-bad"), "要带 peer：{line}");
        assert!(line.contains("原因="), "要带原因：{line}");
        assert!(!line.contains("SECRET-TOKEN"), "⛔ 不含 token：{line}");
        assert!(!line.contains("sig"), "⛔ 不含签名：{line}");
        assert_eq!(http.accepted(), 1, "只该回退一次 HTTP");
    }

    #[tokio::test]
    async fn valid_but_unreachable_quic_falls_back_to_http_after_first_failure() {
        let _serial = super::test_registry_lock().lock().await;
        // ⚠️ 与 E2E 同因：用常驻 runtime 上的测试共享 Registry（不用全局 process_registry，
        // 那会绑在某个测试 runtime 上、测试结束就停摆）。
        test_override_registry(test_shared_registry());
        let registry = test_shared_registry();
        let before = registry.connect_attempts();

        let http = spawn_http_ok("HTTP-AFTER-QUIC-FAIL").await;
        let node_hex = hex::encode(iroh::SecretKey::generate().public().as_bytes());
        let peer = crate::mesh::MeshPeer {
            device_id: "dev-quic".to_string(),
            base: http.base.clone(),
            // 合法但**不可达**的 QUIC 地址：第一次请求会先试 QUIC、失败后走 HTTP。
            // ⚠️ 本判据会等 iroh 的连接超时（约 30s）—— 不加生产超时，只如实等待失败。
            quic_addrs: vec!["127.0.0.1:1".to_string()],
            node_id: node_hex,
        };
        let ep = endpoint_for_peer(&peer, reqwest::Client::new())
            .await
            .expect("合法原料必须构造出复合端点");
        let reply = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            ep.get("/mesh/manifest?space_id=x", None, None),
        )
        .await
        .expect("60 秒内必须完成（QUIC 超时 + HTTP 回退）")
        .expect("QUIC 失败后 HTTP 必须成功");
        assert_eq!(reply.status, 201);
        assert_eq!(reply.body, "HTTP-AFTER-QUIC-FAIL");
        assert!(
            registry.connect_attempts() > before,
            "必须真的先试过 QUIC（Registry connect_attempts 要增加），否则判据没覆盖回退路径"
        );
    }
}

/// ⭐ **P3-2a 单进程端到端**（仅 lan-quic 非 relay）：从 **`endpoint_for_peer` 入口**真的走一次
/// QUIC —— 证明"公告原料齐 ⇒ 选 QUIC 且成功"，而不只是各零件单测。
///
/// 判据形状（为什么"成功只可能来自 QUIC"）：
/// * 本地起一个**真 QUIC 服务端**（独立 secret），只有它会返回 `QUIC-ONLY-RESPONSE`；
/// * `peer.base` 故意给 **不可达** 的 `http://127.0.0.1:1` ⇒ 若请求真走了 HTTP fallback，
///   结果只可能是 `Err`（连接被拒）；
/// * 因此 `get` 拿到 `200 + QUIC-ONLY-RESPONSE`、且服务端确认收到那条请求 ⇒ **只能来自 QUIC**。
///
/// ⚠️ 本模块走**生产接线** ⇒ 用的是全局 `process_registry`（`OnceCell`）。共享性检查见
/// `the_process_registry_is_a_shared_singleton`；对"测试互相污染"的核对与结论写在报告里。
#[cfg(all(test, feature = "lan-quic", not(feature = "relay")))]
mod quic_single_process_e2e_tests {
    use super::*;
    use crate::lan_quic::{bind_direct, LanQuicEndpoint};
    use crate::relay_tunnel::{read_request, write_reply, TunnelReply};
    use iroh::SecretKey;
    use std::sync::Arc;
    use std::time::Duration;

    fn ipv4_port(ep: &LanQuicEndpoint) -> u16 {
        ep.local_addrs()
            .iter()
            .find_map(|s| match s {
                std::net::SocketAddr::V4(v4) if v4.port() != 0 => Some(v4.port()),
                _ => None,
            })
            .expect("端点必须至少绑上一个 IPv4 端口")
    }

    #[tokio::test]
    async fn a_get_from_endpoint_for_peer_succeeds_only_via_quic() {
        let _serial = super::test_registry_lock().lock().await;
        // ⚠️ 不用全局 process_registry：它绑在首次初始化它的测试 runtime 上，测试结束就停摆
        //（见 `quic_registry_for_wiring` 上方注释）。这里注入**常驻 runtime 上的测试共享 Registry**，
        // 但仍然走 `endpoint_for_peer` 的生产分支（只有 Registry 来源不同）。
        test_override_registry(test_shared_registry());

        // a) 本地真 QUIC 服务端：接一条连接、读一次请求、回固定 200/body。
        let server = bind_direct(SecretKey::generate())
            .await
            .expect("本地 QUIC 服务端");
        let port = ipv4_port(&server);
        let node_hex = server.node_id_hex();
        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel();
        let server_task = tokio::spawn(async move {
            let Some(incoming) = server.accept().await else {
                panic!("端点已关，接不到连接");
            };
            let conn = incoming.await.expect("QUIC 握手");
            let (mut send, mut recv) = conn.accept_bi().await.expect("接流");
            let req = read_request(&mut recv).await.expect("读请求");
            let target = req.target.clone();
            write_reply(
                &mut send,
                &TunnelReply {
                    status: 200,
                    body: b"QUIC-ONLY-RESPONSE".to_vec(),
                },
            )
            .await
            .expect("写应答");
            send.finish().expect("收流");
            let _ = seen_tx.send(target);
            // 客户端连接由全局 Registry 缓存；这里等它关（测试收尾会 abort 本任务）。
            let _ = conn.closed().await;
        });

        // b) peer.base 不可达 ⇒ HTTP fallback 若被走到只会失败。
        let peer = crate::mesh::MeshPeer {
            device_id: "dev-e2e".to_string(),
            base: "http://127.0.0.1:1".to_string(),
            quic_addrs: vec![format!("127.0.0.1:{port}")],
            node_id: node_hex,
        };

        // c) 走生产入口 `endpoint_for_peer`（不是直接 new QuicMeshEndpoint）。
        let ep = endpoint_for_peer(&peer, reqwest::Client::new())
            .await
            .expect("原料齐全 ⇒ 必须构造出 QUIC 复合端点");
        let reply = tokio::time::timeout(
            Duration::from_secs(30),
            ep.get("/mesh/manifest?space_id=e2e", None, None),
        )
        .await
        .expect("30 秒内必须完成（同机 QUIC）")
        .expect("HTTP fallback 不可达 ⇒ 成功只能来自 QUIC");
        assert_eq!(reply.status, 200, "状态来自 QUIC 服务端");
        assert_eq!(
            reply.body, "QUIC-ONLY-RESPONSE",
            "正文只可能是 QUIC 服务端返回的那一份"
        );
        assert_eq!(
            seen_rx.await.expect("服务端必须收到请求"),
            "/mesh/manifest?space_id=e2e",
            "服务端看到的 target 必须原样"
        );
        server_task.abort();
    }

    /// ⭐ 全局 Registry 的**共享性**核对：两次调用必须是**同一个** Arc（`OnceCell` 一进程一份）。
    /// 这既是生产语义（一进程一端点），也是"测试会不会互相污染"的关键事实：共享的是**端点**，
    /// 连接缓存按**对端 node id** 分键 ⇒ 不同测试用不同服务端身份时互不串用。
    #[tokio::test]
    async fn the_process_registry_is_a_shared_singleton() {
        crate::db::ensure_test_app_data_dir();
        let a = crate::lan_quic::process_registry()
            .await
            .expect("进程级 Registry 必须能懒初始化");
        let b = crate::lan_quic::process_registry()
            .await
            .expect("第二次调用必须成功");
        assert!(
            Arc::ptr_eq(&a, &b),
            "process_registry 必须是同一份 Arc（否则每次挑传输都新起端点）"
        );
    }
}
