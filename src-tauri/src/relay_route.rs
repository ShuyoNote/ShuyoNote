//! 跨网对端的「路线表」（Step 3-1 的最小落点）。
//!
//! ## 它解决什么
//!
//! 局域网靠 UDP 广播发现对端；**跨网没有广播** ⇒ 得有一个等价物。
//! 完整体是"发现层"（中继目录／DNS），但今天先做**最小的一份**：一个本地文件，
//! 明确写"哪个设备在哪个可达地址上"。⛔ 它不猜、不扫描、不联网。
//!
//! ## 文件在哪、长什么样
//!
//! `<app data dir>/relay/peers.json`（与中继配置同目录）：
//!
//! ```json
//! {
//!   "dev-abc123": { "node_id": "<64 位 hex 的 iroh 公钥>", "addrs": ["192.168.0.105:8788"] }
//! }
//! ```
//!
//! * `node_id` —— **必须**是 64 位 hex（iroh 公钥；⛔ 少了就说不清"连谁"）；
//! * `addrs` —— 可选。**今天只认 IP:port 直连**（中继隧道寻址是 Step 3-2 的事）。
//!
//! ## 三条口径
//!
//! ```text
//! ① 文件不存在 ⇒ **空表**（⛔ 不是错误：绝大多数人不用跨网）
//! ② 文件在但**坏了** ⇒ **可读报错**（⛔ 不静默当成空表 —— 那会让人以为"配了却没用"）
//! ③ 条目里缺 `node_id` / 不是 64 位 hex ⇒ 报错并**点名哪一条**（⛔ 不跳过）
//! ```
//!
//! ⚠️ 本模块**没有** iroh 依赖（只读 JSON）：默认构建也能编 ⇒ 将来"跨网开关/诊断"直接用它。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 文件里的一条：一个设备 ↔ 一个可达的 iroh 对端。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelayRoute {
    /// 对端设备号（与同步档案/信封里的 `device_id` 同一口径）。
    pub device_id: String,
    /// iroh 公钥（64 位 hex）。
    pub node_id: String,
    /// 可选的可达地址（**今天只支持 `IP:port` 直连**）。
    #[serde(default)]
    pub addrs: Vec<String>,
}

/// 路线文件路径：与中继配置同目录（`relay/peers.json`）。
pub fn routes_path() -> Option<PathBuf> {
    let cfg = crate::relay_client::resolve_config_path()?;
    Some(cfg.parent()?.join("peers.json"))
}

/// 读整张表。**文件不存在 ⇒ 空表**；坏 JSON / 条目不合法 ⇒ 报错（见模块头注三条口径）。
pub fn load_routes() -> Result<Vec<RelayRoute>, String> {
    let Some(path) = routes_path() else {
        return Ok(Vec::new());
    };
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("读不了跨网路线表 {}：{e}", path.display()))?;
    parse_routes(&raw)
}

/// 纯解析（可单测）：JSON 对象 ⇒ 按 device_id 排序的条目列表。
pub fn parse_routes(raw: &str) -> Result<Vec<RelayRoute>, String> {
    let map: std::collections::BTreeMap<String, RawEntry> =
        serde_json::from_str(raw).map_err(|e| format!("跨网路线表不是合法 JSON：{e}"))?;
    let mut out = Vec::with_capacity(map.len());
    for (device_id, e) in map {
        let node_id = e.node_id.trim().to_ascii_lowercase();
        if node_id.len() != 64 || !node_id.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!(
                "跨网路线表里 {device_id} 的 node_id 不是 64 位 hex（现在是 {} 位：{:?}）",
                node_id.len(),
                node_id
            ));
        }
        for a in &e.addrs {
            if a.parse::<std::net::SocketAddr>().is_err() {
                return Err(format!(
                    "跨网路线表里 {device_id} 的地址 {a:?} 不是 IP:port（今天只支持直连地址）"
                ));
            }
        }
        out.push(RelayRoute {
            device_id,
            node_id,
            addrs: e.addrs,
        });
    }
    Ok(out)
}

/// 找某个设备的路线。
pub fn route_for<'a>(routes: &'a [RelayRoute], device_id: &str) -> Option<&'a RelayRoute> {
    routes.iter().find(|r| r.device_id == device_id)
}

#[derive(Debug, Deserialize)]
struct RawEntry {
    node_id: String,
    #[serde(default)]
    addrs: Vec<String>,
}

/// 把路线表里的设备变成**网格对端**（纯函数，可单测）：
/// * 已在局域网候选里的设备**跳过**（同一设备不该被拉两次）
/// * base 一律写成 `relay:<node_id>`（由 `mesh_endpoint::endpoint_for_peer` 认这个前缀）
pub fn virtual_peers_from(
    routes: &[RelayRoute],
    already: &std::collections::HashSet<String>,
) -> Vec<crate::mesh::MeshPeer> {
    routes
        .iter()
        .filter(|r| !already.contains(&r.device_id))
        .map(|r| crate::mesh::MeshPeer {
            device_id: r.device_id.clone(),
            base: format!("{}{}", crate::mesh_endpoint::RELAY_BASE_PREFIX, r.node_id),
        })
        .collect()
}

/// 回合装配用：把路线表里的对端**补进**候选（原地追加）。
///
/// ⚠️ **默认构建什么都不做** —— 跨网只有 `--features relay` 才可用，
/// 否则每轮都会拿着 `relay:` 前缀去撞"没编入跨网"的错误（那是噪音，不是功能）。
/// ⚠️ 路线表读不了 ⇒ 打一行日志（⛔ 静默吞掉会让人以为"配了却没生效"）。
pub fn append_virtual_peers(out: &mut Vec<crate::mesh::MeshPeer>) {
    #[cfg(feature = "relay")]
    {
        let routes = match load_routes() {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[mesh] 跨网路线表读不了 ⇒ 本轮不跑跨网：{e}");
                return;
            }
        };
        if routes.is_empty() {
            return;
        }
        let already: std::collections::HashSet<String> =
            out.iter().map(|p| p.device_id.clone()).collect();
        let add = virtual_peers_from(&routes, &already);
        if !add.is_empty() {
            eprintln!(
                "[mesh] 跨网路线表：补了 {} 个对端（{}）",
                add.len(),
                add.iter().map(|p| p.device_id.clone()).collect::<Vec<_>>().join("、")
            );
            out.extend(add);
        }
    }
    #[cfg(not(feature = "relay"))]
    {
        let _ = out;
        // 默认构建：跨网不可用 ⇒ 不往候选里塞 `relay:` 对端（否则每轮都是报错噪音）
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OK_ID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// ⭐ 口径①：**文件不存在 ⇒ 空表**（不是错误）。
    #[test]
    fn a_missing_file_means_an_empty_table_not_an_error() {
        assert!(parse_routes("{}").unwrap().is_empty());
    }

    /// ⭐ 正常一条：node_id 大小写归一、地址校验通过。
    #[test]
    fn one_valid_route_parses() {
        let raw = format!(
            r#"{{"dev-abc": {{"node_id": "{OK_ID}", "addrs": ["192.168.0.105:8788"]}}}}"#
        );
        let routes = parse_routes(&raw).unwrap();
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].device_id, "dev-abc");
        assert_eq!(routes[0].node_id, OK_ID);
        assert_eq!(routes[0].addrs, vec!["192.168.0.105:8788".to_string()]);
        assert!(route_for(&routes, "dev-abc").is_some());
        assert!(route_for(&routes, "dev-none").is_none());
    }

    /// ⭐ 口径③：**node_id 不是 64 位 hex ⇒ 报错并点名**（⛔ 不跳过、不静默）。
    #[test]
    fn a_bad_node_id_is_an_error_that_names_the_entry() {
        let raw = r#"{"dev-x": {"node_id": "abc"}}"#;
        let err = parse_routes(raw).expect_err("短 node_id 必须报错");
        assert!(err.contains("dev-x"), "要点名是哪一条：{err}");
        assert!(err.contains("64 位 hex"), "要说清错在哪：{err}");
    }

    /// ⭐ 地址形如 `1.2.3.4`（缺端口）⇒ 报错（今天只支持 IP:port）。
    #[test]
    fn an_addr_without_a_port_is_refused() {
        let raw = format!(r#"{{"dev-y": {{"node_id": "{OK_ID}", "addrs": ["192.168.0.105"]}}}}"#);
        let err = parse_routes(&raw).expect_err("缺端口必须报错");
        assert!(err.contains("dev-y") && err.contains("IP:port"), "{err}");
    }

    /// ⭐ **Step 3-2 判据**：路线表 → 对端的映射（纯函数）
    /// * 已在局域网候选里的设备**跳过**（⛔ 拉两次）
    /// * base 必须是 `relay:<node_id>`（由工厂认这个前缀）
    #[test]
    fn routesturn_into_virtual_peers_without_duplicating_lan_peers() {
        let routes = parse_routes(&format!(
            r#"{{"dev-a": {{"node_id": "{OK_ID}", "addrs": ["192.168.0.5:8788"]}}}}"#
        ))
        .unwrap();
        assert_eq!(virtual_peers_from(&routes, &Default::default()).len(), 1, "空候选 ⇒ 补一个");
        let seen: std::collections::HashSet<String> =
            ["dev-a".to_string()].into_iter().collect();
        assert!(
            virtual_peers_from(&routes, &seen).is_empty(),
            "已经在局域网候选里的设备不许重复补"
        );
        let peers = virtual_peers_from(&routes, &Default::default());
        assert_eq!(
            peers[0].base,
            format!("{}{}", crate::mesh_endpoint::RELAY_BASE_PREFIX, OK_ID),
            "base 必须是 relay:<node_id>（工厂靠它挑传输）"
        );
    }

    /// ⭐ 口径②：坏 JSON ⇒ 报错（⛔ 不当成空表）。
    #[test]
    fn broken_json_is_an_error_not_an_empty_table() {
        let err = parse_routes("{not json").expect_err("坏 JSON 必须报错");
        assert!(err.contains("不是合法 JSON"), "{err}");
    }
}
