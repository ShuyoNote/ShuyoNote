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
// ⚠️ **骨架阶段的显式例外**：本模块到 P3-2a 第四小步为止**只被测试调用**（`mesh`/`sync` 还没接线）
// ⇒ 端点/注册表/解析/选路这些 `pub` 项在非测试构建里全是"死代码"。等 P3-2 真接线后，
// **请删掉这一行**并按真实使用收窄（⛔ 别让它永久静默掉真正写坏的死代码）。
#![allow(dead_code)]

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use iroh::endpoint::Connection;
use iroh::{Endpoint, EndpointAddr, PublicKey, SecretKey};

use crate::relay_tunnel::{iroh_tunnel, read_reply, write_request, TunnelReply, TunnelRequest};

/// 一个**无中继**的 QUIC/iroh 端点（持有 iroh `Endpoint` 本体）。
///
/// ⚠️ 它**只是骨架**：**本类型不做连接缓存**（缓存/复用归 [`LanQuicRegistry`]），也没有重试预算；
/// 每次 `connect` 直接问 iroh。生命周期归调用方（测试里用完 `close()`；P3-2 接线时归常驻 Sync Core）。
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
        let peer_id = peer.id;
        let started = std::time::Instant::now();
        // ⭐ 2026-11-11（真机：偶发一条 30s 长尾，原因逐字 `无中继 QUIC 连接失败：timed out`）：
        //   iroh 直连的默认超时是 30s ⇒ 这里加 **6s 上限**，超时立刻回退 HTTP（⛔ 不再拖满 30s）。
        let out =
            match tokio::time::timeout(CONNECT_TIMEOUT, self.ep.connect(peer, iroh_tunnel::ALPN))
                .await
            {
                Ok(r) => r,
                Err(_) => {
                    if std::env::var_os("SHUYONOTE_LAN_DEBUG_QUIC").is_some() {
                        eprintln!(
                            "[quic-debug] connect TIMEOUT peer_id={peer_id} limit={}s",
                            CONNECT_TIMEOUT.as_secs()
                        );
                    }
                    return Err(format!(
                        "无中继 QUIC 连接失败：连接超时（{}s 上限）",
                        CONNECT_TIMEOUT.as_secs()
                    ));
                }
            };
        // ⭐ 2026-11-09（QUIC 真机排查开关，默认静默）：成功也要留一行 —— 否则"没有回退日志"
        //   与"根本没尝试 QUIC"分不开（真机复测时需要正证据）。
        if std::env::var_os("SHUYONOTE_LAN_DEBUG_QUIC").is_some() {
            let elapsed = started.elapsed().as_millis();
            match &out {
                Ok(_) => eprintln!("[quic-debug] connect OK peer_id={peer_id} elapsed={elapsed}ms"),
                Err(e) => {
                    eprintln!(
                        "[quic-debug] connect FAIL peer_id={peer_id} elapsed={elapsed}ms err={e}"
                    )
                }
            }
        }
        out.map_err(|e| format!("无中继 QUIC 连接失败：{e}"))
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
    /// ⭐ 2026-11-11：每条缓存连接**上次用到的时刻**（`db::now_ms`）—— 空闲超 TTL 就主动换新。
    last_used: Mutex<HashMap<PublicKey, i64>>,
    /// 连接闸：**唯一一个**在"缓存未命中"时批量建链的入口（拿它期间不再查一次缓存）。
    connect_gate: tokio::sync::Mutex<()>,
    connect_attempts: AtomicUsize,
}

/// ⭐ 2026-11-11（真机 3s 尾巴）：空闲超过这个时间就**主动重连**，不再复用可能已被对端关掉的连接。
/// 取值 60s：比一次同步轮（约 2 分钟）短，又能挡住"高频请求每次都重连"。
const IDLE_TTL_MS: i64 = 60_000;

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
            last_used: Mutex::new(HashMap::new()),
            connect_gate: tokio::sync::Mutex::new(()),
            connect_attempts: AtomicUsize::new(0),
        }
    }

    /// 端点本体（node_id/本地地址/accept 等仍从它取）。
    ///
    /// ⚠️ 今天本模块内没有非测试调用者（接收入站/公告地址是 P3-2 的活）⇒ 暂时显式 allow，
    /// 免得在 `cargo check --features lan-quic` 里多出一条"新写的死代码"噪音。
    /// ⏳ **2026-11-08 收据**：P3-2 接入站监听（`process_registry` 持端点 accept 循环）后删掉本 allow。
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
        if let Some(c) = self.cached_fresh(key).await {
            return Ok(c);
        }
        // 连接闸：拿住它再查一次 ⇒ 并发同 peer 只 connect 一次（骨架层的简单实现）。
        let _gate = self.connect_gate.lock().await;
        if let Some(c) = self.cached_fresh(key).await {
            return Ok(c);
        }
        self.connect_attempts.fetch_add(1, Ordering::Relaxed);
        // ⭐ 2026-11-09（第二层 QUIC 排查开关，默认静默）：把**这次真正要拨的 id/地址集**打出来 ——
        //   用来区分“对端公告已只剩单条 v4”与“本进程 peer 缓存里仍是旧的 172.x/IPv6”（后者会继续空等）。
        if std::env::var_os("SHUYONOTE_LAN_DEBUG_QUIC").is_some() {
            eprintln!(
                "[quic-debug] connect peer_id={} addrs={:?}",
                peer.id, peer.addrs
            );
        }
        let conn = self.endpoint.connect(peer).await?;
        let arc = Arc::new(conn);
        self.conns
            .lock()
            .map_err(|_| "连接缓存的锁被毒掉了".to_string())?
            .insert(key, Arc::clone(&arc));
        self.touch(key);
        Ok(arc)
    }

    /// 走缓存连接发一次请求（复用同一条 QUIC 连接，每次请求各开一条双向流）。
    ///
    /// ⭐ **2026-11-11（真机长尾 20s）**：缓存连接可能**已死**（对端重启/换网/空闲被关），
    /// 旧实现照样复用它、等满 20s 才驱逐 ⇒ 一轮 20s 长尾（真机 39 轮 >5s）。
    /// 现在：
    /// ① 命中缓存 ⇒ 先用 **3s** 短超时试；超时/失败 ⇒ **驱逐**；
    /// ② 再用**新连接**重试一次（全量 20s）；失败 ⇒ 驱逐并如实报错（组合器回退 HTTP）。
    /// ⚠️ 错误说明仍写清"是超时还是连接错误"（排障要看得出）。
    pub async fn request(
        &self,
        peer: EndpointAddr,
        req: &TunnelRequest,
    ) -> Result<TunnelReply, String> {
        let key = peer.id;
        if let Some(conn) = self.cached_fresh(key).await {
            let dbg = std::env::var_os("SHUYONOTE_LAN_DEBUG_QUIC").is_some();
            match tokio::time::timeout(CACHED_ATTEMPT_TIMEOUT, request_on_conn(&conn, req)).await {
                Ok(Ok(reply)) => {
                    self.touch(key);
                    return Ok(reply);
                }
                Ok(Err(e)) => {
                    if dbg {
                        eprintln!("[quic-debug] 缓存连接请求失败（立即换新）：{e}");
                    }
                    self.evict_if_same(key, &conn);
                }
                Err(_) => {
                    if dbg {
                        eprintln!(
                            "[quic-debug] 缓存连接请求超时（{}s，换新重试）",
                            CACHED_ATTEMPT_TIMEOUT.as_secs()
                        );
                    }
                    self.evict_if_same(key, &conn);
                }
            }
        }
        let conn = self.get_or_connect(peer).await?;
        match tokio::time::timeout(REQUEST_TIMEOUT, request_on_conn(&conn, req)).await {
            Ok(Ok(reply)) => {
                self.touch(key);
                Ok(reply)
            }
            Ok(Err(e)) => {
                self.evict_if_same(key, &conn);
                Err(e)
            }
            Err(_) => {
                self.evict_if_same(key, &conn);
                Err(format!(
                    "QUIC 请求超时（{}s，新连接也没通；已驱逐缓存，下一次会重连）",
                    REQUEST_TIMEOUT.as_secs()
                ))
            }
        }
    }

    /// **强制**关掉某对端的缓存连接（下次请求会重连）。返回"原本在不在缓存里"。
    pub async fn evict(&self, peer: PublicKey) -> bool {
        let removed = self.conns.lock().ok().and_then(|mut m| m.remove(&peer));
        if let Ok(mut m) = self.last_used.lock() {
            m.remove(&peer);
        }
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
        if let Ok(mut m) = self.last_used.lock() {
            m.clear();
        }
        for c in drained {
            c.close(0u32.into(), b"registry-close");
        }
        self.endpoint.close().await;
    }

    fn cached(&self, key: PublicKey) -> Option<Arc<Connection>> {
        self.conns.lock().ok().and_then(|m| m.get(&key).cloned())
    }

    /// ⭐ 2026-11-11：**空闲 TTL** —— 超过 [`IDLE_TTL_MS`] 没用的连接直接换新，
    /// ⛔ 不拿可能已被对端关掉的连接再赌一次 3s 超时（真机均摊 ~2.8s 的尾巴就是它）。
    async fn cached_fresh(&self, key: PublicKey) -> Option<Arc<Connection>> {
        let conn = self.cached(key)?;
        let now = crate::db::now_ms();
        let last = self
            .last_used
            .lock()
            .ok()
            .and_then(|m| m.get(&key).copied())
            .unwrap_or(0);
        if last > 0 && now.saturating_sub(last) <= IDLE_TTL_MS {
            return Some(conn);
        }
        self.evict(key).await;
        None
    }

    fn touch(&self, key: PublicKey) {
        if let Ok(mut m) = self.last_used.lock() {
            m.insert(key, crate::db::now_ms());
        }
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
///
/// ⭐ 2026-11-09：调用方 [`LanQuicRegistry::request`] 现在会给它套**超时** —— 缓存连接半死时
/// 不能无限等（否则后台轮永不结束）。本函数自身保持不超时（便于测试单独驱动）。
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// ⭐ 2026-11-11：**iroh 直连 connect** 的短上限 —— 默认 30s ⇒ 真机偶发一条 30s 长尾（原因逐字
/// `无中继 QUIC 连接失败：timed out`）；封顶 6s，超时立刻回退 HTTP。
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);
/// ⭐ 2026-11-11：**缓存连接**的短超时 —— 死连接最多拖 3s（旧实现一律等满 20s，真机长尾 39 轮 >5s）。
const CACHED_ATTEMPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

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

// ───────────────────── 进程级 Registry（P3-2a 最后接线；仅 lan-quic 非 relay） ─────────────────────

/// 进程级 Registry 的懒初始化槽（**一进程一份**）。
///
/// ⚠️ 为什么放在这里而不是 mesh_endpoint：Registry 归 `lan_quic` 所有，mesh_endpoint 只是
/// 一个使用方；`OnceCell` 保证"先到先得"，并发首次调用只会真正 bind 一次。
#[cfg(all(feature = "lan-quic", not(feature = "relay")))]
static PROCESS_REGISTRY: tokio::sync::OnceCell<Arc<LanQuicRegistry>> =
    tokio::sync::OnceCell::const_new();

/// 回落到**文件**身份（`device/identity.hex`）—— 仅当 DB 里还没建过设备身份时用
/// （那种老库/未走写路径的形态下，公告 `pubkey` 也是空 ⇒ 正常不会真的尝试 QUIC）。
#[cfg(all(feature = "lan-quic", not(feature = "relay")))]
fn file_identity_secret() -> Result<SecretKey, String> {
    let identity = crate::device_identity::load_default()
        .map_err(|e| format!("读不到本机设备身份（QUIC 端点身份要用它）：{e}"))?;
    Ok(SecretKey::from_bytes(&identity.seed_bytes()))
}

/// ⭐ **P3-2a 最后接线**：拿**进程级** Registry（首次调用时懒初始化，之后复用同一份）。
///
/// 身份取本机设备身份 seed（`device_identity::load_default()` → `SecretKey::from_bytes`）——
/// 这样公告里的 `pubkey` 与 iroh node id 同源（ADR §3.3）。
///
/// ⚠️ 初始化失败**只返回 Err**（调用方打一行日志后回退 HTTP；⛔ 不 panic、⛔ 不阻断默认路径）。
/// ⚠️ 只在 `all(feature="lan-quic", not(feature="relay"))` 下编：relay 构建仍走旧 HTTP/relay 路径。
#[cfg(all(feature = "lan-quic", not(feature = "relay")))]
pub async fn process_registry() -> Result<Arc<LanQuicRegistry>, String> {
    PROCESS_REGISTRY
        .get_or_try_init(|| async {
            // ⭐ 2026-11-09（真机：两侧 QUIC 都 timed out）：端点身份必须与**公告 pubkey 同源**。
            //   公告 pubkey 读 `meta.sync_state['device_identity_sk']`（`device_key`）；
            //   这里原先读**文件** `device/identity.hex`（`device_identity`）—— 两把不同的钥匙
            //   ⇒ iroh 的 TLS 校验拿 SNI 里的期望 id 比证书 SPKI 必然失败（两侧对称超时，与防火墙无关）。
            //   现在：优先用 DB 那把 seed（**只读**连接，⛔ 不写库）；DB 还没建身份 ⇒ 才回落文件身份。
            let secret = match crate::db::app_data_dir_ref() {
                Some(dir) => {
                    let conn = rusqlite::Connection::open_with_flags(
                        crate::db::meta_path(dir),
                        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                    )
                    .map_err(|e| format!("读不到 meta.db（QUIC 端点身份要用它）：{e}"))?;
                    match crate::device_key::seed_bytes_of(&conn)? {
                        Some(seed) => SecretKey::from_bytes(&seed),
                        None => file_identity_secret()?,
                    }
                }
                None => file_identity_secret()?,
            };
            let endpoint = bind_direct(secret)
                .await
                .map_err(|e| format!("起进程级无中继 QUIC 端点失败：{e}"))?;
            let registry = Arc::new(LanQuicRegistry::from_endpoint(Arc::new(endpoint)));
            // ⭐ 2026-11-09（QUIC 真机排查开关，默认静默）：先量"端点身份 vs 公告 pubkey 是否同源" ——
            //   这是区分「TLS 校验必败（立刻失败）」与「网络不通（30s 空等）」的第一道判据。
            //   只在 `SHUYONOTE_LAN_DEBUG_QUIC=1` 时打一行（不含任何私钥材料）。
            if std::env::var_os("SHUYONOTE_LAN_DEBUG_QUIC").is_some() {
                eprintln!("[quic-debug] node_id={}", registry.endpoint().node_id_hex());
            }
            Ok::<Arc<LanQuicRegistry>, String>(registry)
        })
        .await
        .cloned()
}

// ───────────────────── 公告用的本机 QUIC 地址（P3-2a 数据面最后一步） ─────────────────────

/// 纯函数：把「本机 IP 列表 ＋ 端点实际 UDP 端口」拼成**公告可发**的 `quic_addrs`。
///
/// 口径（消费侧 [`parse_quic_addrs`] 必须能解析）：
/// * 格式：`ip:port`；IPv6 由 `SocketAddr` 的 Display 自动加方括号（`[fe80::1]:47831`）；
/// * **排除回环 / unspecified**（`127.0.0.0/8`、`::1`、`0.0.0.0`、`::` —— 报了也只是噪音）；
/// * **排除 IPv6 link-local（fe80::/10）** —— `if-addrs` 不给 scope id，对端无法用（见 [`is_ipv6_link_local`]）；
/// * **IPv4 优先于 IPv6**（排序键第一维；上限截断时也先保 IPv4），IPv6 全局/ULA 保留；
/// * **去重保序**（同一 IP 只留一条；IPv6 等价写法由 `SocketAddr` 归一）；
/// * **上限 [`MAX_QUIC_ADDRS`] 条**（与解析侧同一个上限）；
/// * 端口 0 ⇒ **空表**（还没绑上，报一个没人算得出的端口没有意义）。
///
/// ⚠️ 它是纯函数 ⇒ 判据直接喂假 IP 就能钉住（不必真有网卡）。
pub fn announce_quic_addrs(local_ips: &[IpAddr], udp_port: u16) -> Vec<String> {
    // 兼容 wrapper：没有网卡名的旧调用点 ⇒ 用空名参与排序（虚拟/真实同档，行为与上一版一致）。
    let named: Vec<(String, IpAddr)> = local_ips.iter().map(|ip| (String::new(), *ip)).collect();
    announce_quic_addrs_named(&named, udp_port)
}

/// 同 [`announce_quic_addrs`]，但**带网卡名** ⇒ 同族内按 mesh 的 `lan_rank_key` 排序
/// （真实网卡在 WSL/Hyper-V/Docker/utun 等虚拟网卡前、link-local 靠后）。
///
/// 口径（与无名字版一致，只是排序更准）：
/// * **IPv4 全在 IPv6 前**（产品口径）；
/// * 同一地址族内按 [`crate::mesh::rank_named_addrs`] 的顺序（它复用 `lan_rank_key`）；
/// * 过滤 loopback / unspecified / IPv6 link-local（fe80::/10，无 scope id）；
/// * 去重、上限 [`MAX_QUIC_ADDRS`]、端口 0 ⇒ 空表 —— 全部不变。
pub fn announce_quic_addrs_named(local_addrs: &[(String, IpAddr)], udp_port: u16) -> Vec<String> {
    if udp_port == 0 {
        return Vec::new();
    }
    let filtered: Vec<(String, IpAddr)> = local_addrs
        .iter()
        // 2026-11-09 (real machine: both sides QUIC timeout, identity now proven equal):
        // virtual-adapter addresses must NOT be advertised -- their 172.x sorts BEFORE the real
        // 192.168.x inside `EndpointAddr.addrs` (BTreeSet) => both sides dial an unreachable
        // address first and time out symmetrically (measured 30s / 89.7s empty waits).
        .filter(|(name, ip)| {
            !crate::mesh::is_virtual_if_name(name)
                && !ip.is_loopback()
                && !ip.is_unspecified()
                && !is_ipv6_link_local(*ip)
        })
        .cloned()
        .collect();
    // mesh 已有的"真实网卡优先"排序（纯函数、只读；不改它的口径）。
    let ranked = crate::mesh::rank_named_addrs(&filtered);
    // IPv4 全部在前（保持各自在 ranked 里的相对顺序），随后才是 IPv6。
    let mut ips: Vec<IpAddr> = Vec::with_capacity(ranked.len());
    ips.extend(
        ranked
            .iter()
            .filter(|(_, ip)| matches!(ip, IpAddr::V4(_)))
            .map(|(_, ip)| *ip),
    );
    // 2026-11-09 V1: do NOT advertise IPv6. The announce carries ONE port, but on this machine
    // the v6 endpoint binds a DIFFERENT port (measured 50531 v4 vs 50533 v6) => every IPv6 entry
    // would point at a port nobody listens on (a guaranteed extra timeout).
    let mut out: Vec<String> = Vec::with_capacity(ips.len());
    for ip in ips {
        let addr = SocketAddr::new(ip, udp_port).to_string();
        if out.contains(&addr) {
            continue;
        }
        out.push(addr);
        if out.len() == MAX_QUIC_ADDRS {
            break;
        }
    }
    out
}

/// **IPv6 link-local（fe80::/10）⇒ 排除**：`if-addrs` 只给 `IpAddr`（**没有 scope id**），
/// 对端拿到也无法指定出口网卡，实际基本不可达（报了只会让对端白试一轮）。
/// IPv6 全局/ULA（`2000::/3`、`fc00::/7`）**保留** —— 它们不带 scope 也能用。
fn is_ipv6_link_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80,
        IpAddr::V4(_) => false,
    }
}

/// 从端点已绑定 sockets 里取**实际 UDP 端口**（IPv4 优先；全 0 ⇒ `None`）。
///
/// ⚠️ iroh 通常同时绑 `0.0.0.0:p` 与 `[::]:p` ⇒ 这里只取端口，**不拿通配地址对外**
///（对外地址由 [`announce_quic_addrs`] 用网卡枚举结果拼）。
fn bound_udp_port(bound: &[SocketAddr]) -> Option<u16> {
    bound
        .iter()
        .find(|s| matches!(s, SocketAddr::V4(v4) if v4.port() != 0))
        .map(|s| s.port())
        .or_else(|| bound.iter().find(|s| s.port() != 0).map(|s| s.port()))
}

/// 公告失败日志的唯一拼装点（纯函数）⇒ 测试可核内容。
#[cfg(all(feature = "lan-quic", not(feature = "relay")))]
fn quic_announce_log_line(why: &str) -> String {
    format!("[lan-quic] P3-2a：本轮公告不带 quic_addrs（原因={why}）")
}

/// ⭐ **P3-2a 最后一步**：本轮公告该带的 `quic_addrs`（本机**可达 IP** ＋ 端点**实际 UDP 端口**）。
///
/// 只在这个 cfg 下真正产地址：`all(feature="lan-quic", not(feature="relay"))`。
/// * Registry 起不来 / 取不到端口 / 枚举不到地址 ⇒ **空表 ＋ 一行日志**（⛔ 不 panic、⛔ 不影响 LAN HTTP）；
/// * 枚举复用 [`crate::mesh::local_addrs`]（既有唯一碰系统的那一处）⇒ 不新造依赖、不另写枚举。
#[cfg(all(feature = "lan-quic", not(feature = "relay")))]
pub async fn local_quic_addrs() -> Vec<String> {
    let registry = match process_registry().await {
        Ok(r) => r,
        Err(why) => {
            eprintln!(
                "{}",
                quic_announce_log_line(&format!("进程级 QUIC Registry 初始化失败：{why}"))
            );
            return Vec::new();
        }
    };
    let Some(port) = bound_udp_port(&registry.endpoint().local_addrs()) else {
        eprintln!(
            "{}",
            quic_announce_log_line("本机 QUIC 端点还没有已绑定的 UDP 端口")
        );
        return Vec::new();
    };
    // ⭐ 用**带网卡名**的排序入口（真实网卡在 WSL/utun 等虚拟网卡前；mesh 的既有口径）。
    let local_addrs = crate::mesh::ranked_local_addrs_named();
    if local_addrs.is_empty() {
        eprintln!("{}", quic_announce_log_line("枚举不到本机网卡地址"));
        return Vec::new();
    }
    announce_quic_addrs_named(&local_addrs, port)
}

// ───────────────── P3-2a 两 OS 进程验收辅助（只给 tests/lan_quic_two_process.rs） ─────────────────
//
// ⚠️ 它们**不是同步路径**：正常同步不会调用（落在这里只是为了让 integration test 能复用
//   同一套隧道帧，而不必把 `relay_tunnel` 私有模块整体公开）。行为与 `iroh_tunnel::request` /
//    `serve_one_conn` 同一口径（同一 ALPN、同一套帧）。

/// ⭐ **P3-2a 两进程验收辅助（服务端）**：接受**一条**连接、读**一次**请求、回固定 200/body，
/// 返回收到的 target（父测试可核对）。
///
/// ⚠️ 只给 `tests/lan_quic_two_process.rs` 的子进程用；⛔ 不是生产同步入口。
#[cfg(all(feature = "lan-quic", not(feature = "relay")))]
pub async fn serve_one_request_text(
    ep: &LanQuicEndpoint,
    reply_body: &str,
) -> Result<String, String> {
    let Some(incoming) = ep.accept().await else {
        return Err("端点已关，接不到连接".to_string());
    };
    let conn = incoming.await.map_err(|e| format!("QUIC 握手失败：{e}"))?;
    let (mut send, mut recv) = conn
        .accept_bi()
        .await
        .map_err(|e| format!("接流失败：{e}"))?;
    let req = crate::relay_tunnel::read_request(&mut recv)
        .await
        .map_err(|e| format!("读请求失败：{e}"))?;
    let target = req.target.clone();
    crate::relay_tunnel::write_reply(
        &mut send,
        &TunnelReply {
            status: 200,
            body: reply_body.as_bytes().to_vec(),
        },
    )
    .await
    .map_err(|e| format!("写应答失败：{e}"))?;
    send.finish().map_err(|e| format!("收流失败：{e}"))?;
    // 等客户端关（与 `serve_one_conn` 同一收尾口径）。
    let _ = conn.closed().await;
    Ok(target)
}

/// ⭐ **P3-2a 两进程验收辅助（客户端）**：向对端发**一次** `GET target`，回 `(status, body)`。
///
/// ⚠️ 只给 `tests/lan_quic_two_process.rs` 的子进程用；⛔ 不是生产同步入口。
#[cfg(all(feature = "lan-quic", not(feature = "relay")))]
pub async fn request_text(
    ep: &LanQuicEndpoint,
    peer: EndpointAddr,
    target: &str,
) -> Result<(u16, String), String> {
    let req = crate::relay_tunnel::TunnelRequest::new("GET", target);
    let reply = iroh_tunnel::request(&ep.ep, peer, &req).await?;
    Ok((
        reply.status,
        String::from_utf8_lossy(&reply.body).into_owned(),
    ))
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

// ───────────────────── 地址解析 ＋ 选路（纯函数；不建连接、不执行） ─────────────────────

/// 公告里 `quic_addrs` 的**条数上限**（防被灌爆；UDP 公告另外还有 `MAX_ANNOUNCE_BYTES`）。
///
/// ⚠️ 超限策略本笔选**如实报错**（⛔ 不静默截断 ✗）：截断会悄悄丢掉地址，而"丢了一半地址"
/// 与"全都能用"在下游看起来一样 —— 与"坏地址要点名"同一条纪律。
pub const MAX_QUIC_ADDRS: usize = 8;

/// 把公告里的 `quic_addrs` 解析成 `SocketAddr` 列表（**纯函数**）。
///
/// 口径（P3-2a 第四小步）：
/// * **只收 `IP:port`**：IPv4 `1.2.3.4:4433`；IPv6 必须带方括号 `[::1]:4433`（标准解析认）；
/// * **去重保序**：同一个地址（含 IPv6 等价写法）只留第一次出现的位置；
/// * **空表 ⇒ 空 vec**（"对端没报"不是错误）；
/// * **坏地址 ⇒ 可读错误并点名第几条**（⛔ 不静默丢 ✗）；
/// * **超 [`MAX_QUIC_ADDRS`] ⇒ 如实报错**（见常量的理由）。
pub fn parse_quic_addrs(addrs: &[String]) -> Result<Vec<SocketAddr>, String> {
    if addrs.len() > MAX_QUIC_ADDRS {
        return Err(format!(
            "quic_addrs 有 {} 条，超过上限 {MAX_QUIC_ADDRS} 条（⛔ 不静默截断）",
            addrs.len()
        ));
    }
    let mut out: Vec<SocketAddr> = Vec::with_capacity(addrs.len());
    for (i, raw) in addrs.iter().enumerate() {
        let addr: SocketAddr = raw.trim().parse().map_err(|_| {
            format!(
                "quic_addrs 第 {} 条不是 IP:port（IPv6 要带方括号）：{raw:?}",
                i + 1
            )
        })?;
        if !out.contains(&addr) {
            out.push(addr);
        }
    }
    Ok(out)
}

/// 64 位 hex → iroh [`PublicKey`]（`node_id` 的唯一解析口；公告/路线表同一形状，大小写都收）。
pub fn public_key_from_hex(node_id_hex: &str) -> Result<PublicKey, String> {
    let s = node_id_hex.trim();
    if s.len() != 64 {
        return Err(format!(
            "node_id 必须是 64 位 hex（现在 {} 位：{s:?}）",
            s.len()
        ));
    }
    let bytes = s.as_bytes();
    let mut raw = [0u8; 32];
    for (i, slot) in raw.iter_mut().enumerate() {
        *slot = (hex_nibble(bytes[2 * i])? << 4) | hex_nibble(bytes[2 * i + 1])?;
    }
    PublicKey::from_bytes(&raw).map_err(|e| format!("node_id 不是合法 iroh 公钥：{e}"))
}

fn hex_nibble(b: u8) -> Result<u8, String> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err(format!("node_id 里有非 hex 字符：{:?}", b as char)),
    }
}

/// 把 `node_id`（64 位 hex）＋ 公告里的地址拼成 iroh 的 [`EndpointAddr`]（**纯函数**）。
///
/// 口径：
/// * `node_id` 走 [`public_key_from_hex`]（长度/非法字符都点名报错）；
/// * 地址走 [`parse_quic_addrs`]（同一上限/去重/点名口径）；
/// * **地址为空 ⇒ 明确错误**：只有 node id 没有地址时今天没有发现层兜底、**连不上**
///   （⛔ 不许生成一个"看起来能连"的空地址端点 ✗）。
pub fn endpoint_addr(node_id_hex: &str, addrs: &[String]) -> Result<EndpointAddr, String> {
    let id = public_key_from_hex(node_id_hex)?;
    let parsed = parse_quic_addrs(addrs)?;
    if parsed.is_empty() {
        return Err(format!(
            "对端 node_id={node_id_hex} 没报任何 QUIC 地址 ⇒ 只有 node id 连不上（发现层还没做）"
        ));
    }
    let transport: std::collections::BTreeSet<iroh::TransportAddr> =
        parsed.iter().map(|a| iroh::TransportAddr::Ip(*a)).collect();
    Ok(EndpointAddr {
        id,
        addrs: transport,
    })
}

/// 选路**候选**（只分类、不执行）—— 枚举顺序即需求 FR-2 的优先级语义。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportChoice {
    /// 同网段 **QUIC 直连**（公告 `quic_addrs`；P3-2 才真正接线）。
    LanQuic,
    /// 同网段 **HTTP 直连**（现有 mesh 那条路）。
    LanHttp,
    /// 手动地址（路线表 `addrs` / 用户填的 IP:port）。
    Manual,
    /// 旧 HTTP fallback（配置的服务端地址等）。
    HttpFallback,
    /// **私有中继** —— 只兜底。
    Relay,
}

impl TransportChoice {
    /// 稳定短名（日志/判据用；⛔ 不是用户可见文案）。
    pub fn as_str(self) -> &'static str {
        match self {
            TransportChoice::LanQuic => "lan-quic",
            TransportChoice::LanHttp => "lan-http",
            TransportChoice::Manual => "manual",
            TransportChoice::HttpFallback => "http-fallback",
            TransportChoice::Relay => "relay",
        }
    }
}

/// 选路输入（全部来自现有读数/配置；本函数⛔ 不联网、⛔ 不判定"真的可达"）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PathOptions {
    /// 同网段有没有 HTTP 直连地址（现有 mesh 的读数）。
    pub has_lan_http: bool,
    /// 公告里有没有 QUIC 候选地址（`parse_quic_addrs` 之后非空）。
    pub quic_addrs_nonempty: bool,
    /// 有没有手动地址（路线表 `addrs`）。
    pub has_manual_addr: bool,
    /// 有没有旧 HTTP fallback。
    pub has_http_fallback: bool,
    /// 有没有配私有中继。
    pub relay_configured: bool,
}

/// **纯函数**：按需求 FR-2 给出**有序**候选：
/// `LAN 直连（HTTP/QUIC） > 手动 > HTTP fallback > 私有中继`（README/ADR §3.5 同一条）。
///
/// ⚠️ 它**只分类、不执行**：不知道哪个地址真的可达；"relay 只兜底"由**顺序**表达 ——
/// relay 永远排在所有直连候选之后，且只有在 `relay_configured` 时才出现。
/// ⚠️ LAN 两条的内部顺序固定为 **QUIC 在前、HTTP 在后**（P3-2 的方向；HTTP 保留作 fallback）。
pub fn transport_preference(o: PathOptions) -> Vec<TransportChoice> {
    let mut out = Vec::with_capacity(4);
    if o.quic_addrs_nonempty {
        out.push(TransportChoice::LanQuic);
    }
    if o.has_lan_http {
        out.push(TransportChoice::LanHttp);
    }
    if o.has_manual_addr {
        out.push(TransportChoice::Manual);
    }
    if o.has_http_fallback {
        out.push(TransportChoice::HttpFallback);
    }
    if o.relay_configured {
        out.push(TransportChoice::Relay);
    }
    out
}

/// 首选（有序候选的第一条；一个都没有 ⇒ `None`）—— 只是 [`transport_preference`] 的便捷读数。
pub fn primary_transport(o: PathOptions) -> Option<TransportChoice> {
    transport_preference(o).first().copied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay_tunnel::{read_request, write_reply};
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

    /// ⭐ **2026-11-11（真机每轮 3s 长尾的真因回归判据）**：**生产服务端 `serve_one_conn`
    /// 必须能在同一连接上连续服务多条流**。旧实现一条连接只服务一条流 ⇒ 第二次请求等应答直到
    /// 超时、驱逐后重连（`connect_attempts` 变 2、每轮 3s）。
    #[tokio::test]
    async fn serve_one_conn_serves_multiple_streams_on_one_connection() {
        let server = bind_direct(SecretKey::generate())
            .await
            .expect("服务端端点");
        let peer = loopback_addr(&server, ipv4_port(&server));
        let serve = tokio::spawn(async move {
            let Some(incoming) = server.accept().await else {
                panic!("端点已关，接不到连接");
            };
            let conn = incoming.await.expect("QUIC 握手");
            crate::relay_tunnel::iroh_tunnel::serve_one_conn(conn, |req| TunnelReply {
                status: 200,
                body: format!("ok:{}", req.target).into_bytes(),
            })
            .await
        });

        let registry = LanQuicRegistry::new(SecretKey::generate())
            .await
            .expect("注册表");
        for i in 0..3 {
            let req = TunnelRequest::new("GET", &format!("/multi/{i}"));
            let reply = tokio::time::timeout(
                Duration::from_secs(5),
                registry.request(peer.clone(), &req),
            )
            .await
            .expect("5s 内必须完成（同一连接应可复用）")
            .expect("请求必须成功");
            assert_eq!(
                String::from_utf8_lossy(&reply.body),
                format!("ok:/multi/{i}"),
                "第 {i} 条应答要对得上"
            );
        }
        assert_eq!(
            registry.connect_attempts(),
            1,
            "3 次请求只应 connect 一次（服务端必须循环接流；旧实现这里会是 2~3）"
        );
        registry.close().await;
        let _ = tokio::time::timeout(Duration::from_secs(5), serve).await;
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
    // ── P3-2a 第四小步：地址解析 ＋ 选路（纯函数；不建连接） ──

    fn valid_node_hex() -> String {
        hex32(SecretKey::generate().public().as_bytes())
    }

    #[test]
    fn parse_quic_addrs_accepts_ipv4_and_bracketed_ipv6_and_dedupes_in_order() {
        let raw = vec![
            "192.168.1.5:4433".to_string(),
            "[::1]:4433".to_string(),
            "192.168.1.5:4433".to_string(), // 重复
            "[2001:db8::1]:4434".to_string(),
            "[::1]:4433".to_string(), // 重复
        ];
        let got = parse_quic_addrs(&raw).expect("合法地址");
        assert_eq!(got.len(), 3, "去重保序：{got:?}");
        assert_eq!(got[0].to_string(), "192.168.1.5:4433");
        assert_eq!(got[1].to_string(), "[::1]:4433");
        assert_eq!(got[2].to_string(), "[2001:db8::1]:4434");
        // 等价的 IPv6 压缩写法应当被视为同一地址
        let got = parse_quic_addrs(&[
            "[::1]:4433".to_string(),
            "[0:0:0:0:0:0:0:1]:4433".to_string(),
        ])
        .expect("IPv6 等价写法");
        assert_eq!(got.len(), 1, "IPv6 等价写法必须去重");
    }

    #[test]
    fn parse_quic_addrs_names_the_bad_index_and_refuses_overflow() {
        let bad = vec!["192.168.1.5:4433".to_string(), "not-an-addr".to_string()];
        let err = parse_quic_addrs(&bad).expect_err("坏地址必须报错");
        assert!(err.contains("第 2 条"), "要点名第几条：{err}");
        assert!(err.contains("IP:port"), "要说清正确写法：{err}");
        assert!(err.contains("not-an-addr"), "要把坏值带出来：{err}");

        // IPv6 不带方括号 ⇒ 标准解析失败 ⇒ 点名（⛔ 不许当 IPv4 糊过去）
        let err = parse_quic_addrs(&["::1:4433".to_string()]).expect_err("无方括号 IPv6 必须报错");
        assert!(err.contains("第 1 条"), "{err}");

        // 上限：恰好 8 条可以，9 条如实报错（不静默截断）
        let eight: Vec<String> = (0..8).map(|i| format!("10.0.0.{}:4433", i + 1)).collect();
        assert_eq!(parse_quic_addrs(&eight).unwrap().len(), 8);
        let nine: Vec<String> = (0..9).map(|i| format!("10.0.0.{}:4433", i + 1)).collect();
        let err = parse_quic_addrs(&nine).expect_err("超上限必须报错");
        assert!(err.contains("上限"), "{err}");
        assert!(err.contains('9'), "{err}");
    }

    #[test]
    fn parse_quic_addrs_accepts_an_empty_table() {
        assert!(
            parse_quic_addrs(&[]).unwrap().is_empty(),
            "空表 = 对端没报，不是错误"
        );
    }

    #[test]
    fn endpoint_addr_needs_a_valid_node_id_and_at_least_one_addr() {
        let node = valid_node_hex();
        let a = endpoint_addr(
            &node,
            &["192.168.1.5:4433".to_string(), "[::1]:4434".to_string()],
        )
        .expect("合法 node_id ＋ 地址");
        assert_eq!(
            hex32(a.id.as_bytes()),
            node,
            "node_id 要原样落进 EndpointAddr.id"
        );
        assert_eq!(a.addrs.len(), 2, "两个地址都要进去（TransportAddr::Ip）");

        // node_id 长度/字符坏 ⇒ 点名
        let err = endpoint_addr(&node[..62], &["1.2.3.4:1".to_string()])
            .expect_err("短 node_id 必须报错");
        assert!(err.contains("64 位 hex"), "{err}");
        let bad = format!("z{}", &node[1..]);
        let err = endpoint_addr(&bad, &["1.2.3.4:1".to_string()]).expect_err("非 hex 必须报错");
        assert!(err.contains("非 hex"), "{err}");
        // 空地址 ⇒ 明确错误（只有 node id 连不上）
        let err = endpoint_addr(&node, &[]).expect_err("空地址必须报错");
        assert!(err.contains("没报任何 QUIC 地址"), "{err}");
        // 坏地址错误要透传（并点名第几条）
        let err = endpoint_addr(&node, &["nope".to_string()]).expect_err("坏地址必须报错");
        assert!(err.contains("第 1 条"), "{err}");
    }

    #[test]
    fn transport_preference_keeps_lan_first_and_relay_as_the_last_resort() {
        // ① 同网：LAN 两档都可用 ⇒ relay 配了也只排最后（⛔ 不许抢 LAN）
        let o = PathOptions {
            quic_addrs_nonempty: true,
            has_lan_http: true,
            has_manual_addr: true,
            has_http_fallback: true,
            relay_configured: true,
        };
        let pref = transport_preference(o);
        assert_eq!(
            pref,
            vec![
                TransportChoice::LanQuic,
                TransportChoice::LanHttp,
                TransportChoice::Manual,
                TransportChoice::HttpFallback,
                TransportChoice::Relay,
            ],
            "FR-2 顺序：LAN 直连 > 手动 > HTTP fallback > 私有中继"
        );
        assert_eq!(
            primary_transport(o),
            Some(TransportChoice::LanQuic),
            "同网首选 LAN，⛔ 不是 relay"
        );

        // ② 同网只有 HTTP（没有 QUIC 地址）⇒ HTTP 直连首选、仍不走 relay
        let o = PathOptions {
            has_lan_http: true,
            has_http_fallback: true,
            relay_configured: true,
            ..Default::default()
        };
        assert_eq!(primary_transport(o), Some(TransportChoice::LanHttp));

        // ③ 跨网：没有任何直连候选 ⇒ relay 才是首选（且只有它）
        let o = PathOptions {
            relay_configured: true,
            ..Default::default()
        };
        assert_eq!(transport_preference(o), vec![TransportChoice::Relay]);
        assert_eq!(primary_transport(o), Some(TransportChoice::Relay));

        // ④ 跨网且没配 relay ⇒ **没有候选**（不是"假装有"）
        assert!(transport_preference(PathOptions::default()).is_empty());
        assert_eq!(primary_transport(PathOptions::default()), None);

        // ⑤ 手动地址 / HTTP fallback 都排在 relay 之前
        let o = PathOptions {
            has_manual_addr: true,
            has_http_fallback: true,
            relay_configured: true,
            ..Default::default()
        };
        assert_eq!(
            transport_preference(o),
            vec![
                TransportChoice::Manual,
                TransportChoice::HttpFallback,
                TransportChoice::Relay,
            ]
        );

        // ⑥ 枚举短名（日志/判据用）稳定
        assert_eq!(TransportChoice::LanQuic.as_str(), "lan-quic");
        assert_eq!(TransportChoice::LanHttp.as_str(), "lan-http");
        assert_eq!(TransportChoice::Manual.as_str(), "manual");
        assert_eq!(TransportChoice::HttpFallback.as_str(), "http-fallback");
        assert_eq!(TransportChoice::Relay.as_str(), "relay");
    }

    // ── P3-2a 数据面最后一步：公告用的 QUIC 地址 ──

    #[test]
    fn announce_quic_addrs_formats_filters_dedupes_and_caps() {
        let ips: Vec<IpAddr> = [
            "127.0.0.1",
            "0.0.0.0",
            "192.168.1.5",
            "192.168.1.5", // 重复
            "fe80::1",     // link-local（无 scope）⇒ 必须排除
            "2001:db8::1", // 全局 IPv6 ⇒ 保留
            "::1",
        ]
        .iter()
        .map(|s| s.parse().unwrap())
        .collect();
        let got = announce_quic_addrs(&ips, 47831);
        assert_eq!(
            got,
            vec!["192.168.1.5:47831".to_string()],
            "V1 只报 IPv4（IPv6 一律不报，理由见 announce_quic_addrs_named 的注释）；去重、排除回环/通配/link-local"
        );
        assert!(
            parse_quic_addrs(&got).is_ok(),
            "公告发出去的格式必须能被消费侧解析：{got:?}"
        );
        // 端口 0 / 空输入 ⇒ 空表（还没绑上，不报一个没人算得出的端口）。
        assert!(announce_quic_addrs(&ips, 0).is_empty());
        assert!(announce_quic_addrs(&[], 47831).is_empty());
        // 上限：10 条不同 IP ⇒ 只留 8 条。
        let many: Vec<IpAddr> = (1..=10)
            .map(|i| IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, i)))
            .collect();
        assert_eq!(announce_quic_addrs(&many, 47831).len(), MAX_QUIC_ADDRS);
        // 全部被过滤 ⇒ 空表。
        let filtered: Vec<IpAddr> = ["127.0.0.1", "0.0.0.0", "::1"]
            .iter()
            .map(|s| s.parse().unwrap())
            .collect();
        assert!(announce_quic_addrs(&filtered, 1).is_empty());
    }

    /// ⭐ P3-2a 地址质量：IPv4 优先、link-local 剔除、全局 IPv6 保留（混合/仅 link-local/仅全局三组）。
    #[test]
    fn announce_quic_addrs_prefers_ipv4_and_drops_ipv6_in_v1() {
        // a) 混合：2 个 IPv4 ＋ 全局 IPv6 ＋ ULA ＋ link-local ⇒ IPv4 全在前、link-local 消失。
        let ips: Vec<IpAddr> = [
            "192.168.1.5",
            "10.0.0.2",
            "2001:db8::1",
            "fd00::1",
            "fe80::1",
            "::1",
        ]
        .iter()
        .map(|s| s.parse().unwrap())
        .collect();
        let got = announce_quic_addrs(&ips, 47831);
        assert_eq!(
            got,
            vec![
                "10.0.0.2:47831".to_string(),
                "192.168.1.5:47831".to_string(),
            ],
            "V1 只报 IPv4；IPv6（全局/ULA/link-local）一律不报"
        );
        assert!(
            parse_quic_addrs(&got).is_ok(),
            "混合列表也必须能被消费侧解析：{got:?}"
        );

        // b) 只有 link-local ⇒ 空表（⛔ 不造一个对端用不了的地址）。
        let only_ll: Vec<IpAddr> = ["fe80::1", "fe80::dead:beef"]
            .iter()
            .map(|s| s.parse().unwrap())
            .collect();
        assert!(
            announce_quic_addrs(&only_ll, 47831).is_empty(),
            "只有 link-local ⇒ 空表"
        );

        // c) 只有全局 IPv6 ⇒ **空表**（V1 不报 IPv6：公告只有一个端口，而 v6 端点端口不同）。
        let only_global = announce_quic_addrs(&["2001:db8::5".parse().unwrap()], 47831);
        assert!(
            only_global.is_empty(),
            "V1 不报 IPv6 ⇒ 空表：{only_global:?}"
        );

        // d) IPv6 被拒后上限只按 IPv4 算：3 个 IPv4 ＋ 10 个 IPv6 ⇒ 只剩 3 条 IPv4。
        let mut many: Vec<IpAddr> = (1..=3)
            .map(|i| IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, i)))
            .collect();
        many.extend(
            (1..=10).map(|i| IpAddr::V6(std::net::Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, i))),
        );
        let capped = announce_quic_addrs(&many, 47831);
        assert_eq!(
            capped.len(),
            3,
            "V1 只报 IPv4 ⇒ 上限内只有 3 条：{capped:?}"
        );
        assert!(
            capped.iter().all(|s| s.starts_with("10.0.0.")),
            "只剩 IPv4：{capped:?}"
        );
    }

    /// ⭐ P3-2a 地址质量第二刀：**带网卡名**的公告地址 —— 真实 WLAN 排第一、虚拟网卡靠后、
    /// 同族内按 mesh 的 `lan_rank_key`、IPv4 全在 IPv6 前。
    #[test]
    fn announce_quic_addrs_named_puts_the_real_wlan_before_virtual_adapters() {
        let ip = |s: &str| -> IpAddr { s.parse().unwrap() };
        let locals: Vec<(String, IpAddr)> = vec![
            ("vEthernet (WSL)".to_string(), ip("172.18.224.1")),
            ("en0".to_string(), ip("192.168.43.190")),
            ("utun3".to_string(), ip("10.128.166.117")),
            ("en0".to_string(), ip("fe80::1")), // link-local ⇒ 过滤
            ("en0".to_string(), ip("2001:db8::1")),
            ("lo0".to_string(), ip("127.0.0.1")), // 回环 ⇒ 过滤
            ("any".to_string(), ip("0.0.0.0")),   // 通配 ⇒ 过滤
        ];
        let got = announce_quic_addrs_named(&locals, 47831);
        assert_eq!(
            got,
            vec!["192.168.43.190:47831".to_string()],
            "V1 只报真实网卡 IPv4：虚拟网卡（vEthernet/WSL/utun）与 IPv6 都不进公告（两者都会让对端拨到没人听的地址/端口）；link-local/回环/通配被过滤"
        );
        assert!(
            parse_quic_addrs(&got).is_ok(),
            "公告发出去的格式必须能被消费侧解析：{got:?}"
        );
        // 去重/端口 0/上限与无名字版同一口径。
        let dup = vec![
            ("en0".to_string(), ip("192.168.43.190")),
            ("en0".to_string(), ip("192.168.43.190")),
        ];
        assert_eq!(announce_quic_addrs_named(&dup, 1).len(), 1, "按 IP 去重");
        assert!(
            announce_quic_addrs_named(&locals, 0).is_empty(),
            "端口 0 ⇒ 空"
        );
        let many: Vec<(String, IpAddr)> = (1..=10)
            .map(|i| {
                (
                    format!("en{i}"),
                    IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, i)),
                )
            })
            .collect();
        assert_eq!(announce_quic_addrs_named(&many, 1).len(), MAX_QUIC_ADDRS);
    }

    #[test]
    fn bound_udp_port_prefers_ipv4_and_ignores_zero() {
        let v = |s: &str| s.parse::<SocketAddr>().unwrap();
        assert_eq!(
            bound_udp_port(&[v("0.0.0.0:0"), v("0.0.0.0:47831"), v("[::]:47831")]),
            Some(47831)
        );
        assert_eq!(bound_udp_port(&[v("0.0.0.0:0")]), None);
        assert_eq!(bound_udp_port(&[]), None);
        assert_eq!(bound_udp_port(&[v("[::]:47832")]), Some(47832));
    }

    /// ⭐ 真实端点：公告地址非空、每条可解析、端口＝端点实际 UDP 端口、无回环/通配、≤8、去重。
    #[cfg(all(feature = "lan-quic", not(feature = "relay")))]
    #[tokio::test]
    async fn local_quic_addrs_are_real_parseable_and_on_the_endpoint_port() {
        crate::db::ensure_test_app_data_dir();
        let addrs = local_quic_addrs().await;
        assert!(
            !addrs.is_empty(),
            "端点起得来且本机有网卡时，公告不许是空表：{addrs:?}"
        );
        let registry = process_registry().await.expect("进程级 Registry");
        let port = bound_udp_port(&registry.endpoint().local_addrs()).expect("端点实际端口");
        let parsed = parse_quic_addrs(&addrs).expect("公告地址必须能被消费侧解析");
        assert_eq!(parsed.len(), addrs.len(), "每条都该解析成功（去重后）");
        for a in &parsed {
            assert_eq!(a.port(), port, "端口必须＝端点实际绑定端口：{a} vs {port}");
            assert!(
                !a.ip().is_loopback() && !a.ip().is_unspecified(),
                "不许回环/通配：{a}"
            );
        }
        assert!(addrs.len() <= MAX_QUIC_ADDRS, "上限：{addrs:?}");
        assert!(
            addrs.windows(2).all(|w| w[0] != w[1]),
            "不许重复：{addrs:?}"
        );
    }
}
