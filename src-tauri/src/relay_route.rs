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
//!
//! ## ⭐ 和局域网的关系：**LAN 优先**（2026-11-08 P0）
//!
//! 路线表是**跨网兜底**，不是局域网的替代品：LAN 已经发现的设备**保留 LAN 路径**，
//! 路线表只补「LAN 没发现」的跨网设备（[`merge_route_peers`] 只追加、不摘除）。
//! ⛔ 反过来做（摘掉 LAN 候选、换成 relay 并放最前）会让**中继服务器不可达时，
//! 同一局域网的两台设备连直连都同步不了** —— 那是 2026-11-08 确认的 P0 缺陷。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 文件里的一条：一个设备 ↔ 一个可达的 iroh 对端。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelayRoute {
    /// 对端设备号（与同步档案/信封里的 `device_id` 同一口径）。
    pub device_id: String,
    /// iroh 公钥（64 位 hex）。
    pub node_id: String,
    /// 可选的可达地址（`IP:port` 直连；⚠️ 只在我们**同一网络**时有用）。
    #[serde(default)]
    pub addrs: Vec<String>,
    /// ⭐ **2026-10-25（owner 拍「现在补异网寻址」）**：可选的中继地址
    /// （如 `http://112.124.60.73:8880`）。
    ///
    /// 用途：两台机器**不在同一网络**时，靠它互相找到（走中继打洞/转发），
    /// ⛔ 只填 `addrs` 是找不到的 —— 那是同一局域网才有效的直连地址。
    #[serde(default)]
    pub relay: Option<String>,
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
                    "跨网路线表里 {device_id} 的地址 {a:?} 不是 IP:port（直连地址要写成 IP:port）"
                ));
            }
        }
        // ⭐ 中继地址（异网寻址）：给了就必须 http(s):// 开头 —— ⛔ 不许填个主机名糊弄过去
        let relay = match e.relay {
            Some(r) => {
                let r = r.trim().to_string();
                if r.is_empty() {
                    None
                } else if r.starts_with("http://") || r.starts_with("https://") {
                    Some(r)
                } else {
                    return Err(format!(
                        "跨网路线表里 {device_id} 的 relay 要写成 http(s)://主机:端口，实得 {r:?}"
                    ));
                }
            }
            None => None,
        };
        // ⚠️ 两条都不给 ⇒ 这个对端根本不可达 ⇒ 报错（⛔ 不要生成一个"永远连不上"的候选）
        if e.addrs.is_empty() && relay.is_none() {
            return Err(format!(
                "跨网路线表里 {device_id} 既没有 addrs 也没有 relay ⇒ 它不可达（跨网发现层还没做，别只写 node_id）"
            ));
        }
        out.push(RelayRoute {
            device_id,
            node_id,
            addrs: e.addrs,
            relay,
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
    #[serde(default)]
    relay: Option<String>,
}

/// 把路线表里的设备变成**网格对端**（纯函数，可单测）：
/// * 已在候选里的设备（＝**LAN 已经发现**）⇒ **跳过** —— LAN 优先，同一设备不该被拉两次
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

/// 回合装配用：把路线表里的**跨网**对端**补进**候选（原地追加，⛔ 不摘除任何已有候选）。
///
/// ⭐ **LAN 优先（2026-11-08 P0）**：LAN 已经发现的设备保留 LAN 路径；
/// 只有 LAN 没发现的设备才补 `relay:<node_id>`（追加在末尾，LAN 候选排前面）。
///
/// ⚠️ **默认构建什么都不做** —— 跨网只有 `--features relay` 才可用，
/// 否则每轮都会拿着 `relay:` 前缀去撞"没编入跨网"的错误（那是噪音，不是功能）。
/// ⚠️ 路线表读不了 ⇒ 打一行日志（⛔ 静默吞掉会让人以为"配了却没生效"；也⛔ 因此打断本轮 —— LAN 照跑）。
pub fn append_virtual_peers(out: &mut Vec<crate::mesh::MeshPeer>) {
    #[cfg(feature = "relay")]
    {
        let routes = match load_routes() {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[mesh] 跨网路线表读不了 ⇒ 本轮不跑跨网（LAN 候选照旧）：{e}");
                return;
            }
        };
        if routes.is_empty() {
            return;
        }
        // 先记下"本来就有哪些 relay 候选"，只用来把日志点名说准（⛔ 不参与取舍）。
        let relay_before: std::collections::HashSet<String> = out
            .iter()
            .filter(|p| p.base.starts_with(crate::mesh_endpoint::RELAY_BASE_PREFIX))
            .map(|p| p.device_id.clone())
            .collect();
        let added = merge_route_peers(out, &routes);
        if added > 0 {
            eprintln!(
                "[mesh] 跨网路线表：补了 {added} 个跨网对端（{}；LAN 已发现的设备保持 LAN）",
                out.iter()
                    .filter(
                        |p| p.base.starts_with(crate::mesh_endpoint::RELAY_BASE_PREFIX)
                            && !relay_before.contains(&p.device_id)
                    )
                    .map(|p| p.device_id.clone())
                    .collect::<Vec<_>>()
                    .join("、")
            );
        }
    }
    #[cfg(not(feature = "relay"))]
    {
        let _ = out;
        // 默认构建：跨网不可用 ⇒ 不往候选里塞 `relay:` 对端（否则每轮都是报错噪音）
    }
}

/// ⭐ 纯函数（可单测）：把路线表里**LAN 没发现**的设备补成 `relay:<node_id>` 候选。
///
/// * 候选里已有同 `device_id` 的设备（LAN 已发现）⇒ **跳过，保留原 LAN 路径**；
/// * 候选里已有同 `relay:<node_id>`（幂等/重复调用）⇒ 跳过（⛔ 拉两次）；
/// * 其余 ⇒ **追加在末尾**（LAN 候选仍排前面）；
/// * ⛔ **不 retain、不替换、不重排** —— 一条已有候选都不会被摘掉。
///
/// 返回**实际追加的跨网对端数**。
///
/// ⚠️ 为什么不再是 2026-10-25 的「路线表优先」（摘掉同 id 的 LAN 候选、换成 relay 放最前）：
/// 那会让**中继服务器不可达时，同网设备连局域网路径都没有** ⇒ 局域网跟着中继一起挂
/// （2026-11-08 确认的 P0 缺陷）。relay 的定位是"LAN 没发现时的跨网兜底"，
/// ⛔ 它不该有权限降级一条已经可用的 LAN 路径。
pub fn merge_route_peers(out: &mut Vec<crate::mesh::MeshPeer>, routes: &[RelayRoute]) -> usize {
    if routes.is_empty() {
        return 0;
    }
    // 已经在候选里的设备（LAN 已发现 / 上一轮已补过）⇒ 不再补 relay。
    let already: std::collections::HashSet<String> =
        out.iter().map(|p| p.device_id.clone()).collect();
    // 同一条 relay 地址已在候选里 ⇒ 也不重复补（防御重复调用）。
    let mut virtuals: Vec<crate::mesh::MeshPeer> = virtual_peers_from(routes, &already)
        .into_iter()
        .filter(|p| !out.iter().any(|q| q.base == p.base))
        .collect();
    let added = virtuals.len();
    out.append(&mut virtuals);
    added
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
        let raw =
            format!(r#"{{"dev-abc": {{"node_id": "{OK_ID}", "addrs": ["192.168.0.105:8788"]}}}}"#);
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
        assert_eq!(
            virtual_peers_from(&routes, &Default::default()).len(),
            1,
            "空候选 ⇒ 补一个"
        );
        let seen: std::collections::HashSet<String> = ["dev-a".to_string()].into_iter().collect();
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

    /// ⭐⭐ **判据 A（2026-11-08 P0）**：LAN 已发现的设备**保留 LAN 路径** ——
    /// 即使路线表里配了同一个 `device_id`，也⛔ 不摘掉、⛔ 不替换成 relay。
    ///
    /// 这条挡的就是 P0 事故：摘掉 LAN ⇒ 中继服务器一挂，同网设备连直连都同步不了。
    #[test]
    fn a_lan_peer_keeps_its_lan_path_even_when_a_route_exists() {
        use crate::mesh::MeshPeer;
        let routes = parse_routes(&format!(
            r#"{{"dev-a": {{"node_id": "{OK_ID}", "addrs": ["192.168.0.5:8788"]}}}}"#
        ))
        .unwrap();
        let lan = MeshPeer {
            device_id: "dev-a".into(),
            base: "http://192.168.0.5:8788".into(),
        };
        let mut out = vec![lan.clone()];
        let added = merge_route_peers(&mut out, &routes);
        assert_eq!(added, 0, "LAN 已发现的设备不该再补 relay");
        assert_eq!(out, vec![lan], "LAN 候选必须原样保留（⛔ 被摘掉/替换）");
        assert!(
            !out.iter()
                .any(|p| p.base.starts_with(crate::mesh_endpoint::RELAY_BASE_PREFIX)),
            "同网设备不该出现 relay 候选（LAN 优先）"
        );
    }

    /// ⭐⭐ **判据 B**：只有路线表的跨网设备 ⇒ 补 `relay:<node_id>`；
    /// LAN 候选**一个不少、顺序不变**，relay 追加在末尾（LAN 优先）。
    #[test]
    fn a_route_only_peer_is_added_as_a_relay_fallback() {
        use crate::mesh::MeshPeer;
        let routes = parse_routes(&format!(
            r#"{{"dev-cross": {{"node_id": "{OK_ID}", "relay": "http://112.124.60.73:8880"}}}}"#
        ))
        .unwrap();
        let before = vec![
            MeshPeer {
                device_id: "dev-b".into(),
                base: "http://192.168.0.6:8788".into(),
            },
            MeshPeer {
                device_id: "dev-a".into(),
                base: "http://192.168.0.5:8788".into(),
            },
        ];
        let mut out = before.clone();
        let added = merge_route_peers(&mut out, &routes);
        assert_eq!(added, 1, "只补 LAN 没发现的那一台");
        assert_eq!(out.len(), before.len() + 1, "⛔ 不许重复拉同一台");
        assert_eq!(&out[..before.len()], &before[..], "LAN 候选原样保留在最前");
        assert_eq!(out[before.len()].device_id, "dev-cross");
        assert_eq!(
            out[before.len()].base,
            format!("{}{}", crate::mesh_endpoint::RELAY_BASE_PREFIX, OK_ID),
            "跨网对端的 base 必须是 relay:<node_id>"
        );
    }

    /// ⭐⭐ **判据 C**：路线表为空 ⇒ 候选**原样不动**（数量、内容、顺序都不变）。
    #[test]
    fn no_routes_leave_candidates_untouched() {
        use crate::mesh::MeshPeer;
        let before = vec![
            MeshPeer {
                device_id: "dev-a".into(),
                base: "http://x:1".into(),
            },
            MeshPeer {
                device_id: "dev-b".into(),
                base: "http://y:2".into(),
            },
        ];
        let mut out = before.clone();
        assert_eq!(merge_route_peers(&mut out, &[]), 0);
        assert_eq!(out, before);
    }

    /// ⭐⭐ **判据 D（LAN 集合不被缩减）**：路线表覆盖若干设备、其中有的 LAN 已发现 ——
    /// `out` 里**原有的每一条候选都还在**（base 逐字节相同），只多出 LAN 没发现的跨网设备。
    ///
    /// 读法：「relay 不可达」只影响那些**只能走 relay** 的跨网设备；
    /// LAN 候选不依赖 relay 路线表是否可达 ⇒ 中继挂了局域网照跑（P0 不变量）。
    #[test]
    fn the_route_table_never_shrinks_the_lan_candidate_set() {
        use crate::mesh::MeshPeer;
        let routes = parse_routes(&format!(
            r#"{{
                "dev-a": {{"node_id": "{OK_ID}", "addrs": ["192.168.0.5:8788"]}},
                "dev-b": {{"node_id": "{OK_ID}", "addrs": ["192.168.0.6:8788"]}},
                "dev-cross": {{"node_id": "{OK_ID}", "relay": "http://112.124.60.73:8880"}}
            }}"#
        ))
        .unwrap();
        let before = vec![
            MeshPeer {
                device_id: "dev-a".into(),
                base: "http://192.168.0.5:8788".into(),
            },
            MeshPeer {
                device_id: "dev-b".into(),
                base: "http://192.168.0.6:8788".into(),
            },
            MeshPeer {
                device_id: "dev-lan-only".into(),
                base: "http://192.168.0.9:8788".into(),
            },
        ];
        let mut out = before.clone();
        let added = merge_route_peers(&mut out, &routes);
        assert_eq!(added, 1, "只补 dev-cross 这一台跨网设备");
        assert_eq!(out.len(), before.len() + 1);
        assert_eq!(
            &out[..before.len()],
            &before[..],
            "原有候选一条都不许少 / 不许被换掉（LAN 优先）"
        );
        for p in &before {
            assert!(out.contains(p), "路线表不许缩减 LAN 集合：丢了 {p:?}");
        }
        assert_eq!(
            out.last().unwrap().device_id,
            "dev-cross",
            "跨网设备补在末尾"
        );
    }

    /// ⭐ 口径②：坏 JSON ⇒ 报错（⛔ 不当成空表）。
    #[test]
    fn broken_json_is_an_error_not_an_empty_table() {
        let err = parse_routes("{not json").expect_err("坏 JSON 必须报错");
        assert!(err.contains("不是合法 JSON"), "{err}");
    }

    /// ⭐⭐ **2026-10-25（异网寻址判据 ①）**：`relay` 字段能写、能读出来。
    #[test]
    fn a_route_may_carry_a_relay_url() {
        let raw = format!(
            r#"{{"dev-r": {{"node_id": "{OK_ID}", "relay": "http://112.124.60.73:8880"}}}}"#
        );
        let routes = parse_routes(&raw).unwrap();
        assert_eq!(routes.len(), 1);
        assert_eq!(
            routes[0].relay.as_deref(),
            Some("http://112.124.60.73:8880"),
            "relay 要原样读出来（异网寻址靠它）"
        );
        assert!(routes[0].addrs.is_empty(), "只写 relay 时 addrs 可以为空");
    }

    /// ⭐ **异网寻址判据 ②**：`relay` 写了但不是 http(s):// ⇒ 报错并点名（⛔ 不猜、不静默丢）。
    #[test]
    fn a_relay_without_scheme_is_refused_and_named() {
        let raw =
            format!(r#"{{"dev-s": {{"node_id": "{OK_ID}", "relay": "112.124.60.73:8880"}}}}"#);
        let err = parse_routes(&raw).expect_err("缺 scheme 必须报错");
        assert!(err.contains("dev-s"), "要点名是哪一条：{err}");
        assert!(err.contains("http(s)://"), "要说清正确写法：{err}");
    }

    /// ⭐ **异网寻址判据 ③**：`addrs` 与 `relay` 都不给 ⇒ 明确报"不可达"
    /// （⛔ 不许生成一个永远连不上的候选）。
    #[test]
    fn a_route_with_neither_addrs_nor_relay_is_refused() {
        let raw = format!(r#"{{"dev-u": {{"node_id": "{OK_ID}"}}}}"#);
        let err = parse_routes(&raw).expect_err("不可达必须报错");
        assert!(err.contains("dev-u") && err.contains("不可达"), "{err}");
    }
}
