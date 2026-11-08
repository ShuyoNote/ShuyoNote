//! ⭐ **P3-2a（2026-11-08）**：**无中继 QUIC 直连端点 ＋ 一进程一端点/按对端连接复用骨架**。
//!
//! ## 这个模块挡什么 / 做什么
//!
//! P3 的目标是「一台设备一个 QUIC/iroh 端点」：LAN 直连、手动地址、私有中继**共用**它
//! （ADR `docs/plans/2026-11-08-personal-sync-2.0-p3-adr.md` §3.3）。本文件到今天做了三小步：
//! 1. **无中继端点**（`LanQuicEndpoint`：node_id / 本地 UDP 地址 / connect）；
//! 2. **一进程一端点 ＋ 每对端连接缓存**（[`LanQuicRegistry`]：同 peer 连续/并发请求只 connect 一次，
//!    关闭/出错时从缓存移除并允许下次重连）；
//! 3. 全部只在 `--features lan-quic` 下编译。
//!
//! ## 今天**不**做什么（如实划界）
//!
//! * ⛔ **不接同步轮次**：`mesh` / `sync` 一条调用都没有（挑路仍是老路）；
//! * ⛔ **不消费 `LanAnnounce.quic_addrs`**（上一笔只把它透传到读数/契约）；
//! * ⛔ 不做**重试预算**（整轮/单对端）与空闲超时驱逐：骨架层只有"LRU 永不驱逐 + 出错即移除"；
//! * ⛔ 不做**进程级全局单例**：`LanQuicRegistry` 由调用方持有（一进程一个由接线方保证；
//!   ⛔ 不在这里放 `static OnceLock` —— 那会让测试互相污染）；
//! * ⛔ 不碰 relay：本模块**只用** iroh 的 `Minimal` 预设（⛔ 不配中继、⛔ 不配发现 ⇒ 只走直连地址）；
//! * ⛔ 不改默认构建 / relay 构建的现有行为：整份模块只在 `--features lan-quic` 下编译。
//!
//! ## 与 `relay_tunnel::iroh_tunnel` 的关系
//!
//! P3-2a 第一步把 `iroh_tunnel` 从 `relay` 放宽到 `lan-quic`，并把 relay 专属的
//! `bind_with_relay*` 继续锁在 `relay` 下 ⇒ 本模块**复用**其中的无中继绑定
//! [`crate::relay_tunnel::iroh_tunnel::bind_direct`] 与帧搬运
//! （`read_request`/`write_reply`/`read_reply`/`write_request`），
//! ⛔ 不另写一套 QUIC 协议 ✗（同一份 ALPN、同一套帧）。
//!
//! ## 判据
//!
//! `lan_quic::tests`（`--features lan-quic`）：
//! * 同机两个端点环回直连，跑通一次请求/应答（证明无中继可连）；
//! * **同 peer 10 次 request ⇒ `connect_attempts()==1`**、10 次都成功（连接复用）；
//! * **并发 8 次同 peer ⇒ `connect_attempts()==1`、只有 1 条缓存连接**；
//! * 关闭（`evict`/服务端断连）后下一次 request **重连成功**、`connect_attempts()` 增加；
//! * `connection_count()` 在关闭/出错后回到 0（下一条请求才重新建链）。
//!
//! ```text
//! cargo test --manifest-path src-tauri/Cargo.toml --lib --features lan-quic lan_quic
//! ```
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use iroh::endpoint::Connection;
use iroh::{Endpoint, EndpointAddr, PublicKey, SecretKey};

use crate::relay_tunnel::{
    iroh_tunnel, read_reply, read_request, write_reply, write_request, TunnelReply, TunnelRequest,
};

/// 一个**无中继**的 QUIC/iroh 端点（持有 iroh `Endpoint` 本体）。
///
/// ⚠️ 它**只是骨架**：没有连接缓存、没有注册表、没有重试预算；每次 `connect` 直接问 iroh。
/// 生命周期归调用方（测试里用完 `close()`；P3-2 接线时归常驻 Sync Core）。
pub struct LanQuicEndpoint {
    ep: Endpoint,
}

impl LanQuicEndpoint {
    /// 本机 node id（iroh 公钥）。P3-2 把它写进公告/路线表时用它。
    pub fn node_id(&self) -> PublicKey {
        self.ep.id()
    }

    /// 本机 node id 的 **64 位小写 hex** —— 与公告 `quic_addrs`/路线表 `node_id` 同一口径
    /// （P3-0b 的 `LanAnnounce.quic_addrs` 消费方将来要能直接对上 ✓）。
    pub fn node_id_hex(&self) -> String {
        hex32(self.ep.id().as_bytes())
    }

    /// 本机已绑定的 UDP 地址（iroh 可能同时绑 IPv4/IPv6 通配；端口是实际端口 ✓）。
    ///
    /// ⚠️ 元素可能是 `0.0.0.0:<port>` —— **那不是"对端能用的地址"**：P3-2 把它填进公告时
    /// 要按本机可达网卡枚举（ADR §3.4）；本笔只**如实暴露**，⛔ 不替它猜 ✗。
    pub fn local_addrs(&self) -> Vec<SocketAddr> {
        self.ep.bound_sockets()
    }

    /// 连向对端（单条 QUIC 连接；ALPN 与现有隧道一致）。
    ///
    /// ⚠️ **不重试**（骨架层只有单次尝试；重试预算是 P3-2 的事 —— 现有的
    /// `iroh_tunnel::request` 仍带它自己的 3×20s 重试，本方法不替代它）。
    pub async fn connect(&self, peer: EndpointAddr) -> Result<iroh::endpoint::Connection, String> {
        self.ep
            .connect(peer, iroh_tunnel::ALPN)
            .await
            .map_err(|e| format!("无中继 QUIC 连接失败：{e}"))
    }

    /// 接一条入站连接（`None` ＝ 端点已关）。与 iroh 的 `accept` 同形，骨架层不做额外包装。
    pub async fn accept(&self) -> Option<iroh::endpoint::Incoming> {
        self.ep.accept().await
    }

    /// 走**现有隧道帧协议**发一次请求（复用 `iroh_tunnel::request`，⛔ 不另写一套 ✗）。
    ///
    /// 用途：P3-2 之前先让"端到端一次请求"可测；正式接线仍走 `mesh_endpoint::Endpoint` 那条。
    pub async fn request(
        &self,
        peer: EndpointAddr,
        req: &TunnelRequest,
    ) -> Result<TunnelReply, String> {
        iroh_tunnel::request(&self.ep, peer, req).await
    }

    /// 关掉端点（释放 UDP 端口）。测试收尾用；生产接线后由生命周期所有者调用。
    pub async fn close(&self) {
        self.ep.close().await;
    }
}

/// ⭐ 起一个**无中继**端点（`Minimal` 预设；⛔ 不配中继、⛔ 不配发现 ⇒ 只走直连地址）。
///
/// `secret` 从调用方来：**身份稳定**是 P3-2 的事（公告里的 node id 必须稳定）；
/// 本笔只接注入的钥匙（测试用 `SecretKey::generate()`，生产接线时由 device identity 派生）。
pub async fn bind_direct(secret: SecretKey) -> Result<LanQuicEndpoint, String> {
    bind_direct_on_port(secret, None).await
}

/// 同 [`bind_direct`]，但可**固定 UDP 端口**（`None` ＝ 随机；端口被占 ⇒ 如实报错，⛔ 不静默退回 ✗）。
pub async fn bind_direct_on_port(
    secret: SecretKey,
    udp_port: Option<u16>,
) -> Result<LanQuicEndpoint, String> {
    let ep = iroh_tunnel::bind_direct(secret, udp_port).await?;
    Ok(LanQuicEndpoint { ep })
}

/// ⭐⭐ **一进程一端点 ＋ 每对端连接缓存**（P3-2a 第三小步的骨架）。
///
/// ## 连接复用语义（本笔的判据就是它）
/// * **键 = 对端 node id**（[`PublicKey`]，来自 `EndpointAddr.id`）—— 同一台设备不管这次给了哪些
///   直连地址，都复用同一条连接 ✓；
/// * 命中缓存 ⇒ **直接复用**（不 connect、不重新握手）；
/// * 未命中 ⇒ **全局串行** connect（骨架层用一把 `tokio::sync::Mutex` 当"连接闸"）——
///   并发同 peer 请求只会有一条真正去 `connect` ✓；代价是**不同 peer 也排队**（P3-2 可换 per-peer
///   `OnceCell`/信号量；这里优先"简单且判据可复现"）；
/// * 请求失败（连接已关/写读出错）⇒ 从缓存**移除**并关掉那条连接 ⇒ 下一次请求自动重连 ✓；
/// * 空闲驱逐/重试预算**不在本笔**（见模块头）。
///
/// ⚠️ 生命周期：由调用方持有（⛔ 本模块不做 `static` 单例 —— 一进程一个由接线方保证）。
pub struct LanQuicRegistry {
    endpoint: Arc<LanQuicEndpoint>,
    conns: Mutex<HashMap<PublicKey, Arc<Connection>>>,
    /// 连接闸：**唯一一个**在"缓存未命中"时批量建链的入口（拿它期间不再查一次缓存）。
    connect_gate: tokio::sync::Mutex<()>,
    connect_attempts: AtomicUsize,
}

impl LanQuicRegistry {
    /// 用一把注入的身份起一个新注册表（内部 `bind_direct` 一个无中继端点）。
    pub async fn new(secret: SecretKey) -> Result<Self, String> {
        Ok(Self::from_endpoint(Arc::new(bind_direct(secret).await?)))
    }

    /// 用一个**已有**端点构造（便于调用方集中管理端点生命周期）。
    pub fn from_endpoint(endpoint: Arc<LanQuicEndpoint>) -> Self {
        Self {
            endpoint,
            conns: Mutex::new(HashMap::new()),
            connect_gate: tokio::sync::Mutex::new(()),
            connect_attempts: AtomicUsize::new(0),
        }
    }

    /// 端点本体（node_id/本地地址/accept 等仍从它取）。
    ///
    /// ⚠️ 今天本模块内没有非测试调用者（接收入站/公告地址是 P3-2 的活）⇒ 暂时显式 allow，
    /// 免得在 `cargo check --features lan-quic` 里多出一条"新写的死代码"噪音。
    #[allow(dead_code)]
    pub fn endpoint(&self) -> &Arc<LanQuicEndpoint> {
        &self.endpoint
    }

    /// 当前缓存里有几条连接（**读数，测试用**）。
    pub fn connection_count(&self) -> usize {
        self.conns.lock().map(|m| m.len()).unwrap_or(0)
    }

    /// 真正发起过几次 `connect`（**读数，测试用**；命中缓存不增加）。
    pub fn connect_attempts(&self) -> usize {
        self.connect_attempts.load(Ordering::Relaxed)
    }

    /// 取该 peer 的缓存连接；没有就建一条并放进缓存。
    ///
    /// ⚠️ 同 peer 并发调用时：只有**第一个**拿到连接闸的会真正 `connect`，其余在闸后重新查缓存
    /// ⇒ 只建 1 条（判据 `concurrent_requests_share_one_connection`）。
    pub async fn get_or_connect(&self, peer: EndpointAddr) -> Result<Arc<Connection>, String> {
        let key = peer.id;
        if let Some(c) = self.cached(key) {
            return Ok(c);
        }
        // 连接闸：拿住它再查一次 ⇒ 并发同 peer 只 connect 一次（骨架层的简单实现）。
        let _gate = self.connect_gate.lock().await;
        if let Some(c) = self.cached(key) {
            return Ok(c);
        }
        self.connect_attempts.fetch_add(1, Ordering::Relaxed);
        let conn = self.endpoint.connect(peer).await?;
        let arc = Arc::new(conn);
        self.conns
            .lock()
            .map_err(|_| "连接缓存的锁被毒掉了".to_string())?
            .insert(key, Arc::clone(&arc));
        Ok(arc)
    }

    /// 走缓存连接发一次请求（复用同一条 QUIC 连接，每次请求各开一条双向流）。
    ///
    /// ⚠️ 失败 ⇒ **移除缓存并关连接**，再把错误原样返回（下一次调用会自动重连 ✓）。
    pub async fn request(
        &self,
        peer: EndpointAddr,
        req: &TunnelRequest,
    ) -> Result<TunnelReply, String> {
        let key = peer.id;
        let conn = self.get_or_connect(peer).await?;
        match request_on_conn(&conn, req).await {
            Ok(reply) => Ok(reply),
            Err(e) => {
                self.evict_if_same(key, &conn);
                Err(e)
            }
        }
    }

    /// **强制**关掉某对端的缓存连接（下次请求会重连）。返回"原本在不在缓存里"。
    pub async fn evict(&self, peer: PublicKey) -> bool {
        let removed = self.conns.lock().ok().and_then(|mut m| m.remove(&peer));
        match removed {
            Some(c) => {
                c.close(0u32.into(), b"evicted");
                true
            }
            None => false,
        }
    }

    /// 关掉注册表：缓存里每条连接都关掉，再关端点（释放 UDP 端口）。
    pub async fn close(&self) {
        let drained: Vec<Arc<Connection>> = self
            .conns
            .lock()
            .map(|mut m| m.drain().map(|(_, c)| c).collect())
            .unwrap_or_default();
        for c in drained {
            c.close(0u32.into(), b"registry-close");
        }
        self.endpoint.close().await;
    }

    fn cached(&self, key: PublicKey) -> Option<Arc<Connection>> {
        self.conns.lock().ok().and_then(|m| m.get(&key).cloned())
    }

    /// 只有命中的仍是**同一条**连接时才移除（避免把并发中别人刚建的新连接误删）。
    fn evict_if_same(&self, key: PublicKey, conn: &Arc<Connection>) {
        if let Ok(mut m) = self.conns.lock() {
            let same = m.get(&key).map(|c| Arc::ptr_eq(c, conn)).unwrap_or(false);
            if same {
                m.remove(&key);
            }
        }
        conn.close(0u32.into(), b"request-failed");
    }
}

/// 在**一条已建立的连接**上跑一次隧道帧请求（⛔ 不建连接、不重试 —— 那是 registry/上层的活）。
///
/// ⚠️ 每条请求开一条新的双向流（同一条 QUIC 连接可并发多流 ✓），并且**不关整条连接**
/// （关了就没法复用；关连接只发生在错误/驱逐时）。
async fn request_on_conn(conn: &Connection, req: &TunnelRequest) -> Result<TunnelReply, String> {
    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|e| format!("开流失败（连接可能已关）：{e}"))?;
    write_request(&mut send, req)
        .await
        .map_err(|e| format!("写请求失败：{e}"))?;
    let reply = read_reply(&mut recv)
        .await
        .map_err(|e| format!("读回应失败：{e}"))?;
    Ok(reply)
}

/// 32 字节 → 64 位小写 hex（与公告/路线表的 `node_id` 同一形状；不引新依赖）。
fn hex32(b: &[u8; 32]) -> String {
    let mut s = String::with_capacity(64);
    for byte in b {
        use std::fmt::Write as _;
        let _ = write!(s, "{byte:02x}");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// 取服务端点**已绑定端口**里的 IPv4 那个（IPv6 通配的端口也一样，但回环 IPv4 最稳）。
    fn ipv4_port(ep: &LanQuicEndpoint) -> u16 {
        ep.local_addrs()
            .iter()
            .find_map(|s| match s {
                SocketAddr::V4(v4) if v4.port() != 0 => Some(v4.port()),
                _ => None,
            })
            .expect("端点必须至少绑上一个 IPv4 端口")
    }

    /// 环回直连地址（⚠️ 不用 `ep.addr()`：那可能是 `0.0.0.0`，本机判据要可复现 ✓）。
    fn loopback_addr(ep: &LanQuicEndpoint, port: u16) -> EndpointAddr {
        EndpointAddr {
            id: ep.node_id(),
            addrs: [iroh::TransportAddr::Ip(SocketAddr::from((
                [127, 0, 0, 1],
                port,
            )))]
            .into_iter()
            .collect(),
        }
    }

    /// ⭐⭐ **P3-2a 第二小步的核心判据**：同一台机器两个**无中继**端点，经 QUIC 直连跑通一次
    /// 最小请求/应答 —— 证明"不挂 relay 也能连"（ADR §3.2 的 `lan-quic` 语义）。
    ///
    /// ⚠️ 只走直连地址（`Minimal`：不配中继/发现）⇒ 离线可跑、进 CI 不需要网络 ✓。
    /// ⛔ 它**不**证明"经公网跨网能通" —— 那要真机/真中继，留给 P3-2 验收。
    #[tokio::test]
    async fn two_direct_endpoints_move_one_request_on_loopback() {
        let server = bind_direct(SecretKey::generate())
            .await
            .expect("服务端无中继端点");
        let client = bind_direct(SecretKey::generate())
            .await
            .expect("客户端无中继端点");
        let peer = loopback_addr(&server, ipv4_port(&server));

        let serve = tokio::spawn(async move {
            let Some(incoming) = server.accept().await else {
                panic!("端点已关，接不到连接");
            };
            let conn = incoming.await.expect("QUIC 握手");
            // 复用**同一套隧道帧**（⛔ 不另写协议 ✗）：读到原样请求 → 回一句可核对的话。
            iroh_tunnel::serve_one_conn(conn, |req| TunnelReply {
                status: 200,
                body: format!("回你：{}", req.target).into_bytes(),
            })
            .await
            .expect("服务一次");
        });

        let reply = tokio::time::timeout(
            Duration::from_secs(30),
            client.request(
                peer,
                &TunnelRequest::new("GET", "/mesh/manifest?space_id=x"),
            ),
        )
        .await
        .expect("30 秒内必须连上（同机环回）")
        .expect("无中继直连必须能跑通一次请求");
        assert_eq!(reply.status, 200);
        assert_eq!(
            String::from_utf8(reply.body).expect("应答正文是 UTF-8"),
            "回你：/mesh/manifest?space_id=x",
            "对端 handler 必须看到**原样 target**"
        );

        client.close().await;
        serve.await.expect("服务任务不应 panic");
    }

    /// ⭐ 骨架层的**暴露形状**：node_id（hex 64 位）＋ 本地 UDP 地址（至少一个真端口）。
    /// ⚠️ `local_addrs()` 里出现 `0.0.0.0` 是正常的（绑定通配）—— 本判据只要求"端口是真的"。
    #[tokio::test]
    async fn node_id_and_local_udp_addrs_are_exposed() {
        let ep = bind_direct(SecretKey::generate()).await.expect("端点");
        let hex = ep.node_id_hex();
        assert_eq!(hex.len(), 64, "node_id 必须是 64 位 hex：{hex}");
        assert!(
            hex.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "node_id 必须是**小写** hex：{hex}"
        );
        let port = ipv4_port(&ep);
        assert!(port != 0, "本地 UDP 端口不能是 0");
        // 固定端口这条口也要能走（`bind_direct_on_port`）：绑一个真实的空闲端口再核对。
        let probe = std::net::UdpSocket::bind("127.0.0.1:0").expect("找一个空闲端口");
        let want = probe.local_addr().expect("probe addr").port();
        drop(probe);
        let fixed = bind_direct_on_port(SecretKey::generate(), Some(want))
            .await
            .expect("固定端口绑定");
        assert!(
            fixed.local_addrs().iter().any(|s| s.port() == want),
            "固定端口必须真的绑上 {want}：{:?}",
            fixed.local_addrs()
        );
        fixed.close().await;
        ep.close().await;
    }

    /// 服务端：在**同一条连接**上连续接 `n` 条双向流，各回一句；返回收到的 target 列表。
    ///
    /// 判据要的"复用同一条连接"全靠这个形状：服务端**只 accept 一次连接**，多流从 `accept_bi` 来。
    async fn serve_streams(conn: &Connection, n: usize) -> Vec<String> {
        let mut seen = Vec::with_capacity(n);
        for _ in 0..n {
            let (mut send, mut recv) = conn.accept_bi().await.expect("接流");
            let req = read_request(&mut recv).await.expect("读请求");
            seen.push(req.target.clone());
            write_reply(
                &mut send,
                &TunnelReply {
                    status: 200,
                    body: format!("回你：{}", req.target).into_bytes(),
                },
            )
            .await
            .expect("写回应");
            send.finish().expect("收流");
        }
        seen
    }

    /// 服务端收尾：等客户端关掉这条连接（等价 `serve_one_conn` 里的 `conn.closed().await`）。
    /// ⚠️ **不要**在写完应答后立刻 `conn.close`：最后一条应答可能还在途（实测会得到
    /// "connection lost"）—— 连接由客户端关，服务端只等。
    async fn wait_closed(conn: &Connection) {
        let _ = conn.closed().await;
    }

    /// ⭐⭐ **连接复用判据 ①**：同一 peer 连续 10 次 request ⇒ **只 connect 1 次**、10 次都成功。
    #[tokio::test]
    async fn ten_requests_on_one_peer_connect_once() {
        let server = bind_direct(SecretKey::generate())
            .await
            .expect("服务端端点");
        let peer = loopback_addr(&server, ipv4_port(&server));
        let serve = tokio::spawn(async move {
            let Some(incoming) = server.accept().await else {
                panic!("端点已关，接不到连接");
            };
            let conn = incoming.await.expect("QUIC 握手");
            let seen = serve_streams(&conn, 10).await;
            wait_closed(&conn).await;
            seen
        });

        let registry = LanQuicRegistry::new(SecretKey::generate())
            .await
            .expect("注册表");
        let mut bodies = Vec::new();
        for i in 0..10 {
            let req = TunnelRequest::new("GET", &format!("/x/{i}"));
            let reply = tokio::time::timeout(
                Duration::from_secs(30),
                registry.request(peer.clone(), &req),
            )
            .await
            .expect("30 秒内必须完成（同机环回）")
            .expect("10 次请求都必须成功");
            assert_eq!(reply.status, 200);
            bodies.push(String::from_utf8(reply.body).expect("应答正文是 UTF-8"));
        }
        assert_eq!(
            registry.connect_attempts(),
            1,
            "同一 peer 连续 10 次 request 只该 connect 一次（缓存复用）"
        );
        assert_eq!(registry.connection_count(), 1, "缓存里应当只有 1 条连接");
        assert_eq!(
            bodies,
            (0..10).map(|i| format!("回你：/x/{i}")).collect::<Vec<_>>(),
            "10 次应答都要逐字对上（⛔ 不是同一条流被复用成错位）"
        );
        registry.close().await;
        let seen = serve.await.expect("服务任务不应 panic");
        assert_eq!(seen.len(), 10, "服务端必须真的接到 10 条流：{seen:?}");
    }

    /// ⭐⭐ **连接复用判据 ②**：**并发 8 次**同 peer request ⇒ 仍只 connect 1 次、只 1 条缓存连接。
    #[tokio::test]
    async fn concurrent_requests_share_one_connection() {
        const N: usize = 8;
        let server = bind_direct(SecretKey::generate())
            .await
            .expect("服务端端点");
        let peer = loopback_addr(&server, ipv4_port(&server));
        let serve = tokio::spawn(async move {
            let Some(incoming) = server.accept().await else {
                panic!("端点已关，接不到连接");
            };
            let conn = incoming.await.expect("QUIC 握手");
            let seen = serve_streams(&conn, N).await;
            wait_closed(&conn).await;
            seen
        });

        let registry = LanQuicRegistry::new(SecretKey::generate())
            .await
            .expect("注册表");
        let futs = (0..N).map(|i| {
            let peer = peer.clone();
            let registry = &registry;
            async move {
                let req = TunnelRequest::new("GET", &format!("/c/{i}"));
                tokio::time::timeout(Duration::from_secs(30), registry.request(peer, &req))
                    .await
                    .expect("30 秒内必须完成")
            }
        });
        let results = futures_util::future::join_all(futs).await;
        for r in results {
            let reply = r.expect("并发 8 次都必须成功");
            assert_eq!(reply.status, 200);
        }
        assert_eq!(
            registry.connect_attempts(),
            1,
            "并发同 peer 只该有 1 次真正 connect（连接闸 + 二次查缓存）"
        );
        assert_eq!(registry.connection_count(), 1, "缓存里应当只有 1 条连接");
        registry.close().await;
        let seen = serve.await.expect("服务任务不应 panic");
        assert_eq!(seen.len(), N, "服务端必须真的接到 N 条流：{seen:?}");
    }

    /// ⭐⭐ **连接复用判据 ③**：**关闭后能重连** —— `evict` 关掉缓存连接后，下一次 request
    /// 必须重新 connect（`connect_attempts` +1）并成功。
    #[tokio::test]
    async fn an_evicted_connection_is_reconnected() {
        let server = bind_direct(SecretKey::generate())
            .await
            .expect("服务端端点");
        let peer = loopback_addr(&server, ipv4_port(&server));
        let serve = tokio::spawn(async move {
            let mut seen = Vec::new();
            // 两轮：每轮接**一条新连接**、各服务 1 条流。
            for _ in 0..2 {
                let Some(incoming) = server.accept().await else {
                    panic!("端点已关，接不到连接");
                };
                let conn = incoming.await.expect("QUIC 握手");
                seen.extend(serve_streams(&conn, 1).await);
                wait_closed(&conn).await;
            }
            seen
        });

        let registry = LanQuicRegistry::new(SecretKey::generate())
            .await
            .expect("注册表");
        let req1 = TunnelRequest::new("GET", "/first");
        registry
            .request(peer.clone(), &req1)
            .await
            .expect("第一次请求");
        assert_eq!(registry.connect_attempts(), 1);
        assert_eq!(registry.connection_count(), 1);

        assert!(registry.evict(peer.id).await, "evict 应确实移除了缓存连接");
        assert_eq!(registry.connection_count(), 0, "关闭后缓存应为空");

        let req2 = TunnelRequest::new("GET", "/second");
        tokio::time::timeout(
            Duration::from_secs(30),
            registry.request(peer.clone(), &req2),
        )
        .await
        .expect("重连要在 30 秒内完成")
        .expect("关闭后下一次请求必须重连成功");
        assert_eq!(
            registry.connect_attempts(),
            2,
            "关闭后必须重新 connect（计数 +1）"
        );
        registry.close().await;
        let seen = serve.await.expect("服务任务不应 panic");
        assert_eq!(seen, vec!["/first".to_string(), "/second".to_string()]);
    }

    /// ⭐ **连接复用判据 ④**：请求失败 ⇒ 坏连接必须**移出缓存**（`connection_count()` 回 0），
    /// 不是留着一个"看起来还在"的死连接。
    ///
    /// 构造方式（确定性，不靠关闭时序竞态）：服务端**接流但不应答**（读到请求后直接丢流）
    /// ⇒ 客户端 `read_reply` 立刻得到"对端没说完"的错 ⇒ registry 走"失败即移除"那条路。
    #[tokio::test]
    async fn a_failed_request_drops_the_cached_connection() {
        let server = bind_direct(SecretKey::generate())
            .await
            .expect("服务端端点");
        let peer = loopback_addr(&server, ipv4_port(&server));
        let serve = tokio::spawn(async move {
            let Some(incoming) = server.accept().await else {
                panic!("端点已关，接不到连接");
            };
            let conn = incoming.await.expect("QUIC 握手");
            // 接一条流、把请求读完，然后**不回应**（drop 掉发送端 ⇒ 客户端读到 EOF/半帧）。
            let (send, mut recv) = conn.accept_bi().await.expect("接流");
            let _ = read_request(&mut recv).await.expect("读请求");
            drop(send);
            wait_closed(&conn).await;
        });

        let registry = LanQuicRegistry::new(SecretKey::generate())
            .await
            .expect("注册表");
        let req = TunnelRequest::new("GET", "/will-fail");
        let err = tokio::time::timeout(
            Duration::from_secs(10),
            registry.request(peer.clone(), &req),
        )
        .await
        .expect("10 秒内必须有结论（骨架是单次尝试，不许无限等）")
        .expect_err("服务端不应答 ⇒ 这次请求必须如实失败");
        assert!(
            err.contains("读回应失败") || err.contains("对端"),
            "错误要能说清是读回应这一步：{err}"
        );
        assert_eq!(
            registry.connection_count(),
            0,
            "请求失败后必须把坏连接移出缓存（connection_count 回 0）"
        );
        registry.close().await;
        serve.await.expect("服务任务不应 panic");
    }
}
