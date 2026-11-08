//! ⭐ **P3-2a 第二小步（2026-11-08）**：**无中继 QUIC 直连端点骨架**。
//!
//! ## 这个模块挡什么 / 做什么
//!
//! P3 的目标是「一台设备一个 QUIC/iroh 端点」：LAN 直连、手动地址、私有中继**共用**它
//! （ADR `docs/plans/2026-11-08-personal-sync-2.0-p3-adr.md` §3.3）。本文件是**第一块骨头**：
//! 只把「**无中继**起一个端点 ＋ 拿到 node_id / 本地 UDP 地址 / 连向对端」做成独立、可测的一层。
//!
//! ## 今天**不**做什么（如实划界）
//!
//! * ⛔ **不接同步轮次**：`mesh` / `sync` 一条调用都没有（挑路仍是老路）；
//! * ⛔ **不消费 `LanAnnounce.quic_addrs`**（上一笔只把它透传到读数/契约）；
//! * ⛔ 不建常驻注册表（`EndpointRegistry`）、不做连接缓存/重试预算 —— 那是 P3-2 后续；
//! * ⛔ 不碰 relay：本模块**只用** iroh 的 `Minimal` 预设（⛔ 不配中继、⛔ 不配发现 ⇒ 只走直连地址）；
//! * ⛔ 不改默认构建 / relay 构建的现有行为：整份模块只在 `--features lan-quic` 下编译。
//!
//! ## 与 `relay_tunnel::iroh_tunnel` 的关系
//!
//! P3-2a 第一步把 `iroh_tunnel` 从 `relay` 放宽到 `lan-quic`，并把 relay 专属的
//! `bind_with_relay*` 继续锁在 `relay` 下 ⇒ 本模块**复用**其中的无中继绑定
//! [`crate::relay_tunnel::iroh_tunnel::bind_direct`] 与帧搬运（`request`/`serve_one_conn`），
//! ⛔ 不另写一套 QUIC 协议 ✗（同一份 ALPN、同一套帧）。
//!
//! ## 判据
//!
//! `lan_quic::tests`：同机两个端点**经环回直连**交换一次最小请求/应答（证明无中继可连），
//! 以及 node_id/本地 UDP 地址的暴露形状。跑法：
//!
//! ```text
//! cargo test --manifest-path src-tauri/Cargo.toml --lib --features lan-quic lan_quic
//! ```
use std::net::SocketAddr;

use iroh::{Endpoint, EndpointAddr, PublicKey, SecretKey};

use crate::relay_tunnel::{iroh_tunnel, TunnelReply, TunnelRequest};

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
}
