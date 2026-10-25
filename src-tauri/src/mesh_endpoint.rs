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
pub async fn endpoint_for_peer(
    peer: &crate::mesh::MeshPeer,
    client: reqwest::Client,
) -> Result<Box<dyn Endpoint + Send>, String> {
    let Some(node_id) = peer.base.strip_prefix(RELAY_BASE_PREFIX) else {
        return Ok(Box::new(LanEndpoint::new(&peer.base, client)));
    };
    relay_endpoint_for(peer, node_id).await
}

#[cfg(feature = "relay")]
async fn relay_endpoint_for(
    peer: &crate::mesh::MeshPeer,
    node_id: &str,
) -> Result<Box<dyn Endpoint + Send>, String> {
    use std::net::SocketAddr;
    let routes = crate::relay_route::load_routes()?;
    let route = crate::relay_route::route_for(&routes, &peer.device_id).ok_or_else(|| {
        format!(
            "对端 {} 要走跨网，但跨网路线表里没有它（peer 的 node_id={}）",
            peer.device_id, node_id
        )
    })?;
    if route.addrs.is_empty() {
        return Err(format!(
            "对端 {} 的路线没有可达地址：跨网发现层还没做（Step 3-2）⇒ 只有 node id 连不上",
            peer.device_id
        ));
    }
    let addrs: std::collections::BTreeSet<iroh::TransportAddr> = route
        .addrs
        .iter()
        .filter_map(|a| a.parse::<SocketAddr>().ok().map(iroh::TransportAddr::Ip))
        .collect();
    let id_bytes = crate::relay_tunnel::iroh_client::node_id_bytes(&route.node_id)?;
    let id = iroh::PublicKey::from_bytes(&id_bytes)
        .map_err(|e| format!("路线表里 {} 的 node_id 不是合法公钥：{e}", peer.device_id))?;
    let ep = crate::relay_tunnel::iroh_client::RelayEndpoint::connect(iroh::EndpointAddr {
        id,
        addrs,
    })
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
        assert_eq!(join("http://192.168.0.5:8788", "/mesh/pull?x=1"), "http://192.168.0.5:8788/mesh/pull?x=1");
        assert_eq!(join("http://192.168.0.5:8788/", "/mesh/pull?x=1"), "http://192.168.0.5:8788/mesh/pull?x=1");
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
        };
        let err = match endpoint_for_peer(&peer, reqwest::Client::new()).await {
            Ok(_) => panic!("relay: 前缀必须走跨网分支（⛔ 不许当 LAN）"),
            Err(e) => e,
        };
        assert!(err.contains("--features relay"), "要说清怎么办：{err}");
    }
}
