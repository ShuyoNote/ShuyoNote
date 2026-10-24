//! 丙-③-b：**对等交换面** —— 客户端之间**直接**收发带戳的记录（没有中枢、没有号牌、没有账本）。
//!
//! ## 它替掉的是什么
//!
//! 甲档的交换是"客户端 ↔ 中枢/服务端"：`POST /push` ＋ `GET /pull?since=<服务端发的 seq>`，
//! 而那个 `seq` **只能由一处发**（简报 §0 的那句总结）。丙 把那条链路换成**每两台设备之间各拉各的**：
//!
//! - **游标**是**发送方自己的** `device_seq`（它那台设备的自增计数）—— ⚠️ 它是**游标，不是号牌**：
//!   **判序完全靠戳**（③-a 已经按戳判页级胜负）。用 `device_seq` 而不是戳当游标只有一个理由：
//!   它**已经是列**、单调、且**不用解析载荷**就能分页（戳在载荷里）。
//! - **服务侧只服务"我自己产生的"记录**（`WHERE device_id = 我`）—— 这就是"**没有账本**"：
//!   你不需要替别人保管历史，因为别人自己也在线上、也能被直接找到。
//! - **不转发、不中继**（简报 §7 不承诺中继）：某台离线时，它那部分等它回来说。
//!
//! ## ★ 承重判据（简报 §6 丙那一格）
//!
//! 「**没有任何设备发号牌也能收敛**：N 个对端乱序 ＋ 重复投递后，两侧投影逐字节相同；
//! 且**去掉中枢进程**之后仍然收敛。」—— 本模块末尾那条 ★★ 判据就是它：
//! 两台客户端各起一个窗口、**没有任何服务端进程**、TCP 走真环回，互换一笔改动后两侧投影逐字节相同。
//!
//! ## ⚠️ 已知缺口（写在这里，别当它不存在）
//!
//! 网格路径塞给既有 `apply` 的那个 `seq` 是**发送方自己的** `device_seq`（与今天服务端那个 `seq`
//! 同一种东西、同一个量级）。**它不参与页级胜负**（两边都带戳时按戳判），但它仍被两处**本机记账**
//! 用到：`page_crdt_pending` 的键、以及「待取回远端版本」的比较。那两处**假设 seq 全局单调**，
//! 而网格路径下**不同对端的号不可比** —— 这是 ③-b 的已知缺口，不是笔误。
//!
//! ## 本片**没做**的
//!
//! - **已经接线**（2026-09-25 ③-b-2a/2b）：命令面 `mesh_sync_now` / `mesh_set_config`、
//!   发现层循环里"开了网格的空间照样发言"（公告报的是**自己的窗口**）、同步面板那一块
//!   （保存地址 / 设口令 / 立刻交换一轮 / 关掉网格）。⚠️ 真机复验 2026-09-26 抓到一处
//!   **两个空间 id 混用**（本地 id 才是库名）⇒ 见 `ensure_window` 的头注；已修 ＋ 两条判据；
//! - 不做 NAT 穿透 / 跨网段 / 中继 / Web 参与（简报 §7 一字不改）；
//! - 不做附件的对端选择（简报 §13 的 ④）。

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::hlc;

/// 一次 pull 最多回多少条（对端可以要更少，但不许要更多）。
pub const MAX_LIMIT: i64 = 1_000;
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 8 * 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(20);

// ─────────────────────────── 过网形状（**没有号牌**） ───────────────────────────

/// 一条要发给对端的记录 —— 与客户端 `do_push` 装进 `PushRequest` 的那一项**逐字段同形**。
///
/// ⚠️ **没有 `seq`**：丙里没有那个"只能由一处发"的号。戳**在载荷里**（`_hlc` 那一项），
/// 所以这里**不再重复一份**：两个地方各存一次真相，迟早会漂（`hlc::stamp_of_payload` 是唯一读者）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeshRow {
    /// 发送方**自己的** `device_seq` —— **游标**，不是号牌（见模块头）。
    pub device_seq: i64,
    pub entity: String,
    pub entity_id: String,
    pub op: String,
    pub payload: Option<String>,
    pub updated_at: i64,
    /// ⭐ 2026-10-23（S3b，方案 `docs/plans/2026-10-23-sync-while-locked.md` §7.1）：
    /// **锁着的那台**发出来的**整条封包** —— `{entity, entity_id, op, payload}` 一起封成一个串。
    ///
    /// 为什么要有它：锁着的时候窗口**打不开空间库**，也就拿不出 `entity/entity_id/op` 这三个明文格子；
    /// 而搬运缓存里存的正是"整条封起来"的那一份 ✓ ⇒ 只能原样发出去，收侧**先解封、再走原来的路** ✓。
    ///
    /// ⚠️ 三条边界：
    /// ① **老对端不认识它** ⇒ serde 忽略这个字段（`MeshRow` 没有 `deny_unknown_fields` ✓）；
    /// ② 有它时上面四格是**空**（`entity=""`）⇒ 老对端会落进 `_` 分支"跳过但推游标" ✗ ⇒
    ///    **⛔ 绝不对不认识它的对端发**（能力协商，见 §7.1 ②）；
    /// ③ `skip_serializing_if` ⇒ 普通的记录**一个字节都不变**（老对端零感知 ✓）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sealed: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PullResponse {
    records: Vec<MeshRow>,
    /// ⭐⭐ **2026-10-20（真机：游标一旦过大就永久静默）**：服务端自己的**高水位**
    /// （它那一栏 `device_seq` 的最大值）。
    ///
    /// 为什么必须带上它：拉取的过滤是 `device_seq > since` ⇒ 只要 `since` 比对方的
    /// 最大值还大，**永远返回空、一个错都不报** ✗（今早实测：我方 cursor 卡在 245、
    /// 对方那栏最大只有 19 ⇒ 一页都拉不到，界面上只显示"收下 0 条"✓）。
    /// 有了它，客户端能**自己发现**"我越界了"并重基 ✓。
    /// ⚠️ `#[serde(default)]`：老版本对端不带这一格 ⇒ 读成 0（⇒ 客户端不敢乱重基 ✓）。
    #[serde(default)]
    max_device_seq: i64,
}

/// 服务侧：**只服务我自己产生的**记录里、游标之后的那一批（按 `device_seq` 升序）。
///
/// ★ 这条 SQL 就是"没有账本"：
/// · `device_id = ?1`（**我自己**）⇒ 别推给别人的历史不在这里，**也不需要在这里**；
/// · `device_seq > ?2` ⇒ 游标是**发送方自己的**计数；
/// · `ORDER BY … ASC LIMIT` ⇒ 一次一批、**前缀**（收侧因此可以把水位推到批尾而不漏）。
pub fn serve_own_records(
    c: &Connection,
    own_device: &str,
    since: i64,
    limit: i64,
) -> Result<Vec<MeshRow>, String> {
    let limit = if limit <= 0 { MAX_LIMIT } else { limit.min(MAX_LIMIT) };
    let mut stmt = c
        .prepare(
            "SELECT device_seq, entity, entity_id, op, payload, updated_at FROM changes
             WHERE device_id = ?1 AND device_seq > ?2
             ORDER BY device_seq ASC LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![own_device, since, limit], |r| {
            Ok(MeshRow {
                device_seq: r.get(0)?,
                entity: r.get(1)?,
                entity_id: r.get(2)?,
                op: r.get(3)?,
                payload: r.get(4)?,
                updated_at: r.get(5)?,
                // 库开着 ⇒ 一律发**明文那三格**（今天的形状，老对端零感知 ✓）
                sealed: None,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 我这一栏 `changes.device_seq` 的**高水位**（没有行 ⇒ 0）。
///
/// ⭐ **2026-10-20**：只给 `/mesh/pull` 的响应带一格用（见 `PullResponse::max_device_seq`）。
fn max_own_device_seq(c: &Connection, own_device: &str) -> Result<i64, String> {
    c.query_row(
        "SELECT COALESCE(MAX(device_seq), 0) FROM changes WHERE device_id = ?1",
        params![own_device],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

// ─────────────────────────── per-peer 水位（KV，不新开列） ───────────────────────────

fn cursor_key(space_id: &str, peer_device: &str) -> String {
    format!("mesh_cursor:{space_id}:{peer_device}")
}

/// 「我见过这台设备到哪儿了」—— 键按 **(空间, 对端设备)** 分开 ⇒ **一条对等体一个水位**。
pub fn peer_cursor(c: &Connection, space_id: &str, peer_device: &str) -> i64 {
    crate::sync::get_meta_state(c, &cursor_key(space_id, peer_device))
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0)
}

/// 推水位。**只许前进**（倒退会让已经收下的记录被再拉一遍 —— 幂等所以不错，但纯属浪费；
/// 更糟的是"水位倒退"往往是别的 bug 的症状，这里当场挡住并报出来）。
pub fn set_peer_cursor(
    c: &Connection,
    space_id: &str,
    peer_device: &str,
    seq: i64,
) -> Result<(), String> {
    let now = peer_cursor(c, space_id, peer_device);
    if seq < now {
        return Err(format!(
            "对端 {peer_device} 的水位不许倒退：现在 {now}，要写成 {seq}（挡在这里，别静默吞掉）"
        ));
    }
    crate::sync::set_meta_state(c, &cursor_key(space_id, peer_device), &seq.to_string())
}

/// ⭐⭐ **2026-10-20（真机：归零自愈写不进去）**：**坏游标**专用的重置入口 —— **允许倒退**。
///
/// 为什么必须单独开一个：上面那个 `set_peer_cursor` **拒绝倒退**（这是对的 ✓ —— 水位倒退
/// 会把已经吸收过的记录再吸收一遍）。但"越界自愈"要做的**恰恰是**把它写小 ✗
/// ⇒ 用普通入口 ⇒ 返回 `Err(…水位不许倒退…)` ⇒ 自愈**静默失败**、每轮重探一次
/// （实测：游标在库里一直是 99999，日志却在刷"归零并采用这一批" ✓）。
/// ⇒ 这个入口只允许在**已判定越界**的那两处调用（带 `healed` 标记的那两支）✓。
fn reset_peer_cursor(
    c: &Connection,
    space_id: &str,
    peer_device: &str,
    seq: i64,
) -> Result<(), String> {
    crate::sync::set_meta_state(c, &cursor_key(space_id, peer_device), &seq.to_string())
}

// ─────────────────────────── 收下（走 ③-a 那条 apply 路径） ───────────────────────────

/// 收下一批对端记录的**产物** —— **不只是计数**。
///
/// ★★ 丙-⑤（2026-09-26）：为什么不能只回 `(applied, tail)`：网格这一档**没有服务端**，
/// 也就**没有**"HTTP 应答里那份冲突清单"——`MeshRoundReport` 是用户唯一能看到的窗口。
/// 只回计数的话，"你本机那一版被远端盖掉了"这件**已经发生过的数据事件**在网格路径上
/// 一句痕迹都没有（= 静默覆盖）；而这两项正是要说的那两句话。两项都**按页去重**。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Absorbed {
    /// 这一批里被应用了几条（幂等重放也会算，与改前一致）。
    pub applied: usize,
    /// 批尾的 `device_seq`（水位推进到这里）。
    pub tail: i64,
    /// ★ 本机那一版**让给了远端**的页数（戳判远端 ＋ 本机有未推送改动）⇒ 已在覆盖前
    /// **存进版本历史**（`sync.rs` 那一刀）。用户想找回那一版，路是编辑器工具栏的「版本历史」。
    pub superseded: usize,
    /// ★ 这些页**等你裁决**（页级保留本地 ⇒ 远端那一版进了「待取回的远端版本」）。
    pub awaiting: usize,
    /// ⭐ **2026-10-17（按名融合接线）**：这一批的「同名个人空间融合」结论。
    ///
    /// ⚠️ 它是**读数**，不是业务数据：`Merged`/`AlreadyMerged` 时内容已经并进本机这一个空间；
    /// `Refused*` 时**一条都没落库、水位也没前进**（⇒ 下一轮还会再拉，⛔ 不静默丢数据）。
    pub merge: PeerMergeState,
}

/// ⭐ 一次设备直连批次的**按名融合结论**（口径见 `mesh_merge_ledger::batch_merge_gate`）。
///
/// ⚠️ 为什么是六态而不是 `bool`：**"不参与"与"明确拒绝"对已收到那一批的处置完全不同**
/// （前者照旧同步、后者一条不落库）⇒ 折成 bool 就分不出"为什么没融"。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerMergeState {
    /// 这一档**不参与**按名融合（团队/未分类/判不出类别/对面没带名字）⇒ **沿用既有按暗号同步**。
    NotEligible(crate::mesh_merge_ledger::NotEligibleWhy),
    /// ⭐ 同名个人空间 ＋ 已信任 ⇒ 账本**记下了这一笔**，内容已并入本机这一个空间。
    Merged,
    /// 同一对之前已经记过 ⇒ 幂等（⛔ 不记第二笔；内容照旧按 id 幂等应用）。
    AlreadyMerged,
    /// ⭐ **明确拒绝**（不同名／判不出身份／不同人）⇒ **这一批一条都没落库、水位没前进**。
    Refused(crate::mesh_merge_ledger::MergeGate),
    /// ⭐ 账本坏/写不进去 ⇒ **这一批一条都没落库**（没有可撤的账，就不做不可逆的事）。
    LedgerUnavailable,
    /// 这一轮**没走到融合判定**（空批 / 拉取失败那一支）—— 如实说"没发生"，⛔ 不假装。
    NotRun,
}

/// 这一批是不是**从某台对端的某个空间**来的 —— 从载荷里读"我这边管它叫什么"（`_space_name`）。
///
/// ⚠️ **读不到就 `None`**（老对端/老载荷 ✓）：那一格**只用于同名判据** ⇒ 保守取"没有"最安全
/// （⛔ 不猜、⛔ 不从 id 反推名字 ✗）。⚠️ 载荷可能是密文（推的那一侧会加密）⇒ 先解一次；
/// 解不开就按明文读（解不开的那一批在 `apply_pulled_changes` 里本来就会**整批中止**）。
fn peer_space_name_in_batch(c: &Connection, rows: &[MeshRow]) -> Option<String> {
    for r in rows {
        if r.entity != "page" || r.op != "upsert" {
            continue;
        }
        let Some(payload) = r.payload.as_deref() else { continue };
        let plain = crate::security::decrypt_payload(c, payload)
            .unwrap_or_else(|_| payload.to_string());
        if let Some(name) = crate::sync::space_name_of_payload(&plain) {
            return Some(name);
        }
    }
    None
}

/// ⭐ **融合闸的接线处**（读本机类别/名字、对面名字、信任名单 ⇒ 纯函数
/// `mesh_merge_ledger::batch_merge_gate`）—— 顺序与口径全在纯函数里，这里只负责取数。
fn peer_merge_decision(
    c: &Connection,
    rows: &[MeshRow],
    peer_device: &str,
    space_id: &str,
    device_level: bool,
) -> crate::mesh_merge_ledger::BatchMerge {
    use crate::mesh_merge_ledger::{batch_merge_gate, IdentityOracle, PairedDeviceOracle};

    let kind = crate::sync::local_space_kind(c);
    let local_name = crate::sync::local_space_name(c).unwrap_or_default();
    let peer_name = peer_space_name_in_batch(c, rows);
    // ⭐ 身份 = 第一档「本机显式信任过那台」（`mesh_paired_devices`；读法与界面/门同一处 ✓）。
    //   ⚠️ 名单读不出来 ⇒ 空名单 ⇒ 落 `Unknown(NotPaired)` ⇒ **不融合**（保守方向 ✓），并**留痕**。
    let paired: Vec<String> = match paired_devices(c, space_id, device_level) {
        Ok(v) => v.into_iter().map(|d| d.device_id).collect(),
        Err(e) => {
            eprintln!(
                "[mesh] 融合闸：信任名单读不出来 ⇒ 按「判不出是不是同一个人」处理（**不融合**）：{e}"
            );
            Vec::new()
        }
    };
    let oracle = PairedDeviceOracle { paired_devices: &paired };
    let identity = oracle.same_person(peer_device, &local_name);
    batch_merge_gate(kind, &local_name, peer_name.as_deref(), &identity)
}

/// 这一次融合要记进账本的东西（⭐ `moved` ＝ 这一批并进来的**页 id**；`kept_before` ＝ 并入前本机已有几条）。
///
/// ⚠️ **幂等键**：`对端设备 ＋ 暗号空间 ＋ 本机空间名` —— 同一对重复接入给同一个键 ⇒
/// `MergeLedger::record` 只记第一笔（语义规格 §4）✓。⚠️ 名字参与键：用户改名后是**新的一格**（可撤各算各的）。
fn peer_merge_request(
    c: &Connection,
    rows: &[MeshRow],
    peer_device: &str,
    space_id: &str,
) -> crate::mesh_merge_ledger::MergeRequest {
    let local_name = crate::sync::local_space_name(c).unwrap_or_default();
    let mut moved: Vec<String> = Vec::new();
    for r in rows {
        if r.entity == "page" && r.op == "upsert" && !moved.contains(&r.entity_id) {
            moved.push(r.entity_id.clone());
        }
    }
    let kept_before: usize = c
        .query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0) as usize;
    let idem = format!(
        "peer={};space={};name={}",
        peer_device.trim(),
        space_id.trim(),
        local_name.trim()
    );
    crate::mesh_merge_ledger::MergeRequest::personal(&local_name, peer_device)
        .moved(moved)
        .kept(kept_before)
        .idem(&idem)
        .space_id(space_id)
}

/// ⭐ 2026-10-23（S3b）：把"整条封包"（`sealed`）解开成普通 `MeshRow`，**再走原来那条路**。
///
/// 口径与"解密失败是 Fatal"同一条（`sync::ApplyFailure::Fatal`）：
/// ⛔ **解不开就整批停下**（游标不前进、一条都不落库），**绝不**当作"不认识的记录"跳过 ——
/// 那条路会把游标推到批尾，而这一条从此**永远补不回来**（方案 §7.1 的探路结论，逐字两次）。
fn unseal_rows(c: &Connection, rows: &[MeshRow]) -> Result<Vec<MeshRow>, String> {
    #[derive(serde::Deserialize)]
    struct SealedRecord {
        entity: String,
        entity_id: String,
        op: String,
        payload: Option<String>,
    }
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let Some(blob) = r.sealed.as_deref() else {
            out.push(r.clone());
            continue;
        };
        let plain = crate::security::decrypt_payload(c, blob).map_err(|e| {
            format!("封包解不开（各端钥匙可能不一致）：{e}（已停下，免得静默丢数据）")
        })?;
        let x: SealedRecord =
            serde_json::from_str(&plain).map_err(|e| format!("封包格式看不懂：{e}"))?;
        out.push(MeshRow {
            device_seq: r.device_seq,
            entity: x.entity,
            entity_id: x.entity_id,
            op: x.op,
            payload: x.payload,
            updated_at: r.updated_at,
            sealed: None,
        });
    }
    Ok(out)
}

/// 把对端给的一批收下并应用。
///
/// ★ 复用 `sync::apply_pulled_changes`（**不在这里长第二份 apply**）：它带着 ③-a 的按戳判序、
/// "一条坏变更不许连坐"、"失败要归档不留白"这些口径。
///
/// ⚠️ 交给它的 `seq`：**有戳 ⇒ 用戳的毫秒；没戳 ⇒ 用发送方的 `device_seq`**。
/// 理由与缺口见模块头「已知缺口」那一段。
///
/// ## ⭐⭐ 2026-10-17：**按名融合闸接在这里**（owner 口径：「空间名称完全一致才算同一空间，需要融合，
/// space_id 可以不同」）
/// 顺序（详见 `mesh_merge_ledger::batch_merge_gate`）：**先类别 → 再身份 → 后名字**。
/// - ⭐ **同名个人空间 ＋ 本机信任过那台** ⇒ 记一笔账（⛔ 不重复记）＋ 把这批并进**本机这一个空间**
///   （保留本机 `space_id` 与名字 ✓ —— 落库时 `doc_content::upsert_remote` 会把
///   `workspace_id` 锚到本机这一格）；
/// - ⭐ **不同名 / 判不出同一个人** ⇒ ⛔ **一条都不落库、水位不前进**（`tail = 0`）并留痕 ——
///   ⚠️ 这是**行为变化**：以前「按暗号匹配上就收」不看名字；owner 的口径是"名字不完全一致就不算同一空间"
///   ⇒ 宁可停下来让人看见，也不把两个不同名的空间悄悄并在一起（少合 ＋ 可撤 ✓ ／ 多合 ＝ 不可逆 ✗）；
/// - ⭐ **团队/未分类/类别读不出/对面没带名字** ⇒ **不参与**按名融合，**照旧按暗号同步**（⛔ 不回归）。
pub fn absorb_peer_batch(
    c: &Connection,
    rows: &[MeshRow],
    peer_device: &str,
    space_id: &str,
    device_level: bool,
) -> Result<Absorbed, String> {
    if rows.is_empty() {
        return Ok(Absorbed {
            applied: 0,
            tail: 0,
            superseded: 0,
            awaiting: 0,
            merge: PeerMergeState::NotRun,
        });
    }
    // ⭐ 2026-10-23（S3b）：**先解封、再走完全一样的那条路**（合并闸、应用、水位都在下面原封不动）。
    //   ⚠️ 解不开 ⇒ 直接 `?` 出去（整批不落库、水位不前进）—— ⛔ 绝不当成"不认识的记录"跳过：
    //      那条路会把游标推到批尾，而这一条就**永远补不回来**了（§7.1 的探路结论）。
    let unsealed;
    let rows: &[MeshRow] = if rows.iter().any(|r| r.sealed.is_some()) {
        unsealed = unseal_rows(c, rows)?;
        &unsealed
    } else {
        rows
    };
    let incoming: Vec<crate::sync::IncomingChange> = rows
        .iter()
        .map(|r| {
            let seq = match r.payload.as_deref().map(hlc::stamp_of_payload) {
                Some(hlc::PayloadStamp::Ok(s)) => s.wall_ms(),
                _ => r.device_seq,
            };
            crate::sync::IncomingChange {
                seq,
                entity: r.entity.clone(),
                entity_id: r.entity_id.clone(),
                op: r.op.clone(),
                payload: r.payload.clone(),
                updated_at: r.updated_at,
            }
        })
        .collect();
    let now = crate::db::now_ms();

    // ⭐ 融合闸：先取证（只读），再决定这一批的处置。
    let merge = match peer_merge_decision(c, rows, peer_device, space_id, device_level) {
        crate::mesh_merge_ledger::BatchMerge::Refuse(gate) => {
            eprintln!(
                "[mesh] **不融合**（{}）：对端 `{}` 的这一批 {} 条**一条都不落库、水位不前进** \
                 ⇒ 下一轮还会再拉（如实停下，不把两个不同名的空间悄悄并在一起）。\
                 口径：owner 2026-10-17「空间名称完全一致才算同一空间，需要融合，space_id 可以不同」",
                gate_reason(gate),
                peer_device,
                rows.len()
            );
            return Ok(Absorbed {
                applied: 0,
                tail: 0,
                superseded: 0,
                awaiting: 0,
                merge: PeerMergeState::Refused(gate),
            });
        }
        crate::mesh_merge_ledger::BatchMerge::NotEligible(why) => {
            eprintln!(
                "[mesh] 这一批**不参与按名融合**（{}）⇒ 沿用既有「按暗号」同步（{} 条照旧处理）",
                not_eligible_reason(why),
                rows.len()
            );
            PeerMergeState::NotEligible(why)
        }
        crate::mesh_merge_ledger::BatchMerge::Allow => {
            // ⭐⭐ **先记账、再落库**：账本是"可撤"的唯一凭据 ⇒ 记不上就不做不可逆的事。
            //   ⚠️ 顺序反过来（先落库、后记账）时账本一坏就变成"并了但撤不回去"（不可逆 ✗）。
            match crate::sync::merge_ledger_record(
                c,
                now,
                &peer_merge_request(c, rows, peer_device, space_id),
            ) {
                Ok(crate::mesh_merge_ledger::MergeOutcome::Recorded(rec)) => {
                    eprintln!(
                        "[mesh] **同名个人空间融合**：对端 `{}` 的空间名＝本机「{}」⇒ 这一批 {} 条并入本机这一个空间\
                         （本机 space_id／名字保持不变）；账本记下第 #{} 笔（可撤销）",
                        peer_device,
                        crate::sync::local_space_name(c).unwrap_or_default(),
                        rows.len(),
                        rec.id
                    );
                    PeerMergeState::Merged
                }
                // 同一对重复接入 ⇒ 只记一笔（内容照旧按 id 幂等应用）。
                Ok(crate::mesh_merge_ledger::MergeOutcome::SkippedDuplicate(_)) => {
                    PeerMergeState::AlreadyMerged
                }
                // 「永久不分离」⇒ 今后不再每次记账（内容照旧幂等应用）。
                Ok(crate::mesh_merge_ledger::MergeOutcome::SkippedPermanent(_)) => {
                    PeerMergeState::AlreadyMerged
                }
                Err(e) => {
                    eprintln!(
                        "[mesh] **融合账本坏 / 写不进去** ⇒ 这一批**一条都不落库**\
                         （没有可撤的账，就不做不可逆的事；如实停下）：{e}"
                    );
                    return Ok(Absorbed {
                        applied: 0,
                        tail: 0,
                        superseded: 0,
                        awaiting: 0,
                        merge: PeerMergeState::LedgerUnavailable,
                    });
                }
            }
        }
    };

    // ⭐ **设备直连（网格）** ⇒ `Ingest::Peer`（⛔ 不是服务器那条路）—— 两条路的材料在
    //   `sync::apply_pulled_changes` 会合，所以"这一笔是从对端来的"必须由**调用方显式说**
    //   （口径见 `doc_content::Ingest`；作用范围见
    //   `docs/specs/2026-10-09-multidevice-merge-semantics.md` §2「作用范围」）。
    let out = crate::sync::apply_pulled_changes(
        c,
        incoming,
        0,
        now,
        crate::doc_content::Ingest::Peer,
    )?;
    let tail = rows.iter().map(|r| r.device_seq).max().unwrap_or(0);
    Ok(Absorbed {
        applied: out.count,
        tail,
        superseded: out.superseded_page_ids.len(),
        awaiting: out.pending_remote_ids.len(),
        merge,
    })
}

/// 拒绝理由的人话（⭐ 三种拒绝**分得开**，排障要看得出是哪一种）。
fn gate_reason(gate: crate::mesh_merge_ledger::MergeGate) -> &'static str {
    use crate::mesh_merge_ledger::MergeGate;
    match gate {
        MergeGate::Allow => "允许（不该走到这里）",
        MergeGate::RefuseDifferentName => "名字不一样（trim 后不是逐字相等）",
        MergeGate::RefuseUnknownIdentity => "判不出是不是同一个人（这台不在本机信任名单里）",
        MergeGate::RefuseDifferentPerson => "判得出、但不是同一个人",
    }
}

/// "不参与"的人话（⭐ 与"拒绝"分开：不参与 ⇒ 照旧同步）。
fn not_eligible_reason(why: crate::mesh_merge_ledger::NotEligibleWhy) -> &'static str {
    use crate::mesh_merge_ledger::{NotEligibleWhy, SpaceKind};
    match why {
        NotEligibleWhy::NotPersonal(SpaceKind::Personal) => "个人空间（不该走到这里）",
        NotEligibleWhy::NotPersonal(SpaceKind::Team) => "团队空间不参与（一个字节都不动）",
        NotEligibleWhy::NotPersonal(SpaceKind::Unclassified) => "未分类空间不参与（一个字节都不动）",
        NotEligibleWhy::KindUnknown => "本机这一格的类别读不出来 ⇒ 判不出（⛔ 不默认成个人空间）",
        NotEligibleWhy::NoPeerName => "对面载荷里没带空间名（老对端/老载荷）⇒ 判不了同名",
    }
}

// ─────────────────────────── 纯函数：这次要拉哪些对端 ───────────────────────────

/// 一个可以被直接拉的对等体。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeshPeer {
    pub device_id: String,
    pub base: String,
}

/// ★ **一台对端能不能被直接拉**（＝可以被邀请）—— **唯一的一把尺**，返回它的基址。
///
/// 三条过滤（顺序即口径）：**不是我自己** · **它代言这个空间** · **它的基址是局域网地址**
/// （`lan::is_lan_base`；公网地址一律不当网格对端 —— 简报 §7 的边界）。
///
/// ⚠️ 为什么抽出来（2026-09-29，丙档「附近设备」）：**两个调用方要问同一句话** ——
/// [`mesh_peers`]（这一轮拉谁）与 `sync::NearbyPeer::invitable`（界面上那一行有没有「邀请」）。
/// 各写一遍就会漂，而漂的表现是"列表里有「邀请」按钮，点了却拉不动"（或反过来：
/// 能拉的没有按钮）—— **不炸、不报错、单测全绿**。
/// 承重判据：`sync::tests` 里那条"`nearby.filter(invitable)` 的集合 == `mesh_peers` 的集合"。
pub fn invitable_base(space_id: &str, my_device: &str, p: &crate::lan::Peer) -> Option<String> {
    invitable_base_for(space_id, "", my_device, p)
}

/// ⭐⭐ **2026-10-19（owner 重申「个人空间严格按空间名称自动同步」· B1 步三）**：
/// 与 [`invitable_base`] 同一条，但**多一把"名字"的尺** —— 判定顺序：
///
/// 1. ⭐ **对端报了空间名** ⇒ **只看名字**（`lan::serves_space_name`，逐字 trim 相等）；
///    ⚠️ 这一支下**同 id 不同名也不许挑中** ✗ —— 那正是「严格按空间名称」的可核形状。
/// 2. ⭐ **对端没报名字**（老版本）⇒ 回落到 **id**（`lan::serves_space`）✓ ——
///    ⛔ 不许因为"对面没报名字"就把老版本整个排除掉（那会把升级期变成断连）。
/// 3. `space_name` 为空（团队档／还没取到名字）⇒ 回落到 id ✓（团队空间本来就不参与按名融合）。
pub fn invitable_base_for(
    space_id: &str,
    space_name: &str,
    my_device: &str,
    p: &crate::lan::Peer,
) -> Option<String> {
    let id = p.announce.device_id.trim();
    if id.is_empty() || id == my_device.trim() {
        return None;
    }
    // ★ 「服务这个空间」这一关与地址解析共用**同一把尺**（`lan::serves_space`）。
    // ★ 「服务这个空间」这一关与地址解析共用**同一把尺**。
    // ⭐⭐ **2026-10-19 回滚（真机读数驱动）**：⭐ 这里原来"对端报了名字就只看名字" ✗ ——
    //   实测（windows↔AMD）：对端公告**收到了**（`✅ 与本机空间匹配`），但后台轮次**候选 0**，
    //   因为我这一格的本机空间名与对端报的名字**不同**（房间档下它们根本不是同一个名字），
    //   ⇒ 名字这把尺把"能说话的对端"直接筛掉了 ✗。
    //   ⇒ **挑选对端回到 id/房间**（传输作用域）✓；名字只用在**落库那一层**
    //   （`mesh_merge_ledger::batch_merge_gate`）—— 那才是"同名才融合"该待的地方 ✓。
    //   ⚠️ `space_name` 参数**保留**（公告里那格照发、将来"多空间路由"要用），但⛔ 不参与挑选。
    let _ = space_name;
    if !crate::lan::serves_space(space_id, p) {
        return None;
    }
    let base = p.announce.hub_base.as_deref().map(str::trim).filter(|b| !b.is_empty())?;
    if !crate::lan::is_lan_base(base) {
        return None;
    }
    Some(base.trim_end_matches('/').to_string())
}

/// 从发现层那张表里挑出**这次要拉的对象** —— 纯函数（判据不打桩、不看真实网络）。
///
/// 三条过滤见 [`invitable_base`]（**它就是那三条**，本函数不再自己写一遍）。
///
/// ⚠️ 这里用的是甲-1 那块砖（`LanAnnounce` 的 `hub_base` / `hub_spaces`）：**发现层三档共用**，
/// 丙 只是把"谁在代言"读成"谁可以被直接拉"。
pub fn mesh_peers(space_id: &str, my_device: &str, peers: &[crate::lan::Peer]) -> Vec<MeshPeer> {
    mesh_peers_by_name(space_id, "", my_device, peers)
}

/// ⭐ **2026-10-19（B1 步三）**：[`mesh_peers`] 的**按名**版本 —— 个人空间用这个：
/// 对端报了名字就**只看名字**（`invitable_base_for`），没报名字的老对端回落到 id。
/// ⚠️ `space_id` 仍然要：它挡"空空间"（一条都不拉），也是回落那一支的判据。
pub fn mesh_peers_by_name(
    space_id: &str,
    space_name: &str,
    my_device: &str,
    peers: &[crate::lan::Peer],
) -> Vec<MeshPeer> {
    if space_id.trim().is_empty() && space_name.trim().is_empty() {
        return Vec::new();
    }
    let mut out: Vec<MeshPeer> = Vec::new();
    for p in peers {
        let Some(base) = invitable_base_for(space_id, space_name, my_device, p) else {
            continue;
        };
        let id = p.announce.device_id.trim();
        if out.iter().any(|q| q.device_id == id || q.base == base) {
            continue; // 同一台 / 同一个地址只拉一次
        }
        out.push(MeshPeer { device_id: id.to_string(), base });
    }
    out.sort_by(|a, b| a.device_id.cmp(&b.device_id)); // 确定性（判据要能逐字节比）
    out
}

// ─────────────────────────── 拉的那一侧 ───────────────────────────

/// 拉一台对端**自己**的记录（游标之后的那一批）。
///
/// ⭐ **2026-10-12（设备身份第 2 步）**：多一个 `auth` ✗（⭐ `(device_id, ts_ms, sig_hex)` ✓）——
/// ⚠️ **由调用方签好再传进来** ✗：签名要拿库锁 ✓，而这里在 await 里 ⇒ ⛔ 不许跨 await 持锁 ✗（本仓老规矩 ✓）。
/// ⚠️ 签名**过不过**是**对面**的事 ✓：⭐ 这一侧照样把口令也带上 ✓（⭐ 过渡期两档并存 ✓，
/// 见 `authorized` 那段"等 owner 选 ⓒ 时怎么改"✓）。
pub async fn pull_from_peer(
    client: &reqwest::Client,
    peer: &MeshPeer,
    space_id: &str,
    since: i64,
    token: Option<&str>,
    auth: Option<(&str, i64, &str)>,
    // ⭐ 2026-10-23（S3b-发）：本机空间名的哈希 ⇒ 对端锁着时按它找回"该发哪一份"
    //   （空串 ＝ 这次调用不带：判据/探针用 ✓）。
    name_sha: &str,
) -> Result<(Vec<MeshRow>, i64), String> {
    // ⚠️ target **只拼一次** ✗：⭐ 签的是它、发的也是它 ✓（⛔ 两处各拼一份 ⇒ 一漂就验不过 ✗）。
    let target = pull_target(space_id, since, name_sha);
    let url = format!("{}{}", peer.base.trim_end_matches('/'), target);
    let mut req = client.get(&url);
    if let Some((device_id, ts, sig)) = auth {
        req = req
            .header(HDR_DEVICE, device_id)
            .header(HDR_TS, ts.to_string())
            .header(HDR_SIG, sig);
    }
    if let Some(t) = token.map(str::trim).filter(|t| !t.is_empty()) {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.map_err(|e| {
        // ⚠️ `reqwest::Error` 的 `Display` **只有** "error sending request for url (…)" ——
        // 真正的原因（连接被拒 / 半截响应 / …）挂在 `source()` 链上。这里**逐层接出来**：
        // "拉不动"最要紧的就是"为什么"，把原因丢掉等于让人猜（10 台那一档的排查就卡在这）。
        let mut why = e.to_string();
        let mut cur: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(&e);
        while let Some(s) = cur {
            why.push_str(" ← ");
            why.push_str(&s.to_string());
            cur = s.source();
        }
        format!("拉对端 {} 失败：{why}", peer.device_id)
    })?;
    if !resp.status().is_success() {
        return Err(format!("对端 {} 回了 {}", peer.device_id, resp.status()));
    }
    let body: PullResponse = resp.json().await.map_err(|e| e.to_string())?;
    // ⚠️ 老对端不带 `max_device_seq` ⇒ 0（`serde(default)`）⇒ 调用方**不会**据此重基 ✓
    Ok((body.records, body.max_device_seq))
}

/// 一轮对等交换的结果（给人看的读数，不是业务数据）。
///
/// ⚠️ **失败也在这里**：一只对端拉不动**不许**把整轮打断（别的对端、别的空间照拉）——
/// 这与同步主路那条"一条坏变更不连坐整批"是同一条纪律。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerPullReport {
    pub peer: String,
    pub fetched: usize,
    pub applied: usize,
    pub cursor: i64,
    /// ⭐ **2026-10-20**：对端那一栏的**高水位**（拉取响应带回来的）。
    /// 用来判「游标是不是越界了」；#[serde(skip)] ⇒ 界面契约一个字都不变 ✓
    #[serde(skip)]
    pub max_seq: i64,
    /// ★★ 丙-⑤：这一轮里**本机那一版让给了远端**的页数（⇒ 已在覆盖前存进**版本历史**）。
    /// 见 [`Absorbed::superseded`] —— 网格这一档没有服务端那份冲突清单，这一项就是全部凭证。
    pub superseded: usize,
    /// ★★ 丙-⑤：这一轮里**等你裁决**的页数（⇒ 远端那一版进了「待取回的远端版本」）。
    pub awaiting: usize,
    /// ⭐ **2026-10-09（task-8）**：这一轮**真的拉回来了**的那些条（逐条 `entity` / `entity_id` / `op` ✓）。
    ///
    /// 用途**只有一个**：`mesh_sync_now` 拿它写 `sync_history` 的「N 项明细」✓ —— 在它之前，
    /// 网格这一档**一个字都不进历史**（`write_sync_history` 只挂在服务器那条路上 ✗）⇒
    /// 用户在「同步历史」里**永远看不到设备直连发生过什么**，验收判据
    /// 「`sync_history` 出现经设备直连的记录」也就**永远不可能成立** ✓。
    ///
    /// ⚠️ `#[serde(skip)]`：**不进 JSON** ✗ ⇒ `commands.ts` 里 `MeshRoundReport` 的契约
    /// **一个字都不变** ✓（明细走历史那条路，界面读的是 `list_sync_history` ✓）。
    /// 标题用 `sync::item_title`（与服务器那条路**同一个函数** ✓ —— 两处各写一遍迟早漂 ✓）。
    #[serde(skip)]
    pub items: Vec<crate::sync::SyncItem>,
    /// ⭐ **2026-10-17（按名融合接线）**：这一台的这一批**融没融**（见 [`PeerMergeState`]）。
    ///
    /// ⚠️ `#[serde(skip)]`：**不进 JSON** ✗ ⇒ `commands.ts` 里 `MeshRoundReport` 的契约**一个字都不变** ✓；
    /// 它今天只服务判据与日志（面板那两格「已融合／未融合」是**下一笔**的界面事）。
    #[serde(skip)]
    pub merge: PeerMergeState,
    /// 拉不动时**如实写在这里**（`None` ＝ 这一台这一轮没问题）。
    pub error: Option<String>,
}

/// 一轮对等交换的**总读数**（`mesh_sync_now` 回给界面的就是它）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshRoundReport {
    /// 网格这一档现在**能不能用** —— 判据是"配没配监听地址"（见 [`settings`]）。
    pub enabled: bool,
    /// **说得出为什么**：用户要能分辨"没开"／"开了但网段里没人"／"有人但都拉不动"这三件
    /// 处置完全不同的事（与甲-1 状态行同一条口径）。
    pub note: String,
    /// 发现层里**够格当网格对端**的台数（＝下面 `peers` 的行数）。
    pub candidates: usize,
    pub peers: Vec<PeerPullReport>,
    /// 本机窗口**实际**绑在哪儿（没开 ⇒ `None`）。⚠️ 它由**命令面**填（`round` 本身不开窗）。
    pub window: Option<String>,
}

/// 这一轮**改到了哪些页**（只读读数：给"同步完刷新当前页"那件事用）。
///
/// ⭐ 2026-10-24（真机：同页并发后两边各缺一块）：网格拉取是 **Rust 后台轮**干的，
/// 应用完远端页**不给前端任何通知** ⇒ 编辑器里那份旧 doc 之后一保存，就把刚并进来的块盖掉。
/// 服务器那条路有 SSE 通知；网格这条路没有 ⇒ 这里给出"改了哪几页"，由命令面/后台轮
/// emit `mesh-applied` 事件，前端收到后刷新当前页（与自动同步那一轮同一套节流）。
///
/// ⚠️ 只收 `page/upsert`：附件/其它实体不动编辑器；
/// ⚠️ `applied == 0 && superseded == 0 && awaiting == 0` 的 peer 整台跳过（它这一轮没改任何东西）。
pub fn round_touched_pages(r: &MeshRoundReport) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in &r.peers {
        if p.applied == 0 && p.superseded == 0 && p.awaiting == 0 {
            continue;
        }
        for it in &p.items {
            if it.entity == "page"
                && it.op == "upsert"
                && !out.iter().any(|x| x == &it.entity_id)
            {
                out.push(it.entity_id.clone());
            }
        }
    }
    out
}

/// 跟**一台**对端交换一轮：读水位 ⇒ 拉 ⇒ 收下 ⇒ **水位推进到批尾**。
///
/// ⚠️ 锁**不跨 `await`**：读一次、放掉、拉完再拿一次（否则一次网络卡顿会把整个库锁住）。
/// ⚠️ 签名收的是 `&Mutex<Connection>`（不是 `Arc`）：窗口那一侧需要 `Arc` 来跨线程持有，
/// **客户端这一侧不需要** —— 而 `State<'_, Db>` 给的正好是一个 `&Mutex<Connection>`。
pub async fn pull_and_absorb(
    conn: &Mutex<Connection>,
    client: &reqwest::Client,
    peer: &MeshPeer,
    space_id: &str,
    token: Option<&str>,
    // ⭐ **2026-10-17（按名融合接线）**：⭐ 由**调用方**从 `mesh_scope` 传进来（⛔ 不在这里反推）——
    //   它只用来选「信任名单是哪一行」（`paired_row_key`，个人档＝空串那一行 ✓）。
    device_level: bool,
) -> Result<PeerPullReport, String> {
    let since = {
        let g = conn.lock().map_err(|_| "空间库的锁被毒掉了".to_string())?;
        peer_cursor(&g, space_id, &peer.device_id)
    };
    // ⭐ 2026-10-23（S3b-发）：本机空间名的哈希 —— 对端**锁着**的时候，它靠这一格找回
    //   "该发我哪一个空间的那一份"（一个房间里可能挤着多个个人空间 ✓）。
    //   ⚠️ 拿不到名字 ⇒ 空串（对端若锁着会回 400 并说明原因，⛔ 不猜 ✗）。
    let name_sha = {
        let g = conn.lock().map_err(|_| "空间库的锁被毒掉了".to_string())?;
        match crate::sync::local_space_name(&g) {
            Some(n) if !n.trim().is_empty() => crate::db::sha256_hex(n.trim()),
            _ => String::new(),
        }
    };
    // ⭐⭐ **2026-10-20（真机：游标越界 ⇒ 永久静默）**：先按原游标拉；若发现
    //   **对端高水位 < 我的游标** ⇒ 说明这格游标不是"对方那条计数"里的值（历史遗留 / 换了空间）
    //   ⇒ **归零重拉一次**，并如实记一行（⛔ 不静默、⛔ 不每次轮都重拉：只在这一情形下发生 ✓）。
    let mut healed = false;
    let (mut rows, mut max_seq) = {
        // ⭐ 签名要在**拿锁的那一小段**里算好 ✗（⛔ 不许跨 await 持锁 ✗）；拿不到身份 ⇒ `None` ✓
        //   （⭐ 那就只剩口令那一档 ✓ —— 与今天逐字相同 ✓）。
        let auth = {
            let g = conn.lock().map_err(|_| "空间库的锁被毒掉了".to_string())?;
            let device_id = crate::sync::device_id(&g).unwrap_or_default();
            if device_id.trim().is_empty() {
                None
            } else {
                let target = pull_target(space_id, since, &name_sha);
                sign_request(&g, &device_id, space_id, "GET", &target, crate::db::now_ms())
                    .map(|(ts, sig)| (device_id, ts, sig))
            }
        };
        let auth_ref = auth.as_ref().map(|(d, t, s)| (d.as_str(), *t, s.as_str()));
        pull_from_peer(client, peer, space_id, since, token, auth_ref, &name_sha).await?
    };
    // ⭐ 游标越界 ⇒ 归零重拉一次（只重拉一次；还得再拿锁算签名 ⇒ 与上面同一套）
    if max_seq > 0 && since > max_seq {
        eprintln!(
            "[mesh] ⚠️ 游标越界：我方 since={since} > 对端高水位 {max_seq}（这一格游标不是{}的计数）⇒ 归零重拉一次",
            peer.device_id
        );
        {
            let g = conn.lock().map_err(|_| "空间库的锁被毒掉了".to_string())?;
            reset_peer_cursor(&g, space_id, &peer.device_id, 0)?;
        }
        let auth = {
            let g = conn.lock().map_err(|_| "空间库的锁被毒掉了".to_string())?;
            let device_id = crate::sync::device_id(&g).unwrap_or_default();
            if device_id.trim().is_empty() {
                None
            } else {
                let target = pull_target(space_id, 0, &name_sha);
                sign_request(&g, &device_id, space_id, "GET", &target, crate::db::now_ms())
                    .map(|(ts, sig)| (device_id, ts, sig))
            }
        };
        let auth_ref = auth.as_ref().map(|(d, t, s)| (d.as_str(), *t, s.as_str()));
        let again = pull_from_peer(client, peer, space_id, 0, token, auth_ref, &name_sha).await?;
        rows = again.0;
        max_seq = again.1.max(max_seq);
    }
    // ⭐⭐ **2026-10-20（旧对端不带 `max_device_seq`）**：**冷探针**。
    //   情形：`since > 0`、这次一条没拉到、对端又没报高水位（老版本）⇒
    //   "真的没有新东西"和"我的游标越界了"**长得一模一样** ✗ ⇒ 问一次 `since=0`：
    //     · 探针回来的最大 `device_seq` **≤ 我方游标** ⇒ 游标确实越界 ⇒ **归零并采用这一批** ✓
    //     · 否则 ⇒ 只是没有新东西 ⇒ **游标原样**（⛔ 不把老历史重新并一遍）✓
    //   ⚠️ 有冷却（10 分钟一格/一对端）：⛔ 不许每轮都探（那等于每轮重读一遍历史）✗
    if rows.is_empty() && max_seq == 0 && since > 0 {
        const PROBE_COOLDOWN_MS: i64 = 10 * 60 * 1000;
        let mut last: i64 = 0;
        {
            let g = conn.lock().map_err(|_| "空间库的锁被毒掉了".to_string())?;
            last = read_setting(
                &g,
                &format!("mesh_cursor_probe:{}", space_id),
                &peer.device_id,
            )
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        }
        let now = crate::db::now_ms();
        if now - last > PROBE_COOLDOWN_MS {
            {
                let g = conn.lock().map_err(|_| "空间库的锁被毒掉了".to_string())?;
                write_setting(
                    &g,
                    &format!("mesh_cursor_probe:{}", space_id),
                    &peer.device_id,
                    Some(&now.to_string()),
                )?;
            }
            let auth = {
                let g = conn.lock().map_err(|_| "空间库的锁被毒掉了".to_string())?;
                let device_id = crate::sync::device_id(&g).unwrap_or_default();
                if device_id.trim().is_empty() {
                    None
                } else {
                    let target = pull_target(space_id, 0, &name_sha);
                    sign_request(&g, &device_id, space_id, "GET", &target, crate::db::now_ms())
                        .map(|(ts, sig)| (device_id, ts, sig))
                }
            };
            let auth_ref = auth.as_ref().map(|(d, t, s)| (d.as_str(), *t, s.as_str()));
            // ⚠️ 探针**不许静默**：进没进、回来几条、错在哪 —— 都要看得见 ✓
            //   （第一版用 `if let Ok` 把 Err 吞了 ⇒ 现场只看到"什么也没发生" ✗）
            let probe = pull_from_peer(client, peer, space_id, 0, token, auth_ref, &name_sha).await;
            let probe_rows = match probe {
                Err(e) => {
                    eprintln!(
                        "[mesh {}] ⚠️ 冷探针失败（不影响本轮）：{e}",
                        crate::db::now_ms()
                    );
                    Vec::new()
                }
                Ok((r, _)) => r,
            };
            eprintln!(
                "[mesh {}] 冷探针：since={since}（越界候选）⇒ 探到 {} 条",
                crate::db::now_ms(),
                probe_rows.len()
            );
            {
                let tail = probe_rows.iter().map(|r| r.device_seq).max().unwrap_or(0);
                if tail > 0 && tail <= since {
                    eprintln!(
                        "[mesh {}] ⚠️ 冷探针：我方 since={since} 但{}那一栏最高只有 {tail} ⇒ 游标越界 ⇒ 归零并采用这一批（{} 条）",
                        crate::db::now_ms(),
                        peer.device_id,
                        probe_rows.len()
                    );
                    {
                        let g = conn.lock().map_err(|_| "空间库的锁被毒掉了".to_string())?;
                        reset_peer_cursor(&g, space_id, &peer.device_id, 0)?;
                    }
                    healed = true;
                    rows = probe_rows;
                    max_seq = tail;
                }
            }
        }
    }

    let fetched = rows.len();
    // ⭐ 2026-10-09（task-8）：把**这一批真的换过来的条**留给 `sync_history` 的明细 ✓。
    //    ⚠️ 与服务器那条路同一口径（`sync::item_title` ✓）、同一条 dir＝`"pull"`（网格这一轮只拉 ✓）。
    let items: Vec<crate::sync::SyncItem> = rows
        .iter()
        .map(|r| crate::sync::SyncItem {
            entity: r.entity.clone(),
            entity_id: r.entity_id.clone(),
            op: r.op.clone(),
            dir: "pull".to_string(),
            title: crate::sync::item_title(&r.entity, r.payload.as_ref()),
        })
        .collect();
    let g = conn.lock().map_err(|_| "空间库的锁被毒掉了".to_string())?;
    let ab = absorb_peer_batch(&g, &rows, &peer.device_id, space_id, device_level)?;
    // ⭐ 2026-10-20：**归零自愈过的那一轮必须无条件写回** ✗ ——
    //   原规则是 `ab.tail > since`，而 since 还是那个越界值（99999）⇒ 恒 false
    //   ⇒ 数据库里那格**永远是 99999** ⇒ 每轮都要重新探一次（实测就是这么被咬的 ✓）。
    if healed {
        // ⭐ 自愈那一支**允许倒退**（否则 `ab.tail < since` 会被"水位不许倒退"挡住 ⇒ 白修）
        reset_peer_cursor(&g, space_id, &peer.device_id, ab.tail)?;
    } else if ab.tail > since {
        set_peer_cursor(&g, space_id, &peer.device_id, ab.tail)?;
    }
    Ok(PeerPullReport {
        peer: peer.device_id.clone(),
        fetched,
        applied: ab.applied,
        cursor: if healed { ab.tail } else { ab.tail.max(since) },
        max_seq,
        superseded: ab.superseded,
        awaiting: ab.awaiting,
        items,
        merge: ab.merge,
        error: None,
    })
}

// ─────────────────────────── 控制面：网格开不开、口令牌、一轮交换 ───────────────────────────

/// 网格这一档的设置（都放 `meta.sync_state` 的 KV，**不新开 schema 列**）。
///
/// ★ **"开"的定义只有一个**：**配了监听地址**。没配 ⇒ 整档关着（不猜默认端口 ——
/// 悄悄开一个口比不开更糟）。口令可选；没有口令时窗口会用**很大声**的日志说明这是不设防的。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MeshSettings {
    /// `IP:端口`（或 `localhost:端口`）。`None`/空 ⇒ **网格这一档没开**。
    pub bind: Option<String>,
    /// 对端要带的口令（可选）。⚠️ 口令的**来源与形状**与 B 片（成员凭证）同批设计，本片只留格子。
    pub token: Option<String>,
}

fn setting_key(prefix: &str, space_id: &str) -> String {
    format!("{prefix}:{space_id}")
}

fn read_setting(c: &Connection, prefix: &str, space_id: &str) -> Option<String> {
    crate::sync::get_meta_state(c, &setting_key(prefix, space_id))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 空串 ＝ **关**（用空串当"清除"，省掉一个 KV 删除接口；`read_setting` 两侧都按空当没有）。
fn write_setting(c: &Connection, prefix: &str, space_id: &str, value: Option<&str>) -> Result<(), String> {
    let v = value.map(str::trim).unwrap_or("");
    crate::sync::set_meta_state(c, &setting_key(prefix, space_id), v)
}

// ─────────────────────── ⭐ 设备级（owner 2026-10-11 拍） ───────────────────────

/// ⭐⭐ **设备级那一格的键 ＝ `space_id` 为空** ✗（方案 §9.1 ✓）。
///
/// ⛔ **不新造键** ✗：个人空间在生产里**就是**按"`space_id` 空"认的 ✓
/// （`sync.rs:909 / 1071 / 1093 / 2108` ✓）⇒ ⭐ 语义自然对上 ✓，
/// 而 `'ws-personal'` 那种名字**只活在测试夹具里** ✗ ⇒ 拿它当键就得造一个假工作区 ✓（那是歪的 ✓）。
pub const DEVICE_LEVEL_SPACE: &str = "";

/// ⭐ **设备级读取面** ✗：个人档 ⇒ 一律读"空 `space_id`"那一格 ✓；⭐ 团队档 ⇒ 照旧读它自己的 `space_id` ✓。
///
/// ⚠️ 个人档**回退**读旧的"按暗号那一格"✓（⭐ 只读、⛔ 不写 ✗）：升级上来的机器**第一次读就看得见旧值** ✓
/// —— 迁移只发生在写路径 ✓（[`migrate_device_level_mesh`] ✓），⛔ 读路径一个字节都不写 ✓。
pub fn settings_for(c: &Connection, space: &str, device_level: bool) -> MeshSettings {
    let key = if device_level { DEVICE_LEVEL_SPACE } else { space };
    let mut bind = read_setting(c, "mesh_bind", key);
    let mut token = read_setting(c, "mesh_token", key);
    if device_level {
        if bind.is_none() {
            bind = read_setting(c, "mesh_bind", space);
        }
        if token.is_none() {
            token = read_setting(c, "mesh_token", space);
        }
    }
    MeshSettings { bind, token }
}

/// ⭐ 写侧**同口径** ✓（个人档 ⇒ 一律写"空 `space_id`"那一格 ✓）。
pub fn set_mesh_bind_for(
    c: &Connection,
    space: &str,
    device_level: bool,
    bind: Option<&str>,
) -> Result<(), String> {
    let key = if device_level { DEVICE_LEVEL_SPACE } else { space };
    write_setting(c, "mesh_bind", key, bind)
}

/// ⭐ 同 [`set_mesh_bind_for`] ✓。
pub fn set_mesh_token_for(
    c: &Connection,
    space: &str,
    device_level: bool,
    token: Option<&str>,
) -> Result<(), String> {
    let key = if device_level { DEVICE_LEVEL_SPACE } else { space };
    write_setting(c, "mesh_token", key, token)
}

/// ⭐⭐ **2026-10-11（owner 补拍「丙」）：对端表那一行的键** ✗。
///
/// ```text
/// ⭐ 个人档 ⇒ DEVICE_LEVEL_SPACE（空串 ✓）—— "这台设备认过谁" ＝ 一份 ✓（撤回 ＝ 本机从此不认它 ✓）
/// ⭐ 团队档 ⇒ 它自己的 `space_id` ✓ —— ⛔ 一个字节不动 ✗（"撤回"仍只从那个空间撤 ✓）
/// ```
///
/// ⚠️ **口径照方案 §10.3** ✗：**判定只有这一处** ✓ —— ⭐ 调用方知道 `device_level` ⇒ 就**传进来** ✓；
/// ⛔ 不许在下游拿"这是不是个人档"反推 ✗（那就是第二处判定 ⇒ 两份口径迟早会漂 ✓）。
///
/// ⚠️ **上面那一段是 `text` 围栏、不是 Rust 代码** ✗ —— ⛔ 别写成**裸三个反引号** ✗：
/// ⭐ Rust 会把它当 **doctest 去编译** ✓（散文编不过 ⇒ `cargo test --doc` 红 ✓）。
/// ⚠️ 而**本机那套 `--lib` 判据照不出来** ✗（它只跑 lib 目标 ✓）⇒ ⭐ 这条是 CI 里那条 rust 组抓到的 ✓。
///
/// ⚠️ **它只决定"库里哪一行"，不决定"门服务哪个空间"** ✗ —— 门那一侧（`add_paired` /
/// `forget_paired` 扫的内存卡表）永远按**门服务的那个空间** `proto_space` 记 ✓（个人的 `proto_space`
/// 是配对暗号 ✓，不是空串 ✗）⇒ ⭐ 两者**不是一回事**，别合 ✗。
pub fn paired_row_key<'a>(space: &'a str, device_level: bool) -> &'a str {
    if device_level {
        DEVICE_LEVEL_SPACE
    } else {
        space
    }
}

/// ⭐ **配对暗号** ⭐ 也搬进**同一张 KV** ✗（方案 §9.2 乙 ✓，Lead 批准的方向 ✓）：
/// ⭐ 三格从此**同一个存储、同一个键形状** ✓ ⇒ "设备级"只是**一处口径** ✓，⛔ 不是三处特例 ✓；
/// ⭐ 而且**不用碰 `meta.workspaces`** ✓（甲 那条路要先造一个真工作区 ＝ 又一份真相源 ✗）。
///
/// ⚠️ 读侧**保留旧列的回退** ✓（见 [`legacy_mesh_room`] ✓）：升级上来的机器读得到旧值 ✓。
/// ⭐ **"⭐ 这个空间是不是设备级那一格 ✗"** ✗ —— ⭐ **唯一判据** ✓（⭐ 调用方用它把这个判定算出来，
/// ⛔ 不在被调函数里再判一次 ✗ —— 那是第二份口径 ✓）。
pub fn is_device_level_space(c: &Connection, space: &str) -> bool {
    let s = space.trim();
    !s.is_empty() && mesh_room_device(c).as_deref() == Some(s)
}

pub fn mesh_room_device(c: &Connection) -> Option<String> {
    read_setting(c, "mesh_room", DEVICE_LEVEL_SPACE)
}

pub fn set_mesh_room_device(c: &Connection, room: Option<&str>) -> Result<(), String> {
    write_setting(c, "mesh_room", DEVICE_LEVEL_SPACE, room)
}

/// ⭐ **旧那一份**（`sync_profiles.mesh_room` ✓）：⭐ 个人行（`space_id` 空 ✓）里
/// **第一个非空 ＋ 按 `ws_id` 定序** ✗（结果确定 ✓ —— 因为没有时间戳，见方案 §8 ① ✓）。
pub fn legacy_mesh_room(c: &Connection) -> Option<String> {
    let mut stmt = c
        .prepare(
            "SELECT mesh_room FROM sync_profiles \
             WHERE space_id = '' AND TRIM(mesh_room) <> '' ORDER BY ws_id ASC LIMIT 1",
        )
        .ok()?;
    let mut rows = stmt.query([]).ok()?;
    let row = rows.next().ok()??;
    let v: String = row.get(0).ok()?;
    let v = v.trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

pub fn legacy_mesh_room_for(c: &Connection, ws_id: &str) -> Option<String> {
    let mut stmt = c
        .prepare("SELECT mesh_room FROM sync_profiles WHERE ws_id = ?1")
        .ok()?;
    let mut rows = stmt.query(rusqlite::params![ws_id]).ok()?;
    let row = rows.next().ok()??;
    let v: String = row.get(0).ok()?;
    let v = v.trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// ⭐⭐ **迁移（幂等 ✓、只增不删 ✓）**：把老的**逐空间**设置收敛成设备级那一份 ✗。
///
/// ## 三条实测口径（方案 §8／§9 ✓ —— ⛔ 都是量过的，不是猜的 ✗）
/// · ⭐ **没有时间戳** ✗：`sync_state` 只有 `key` / `value` 两列（`lan_state.rs:925` ✓）
///   ⇒ "取最近改过的"**做不到** ✓ ⇒ 取 ⭐ **第一个非空 ＋ 按 `ws_id`（或键名）定序** ✗
///   （结果**确定** ✓）＋ ⭐ **记一行日志说取了谁** ✓；
/// · ⛔ **旧行／旧键一个不删** ✗（⭐ 随时可回退 ✓）；
/// · ⭐ **幂等** ✓：设备级那格已经有值 ⇒ 那格一个字节都不动 ✓。
///
/// 返回**这次采用了谁**（`None` ＝ 没动 ✓）—— ⭐ 给日志与判据用 ✓。
///
/// ⭐ **2026-10-11（丙）**：多了 ③ —— ⭐ **已认的对端也并进设备级那一行** ✗
/// （见 [`migrate_device_level_paired_devices`] ✓：并集 ✓、只用一次 ✓、⛔ 旧行不删 ✗）。
pub fn migrate_device_level_mesh(c: &Connection) -> Result<Option<String>, String> {
    let mut moved: Vec<String> = Vec::new();
    // ① 配对暗号：老的逐空间那一份在 `sync_profiles.mesh_room`（个人行 ✓）
    if mesh_room_device(c).is_none() {
        if let Some(room) = legacy_mesh_room(c) {
            set_mesh_room_device(c, Some(&room))?;
            moved.push(format!("mesh_room(（{room}）"));
            eprintln!(
                "[mesh] ⭐ 设备级迁移：配对暗号取自旧的那一份（「{room}」✓ —— 无时间戳 ⇒ 取第一个非空 ＋ 按 ws_id 定序 ✓）；⛔ 旧行没删 ✓"
            );
        }
    }
    // ② 监听地址／口令：老的键是 `mesh_bind:<暗号或 space_id>` ✓ ⇒ ⛔ 只认**不属于任何团队空间**的键 ✗
    for prefix in ["mesh_bind", "mesh_token"] {
        let dev_key = setting_key(prefix, DEVICE_LEVEL_SPACE);
        let already = crate::sync::get_meta_state(c, &dev_key)
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if already {
            continue;
        }
        // ⚠️ ⭐ **先把候选键读完再判** ✗ —— 一边遍历 `rows` 一边在**同一条连接**上再发一次查询，
        //   rusqlite 会报"语句还在用"✗ ⇒ 那个错会被 `unwrap_or(0)` **吞掉** ⇒ 白名单恒为 0
        //   ⇒ ⭐ **一个键都搬不动** ✗（实测踩过：判据③当场红 ✓）。⇒ 收集完再逐条判 ✓。
        let mut candidates: Vec<(String, String)> = Vec::new();
        {
            let mut stmt = c
                .prepare(
                    "SELECT key, value FROM meta.sync_state \
                     WHERE key LIKE ?1 AND TRIM(value) <> '' ORDER BY key ASC",
                )
                .map_err(|e| e.to_string())?;
            let like = format!("{prefix}:%");
            let mut rows = stmt.query(rusqlite::params![like]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                candidates.push((
                    row.get(0).map_err(|e| e.to_string())?,
                    row.get(1).map_err(|e| e.to_string())?,
                ));
            }
        }
        let mut picked: Option<(String, String)> = None;
        for (k, v) in candidates {
            let suffix = k.strip_prefix(&format!("{prefix}:")).unwrap_or("").trim().to_string();
            if suffix.is_empty() {
                continue; // 已经是设备级那一格 ✓
            }
            // ⭐⭐ **反向白名单** ✗（Lead 2026-10-11 拍 ✓）：⭐ 只搬"**可证明是个人档**"的后缀 ✗ ——
            //   依据：⭐ 个人档的旧键后缀 ＝ 那一行的 `mesh_room`（`space_id` 空 ✓）⇒ ⭐ 这是**可查**的事实 ✓。
            //   ⛔ 原来的做法（"后缀是某个 `space_id` 才算团队"）**反了** ✗：
            //     一个**从没建过档案行**的团队空间会被当成"不是团队" ⇒ ⭐ 它的设置**漏进设备级** ✗
            //     （＝ 会跟着"所有个人空间"一起生效 ✗ —— 判据⑤当场抓到 ✓）。
            let provable_personal: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM sync_profiles \
                     WHERE TRIM(space_id) = '' AND TRIM(mesh_room) = ?1",
                    rusqlite::params![suffix],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if provable_personal == 0 {
                eprintln!(
                    "[mesh] ⚠️ 设备级迁移：旧键「{k}」**没搬** ✓ —— ⭐ 它证明不了是个人档 ✗\
                     （个人档的后缀 ＝ 该行的 `mesh_room` ✓）；⛔ 这个键**原样留着** ✓"
                );
                continue;
            }
            picked = Some((suffix, v.trim().to_string()));
            break; // ⭐ 取第一个非空（键名已定序 ⇒ 确定 ✓）
        }
        if let Some((from, value)) = picked {
            write_setting(c, prefix, DEVICE_LEVEL_SPACE, Some(&value))?;
            moved.push(format!("{prefix}（来自「{from}」）"));
            eprintln!(
                "[mesh] ⭐ 设备级迁移：{prefix} 取自旧的那一份（「{from}」✓ —— 按键名定序取第一个非空 ✓）；⛔ 旧键没删 ✓"
            );
        }
    }
    // ③ ⭐⭐ **2026-10-11（丙）**：⭐ 已认的对端也并进设备级那一行 ✗（方案 §11.3 ✓）。
    let pairs_moved = migrate_device_level_paired_devices(c)?;
    if pairs_moved > 0 {
        moved.push(format!("已认的对端 {pairs_moved} 条"));
    }
    if moved.is_empty() {
        return Ok(None);
    }
    Ok(Some(moved.join("、")))
}

/// ⛔ **"对端表的设备级迁移做过了"那一格** ✗ —— ⭐ 它不是第二份真相源 ✓：
/// 它不存"认了谁"（那是 `mesh_paired_devices` 自己的事 ✓），只记"这件事做过了"✓。
const PAIRED_MIGRATED_KEY: &str = "mesh_paired_migrated_to_device_level";

/// ⭐⭐ **2026-10-11（丙）：把各个人空间的 `mesh_paired_devices` 行并进设备级那一行** ✗
/// （方案 §11.3 ✓）。返回**这次真合进去几条** ✓。
///
/// ## 三条口径
/// · ⭐ **并集** ✗：同一个 `device_id` 冲突 ⇒ ⭐ 保留 `added_at_ms` **更早**的那条 ✓
///   （＝"先认的"✓）—— ⚠️ 这个规则**与遍历顺序无关** ✓ ⇒ 结果确定 ✓；
/// · ⛔ **旧行一个不删** ✗（⭐ 可回退 ✓）；
/// · ⭐ **只搬"可证明是个人档"的行** ✗：判据＝`sync_profiles` 里有一个 `space_id` 空的行、
///   它的 `mesh_room` ＝ 这一行的 `space_id` ✓（⭐ 与设置那一半§10.1 **同一把尺** ✓）。
///   ⛔ 证明不了 ⇒ **不搬** ＋ ⭐ 记一行日志 ✓（团队行就是这样被挡在外面的 ✓）。
///
/// ## ⚠️⭐ 它**只做一次** ✗ —— 本轮**实测出来**的一条（方案 §11 里没写 ✓）
/// ⛔ 旧行**一个不删** ✗ ⇒ 若每次写路径都并一遍，⭐ **用户撤回过的那一台会被旧行重新并回来** ✗
/// （＝"撤回"被静默撤销 ✓ —— 那是**安全方向**上的回归 ✓）⇒ 用一格一次性标记挡住 ✓。
/// ⚠️ 标记**建完就写** ✓（⛔ 不是"搬动了才写" ✗）：一行都没搬到时也要记住做过 ✓。
fn migrate_device_level_paired_devices(c: &Connection) -> Result<usize, String> {
    if crate::sync::get_meta_state(c, PAIRED_MIGRATED_KEY)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        return Ok(0);
    }
    // ⚠️ ⭐ **先把候选行读完再判** ✗ —— 一边遍历 `rows` 一边在同一条连接上再发查询，
    //   rusqlite 会报"语句还在用" ✗（设置那一半**实测踩过** ✓，见 `migrate_device_level_mesh` ✓）。
    let rows: Vec<(String, String, String, i64)> = {
        let mut stmt = c
            .prepare(
                "SELECT space_id, device_id, secret_sha256, added_at_ms FROM mesh_paired_devices \
                 WHERE TRIM(space_id) <> '' ORDER BY space_id ASC, device_id ASC",
            )
            .map_err(|e| e.to_string())?;
        let it = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map_err(|e| e.to_string())?;
        it.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    let mut moved = 0usize;
    let mut skipped = 0usize;
    for (space, device, secret, added_at) in rows {
        let provable_personal: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM sync_profiles \
                 WHERE TRIM(space_id) = '' AND TRIM(mesh_room) = ?1",
                rusqlite::params![space],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if provable_personal == 0 {
            skipped += 1;
            eprintln!(
                "[mesh] ⚠️ 设备级迁移：对端行（空间「{space}」／设备 {}）**没搬** ✓ —— \
                 它证明不了是个人档 ✗；⛔ 旧行原样留着 ✓",
                device.chars().take(8).collect::<String>()
            );
            continue;
        }
        // ⭐ 幂等 ＋ 早者优先：`WHERE` 挂在 `DO UPDATE` 上 ⇒ 条件不成立就是**空操作** ✓
        //   （⛔ 不是"先查再写"✗ —— 一次语句里做完，早/晚两条无论谁先来，结果都一样 ✓）。
        let n = c
            .execute(
                "INSERT INTO mesh_paired_devices (space_id, device_id, secret_sha256, added_at_ms) \
                 VALUES ('', ?1, ?2, ?3) \
                 ON CONFLICT(space_id, device_id) DO UPDATE SET \
                     secret_sha256 = excluded.secret_sha256, \
                     added_at_ms = excluded.added_at_ms \
                 WHERE excluded.added_at_ms < mesh_paired_devices.added_at_ms",
                rusqlite::params![device, secret, added_at],
            )
            .map_err(|e| e.to_string())?;
        moved += n;
    }
    crate::sync::set_meta_state(c, PAIRED_MIGRATED_KEY, "1")?;
    eprintln!(
        "[mesh] ⭐ 设备级迁移：已认的对端并进设备级那一行 —— 合了 {moved} 条\
         （⛔ 旧行一个没删 ✓；⭐ 证明不了是个人档的 {skipped} 条没搬 ✓）"
    );
    Ok(moved)
}

/// ⭐ **U11/T5**：本机**要出示给那一台**的那份秘密（明文 ✓，只在本机 ✓）。
///
/// 键＝`mesh_pair_secret:<space>:<peer_device_id>`（规格 §3.2 定的形状 ✓）。
/// ⚠️ 它与"我认谁"（`mesh_paired_devices.secret_sha256` ✓）是**两半**：
///   这一半是**我要出示的**，那一半是**别人要出示给我、我存的哈希** ✓。
pub fn pair_secret_for(c: &Connection, space_id: &str, peer_device_id: &str) -> Option<String> {
    // ⭐⭐ **2026-10-19（真机读数）**：**设备级那一格是空串时，回落到旧的房间档那一格** ✗。
    //   现场（windows↔AMD，逐字三行）：
    //     `mesh_pair_secret::94bfb27e…`         = **（空）**
    //     `mesh_pair_secret:123456789Ok,./:94bfb27e…` = `Tashan1973,./`
    //     `sync_history`：`拉了 1 台对端，其中 1 台没拉动`（对端 401）
    //   ⇒ 迁移那一步（`mesh_paired_migrated_to_device_level = 1`）**只搬了标记、没搬值** ⇒
    //     每一轮都拿空串去出示 ⇒ 对端一律 401 ⇒ 用户看到"同步不了"。
    //   ⇒ 读路径上做**回落**（⛔ 不改写库：写路径仍是 `set_pair_secret` 那一处）✓
    let main = read_setting(c, &format!("mesh_pair_secret:{space_id}"), peer_device_id)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if main.is_some() {
        return main;
    }
    // 回落：设备级（`space_id` 空）那一格 ↔ 房间档那一格，两边都试一次。
    let legacy_room = legacy_mesh_room(c).unwrap_or_default();
    let candidates = [legacy_room.as_str(), ""];
    for sid in candidates {
        if sid == space_id {
            continue;
        }
        if let Some(v) = read_setting(c, &format!("mesh_pair_secret:{sid}"), peer_device_id) {
            let v = v.trim().to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

/// 写/清那一份（空 ⇒ 清掉 ✓）。⚠️ **不校验强度**：它由配对流程生成（≥60 bit 的码 ✓），
/// ⛔ 不是用户手打的口令 ✗（用户手打的那条 `mesh_token` 已经退役 ✓）。
pub fn set_pair_secret(
    c: &Connection,
    space_id: &str,
    peer_device_id: &str,
    secret: Option<&str>,
) -> Result<(), String> {
    write_setting(c, &format!("mesh_pair_secret:{space_id}"), peer_device_id, secret)
}

pub fn settings(c: &Connection, space_id: &str) -> MeshSettings {
    MeshSettings {
        bind: read_setting(c, "mesh_bind", space_id),
        token: read_setting(c, "mesh_token", space_id),
    }
}

pub fn set_mesh_bind(c: &Connection, space_id: &str, bind: Option<&str>) -> Result<(), String> {
    if let Some(b) = bind.map(str::trim).filter(|b| !b.is_empty()) {
        // 配的时候就**当场**把关（而不是等开窗那一步才报错）：公网地址一律不收。
        checked_bind(b)?;
    }
    write_setting(c, "mesh_bind", space_id, bind)
}

/// ⭐ **口令强度的成文口径**（`U9` / `INV-PER-unencrypted-needs-strong-secret`）：
/// **未加密的空间里，这个口令就是唯一的防线** —— 同网段的人只要抄到"地址＋空间＋口令"三样
/// 就能把整个空间的记录拉走 ✓（`nearby §13.8.5`）。
///
/// ⚠️ **本批的范围是"只做长度与字符类，不做字典"** ✓（规格 §7-R7 明写）—— 所以：
///   · ⛔ 不查常见弱口令表 ✗（那需要字典 ＋ 误报口径，属另一批）；
///   · ✅ 只拒三样：**太短** ／ **纯数字** ／ **同一个字符重复**。
///     ⭐ 这三样正是"用户以为自己设了密码、其实三秒被猜中"的那一类 ✓。
///
/// 空串 ⇒ **放行**（＝清除这一档，保持既有语义 ✓ —— `write_setting` 两侧都按空当"没有"）。
///
/// ⚠️ 门槛写死 **8** 的理由（写下来免得后人来猜 ✓）：攻击面是**在线**的
/// （口令在服务端逐次比对，不参与派生）⇒ 8 位随机口令已远超在线爆破的可行域 ✓；
/// 而真正会造成事故的是"**6 位数字**"那一类 ✓ —— 它的搜索空间只有 10^6。
pub(crate) fn weak_token_reason(t: &str) -> Option<&'static str> {
    if t.chars().count() < 8 {
        return Some("太短（少于 8 个字符）");
    }
    if t.chars().all(|c| c.is_ascii_digit()) {
        return Some("全是数字");
    }
    let first = t.chars().next();
    if t.chars().count() > 1 && t.chars().all(|c| Some(c) == first) {
        return Some("整串是同一个字符重复");
    }
    None
}

/// ⚠️ **配的时候就当场把关**（与 `set_mesh_bind` 同一条先例 ✓）—— 而不是等开窗那一步才报错：
/// 口令一旦落库，用户**不会**再回来看它；所以"弱口令"必须在这一步被挡住 ✓。
pub fn set_mesh_token(c: &Connection, space_id: &str, token: Option<&str>) -> Result<(), String> {
    let v = token.map(str::trim).unwrap_or("");
    if !v.is_empty() {
        if let Some(why) = weak_token_reason(v) {
            return Err(format!(
                "拒绝保存：这个口令**{why}** ✗。\n\
                 ⚠️ 还没加密的空间里，**口令是唯一的防线** —— 同一个网络里，\
                 抄到「地址 ＋ 空间 ＋ 口令」三样的人就能把这个空间的记录整批拉走，\
                 而**你不会收到任何提示**。\n\
                 ⇒ 请换一个：**至少 8 个字符**，**别用纯数字**（例如 `k7Qm-2pRt` 这样混着字母）。\n\
                 （若这个空间已开静态加密，口令仍要设 —— 它是第二道门，不是替代品。）"
            ));
        }
    }
    write_setting(c, "mesh_token", space_id, token)
}

/// ★ **产品入口的那一层**：一轮网格交换 —— 读设置 ⇒ 挑对端 ⇒ 逐个拉。
///
/// 三条口径：
/// 1. **没配监听地址 ⇒ 整档关着，一个字节都不动**（连对端表都不看）—— 这是"默认零行为变化"；
/// 2. **一只对端拉不动不许连坐**：它的错记在它自己那一行，别的照拉（回到 `error` 字段）；
/// 3. **与 `server_url` 无关**：这一层只认"空间 ＋ 网格设置 ＋ 对端表" ⇒
///    **一个没有服务端可绑的空间照样能靠网格同步**（这正是 ③-b-2 要兑现的那件事）。
pub async fn round(
    conn: &Mutex<Connection>,
    space_id: &str,
    my_device: &str,
    peers: &[crate::lan::Peer],
    // ⭐⭐ 2026-10-11（设备级 ✓）：⭐ 由**调用方**从 `mesh_scope` 传进来 ✗ ——
    //   ⛔ 本函数**不许**自己判"是不是个人档" ✗（那就成了第二份口径 ✓，方案 §9.1 ✓）。
    device_level: bool,
) -> Result<MeshRoundReport, String> {
    let cfg = {
        let g = conn.lock().map_err(|_| "空间库的锁被毒掉了".to_string())?;
        settings_for(&g, space_id, device_level)
    };
    // ⭐ **2026-10-19（B1 步三）**：⚠️ 名字**和 cfg 同一把锁**里读出来（一次锁、一次读 ✓）——
    //   ⛔ 不许跨 `await` 持锁 ✗（下面 `mesh_peers_by_name` 之后就进网络了）。
    //   读不到名字 ⇒ 空串 ⇒ `mesh_peers_by_name` 回落到 id（老行为，⛔ 不是"一个都不拉"）。
    //   ⭐⭐ **2026-10-19 修**：⭐ **只有设备级／个人档才按名字挑** ✗ —— 团队空间**不参与**按名融合
    //   （规格 C3）⇒ 团队档必须传空名（回落 id），否则"同名"会误伤团队空间的正常同步 ✓。
    let space_name = if device_level {
        let g = conn.lock().map_err(|_| "空间库的锁被毒掉了".to_string())?;
        crate::sync::local_space_name(&g).unwrap_or_default()
    } else {
        String::new()
    };
    // ⭐ 2026-10-23（S3c-接）：**先把"锁着时收下的"那批补应用掉** ✓ ——
    //   它们躺在 `meta.mesh_inbox` 里，不主动 drain 就永远不动（那是最坏的静默失败：
    //   "收到了、也存住了、就是不用" ✗）。⚠️ 放在真正拉取**之前**：这一轮后面的 pull
    //   才有机会看到"已经应用过的"那份；⚠️ drain 失败**不拦这一轮**（下一轮还会再来 ✓）。
    if let Ok(g) = conn.lock() {
        for p in peers {
            match drain_inbox(&g, space_id, &p.announce.device_id, device_level) {
                Ok(ab) if ab.applied > 0 => eprintln!(
                    "[mesh] 解锁后补应用：对端 {} ｜ {} 条",
                    p.announce.device_id, ab.applied
                ),
                Ok(_) => {}
                Err(e) => eprintln!("[mesh] 补应用失败（这一轮照常继续）：{e}"),
            }
        }
    }
    let Some(_bind) = cfg.bind.clone() else {
        return Ok(MeshRoundReport {
            enabled: false,
            note: "没有配网格监听地址 ⇒ 网格这一档关着（这一轮一个字节都没动）".to_string(),
            candidates: 0,
            peers: Vec::new(),
            window: None,
        });
    };
    let candidates = mesh_peers_by_name(space_id, &space_name, my_device, peers);
    if candidates.is_empty() {
        return Ok(MeshRoundReport {
            enabled: true,
            note: "网格开着，但这个网段里没有能直接拉的对端（没人代言这个空间 / 只有我自己）".to_string(),
            candidates: 0,
            peers: Vec::new(),
            window: None,
        });
    }
    round_candidates(conn, space_id, candidates, device_level).await
}

/// `round` 的**后半**：对端由调用方给，只做"逐个拉 ＋ 不连坐 ＋ 把读数整理成人话"。
///
/// ⚠️ 为什么把这一半单独开出来：**本机判据只能用回环地址**（`127/8`），
/// 而 `lan::is_lan_base` **明确把回环排除**在"网段里的别人"之外（甲-1 的口径）⇒
/// `round` 前半挑出来的对端在判据里必然是空集。所以：
/// **前半（设置 ＋ 挑对端）与后半各有判据**，"合起来那一趟"要两个真内网地址（真机/两进程）。
///
/// ⭐ **2026-10-11（丙）**：`device_level` 由调用方传进来 ✗ —— 它决定 ⭐ **"本机要出示的那一份"
/// 从哪一格读** ✗（个人档 ⇒ 空串那一格 ✓，与 `remember_peer_card` 写的那把键**同一把** ✓）。
pub async fn round_candidates(
    conn: &Mutex<Connection>,
    space_id: &str,
    candidates: Vec<MeshPeer>,
    device_level: bool,
) -> Result<MeshRoundReport, String> {
    let client = reqwest::Client::new();
    let mut out: Vec<PeerPullReport> = Vec::with_capacity(candidates.len());
    for p in &candidates {
        // ⭐ **U11（A：门只认卡）**：出示的是**这一台**的那一份配对秘密 ✓
        //    ⛔ 不再用共享口令 ✗（它已退役 ✓）；本地没有这一台的那份 ⇒ 出示 `None`
        //    ⇒ 对端回 401（如实报出来 ✓，⛔ 不是静默跳过 ✗）
        let secret = {
            let g = conn.lock().map_err(|_| "空间库的锁被毒掉了".to_string())?;
            pair_secret_for(&g, paired_row_key(space_id, device_level), &p.device_id)
        };
        // ⭐ **2026-10-19（排障用，一行）**：把"这一台拉成了没有 / 出示的是哪一份"打出来 ——
        //   真机那次"收下 0 条"在界面上只显示一句"1 台没拉动"，**说不清是没秘密、401、还是空** ✓。
        //   ⚠️ 只打**有无**，⛔ 不打秘密本身。
        eprintln!(
            "[mesh {}] 拉 {} ⇒ secret={} · space={} · device_level={}",
            crate::db::now_ms(),
            p.device_id,
            if secret.is_some() { "有" } else { "**无**（会 401）" },
            space_id,
            device_level
        );
        match pull_and_absorb(conn, &client, p, space_id, secret.as_deref(), device_level).await {
            Ok(rep) => {
                eprintln!(
                    "[mesh {}] 拉 {} ⇒ ok fetched={} applied={} cursor={} max={} error={:?}",
                    crate::db::now_ms(),
                    p.device_id,
                    rep.fetched,
                    rep.applied,
                    rep.cursor,
                    rep.max_seq,
                    rep.error
                );
                out.push(rep)
            }
            // ⚠️ **不连坐**：这一台拉不动，别的照拉；错原样带回给界面。
            Err(e) => out.push(PeerPullReport {
                peer: p.device_id.clone(),
                fetched: 0,
                applied: 0,
                cursor: 0,
                max_seq: 0,
                // 拉不动 ⇒ 一个字节都没换过，这两项必然是 0（不是"不知道"，是"没发生"）。
                superseded: 0,
                awaiting: 0,
                items: Vec::new(),
                // 拉取失败 ⇒ 融合判定没跑过（如实说"没发生"，⛔ 不假装"不融"）。
                merge: PeerMergeState::NotRun,
                error: Some(e),
            }),
        }
    }
    let note = round_note(&out);
    Ok(MeshRoundReport { enabled: true, note, candidates: out.len(), peers: out, window: None })
}

/// 把每一台的读数拼成**一句人话** —— 纯函数（判据不打桩、不看网络）。
///
/// ★★ 丙-⑤（2026-09-26）：**必须把"用户输了/等裁决"的那两件事说出来**。网格这一档没有服务端，
/// `MeshRoundReport` 就是用户唯一的窗口；只说"拉了 N 台对端"的话，一次"对端戳更晚 ⇒ 本机那一版
/// 被盖掉"的交换与一次"什么都没发生"的交换**长得一模一样**（静默覆盖）。
///   · `superseded` ⇒ 你本机那一版让给了远端，**已存进版本历史**（找回它的路在编辑器工具栏）；
///   · `awaiting`   ⇒ 有页等你裁决（在面板「待取回的远端版本」那一段）。
/// ⚠️ 老那两句（拉了几台 / 几台没拉动）**逐字不变** —— 它们是既有判据钉着的形状，
/// 也是"没开/没人/拉不动"三件事的分辨器。
pub fn round_note(peers: &[PeerPullReport]) -> String {
    let failed = peers.iter().filter(|r| r.error.is_some()).count();
    let base = if failed == 0 {
        format!("网格：拉了 {} 台对端", peers.len())
    } else {
        format!("网格：拉了 {} 台对端，其中 {failed} 台没拉动（见每一行的 error）", peers.len())
    };
    let superseded: usize = peers.iter().map(|r| r.superseded).sum();
    let awaiting: usize = peers.iter().map(|r| r.awaiting).sum();
    let mut tail: Vec<String> = Vec::new();
    if superseded > 0 {
        tail.push(format!(
            "其中 {superseded} 页你本机那一版让给了远端（远端更晚）—— 那一版**已存进版本历史**，编辑器工具栏点「版本历史」能找回"
        ));
    }
    if awaiting > 0 {
        tail.push(format!("另有 {awaiting} 页等你裁决（见下面「待取回的远端版本」）"));
    }
    // ⭐ **2026-10-17（按名融合接线）**：融合/没融也**必须说出来** —— 与上面那两句同一条纪律
    //   （网格这一档没有服务端，`MeshRoundReport` 是用户唯一能看到的窗口）。
    let merged = peers
        .iter()
        .filter(|r| matches!(r.merge, PeerMergeState::Merged))
        .count();
    let already = peers
        .iter()
        .filter(|r| matches!(r.merge, PeerMergeState::AlreadyMerged))
        .count();
    let refused = peers
        .iter()
        .filter(|r| matches!(r.merge, PeerMergeState::Refused(_)))
        .count();
    let ledger_bad = peers
        .iter()
        .filter(|r| matches!(r.merge, PeerMergeState::LedgerUnavailable))
        .count();
    if merged > 0 {
        tail.push(format!(
            "其中 {merged} 台把**同名个人空间**并进来了（已记融合账，可撤销）"
        ));
    }
    if already > 0 {
        tail.push(format!(
            "另有 {already} 台的同名融合**之前已经记过账**（幂等，不重复并入）"
        ));
    }
    if refused > 0 {
        tail.push(format!(
            "有 {refused} 台**没融合**（空间名/身份对不上）—— 那一批**没落库**，原因见日志"
        ));
    }
    if ledger_bad > 0 {
        tail.push(format!(
            "有 {ledger_bad} 台的**融合账本坏了** ⇒ 那一批没落库（见日志）"
        ));
    }
    if tail.is_empty() {
        base
    } else {
        format!("{base}；{}", tail.join("；"))
    }
}

// ─────────────────────────── 窗口的进程级注册表（一个空间一个窗口） ───────────────────────────

// ─────────────────── 窗口的进程级注册表（⭐ **U8：一个绑定一扇门**，门里服务多个空间） ───────────────────

/// ⭐ **U8（2026-10-01）**：**一个绑定一扇门** —— ⛔ 不再是「一个空间一个窗口」✗。
///
/// 键＝**绑定地址**（`0.0.0.0:8788` 这种写法本身）：⭐ 同一个绑定的那些空间**共用一扇门** ✓，
/// 而"门里服务哪些空间"由 `MeshHandle::conns` 的键表达 ✓（单一真相，见 `State` 的头注 ✓）。
static WINDOWS: std::sync::OnceLock<Mutex<std::collections::HashMap<String, MeshHandle>>> =
    std::sync::OnceLock::new();

fn windows() -> &'static Mutex<std::collections::HashMap<String, MeshHandle>> {
    WINDOWS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// 确保这个空间的窗口开着（**配了监听地址才开**）。已经在开 ⇒ 原样返回它的地址（幂等）。
///
/// ⚠️ **两个空间 id 不是一回事**（2026-09-26 真机实测踩到，改前它把两者混用了）：
///   · `db_space` ＝ **本地空间 id**，就是 `spaces/<id>.db` 的文件名那一半 ⇒ 决定**开哪一份库**；
///   · `proto_space` ＝ **远端组织空间 id**（档案里 `sync_profiles.space_id`）⇒ 决定窗口**服务哪个空间**
///     （`handle_pull` 的 403 检查；对端挑人时也是按它匹配）。
///   真机上这两个 id **不同名**（本地 `default` / 远端 `8be69ab5…`）。早期实现拿后者当库名 ⇒
///   窗口对着一个**按远端 id 新建的空库**在服务：HTTP 照常 200、`records: []`、**一个错都不报**，
///   而两台手机"互相拉得动"却**一条也换不过去**。
///   判据：`the_window_serves_the_local_spaces_db_not_a_file_named_after_the_remote_id`。
///
/// ⚠️ 窗口用**自己那条**空间库连接（`db::open_space_conn_at`）：不与界面那条抢锁，
/// 也不会因为界面切空间而被换掉。**代价如实写**：加密空间**必须已解锁**，
/// 否则这条连接打不开 ⇒ 这里如实报错（"开不起来"比"开着一个读不了库的窗口"好）。
/// ⭐ **U8（2026-10-01）**：确保**这一个绑定**的窗口开着，并把它要服务的这些空间**都**加进去（幂等 ✓）。
///
/// 三条都在这里钉着：
///   ① **一个绑定一扇门**：注册表按 `bind` 记 ⇒ 三个空间同一个绑定 ⇒ **同一个 `SocketAddr`** ✓
///      （矩阵 U8-① 的变异：退回"每空间一份 handle" ⇒ 必须红 ✓）；
///   ② **已在开 ⇒ 往里加空间**（⛔ **不重启** ✗）—— 重启会换端口、把正在连的对端掐断 ✓；
///   ③ **`token` 只在开新门时用**：门已经开着时换口令**不生效**（要生效得先 `stop_window` 再 ensure ✓，
///      与改绑定的处置一致 —— 设置面那条路就是这么走的 ✓）。
///
/// ⚠️ **两个空间 id 不是一回事**（2026-09-26 真机实测踩到，改前它把两者混用了）：
///   · `db_space` ＝ **本地空间 id**，就是 `spaces/<id>.db` 的文件名那一半 ⇒ 决定**开哪一份库**；
///   · `proto_space` ＝ **远端组织空间 id**（档案里 `sync_profiles.space_id`）⇒ 决定窗口**服务哪个空间**
///     （`?space_id=` 那条 403 的判据；对端挑人时也是按它匹配）。
///   真机上这两个 id **不同名**（本地 `default` / 远端 `8be69ab5…`）。早期实现拿后者当库名 ⇒
///   窗口对着一个**按远端 id 新建的空库**在服务：HTTP 照常 200、`records: []`、**一个错都不报**，
///   而两台手机"互相拉得动"却**一条也换不过去**。
///   判据：`the_window_serves_the_local_spaces_db_not_a_file_named_after_the_remote_id`。
///
/// ⚠️ 窗口用**自己那条**空间库连接（`db::open_space_conn_at`）：不与界面那条抢锁，
/// 也不会因为界面切空间而被换掉。**代价如实写**：加密空间**必须已解锁**，
/// 否则这条连接打不开 ⇒ 这里如实报错（"开不起来"比"开着一个读不了库的窗口"好）。
///
/// ⭐ **2026-10-11（丙）：`spaces` 的第三格是"这一档是不是个人档"** ✗ ——
///   它决定 ⭐ **卡从库里哪一行载** ✗（个人档 ⇒ 空串那一行 ✓，见 [`paired_row_key`] ✓）；
///   ⛔ **不影响**门服务哪个空间／内存卡表的键 ✗（那两个永远是 `proto_space` ✓）。
///   ⚠️ 由**调用方**传进来 ✓（它知道这一行的 `space_id` 空不空 ✓）—— 本层**不反推** ✗（方案 §10.3 ✓）。
pub fn ensure_window(
    spaces: &[(String, String, bool)],
    device_id: &str,
    bind: &str,
    dir: &Path,
) -> Result<Option<SocketAddr>, String> {
    let bind = bind.trim();
    if bind.is_empty() {
        return Ok(None);
    }
    let mut guard = windows().lock().map_err(|_| "网格窗口表的锁被毒掉了".to_string())?;
    // ① 这一扇门**已经在开** ⇒ 只把缺的空间加进去（⛔ 不重启 ✗）
    if let Some(h) = guard.get(bind) {
        let mut failures: Vec<String> = Vec::new();
        for (db_space, proto_space, device_level) in spaces {
            // ⭐ 2026-10-23（S3a）：**一个打不开的空间不许把这一轮整批按死** ✗ ——
            //   锁着的加密空间就是这种：它自己没钥匙（开不了库），但它**不该连累**同绑定的其它空间 ✓。
            //   口径：能加的先加；加不上的**记一条**、⛔ 不谎报"我在服务它"（服务范围＝`served()` ✓）。
            if let Err(e) = h.add_space(db_space, proto_space, dir) {
                failures.push(format!("{proto_space}: {e}"));
                continue;
            }
            // ⭐ **U11**：连接加了，**卡也要一起载** ✗→✓（否则那个空间"服务着但谁都进不来" ✓）
            if let Err(e) = h.load_cards_for(proto_space, dir, *device_level) {
                failures.push(format!("{proto_space}: 卡表载不进来：{e}"));
            }
        }
        // ⚠️ 一门都没服务上 ⇒ 仍然**如实报错**（⛔ 不许把"一个都没开"说成成功 ✗）。
        if !failures.is_empty() && h.served().is_empty() {
            return Err(failures.join("; "));
        }
        for f in &failures {
            eprintln!("[mesh] 绑定 {bind} 这一轮**少服务一个空间**（其余照常）：{f}");
        }
        return Ok(Some(h.addr()));
    }
    // ② 新开一扇门：先把这些空间的库连接都开好（⭐ 服务范围＝这张表的键 ✓）
    // ⭐ 2026-10-23（S3a）：逐个开、**开不了的那个跳过**（口径同 ①）—— 一个锁着的加密空间
    //   曾经让整扇门「这一轮都不宣告」，界面只会说「附近发现 0 台」，真因一个字看不见 ✓。
    let mut conns: std::collections::HashMap<String, Arc<Mutex<Connection>>> = std::collections::HashMap::new();
    let mut failures: Vec<String> = Vec::new();
    // ⭐ S3b-发：开不了的那些**记下房间名** —— 它们不是"没有"，而是"知道但打不开"。
    let mut locked_protos: Vec<String> = Vec::new();
    for (db_space, proto_space, _) in spaces {
        match crate::db::open_space_conn_at(db_space, dir) {
            Ok(conn) => {
                conns.insert(proto_space.clone(), Arc::new(Mutex::new(conn)));
            }
            Err(e) => {
                failures.push(format!("{proto_space}: {e}"));
                locked_protos.push(proto_space.clone());
            }
        }
    }
    if conns.is_empty() {
        // 一个都开不了 ⇒ 仍然如实报错（⛔ 不许起一扇服务 0 个空间的门当作成功 ✗）
        return Err(if failures.is_empty() {
            "没有可服务的空间".to_string()
        } else {
            failures.join("; ")
        });
    }
    // ⚠️ **跳过必须出声** ✗：静默少服务一个空间，用户只会看到"有些东西同步不过去"，而真因
    //   （这一步：那个库打不开，通常是加密空间还没解锁）一个字都不在界面上 ✓。
    for f in &failures {
        eprintln!("[mesh] 绑定 {bind} 这一轮**少服务一个空间**（其余照常）：{f}");
    }
    // ⭐ U11：把**每个空间各自的**卡表载进来（一个空间一组 ✓）
    //   ⚠️ S3b-发：**开不了的空间也要载卡** ✗ —— 鉴权只需要卡表（读 meta），不需要开库 ✓；
    //     不载 ⇒ 锁着的那台连"我认得你"都做不到 ⇒ 一律 401，封包那条路根本走不到 ✗。
    let mut paired: CardBook =
        std::collections::HashMap::new();
    for (_, proto_space, device_level) in spaces {
        load_cards(dir, proto_space, *device_level, &mut paired);
    }
    let handle = start(
        MeshConfig {
            bind: bind.to_string(),
            device_id: device_id.to_string(),
            // ★ 丙-④：附件字节在这棵树下的 `<本地空间>/…` ⇒ 窗口要能发它
            //   （`dir` 就是 app data 目录；判据里是临时目录）。
            data_dir: Some(dir.to_path_buf()),
        },
        Arc::new(Mutex::new(conns)),
        Arc::new(Mutex::new(paired)),
    )?;
    let addr = handle.addr();
    for p in &locked_protos {
        handle.mark_locked(p);
    }
    guard.insert(bind.to_string(), handle);
    Ok(Some(addr))
}

/// ⭐ 2026-10-23（S3a）：**这一扇门此刻到底在服务哪些空间** —— 给"公告"那一侧核对用。
///
/// 为什么需要它：`ensure_window` 现在会**跳过**打不开的空间（锁着的加密空间就是这种 ✓），
/// 而调用方手上只有一份"**想**服务的名单"（`pairs`）⇒ 不核对就会把没服务上的也宣告出去，
/// 那正是这一族里最坏的一种：**播出去的话是假的** ✓。
pub fn window_serves(bind: &str, proto_space: &str) -> bool {
    let bind = bind.trim();
    let Ok(g) = windows().lock() else { return false };
    let Some(h) = g.get(bind) else { return false };
    h.served().iter().any(|s| s == proto_space)
}

/// ⭐ **U8 的便利包装**（设置面那两条命令用 ✓）：从 `MeshSettings` 取绑定/口令、目录取 app data ✓。
///
/// ⚠️ 窗口级的口令按 **R3 的裁定**取（调用方给的那一份＝「最早那个空间」✓）。
pub fn ensure_window_for(
    spaces: &[(String, String, bool)],
    device_id: &str,
    bind: &str,
) -> Result<Option<SocketAddr>, String> {
    let dir = crate::db::app_data_dir_ref().ok_or_else(|| "app data dir not initialised".to_string())?;
    ensure_window(spaces, device_id, bind, dir)
}

/// `ensure_window` 的**可测那一半**：显式给库目录，**开一扇独立的门**（⛔ 不进注册表 ✗）。
///
/// ⭐ **U8 之后它就是"只有一个空间"的那种情况** ✓ —— 判据（与旧调用点）都用它 ✓。
/// ⚠️ 独立门＝不共享端口 ⇒ 判据之间不会互相污染（`stop_window` 对它也只是幂等空操作 ✓）。
/// ⚠️ **2026-10-01 收据**（`check-dead-code-receipts` 要的）：它在**产品二进制**里没有调用点 ——
/// 产品走的是 `ensure_window`（按绑定开**注册表里那扇门** ✓）；这一个只给**判据**开「独立门」 ✓。
/// **删除条件** ＝ 判据改用 `ensure_window` ＋ 一个测试专用的清场助手那天。
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn open_window_at(
    db_space: &str,
    proto_space: &str,
    device_level: bool,
    device_id: &str,
    bind: &str,
    token: Option<String>,
    dir: &Path,
) -> Result<MeshHandle, String> {
    let conn = crate::db::open_space_conn_at(db_space, dir)?;
    let mut conns: std::collections::HashMap<String, Arc<Mutex<Connection>>> = std::collections::HashMap::new();
    conns.insert(proto_space.to_string(), Arc::new(Mutex::new(conn)));
    // ⭐ **U11**：判据传进来的那个 `token` 现在当**一张已登记的卡** ✓
    //   （A 之后门只认卡 ✓）—— 于是既有那批判据**不用改形状**，而它们**真的在走卡那条路** ✓。
    let mut paired: CardBook =
        std::collections::HashMap::new();
    if let Some(t) = token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        paired.entry(proto_space.to_string()).or_default().hashes.insert(crate::db::sha256_hex(t));
    }
    // ⚠️ 而**真实**的卡从库里来（判据通常没有 ✓ ⇒ 上面那张就是它唯一的卡 ✓）
    load_cards(dir, proto_space, device_level, &mut paired);
    start(
        MeshConfig {
            bind: bind.to_string(),
            device_id: device_id.to_string(),
            data_dir: Some(dir.to_path_buf()),
        },
        Arc::new(Mutex::new(conns)),
        Arc::new(Mutex::new(paired)),
    )
}

/// ⭐ **U11/T5**：**逐台解除**的读数（界面要能如实说"这台还认我吗" ✓）。
///
/// ⚠️ 只回**事实**（这一台解除了没、还认几台 ✓），⛔ **不回任何秘密** ✗
///（秘密只在本机"我要出示"的那一侧 ✓，见规格 §3.2 ✓）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshPairedState {
    /// 刚被解除的那一台。
    pub peer: String,
    /// **解除之前**它是不是真在名单里（`false` ⇒ 本来就没配过 ⇒ 界面要说清"它本来就不在" ✓）。
    pub was_paired: bool,
    /// 解除**之后**这个空间还认几台 ✓。
    pub paired_count: i64,
    /// 一句人话 ✓。
    pub note: String,
}

/// ⭐ **U11/T5（2026-10-02）**：这个空间**认了哪些设备**（给界面"逐台解除"用 ✓）。
///
/// ⛔ **只有 `device_id` 与时间，绝不出 `secret_sha256`** ✗ ——
/// 界面只需要"能点名到那一台" ✓，哈希对它毫无用处、漏出去只有坏处 ✓。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshPairedDevice {
    pub device_id: String,
    pub added_at_ms: i64,
}

/// 读"认了哪些设备"（**只 select 两列** ✓ —— ⛔ 不把哈希带出库 ✗）。
///
/// ⭐ **2026-10-11（丙）**：那一行的键走 [`paired_row_key`] ✓ —— ⭐ 个人档读"空串那一行" ✗
/// （⇒ 两个个人空间看到的是**同一个集合** ✓）、⭐ 团队档读自己的 ✓（⛔ 行为逐字不变 ✗）。
pub fn paired_devices(
    c: &Connection,
    space_id: &str,
    device_level: bool,
) -> Result<Vec<MeshPairedDevice>, String> {
    let row = paired_row_key(space_id, device_level);
    let mut stmt = c
        .prepare(
            "SELECT device_id, added_at_ms FROM mesh_paired_devices \
             WHERE space_id = ?1 ORDER BY added_at_ms ASC, device_id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![row], |r| {
            Ok(MeshPairedDevice { device_id: r.get(0)?, added_at_ms: r.get(1)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 网格设置的**读数**（设置面回给界面的东西）。
///
/// ⚠️ **不回口令本身**，只说"设没设"：那东西没有任何理由被界面再拿回去一遍。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshConfigState {
    pub enabled: bool,
    pub bind: Option<String>,
    pub token_set: bool,
    /// 窗口**实际**绑在哪儿（`http://…`；没开 ⇒ `None`）。
    pub window: Option<String>,
    /// ⭐ **U8（2026-10-01）**：这扇门**服务哪些空间**（**排过序** ⇒ 读数确定 ✓）。
    ///
    /// 界面上要能说出"**这一扇门管几个空间**" ✓ —— 否则用户看到"一个窗口"却不知道
    /// 它替谁在听；而"关掉一个空间不许关掉整窗"这条口径也要靠它才看得出来 ✓。
    pub served: Vec<String>,
    /// ⭐ **U11/T5**：这个空间**认了哪些设备**（⛔ **不含哈希** ✗ —— 见 `MeshPairedDevice` ✓）。
    ///
    /// 界面靠它**点得出名字**再逐台解除 ✓ —— 否则用户只知道"有几台"，却不知道"解除哪一台" ✗。
    pub paired: Vec<MeshPairedDevice>,
    /// 一句人话：开没开、**窗口开在哪**。
    pub note: String,
    /// ⭐ **2026-10-14（owner：顶上那条绿字太长 ⇒ 拆两行）** ✗：⭐ 单独一句
    /// 「**别人拉不拉得到**」✓ —— ⭐ 界面把它当**第二行**小灰字摆 ✓（第一行只说「监听地址／端口」✓）。
    ///
    /// ⚠️ 从 `note` 里**搬出来**的（⛔ 不是加一份复制 ✗ —— 同一件事两份说法迟早漂开 ✓）：
    /// `note` 现在只说"开没开、窗口在哪" ✓，这一格只说"对面能不能连上我" ✓。
    pub reach: String,
    /// ⭐ **2026-10-14（owner 给了参照图）** ✗：⭐ **枚举到的那个可达 base** ✓（形如
    /// `http://192.168.43.206:8788` ✓；枚举不出／窗口没起来 ⇒ `None` ✓）。
    ///
    /// ⚠️ ⭐ 与 `window` **不是一回事** ✗：`window` 是"窗口**绑**在哪儿" ✓（绑通配时它就是
    /// `0.0.0.0` ✗），而这一格是"**报出去的那个**" ✓ —— 界面上那句「报出去的是 …」只能用它 ✓
    /// （⛔ 拿 `window` 会写出 `0.0.0.0` ✗，那是**编造** ✓）。
    /// ⚠️ 界面**只取它的 host** ✓（`new URL(...).hostname` ✓ —— 结构化字段 ✓，⛔ 不解析人话 ✗）。
    pub announced: Option<String>,
}

/// 把"设置 ＋ 窗口实际地址"变成给人看的读数 —— **纯函数**（判据不打桩）。
///
/// ★ 它要回答的最要紧的一件事：**这个窗口别人拉得到吗**。绑在回环上时网格自己照常工作
/// （它能拉别人），但**没人能拉它** —— 那正是"不装服务端也能同步"只做了一半的形态，
/// 必须说出来，不能只回一句"已保存"。
///
/// ★ **D1（owner 2026-09-30）之后多两格**：绑**通配**时窗口地址本身是 `0.0.0.0` ——
/// 那既不是回环、也不是"能连接的地址"，所以上面那条"回环 / 端口 0"的话**对它不成立**。
/// 通配要分两种如实说：① 枚举到了候选 ⇒ 报出**哪一个**（用户才知道对端看到的是什么）；
/// ② 一个候选都没有（这台只有回环/公网地址）⇒ **可操作**地说"别人拉不到 ＋ 去查网卡"
/// （`INV-VLAN-bind-must-be-reachable`：这一档最常见的失败就是**静默不工作**）。
pub fn config_state(
    cfg: &MeshSettings,
    window: Option<SocketAddr>,
    served: &[String],
    paired: &[MeshPairedDevice],
) -> MeshConfigState {
    let enabled = cfg.bind.is_some();
    // ⭐ 两句话**各说一件事**（⭐ 2026-10-14 拆的 ✓）：`note` ＝ 开没开／窗口在哪 ✓；`reach` ＝ 别人拉不拉得到 ✓。
    let (note, reach) = match (enabled, window) {
        (false, _) => (
            "网格这一档关着（没配监听地址 ⇒ 不听也不喊）".to_string(),
            "还没开 ⇒ **别人拉不到**".to_string(),
        ),
        (true, None) => (
            "配了监听地址，但窗口还没起来（见日志）".to_string(),
            "窗口还没起来 ⇒ **别人暂时拉不到**".to_string(),
        ),
        (true, Some(addr)) => match (announced_base(addr), addr.ip().is_unspecified()) {
            (Some(base), true) => (
                format!("网格开着：窗口**听所有网卡**（绑的是 {addr}）"),
                format!("**能被别人拉到** —— 报出去的是枚举到的 {base}"),
            ),
            (Some(base), false) => (
                format!("网格开着：窗口在 {base}"),
                format!("**能被别人拉到** —— 报出去的是 {base}"),
            ),
            (None, true) => (
                format!("网格开着：窗口**听所有网卡**（绑的是 {addr}）"),
                format!(
                    "⚠️ **别人拉不到** —— **枚举不出任何可以宣告的内网/VPN 地址**（这一台只有回环/公网地址？插上网线或虚拟网卡再看）"
                ),
            ),
            (None, false) => (
                format!("网格开着：窗口在 {addr}"),
                "⚠️ **别人拉不到**（回环 / 端口 0 ⇒ 这一台只能拉别人）".to_string(),
            ),
        },
    };
    // ⭐ U8：服务多个空间时，**在读数里说清是几个** ✓（不然"一个窗口"看不出它替谁听 ✓）
    let note = if served.len() > 1 {
        format!("{note} ｜ 这一扇门服务 {} 个空间：{}", served.len(), served.join("、"))
    } else {
        note
    };
    MeshConfigState {
        enabled,
        bind: cfg.bind.clone(),
        token_set: cfg.token.is_some(),
        window: window.map(|a| format!("http://{a}")),
        served: served.to_vec(),
        paired: paired.to_vec(),
        note,
        reach,
        // ⭐ 与上面 `reach` 里那句「报出去的是枚举到的 …」**同一个来源** ✓（`announced_base` ✓，纯函数 ✓）。
        announced: window.and_then(announced_base),
    }
}

/// ★ 这个空间现在**开着窗口吗**、开在哪儿（**只读**，不开窗）。
///
/// 给设置面板的读数用：面板打开一次不该顺手开一个端口（开窗归 `ensure_window` 的调用方）。
///
/// ⭐ **U8**：按**空间**查 ⇒ 扫注册表找"服务范围里有它"的那扇门 ✓
/// （⛔ 注册表的键是**绑定**，不是空间 ✗ —— 见 `WINDOWS` ✓）。
pub fn window_addr(space_id: &str) -> Option<SocketAddr> {
    let guard = windows().lock().ok()?;
    guard.values().find(|h| h.serves(space_id)).map(|h| h.addr())
}

/// ⭐ **U11/T5**：把**这一张卡**从**正在跑的那扇门**里摘掉（回"摘到了吗"✓）。
///
/// ⚠️ **只删库不算** ✗ —— 运行中的窗口**还认着那张卡**（它是开门时载进内存的 ✓）
/// ⇒ 用户看到的是「**删了等于没删**」✓ ⇒ 必须两处一起摘 ✓。
pub fn forget_paired(proto_space: &str, secret_sha256: &str) -> Result<bool, String> {
    let guard = windows().lock().map_err(|_| "网格窗口表的锁被毒掉了".to_string())?;
    for h in guard.values() {
        if h.serves(proto_space) {
            return h.forget_paired_hash(proto_space, secret_sha256);
        }
    }
    Ok(false) // 门没开着 ⇒ 库里删掉就够了（下次开门时它就不在卡表里 ✓）
}

/// ⭐ **2026-10-12（设备身份第 2 步）**：把**那一台的公钥**从**正在跑的那扇门**里摘掉 ✗
/// —— ⭐ [`forget_paired`] 在**新那一档**上的对应物 ✓，同一条理由（⛔ 只删库不算 ✗）。
///
/// ⚠️ 撤回时**两档都要摘** ✗：那一行可能既有哈希又有公钥 ✓ ⇒ ⛔ 只摘一半 ＝ 它还能从另一半进来 ✗。
pub fn forget_paired_device(proto_space: &str, device_id: &str) -> Result<bool, String> {
    let guard = windows().lock().map_err(|_| "网格窗口表的锁被毒掉了".to_string())?;
    for h in guard.values() {
        if h.serves(proto_space) {
            return h.forget_paired_device(proto_space, device_id);
        }
    }
    Ok(false) // 门没开着 ⇒ 库里删掉就够了（下次开门时它就不在卡册里 ✓）
}

/// ⭐ **U11/T5：`forget_paired` 的反面** —— 把**刚登记的这一张卡**加进**正在跑的那扇门** ✓。
///
/// ⚠️ **它同样必须做** ✗（今天缺的正是这一半 ✓）：门的卡表是**开门时载一次**的
/// （`load_cards` / `ensure_window` ✓）⇒ 用户**先开着门、再配对**时，库里那张新卡
/// **进不了内存里的卡表** ⇒ 现象是「**配对显示成功，对端照样 401**」✗
/// —— 与「删了等于没删」**同族**（都是"库里对了、跑着的门不认"✓）。
///
/// ⚠️ 门没开着 ⇒ `Ok(false)`：库里写上就够了（下次开门 `load_cards` 会把它载进来 ✓）。
/// ⛔ **不是错** ✗ —— 与 `forget_paired` 对称 ✓（判据因此不必先开窗，但**开着窗那一趟必须 200** ✓）。
pub fn add_paired(proto_space: &str, secret_sha256: &str) -> Result<bool, String> {
    let guard = windows().lock().map_err(|_| "网格窗口表的锁被毒掉了".to_string())?;
    for h in guard.values() {
        if h.serves(proto_space) {
            return h.add_paired_hash(proto_space, secret_sha256);
        }
    }
    Ok(false)
}

/// ⭐ **2026-10-12（设备身份第 3 步）**：把**那一台的公钥**加进**正在跑的那扇门** ✗
/// —— ⭐ [`add_paired`] 在**新那一档**上的对应物 ✓，同一条理由（⛔ 只写库不算 ✗）。
///
/// ⚠️ 门没开着 ⇒ `Ok(false)` ✓：库里写上就够了（下次开门时 `load_cards` 会把它载进来 ✓）。
pub fn add_paired_pubkey(
    proto_space: &str,
    device_id: &str,
    pubkey_hex: &str,
) -> Result<bool, String> {
    let guard = windows().lock().map_err(|_| "网格窗口表的锁被毒掉了".to_string())?;
    for h in guard.values() {
        if h.serves(proto_space) {
            return h.add_paired_pubkey(proto_space, device_id, pubkey_hex);
        }
    }
    Ok(false)
}

/// ⭐ **U8**：这个空间所在的那扇门**服务哪些空间**（**只读** ✓；没开 ⇒ 空 ✓）。
///
/// ⚠️ 读数用 —— ⛔ 它**不开窗** ✗（与 `window_addr` 同一条纪律：面板打开一次不该顺手开端口 ✓）。
pub fn served_spaces(space_id: &str) -> Vec<String> {
    match windows().lock() {
        Ok(g) => g.values().find(|h| h.serves(space_id)).map(|h| h.served()).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// ⭐ **U8**：把**这一个空间**从门里摘掉 —— ⚠️ **门里还有别的空间就不关整扇门** ✓。
///
/// T6 的判据就是这条：「**关掉一个空间不许关掉整窗**」✓ ——
/// 最后一个空间也走了，整扇门才真关 ✓（不然"关掉 A 顺手把 B 也断了"，而界面上看不出来 ✗）。
pub fn stop_window(space_id: &str) -> Result<(), String> {
    let mut guard = windows().lock().map_err(|_| "网格窗口表的锁被毒掉了".to_string())?;
    let hit: Option<String> = guard
        .iter()
        .find(|(_, h)| h.serves(space_id))
        .map(|(k, _)| k.clone());
    if let Some(key) = hit {
        let none_left = match guard.get(&key) {
            Some(h) => !h.remove_space(space_id)?,
            None => false,
        };
        if none_left {
            // 门里没人要了 ⇒ 这才真关（`Drop` 会停下 accept 线程 ✓）
            guard.remove(&key);
        }
    }
    Ok(())
}

/// ★ **D1（owner 2026-09-30 拍"把 `0.0.0.0 ⇒ Err` 反过来"）**：绑**通配**时该报哪些地址。
///
/// 这就是"地址自动"的另一半。为什么它必须存在：`announced_base` 的输入是"**实际绑上的那个**地址"，
/// 而绑通配时那个地址是 `0.0.0.0` —— 它**不是一个可连接的地址**（对端拿它去连就是连自己）
/// ⇒ 只把 `checked_bind` 放宽成"允许通配"的话，用户能开窗、**却没人拉得到他**。
///
/// 口径四条（**全在这一个纯函数里** ⇒ 判据喂一组假网卡就能钉住，不必有真网卡）：
/// 1. **端口 0 ⇒ 空**（还没绑上，报一个没人算得出的端口没有意义）；
/// 2. 绑的是**具体地址** ⇒ 只报它自己（与 D1 之前的行为**逐字相同**）；
/// 3. 绑的是**通配**（`0.0.0.0` / `[::]`）⇒ 报**枚举到的每一个**可达候选；
/// 4. 候选的过滤**与开窗那一关同一把尺**（`is_lan_only`）：去掉回环 / 通配 / 公网；
///    链路本地**排最后**（它是"这条链上"的地址，最不像对端能用的），其余按地址字节排 ⇒ **确定性**
///    （同一组网卡每次跑出来的顺序一样，判据才能逐字节比）。
///    ⚠️ **绝不许报 `0.0.0.0`**：见上。
///    ⚠️ **IPv6 一律不报**（理由见下面那段 `retain`）：消费侧只认 IPv4 基址。
pub fn announced_bases_with(addr: SocketAddr, locals: &[IpAddr]) -> Vec<String> {
    if addr.port() == 0 {
        return Vec::new();
    }
    let mut ips: Vec<IpAddr> = if addr.ip().is_unspecified() {
        // 绑通配 ⇒ 候选就是**这台机器的网卡**（由调用方给：探针/判据喂假结果，见 `local_addrs`）。
        locals.to_vec()
    } else {
        vec![addr.ip()]
    };
    // ⚠️ **只要 IPv4**：消费侧 `lan::is_lan_base` **只认 `http://<私有 IPv4>[:端口]`**
    //    —— 它自己的口径原话是「刻意不支持 IPv6 与主机名」。⇒ 报一个 IPv6 基址，就是报一个
    //    **对方必然会跳过**的地址（正是"往返性质"退化时的形状，见
    //    `lan::tests::an_announce_we_produce_is_always_one_we_would_accept`）。
    //    宁可这一轮不宣告（`config_state` 会如实说"别人拉不到"），也不报一个没人会采纳的地址。
    ips.retain(|ip| matches!(ip, IpAddr::V4(_)));
    ips.retain(|ip| !ip.is_loopback() && !ip.is_unspecified() && is_lan_only(*ip));
    ips.sort_by_key(|ip| (is_link_local_addr(*ip), ip_bits(*ip)));
    ips.dedup();
    ips.into_iter().map(|ip| format!("http://{}", SocketAddr::new(ip, addr.port()))).collect()
}

fn is_link_local_addr(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_link_local(),
        IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80,
    }
}

/// 排序键：**数值**而不是字符串 —— `"10.0.0.1" < "9.0.0.1"`（字符串序）会给出反直觉的顺序，
/// 而这条排序要能被判据逐字节钉住。IPv4 排在 IPv6 前。
fn ip_bits(ip: IpAddr) -> (u8, u128) {
    match ip {
        IpAddr::V4(v4) => (0, u32::from(v4) as u128),
        IpAddr::V6(v6) => (1, u128::from(v6)),
    }
}

/// 枚举本机地址 —— **唯一碰系统的那一处**（其余全是纯函数）。
///
/// 失败 ⇒ **空**（不 panic、不静默编一个）：枚举不到只意味着"这一轮不宣告"，
/// 而"别人拉不到"由 `config_state` 的人话如实说出来（`INV-VLAN-bind-must-be-reachable`）。
/// ⚠️ 它**不做任何过滤** —— 策略全在 [`announced_bases_with`] 里（一处口径）。
/// 依赖选型（为什么是 `if-addrs` 而不是自己写 `getifaddrs`／`GetAdaptersAddresses`）见 `Cargo.toml`。
pub fn local_addrs() -> Vec<IpAddr> {
    match if_addrs::get_if_addrs() {
        Ok(ifs) => ifs.into_iter().map(|i| i.addr.ip()).collect(),
        Err(_) => Vec::new(),
    }
}
/// ⭐ **2026-10-09 修**：枚举本机地址**并带上网卡名** —— 只多一层，判定仍是纯函数 ✓。
///
/// **为什么必须有它**（amd 报的真发现，逐字）：绑通配时原来是"从枚举到的候选里取**第一个**"✓，
/// 而排序按**地址字节** ⇒ 在多网卡机器上（Windows 装 WSL / Hyper-V / Docker 就**必然多张** ✓）
/// 会撞到**虚拟网卡** ✗ —— 现场：vEthernet (WSL) 的 172.18.224.1 排在一张真 WLAN 的
/// 192.168.43.190 **前面**（字节序 ✓），于是报出去的是对面**永远到不了**的地址 ✓，
/// 而症状是**静默的**（没有任何提示 ✓）。
///
/// ⚠️ 口径：**只看名字，不猜地址** —— 172.18.x 也可能是真内网 ✓，所以判"虚拟"只按网卡**名字** ✓。
pub fn local_addrs_named() -> Vec<(String, IpAddr)> {
    match if_addrs::get_if_addrs() {
        Ok(ifs) => ifs.into_iter().map(|i| (i.name, i.addr.ip())).collect(),
        Err(_) => Vec::new(),
    }
}

/// 这张网卡**名字**看起来是不是"本机内部"的虚拟网卡（WSL / Hyper-V / Docker / 环回 / 仅主机 ✓）。
///
/// ⚠️ **刻意只列"明显不是对端能到的"那几家** ✓：⛔ 不列 Tailscale / ZeroTier 这类 ✗
/// （它们是**真的网络** ✓，用户可能正要用它们当对端 ✓）。
fn is_virtual_if_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    const NEEDLES: [&str; 8] = [
        "vethernet",      // Hyper-V / WSL 的 vEthernet
        "hyper-v",
        "wsl",
        "docker",
        "loopback",       // 环回伪网卡
        "default switch", // Hyper-V 默认交换机
        "virtualbox",
        "vmware",
    ];
    NEEDLES.iter().any(|k| n.contains(k))
}

/// ⭐ 排序键（**一条口径** ✓）：第一档是"像不像一张对端能到的网卡" ✓，
/// 第二档才是链路本地，第三档回到原来的**地址字节序**（确定性 ✓，判据可逐字节钉 ✓）。
fn lan_rank_key(name: Option<&str>, ip: IpAddr) -> (u8, u8, (u8, u128)) {
    let virt = name.map(is_virtual_if_name).unwrap_or(false);
    (u8::from(virt), u8::from(is_link_local_addr(ip)), ip_bits(ip))
}

/// 与 announced_bases_with 同一个内核，但**带网卡名** ⇒ 能按 lan_rank_key 把虚拟网卡排到最后 ✓。
pub fn announced_bases_with_named(addr: SocketAddr, locals: &[(String, IpAddr)]) -> Vec<String> {
    if addr.port() == 0 {
        return Vec::new();
    }
    let mut cands: Vec<(Option<&str>, IpAddr)> = if addr.ip().is_unspecified() {
        locals.iter().map(|(n, ip)| (Some(n.as_str()), *ip)).collect()
    } else {
        vec![(None, addr.ip())]
    };
    cands.retain(|(_, ip)| matches!(ip, IpAddr::V4(_)));
    cands.retain(|(_, ip)| !ip.is_loopback() && !ip.is_unspecified() && is_lan_only(*ip));
    cands.sort_by_key(|(n, ip)| lan_rank_key(*n, *ip));
    cands.dedup_by_key(|(_, ip)| *ip);
    cands.into_iter().map(|(_, ip)| format!("http://{}", SocketAddr::new(ip, addr.port()))).collect()
}

/// ★ 丙-③-b-2b：这个**实际绑上的**窗口地址该报哪个（＝别人能不能来拉我）。
///
/// 三条**都要**满足，一条不满足就**不宣告**（宁可这一轮不露面，也不要报一个拉不到的地址）：
/// 1. **端口不是 0** —— 端口 0 的意思是"还没绑上"，宣告它等于报一个没人算得出的端口；
/// 2. **不是回环** —— `lan::is_lan_base` 明确把 `127/8` 排除（"回环不是网段里的别人"），
///    宣告一个本机地址只会往网段里灌噪音；
/// 3. **是本网段地址**（`is_lan_only`，与开窗那一关同一把尺）。
///
/// ★ **D1 之后多一条**：绑**通配**时 ⇒ 从 [`local_addrs`] 枚举到的候选里取**第一个**
/// （见 [`announced_bases_with`] 的四条口径）⇒ 于是"**换网不失效**"是**每一轮重新算**出来的：
/// `lan_state` 的公告循环每轮都调它一次，**不需要**任何缓存、订阅或"网卡变化"通知。
/// ⚠️ **只报第一个**是今天**唯一**能做的形态：一次报**多个** `hub_base` 要动 `LanAnnounce`
/// （`lan.rs` 的线上字段）—— 那条路不在本任务写域里，属显式决定（见报告 §拿不准）。
pub fn announced_base(addr: SocketAddr) -> Option<String> {
    // ⭐ 2026-10-09：走**带网卡名**的那条 ⇒ 虚拟网卡不再抢到第一个 ✓（原来按字节序，172.18.* 会赢 ✓）。
    announced_bases_with_named(addr, &local_addrs_named()).into_iter().next()
}

// ─────────────────────────── 供的那一侧（最小 HTTP/1.1，不引依赖） ───────────────────────────

/// 一条请求去哪个处理函数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// `GET /mesh/pull`
    Pull,
    /// ★ 丙-④：`GET /mesh/attachment?space_id=…&hash=…` —— **本机手上那一份附件字节**。
    ///
    /// 口径与 `/mesh/pull` 同一条：**只服务我有的东西**（没有账本、不去问别人、也不代收）。
    /// 没有 ⇒ `404` ＋ 一句人话（"这一台没有" ≠ "网络故障"，这两件用户的下一步完全不同）。
    Attachment,
    /// 同步协议里**有**、但**不是网格这一档**的端点 ⇒ `501` ＋ 一句人话。
    NotYet(&'static str),
    /// 协议里根本没有这个路径 ⇒ `404`。
    Unknown,
}

pub fn route(method: &str, target: &str) -> Route {
    let path = target.split('?').next().unwrap_or("");
    let path = if path.len() > 1 { path.trim_end_matches('/') } else { path };
    match method.to_ascii_uppercase().as_str() {
        "GET" if path == "/mesh/pull" => Route::Pull,
        "GET" if path == "/mesh/attachment" => Route::Attachment,
        _ => match not_yet(path) {
            Some(what) => Route::NotYet(what),
            None => Route::Unknown,
        },
    }
}

/// 中枢那一套端点在网格窗口里**有名有姓**地回答"这一档不支持"（不是 404 让人自己猜）。
fn not_yet(path: &str) -> Option<&'static str> {
    match path {
        "/push" | "/pull" | "/spaces" => return Some("中枢 / 服务端那一套交换端点"),
        "/lineage-claim" => return Some("CRDT 血统 claim"),
        "/auth/register" | "/auth/login" | "/auth/me" | "/auth/logout" => return Some("账号"),
        _ => {}
    }
    if path.starts_with("/notifications") {
        return Some("通知");
    }
    if path.ends_with("/attachments") || path.contains("/attachments/") {
        return Some("附件同步");
    }
    if let Some(rest) = path.strip_prefix("/spaces/") {
        let mut segs = rest.split('/');
        let _space = segs.next();
        return match segs.next() {
            Some("changes-stream") => Some("近实时推流（SSE）"),
            Some("presence") | Some("online") => Some("在线态"),
            Some("members") => Some("成员管理"),
            Some("keyring") => Some("钥匙袋（换设备的公开材料）"),
            Some("pages") => Some("评论"),
            _ => None,
        };
    }
    None
}

// ─── 只绑内网（与甲-2 同一口径；丙里更紧张：**每台都开窗**） ───

/// 这个地址是不是"只在本网段可达"。
///
/// ⚠️ **`100.64.0.0/10` 必须算"本网段"** —— **owner 2026-09-30 拍 D14（放行 CGNAT）**。
/// 理由三条：
/// 1. **Tailscale 默认就用这一段**（RFC 6598 共享地址空间）⇒ 不放行 ⇒ 用户**开不了窗**，
///    因为 [`checked_bind`] 是**拒绝启动**（不是"连不上"）；
/// 2. std 的 `Ipv4Addr::is_private()` **只含 RFC 1918 三段**、`is_link_local()` **只含 `169.254/16`**
///    ⇒ 这一段**三个谓词全不满足**（本机实测：`100.64.0.1`／`100.100.1.2`／`100.127.255.254` 全 `false`）；
/// 3. ⚠️ std 里**正好**有个 `Ipv4Addr::is_shared()`（就是这一段），但它在 **MSRV 1.94.0 与
///    stable 1.98.1 上都还是 unstable**（`error[E0658] use of unstable library feature 'ip'`，
///    issue #27709，本机实测）⇒ **只能手写这一段**。
///
/// ⚠️ **与 `lan::is_private_ipv4` 是同一件事的另一把尺，必须同时放宽**：那边管消费侧
/// （认不认对端公告里的 `hub_base`）。只改这一处 ⇒ 甲尺放行、乙尺仍跳过对端 ⇒ **静默不通**
/// （`lan.rs:270` 的作者注释原话：「这里必须和消费侧用同一把尺」）。
/// 判据 `the_two_lan_range_tables_agree` 与每条 CGNAT 用例把这条钉住。
pub fn is_lan_only(ip: IpAddr) -> bool {
    match ip {
        // ⚠️ 第三支 `[100, 64..=127, ..]` ＝ **D14**（`100.64.0.0/10`，含两端）；
        //    公网地址仍然落在这三支之外 ⇒ 照旧被拒（不许把 D14 读成"放宽了内网的定义"）。
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || matches!(v4.octets(), [100, 64..=127, ..])
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

/// 解析 ＋ 把关：公网地址**拒绝启动**（不是提醒一下）。
pub fn checked_bind(bind: &str) -> Result<SocketAddr, String> {
    let bind = bind.trim();
    if bind.is_empty() {
        return Err("网格窗口必须显式给一个监听地址（`IP:端口`）—— 不留默认值".to_string());
    }
    let addr: SocketAddr = if let Some(port) = bind.strip_prefix("localhost:") {
        let port: u16 = port.parse().map_err(|_| format!("端口读不出来：{bind}"))?;
        SocketAddr::from((Ipv4Addr::LOCALHOST, port))
    } else {
        bind.parse()
            .map_err(|_| format!("监听地址只能写字面 `IP:端口`（或 `localhost:端口`）：{bind}"))?
    };
    // ⚠️ **D1（owner 2026-09-30：把"`0.0.0.0 ⇒ Err`"反过来）** ⇒ **通配绑定放行**。
    //    它就是"用户不用填 IP"的前提：听**所有**网卡（含以后才插上的那张、含虚拟网卡），
    //    至于往公告里写哪个地址，由 `announced_bases_with` 从枚举结果里算（不是 0.0.0.0）。
    //    ⚠️ 而**具体公网地址仍然拒**：D1 放的是"听我自己的所有网卡"，**不是**"公网也能听"
    //    （既有判据钉着 `8.8.8.8 ⇒ Err`，那是本任务的**不许放宽**证据）。
    if !addr.ip().is_unspecified() && !is_lan_only(addr.ip()) {
        return Err(format!(
            "拒绝启动：{addr} 不是内网地址（简报 §7 的边界：网格只在自己网段里）。\
             同一网络请用 192.168.x.x / 10.x.x.x / 172.16-31.x.x；\
             虚拟局域网（Tailscale 等）请用 100.64-127.x.x（VPN 网卡上的那个地址）；\
             不想手填就写 `0.0.0.0:<端口>`（＝听所有网卡，地址由系统报出）；\
             本机自测用 127.0.0.1。"
        ));
    }
    Ok(addr)
}

struct State {
    /// ⭐ **U8（2026-10-01）**：**每个空间一条自己的库连接**（一个空间一份库 ⇒ 服务多空间就要多连接 ✓）。
    ///
    /// ⚠️ **它同时就是"服务范围"**（键＝被服务的 `proto_space` ✓）——
    /// ⛔ 不许另存一份"范围"清单 ✗：两份清单迟早会漂，而这份就是**数据面那一份真相** ✓。
    /// ⚠️ **可增长**（用户新加一个空间 ⇒ `ensure_window` 往表里加一条 ✓，⛔ **不重启窗口** ✗）——
    /// 重启会换端口、把正在连的对端掐断，而那正是「**关掉一个空间不许关掉整窗**」同一族的坑 ✓。
    conns: Arc<Mutex<std::collections::HashMap<String, Arc<Mutex<Connection>>>>>,
    /// ⭐ **U11/T5（2026-10-02）**：这个窗口**认哪些卡**（每个空间一组 `secret_sha256` ✓）。
    ///
    /// ⚠️ **它就是授权口径** —— owner 2026-10-02 选 **A：门只认卡** ✓
    /// ⇒ ⛔ 旧的共享口令**不再能进** ✗（否则「删掉那一行」对拿到过共享口令的设备不成立 ✗，
    /// U11 就成了「看起来有其实没有」✓）。
    /// ⚠️ 键＝`proto_space`；值＝那一组卡的哈希（**只存哈希** ✓，明文只在本机"我要出示"那一侧 ✓）。
    paired: Arc<Mutex<CardBook>>,
    cfg: MeshConfig,
    /// ★ **T-10**（`U14` 的判据承载）：这个窗口**真正服务过**的 `/mesh/pull` 次数（只增）。
    ///
    /// 为什么要这一个数：10 台那一档的判据 ③（每台 ≤2 次/秒、合计 ≤18 次/秒）**必须从
    /// "实际发生的拉取"里数出来**，而客户端手上只有"我发起了几次" —— 哪天多出一条隐式拉取
    /// （跳号回退、重试、附件），客户端那一侧**看不见**。这个计数器记的是"请求真的到了、
    /// 且过了鉴权"的次数 ⇒ 两边对不上就是有额外拉取（判据里就是这么交叉验的）。
    served_pulls: Arc<AtomicUsize>,
    /// ⭐ 2026-10-23（S3b-发，方案 §7.3）：**"我知道、但这一轮开不了"的空间**（多半是加密且未解锁）。
    ///
    /// 它们不在 `conns` 里（开不了库），但**仍然是我的空间** —— 鉴权要放行，
    /// 拉取走"封包"那条路（从 `meta.mesh_outbox` 搬已经封好的那几条 ✓）。
    /// ⚠️ 与 `conns` **分开存是有意的**：`conns` 回答"我能开库的有哪些"，
    /// 这一格回答"我知道、但现在打不开的有哪些" —— 两件事，⛔ 不合并 ✗。
    locked: Arc<Mutex<std::collections::HashSet<String>>>,
}

impl State {
    /// ⭐ **U8：这一条请求要哪个空间 ⇒ 给出它**自己那条**连接**；不在范围内 ⇒ **403**。
    ///
    /// ⚠️ 三条写在这里，因为它们是**这一片的安全面** ✓：
    ///   ① **白名单**：`?space_id=` 不在 `conns` 里 ⇒ 403（**绝不**退回"随便挑一个"✗）；
    ///   ② **连接按空间取**：`handle_attachment` 的空间 id 是**从这条连接的 meta 里读的**
    ///      ⇒ 取错连接 ＝ **把别人的附件字节发出去** ✗；
    ///   ③ **省略 `?space_id=` 的语义**（⚠️ **显式决定**，2026-10-01）：**只服务一个空间**时用它
    ///      （向后兼容旧客户端 ✓）；**服务多个**时 ⇒ **400**（说不清要哪个 ⇒ ⛔ **不猜** ✗）。
    ///      既有判据 `the_space_id_gate_refuses_by_default_and_never_leaks_before_refusing` 钉着它 ✓。
    /// ⭐ 2026-10-23（S3b-发）：这个空间**现在**在不在服务范围（= 库开着）。
    fn serves(&self, space: &str) -> bool {
        match self.conns.lock() {
            Ok(g) => g.contains_key(space),
            Err(_) => false,
        }
    }

    /// ⭐ 2026-10-23（S3b-发）：这个空间是不是"我知道、但这一轮开不了"（多半：加密未解锁）。
    fn is_locked(&self, space: &str) -> bool {
        match self.locked.lock() {
            Ok(g) => g.contains(space),
            Err(_) => false,
        }
    }

    fn select_space(&self, target: &str) -> Result<Arc<Mutex<Connection>>, Reply> {
        let want = match query_get(target, "space_id") {
            Ok(v) => v,
            Err(e) => return Err(Reply::json(400, "Bad Request", json_error(&e))),
        };
        // ⚠️ **克隆出 `Arc` 再放锁**（别把 `&` 借出去 —— 那要么撑大借用期、要么逼出 unsafe ✗）
        let guard = match self.conns.lock() {
            Ok(g) => g,
            Err(_) => {
                return Err(Reply::json(500, "Internal Server Error", json_error("空间连接表的锁被毒掉了")))
            }
        };
        let space = match want {
            Some(s) => s,
            None => match guard.len() {
                1 => guard.keys().next().cloned().unwrap_or_default(),
                _ => {
                    return Err(Reply::json(
                        400,
                        "Bad Request",
                        json_error("这个窗口服务**多个**空间 ⇒ 请求必须带 `?space_id=`（说不清要哪个，不猜）"),
                    ))
                }
            },
        };
        match guard.get(&space) {
            Some(c) => Ok(c.clone()),
            None => {
                let mut names: Vec<String> = guard.keys().cloned().collect();
                names.sort_unstable();
                Err(Reply::json(
                    403,
                    "Forbidden",
                    json_error(&format!("这个窗口只服务这些空间：{}（收到 {space}）", names.join("、"))),
                ))
            }
        }
    }
}

/// 一个网格窗口的配置。
///
/// ⭐ **U8（2026-10-01）**：⛔ 去掉了 `space_id` ✗ —— **"服务哪些空间"改由 `State::conns` 的键表达** ✓
/// （见 `State` 的注释）。窗口级只剩**绑哪儿 ＋ 用什么口令 ＋ 自称是谁** ✓。
#[derive(Debug, Clone)]
pub struct MeshConfig {
    pub bind: String,
    /// 本机对外自称的 `device_id` —— 窗口**只服务它自己的记录**。
    pub device_id: String,
    // ⛔ **`token` 已删**（owner 2026-10-02 选 **A：门只认卡** ✓）——
    //    理由写进 `personal-edition-spec` §3.3-⑥：留着共享口令 ⇒「删掉那一行」对
    //    **拿到过共享口令的设备不成立** ✗ ⇒ U11 变「看起来有其实没有」✓。
    //    ⚠️ 旧的 `mesh_token:<space>` KV **保留可读**（不静默删 ✓）但**不再作任何凭证** ✗。
    /// ★ 丙-④：**数据目录**（附件字节在这棵树下的 `<本地空间>/…`）——
    /// `None` ⇒ 这一档**不服务附件**，`/mesh/attachment` 如实回 501（不是 404：
    /// "没配"和"这一台没有这份文件"是两件不同的事）。
    /// ⚠️ 由 `open_window_at` 从调用方给的目录填（判据因此能塞一个临时目录，
    /// 不去碰 `APP_DATA_DIR` 那个全局 —— 那个全局会让"单跑红、全量绿"）。
    pub data_dir: Option<std::path::PathBuf>,
}

pub struct MeshHandle {
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
    served_pulls: Arc<AtomicUsize>,
    /// ⭐ **U8**：与 `State::conns` **同一份**（同一个 `Arc` ✓）——
    /// `ensure_window` 靠它往里**加空间**（⛔ 不重启窗口 ✗）；`stop_window` 靠它**摘掉**一个空间 ✓。
    conns: Arc<Mutex<std::collections::HashMap<String, Arc<Mutex<Connection>>>>>,
    /// ⭐ **U11**：与 `State::paired` 同一份 ⇒ **逐台解除**时要把那张卡从**正在跑的门**里也摘掉 ✓
    /// （⛔ 只删库不算 ✗ —— 那个窗口还认着它，直到下次重启 ⇒ 那就是"删了等于没删"✓）。
    paired: Arc<Mutex<CardBook>>,
    /// ⭐ 2026-10-23（S3b-发）：与 `State::locked` 同一个 `Arc` —— `ensure_window` 跳过谁就标谁，
    /// 于是"我知道、但这一轮开不了"这件事**只记一处** ✓（⛔ 不另立清单 ✗）。
    locked: Arc<Mutex<std::collections::HashSet<String>>>,
}

impl MeshHandle {
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// ⭐ 2026-10-23（S3b-发）：把"这个空间我知道、但这一轮开不了"记上 —— 鉴权会放行它，
    /// 拉取会走"封包"那条路（见 `State::is_locked` 与 `serve_locked_outbox`）。
    pub fn mark_locked(&self, proto_space: &str) {
        if let Ok(mut g) = self.locked.lock() {
            g.insert(proto_space.to_string());
        }
    }

    /// ⭐ **U8**：这一扇门现在**服务哪些空间**（**排过序** ⇒ 读数确定 ✓）。
    pub fn served(&self) -> Vec<String> {
        match self.conns.lock() {
            Ok(g) => {
                let mut v: Vec<String> = g.keys().cloned().collect();
                v.sort_unstable();
                v
            }
            Err(_) => Vec::new(),
        }
    }

    /// ⭐ **U8**：把这个空间**加进**这扇门（已经在里面 ⇒ 什么都不做 ✓，回 `false` ✓）。
    ///
    /// ⚠️ 开的是**这个空间自己那份库**（`db_space` ≠ `proto_space` —— 那条真机教训见 `ensure_window` ✓）。
    pub fn add_space(&self, db_space: &str, proto_space: &str, dir: &Path) -> Result<bool, String> {
        let mut guard = self.conns.lock().map_err(|_| "空间连接表的锁被毒掉了".to_string())?;
        if guard.contains_key(proto_space) {
            return Ok(false);
        }
        let conn = crate::db::open_space_conn_at(db_space, dir)?;
        guard.insert(proto_space.to_string(), Arc::new(Mutex::new(conn)));
        Ok(true)
    }

    /// ⭐ **U11**：把**这个空间**的卡表也载进来 ✓。
    ///
    /// ⚠️ **U8 的"门已开着、往里加空间"那条路上必须一起做** ✗ ——
    /// 只加连接不载卡 ⇒ 那个空间**服务着、但谁都进不来**（401 ✓）
    /// ⇒ ⭐ **这是 U8 判据当场抓到的真 bug** ✓（2026-10-02 实测：`three_spaces_share_one_window_…`
    /// 里 proto-2 回 401 而期望 200 ✓）。
    pub fn load_cards_for(&self, proto_space: &str, dir: &Path, device_level: bool) -> Result<(), String> {
        let mut fresh = CardBook::new();
        load_cards(dir, proto_space, device_level, &mut fresh);
        let add = fresh.remove(proto_space).unwrap_or_default();
        let mut guard = self.paired.lock().map_err(|_| "配对卡表的锁被毒掉了".to_string())?;
        let cards = guard.entry(proto_space.to_string()).or_default();
        for h in add.hashes {
            cards.hashes.insert(h);
        }
        // ⭐ 2026-10-12（第 2 步）：⭐ 公钥那一档**也一起并** ✗
        //   （⛔ 只并哈希 ⇒ 新那一档配对出来的门**永远认不出来** ✗ —— "库里有、跑着的门不认"那一族 ✓）。
        for (dev, pk) in add.pubkeys {
            cards.pubkeys.insert(dev, pk);
        }
        Ok(())
    }

    /// ⭐ **U11**：把**这一张卡**从正在跑的门里摘掉（回"摘掉了吗"✓）。
    ///
    /// ⚠️ **必须做** ✗：只删库里那一行 ⇒ 运行中的窗口**还认着那张卡** ⇒ 直到重启/换绑
    /// ⇒ 用户看到的是"**删了等于没删**" ✗（正是 T5 判据① 要挡的 ✓）。
    pub fn forget_paired_hash(&self, proto_space: &str, secret_sha256: &str) -> Result<bool, String> {
        let mut guard = self.paired.lock().map_err(|_| "配对卡表的锁被毒掉了".to_string())?;
        Ok(guard.get_mut(proto_space).map(|c| c.hashes.remove(secret_sha256)).unwrap_or(false))
    }

    /// ⭐ **2026-10-12（第 2 步）**：把**那一台的公钥**从正在跑的门里摘掉 ✗
    /// （⭐ `forget_paired_hash` 在新那一档上的对应物 ✓ —— ⛔ 只删库那一步不够 ✗，同一条理由 ✓）。
    pub fn forget_paired_device(&self, proto_space: &str, device_id: &str) -> Result<bool, String> {
        let mut guard = self.paired.lock().map_err(|_| "配对卡表的锁被毒掉了".to_string())?;
        Ok(guard.get_mut(proto_space).map(|c| c.pubkeys.remove(device_id).is_some()).unwrap_or(false))
    }

    /// ⭐ **U11/T5**：把**刚登记的这一张卡**加进正在跑的门（回"新加的吗"✓）——
    /// **`forget_paired_hash` 的反面**，同样必须做 ✗（理由见 `mesh::add_paired` ✓）。
    ///
    /// ⚠️ 这个空间**不在服务范围**里 ⇒ 门**别替它开格子** ✗（那样只会让读数里多一个
    /// "服务着但没连接"的空壳 ✓）⇒ 返回 `false`，库里那张卡等下次开门时载 ✓。
    pub fn add_paired_hash(&self, proto_space: &str, secret_sha256: &str) -> Result<bool, String> {
        // ⚠️ 先问"服务不服务"、**再**锁卡表 —— 两把锁**不许嵌套** ✗
        //    （`conns` 与 `paired` 各有各的调用方，嵌套迟早会撞上反向顺序 ✓）。
        if !self.serves(proto_space) {
            return Ok(false);
        }
        let mut guard = self.paired.lock().map_err(|_| "配对卡表的锁被毒掉了".to_string())?;
        Ok(guard.entry(proto_space.to_string()).or_default().hashes.insert(secret_sha256.to_string()))
    }

    /// ⭐ **2026-10-12（第 3 步）**：把**那一台的公钥**加进这道门的卡册（回"新加的吗"✓）——
    /// ⭐ `add_paired_hash` 在**新那一档**上的对应物 ✓（同一条"先问服务不服务、再锁卡册"✓）。
    pub fn add_paired_pubkey(
        &self,
        proto_space: &str,
        device_id: &str,
        pubkey_hex: &str,
    ) -> Result<bool, String> {
        if !self.serves(proto_space) {
            return Ok(false);
        }
        let mut guard = self.paired.lock().map_err(|_| "配对卡表的锁被毒掉了".to_string())?;
        let cards = guard.entry(proto_space.to_string()).or_default();
        Ok(cards
            .pubkeys
            .insert(device_id.to_string(), pubkey_hex.trim().to_string())
            .map(|old| old != pubkey_hex.trim())
            .unwrap_or(true))
    }

    /// ⭐ **U11**：这一扇门现在**认几张卡**（这个空间 ✓；读数用 ✓）。
    ///
    /// ⚠️ 2026-10-12（第 2 步）后**两档各算一份** ✗（哈希 ＋ 公钥 ✓）——
    /// ⭐ 它只是**读数** ✓，⛔ 不参与任何判定 ✗（真判定在 `authorized` ✓）。
    pub fn paired_card_count(&self, proto_space: &str) -> usize {
        match self.paired.lock() {
            Ok(g) => g.get(proto_space).map(|c| c.hashes.len() + c.pubkeys.len()).unwrap_or(0),
            Err(_) => 0,
        }
    }

    /// ⭐ **U8**：这一扇门现在**服务不服务**这个空间 ✓。
    pub fn serves(&self, proto_space: &str) -> bool {
        match self.conns.lock() {
            Ok(g) => g.contains_key(proto_space),
            Err(_) => false,
        }
    }

    /// ⭐ **U8**：把**这一个空间**从门里摘掉；回「摘完之后门里**还有没有别人**」✓。
    ///
    /// ⚠️ 这就是 T6 的「**关掉一个空间不许关掉整窗**」✓ —— 调用方据此决定要不要真停 ✓。
    pub fn remove_space(&self, proto_space: &str) -> Result<bool, String> {
        let mut guard = self.conns.lock().map_err(|_| "空间连接表的锁被毒掉了".to_string())?;
        guard.remove(proto_space);
        Ok(!guard.is_empty())
    }

    /// ★ **T-10**：这个窗口**真正服务过**的 `/mesh/pull` 次数（只增；口径见 `State::served_pulls`）。
    ///
    /// ⚠️ **2026-09-30 收据**（`check-dead-code-receipts` 要的）：今天唯一的读者是 `#[ignore]` 的
    /// T-10 判据（`ten_devices_converge_with_no_device_left_behind`）⇒ 在**产品二进制**里没人读它。
    /// **删除条件** ＝ 产品侧真有了"拉取计数"的读数口（那时它会**被生产代码读**，这条豁免就该撤），
    /// 或 T-10 那一档被别的形态取代那天。
    #[allow(dead_code)]
    pub fn served_pulls(&self) -> usize {
        self.served_pulls.load(Ordering::Relaxed)
    }
}

impl Drop for MeshHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

/// 起一个网格窗口（阻塞式 accept 线程 ＋ 每连接一个线程；**不引任何依赖**）。
pub fn start(
    cfg: MeshConfig,
    conns: Arc<Mutex<std::collections::HashMap<String, Arc<Mutex<Connection>>>>>,
    paired: Arc<Mutex<CardBook>>,
) -> Result<MeshHandle, String> {
    let addr = checked_bind(&cfg.bind)?;
    let listener = TcpListener::bind(addr).map_err(|e| format!("网格窗口绑不上 {addr}：{e}"))?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    // ⭐ U8：一条请求要哪个空间由 `?space_id=` 决定 ⇒ 日志把**服务范围**印全（排过序 ⇒ 确定 ✓）
    let served: Vec<String> = {
        let g = conns.lock().map_err(|_| "空间连接表的锁被毒掉了".to_string())?;
        let mut v: Vec<String> = g.keys().cloned().collect();
        v.sort_unstable();
        v
    };
    // ⭐ U11：**"不设防"的判据从"没设口令"改成"一张卡都没有"** ✓
    //    —— 因为 A 之后口令已经不作凭证了 ✓；而"零张卡"确实等于"谁都能…"？不 ✓：
    //    零张卡 ⇒ **谁都进不来**（门只认卡 ✓）⇒ 所以这里要说的不是"危险"，而是"**进不来**" ✓。
    {
        let cards: usize = match paired.lock() {
            Ok(g) => g.values().map(|c| c.hashes.len() + c.pubkeys.len()).sum(),
            Err(_) => 0,
        };
        if cards == 0 {
            eprintln!(
                "[mesh] ⚠️ 网格窗口（{bound}，服务 {} 个空间：{}）**一张配对的卡都没有** ⇒ **谁都拉不动**（门只认卡 ✓）：先在设置面配对 ✓。",
                served.len(),
                served.join("、")
            );
        }
    }
    eprintln!(
        "[mesh] 网格窗口已启动：{bound} ｜ 服务 {} 个空间：{} ｜ 自称 {}",
        served.len(),
        served.join("、"),
        cfg.device_id
    );

    let served_pulls = Arc::new(AtomicUsize::new(0));
    let locked = Arc::new(Mutex::new(std::collections::HashSet::new()));
    let state = Arc::new(State {
        conns: conns.clone(),
        paired: paired.clone(),
        cfg,
        served_pulls: served_pulls.clone(),
        locked: locked.clone(),
    });
    let stop = Arc::new(AtomicBool::new(false));
    let stop_in = stop.clone();
    let join = std::thread::Builder::new()
        .name("mesh".to_string())
        .spawn(move || {
            while !stop_in.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((sock, _)) => {
                        let st = state.clone();
                        std::thread::spawn(move || {
                            let _ = handle_conn(sock, st);
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(POLL),
                    Err(_) => std::thread::sleep(POLL),
                }
            }
        })
        .map_err(|e| format!("网格窗口线程起不来：{e}"))?;
    Ok(MeshHandle { addr: bound, stop, join: Some(join), served_pulls, conns, paired, locked })
}

struct Request {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

fn read_request(sock: &mut TcpStream) -> Result<Request, String> {
    let _ = sock.set_read_timeout(Some(IO_TIMEOUT));
    let _ = sock.set_write_timeout(Some(IO_TIMEOUT));
    let mut raw: Vec<u8> = Vec::new();
    let mut buf = [0u8; 4096];
    let head_end = loop {
        if let Some(p) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break p + 4;
        }
        if raw.len() > MAX_HEAD {
            return Err("请求头太大".to_string());
        }
        let n = sock.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("半截请求".to_string());
        }
        raw.extend_from_slice(&buf[..n]);
    };
    let head = String::from_utf8_lossy(&raw[..head_end - 4]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    if method.is_empty() || target.is_empty() {
        return Err(format!("请求行读不出来：{request_line}"));
    }
    let mut headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let want: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    if want > MAX_BODY {
        return Err(format!("请求体太大：{want}"));
    }
    let mut body = raw[head_end..].to_vec();
    while body.len() < want {
        let n = sock.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("半截请求".to_string());
        }
        body.extend_from_slice(&buf[..n]);
    }
    body.truncate(want);
    // ⚠️ 网格的端点**都不吃体**（`GET /mesh/pull`）。这里仍然把它读掉：不读的话，
    // 一个带体的请求会把体字节留在连接上 —— 现在是 `Connection: close` 所以无害，
    // 但"读干净"这个习惯别丢（将来若接 keep-alive，那就是一串解析错误）。
    let _ = body;
    Ok(Request { method, target, headers })
}

/// 一个响应：状态码 ＋ 原因 ＋ 体（**字节**）＋ 内容类型。
///
/// ⚠️ 为什么从三件套 `(u16, &'static str, String)` 改成结构体：丙-④ 要让这个窗口**发附件字节**
/// （几十 MB 的二进制），而原来的 `respond` 把 `Content-Type` 写死成 JSON、且只收 `&str`。
/// 给二进制另开一条 `respond_bytes` 会让"写头 / Content-Length / flush"变成两份实现 ——
/// 而两份里只要有一边写错长度，症状就是"偶尔截断"，是最难查的那一类。
struct Reply {
    code: u16,
    reason: &'static str,
    content_type: &'static str,
    body: Vec<u8>,
}

impl Reply {
    fn json(code: u16, reason: &'static str, body: String) -> Self {
        Reply { code, reason, content_type: "application/json; charset=utf-8", body: body.into_bytes() }
    }

    /// 原始字节（附件）：`application/octet-stream` —— 具体 mime 由**收侧**按本地元数据判
    /// （与甲那条 `GET /attachments/<hash>` 同一口径：**字节就是字节**，元数据各机自己有一份）。
    fn bytes(code: u16, reason: &'static str, body: Vec<u8>) -> Self {
        Reply { code, reason, content_type: "application/octet-stream", body }
    }
}

fn respond(sock: &mut TcpStream, reply: &Reply) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        reply.code,
        reply.reason,
        reply.content_type,
        reply.body.len()
    );
    sock.write_all(head.as_bytes())?;
    sock.write_all(&reply.body)?;
    sock.flush()
}

fn json_error(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

fn handle_conn(mut sock: TcpStream, state: Arc<State>) -> Result<(), String> {
    // ⚠️ **accepted socket 必须显式设回阻塞**：listener 是 `set_nonblocking(true)` 的，
    // 而 **macOS/BSD 的 `accept()` 会让新 socket 继承 `O_NONBLOCK`**（Linux 不继承）。
    // 后果（T-10 十台那一档实测抓到）：`respond` 的 `write_all` 在**大响应**上写半截就返回
    // `WouldBlock` ⇒ 连接被丢掉 ⇒ 客户端看到截断的响应
    // （hyper：`client error (SendRequest) ← received unexpected message from connection`）。
    // 2 台那几条判据的响应只有一条记录（几百字节）⇒ 恰好没暴露它。
    // 而 `read_request` 本来就设了读写超时 —— 那些只对**阻塞** socket 有效 ⇒ 这里也本该是阻塞的。
    let _ = sock.set_nonblocking(false);
    let req = match read_request(&mut sock) {
        Ok(r) => r,
        Err(e) => {
            let reply = Reply::json(400, "Bad Request", json_error(&format!("请求读不出来：{e}")));
            let _ = respond(&mut sock, &reply);
            return Ok(());
        }
    };
    let reply = dispatch(&state, &req);
    respond(&mut sock, &reply).map_err(|e| e.to_string())
}

fn dispatch(state: &State, req: &Request) -> Reply {
    // ⭐ U11：门只认卡，且**分清 401／403**（见 `authorized` 头注 ✓）
    if let Err(r) = authorized(state, req) {
        return r;
    }
    match route(&req.method, &req.target) {
        Route::Pull => {
            // ★ **T-10**：**在线上真的发生过**的拉取在这里计数（`authorized` 之后 ⇒ 只数被服务的）。
            state.served_pulls.fetch_add(1, Ordering::Relaxed);
            handle_pull(state, &req.target)
        }
        Route::Attachment => handle_attachment(state, &req.target),
        Route::NotYet(what) => Reply::json(
            501,
            "Not Implemented",
            serde_json::json!({
                "error": format!("网格窗口（丙-③）不提供「{what}」"),
                "endpoint": format!("{} {}", req.method, req.target),
                "hint": "这是**明确的不支持**（不是网络故障、也不是空结果）：中心那一套端点在网格这一档里没有位置。",
            })
            .to_string(),
        ),
        Route::Unknown => Reply::json(
            404,
            "Not Found",
            json_error("这个路径不在网格协议里（'协议里有但这一档没有'是另一回事，那种回 501）"),
        ),
    }
}

/// ⭐ **U11/T5（2026-10-02）：门只认卡** —— owner 选 **A**（退役共享口令）✓。
///
/// 三步，缺一不可 ✓：
///   ① **必须出示**（没给 `Authorization` ⇒ 拒 ✓）—— ⛔ 不再有"没设口令就全放行"那条路 ✗
///      （那正是 A 要消灭的：留着它 ⇒「删掉那一行」对拿到过共享口令的设备**不成立** ✗）；
///   ② 从 `?space_id=` **定位空间**（缺参数时与 `select_space` 同一口径：只服务一个 ⇒ 用它 ✓；
///      多个 ⇒ 拒 ✓ —— ⛔ **不猜** ✗）；
///   ③ 出示的那串算 `sha256`，在**那个空间**的卡表里找 ✓（表里的就是**已登记**、**未解除**的卡 ✓）。
///
/// ⚠️ 哈希只有**一处**实现（`crate::db::sha256_hex` ✓）：写入侧与这里共用 ⇒ 不会漂 ✓。
fn authorized(state: &State, req: &Request) -> Result<(), Reply> {
    // ① 先**定位空间**（缺参数时与 `select_space` 同一口径：只服务一个 ⇒ 用它 ✓；多个 ⇒ 拒 ✓ 不猜 ✗）
    let space = match query_get(&req.target, "space_id") {
        Ok(Some(s)) => s,
        Ok(None) => {
            let Ok(guard) = state.conns.lock() else {
                return Err(Reply::json(500, "Internal Server Error", json_error("空间连接表的锁被毒掉了")));
            };
            match guard.len() {
                1 => guard.keys().next().cloned().unwrap_or_default(),
                _ => {
                    return Err(Reply::json(
                        400,
                        "Bad Request",
                        json_error("这个窗口服务**多个**空间 ⇒ 请求必须带 `?space_id=`（说不清要哪个，不猜）"),
                    ))
                }
            }
        }
        Err(e) => return Err(Reply::json(400, "Bad Request", json_error(&e))),
    };
    // ② ⭐ **空间不在服务范围 ⇒ 403**（认得出你，但这不是我的空间 ✓）
    //    ⚠️ **别把它混进 401** ✗ —— 既有两条判据（`the_space_id_gate_…` 与 `the_window_serves_…`）
    //    都要求这里回 **403** ✓（2026-10-02 实测踩到过：混成 401 ⇒ 两条判据当场红 ✓）。
    let served = state.serves(&space) || state.is_locked(&space);
    if !served {
        return Err(Reply::json(
            403,
            "Forbidden",
            json_error(&format!("这个窗口不服务空间 {space}（不是「没带证件」，是「这不是我的空间」）")),
        ));
    }
    // ③ ⭐⭐ **2026-10-12（设备身份第 2 步）**：⭐ **先试签名那一档** ✗ ——
    //    三格头（`x-shuyo-dev` ／ `x-shuyo-ts` ／ `x-shuyo-sig`）齐 ⇒ ⭐ 按**那一台的公钥**验签 ✓。
    //    ⚠️ **两档各看各的** ✗（方案 §5① 选 ⓐ：旧那一档**继续认** ✓ —— 停认的时点是 owner 的事 ✓）：
    //      · 签名**过** ⇒ 立刻放行 ✓（⭐ 而且出站那一侧签完就**不再带口令** ✓ ⇒ 口令的上线窗口收窄 ✓）；
    //      · 签名**没过** ⇒ ⛔ **不在这里直接 401** ✗，而是**落回**下面旧那一档 ✓ ——
    //        ⭐ 理由（过渡期专用 ✓）：⭐ 老配对的**行里还没有公钥** ✓（第 3 步才开始登记 ✓）；
    //        若这里硬拒，那些对端会**当场断** ✓，而 ⓐ 之下旧那一档本来就还开着 ✓
    //        （⇒ 回退**不额外给任何东西** ✓：知道口令的人本来就能走旧那一档 ✓）。
    //    ⚠️⭐ **等 owner 选 ⓒ（停认旧那一档）时，这一段必须改成"签名不过 ⇒ 直接 401"** ✗ ——
    //      否则"把签名弄坏就能降级"就是一条真洞 ✓（⛔ 那时标志是：旧那一档那一段被删掉 ✓）。
    let mut sig_refusal: Option<&'static str> = None;
    if let Some(dev) = req.header(HDR_DEVICE).map(str::trim).filter(|s| !s.is_empty()) {
        let ts = req.header(HDR_TS).and_then(|v| v.trim().parse::<i64>().ok());
        let sig = req.header(HDR_SIG).map(str::trim).filter(|s| !s.is_empty());
        match (ts, sig) {
            (Some(ts), Some(sig)) => {
                let now = crate::db::now_ms();
                if (now - ts).abs() > AUTH_WINDOW_MS {
                    sig_refusal = Some("这份签名**过期**了（或对端时钟偏得太多）");
                } else {
                    let pk = match state.paired.lock() {
                        Ok(g) => g.get(&space).and_then(|c| c.pubkeys.get(dev).cloned()),
                        Err(_) => None,
                    };
                    match pk {
                        None => {
                            sig_refusal =
                                Some("这个空间里**没有登记过这台设备的公钥**（没被信任过，或已被逐台解除）")
                        }
                        Some(pk) => {
                            // ⭐ 签的那串由**同一句**重建 ✗（`auth_message` ✓）—— ⚠️ 用的是
                            //   **这一条请求真实的** `method` ／ `target` ✓（⭐ 签名绑死"这一个请求" ✓）
                            let msg = auth_message(dev, &space, ts, &req.method, &req.target);
                            if crate::device_key::verify_hex(&pk, msg.as_bytes(), sig) {
                                return Ok(());
                            }
                            sig_refusal = Some("签名对不上（不是这台签的，或这条请求被改过）");
                        }
                    }
                }
            }
            _ => sig_refusal = Some("签名那一档要**三格一起**给（设备号／时间戳／签名）—— 现在缺格，不猜"),
        }
    }
    // ③-b ⭐ **旧那一档（过渡）**：出示共用口令 ⇒ 它的 `sha256` 在名单里就算过 ✓
    let Some(got) = req
        .header("authorization")
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty())
    else {
        return Err(Reply::json(
            401,
            "Unauthorized",
            json_error(&match sig_refusal {
                Some(why) => format!("没通过，而且口令那一档也没出示：{why}"),
                None => "这个网格窗口要**配对的卡**（Authorization: Bearer …）或一份**设备签名**，两者都没出示".to_string(),
            }),
        ));
    };
    let h = crate::db::sha256_hex(got);
    let ok = match state.paired.lock() {
        Ok(g) => g.get(&space).map(|cards| cards.hashes.contains(&h)).unwrap_or(false),
        Err(_) => false,
    };
    if ok {
        Ok(())
    } else {
        Err(Reply::json(
            401,
            "Unauthorized",
            json_error("这张卡不在这个空间的名单里（**没配过对**，或**已经被逐台解除** ✓）"),
        ))
    }
}

// ─────────────── ⭐ 2026-10-12（设备身份第 2 步）：请求签名 ✗ ───────────────

/// 签名请求头的三格（⭐ 客户端与门**共用**这三格 ✓ —— ⛔ 不许各写一份字面量 ✗）。
pub(crate) const HDR_DEVICE: &str = "x-shuyo-dev";
pub(crate) const HDR_TS: &str = "x-shuyo-ts";
pub(crate) const HDR_SIG: &str = "x-shuyo-sig";

/// ⭐ 签名的**有效窗口**（毫秒 ✓）—— ⚠️ 它挡的是「**旧包**重放」✗，⛔ **不挡**"窗口内的重放" ✗。
///
/// ⭐ 如实记（不做假保证）✗：网线上那条 `/mesh/pull` 的**响应本来就是明文** ✓ ⇒
/// ⭐ 一个**被动窃听者**根本不需要重放 ✓（它直接读响应 ✓）。这条窗口针对的是
/// ⭐ "把**旧请求**捡起来再发一遍"这一类 ✓，而 2 分钟足够盖住正常的时钟偏差 ✓。
pub(crate) const AUTH_WINDOW_MS: i64 = 120_000;

/// ⭐⭐ **签名覆盖的那串**（⭐ **一处实现** ✗ —— 门那一侧照**同一句**重建 ✓）。
///
/// 覆盖五样（⭐ 少一样就少一道绑定 ✓）：
/// `device_id`（⭐ 哪台在说话 ✓）／`space`（⭐ 对哪个空间 ✓）／`ts_ms`（⭐ 抗重放窗口用它 ✓）
/// ／`method` ＋ `target`（⭐ **哪一个请求** ✓ —— ⛔ 少了 target，一次签名就能换任何路径 ✗）。
pub(crate) fn auth_message(
    device_id: &str,
    space: &str,
    ts_ms: i64,
    method: &str,
    target: &str,
) -> String {
    format!("SHUYO-MESH-AUTH-1\n{device_id}\n{space}\n{ts_ms}\n{method}\n{target}")
}

/// ⭐ `/mesh/pull` 要的 **target**（⭐ 纯函数、**一处拼** ✗）——
/// ⚠️ 签的是它、发的也是它 ✓：⛔ 两处各拼一份 ⇒ 一漂就验不过 ✗（判据里那条端到端钉这条 ✓）。
///
/// ⭐ 2026-10-23（S3b-发）：多带两格能力/身份 ——
/// `caps=sealed1`（我认得封包）＋ `name_sha=<sha256(空间名)>`（锁着时对方按它找我的那个空间）。
/// ⚠️ 名字**不能**直接进来：`query_get` 不做 URL 解码，而名字里可能有 `&`（本机真有「客户&伙伴」）。
pub(crate) fn pull_target(space_id: &str, since: i64, name_sha: &str) -> String {
    format!(
        "/mesh/pull?space_id={space_id}&since={since}&limit={MAX_LIMIT}&caps=sealed1&name_sha={name_sha}"
    )
}

/// ⭐ `/mesh/attachment` 要的 target（⭐ 同上：一处拼 ✗）。
pub(crate) fn attachment_target(space_id: &str, hash: &str) -> String {
    format!("/mesh/attachment?space_id={space_id}&hash={hash}")
}

/// ⭐ 为**这一次请求**签一份凭证 ✗（⭐ `(ts_ms, sig_hex)` ✓）。
///
/// ⚠️ **拿不到身份 ⇒ `None`** ✓（⭐ 调用方据此退回"旧那一档"✓，⛔ 不假装签了 ✗）。
pub fn sign_request(
    c: &Connection,
    device_id: &str,
    space: &str,
    method: &str,
    target: &str,
    now_ms: i64,
) -> Option<(i64, String)> {
    let id = crate::device_key::load_or_create(c).ok()?;
    let msg = auth_message(device_id, space, now_ms, method, target);
    Some((now_ms, id.sign_hex(msg.as_bytes())))
}

/// ⭐ 一个空间的**卡册** ✗ —— ⭐ 两档**并存** ✓（方案 §4 ③ 的"加法"）：
/// · `hashes` ＝ **旧那一档**：出示共用口令 ⇒ 它的 `sha256` 在这儿 ✓（⚠️ 过渡用 ✓，
///   ⛔ 认不认它由 owner 拍 ✓：方案 §5① ✓）；
/// · `pubkeys` ＝ **新那一档**：`device_id → 公钥十六进制` ✓（⭐ 门据此**验签** ✓）。
#[derive(Default, Clone)]
pub(crate) struct SpaceCards {
    pub(crate) hashes: std::collections::HashSet<String>,
    pub(crate) pubkeys: std::collections::HashMap<String, String>,
}

/// 整本卡册（键 ＝ 门服务的那个空间 `proto_space` ✓）。
pub(crate) type CardBook = std::collections::HashMap<String, SpaceCards>;

/// ⭐ **U11**：把库里那个空间的卡**载进内存表**（开门时载一次 ✓；解除时摘一张 ✓）。
///
/// ⚠️ 载不进来（库打不开 / 表不在）⇒ **空表** ⇒ 门**谁都进不来** ✓（⛔ 不是"放行" ✗）。
///
/// ⭐⭐ **2026-10-11（丙）**：⭐ **库里读哪一行**由 [`paired_row_key`] 定 ✓（个人档 ⇒ 空串那一行 ✓），
/// 而**内存卡表的键**永远是 `proto_space` ✓（＝ 门服务的那个空间 ＝ 请求里 `?space_id=` ✓）。
/// ⛔ **这两个不是一回事** ✗ —— 个人的 `proto_space` 是配对暗号 ✓，不是空串 ✗（合起来就串空间 ✓）。
///
/// ⭐⭐ **2026-10-12（第 2 步）**：⭐ 两档**一起载** ✗（旧：哈希 ✓／新：公钥 ✓）——
/// ⚠️ 行键那一步**只有这一处** ✓ ⇒ ⛔ 两档不许各算一次行键 ✗（那是第二处判定 ✓）。
fn load_cards(dir: &Path, proto_space: &str, device_level: bool, into: &mut CardBook) {
    let Ok(meta) = crate::db::open_meta_conn_at(dir) else { return };
    let row = paired_row_key(proto_space, device_level);
    let cards = into.entry(proto_space.to_string()).or_default();
    // ⭐ 两档**各查各的、互不连坐** ✗：⭐ 一档的查询失败（老库缺列 / 表不在）**不该把另一档也清空** ✓
    //   （⛔ 否则一个 SELECT 出错 ＝ 门谁都进不来 ＝ 一条安静的升级事故 ✓）。
    if let Ok(hashes) = crate::db::paired_secret_hashes(&meta, row) {
        for h in hashes {
            cards.hashes.insert(h);
        }
    }
    if let Ok(pubkeys) = crate::db::paired_pubkeys(&meta, row) {
        for (dev, pk) in pubkeys {
            cards.pubkeys.insert(dev, pk);
        }
    }
}

/// 查询串 → `(键, 值)`；出现需要 URL 解码的字符就**当场拒绝**（不猜着解码）。
fn query_get(target: &str, key: &str) -> Result<Option<String>, String> {
    let Some(q) = target.split_once('?').map(|(_, q)| q) else {
        return Ok(None);
    };
    for pair in q.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k.contains('%') || v.contains('%') || k.contains('+') || v.contains('+') {
            return Err("查询参数里出现了 `%` / `+` —— 本窗口不做 URL 解码：如实拒绝，不猜".to_string());
        }
        if k == key {
            return Ok(Some(v.to_string()));
        }
    }
    Ok(None)
}

fn handle_pull(state: &State, target: &str) -> Reply {
    // ⭐ **U8**：**鉴权 ＋ 取哪条连接**一次做完（`select_space` 里就是那条白名单判据 ✓）。
    // ⛔ 别在这里再写一遍 `space != …` ✗ —— 两处判据迟早会漂，而漂的方向是"漏"✗。
    let space = match query_get(target, "space_id") {
        Ok(Some(s)) => s,
        Ok(None) => String::new(),
        Err(e) => return Reply::json(400, "Bad Request", json_error(&e)),
    };
    let since = match query_get(target, "since") {
        Ok(Some(v)) => v.parse::<i64>().unwrap_or(0),
        Ok(None) => 0,
        Err(e) => return Reply::json(400, "Bad Request", json_error(&e)),
    };
    let limit = match query_get(target, "limit") {
        Ok(Some(v)) => v.parse::<i64>().unwrap_or(MAX_LIMIT),
        Ok(None) => MAX_LIMIT,
        Err(e) => return Reply::json(400, "Bad Request", json_error(&e)),
    };
    // ⭐ 2026-10-23（S3b-发）：**库开不了、但这个空间是我的** ⇒ 走"封包"那条路
    //   （数据不在空间库里，在 `meta.mesh_outbox` 的密封镜像里 ✓）。
    if !space.is_empty() && !state.serves(&space) && state.is_locked(&space) {
        return serve_locked_outbox(state, target, &space, since, limit);
    }
    let conn = match state.select_space(target) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let g = match conn.lock() {
        Ok(g) => g,
        Err(_) => return Reply::json(500, "Internal Server Error", json_error("空间库的锁被毒掉了")),
    };
    // ⭐ 2026-10-20：把**我这一栏的高水位**一起发出去（收侧据此判断"游标是不是越界了"）。
    let max_device_seq = max_own_device_seq(&g, &state.cfg.device_id).unwrap_or(0);
    match serve_own_records(&g, &state.cfg.device_id, since, limit) {
        Ok(records) => Reply::json(
            200,
            "OK",
            serde_json::json!({ "records": records, "max_device_seq": max_device_seq }).to_string(),
        ),
        Err(e) => Reply::json(500, "Internal Server Error", json_error(&e)),
    }
}

/// ⭐ 2026-10-23（S3c-接②）：**锁着时的那一轮** —— 不开空间库，只把对端的封包收进 `meta.mesh_inbox`。
///
/// 与 [`round`] 的关系：`round` 要一条**空间连接**（读设置、读名字、落库）；库打不开时那条路走不了
/// ⇒ 换这一条：只用 `meta.db`（设备钥匙、空间名、inbox 都在里面 ✓）。
///
/// 三条口径：
/// ① **一条都不应用** —— 收下 = 进 inbox，解锁后由 [`drain_inbox`] 应用（S3c-接① ✓）；
/// ② 游标用 **inbox 里那个对端已收的最大 `device_seq`**（锁着时没有别处记它）；
/// ③ **收不下也算数**：每个对端的失败原因原样带回去（⛔ 不静默 ✗）。
pub async fn sealed_round(
    dir: &std::path::Path,
    proto_space: &str,
    db_space: &str,
    my_device: &str,
    peers: &[crate::lan::Peer],
) -> Result<MeshRoundReport, String> {
    let meta = crate::db::open_meta_conn_at(dir)?;
    // 空间名：锁着时只能从 meta 读（空间库里那份开不了 ✓）
    let name: String = meta
        .query_row(
            "SELECT name FROM workspaces WHERE id = ?1 AND deleted_at IS NULL",
            params![db_space],
            |r| r.get(0),
        )
        .unwrap_or_default();
    let name_sha = if name.trim().is_empty() {
        String::new()
    } else {
        crate::db::sha256_hex(name.trim())
    };
    let targets = mesh_peers_by_name(proto_space, &name, my_device, peers);
    if targets.is_empty() {
        return Ok(MeshRoundReport {
            enabled: true,
            note: "锁着：网段里没有能直接拉的对端（这一轮一个字节都没动）".to_string(),
            candidates: 0,
            peers: Vec::new(),
            window: window_addr(proto_space).map(|a| format!("http://{a}")),
        });
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut out: Vec<PeerPullReport> = Vec::new();
    let mut stashed_total = 0usize;
    for peer in &targets {
        let since: i64 = meta
            .query_row(
                "SELECT COALESCE(MAX(device_seq), 0) FROM mesh_inbox
                  WHERE space_id = ?1 AND peer_device = ?2",
                params![db_space, peer.device_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let target = pull_target(proto_space, since, &name_sha);
        let auth = sign_request(&meta, my_device, proto_space, "GET", &target, crate::db::now_ms())
            .map(|(ts, sig)| (my_device.to_string(), ts, sig));
        let auth_ref = auth.as_ref().map(|(d, t, s)| (d.as_str(), *t, s.as_str()));
        match pull_from_peer(&client, peer, proto_space, since, None, auth_ref, &name_sha).await {
            Ok((rows, _max)) => {
                let n = stash_sealed_rows(&meta, db_space, &peer.device_id, &rows).unwrap_or(0);
                stashed_total += n;
                out.push(PeerPullReport {
                    peer: peer.device_id.clone(),
                    fetched: rows.len(),
                    // ⚠️ 收下 ≠ 应用：这一档**只存不用** ⇒ applied 恒 0（解锁后 drain 才算应用 ✓）
                    applied: 0,
                    cursor: since,
                    max_seq: 0,
                    superseded: 0,
                    awaiting: 0,
                    items: Vec::new(),
                    merge: PeerMergeState::NotRun,
                    error: None,
                });
            }
            Err(e) => out.push(PeerPullReport {
                peer: peer.device_id.clone(),
                fetched: 0,
                applied: 0,
                cursor: since,
                max_seq: 0,
                superseded: 0,
                awaiting: 0,
                items: Vec::new(),
                merge: PeerMergeState::NotRun,
                error: Some(e),
            }),
        }
    }
    Ok(MeshRoundReport {
        enabled: true,
        note: format!(
            "锁着：不开空间库，只把封包收进 inbox（这一轮新收 {stashed_total} 条；解锁后自动应用）"
        ),
        candidates: targets.len(),
        peers: out,
        window: window_addr(proto_space).map(|a| format!("http://{a}")),
    })
}

/// ⭐ 2026-10-23（S3c）：把对端搬来的**封包**先存进 `meta.mesh_inbox` —— **不解密、不应用**。
///
/// 为什么要有它：**锁着的那一侧也要能收** ✗ —— 那张表只需要明文库（meta.db），不需要空间库的钥匙 ✓；
/// 等解锁了再由 [`drain_inbox`] 逐条解封、走**现有**的 apply 路径 ✓。
///
/// 三条口径：① 只存 `sealed`（⛔ 明文不进这张表 ✗）；② 主键去重 ⇒ 重复收同一批幂等 ✓；
/// ③ 返回"这次**新**存了几条"（`INSERT OR IGNORE` 的影响行数）—— 读数要能分辨"收过了"与"刚收到" ✓。
pub fn stash_sealed_rows(
    meta: &Connection,
    space_id: &str,
    peer_device: &str,
    rows: &[MeshRow],
) -> Result<usize, String> {
    let now = crate::db::now_ms();
    let mut n = 0usize;
    for r in rows {
        let Some(blob) = r.sealed.as_deref() else {
            continue;
        };
        let changed = meta
            .execute(
                "INSERT OR IGNORE INTO mesh_inbox
                     (space_id, peer_device, device_seq, updated_at, sealed, received_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![space_id, peer_device, r.device_seq, r.updated_at, blob, now],
            )
            .map_err(|e| e.to_string())?;
        n += changed;
    }
    Ok(n)
}

/// ⭐ 2026-10-23（S3c）：**解锁后**把 inbox 里那一批解封并应用；**应用成功才删** ✗。
///
/// ⚠️ 删的时机是这一片最要紧的一格：删早了 = 静默丢数据；删晚了只是多占几行 ✓
/// ⇒ 只有在 `applied > 0` 时才删（被合并闸拒下的那批**留着**，下次解锁再试 ✓）。
pub fn drain_inbox(
    c: &Connection,
    space_id: &str,
    peer_device: &str,
    device_level: bool,
) -> Result<Absorbed, String> {
    // ⚠️ 空间连接上 `meta` 是 **attach 进来的** ⇒ 表名一律写全 `meta.mesh_inbox` ✓
    //   （与 `mesh_paired_devices`／`sync_profiles` 那几处同一个写法 ✓）。
    let rows: Vec<MeshRow> = {
        let mut st = c
            .prepare(
                "SELECT device_seq, updated_at, sealed FROM meta.mesh_inbox
                  WHERE space_id = ?1 AND peer_device = ?2 ORDER BY device_seq ASC",
            )
            .map_err(|e| e.to_string())?;
        let it = st
            .query_map(params![space_id, peer_device], |r| {
                Ok(MeshRow {
                    device_seq: r.get(0)?,
                    entity: String::new(),
                    entity_id: String::new(),
                    op: String::new(),
                    payload: None,
                    updated_at: r.get(1)?,
                    sealed: Some(r.get(2)?),
                })
            })
            .map_err(|e| e.to_string())?;
        it.filter_map(Result::ok).collect()
    };
    if rows.is_empty() {
        return Ok(Absorbed {
            applied: 0,
            tail: 0,
            superseded: 0,
            awaiting: 0,
            merge: PeerMergeState::NotRun,
        });
    }
    let out = absorb_peer_batch(c, &rows, peer_device, space_id, device_level)?;
    if out.applied > 0 {
        for r in &rows {
            let _ = c.execute(
                "DELETE FROM meta.mesh_inbox WHERE space_id = ?1 AND peer_device = ?2 AND device_seq = ?3",
                params![space_id, peer_device, r.device_seq],
            );
        }
    }
    Ok(out)
}
///
/// 三条口径，每条都对应一次"否则就会静默丢数据"：
/// ① **只发给认得封包的对端**（`caps=sealed1`）—— 老对端收到空 `entity` 会"跳过并推游标"，
///    那条从此补不回来（方案 §7.1 的探路结论，逐字两次）；
/// ② **必须带 `name_sha`**（`sha256(空间名)`）—— 一个房间里挤着多个个人空间，只说房间名
///    不知道该发谁那一份；⚠️ 名字里有 `&`（本机真有「客户&伙伴」）⇒ 不能直接进 query，
///    而 `query_get` 又不做 URL 解码 ⇒ 发哈希最稳（空间名本来就在公告里明文广播，不新增暴露 ✓）；
/// ③ **一条都不发也要说清楚**（409 ＋ 一句人话）—— ⛔ 不许回一个"正常的空批次" ✗（那会让对端以为追平了）。
fn serve_locked_outbox(state: &State, target: &str, _space: &str, since: i64, limit: i64) -> Reply {
    let caps = query_get(target, "caps").ok().flatten().unwrap_or_default();
    if !caps.split(',').any(|c| c.trim() == "sealed1") {
        return Reply::json(
            409,
            "Conflict",
            json_error(
                "这一台现在**锁着**（有加密空间还没解锁）：只能把**封好的**记录搬给认识它的对端，\
                 而你没带 `caps=sealed1` ⇒ 这一轮**一条都不发**（不发一半：发一半会让游标越过被扣下的那几条，\
                 那几条就永远补不回来了）。升级到认识封包的版本后即可继续。",
            ),
        );
    }
    let name_sha = match query_get(target, "name_sha") {
        Ok(Some(v)) if !v.trim().is_empty() => v.trim().to_string(),
        _ => {
            return Reply::json(
                400,
                "Bad Request",
                json_error("锁着的时候必须带 `?name_sha=`（这个房间下可能不止一个空间：说不清就不猜）"),
            )
        }
    };
    let Some(dir) = state.cfg.data_dir.as_deref() else {
        return Reply::json(
            501,
            "Not Implemented",
            json_error("这一档没配数据目录 ⇒ 读不到搬运缓存（不是「没有数据」）"),
        );
    };
    let meta = match crate::db::open_meta_conn_at(dir) {
        Ok(c) => c,
        Err(e) => return Reply::json(500, "Internal Server Error", json_error(&e)),
    };
    // 名字对不上 ⇒ 这不是我的空间（403，与"不服务这个空间"同一档，别混进 401）。
    let mut ws: Option<String> = None;
    if let Ok(mut st) = meta.prepare("SELECT id, name FROM workspaces WHERE deleted_at IS NULL") {
        if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for row in rows.flatten() {
                if crate::db::sha256_hex(row.1.trim()) == name_sha {
                    ws = Some(row.0);
                    break;
                }
            }
        }
    }
    let Some(ws) = ws else {
        return Reply::json(
            403,
            "Forbidden",
            json_error("这一台没有那个名字的空间（或它已删）—— 不是「没带证件」，是「不是我的空间」"),
        );
    };
    let limit = if limit <= 0 { MAX_LIMIT } else { limit.min(MAX_LIMIT) };
    let max_device_seq: i64 = meta
        .query_row(
            "SELECT COALESCE(MAX(device_seq), 0) FROM mesh_outbox WHERE space_id = ?1 AND device_id = ?2",
            params![ws, state.cfg.device_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let mut records: Vec<MeshRow> = Vec::new();
    match meta.prepare(
        "SELECT device_seq, updated_at, sealed FROM mesh_outbox
          WHERE space_id = ?1 AND device_id = ?2 AND device_seq > ?3
          ORDER BY device_seq ASC LIMIT ?4",
    ) {
        Ok(mut st) => match st.query_map(params![ws, state.cfg.device_id, since, limit], |r| {
            Ok(MeshRow {
                device_seq: r.get(0)?,
                // 锁着 ⇒ **拿不出** entity/entity_id/op（它们在封包里）⇒ 如实用空串，⛔ 不编 ✗
                entity: String::new(),
                entity_id: String::new(),
                op: String::new(),
                payload: None,
                updated_at: r.get(1)?,
                sealed: Some(r.get(2)?),
            })
        }) {
            Ok(rows) => records = rows.flatten().collect(),
            Err(e) => return Reply::json(500, "Internal Server Error", json_error(&e.to_string())),
        },
        Err(e) => return Reply::json(500, "Internal Server Error", json_error(&e.to_string())),
    }
    Reply::json(
        200,
        "OK",
        serde_json::json!({ "records": records, "max_device_seq": max_device_seq }).to_string(),
    )
}

/// ★ 丙-④：`GET /mesh/attachment?space_id=…&hash=…` —— 把**本机手上那一份**附件的字节发出去。
///
/// 四条口径（每条都对应一种"用户的下一步完全不同"的情形，所以分开说）：
/// 1. **空间对不上 ⇒ 403**（与 `/mesh/pull` 同一道门，同一句话）；
/// 2. **`hash` 是不可信输入** ⇒ 先校验形状（它会被拼进文件路径，见 `attachments` 那侧的同一道门）；
/// 3. **这一台没有这份字节 ⇒ 404 ＋ 一句人话** —— "我这儿没有"和"网络不通"是两件事：
///    前者该去问另一个对端，后者该重试（收侧靠 404 与 5xx 的区别决定要不要继续试下一台）；
/// 4. **发的是明文**（与甲那条 `GET /attachments/<hash>` 一致）：盘上可能是加密存的（E1），
///    解密在**这一侧**做；收侧自己按它那把钥匙重新加密落盘。
fn handle_attachment(state: &State, target: &str) -> Reply {
    // ⭐ **U8**：同 `handle_pull` —— 鉴权与"取哪条连接"一次做完 ✓。
    // ⚠️ 这一处**尤其要紧**：下面的空间 id 是**从这条连接的 meta 里读的**
    //    ⇒ 取错连接 ＝ **把别的空间的附件字节发出去** ✗（跨空间泄漏，最坏的一种坏法）。
    let conn = match state.select_space(target) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let hash = match query_get(target, "hash") {
        Ok(Some(v)) => v,
        Ok(None) => return Reply::json(400, "Bad Request", json_error("缺 hash：这一档按**内容**要字节（内容寻址）")),
        Err(e) => return Reply::json(400, "Bad Request", json_error(&e)),
    };
    if !crate::sync::is_valid_attachment_hash(&hash) {
        return Reply::json(400, "Bad Request", json_error("附件标识不合法（要 64 位十六进制的内容指纹）"));
    }
    let Some(data_dir) = state.cfg.data_dir.as_deref() else {
        return Reply::json(
            501,
            "Not Implemented",
            json_error("这个窗口没配数据目录 ⇒ 不服务附件字节（设置面该重开一次窗口）"),
        );
    };
    // 附件按**空间**分目录，而"本地空间 id"只能从这条连接的 meta 里读（真机上它 ≠ 对暗号的 id）。
    // ⚠️ **U8**：这里的 `conn` 必须是 `select_space` 挑出来的**那个空间自己那条** ✓（见上面的头注）。
    let (space_id, key) = match conn.lock() {
        Ok(g) => (crate::attachments::active_space_id(&g), crate::security::key_if_enabled(&g)),
        Err(_) => return Reply::json(500, "Internal Server Error", json_error("空间库的锁被毒掉了")),
    };
    match crate::attachments::read_attachment_bytes_at(data_dir, &space_id, &hash) {
        Ok(raw) => match crate::security::decrypt_attachment_bytes(key.as_ref(), &raw) {
            Ok(plain) => Reply::bytes(200, "OK", plain),
            Err(e) => Reply::json(500, "Internal Server Error", json_error(&format!("本机这份字节解不开：{e}"))),
        },
        Err(e) => Reply::json(
            404,
            "Not Found",
            json_error(&format!("这一台没有这份附件字节（去问别的对端）：{e}")),
        ),
    }
}

/// 向**一台**对端要一件附件的字节（丙-④ 的「跟谁要哪份」由调用方决定顺序）。
///
/// 回的是**还没读体的响应**：调用方把它交给**那条唯一的落盘路径**
/// （`sync::download_one_attachment`）去流式写 —— 于是"下载"在甲、丙两条路上**只有一份实现**
/// （甲那条的注释明写着"P6.3 不许再写第二份下载实现"，这里沿用同一条纪律）。
///
/// ⚠️ 与 `/mesh/pull` 同一套凭证（`Authorization: Bearer <网格口令>`）。
pub async fn request_attachment_from_peer(
    client: &reqwest::Client,
    peer: &MeshPeer,
    space_id: &str,
    hash: &str,
    token: Option<&str>,
    // ⭐ 2026-10-24（图片块同步）：**设备签名那一档** —— 与 `/mesh/pull` 同一套三格头。
    //   ⚠️ 为什么必须有：新版配对走设备身份（`mesh_paired_devices.pubkey`），
    //   `secret_sha256` **是空的** ⇒ 只带口令的话对面 401 ⇒ 图片字节永远取不到
    //   （真机：拉取能过、按需取字节 401 —— 两条路各用了一套凭证）。
    //   形状同 `pull_from_peer`：由调用方签好再传（签名要拿库锁，⛔ 不许跨 await 持锁）。
    auth: Option<(&str, i64, &str)>,
) -> Result<reqwest::Response, String> {
    // ⚠️ target 只拼一次（`attachment_target`）—— 签的是它、发的也是它（⛔ 两处各拼一份会漂）。
    let target = attachment_target(space_id, hash);
    let url = format!("{}{}", peer.base.trim_end_matches('/'), target);
    let mut req = client.get(&url);
    if let Some((device_id, ts, sig)) = auth {
        req = req
            .header(HDR_DEVICE, device_id)
            .header(HDR_TS, ts.to_string())
            .header(HDR_SIG, sig);
    }
    if let Some(t) = token.map(str::trim).filter(|t| !t.is_empty()) {
        req = req.bearer_auth(t);
    }
    req.send().await.map_err(|e| format!("问对端 {} 失败：{e}", peer.device_id))
}

/// ⭐⭐ **2026-10-09（task-8「设备直连」）**：**公告报的空间 == 窗口服务的空间**。
///
/// ## 这一条挡的是哪一次事故（真机读数，逐字）
///
/// 两台真机都在同一热点、`8788` 在听、`UDP 47821` 在听、双向包都通、配对表两边各一行、
/// `secret_sha256` 前 8 位都是 `e304c53b` —— 而 **`sync_history` 一条"经设备直连"的记录都没有**
/// （`pushed/pulled/items` 全 0），面板「附近的设备」**为空**。⇒ **网格那条路从未发起。**
///
/// 真因是**两把尺不同名**：
/// · **窗口服务 / 网格匹配**用的是**解析后**的空间 —— 个人空间（`sync_profiles.space_id` 是空串）
///   解析成用户填的「配对暗号」（`lan_state::window_serve_space` ✓，`dde69cbe` 修的就是这一半 ✓）；
/// · 而**公告产出**那一半仍拿 `bound_profiles()` 给的**原始 `space_id`**（＝空串 ✗）去和
///   `mesh_bases` 比 ⇒ `find` 永远 miss ✗；`is_fully_bound("", url)` 也永远 false ✗
///   ⇒ 那条 `continue` 把**每一行档案**都跳过 ⇒ **0 条公告** ✗。
///
/// ⇒ 两台设备在网段里**互相看不见**（对端表恒空）⇒ `mesh_peers` 恒空 ⇒ `round` 永远走
/// 「网段里没有能直接拉的对端」那一支 ⇒ **一次交换都没发生过**。
///
/// ## 形状**逐字**取自产品路径，不是构造出来的
/// · `profiles` ＝ `lan_state::bound_profiles()` 的返回（**原始** `p.space_id` ✓）；
/// · `mesh_bases` ＝ `lan_state::start()` 里那一份（键是 `window_serve_space()` 解析出来的 ✓）。
/// 判据红 ＝ 产品路径就会那样坏 ✓（红读数见任务报告）。
#[cfg(test)]
mod direct_sync_tests {
    use super::*;

    /// 与 `lan_state::mesh_serve_space_tests::fixture` 同一形状（那几张表够 `mesh_scope_at` 读）。
    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "ATTACH DATABASE ':memory:' AS meta;
             CREATE TABLE meta.sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE meta.sync_profiles (
                 ws_id TEXT PRIMARY KEY, server_url TEXT NOT NULL DEFAULT '',
                 token TEXT NOT NULL DEFAULT '', space_id TEXT NOT NULL DEFAULT '',
                 last_pushed_seq INTEGER NOT NULL DEFAULT 0, last_pulled_seq INTEGER NOT NULL DEFAULT 0,
                 sync_attachments INTEGER NOT NULL DEFAULT 1, mesh_room TEXT NOT NULL DEFAULT ''
             );
             CREATE TABLE meta.workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', deleted_at INTEGER);
             INSERT INTO meta.workspaces (id, name) VALUES ('ws-personal', '测试');
             INSERT INTO meta.sync_state (key, value) VALUES ('device_id', 'dev-win');",
        )
        .unwrap();
        c
    }

    /// 个人空间：`space_id` 空 ＋ 用户填了配对暗号（**真库那几行的形状** `123456789Ok,./` 同族 ✓）。
    fn personal_space_with_room() -> Connection {
        let c = fixture();
        c.execute(
            "INSERT INTO meta.sync_profiles (ws_id, mesh_room) VALUES ('ws-personal', 'room-123')",
            [],
        )
        .unwrap();
        c
    }

    /// ⭐ 本判据（产出侧）：开了网格的个人空间**必须**发一条公告，而且**公告报的空间
    /// 就是窗口/网格匹配的那个空间**（＝配对暗号 ✓）。
    ///
    /// ⚠️ 调的是**产品路径的唯一入口** `lan_state::announces_for_this_round` ✓ —— 不是把两半各测一遍。
    /// 这正是这条 bug 活下来的原因：两半各自绿、**接起来对不上**没人管 ✗。
    ///
    /// ⚠️ 未修时 `got.len() == 0` ✗ ⇒ **必红** ✓（这正是"网段里一个包都不喊"那一格）。
    #[test]
    fn a_personal_spaces_announce_carries_the_served_space() {
        let c = personal_space_with_room();
        // ① 与 `bound_profiles()` 同一形状：**原始** `space_id`（个人空间＝空串 ✓）。
        let profiles = vec![("".to_string(), "".to_string(), "ws-personal".to_string())];
        // ② 与 `start()` 同一形状：`mesh_bases` 的键是**解析后**的空间 ✓。
        let served = crate::lan_state::window_serve_space(&c, "", "ws-personal");
        assert_eq!(served, "room-123", "前提：个人空间的服务空间就是配对暗号 ✓");
        let bases = vec![(served.clone(), "http://192.168.43.206:8788".to_string())];

        let got = crate::lan_state::announces_for_this_round(&c, "dev-win", "WIN", &profiles, &bases);
        assert_eq!(
            got.len(),
            1,
            "开了网格的个人空间**必须发一条公告** ✗ —— 0 条 ⇒ 同一热点里的对端**永远看不见它** \
             ⇒ 对端表恒空 ⇒ 网格一轮都跑不起来（真机读数：面板「附近的设备」为空 ＋ sync_history 零条设备直连）"
        );
        assert_eq!(
            got[0].hub_spaces,
            vec!["room-123".to_string()],
            "公告报的空间必须是**窗口服务的那个**（报空串 ⇒ `lan::serves_space` 永远匹配不上 ✗）"
        );
        assert_eq!(
            got[0].hub_base.as_deref(),
            Some("http://192.168.43.206:8788"),
            "而且基址必须是我自己的窗口（丙-③-b-2b 的那一格 ✓）"
        );
    }

    /// ⭐⭐ **往返性质**（本判据最承重的一条）：**我产出的公告，对端一定能把我挑进候选**。
    ///
    /// 它把两台真机上那两半接起来：`announces_for_with_mesh`（乙的产出 ✓）⇒ 原样喂给
    /// `mesh_peers`（甲的挑选 ✓）⇒ **必须恰好一条** ✓。
    /// ⚠️ 这比"各自单测绿"强：两半各自自洽、**接起来对不上**正是今天这台机器上的形状
    ///（`dde69cbe` 只修了挑人那一半 ⇒ 每一片单测照绿，而真机上一个包都不发 ✓）。
    #[test]
    fn a_personal_space_peer_survives_the_round_trip_into_the_round_candidates() {
        let c = personal_space_with_room();
        let room = crate::lan_state::window_serve_space(&c, "", "ws-personal");
        // 乙那台：个人空间 ＋ 同一个暗号 ＋ 窗口绑在它的真 WLAN 地址上。
        let profiles_b = vec![("".to_string(), "".to_string(), "ws-personal".to_string())];
        let bases_b = vec![(room.clone(), "http://192.168.43.190:8788".to_string())];
        let announced =
            crate::lan_state::announces_for_this_round(&c, "dev-amd", "AMD", &profiles_b, &bases_b);
        assert_eq!(announced.len(), 1, "乙必须先真的喊出去（上一条判据管这一格）");

        // 甲那台：收到的就是乙那一条原样（发现层 decode 之后 `Peer` 就是这个形状 ✓）。
        let peers = vec![crate::lan::Peer {
            announce: announced[0].clone(),
            addr: "192.168.43.190".to_string(),
            seen_at_ms: 1_000,
        }];
        let got = mesh_peers(&room, "dev-win", &peers);
        assert_eq!(
            got.len(),
            1,
            "同一暗号、同网段的乙**必须**进甲的候选（否则甲一轮都不会去拉它 ✗）：{got:#?}"
        );
        assert_eq!(got[0].device_id, "dev-amd");
        assert_eq!(got[0].base, "http://192.168.43.190:8788");
    }

    /// ⭐ **反向（放宽 ≠ 乱认）**：**没填暗号**的个人空间 ⇒ 解析不出来 ⇒ `window_serve_space`
    /// 保持旧口径回落成 `''` ⇒ **仍然一条公告都不发** ✓。
    /// ⚠️ 这条挡的是"为了修 A 把 B 放掉"：把回落口径改成"随便给个空间"就能让上一条绿，
    /// 而那样会让**没配过的**空间在网段里发声 ✗。
    #[test]
    fn a_personal_space_without_a_room_still_says_nothing() {
        let c = fixture();
        c.execute("INSERT INTO meta.sync_profiles (ws_id, mesh_room) VALUES ('ws-personal', '')", []).unwrap();
        let profiles = vec![("".to_string(), "".to_string(), "ws-personal".to_string())];
        let got = crate::lan_state::announces_for_this_round(&c, "dev-win", "WIN", &profiles, &[]);
        assert!(got.is_empty(), "没暗号 ⇒ 保持旧口径不发言（⛔ 不许凭空报一个空间出来 ✗）：{got:#?}");
    }

    /// ⭐ **接线判据**：公告那一行必须走**唯一入口** ✓，⛔ 不许退回"把原始 `profiles` 直接喂给
    /// `announces_for_with_mesh`" ✗ —— 那正是今天这条断点的形状，而它**编译得过、单测照绿** ✓
    /// （与 `lan_state::tests::the_announce_loop_recomputes_targets_from_the_live_peer_table` 同一种判据 ✓，
    /// 也正是本笔能成立的前提：判据够得着那一行 ✓）。
    #[test]
    fn the_announce_loop_goes_through_the_resolving_entry_point() {
        let code = include_str!("lan_state.rs")
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            code.contains("announces_for_this_round(&c, &device_id, &device_name, &profiles, &mesh_bases)"),
            "公告那一行没有走 `announces_for_this_round` ⇒ 个人空间又会一条都发不出去（静默、单测照绿）"
        );
        // ⚠️ 这个"不许出现"的模式**必须拼出来**：`include_str!` 把**本判据自己**也读进去了
        //    （写成字面量就会自己命中自己 —— 与 `lan_state` 那条判据同一个坑 ✓）。
        let forbidden = format!("announces_for_with_mesh(&device_id, &device_name, &{}", "profiles");
        assert!(!code.contains(&forbidden), "公告那一行退回了**原始** `profiles`（个人空间＝空串 ⇒ 0 条公告 ✗）");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lan::{LanAnnounce, Peer};
    use crate::models::PageDetail;

    // ── 两台"客户端栈"：各自一份空间库（带 meta），各自一个网格窗口

    fn space_conn(device: &str) -> Connection {
        conn_with(Connection::open_in_memory().unwrap(), device)
    }

    /// ★ **T-10**：**独立库文件**那一版 —— 10 台那一档要"各自独立 `--db`"，所以不上 `:memory:`。
    /// （`conn_with` 是两者共用的那份 fixture schema；**只此一处**，免得两份 fixture 各漂。）
    fn device_conn(dir: &std::path::Path, device: &str) -> Connection {
        conn_with(Connection::open(dir.join(format!("{device}.db"))).unwrap(), device)
    }

    /// 两台／十台共用的 fixture schema（迁移 ＋ `meta` 挂库 ＋ 那两张表 ＋ 设备身份）。
    fn conn_with(c: Connection, device: &str) -> Connection {
        crate::db::migrate(&c, "ws").unwrap();
        c.execute_batch("ATTACH DATABASE ':memory:' AS meta").unwrap();
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta.sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS meta.sync_profiles (
                 ws_id TEXT PRIMARY KEY,
                 server_url TEXT NOT NULL DEFAULT '',
                 token TEXT NOT NULL DEFAULT '',
                 space_id TEXT NOT NULL DEFAULT '',
                 last_pushed_seq INTEGER NOT NULL DEFAULT 0,
                 last_pulled_seq INTEGER NOT NULL DEFAULT 0,
                 sync_attachments INTEGER NOT NULL DEFAULT 1
             );",
        )
        .unwrap();
        crate::sync::set_meta_state(&c, "device_id", device).unwrap();
        c
    }

    // ═══════════ ⭐ 同名融合的「**是不是同一个人**」身份闸（D1/D2/D3）═══════════
    //
    // ## 为什么这几条**故意**待在 `mesh.rs`、而不是 `mesh_merge_ledger.rs` 自己的 `mod tests` ✗
    // ⭐ 它们要证的正是**接线**（真表 ⇒ 真读法 ⇒ 真闸）⇒ 必须待在一个**今天就在构建里**的文件 ✓。
    // ⚠️ 反面教材就在眼前：`mesh_merge_ledger.rs` 里有一整套纯逻辑判据（它自己的 j/k/l），
    //    但**`lib.rs` 里原先没有 `mod mesh_merge_ledger;`** ⇒ 那些判据**根本不在二进制里**
    //    （跑了也看不见：0 条 ✓）✗ —— 这几条放在这儿 ⇒ 模块一旦掉出构建，它们**当场编不过** ✓
    //    （2026-10-12 实测：加 `mod` 之前，这几条让 lib target 直接 3 条 error ✓）。
    // 四要件（判据／怎么量／反例逐字／过期条件）写在交付报告里；这里只留最短的那句。

    /// ⭐ **D1**：这一格的"同一个人"＝**本机显式信任过那台**（`mesh_paired_devices`）。
    /// 判据：库里**没有**那一行 ⇒ `merge_gate` 必须回 `RefuseUnknownIdentity`（⛔ 不是 `Allow`）。
    /// 反例（逐字）：`left: Allow` ／ `right: RefuseUnknownIdentity`。
    /// 过期条件：表或主键变（`db.rs:490`）／行键口径变（`paired_row_key`）⇒ 重写。
    #[test]
    fn merge_gate_d1_unpaired_device_is_refused() {
        use crate::mesh_merge_ledger::{merge_gate, IdentityOracle, MergeGate, PairedDeviceOracle};

        let c = conn_with(Connection::open_in_memory().unwrap(), "dev-me");
        // 真表（照 `db.rs:490-500` 的列与主键；⚠️ 挂 `meta` 上 —— 生产读的 SQL 是**不带前缀**的 `FROM mesh_paired_devices`）
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta.mesh_paired_devices (
                 space_id      TEXT NOT NULL,
                 device_id     TEXT NOT NULL,
                 secret_sha256 TEXT NOT NULL,
                 added_at_ms   INTEGER NOT NULL,
                 pubkey        TEXT NOT NULL DEFAULT '',
                 PRIMARY KEY (space_id, device_id)
             );",
        )
        .unwrap();
        c.execute(
            "INSERT INTO meta.mesh_paired_devices (space_id, device_id, secret_sha256, added_at_ms, pubkey)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![DEVICE_LEVEL_SPACE, "平板", "sha256:占位", 1_i64, ""],
        )
        .unwrap();

        // ⭐ 走**生产那个读法**（`mesh::paired_devices`：只 select 两列 ✓、键走 `paired_row_key` ✓）
        let rows = paired_devices(&c, DEVICE_LEVEL_SPACE, true).unwrap();
        let paired: Vec<String> = rows.into_iter().map(|d| d.device_id).collect();
        assert_eq!(
            paired,
            vec!["平板".to_string()],
            "前提：那一行**真的读出来了**（⛔ 防两张空表假绿 ✗）"
        );
        let oracle = PairedDeviceOracle { paired_devices: &paired };

        // 认过的 ⇒ `Yes` ⇒ **同名**才允许融（Q3）
        assert_eq!(merge_gate(&oracle.same_person("平板", "工作"), true), MergeGate::Allow);
        // ⭐ 没认过的 ⇒ 判**不出** ⇒ **不融**（反例：`left: Allow` ／ `right: RefuseUnknownIdentity`）
        assert_eq!(
            merge_gate(&oracle.same_person("陌生设备", "工作"), true),
            MergeGate::RefuseUnknownIdentity,
            "⛔ 没配对过却 Allow ⇒ 陌生人的同名空间会被静默并进来 ✗（Q1）"
        );
    }

    /// ⭐ **D2**：对端**身份拿不到** ⇒ 如实 `Unknown` ⇒ 不融；⛔ **不许折成**「不同人」（`No`）。
    /// 反例（逐字）：`left: RefuseDifferentPerson` ／ `right: RefuseUnknownIdentity`。
    /// 过期条件：`LanAnnounce` 真的加上**可选**身份字段之后，这一档只该覆盖"**老对端**"⇒ 重写。
    #[test]
    fn merge_gate_d2_unknown_never_collapses_into_different_person() {
        use crate::mesh_merge_ledger::{
            merge_gate, IdentityOracle, MergeGate, PairedDeviceOracle, SamePerson, WhyUnknown,
        };

        let none: Vec<String> = Vec::new();
        let oracle = PairedDeviceOracle { paired_devices: &none };
        let id = oracle.same_person("陌生设备", "工作");
        assert_eq!(
            id,
            SamePerson::Unknown(WhyUnknown::NotPaired),
            "⭐ 判不出就是判不出 —— 而且**带着原因**（⛔ 不糊成一句「未知」✗）"
        );
        assert_ne!(
            merge_gate(&id, true),
            MergeGate::RefuseDifferentPerson,
            "⛔ 把「拿不到身份」折成「不同人」＝**替用户下一个我们没有依据的断言** ✗"
        );
        assert_eq!(merge_gate(&id, true), MergeGate::RefuseUnknownIdentity);
    }

    /// ⭐ **D2 的"路上那一半"**：⛔ 不许为了对端身份动这两条硬约束 ——
    ///   ① ⛔ **不许升 `WIRE_VERSION`**（升了 ⇒ 老对端公告被**直接拒收** ⇒ 两台互相看不见 ✗）；
    ///   ② ⛔ **`user_id` 不许进 `pairing.rs`**（它是 `deny_unknown_fields` ⇒ 老版本把整条码判成"字段对不上" ✗）。
    ///   ＋ 如实记：**今天链路上根本没有对端身份** ⇒ D2 今天只会走 `Unknown` ✓。
    /// 反例（逐字）：`assertion failed: lan.contains("pub const WIRE_VERSION: u32 = 1;")`。
    /// 过期条件：真的加了**可选**身份字段（只许 `#[serde(default)]`，⛔ 不升版本）⇒ 本条与 D2 一起重写。
    #[test]
    fn merge_gate_d2_wire_contract_and_peer_identity_absent_today() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let lan = std::fs::read_to_string(src.join("lan.rs")).expect("读得到 src/lan.rs");
        let pairing = std::fs::read_to_string(src.join("pairing.rs")).expect("读得到 src/pairing.rs");

        assert!(lan.contains("pub const WIRE_VERSION: u32 = 1;"), "⛔ 不许升 WIRE_VERSION ✗");
        assert!(
            pairing.contains("deny_unknown_fields"),
            "⛔ 配对码那条路是**硬**的（老版本会整条拒收）—— 这正是**不能**往它里面放身份字段的理由 ✓"
        );
        assert!(
            !lan.contains("user_id"),
            "⚠️ `LanAnnounce` 今天**没有**对端身份字段（这就是 D2 只走 `Unknown` 的原因 ✓）；\
             ⚠️ 哪天加上了（**只许** `#[serde(default)]` 可选取字段）⇒ 这条与 D2 一起重写 ✗"
        );
    }

    /// ⭐ **D3**：**许可证不得当身份** ✗ —— 真凭证在**占位 keyring** 下一律 `UnknownKid`
    /// （`relay_license.rs:59-62`）⇒ 它今天**不能当判据** ✓。
    /// 反例（逐字）：`left: Yes(IdentityBasis::License("space-1"))` ／ `right: Unknown(NoLicense)`。
    /// 过期条件：owner 给真 keyring **且**定下"许可证怎么答『是不是同一个人』"之后重写。
    #[test]
    fn merge_gate_d3_license_is_never_an_identity_basis() {
        use crate::mesh_merge_ledger::{IdentityBasis, IdentityOracle, PairedDeviceOracle, SamePerson};

        // ① 唯一的**生产** oracle（`PairedDeviceOracle`）**永远不产** `Account`/`License` 两类身份 ✓
        let paired = vec!["平板".to_string()];
        let oracle = PairedDeviceOracle { paired_devices: &paired };
        for dev in ["平板", "陌生设备"] {
            let id = oracle.same_person(dev, "工作");
            assert!(
                !matches!(
                    id,
                    SamePerson::Yes(IdentityBasis::License(_)) | SamePerson::Yes(IdentityBasis::Account(_))
                ),
                "⛔ 今天**没有**任何生产数据能支撑「同一个人」的账号/许可证判定 ⇒ 不许凭空造一个 `Yes` ✗"
            );
        }

        // ② 全 `src/` 扫一遍：这两类身份的构造点**只许**出现在 `mesh_merge_ledger.rs` 里
        //    （枚举定义 ＋ 它自己的测试）；⛔ 别处出现 ⇒ 有人把"账号/许可证"当身份接进生产了 ✗
        //    ⚠️ **排除本文件**（`mesh.rs`）：这条判据**自己**就写着那两个模式串 ⇒ 不排除必然**自绊** ✗
        //    （实测逐字：`实得 ["mesh.rs", "mesh_merge_ledger.rs"]` ✓）——手法与
        //    `relay_license.rs` 那条泄漏判据的「排除判据自己」逐字同形 ✓。
        // ③ ⭐ 更强的一句：**生产里只许有一个 `IdentityOracle` 实现**（＝第一档 `PairedDeviceOracle`）——
        //    账号/许可证那两档**今天没有实现** ⇒ 哪天别处冒出第二个 impl ⇒ 红 ✗。
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut hits: Vec<String> = Vec::new();
        let mut impls: Vec<String> = Vec::new();
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            for e in std::fs::read_dir(&dir).expect("读得到 src").flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                if p.extension().and_then(|s| s.to_str()) != Some("rs") {
                    continue;
                }
                let name = p.file_name().unwrap().to_string_lossy().to_string();
                if name == "mesh.rs" {
                    continue; // ⭐ 判据自己（否则那两个模式串自绊 ✗）
                }
                let text = std::fs::read_to_string(&p).expect("读得到 .rs");
                if text.contains("IdentityBasis::License(") || text.contains("IdentityBasis::Account(") {
                    hits.push(name.clone());
                }
                if text.contains("impl IdentityOracle for") {
                    impls.push(name);
                }
            }
        }
        assert!(
            !hits.iter().any(|f| f != "mesh_merge_ledger.rs"),
            "⛔ 账号/许可证**不许**在别处当身份用（今天只许出现在 `mesh_merge_ledger.rs` 的枚举定义与它自己的测试里）：实得 {hits:?}"
        );
        assert_eq!(
            impls,
            vec!["mesh_merge_ledger.rs".to_string()],
            "⛔ 生产里**只许有一个** `IdentityOracle` 实现（第一档）；多出来的那个多半是「拿账号/许可证当身份」✗"
        );
    }

    fn page(id: &str, text: &str, updated_at: i64) -> PageDetail {
        PageDetail {
            id: id.to_string(),
            workspace_id: "ws".to_string(),
            parent_id: None,
            title: "页".to_string(),
            content_json: serde_json::json!({ "root": { "children": [
                { "type": "paragraph", "blockId": "b1", "blockRev": 1,
                  "children": [{ "type": "text", "text": text }] } ] } })
            .to_string(),
            content_text: text.to_string(),
            cover: String::new(),
            icon: String::new(),
            cover_height: 300,
            cover_pos: 50.0,
            kind: "page".to_string(),
            sort_order: 0.0,
            created_at: 1,
            updated_at,
        }
    }

    /// 本机改一页 —— 与产品保存路径同形：**先落本机那一行，再记进 outbox**（outbox 那条带本机戳）。
    ///
    /// ⚠️ 落本机借的是那一层的**远端写入口**（`doc_content::upsert_remote`）：它落的列集就是同一组，
    /// 免得判据手写 `INSERT` 去猜 `pages` 的 NOT NULL 列。它会把 `dirty` 写 0 ——
    /// **本判据不依赖 `dirty`**（网格里两边都带戳 ⇒ 页级按戳判），所以不碍事。
    fn local_edit(c: &Connection, pg: &PageDetail) {
        crate::doc_content::upsert_remote(c, pg, 0, crate::doc_content::Ingest::Peer).unwrap();
        crate::sync::record_page_upsert(c, pg).unwrap();
    }

    fn content_of(c: &Connection, id: &str) -> String {
        c.query_row("SELECT content_json FROM pages WHERE id = ?1", params![id], |r| r.get(0))
            .unwrap_or_else(|e| panic!("{id} 应当已经在库里：{e}"))
    }

    /// 这一页的**投影**：规范化之后的内容（去 `blockRev` ＋ 键排序）。
    ///
    /// 口径与 `mesh_sim` 那条"投影逐字节相同"**同一个**：**键序不是内容**（`block_rev` 文件头口径 3）。
    /// 两侧可能一份是本地写的、一份是合并落库的 ⇒ 序列化形态天然会差一点，
    /// 拿原始字节比就是在比"谁经手过哪条代码路径"，那不是判据要守的东西。
    fn projection_of(c: &Connection, id: &str) -> String {
        let v: serde_json::Value = serde_json::from_str(&content_of(c, id)).unwrap();
        crate::block_rev::canonical_content(&v)
    }

    fn mesh_peer(device: &str, base: &str) -> MeshPeer {
        MeshPeer { device_id: device.to_string(), base: base.to_string() }
    }

    fn lan_peer_of(device: &str, base: Option<&str>, spaces: &[&str]) -> crate::lan::Peer {
        crate::lan::Peer {
            announce: crate::lan::LanAnnounce {
                trust_ask: String::new(),
                trust_secret: String::new(),
                v: 1,
                device_id: device.to_string(),
                device_name: format!("{device} 的机器"),
                short_id: String::new(),
                hub_base: base.map(str::to_string),
                hub_spaces: spaces.iter().map(|s| s.to_string()).collect(),
                hub_space_kinds: Vec::new(),
                hub_space_names: Vec::new(),
                fp: "fp".into(),
                pubkey: String::new(),
            },
            addr: "192.168.1.9".into(),
            seen_at_ms: 0,
        }
    }

    /// ★★ **`INV-PER-no-server` 的「**不连服务器**」那一半**（2026-10-02 立 ✓）。
    ///
    /// 那条不变式在个人版规格 §2 里，功能性那半已有判据（"无 hub 无服务器也能通" ✓），
    /// 但**「网络抓包无外连」那半一直是「待立」**✗ ⇒ 本判据立它 ✓：
    /// **网格那一轮的候选里，一个公网基址都不许出现** ✓（候选为空 ⇒ 那一轮**一个字节都不发** ✓）。
    ///
    /// 判据（一张表看完 5 种基址 ✓）：
    ///   · **公网**（`https://shuyo.cn/sync`／`http://8.8.8.8:8788`）⇒ **不进候选** ✓
    ///     —— 这一条就是"个人版不联系任何服务器"在**代码层**的落点 ✓；
    ///   · **回环**（`127.0.0.1` ✓）与**通配**（`0.0.0.0` ✓）⇒ 同样不进（`lan::is_lan_base` 明确排除 ✓
    ///     —— 回环不是"网段里的别人"，通配不是可拨的地址 ✓）；
    ///   · **同网段**（`192.168.1.6:8788` ✓）⇒ **恰好一条** ✓（正例：不然"全都不给连"也能骗过本判据 ✗）；
    ///   · **别的空间**（`hub_spaces` 不含本空间 ✓）⇒ 不进 ✓。
    ///
    /// **变异**：把 `invitable_base` 里那道 `if !crate::lan::is_lan_base(base)` 删掉 ⇒ 本判据**必须红** ✓
    /// （那时公网基址会进候选 ⇒ "个人版可能去连一个服务器" ✗）。
    #[test]
    fn the_mesh_never_dials_a_public_base() {
        for bad in [
            "https://shuyo.cn/sync",
            "http://8.8.8.8:8788",
            "http://127.0.0.1:8788",
            "http://0.0.0.0:8788",
        ] {
            let peers = vec![lan_peer_of("dev-peer", Some(bad), &["sp-1"])];
            assert!(
                mesh_peers("sp-1", "me", &peers).is_empty(),
                "{bad} 不许进候选 ⇒ 个人版**不联系任何服务器** ✗（`INV-PER-no-server` ✓）"
            );
        }
        // 别的空间代言 ⇒ 不进（地址解析与"服务不服务"共用同一把尺 ✓）
        let others = vec![lan_peer_of("dev-peer", Some("http://192.168.1.6:8788"), &["sp-other"])];
        assert!(mesh_peers("sp-1", "me", &others).is_empty(), "别的空间的公告不许被拨 ✗");
        // 正例：同网段 ⇒ 恰好一条（否则"全都不给连"也能骗过这条判据 ✗）
        let good = vec![lan_peer_of("dev-peer", Some("http://192.168.1.6:8788"), &["sp-1"])];
        assert_eq!(mesh_peers("sp-1", "me", &good).len(), 1, "同网段的对端要进候选 ✓");
    }

    fn announced(device: &str, base: &str, spaces: &[&str]) -> Peer {
        Peer {
            announce: LanAnnounce {
                trust_ask: String::new(),
                trust_secret: String::new(),
                v: crate::lan::WIRE_VERSION,
                device_id: device.to_string(),
                device_name: String::new(),
                short_id: String::new(),
                hub_base: Some(base.to_string()),
                hub_spaces: spaces.iter().map(|s| s.to_string()).collect(),
                hub_space_kinds: Vec::new(),
                hub_space_names: Vec::new(),
                fp: device.to_string(),
                pubkey: String::new(),
            },
            addr: "192.168.1.9".to_string(),
            seen_at_ms: 0,
        }
    }

    /// ⭐ 会**报名字**的对端（B1 步三之后的新版本才会这样发）。
    fn announced_named(device: &str, base: &str, space_id: &str, space_name: &str) -> Peer {
        let mut p = announced(device, base, &[space_id]);
        p.announce.hub_space_names = vec![space_name.to_string()];
        p
    }

    /// ⭐⭐ **2026-10-19（真机读数把这一条改回来了）**：**挑对端按"传输作用域"（id／房间），⛔ 不按名字** ✗。
    ///
    /// 来由（windows↔AMD 实测，逐字）：
    /// ```text
    /// [mesh] 收到公告：来源 172.16.174.37 ｜ 对端 94bfb27e ｜ 它代言 1 个空间 [1234…]
    ///        ｜ ✅ 与本机空间**匹配** ⇒ 可以成为网格对端
    /// [mesh] 后台一轮完成：空间 1234… ｜ 候选 0 ｜ 收下 0 条
    /// ```
    /// ⇒ 公告收到了、也判了"匹配"，但**候选 0** —— 因为"对端报了名字就只看名字"那把尺，
    ///   把**能说话的对端**筛掉了（房间档里两边本机空间名根本不同）✓
    /// ⭐ 结论：**名字只用在落库那一层**（`mesh_merge_ledger::batch_merge_gate`）——
    ///   那才是"同名才融合"该待的地方 ✓；用它筛对端，会把**传输**和**融合**两件事搅在一起 ✗。
    ///
    /// 三格：① 同名但服务**别的**房间 ⇒ ⛔ 不挑（传输作用域不同）；
    ///       ② 同房间、名字不同 ⇒ **挑中**（能说话；名字交给落库那一层判）；
    ///       ③ 老对端没报名字 ⇒ 照旧按 id。
    ///
    /// **变异**：把 `invitable_base_for` 改回"有名字就只看名字" ⇒ 第 ② 格必红（正是今天那次故障）。
    #[test]
    fn peer_selection_is_by_transport_scope_not_by_name() {
        let named = vec![announced_named("B", "http://192.168.1.3:8787", "sp-remote", "产品")];
        assert!(
            mesh_peers_by_name("sp-local", "产品", "me", &named).is_empty(),
            "① 对端服务的是**别的**房间 ⇒ ⛔ 不挑（传输作用域不同）"
        );

        let same_room_other_name =
            vec![announced_named("C", "http://192.168.1.4:8787", "sp-local", "运营")];
        let got = mesh_peers_by_name("sp-local", "产品", "me", &same_room_other_name);
        assert_eq!(got.len(), 1, "② 同一房间、名字不同 ⇒ **要挑中**（名字交给落库那层判）");
        assert_eq!(got[0].device_id, "C");

        let old = vec![announced("D", "http://192.168.1.5:8787", &["sp-local"])];
        assert_eq!(mesh_peers_by_name("sp-local", "产品", "me", &old).len(), 1, "③ 老对端按 id");
        let old_other = vec![announced("E", "http://192.168.1.6:8787", &["other"])];
        assert!(mesh_peers_by_name("sp-local", "产品", "me", &old_other).is_empty());
    }

    // ─────────────────────────── 服务侧：没有账本 ───────────────────────────

    /// ★ 「**没有账本**」的可断言形态：窗口**只服务它自己产生的**记录。
    /// 别人推给它的行（`device_id` 不是它）**一条都不许出去** —— 它就是靠这条不需要账本。
    #[test]
    fn the_window_serves_only_its_own_records_so_it_needs_no_ledger() {
        let c = space_conn("A");
        local_edit(&c, &page("p1", "A 自己写的", 10));
        // 往同一张表里塞一条"别人的"记录（模拟它收到过的对端记录 / 别人的 outbox 行）
        crate::sync::set_meta_state(&c, "device_id", "B").unwrap();
        local_edit(&c, &page("p2", "B 写的", 20));
        crate::sync::set_meta_state(&c, "device_id", "A").unwrap();

        let served = serve_own_records(&c, "A", 0, 500).unwrap();
        assert_eq!(served.len(), 1, "只该有 A 自己那一条：{served:#?}");
        assert_eq!(served[0].entity_id, "p1");

        // 分页：游标是**发送方自己的** device_seq，一次一批、是**前缀**（收侧推进到批尾不漏）
        let first = serve_own_records(&c, "A", 0, 1).unwrap();
        assert_eq!(first.len(), 1);
        let tail = first[0].device_seq;
        assert!(serve_own_records(&c, "A", tail, 500).unwrap().is_empty(), "批尾之后没有了");
    }

    #[test]
    fn the_cursor_only_moves_forward_and_refuses_to_go_back() {
        let c = space_conn("A");
        assert_eq!(peer_cursor(&c, "space-x", "B"), 0, "没见过 ⇒ 0");
        set_peer_cursor(&c, "space-x", "B", 7).unwrap();
        assert_eq!(peer_cursor(&c, "space-x", "B"), 7);
        set_peer_cursor(&c, "space-x", "B", 7).unwrap(); // 原地不动是允许的
        assert!(set_peer_cursor(&c, "space-x", "B", 6).is_err(), "水位倒退要当场挡住");
        // 每个对端一个水位（互不串味）
        assert_eq!(peer_cursor(&c, "space-x", "C"), 0);
    }

    // ─────────────────────────── 挑对端（纯函数） ───────────────────────────

    #[test]
    fn only_peers_that_serve_this_space_over_lan_are_mesh_peers() {
        let peers = vec![
            announced("me", "http://192.168.1.2:8787", &["space-x"]),      // 我自己
            announced("B", "http://192.168.1.3:8787", &["space-x"]),        // ✅
            announced("C", "http://192.168.1.4:8787", &["other"]),          // 不服务这个空间
            announced("D", "http://203.0.113.7:8787", &["space-x"]),        // 公网地址
            announced("E", "http://192.168.1.5:8787", &[]),                 // 谁都不代言
            announced("B", "http://192.168.1.3:8787", &["space-x"]),        // 重复
        ];
        let got = mesh_peers("space-x", "me", &peers);
        assert_eq!(got, vec![mesh_peer("B", "http://192.168.1.3:8787")], "{got:#?}");
        assert!(mesh_peers("", "me", &peers).is_empty(), "没绑空间 ⇒ 不拉任何对端");
    }

    /// ★★ 丙档「附近设备」（2026-09-29）：**"谁可以被直接拉"只有一把尺** ——
    /// `invitable_base` 是**逐条**判（没有 `mesh_peers` 那个"同一台/同一地址只留一条"的归并），
    /// 而 `mesh_peers` 必须**只用它**挑（判据在 `sync::tests` 里比两边的集合）。
    ///
    /// 咬人的地方：如果哪天有人把三条过滤在 `mesh_peers` 里再写一遍（或改松一点，
    /// 比如去掉 `is_lan_base` 那一关），列表上就会出现"有「邀请」按钮、点了拉不动"的行。
    #[test]
    fn one_ruler_says_who_can_be_pulled_and_who_can_be_invited() {
        // ✅ 三条都过 ⇒ 可以被直接拉（＝界面上那一行有「邀请」）
        assert_eq!(
            invitable_base("space-x", "me", &announced("B", "http://192.168.1.3:8787", &["space-x"])),
            Some("http://192.168.1.3:8787".to_string())
        );
        // 尾巴上的 `/` 归一（与 `mesh_peers` 的 `base` 逐字节一致）
        assert_eq!(
            invitable_base("space-x", "me", &announced("B", "http://192.168.1.3:8787/", &["space-x"])),
            Some("http://192.168.1.3:8787".to_string())
        );
        // ❌ 我自己 / ❌ 不服务这个空间 / ❌ 公网地址 / ❌ 没报地址 / ❌ 空 device_id
        assert_eq!(invitable_base("space-x", "me", &announced("me", "http://192.168.1.3:8787", &["space-x"])), None);
        assert_eq!(invitable_base("space-x", "me", &announced("C", "http://192.168.1.3:8787", &["other"])), None);
        assert_eq!(invitable_base("space-x", "me", &announced("D", "http://203.0.113.7:8787", &["space-x"])), None);
        assert_eq!(invitable_base("space-x", "me", &announced("E", "", &["space-x"])), None);
        assert_eq!(invitable_base("space-x", "me", &announced("   ", "http://192.168.1.3:8787", &["space-x"])), None);
        // ❌ 没空间（"没指定空间"不是"谁都算"）
        assert_eq!(invitable_base("", "me", &announced("B", "http://192.168.1.3:8787", &["space-x"])), None);
    }

    // ─────────────────────────── 路由：显式不支持 ───────────────────────────

    #[test]
    fn central_endpoints_are_answered_explicitly_rather_than_404() {
        assert_eq!(route("GET", "/mesh/pull?space_id=s&since=1"), Route::Pull);
        for t in ["/push", "/pull", "/spaces", "/lineage-claim", "/spaces/s/keyring", "/auth/login"] {
            assert!(matches!(route("POST", t), Route::NotYet(_)) || matches!(route("GET", t), Route::NotYet(_)), "{t}");
        }
        for t in ["/", "/healthz", "/mesh", "/mesh/pull/extra"] {
            assert_eq!(route("GET", t), Route::Unknown, "{t}");
        }
        assert_eq!(route("POST", "/mesh/pull"), Route::Unknown, "方法不对不算认识");
    }

    #[test]
    fn the_window_refuses_to_listen_on_a_public_address() {
        for ok in ["127.0.0.1:0", "localhost:8788", "192.168.1.5:8788", "10.1.2.3:1", "[::1]:8788"] {
            assert!(checked_bind(ok).is_ok(), "{ok}");
        }
        for bad in ["8.8.8.8:8788", "example.com:8788", "", "127.0.0.1"] {
            assert!(checked_bind(bad).is_err(), "{bad} 不该被放行");
        }
        // ⭐ **D1（owner 2026-09-30：把"`0.0.0.0 ⇒ Err`"反过来）** ⇒ **通配放行**：
        //    "用户不用手填 IP、换网也不失效"的第一半就是它。⚠️ 第二半是"报得出"
        //    （`announced_bases_with`），只放宽这一关 ⇒ 能开窗但没人拉得到（见那条判据）。
        for ok in ["0.0.0.0:8788", "0.0.0.0:0", "[::]:8788"] {
            assert!(checked_bind(ok).is_ok(), "D1：通配必须绑得上：{ok}");
        }
        // ⚠️ **不许放宽**：D1 放的是"听我自己的所有网卡"，**不是**"公网也能听"
        //    ⇒ 具体公网字面地址**仍旧 Err**（这条是本任务"没有顺手放宽"的证据）。
        assert!(checked_bind("8.8.8.8:8788").is_err(), "D1 不许把公网放进来");
        assert!(checked_bind("1.1.1.1:8788").is_err(), "D1 不许把公网放进来");
        // ⚠️ **D14（owner 2026-09-30：放行 CGNAT）**：`100.64.0.0/10` 现在**绑得上** ——
        //    这是 Tailscale 默认段，不放行 ⇒ 用户**开不了窗**。
        assert!(checked_bind("100.100.1.1:8788").is_ok(), "D14：CGNAT 必须绑得上");
        // ⚠️ 而**出段的两条仍拒**：D14 只放 `100.64/10`，不许顺手放宽成"100/8 全收"。
        for bad in ["100.63.255.255:8788", "100.128.0.1:8788"] {
            assert!(checked_bind(bad).is_err(), "{bad} 出了 100.64/10，不许被放行");
        }
    }

    /// ⚠️ **D14（owner 2026-09-30：放行 CGNAT）** —— `100.64.0.0/10` 是**含两端**的十位段
    /// （`100.64.0.0` ~ `100.127.255.255`）⇒ 边界**逐条**钉住，防"写宽/写窄"。
    /// 同时**两把尺一起钉**（甲尺 `is_lan_only` ＋ 乙尺 `lan::is_lan_base`）：
    /// 只放宽一把 ⇒ 绑得上而认不得（或反过来），**没有编译期信号**。
    #[test]
    fn the_cgnat_shared_range_is_exactly_100_64_over_10() {
        for ok in ["100.64.0.1", "100.100.1.1", "100.127.255.254"] {
            assert!(is_lan_only(ok.parse().unwrap()), "D14：{ok} 在 100.64/10 里，必须算内网");
            assert!(
                crate::lan::is_lan_base(&format!("http://{ok}:8787")),
                "D14：{ok} 在乙尺（消费侧）上也必须放行"
            );
        }
        for bad in ["100.63.255.255", "100.128.0.1"] {
            assert!(!is_lan_only(bad.parse().unwrap()), "{bad} 出了 100.64/10，不许当内网");
            assert!(
                !crate::lan::is_lan_base(&format!("http://{bad}:8787")),
                "{bad} 出段 ⇒ 乙尺也不许放行"
            );
        }
        // ⚠️ **不许放宽**：D14 只加这一段 —— 公网照旧落到三支之外。
        assert!(!is_lan_only("8.8.8.8".parse().unwrap()));
        assert!(checked_bind("8.8.8.8:8788").is_err(), "D14 不许把公网放进来");
    }

    /// ⚠️ **横切判据（D14 之后新增）**：仓里**有两张网段表**，它们必须对同一批地址给同一个结论 ——
    /// 甲尺 [`is_lan_only`]（管"绑不绑得上"＋"报不报得出去"）与
    /// 乙尺 `lan::is_private_ipv4`（经 `lan::is_lan_base`；管"认不认对端的 `hub_base`"＋"代不代言"）。
    /// 只改一把 ⇒ **没有编译期信号、单测也照绿**，现象是「两台都开着、都在喊、谁都拉不动谁」
    /// （`lan.rs` 的作者注释原话：「这里必须和消费侧用同一把尺」）。
    ///
    /// ⚠️⚠️ **`127/8` 必须显式排除**：它**今天就不一致、而且是设计如此** ——
    /// `is_lan_only(127.0.0.1) == true`，而 `is_lan_base` 明确把回环排除在"网段里的别人"之外
    /// （`lan.rs` 的口径；`announced_base` 另有一道 `is_loopback()` 挡着）。
    /// 不给这一格例外 ⇒ **本判据上线第一天就假红**（`checked_bind` 的正例里就有 `127.0.0.1:0`）。
    /// ⚠️ 只覆盖 IPv4：乙尺**刻意只认 http ＋ 私有 IPv4**（它自己的文档那句）⇒ IPv6 不适用。
    #[test]
    fn the_two_lan_range_tables_agree() {
        let addrs = [
            // 段内（含 D14 新放的 CGNAT）
            "100.64.0.1", "100.100.1.1", "100.127.255.254",
            "10.0.0.1", "172.16.3.4", "172.31.255.254", "192.168.1.5", "169.254.1.1",
            // 段外边界：一个都不许算内网
            "100.63.255.255", "100.128.0.1", "100.0.0.1",
            "172.15.0.1", "172.32.0.1", "192.167.1.1", "192.169.1.1",
            "169.253.1.1", "169.255.1.1", "11.0.0.1",
            // 公网
            "8.8.8.8", "1.1.1.1",
        ];
        for a in addrs {
            let ip: IpAddr = a.parse().unwrap();
            let by_mesh = is_lan_only(ip);
            let by_lan = crate::lan::is_lan_base(&format!("http://{a}:8787"));
            assert_eq!(
                by_mesh, by_lan,
                "两张网段表对 {a} 的结论不一致（甲尺 {by_mesh} ／ 乙尺 {by_lan}）—— D14 要求同时放宽"
            );
        }
        // ⚠️ 回环是**唯一**允许不一致的那一格（设计如此，见本判据头注）。
        assert!(is_lan_only("127.0.0.1".parse().unwrap()));
        assert!(!crate::lan::is_lan_base("http://127.0.0.1:8787"));
    }

    // ─────────────────────────── ★★ 判据：去掉中枢仍然收敛 ───────────────────────────

    /// ★★ 简报 §6 丙那一格：**没有任何设备发号牌、也没有中枢进程**，两台客户端直接交换带戳的记录，
    /// 互换一笔改动后**两侧投影逐字节相同**。
    ///
    /// 拓扑就是真实拓扑：**每台客户端各起一个网格窗口**（各自服务**自己**的记录），
    /// 另一台直接去拉它 —— **全程没有第三个进程、没有服务端、没有 `seq` 号牌**。
    /// TCP 走**真环回**，两个客户端各有一份**独立的空间库**。
    #[tokio::test]
    async fn two_clients_converge_over_real_loopback_with_no_hub_and_no_server() {
        let a = Arc::new(Mutex::new(space_conn("A")));
        let b = Arc::new(Mutex::new(space_conn("B")));

        // 各起一个窗口（**每台都开窗** —— 这就是丙与甲在拓扑上的差别）
        let win_a = start1(
            MeshConfig {
                bind: "127.0.0.1:0".into(),
                device_id: "A".into(),
                // 判据里的窗口默认**不服务附件**（`/mesh/attachment` 会如实回 501）；
                // 要验附件那条路的判据自己塞临时目录。
                data_dir: None,
            },
            a.clone(),
        )
        .unwrap();
        let win_b = start1(
            MeshConfig {
                bind: "127.0.0.1:0".into(),
                device_id: "B".into(),
                // 判据里的窗口默认**不服务附件**（`/mesh/attachment` 会如实回 501）；
                // 要验附件那条路的判据自己塞临时目录。
                data_dir: None,
            },
            b.clone(),
        )
        .unwrap();

        // ⭐ P1（2026-10-13）：**摘掉共享口令** ⇒ 进门只剩**签名**那一档 ⇒
        //   两边各自把**对方的真公钥**登记在**自己门口** ✓（方向＝"**谁进门、谁被登记**"✓：
        //   A 的门要收 **B 的**公钥 ✓，B 的门要收 **A 的** ✓）。
        //   ⚠️ 两扇门服务的是**同一个空间**（`space-x`）⇒ ⛔ **不能用那个自由函数** ✗（会落错门 ✓，
        //   见 `trust_conn` 的注释 ✓）：这里逐个用**手柄**指名 ✓。
        trust_conn(&win_a, "space-x", "B", &b.lock().unwrap());
        trust_conn(&win_b, "space-x", "A", &a.lock().unwrap());

        // ① A 本地改一页（本机戳 ⇒ 记进它自己的 outbox）
        {
            let c = a.lock().unwrap();
            local_edit(&c, &page("p1", "甲写的", 1_000));
        }
        // ② B 去拉 A（**没有中枢**，直接拉）
        let client = reqwest::Client::new();
        let report = pull_and_absorb(
            &b,
            &client,
            &mesh_peer("A", &format!("http://{}", win_a.addr())),
            "space-x",
            // ⭐ P1：**摘掉口令** ⇒ 这一趟只能靠 `pull_and_absorb` 自己的真签名进门 ✓
            //   （B 的钥匙在 A 的门上登记过 ✓）。
            None,
            // 融合闸的信任名单键：这一组对端**不带 `_space_name`** ⇒ 走"不参与融合"那一支，值不影响读数。
            false,
        )
        .await
        .unwrap();
        assert_eq!((report.fetched, report.applied), (1, 1), "{report:?}");
        assert_eq!(projection_of(&b.lock().unwrap(), "p1"), projection_of(&a.lock().unwrap(), "p1"), "一侧一致");

        // ③ B 接着改同一页，A 去拉 B（**互换**的另一半）
        {
            let c = b.lock().unwrap();
            local_edit(&c, &page("p1", "乙接着写的", 2_000));
        }
        pull_and_absorb(
            &a,
            &client,
            &mesh_peer("B", &format!("http://{}", win_b.addr())),
            "space-x",
            // ⭐ P1：同上 —— 换 A 进门，A 的钥匙在 B 的门上登记过 ✓。
            None,
            false,
        )
        .await
        .unwrap();

        // ④ 两侧投影**逐字节相同**，而且是**因果上更后**的那一版（两边都带戳 ⇒ 按戳判）
        let ca = projection_of(&a.lock().unwrap(), "p1");
        let cb = projection_of(&b.lock().unwrap(), "p1");
        assert_eq!(ca, cb, "两侧投影必须逐字节相同");
        assert!(ca.contains("乙接着写的"), "更晚的戳必须赢：{ca}");

        // ⑤ 重复投递（再拉一遍）：**水位没动 ⇒ 什么都不该再发生**（幂等）
        let again = pull_and_absorb(
            &b,
            &client,
            &mesh_peer("A", &format!("http://{}", win_a.addr())),
            "space-x",
            // ⭐ P1：幂等那一趟同样**不带口令** ✓。
            None,
            false,
        )
        .await
        .unwrap();
        assert_eq!(again.fetched, 0, "水位已经到批尾 ⇒ 不该再拉回东西：{again:?}");
    }

    /// ★★ 窗口要开**本地空间那一份库**，而不是"对暗号那个远端 id"的同名文件。
    ///
    /// 现场就是**真机上的形状**（2026-09-26 两台手机实测抓到）：
    ///   · 本地空间 id ＝ `default`（`spaces/default.db`，用户内容在这儿）；
    ///   · 档案里的远端组织空间 id ＝ `space-x`（**两个 id 不同名**）。
    /// 改前 `ensure_window` 拿后者当库名 ⇒ 开出一个**新建的空库** ⇒ 窗口 HTTP 照常 200、
    /// `records: []`、一个错都不报，于是"两台手机互相拉得动、却**一条也换不过去**"
    /// （真机读数：`fetched 0 / applied 0`，而另一台上刚新建的那一页过不去）。
    ///
    /// 这条判据**为什么以前没有**：上面那条 ★★（两台客户端回环收敛）是直接把**已经打开的连接**
    /// 交给窗口，协议 id 与库名在测试里**恰好是同一个字符串** ⇒ 两个命名空间重合，怎么写都绿。
    /// 这里故意**让它们不同名**，缺口就露出来了。
    #[tokio::test]
    async fn the_window_serves_the_local_spaces_db_not_a_file_named_after_the_remote_id() {
        let dir = temp_dir("mesh-db-id");
        // `spaces/` 这一层得先有：SQLite 不会替你建目录（少了它报
        // `unable to open database file: …\spaces\default.db`）。
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        // ① 本地空间库 `default`：写进一条**本机产生的**记录（走真 outbox 路径）
        {
            let c = crate::db::open_space_conn_at("default", &dir).unwrap();
            // 真机上 `meta.sync_state` 由应用启动时的迁移建好；判据按 `space_conn` 那份最小形状补上
            // （不补就是 `no such table: meta.sync_state`）。
            c.execute_batch("CREATE TABLE IF NOT EXISTS meta.sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
                .unwrap();
            crate::sync::set_meta_state(&c, "device_id", "A").unwrap();
            // ⚠️ 这一页的 `workspace_id` 必须是**这个空间自己的 id**（`default`）：
            // `pages.workspace_id` 有 FK 指向 `workspaces(id)`，而 `page()` 助手默认写的是
            // `"ws"` —— 在真库上那会直接 `FOREIGN KEY constraint failed`。
            let mut pg = page("p1", "本机写的那一版", 1_000);
            pg.workspace_id = "default".to_string();
            local_edit(&c, &pg);
        }
        // ② 窗口：库名 `default`、对暗号的空间 id `space-x` —— **故意让两个 id 不同名**
        let win = open_window_at("default", "space-x", false, "A", "127.0.0.1:0", Some("lan-token".into()), &dir)
            .expect("窗口应当起得来");
        // ③ 直接问它：那条记录必须**服务得出来**
        let (code, body) = http_get(win.addr(), "/mesh/pull?space_id=space-x&since=0&limit=100", Some("lan-token"));
        assert_eq!(code, 200, "{body}");
        assert!(
            body.contains("p1") && body.contains("本机写的那一版"),
            "窗口服务的是**空库**（改前的真机症状：fetched=0、一条也换不过去）：{body}"
        );
        // ④ 反向：**对暗号仍然按远端那个 id**（问本地那个 id 必须 403）
        let (code, _) = http_get(win.addr(), "/mesh/pull?space_id=default&since=0", Some("lan-token"));
        assert_eq!(code, 403, "这个窗口服务的是 space-x ⇒ 问 default 必须被拒（两个 id 各司其职）");
        // ⑤ 别把窗口留在**进程级**注册表里（后面的判据还会用同一张表）
        crate::mesh::stop_window("space-x").unwrap();
    }

    /// ⭐ **`?space_id=` 这条边界的细活**（2026-10-01 立；U8「一窗多空间」落地前先钉住 ✓）：
    ///
    /// ① ⛔ **不在服务范围里 ⇒ 403，而且 body 里【一条记录都不许有】** ——
    ///    上面那条只钉了**状态码** ✓；真正危险的是「**先漏后拒**」（把记录吐出去再回 403）✗。
    /// ② ⚠️ **省略 `?space_id=` ⇒ 今天照样服务**（窗口只服务一个空间时无从歧义 ✓）——
    ///    这条**故意钉住** ✓：U8 之后「服务多个空间」时它**必须变成显式决定**
    ///    （要么要求带参数、要么说不清就拒）；⛔ 不许「顺手」让它继续等于「随便挑一个空间服务」✗。
    ///    ⇒ 将来 U8 改到这里时，**本测试会红**，而那次红就是「请显式决定」的信号 ✓。
    ///
    /// **变异**：把 `handle_pull` 的 403 放宽成「任何 `space_id` 都收」
    /// （U8 最容易犯的错：写成「窗口里有任意一个空间匹配就放行」）⇒ ① 必须红 ✓。
    #[tokio::test]
    async fn the_space_id_gate_refuses_by_default_and_never_leaks_before_refusing() {
        let dir = temp_dir("mesh-space-gate");
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        {
            let c = crate::db::open_space_conn_at("default", &dir).unwrap();
            c.execute_batch("CREATE TABLE IF NOT EXISTS meta.sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
                .unwrap();
            crate::sync::set_meta_state(&c, "device_id", "A").unwrap();
            let mut pg = page("p-secret", "只该给 space-x 看的内容", 1_000);
            pg.workspace_id = "default".to_string();
            local_edit(&c, &pg);
        }
        let win = open_window_at("default", "space-x", false, "A", "127.0.0.1:0", Some("lan-token".into()), &dir)
            .expect("窗口应当起得来");

        // ① 别的空间 ⇒ 403，**且一个字节的记录都不许出现在 body 里**
        let (code, body) = http_get(win.addr(), "/mesh/pull?space_id=space-y&since=0&limit=100", Some("lan-token"));
        assert_eq!(code, 403, "别的空间必须被拒：{body}");
        assert!(
            !body.contains("p-secret") && !body.contains("只该给 space-x 看的内容"),
            "⛔ **先漏后拒**：403 的响应里不许带任何记录（这是最坏的一种坏法）：{body}"
        );

        // ② ⚠️ 省略 `?space_id=` ⇒ **今天**仍然服务（U8 必须显式决定它变成什么 —— 见上面的注释）
        let (code, body) = http_get(win.addr(), "/mesh/pull?since=0&limit=100", Some("lan-token"));
        assert_eq!(code, 200, "今天省略参数仍然服务（U8 会改动这里 ⇒ 那次改动必须是显式的）：{body}");
        assert!(body.contains("p-secret"), "省略参数时服务的仍是那一个空间：{body}");

        // ③ 而本空间带参数 ⇒ 正常 ✓（别把闸门做成「谁都不给」）
        let (code, _) = http_get(win.addr(), "/mesh/pull?space_id=space-x&since=0&limit=100", Some("lan-token"));
        assert_eq!(code, 200, "本空间必须放行");

        crate::mesh::stop_window("space-x").unwrap();
    }

    /// 判据自己的临时目录（同一个进程里多次调用不许撞车 —— 用计数器，不用时间）。
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "shuyo-mesh-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    /// ★ 服务出去的那一批**必须带戳** —— 丙 的判序全靠它。
    /// （不带戳的记录仍然会被服务，但收侧只能按今天那条路判；那一路由 `sync` 的判据守着。）
    #[test]
    fn the_served_records_carry_the_stamp_that_the_ordering_depends_on() {
        let c = space_conn("A");
        local_edit(&c, &page("p1", "带戳的", 10));
        let served = serve_own_records(&c, "A", 0, 500).unwrap();
        assert_eq!(served.len(), 1);
        let payload = served[0].payload.as_deref().expect("页 upsert 必须有载荷");
        match hlc::stamp_of_payload(payload) {
            hlc::PayloadStamp::Ok(s) => assert_eq!(s.device_id(), "A"),
            other => panic!("服务出去的记录必须带本机戳：{other:?}"),
        }
        // 顺带钉住"戳在载荷里、行上不重复一份"（两处各存一次真相迟早会漂）
        let json: serde_json::Value = serde_json::from_str(&serde_json::to_string(&served[0]).unwrap()).unwrap();
        assert!(json.get("stamp").is_none(), "行上不该再有一份戳：{json}");
        assert!(json["payload"].as_str().unwrap().contains(hlc::HLC_PAYLOAD_FIELD));
    }

    /// 对端窗口**不服务别人的记录**，所以"收到过谁的东西"不会从这里漏出去 ——
    /// 一处直接的判据（配合上面那条"没有账本"）。
    #[test]
    fn a_batch_from_a_peer_is_applied_and_the_cursor_lands_on_the_batch_tail() {
        let c = space_conn("B");
        let src = space_conn("A");
        local_edit(&src, &page("p1", "甲", 10));
        local_edit(&src, &page("p2", "乙", 20));
        let rows = serve_own_records(&src, "A", 0, 500).unwrap();
        assert_eq!(rows.len(), 2);

        let ab = absorb_peer_batch(&c, &rows, "A", "ws", false).unwrap();
        assert_eq!(ab.applied, 2);
        assert_eq!(ab.tail, rows.iter().map(|r| r.device_seq).max().unwrap());
        // ★ 丙-⑤：这两条对端都是**本机没有的页** ⇒ 既没有"让给远端"的，也没有"等裁决"的。
        //   （"不是 0 才对"由下面 `absorb_reports_what_the_user_lost` 那一条正面钉住。）
        assert_eq!((ab.superseded, ab.awaiting), (0, 0), "{ab:?}");
        // 重复收同一批：幂等（内容不再变）
        let before = content_of(&c, "p1");
        let ab2 = absorb_peer_batch(&c, &rows, "A", "ws", false).unwrap();
        assert_eq!(content_of(&c, "p1"), before);
        assert_eq!(ab2.applied, 2, "仍然走完 apply（幂等），但内容一字不变");
        // ⚠️ 这里为 0 靠的是 丙-⑤ 在 `doc_content::stash_pending_remote` 里新加的那一句
        //    "**与本地同一份文档的那一版不记**"＋它**如实回 false**（调用方据此不计数）：
        //    老规矩"同一 seq 重放 ⇒ 保留本地"会把这一批再记两条「待取回」（内容是同一份 ⇒
        //    用户点「采用服务端」是个 no-op）＝ 假账。这条断言就是那两句的**行为面**见证
        //    （正面判据在 `doc_content` 那侧）。
        //    ⚠️ 它抓过一次真的：第一版只改了 stash、**没改计数**（`pending_remote_ids` 照旧无条件推），
        //    于是"清单是空的、而读数说另有 2 页等你裁决"—— 这条断言当场红。
        assert_eq!((ab2.superseded, ab2.awaiting), (0, 0), "幂等重放不该多出裁决项（假账）：{ab2:?}");
    }

    /// ★★ 丙-⑤（2026-09-26）：**网格一轮里用户输了/等裁决的那两件事必须被报出来**。
    ///
    /// 为什么这条是承重的：网格这一档**没有服务端**，`MeshRoundReport` 是用户唯一能看到的窗口。
    /// 只回 `(applied, tail)` 的话，"对端戳更晚 ⇒ 你本机那一版被盖掉"这一趟与
    /// "什么都没发生"的那一趟**长得一模一样** —— 那正是本项目最看重的那种静默。
    /// 一格判据同时钉住两个**方向相反**的结局：
    ///   · 对端戳更晚 ⇒ `superseded = 1`（本机那一版**已存进版本历史**，不是丢了）；
    ///   · 本机戳更晚 ⇒ `awaiting   = 1`（远端那一版进了「待取回的远端版本」，等用户裁决）。
    /// **变异实测**：把 `sync.rs` 里那一刀挪到 `apply_upsert` 之后 ⇒ `superseded` 归零、当场红。
    #[test]
    fn absorb_reports_what_the_user_lost_so_a_mesh_round_is_never_silent() {
        // ── 本机：一页**未推送**（dirty=1）＋ 一枚**早**的本机戳
        let c = space_conn("B");
        let mine = page("p1", "本机未推送的那一版", 10);
        local_edit(&c, &mine); // 落库 ＋ 挂本机戳（走真路径）
        // ⚠️ `dirty` 必须在 `local_edit` **之后**置 1：它内部借的是远端写入口，
        //    那一条把 `dirty` 写 0（就是这个原因，本判据的顺序不能反）。
        c.execute("UPDATE pages SET dirty = 1 WHERE id = 'p1'", []).unwrap();
        let mine_stamp = crate::sync::page_stamp(&c, "ws", "p1").unwrap();

        // ── 对端那一版：戳**更晚**（同一页、改了同一块）⇒ 戳判"用远端"
        let theirs = page("p1", "对端更晚的那一版", 20);
        let later = crate::hlc::Hlc::genesis("A").tick(mine_stamp.wall_ms() + 1_000);
        let rows = vec![MeshRow {
            device_seq: 1,
            entity: "page".to_string(),
            entity_id: "p1".to_string(),
            op: "upsert".to_string(),
            payload: Some(crate::hlc::with_stamp(&serde_json::to_string(&theirs).unwrap(), &later).unwrap()),
            updated_at: 20,
            sealed: None,
        }];
        let ab = absorb_peer_batch(&c, &rows, "A", "ws", false).unwrap();
        assert_eq!(ab.applied, 1, "{ab:?}");
        assert_eq!(ab.superseded, 1, "戳判远端 ＋ 本机脏 ⇒ 必须报成「你那一版让给了远端」：{ab:?}");
        assert_eq!(ab.awaiting, 0, "远端赢了就没有「等裁决」的东西：{ab:?}");
        assert!(content_of(&c, "p1").contains("对端更晚的那一版"), "{}", content_of(&c, "p1"));
        // ★ 那句人话必须对得上账：报出来的页**真的**在版本历史里（不然就是"说了但没做"）。
        let kept: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM page_versions WHERE page_id = 'p1' AND content_json LIKE '%本机未推送的那一版%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept, 1, "报成 superseded 的页，本机那一版必须真的在版本历史里");

        // ── 反面方向：换一页，**本机戳更晚** ⇒ 远端那一版进「待取回的远端版本」，等用户裁决
        let mine2 = page("p2", "本机更晚的那一版", 30);
        local_edit(&c, &mine2);
        c.execute("UPDATE pages SET dirty = 1 WHERE id = 'p2'", []).unwrap();
        let mine2_stamp = crate::sync::page_stamp(&c, "ws", "p2").unwrap();
        let older = crate::hlc::Hlc::genesis("A").tick(mine2_stamp.wall_ms().saturating_sub(1_000));
        let rows2 = vec![MeshRow {
            device_seq: 2,
            entity: "page".to_string(),
            entity_id: "p2".to_string(),
            op: "upsert".to_string(),
            payload: Some(
                crate::hlc::with_stamp(&serde_json::to_string(&page("p2", "对端更早的那一版", 40)).unwrap(), &older)
                    .unwrap(),
            ),
            updated_at: 40,
            sealed: None,
        }];
        let ab2 = absorb_peer_batch(&c, &rows2, "A", "ws", false).unwrap();
        assert_eq!((ab2.superseded, ab2.awaiting), (0, 1), "本机赢了 ⇒ 远端那一版进「待取回」等裁决：{ab2:?}");
        assert!(content_of(&c, "p2").contains("本机更晚的那一版"), "{}", content_of(&c, "p2"));
    }

    // ═══════════ ⭐ 按名融合接线（2026-10-17）：同名个人空间 ⇒ 并进来；其余**如实不动** ═══════════
    //
    // 口径逐字：owner 2026-10-17「个人版：空间名称完全一致才算同一空间，需要融合，space_id 可以不同。」
    // ＋ Lead 当日对齐的补充口径：名字 **trim 后逐字相等**；只个人空间；团队/未分类不参与。
    //
    // ⚠️ 这组判据**走真表、真读法**（`meta.workspaces.kind` ⇒ `sync::local_space_kind`；
    //    `meta.mesh_paired_devices` ⇒ `paired_devices` ⇒ `PairedDeviceOracle` ⇒ `batch_merge_gate`），
    //    ⛔ 不是只重跑纯函数 —— 只测纯函数的话，"闸没接上"这件事它照样绿。

    use crate::mesh_merge_ledger::{MergeGate, NotEligibleWhy, SpaceKind};

    /// 融合夹具：本机空间名/类别（`meta.workspaces`）＋ 信任名单（`meta.mesh_paired_devices`，设备级那一行）。
    fn merge_fixture(c: &Connection, name: &str, kind: &str, trusted: &[&str]) {
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta.workspaces (
                 id TEXT PRIMARY KEY, name TEXT NOT NULL,
                 created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
                 kind TEXT NOT NULL DEFAULT '');
             CREATE TABLE IF NOT EXISTS meta.mesh_paired_devices (
                 space_id TEXT NOT NULL, device_id TEXT NOT NULL,
                 secret_sha256 TEXT NOT NULL, added_at_ms INTEGER NOT NULL,
                 pubkey TEXT NOT NULL DEFAULT '', PRIMARY KEY (space_id, device_id));",
        )
        .unwrap();
        let ws: String = c
            .query_row("SELECT id FROM workspaces ORDER BY rowid ASC LIMIT 1", [], |r| r.get(0))
            .expect("空间库必须有自己那一行（`db::migrate` 播种）");
        c.execute(
            "INSERT INTO meta.workspaces (id, name, kind) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind",
            params![ws, name, kind],
        )
        .unwrap();
        for d in trusted {
            c.execute(
                "INSERT INTO meta.mesh_paired_devices
                     (space_id, device_id, secret_sha256, added_at_ms, pubkey)
                 VALUES (?1, ?2, '', 1, '')",
                params![DEVICE_LEVEL_SPACE, d],
            )
            .unwrap();
        }
    }

    /// 一条**对端来的**页 upsert（`_space_name` 那个挂件与推那一侧**同一个函数** `sync::with_space_name`）。
    fn peer_row(seq: i64, pg: &PageDetail, space_name: Option<&str>) -> MeshRow {
        let payload = serde_json::to_string(pg).unwrap();
        let payload = match space_name {
            Some(n) => crate::sync::with_space_name(&payload, n).unwrap(),
            None => payload,
        };
        MeshRow {
            device_seq: seq,
            entity: "page".to_string(),
            entity_id: pg.id.clone(),
            op: "upsert".to_string(),
            payload: Some(payload),
            updated_at: pg.updated_at,
            sealed: None,
        }
    }

    /// ⭐ 2026-10-23（S3b）：**封包必须在任何下游看它之前解开** —— 解开之后与普通记录逐字段一样。
    ///
    /// ⚠️ 本判据里的空间是**明文** ⇒ `decrypt_payload` 原样过（封包只是一层"搬家用的盒子"）。
    /// 密文空间"真封真解"那一半要带钥匙袋的夹具/真机才量得到，这里**不假装**量到了。
    #[test]
    fn a_sealed_row_is_unsealed_before_anything_else_looks_at_it() {
        let c = space_conn("A");
        let inner = serde_json::json!({
            "entity": "page",
            "entity_id": "p1",
            "op": "upsert",
            "payload": "{\"id\":\"p1\"}",
        })
        .to_string();
        let rows = vec![MeshRow {
            device_seq: 7,
            entity: String::new(),
            entity_id: String::new(),
            op: String::new(),
            payload: None,
            updated_at: 9,
            sealed: Some(inner),
        }];
        let out = unseal_rows(&c, &rows).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].entity, "page");
        assert_eq!(out[0].entity_id, "p1");
        assert_eq!(out[0].op, "upsert");
        assert_eq!(out[0].payload.as_deref(), Some("{\"id\":\"p1\"}"));
        assert_eq!(out[0].device_seq, 7, "游标那一格必须原样带过来（水位按它走）");
        assert!(out[0].sealed.is_none(), "解开之后不许再留封包（否则下游会再解一次）");
    }

    /// ⭐ 2026-10-23（S3b）：**解不开就停**，⛔ 不许当成"不认识的记录"跳过。
    ///
    /// 为什么这是承重的：跳过那条路会把**游标推到批尾**（`sync.rs:4005` ＋ 判据
    /// `unrecognized_entity_kinds_are_ignored_loudly_and_never_wedge_the_cursor` 明写"必须走到批尾"）
    /// ⇒ 这一条从此**永远补不回来**（方案 §7.1 的探路结论）。
    #[test]
    fn a_sealed_row_that_cannot_be_opened_stops_the_batch_instead_of_skipping_it() {
        let c = space_conn("A");
        let rows = vec![MeshRow {
            device_seq: 3,
            entity: String::new(),
            entity_id: String::new(),
            op: String::new(),
            payload: None,
            updated_at: 1,
            sealed: Some("不是 JSON".to_string()),
        }];
        let err = unseal_rows(&c, &rows).unwrap_err();
        assert!(
            err.contains("封包格式看不懂"),
            "解不开必须**停下**（⛔ 不许跳过：游标一越过去就永远补不回来）：{err}"
        );
    }

    /// ⭐ 2026-10-23（S3b-发）：**锁着的空间**只把"封好的记录"发给**认识封包**的对端；
    /// 不认识 ⇒ **409 且一条记录都没有**（⛔ 不发一半 —— 发一半，游标就越过被扣下的那几条了）。
    ///
    /// 现场怎么造：那个空间的库打不开（路径上放一个目录，与"加密未解锁"同一档"开不了"）＋
    /// meta 里有它的 `workspaces` 行与一条 `mesh_outbox` 镜像 ＋ 一张卡。
    #[test]
    fn a_locked_space_only_serves_sealed_rows_to_peers_that_understand_them() {
        let dir = temp_dir("s3b-locked-serve");
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        {
            // 好的那个：真开一次库，让这扇门起得来
            crate::db::open_space_conn_at("sp-good", &dir).unwrap();
        }
        // 锁着的那个：库路径上放一个**目录** ⇒ sqlite 开不了
        std::fs::create_dir_all(crate::db::spaces_dir(&dir).join("ws-locked.db")).unwrap();
        {
            let meta = crate::db::open_meta_conn_at(&dir).unwrap();
            meta.execute(
                "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws-locked', '工作', 1, 1)",
                [],
            )
            .unwrap();
            // 搬运缓存里的那一条（payload 已封；这里用一段可辨认的串代替真加密）
            meta.execute(
                "INSERT INTO mesh_outbox (space_id, device_id, device_seq, updated_at, sealed, mirrored_at)
                 VALUES ('ws-locked', 'dev-me', 5, 1, 'SEALED-BLOB-1', ?1)",
                rusqlite::params![crate::db::now_ms()],
            )
            .unwrap();
            crate::db::pair_device(&meta, "proto-locked", "me", "lan-token").unwrap();
        }
        let bind = "127.0.0.1:000000";
        let pairs = vec![
            ("sp-good".to_string(), "proto-good".to_string(), false),
            ("ws-locked".to_string(), "proto-locked".to_string(), false),
        ];
        let addr = ensure_window(&pairs, "dev-me", bind, &dir)
            .expect("好的那个必须把门开起来")
            .expect("端口 0 也应当拿到真实地址");
        assert!(window_serves(bind, "proto-good"));
        assert!(!window_serves(bind, "proto-locked"), "开不了的空间不算在服务 ✓");

        // ① 不认识封包 ⇒ 409，且**一条记录都没有**
        let (code, body) = http_get(
            addr,
            "/mesh/pull?space_id=proto-locked&since=0&limit=100",
            Some("lan-token"),
        );
        assert_eq!(
            code, 409,
            "不认识封包必须**明确拒绝**（⛔ 不许回一个空批次让人以为追平了）：{body}"
        );
        assert!(!body.contains("SEALED-BLOB"), "⛔ 拒绝了还漏数据：{body}");

        // ② 认识封包 ＋ 带空间名哈希 ⇒ 200 ＋ 那条封包原样搬出去
        let name_sha = crate::db::sha256_hex("工作");
        let target = format!(
            "/mesh/pull?space_id=proto-locked&since=0&limit=100&caps=sealed1&name_sha={name_sha}"
        );
        let (code, body) = http_get(addr, &target, Some("lan-token"));
        assert_eq!(code, 200, "带 caps 应当拿得到：{body}");
        assert!(body.contains("SEALED-BLOB-1"), "封包没搬出去：{body}");
        assert!(body.contains("\"sealed\""), "必须走 sealed 那一格：{body}");
        assert!(
            body.contains("\"device_seq\":5"),
            "游标那一格必须原样带上（水位按它走）：{body}"
        );

        // ③ 名字对不上 ⇒ 403（"不是我的空间"，别混进 401）
        let wrong = format!(
            "/mesh/pull?space_id=proto-locked&since=0&limit=100&caps=sealed1&name_sha={}",
            crate::db::sha256_hex("不存在的空间")
        );
        let (code, body) = http_get(addr, &wrong, Some("lan-token"));
        assert_eq!(code, 403, "名字对不上 ⇒ 403：{body}");

        let _ = stop_window("proto-good");
    }

    /// ⭐ 2026-10-23（S3c）：**锁着时收下的封包先进 inbox（不解密、不应用）；解锁后 drain 才应用**。
    ///
    /// 两条承重的：① 重复收同一批**幂等**（主键去重）；② **应用成功才删**（删早了 = 静默丢数据）。
    #[test]
    fn sealed_rows_stash_into_the_inbox_and_apply_on_unlock() {
        let dir = temp_dir("s3c-inbox");
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        let meta = crate::db::open_meta_conn_at(&dir).unwrap();
        meta.execute(
            "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('sp-a', '工作', 1, 1)",
            [],
        )
        .unwrap();
        crate::db::pair_device(&meta, "proto-a", "dev-peer", "tok").unwrap();
        let c = crate::db::open_space_conn_at("sp-a", &dir).unwrap();
        c.execute("UPDATE workspaces SET name = '工作'", []).unwrap();
        crate::sync::set_meta_state(&c, "device_id", "dev-me").unwrap();

        // 两条"封包"（空间是明文 ⇒ 封包就是那条记录本身的 JSON，`decrypt_payload` 原样过）
        let mk = |id: &str, seq: i64| MeshRow {
            device_seq: seq,
            entity: String::new(),
            entity_id: String::new(),
            op: String::new(),
            payload: None,
            updated_at: 1,
            sealed: Some(
                serde_json::json!({
                    "entity": "page",
                    "entity_id": id,
                    "op": "upsert",
                    "payload": serde_json::to_string(&page(id, "锁着时收到的", 10)).unwrap(),
                })
                .to_string(),
            ),
        };
        let rows = vec![mk("p1", 1), mk("p2", 2)];

        assert_eq!(stash_sealed_rows(&meta, "sp-a", "dev-peer", &rows).unwrap(), 2);
        assert_eq!(
            stash_sealed_rows(&meta, "sp-a", "dev-peer", &rows).unwrap(),
            0,
            "同一批再存一次 ⇒ 一条都不新增（主键去重 ⇒ 幂等）"
        );
        let n: i64 = meta.query_row("SELECT COUNT(*) FROM mesh_inbox", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
        // 收下 ≠ 应用：空间库里一条都还没有
        let before: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();

        // 解锁 ⇒ drain
        let ab = drain_inbox(&c, "sp-a", "dev-peer", false).unwrap();
        assert_eq!(ab.applied, 2, "两条都要真的应用：{ab:?}");
        let after: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(after, before + 2, "应用之后空间库里必须有这两页");
        let left: i64 = meta.query_row("SELECT COUNT(*) FROM mesh_inbox", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0, "应用成功的那几条必须从 inbox 删掉（否则会被反复应用）");
    }

    /// ⭐ 2026-10-23（S3c-接②的护栏）：**同一个房间里，别的空间一个字节都不许动**。
    ///
    /// 为什么要有它：后台轮改成"逐空间各开各的连接"之后，同一个房间下的多个空间会各拉一轮
    /// —— 如果合并闸没拦住，同一批记录就会被**重复落进多个空间**（今天真机上碰巧没发生，
    /// 那不算判据）。这里把"没拦住的后果"钉成红的：两个空间同房间、名字不同、对端只报一个名字。
    #[test]
    fn two_spaces_in_the_same_room_never_bleed_into_each_other() {
        let dir = temp_dir("s3c-same-room");
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        let meta = crate::db::open_meta_conn_at(&dir).unwrap();
        for (id, name) in [("sp-a", "工作"), ("sp-b", "别的")] {
            meta.execute(
                "INSERT INTO workspaces (id, name, kind, created_at, updated_at) VALUES (?1, ?2, 'personal', 1, 1)",
                rusqlite::params![id, name],
            )
            .unwrap();
        }
        // ⭐ 对端只服务「工作」这一个名字
        crate::db::pair_device(&meta, "proto-room", "dev-peer", "tok").unwrap();
        let a = crate::db::open_space_conn_at("sp-a", &dir).unwrap();
        a.execute("UPDATE workspaces SET name = '工作', kind = 'personal'", []).unwrap();
        crate::sync::set_meta_state(&a, "device_id", "dev-me").unwrap();
        let b = crate::db::open_space_conn_at("sp-b", &dir).unwrap();
        b.execute("UPDATE workspaces SET name = '别的', kind = 'personal'", []).unwrap();
        crate::sync::set_meta_state(&b, "device_id", "dev-me").unwrap();

        let rows = vec![peer_row(1, &page("p1", "对端的这一页", 10), Some("工作"))];

        // ① 名字对得上的那个空间 ⇒ 收下
        let ab = absorb_peer_batch(&a, &rows, "dev-peer", "proto-room", false).unwrap();
        assert!(ab.applied > 0, "同名（工作）必须收下：{ab:?}");
        let na: i64 = a.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(na, 1);

        // ② 同房间、但名字不同的那个 ⇒ **一条都不许落库**，水位也不许前进
        let ab2 = absorb_peer_batch(&b, &rows, "dev-peer", "proto-room", false).unwrap();
        assert_eq!(ab2.applied, 0, "⛔ 同房间不同名却落库 = 把两个空间悄悄并了：{ab2:?}");
        assert_eq!(ab2.tail, 0, "被拒的那批不许推进水位（否则它永远补不回来）");
        let nb: i64 = b.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(nb, 0, "⛔ 另一个空间被串了：{nb} 页");
    }

    /// ⭐ **判据①**：同名个人空间 ⇒ **融合**（并进本机这一个空间、保留本机 id/名字）＋ **账本一条记录（可读）**。
    ///
    /// 反例（逐字）：把 `absorb_peer_batch` 里的闸去掉（回到"按暗号照收"）时，本判据**仍然绿** ✗ ——
    /// 所以下面还钉了"对面 `space_id` 与本机不同、落库后必须锚到本机 id"这一句：
    /// 不同 `space_id` 的同名空间要合成一个（owner 原话「space_id 可以不同」）。
    #[test]
    fn a_same_named_personal_space_is_merged_and_the_ledger_has_one_record() {
        let c = space_conn("B");
        merge_fixture(&c, "工作", "personal", &["平板"]);
        // ⭐ 对面那页的 `workspace_id` 是**对面那台的空间 id**（与本机 `ws` 不同名 —— owner 说的正是这件事）。
        let mut p = page("p1", "从平板来的", 10);
        p.workspace_id = "对面那台的空间 id".to_string();
        let rows = vec![peer_row(1, &p, Some("  工作  "))];

        let ab = absorb_peer_batch(&c, &rows, "平板", DEVICE_LEVEL_SPACE, true).unwrap();
        assert_eq!(ab.merge, PeerMergeState::Merged, "⭐ 同名个人空间必须融合：{ab:?}");
        assert_eq!((ab.applied, ab.tail), (1, 1), "融合这一批算收下 ⇒ 水位到批尾：{ab:?}");
        assert!(content_of(&c, "p1").contains("从平板来的"));

        // ⭐ 保留**本机** space_id 与名字（⛔ 不许把对面的 id 落进来）。
        let landed_ws: String = c
            .query_row("SELECT workspace_id FROM pages WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(landed_ws, "ws", "⛔ 融合后落库的 workspace_id 必须是本机的（space_id 可以不同）");
        assert_eq!(
            crate::sync::local_space_name(&c).as_deref(),
            Some("工作"),
            "⛔ 归一/融合都不许改写用户写的名字"
        );

        // ⭐ **账本一条记录（可读）**：谁、融了哪些行、融合前本机有几条。
        let v = crate::sync::merge_ledger_view(&c, "工作").unwrap();
        assert_eq!(v.undoable.len(), 1, "⭐ 账本必须记下这一笔（否则「可撤」没有落点）");
        assert_eq!(v.undoable[0].peer_device, "平板");
        assert_eq!(v.undoable[0].moved, vec!["p1".to_string()], "撤销要动的是并进来的页 id");
        assert_eq!(v.undoable[0].kept_before, 0, "融合前本机没有页");
    }

    /// ⭐ **判据②（反向）**：不同名 ⇒ **不融合**：一条都不落库、水位不前进、账本一笔都不记。
    ///
    /// 反例（逐字）：不拒绝而照旧落库 ⇒ `pages` 会多一行（`COUNT(*) = 1`）而本判据当场红 ——
    /// 那正是 owner 最不要的「把两个本来不同名的空间悄悄并在一起」。
    #[test]
    fn a_different_named_personal_space_is_not_merged_and_nothing_lands() {
        let c = space_conn("B");
        merge_fixture(&c, "工作", "personal", &["平板"]);
        let rows = vec![peer_row(1, &page("p1", "不该进来", 10), Some("私人"))];

        let ab = absorb_peer_batch(&c, &rows, "平板", DEVICE_LEVEL_SPACE, true).unwrap();
        assert_eq!(
            ab.merge,
            PeerMergeState::Refused(MergeGate::RefuseDifferentName),
            "⛔ 名字不一样却融了 ✗：{ab:?}"
        );
        assert_eq!((ab.applied, ab.tail), (0, 0), "⭐ 不融 ⇒ 一条不落库、水位不前进（下一轮还会再拉）");
        let n: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "⛔ 不同名却落库 = 把两个空间悄悄并了");
        assert!(
            crate::sync::merge_ledger_view(&c, "工作").unwrap().undoable.is_empty(),
            "⛔ 没融就不许记账"
        );
    }

    /// ⭐ **判据③（反向）**：**团队空间一个字节都不动** —— 不参与按名融合，照旧按暗号同步；
    /// ⛔ **一条融合账都不许记**。未分类/类别读不出同理（"判不出 ⇒ 不融"，⛔ 不默认成个人空间）。
    #[test]
    fn a_team_or_unclassified_space_is_never_touched_by_name_fusion() {
        // ① 团队空间：哪怕名字完全一样、也信任过那台 ⇒ 仍**不参与**融合（老路照旧）。
        let c = space_conn("B");
        merge_fixture(&c, "工作", "team", &["平板"]);
        let rows = vec![peer_row(1, &page("p1", "团队空间的数据", 10), Some("工作"))];
        let ab = absorb_peer_batch(&c, &rows, "平板", DEVICE_LEVEL_SPACE, true).unwrap();
        assert_eq!(
            ab.merge,
            PeerMergeState::NotEligible(NotEligibleWhy::NotPersonal(SpaceKind::Team)),
            "⛔ 团队空间参与了融合 ✗：{ab:?}"
        );
        assert_eq!((ab.applied, ab.tail), (1, 1), "⭐ 团队空间沿用既有同步（不掺融合）");
        assert!(
            crate::sync::merge_ledger_view(&c, "工作").unwrap().undoable.is_empty(),
            "⛔ 团队空间**一条融合账都不许记**"
        );

        // ② 未分类（`kind=''`）：读到了，但**不参与**。
        let c = space_conn("B");
        merge_fixture(&c, "工作", "", &["平板"]);
        let ab = absorb_peer_batch(&c, &rows, "平板", DEVICE_LEVEL_SPACE, true).unwrap();
        assert_eq!(
            ab.merge,
            PeerMergeState::NotEligible(NotEligibleWhy::NotPersonal(SpaceKind::Unclassified)),
            "{ab:?}"
        );
        assert_eq!((ab.applied, ab.tail), (1, 1), "未分类空间：老路照旧");

        // ③ 类别**读不出来**（没有 `meta.workspaces` 那张表）⇒ 判不出 ⇒ 不参与（⛔ 不默认成个人空间）。
        let c = space_conn("B");
        let ab = absorb_peer_batch(&c, &rows, "平板", DEVICE_LEVEL_SPACE, true).unwrap();
        assert_eq!(
            ab.merge,
            PeerMergeState::NotEligible(NotEligibleWhy::KindUnknown),
            "⭐ 读不到 ≠ 读到 0：类别判不出时**不许**当个人空间：{ab:?}"
        );
        assert_eq!((ab.applied, ab.tail), (1, 1), "判不出类别 ⇒ 不参与 ⇒ 老路照旧");
    }

    /// ⭐ **判据④**：**重复接入幂等** —— 同一对设备再连一次 ⇒ 账本**仍只有一笔**、页面数不涨、
    /// 原来那笔的记录不被改写。反例：每次接入都记一笔 ⇒ `undoable.len() == 2` ⇒ 红。
    #[test]
    fn re_absorbing_the_same_pair_is_idempotent() {
        let c = space_conn("B");
        merge_fixture(&c, "工作", "personal", &["平板"]);
        let rows = vec![peer_row(1, &page("p1", "从平板来的", 10), Some("工作"))];

        let first = absorb_peer_batch(&c, &rows, "平板", DEVICE_LEVEL_SPACE, true).unwrap();
        assert_eq!(first.merge, PeerMergeState::Merged);
        let first_at = crate::sync::merge_ledger_view(&c, "工作").unwrap().undoable[0].at_ms;

        // 重复接入同一批（同一对设备、同一个名字）⇒ ⭐ 不再记第二笔。
        let again = absorb_peer_batch(&c, &rows, "平板", DEVICE_LEVEL_SPACE, true).unwrap();
        assert_eq!(
            again.merge,
            PeerMergeState::AlreadyMerged,
            "⭐ 重复接入必须幂等（只记一笔）：{again:?}"
        );
        assert_eq!((again.applied, again.tail), (1, 1), "内容照旧按 id 幂等应用");
        let n: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "⭐ 页面数也不许涨（没有第二份内容）");
        let v = crate::sync::merge_ledger_view(&c, "工作").unwrap();
        assert_eq!(v.undoable.len(), 1, "⭐ 账本仍只有一笔");
        assert_eq!(v.undoable[0].at_ms, first_at, "原来那一笔不许被改写");
    }

    /// ⭐ **判据⑤（身份闸，与判据①互补）**：**没被本机信任过**那台 ⇒ 判**不出**是不是同一个人
    /// ⇒ ⛔ 不融（哪怕名字完全一样）—— 且**不许**把"判不出"折成"不同人"。
    #[test]
    fn an_untrusted_device_cannot_merge_even_with_the_same_name() {
        let c = space_conn("B");
        merge_fixture(&c, "工作", "personal", &[]); // 信任名单是空的
        let rows = vec![peer_row(1, &page("p1", "陌生设备的同名空间", 10), Some("工作"))];

        let ab = absorb_peer_batch(&c, &rows, "陌生设备", DEVICE_LEVEL_SPACE, true).unwrap();
        assert_eq!(
            ab.merge,
            PeerMergeState::Refused(MergeGate::RefuseUnknownIdentity),
            "⛔ 没配对过却 Allow ⇒ 陌生人的同名空间会被静默并进来 ✗：{ab:?}"
        );
        assert_eq!((ab.applied, ab.tail), (0, 0), "不融 ⇒ 一条不落库");
        assert_ne!(
            ab.merge,
            PeerMergeState::Refused(MergeGate::RefuseDifferentPerson),
            "⛔ 「判不出」不许折成「不同人」（那是替用户下断言）"
        );
        let n: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    /// ⭐ **判据⑥（兼容/如实）**：对面**没带空间名**（老对端/老载荷）⇒ 判不了同名 ⇒ **不参与融合**
    /// （⛔ 不记账），但 **沿用既有「按暗号」同步**（⛔ 不许因此静默丢数据/把老对端整条断掉）。
    #[test]
    fn a_batch_without_a_space_name_is_not_fused_but_keeps_the_old_path() {
        let c = space_conn("B");
        merge_fixture(&c, "工作", "personal", &["平板"]);
        let rows = vec![peer_row(1, &page("p1", "老对端来的", 10), None)];

        let ab = absorb_peer_batch(&c, &rows, "平板", DEVICE_LEVEL_SPACE, true).unwrap();
        assert_eq!(
            ab.merge,
            PeerMergeState::NotEligible(NotEligibleWhy::NoPeerName),
            "⭐ 拿不到名字 ⇒ 如实「没参与融合」（⛔ 不猜、⛔ 不拿 id 反推名字）：{ab:?}"
        );
        assert_eq!((ab.applied, ab.tail), (1, 1), "兼容：老对端照旧按暗号同步");
        assert!(
            crate::sync::merge_ledger_view(&c, "工作").unwrap().undoable.is_empty(),
            "⛔ 没判出同名就记账 = 假账"
        );
    }

    /// ★ 丙-⑤：**那两句人话**（纯函数，判据不打桩、不看网络）—— 老那两句逐字不变，
    /// 新的两句只在真有那两件事时出现（没有就**一个字都不多说**，免得变成噪声）。
    #[test]
    fn the_round_note_says_what_the_user_lost_and_keeps_the_old_two_sentences() {
        let ok = |superseded: usize, awaiting: usize| PeerPullReport {
            peer: "A".to_string(),
            fetched: 3,
            applied: 3,
            cursor: 3,
            superseded,
            awaiting,
            items: Vec::new(),
            merge: PeerMergeState::NotRun,
        max_seq: 0,
            error: None,
        };
        assert_eq!(round_note(&[ok(0, 0)]), "网格：拉了 1 台对端", "老那一句**逐字不变**");
        assert_eq!(round_note(&[]), "网格：拉了 0 台对端");
        let s = round_note(&[ok(2, 0)]);
        assert!(s.starts_with("网格：拉了 1 台对端；"), "{s}");
        assert!(s.contains("2 页你本机那一版让给了远端"), "{s}");
        assert!(s.contains("已存进版本历史"), "要给出找回的去处：{s}");
        assert!(s.contains("版本历史"), "{s}");
        let a = round_note(&[ok(0, 1)]);
        assert!(a.contains("1 页等你裁决"), "{a}");
        assert!(!a.contains("让给了远端"), "没发生的事一个字都不许说：{a}");
        // 两台对端：**跨台累加**（用户关心的是"这一轮我一共输了几页"，不是"哪一台"）
        let two = round_note(&[ok(1, 1), ok(2, 0)]);
        assert!(two.contains("拉了 2 台对端"), "{two}");
        assert!(two.contains("3 页你本机那一版让给了远端"), "3 = 1 + 2：{two}");
        // ⭐ 2026-10-17：**融合/没融也要出现在这句人话里**（网格这一档用户只能看它）。
        let mut merged = ok(0, 0);
        merged.merge = PeerMergeState::Merged;
        assert!(
            round_note(&[merged]).contains("同名个人空间"),
            "融合了却不说 ⇒ 用户不知道空间真的并进来了"
        );
        let mut refused = ok(0, 0);
        refused.merge = PeerMergeState::Refused(MergeGate::RefuseDifferentName);
        assert!(
            round_note(&[refused]).contains("没融合"),
            "没融也要说 —— 否则用户只会以为同步坏了（而且那一批确实没落库）"
        );
        // 拉不动那台：老那句（分辨"没人"／"都拉不动"）不许被新句子盖掉
        let mut bad = ok(0, 0);
        bad.error = Some("连接被拒".to_string());
        let e = round_note(&[bad]);
        assert!(e.contains("其中 1 台没拉动"), "{e}");
    }

    /// ★★ 丙-④（2026-09-26）：**附件按内容从"任意一个"对等体取到** —— 真环回、两个窗口。
    ///
    /// 现场形状就是产品里的那一个：网段里有两台对端，**第一台手上没有**这份字节，
    /// **第二台有** ⇒ 客户端按顺序试，从第二台拿到，而且**字节逐字节相同**。
    /// 三种"取不到"也一并钉住（每一种用户的下一步都不同）：
    ///   · 空间不对 ⇒ **403**（与 `/mesh/pull` 同一道门）；
    ///   · 这一台没有 ⇒ **404 ＋ "这一台没有…"**（≠ 网络故障 ⇒ 该去问另一台）；
    ///   · 窗口没配数据目录 ⇒ **501**（"没配"与"没有这份文件"是两件事）。
    ///
    /// 变异实测：把 `handle_attachment` 里那次 `read_attachment_bytes_at` 换成"回空体" ⇒ 当场红。
    #[tokio::test]
    async fn an_attachment_comes_from_whichever_peer_actually_has_it() {
        let bytes: Vec<u8> = b"\x89PNG\r\n\x1a\n-not-a-real-png-but-real-bytes".to_vec();
        let hash = "ab".repeat(32); // 64 位十六进制（过形状校验）
        let dir_a = temp_dir("att-a");
        let dir_b = temp_dir("att-b");
        let a = Arc::new(Mutex::new(space_conn("A")));
        let b = Arc::new(Mutex::new(space_conn("B")));
        // B 的盘上有这份字节 —— 写的位置走**产品那条布局**（`space_attachments_dir` ＋ `bucket_path`），
        // 空间 id 也用那一侧自己的读法（`active_space_id`），免得判据手抄一份布局。
        let (space_of_b, bucket) = {
            let g = b.lock().unwrap();
            let space = crate::attachments::active_space_id(&g);
            let root = crate::attachments::space_attachments_dir(&dir_b, &space);
            (space, root)
        };
        std::fs::create_dir_all(&bucket).unwrap();
        let file = crate::attachments::bucket_path(&bucket, &hash, "png");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, &bytes).unwrap();
        assert!(!space_of_b.is_empty() || bucket.exists(), "夹具：B 的附件目录应当建好了");

        let win_a = start1(
            MeshConfig {
                bind: "127.0.0.1:0".into(),
                device_id: "A".into(),
                data_dir: Some(dir_a.clone()),
            },
            a.clone(),
        )
        .unwrap();
        let win_b = start1(
            MeshConfig {
                bind: "127.0.0.1:0".into(),
                device_id: "B".into(),
                data_dir: Some(dir_b.clone()),
            },
            b.clone(),
        )
        .unwrap();
        // 第三个窗口：**没配数据目录**（配置问题，不是"没有这份文件"）
        let win_c = start1(
            MeshConfig {
                bind: "127.0.0.1:0".into(),
                device_id: "C".into(),
                data_dir: None,
            },
            Arc::new(Mutex::new(space_conn("C"))),
        )
        .unwrap();

        let client = reqwest::Client::new();
        let pa = mesh_peer("A", &format!("http://{}", win_a.addr()));
        let pb = mesh_peer("B", &format!("http://{}", win_b.addr()));
        let pc = mesh_peer("C", &format!("http://{}", win_c.addr()));

        // ① 第一台没有 ⇒ 404，而且**说清"这一台没有"**（客户端据此去问下一台）
        let resp = request_attachment_from_peer(&client, &pa, "space-x", &hash, Some("lan-token"), None).await.unwrap();
        assert_eq!(resp.status().as_u16(), 404, "第一台没有这份字节");
        let body = resp.text().await.unwrap();
        assert!(body.contains("这一台没有"), "404 必须说清是「这一台没有」，不是笼统失败：{body}");

        // ② 第二台有 ⇒ 200 ＋ **字节逐字节相同**（这就是"按内容从任意一个对等体取到"）
        let resp = request_attachment_from_peer(&client, &pb, "space-x", &hash, Some("lan-token"), None).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200, "第二台手上就有这份字节");
        assert_eq!(resp.bytes().await.unwrap().to_vec(), bytes, "取回来的必须**逐字节**是那一份");

        // ③ 空间对不上 ⇒ 403（与 pull 同一道门）
        let resp = request_attachment_from_peer(&client, &pb, "other-space", &hash, Some("lan-token"), None).await.unwrap();
        assert_eq!(resp.status().as_u16(), 403, "窗口只服务它代言的空间");
        // ④ 口令不对 ⇒ 401（同一道门，同一句话）
        let resp = request_attachment_from_peer(&client, &pb, "space-x", &hash, Some("wrong"), None).await.unwrap();
        assert_eq!(resp.status().as_u16(), 401);
        // ⑤ 没配数据目录 ⇒ 501（"没配"≠"没有这份文件"）
        let resp = request_attachment_from_peer(&client, &pc, "space-x", &hash, Some("lan-token"), None).await.unwrap();
        assert_eq!(resp.status().as_u16(), 501, "没配数据目录要如实说（不是 404）");
        // ⑥ 形状不合法的 hash ⇒ 400（它会被拼进文件路径 ⇒ 与产品同一道门）
        let resp = request_attachment_from_peer(&client, &pb, "space-x", "../../meta.db", Some("lan-token"), None).await.unwrap();
        assert_eq!(resp.status().as_u16(), 400, "不可信的 hash 必须当场拒绝");

        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
    }

    /// ★ 丙-④：**"取不到"那句话要说得清是四种里的哪一种**（纯函数，判据不打桩、不看网络）。
    #[test]
    fn the_attachment_failure_note_says_which_kind_of_nowhere() {
        // ① 没绑组织空间 id ⇒ 配置问题
        let s = crate::sync::attachment_fetch_failure(None, "", 0, &[]);
        assert!(s.contains("没绑组织空间 id"), "{s}");
        assert!(!s.contains("没有能问的对端"), "没绑 id 时不许说成「网段里没人」：{s}");
        // ② 绑了 id、网段里没人 ⇒ 这不是失败，是"没人"
        let s = crate::sync::attachment_fetch_failure(None, "space-x", 0, &[]);
        assert!(s.contains("附近没有能问的对端"), "{s}");
        assert!(!s.contains("问了"), "一台都没问过，不许说「问了 N 台」：{s}");
        // ③ 有对端但都拿不到 ⇒ 每一家的原文都要带上（别合成一句"失败"）
        let tried = vec!["A：对端 A 返回 404".to_string(), "B：问对端 B 失败：连接被拒".to_string()];
        let s = crate::sync::attachment_fetch_failure(None, "space-x", 2, &tried);
        assert!(s.contains("问了 2 台对端"), "{s}");
        assert!(s.contains("A：对端 A 返回 404") && s.contains("连接被拒"), "每一家的原文都要在：{s}");
        // ④ 服务端那条也报过错 ⇒ 一并带上（用户要能分辨"服务器没成"与"对端没有"）
        let s = crate::sync::attachment_fetch_failure(Some("服务端 返回 401"), "space-x", 1, &["A：x".to_string()]);
        assert!(s.contains("服务端：服务端 返回 401"), "{s}");
    }

    /// ★ 丙-④：窗口那条路由**认得**新端点（不认得就会被 `not_yet` 抢走回 501）。
    #[test]
    fn the_attachment_endpoint_is_a_route_not_a_not_yet() {
        assert_eq!(route("GET", "/mesh/attachment?space_id=s&hash=h"), Route::Attachment);
        assert_eq!(route("GET", "/mesh/attachment/"), Route::Attachment);
        assert_eq!(route("POST", "/mesh/attachment"), Route::Unknown, "只认 GET");
        // ⚠️ 中枢那条 `/attachments/<hash>` **仍然**是"这一档不支持"（两条路不能混为一谈）
        assert!(matches!(route("GET", "/attachments/abc"), Route::NotYet(_)));
    }

    /// 窗口设了口令 ⇒ 对不上的一律 401；中枢那一套端点 ⇒ **501 ＋ 人话**（不是 404、不是空 200）。
    #[test]
    fn an_unimplemented_endpoint_answers_explicitly_over_real_http() {
        let c = Arc::new(Mutex::new(space_conn("A")));
        let win = start1s_card(
            "space-x",
            "right",
            MeshConfig {
                bind: "127.0.0.1:0".into(),
                device_id: "A".into(),
                data_dir: None,
            },
            c,
        )
        .unwrap();
        let (code, body) = http_get(win.addr(), "/mesh/pull?space_id=space-x&since=0", Some("right"));
        assert_eq!(code, 200, "{body}");

        let (code, body) = http_get(win.addr(), "/push", Some("right"));
        assert_eq!(code, 501, "中枢端点必须**显式**说不支持：{code} {body}");
        assert!(body.contains("明确的不支持"), "{body}");

        let (code, _) = http_get(win.addr(), "/healthz", Some("right"));
        assert_eq!(code, 404);

        let (code, _) = http_get(win.addr(), "/mesh/pull?space_id=space-x", Some("wrong"));
        assert_eq!(code, 401);
        let (code, _) = http_get(win.addr(), "/mesh/pull?space_id=space-x", None);
        assert_eq!(code, 401);
    }

    /// 一个**手写的**最小 GET（判据不依赖被测的那一侧自己写的客户端）。
    /// ⭐ **U8（2026-10-01）**：判据里造「**一扇门只服务 `space-x`**」的窗口 ——
    /// 所有测试夹具用的都是它 ✓（U8 之后 `start` 收的是**连接表**，判据只要一对 ✓）。
    /// ⭐ **U11（2026-10-02）**：判据里的窗口现在**门只认卡** ✓ ⇒ 助手要**登记一张卡** ✓。
    /// `card` ＝ 判据会拿去当 `Authorization: Bearer` 的那一串 ✓（于是既有那批判据
    /// **形状不变**，而它们**真的在走「卡」那条路** ✓）。
    fn start1s_card(
        proto: &str,
        card: &str,
        cfg: MeshConfig,
        conn: Arc<Mutex<Connection>>,
    ) -> Result<MeshHandle, String> {
        let mut m = std::collections::HashMap::new();
        m.insert(proto.to_string(), conn);
        let mut cards: CardBook =
            std::collections::HashMap::new();
        cards
            .entry(proto.to_string())
            .or_default()
            .hashes
            .insert(crate::db::sha256_hex(card));
        start(cfg, Arc::new(Mutex::new(m)), Arc::new(Mutex::new(cards)))
    }

    fn start1s(proto: &str, cfg: MeshConfig, conn: Arc<Mutex<Connection>>) -> Result<MeshHandle, String> {
        start1s_card(proto, "lan-token", cfg, conn)
    }

    fn start1(cfg: MeshConfig, conn: Arc<Mutex<Connection>>) -> Result<MeshHandle, String> {
        start1s("space-x", cfg, conn)
    }

    fn http_get(addr: SocketAddr, target: &str, token: Option<&str>) -> (u16, String) {
        let mut sock = TcpStream::connect(addr).expect("connect");
        let auth = match token {
            Some(t) => format!("Authorization: Bearer {t}\r\n"),
            None => String::new(),
        };
        let req = format!("GET {target} HTTP/1.1\r\nHost: x\r\n{auth}Connection: close\r\n\r\n");
        sock.write_all(req.as_bytes()).unwrap();
        sock.flush().unwrap();
        let mut raw = Vec::new();
        sock.read_to_end(&mut raw).unwrap();
        let text = String::from_utf8_lossy(&raw).to_string();
        let code = text.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
        (code, body)
    }

    /// ⭐ 2026-10-12（设备身份第 2 步）：发一条**带签名**的 GET ✗（⛔ 不带任何口令 ✗）。
    ///
    /// ⚠️ `ts` 由调用方给 ✗ ⇒ ⭐ 时间窗那一档能被判据**固定** ✓（本仓老规矩：判定里一律传时间 ✓）。
    fn http_get_signed(
        addr: SocketAddr,
        target: &str,
        device_id: &str,
        ts: i64,
        sig: &str,
    ) -> (u16, String) {
        let mut sock = TcpStream::connect(addr).expect("connect");
        let req = format!(
            "GET {target} HTTP/1.1\r\nHost: x\r\n{HDR_DEVICE}: {device_id}\r\n{HDR_TS}: {ts}\r\n{HDR_SIG}: {sig}\r\nConnection: close\r\n\r\n"
        );
        sock.write_all(req.as_bytes()).unwrap();
        sock.flush().unwrap();
        let mut raw = Vec::new();
        sock.read_to_end(&mut raw).unwrap();
        let text = String::from_utf8_lossy(&raw).to_string();
        let code = text.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
        (code, body)
    }

    // ═══════════ ⭐ P1（2026-10-13）：**摘掉口令之后，判据怎么进门** ═══════════
    //
    // 来由：`start1s` 默认往卡册里塞 `lan-token` 的**哈希**（旧那一档 ✓，`:3680-3684`）⇒ 判据一直
    // 靠"出示口令"进门 ✓。P1 要量的是**签名那一档**（设备身份第 2/3 步 ✓）⇒ 判据必须：
    //   ① 摘掉口令 ✓；② 在**对面那扇门**上登记**这一份库的真公钥** ✓。
    // ⚠️ 真钥匙**不是**测试里现造的假钥匙 ✗：走生产那条 `device_key::load_or_create`
    //   （`device_key.rs:56` ✓），拿的是**这一份空间库自己的**真公钥 ✓（样板＝`:5046-5047` 那两把 ✓）。

    /// 这一份空间库的真公钥（十六进制 ✓）—— ⚠️ **会就地建键** ✓（＝生产 `sign_request` 那条路 ✓）。
    fn real_pubkey(conn: &Connection) -> String {
        crate::device_key::load_or_create(conn)
            .expect("真钥匙要建得出来")
            .public_key_hex()
    }

    /// ⭐ **在"对面那扇门"上登记这一份库的真公钥** ⇒ 它签的东西就能过签名那一档 ✓。
    ///
    /// ⛔ **走 `MeshHandle` 的方法，不走 `mesh::add_paired_pubkey` 那个自由函数** ✗ ——
    /// 自由函数是"按**服务哪个空间**去找门、取**第一个**命中的"（`:1330-1336` ✓）⇒
    /// 判据里**两扇门服务同一个空间**时，登记会落进**另一扇门** ⇒ 判据"看起来全绿、其实什么都没证" ✗。
    /// ⭐ 这条坑本仓**已经写过一次**：`:5054-5056`（R110 那条判据里记着同一个 ✓）—— 手柄指的就是**那一扇** ✓。
    fn trust_conn(win: &MeshHandle, proto: &str, device: &str, conn: &Connection) -> String {
        let pk = real_pubkey(conn);
        win.add_paired_pubkey(proto, device, &pk)
            .expect("登记真公钥不该失败");
        pk
    }

    /// ⭐ **带签名的裸 GET**（"手写 GET 那一档" ✓，与 `http_get_signed` 配对 ✓）——
    /// ⭐ 走**生产**的 `sign_request` ✓（⛔ 判据里不自己拼签名 ✗：那会变成"另一份实现" ✗），
    /// ⭐ 空间从请求串的 `?space_id=` 取 ✓ —— 必须与门那一侧判的**同一个** `space`（`auth_message`
    /// 把它签进去了 ✓；两边取法不同源 ⇒ 一漂就"永远 401"✓）。
    fn signed_get(conn: &Connection, addr: SocketAddr, target: &str) -> (u16, String) {
        let space = query_get(target, "space_id")
            .expect("查询串不该需要解码")
            .expect("signed_get 的 target 必须带 ?space_id=");
        let device = crate::sync::device_id(conn).expect("这一份库要有设备号");
        let (ts, sig) = sign_request(conn, &device, &space, "GET", target, crate::db::now_ms())
            .expect("真钥匙应当签得出来");
        http_get_signed(addr, target, &device, ts, &sig)
    }

    /// ★ 丙-③-b-2b：**报不出去**的地址一个都不许写进公告（端口 0 / 回环 / 公网）——
    /// 宁可这一轮不露面，也不要报一个别人拉不到的地址（那只会往网段里灌噪音）。
    #[test]
    fn only_a_real_lan_window_address_may_be_announced() {
        let ok: SocketAddr = "192.168.1.5:8788".parse().unwrap();
        assert_eq!(announced_base(ok).as_deref(), Some("http://192.168.1.5:8788"));
        // ⚠️ **D14（owner 2026-09-30：放行 CGNAT）**：绑在 `100.64/10`（Tailscale 默认段）上的窗口
        //    必须**报得出去** —— 否则对端 `invitable_base` 拿到 `None` ⇒ 永远拉不到我们
        //    （"绑得上但不报"＝ D14 只做了一半）。
        let cgnat: SocketAddr = "100.100.1.1:8788".parse().unwrap();
        assert_eq!(announced_base(cgnat).as_deref(), Some("http://100.100.1.1:8788"));
        // ⚠️ 这里**故意不再断言** `announced_base("0.0.0.0:8788") == None`：D1 之后它的结果
        //    **取决于这台机器真有哪些网卡** ⇒ 放进"固定期望"的判据里就是**看机器脸色**。
        //    通配那一支改由下面那条**喂假网卡**的判据钉（确定性），并在那里断言"绝不许报 0.0.0.0"。
        for bad in ["127.0.0.1:8788", "8.8.8.8:8788", "192.168.1.5:0"] {
            let a: SocketAddr = bad.parse().unwrap();
            assert_eq!(announced_base(a), None, "{bad} 不该被宣告");
        }
    }

    /// ⭐ **判据②（D1 的另一半）：绑通配 ⇒ 报的是"枚举到的那个可达地址"，绝不报 `0.0.0.0`。**
    ///
    /// ⚠️ 为什么必须**喂假网卡**（`announced_bases_with` 的第二个参数）：真网卡是**机器相关**的
    /// —— 本机可能只有回环，也可能有 Wi-Fi ＋ VPN 三张卡 ⇒ 拿真网卡写"固定期望"就是看机器脸色。
    /// 本仓既有纪律同此：**"枚举网卡"这件事本机只能验函数，验不了系统**（真换网/真网卡属 M 档）。
    #[test]
    fn a_wildcard_bind_announces_enumerated_addresses_and_never_the_wildcard() {
        let wild: SocketAddr = "0.0.0.0:8788".parse().unwrap();
        // 一台"典型"的机器：一张 Wi-Fi（私有）＋ 一张 VPN（D14 放行的 CGNAT 段）
        // ＋ 回环 ＋ 链路本地 ＋ 一个公网地址（后三个都**不许**被报出去）。
        let locals: Vec<IpAddr> = [
            "192.168.1.5", "100.100.1.2", "127.0.0.1", "169.254.10.20", "8.8.8.8", "0.0.0.0",
        ]
        .iter()
        .map(|s| s.parse().unwrap())
        .collect();
        let got = announced_bases_with(wild, &locals);
        // 三个候选都在，**顺序**是：非链路本地按地址字节在前，链路本地**排最后**。
        // ⚠️ 链路本地**仍然报**（不排除）—— 与 `is_lan_only` / `lan::is_lan_base` 一致：
        //    169.254 在本仓的定义里**是合法内网地址**（VL-1 的往返判据钉着它）。
        //    而**默认**的枚举（`if-addrs` 的 `link-local` feature 默认关，见 `Cargo.toml`）
        //    本来就不会给出链路本地 ⇒ "排最后"是给"真给了它"那一档兜底。
        assert_eq!(
            got,
            vec![
                "http://100.100.1.2:8788".to_string(),
                "http://192.168.1.5:8788".to_string(),
                "http://169.254.10.20:8788".to_string(),
            ],
            "通配要报出枚举到的候选（回环/公网/通配去掉；链路本地排最后）：{got:?}"
        );
        // ⚠️ **绝不许报 0.0.0.0** —— 对端拿它去连就是连自己（这正是"只放宽 checked_bind"的坑）
        assert!(!got.iter().any(|b| b.contains("0.0.0.0")), "{got:?}");
        assert!(!got.iter().any(|b| b.contains("127.0.0.1")), "回环不是'网段里的别人'：{got:?}");
        assert!(!got.iter().any(|b| b.contains("8.8.8.8")), "公网不许宣告：{got:?}");
        // 一个候选都没有（这台只有回环/公网）⇒ **空**，而不是硬编一个
        assert!(announced_bases_with(wild, &["127.0.0.1".parse().unwrap()]).is_empty());
        assert!(announced_bases_with(wild, &[]).is_empty());
        // 端口 0 ＝ 还没绑上 ⇒ 说得出"没有地址"，不报一个没人算得出的端口
        assert!(announced_bases_with("0.0.0.0:0".parse().unwrap(), &locals).is_empty());
        // 顺序是**确定性**的：同一组网卡跑两遍逐字节相同（否则判据没法比）
        assert_eq!(got, announced_bases_with(wild, &locals));
        // 去重：同一张网卡报两遍 ⇒ 只出现一次
        let dup: Vec<IpAddr> =
            ["192.168.1.5", "192.168.1.5"].iter().map(|s| s.parse().unwrap()).collect();
        assert_eq!(announced_bases_with(wild, &dup).len(), 1);
        // 链路本地**排在私有之后**（它是"这条链上"的地址，最不像对端能用的）
        let ll = announced_bases_with(wild, &["169.254.1.1".parse().unwrap(), "10.0.0.9".parse().unwrap()]);
        assert_eq!(ll, vec!["http://10.0.0.9:8788".to_string(), "http://169.254.1.1:8788".to_string()], "{ll:?}");
        // ★ **绑具体地址 ⇒ 只报它自己**（与 D1 之前逐字相同：这一支不走枚举）
        let concrete: SocketAddr = "10.0.0.7:9000".parse().unwrap();
        assert_eq!(announced_bases_with(concrete, &locals), vec!["http://10.0.0.7:9000".to_string()]);
        // ⚠️ **IPv6 候选一律丢掉**：消费侧 `lan::is_lan_base` 只认 `http://<私有 IPv4>[:端口]`
        //    ⇒ 报 IPv6 就是报一个**对方必然跳过**的地址（往返性质退化的形状）。宁可这一轮不宣告。
        let v6: Vec<IpAddr> = ["fc00::1", "192.168.1.5"].iter().map(|s| s.parse().unwrap()).collect();
        assert_eq!(
            announced_bases_with(wild, &v6),
            vec!["http://192.168.1.5:8788".to_string()],
            "IPv6 候选不许进公告"
        );
        assert!(announced_bases_with(wild, &["fc00::1".parse().unwrap()]).is_empty());
        // 具体绑在 IPv6 上 ⇒ 也不再宣告（**行为变更**：今天它会报一个对方必然跳过的地址）
        assert!(announced_bases_with("[fc00::1]:8788".parse().unwrap(), &locals).is_empty());
    }

    /// ⭐ **2026-10-09 修（amd 报的真发现）**：多网卡机器上，绑通配报出去的必须是**真网卡**，
    /// ⛔ 不是 WSL/Hyper-V 的虚拟网卡 ✗ —— 现场是"报出去的是 172.18.224.1（vEthernet (WSL)），
    /// 而真地址是 192.168.43.190（WLAN）"✓ ⇒ 对面拿虚拟地址来连**永远连不上**，且**没有任何提示** ✓。
    ///
    /// **变异**：把 lan_rank_key 里第一档 u8::from(virt) 去掉（或恒为 0）⇒ ⭐ 本判据**必须红** ✓
    /// （那时 172.18.224.1 会因字节序小于 192.168.43.190 而重新夺回第一位 ✓）。
    #[test]
    fn a_wildcard_bind_prefers_a_real_adapter_over_virtual_ones() {
        let wild: SocketAddr = "0.0.0.0:8788".parse().unwrap();
        // amd 那台的真实读数（逐字）：6 个 IPv4，两张虚拟 ＋ 一张真 WLAN ＋ 三张没连上的链路本地
        let named: Vec<(String, IpAddr)> = [
            ("vEthernet (Default Switch)", "172.31.32.1"),
            ("vEthernet (WSL (Hyper-V firewall))", "172.18.224.1"),
            ("WLAN 6", "192.168.43.190"),
            ("以太网 2", "169.254.10.5"),
            ("以太网 3", "169.254.20.6"),
            ("以太网 4", "169.254.30.7"),
        ]
        .iter()
        .map(|(n, ip)| (n.to_string(), ip.parse().unwrap()))
        .collect();
        let got = announced_bases_with_named(wild, &named);
        // ⭐ 第一位必须是真 WLAN ✓（这就是产品路径 announced_base 取的那个 ✓）
        assert_eq!(
            got.first().map(String::as_str),
            Some("http://192.168.43.190:8788"),
            "绑通配时第一位必须是真网卡，⛔ 不是虚拟网卡：{got:?}"
        );
        // ⭐ 顺序（**实测出来的**，我第一次写反了 ✗）：真网卡 → **链路本地** → 虚拟。
        //    原因：排序键**第一档**是"像不像虚拟网卡" ✓（链路本地那张网卡名是真网卡 ⇒ 第一档 0 ✓），
        //    **第二档**才是链路本地 ⇒ 于是"非虚拟的链路本地"排在"虚拟的真地址"之前 ✓。
        //    ⚠️ 产品目标只看**第一位**（`announced_base` 取 `.next()` ✓）⇒ 这个先后不影响结论 ✓，
        //    但判据要钉**本函数真实的序** ✓，不能钉我以为的序 ✗。
        let pos = |s: &str| got.iter().position(|g| g == s).unwrap_or(usize::MAX);
        assert!(pos("http://192.168.43.190:8788") < pos("http://169.254.10.5:8788"), "{got:?}");
        assert!(pos("http://169.254.10.5:8788") < pos("http://172.18.224.1:8788"), "{got:?}");
        // ⚠️ 虚拟网卡**仍然报**（不排除 ✓）—— 只是**不许抢第一** ✓
        assert_eq!(got.len(), 6, "六张都要在（顺序变、集合不变）：{got:?}");
        assert_eq!(got, announced_bases_with_named(wild, &named));
        // 具体绑虚拟网卡 ⇒ **仍然只报它自己**（用户显式选的，不许替他改 ✓）
        let concrete: SocketAddr = "172.18.224.1:8788".parse().unwrap();
        assert_eq!(
            announced_bases_with_named(concrete, &named),
            vec!["http://172.18.224.1:8788".to_string()]
        );
    }

    /// ⭐ **判据⑤：绑了通配也真的"拉得通"** —— 这就是"用户不填 IP"那一档的端到端形状。
    ///
    /// ⚠️ **回环 ⇒ 只当下界**（本仓纪律）：本判据证明的是"**通配真的在听**、而且**拉得通**"；
    /// 而"**换了网卡之后仍报得出对端能用的那个地址**"**本机验不了**（要真网卡 ⇒ 属 M 档，
    /// 与"真机换网"同一格）。
    #[tokio::test]
    async fn a_wildcard_bound_window_actually_listens_and_can_be_pulled() {
        let a = Arc::new(Mutex::new(space_conn("A")));
        let b = Arc::new(Mutex::new(space_conn("B")));
        // D1：B **不填任何具体 IP**（用户视角："我不知道该填哪个，让它自己听"）
        let win_b = start1(
            MeshConfig {
                bind: "0.0.0.0:0".into(),
                device_id: "B".into(),
                data_dir: None,
            },
            b.clone(),
        )
        .unwrap();
        // ⭐ P1（2026-10-13）：**摘掉口令** ⇒ 只剩签名那一档 ⇒ 把**进门那一方（A）的真公钥**
        //   登记在 **B 这扇门**上 ✓（方向＝"谁进门、谁被登记"✓）。
        trust_conn(&win_b, "space-x", "A", &a.lock().unwrap());
        // ① 通配真的落在一个**具体端口**上（而 `local_addr()` 的 IP 仍是 `0.0.0.0`
        //    ⇒ **它自己不是一个能报给对端的地址**，这就是必须有 `announced_bases_with` 的原因）
        let bound = win_b.addr();
        assert!(bound.ip().is_unspecified(), "绑通配时 local_addr 的 IP 是 0.0.0.0：{bound}");
        assert_ne!(bound.port(), 0, "端口是内核给的具体端口：{bound}");
        // ⭐ P1 前提读数（判据不许假绿 ✓）：这扇门现在**只有签名这一档能进** ——
        //   ⛔ 不带任何证件 ⇒ **401** ✓；✅ 带**这一份库的真签名** ⇒ **200** ✓。
        //   ⚠️ 两条都要量：只量 200 的话，"口令那一档其实还开着"也会绿 ✗（那就什么都没证 ✓）。
        //   ⚠️ **必须连 `127.0.0.1:port`** ✗ —— 这扇门绑的是 `0.0.0.0`，`connect(0.0.0.0:port)` 会**直接
        //   失败** ✓（`win_b.addr()` 的 IP 永远是不确定的 `0.0.0.0` ✓ —— 这也正是本判据下面
        //   要喂假网卡的原因 ✓）；下面那次 `pull_and_absorb` 用的也是 `127.0.0.1:port` ✓（同源 ✓）。
        let probe: SocketAddr = format!("127.0.0.1:{}", bound.port()).parse().unwrap();
        assert_eq!(
            http_get(probe, "/mesh/pull?space_id=space-x&since=0&limit=100", None).0,
            401,
            "摘掉口令之后，不带证件必须 401"
        );
        assert_eq!(
            signed_get(&a.lock().unwrap(), probe, "/mesh/pull?space_id=space-x&since=0&limit=100").0,
            200,
            "登记过 A 的真公钥 ⇒ A 的真签名必须放行"
        );
        // ② B 在自己窗口上写一页
        {
            let c = b.lock().unwrap();
            local_edit(&c, &page("p1", "乙在通配窗口上写的", 1_000));
        }
        // ③ A 去拉 —— 通配窗口**在回环上也听** ⇒ "拉得通"（回环是本档的下界，见头注）
        let client = reqwest::Client::new();
        let report = pull_and_absorb(
            &a,
            &client,
            &mesh_peer("B", &format!("http://127.0.0.1:{}", bound.port())),
            "space-x",
            // ⭐ P1：**不带口令** ✓ —— 这一趟靠 A 的真签名进门（A 的钥匙在 B 的门上登记过 ✓）。
            None,
            false,
        )
        .await
        .unwrap();
        assert_eq!((report.fetched, report.applied), (1, 1), "{report:?}");
        assert_eq!(
            projection_of(&a.lock().unwrap(), "p1"),
            projection_of(&b.lock().unwrap(), "p1"),
            "拉过来的内容必须与 B 逐字节一致"
        );
        // ④ ★ 而**报出去的**绝不是 `0.0.0.0`：同一个端口，喂一组假网卡 ⇒ 报成对端能连的地址
        let announced = announced_bases_with(bound, &["192.168.1.5".parse().unwrap()]);
        assert_eq!(announced, vec![format!("http://192.168.1.5:{}", bound.port())]);
        assert!(!announced.iter().any(|x| x.contains("0.0.0.0")), "{announced:?}");
    }

    /// ★ 设置面的读数必须说清**"别人拉不拉得到"** —— 绑回环时网格自己照常工作，
    /// 但那正是"只做了一半"的形态，不许只回一句"已保存"。
    #[test]
    fn the_config_readout_says_whether_others_can_actually_reach_you() {
        let off = MeshSettings::default();
        assert!(!config_state(&off, None, &[], &[]).enabled);
        assert!(config_state(&off, None, &[], &[]).note.contains("关着"));

        let on = MeshSettings { bind: Some("192.168.1.5:8788".into()), token: Some("t".into()) };
        let good = config_state(&on, Some("192.168.1.5:8788".parse().unwrap()), &[], &[]);
        assert!(good.enabled && good.token_set);
        // ⭐ 2026-10-14：这句搬到了 `reach`（⭐ 界面第二行 ✓）—— ⭐ 判据跟着换对象 ✓（⛔ 断言没删 ✗）。
        assert!(good.reach.contains("能被别人拉到"), "{}", good.reach);
        assert_eq!(good.window.as_deref(), Some("http://192.168.1.5:8788"));

        let loopback = config_state(&on, Some("127.0.0.1:8788".parse().unwrap()), &[], &[]);
        assert!(loopback.reach.contains("别人拉不到"), "{}", loopback.reach);

        // ★ **D1（owner 2026-09-30）**：绑**通配**时那两句人话 —— ⚠️ **不写死"这台机器有没有网卡"**
        //   （那是机器脸色）：只钉"它说的是通配"＋"与 `announced_base` 的结论一致"。
        let wild: SocketAddr = "0.0.0.0:8788".parse().unwrap();
        let w = config_state(&on, Some(wild), &[], &[]);
        assert!(w.note.contains("听所有网卡"), "{}", w.note);
        assert!(w.note.contains("0.0.0.0:8788"), "通配要把**绑的**地址说出来：{}", w.note);
        match announced_base(wild) {
            Some(base) => {
                assert!(w.reach.contains(&base), "枚举到的地址要出现在读数里：{}", w.reach);
                assert!(w.reach.contains("能被别人拉到"), "{}", w.reach);
            }
            None => {
                assert!(w.reach.contains("别人拉不到"), "{}", w.reach);
                // ⚠️ 通配 + 无候选，**不许**说成"回环 / 端口 0"——那是另一格，用户的下一步不同
                //    （`INV-VLAN-bind-must-be-reachable`：这里要说**可操作**的话，不许静默）
                assert!(!w.note.contains("回环"), "通配不是回环，别混两格：{}", w.note);
                assert!(w.note.contains("网卡"), "要给出可操作的下一步：{}", w.note);
            }
        }

        // ⚠️ **不回口令本身**
        let json = serde_json::to_string(&good).unwrap();
        assert!(json.contains("tokenSet"), "{json}");
        assert!(!json.contains("\"t\""), "读数里不许带口令本身：{json}");
    }

    /// ⚠️ **变异实测**：把服务侧那条 SQL 的 `device_id = 我自己` 去掉 ⇒ "没有账本"那条判据
    /// 与 ★★ 判据都会红（别人的行会被服务出去）。这里只用**纯 SQL** 复算一遍这个后果，
    /// 免得将来有人以为那个 `WHERE` 是可有可无的优化。
    #[test]
    fn without_the_own_device_filter_the_window_would_leak_other_devices_rows() {
        let c = space_conn("A");
        local_edit(&c, &page("p1", "A 的", 10));
        crate::sync::set_meta_state(&c, "device_id", "B").unwrap();
        local_edit(&c, &page("p2", "B 的", 20));
        crate::sync::set_meta_state(&c, "device_id", "A").unwrap();

        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM changes WHERE device_seq > 0", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2, "库里确实有两条（一条是我的、一条不是）");
        assert_eq!(serve_own_records(&c, "A", 0, 500).unwrap().len(), 1, "而我只服务我自己的那条");
    }

    // ═══════════════ 丙-③-b-2a：控制面（设置 / 窗口 / 一轮交换） ═══════════════

    /// ★ **没配监听地址 ⇒ 整档关着，一个字节都不动**（默认零行为变化）。
    ///
    /// 咬人的地方：把这一支改成"没配就用默认端口" ⇒ 这条红 —— 而**悄悄开一个口**比不开更糟。
    /// 判据怎么证明"没动过"：对端表里给一个**根本连不上**的地址 ——
    /// 真去拉了就会在报告里留一行 `error`；这里要求**一行都没有**。
    #[tokio::test]
    async fn without_a_configured_bind_the_mesh_is_off_and_touches_nothing() {
        let b = Mutex::new(space_conn("B"));
        assert_eq!(settings(&b.lock().unwrap(), "space-x"), MeshSettings::default(), "默认是关的");

        let peers = vec![announced("A", "http://127.0.0.1:9", &["space-x"])]; // 端口 9：连不上
        let rep = round(&b, "space-x", "B", &peers, false).await.unwrap();
        assert!(!rep.enabled, "{rep:?}");
        assert_eq!(rep.candidates, 0);
        assert!(rep.peers.is_empty(), "没开就不许碰任何对端：{rep:?}");
        assert!(rep.note.contains("关着"), "要说得出为什么：{}", rep.note);
    }

    /// ★ **网格不需要服务端档案** —— 设置那一格与 `sync_profiles` 完全无关
    /// （这正是甲-2 冻结之后"不装服务端也能同步"落到的地方）。
    #[test]
    fn a_space_with_no_server_profile_can_still_turn_the_mesh_on() {
        let c = space_conn("A");
        let n: i64 = c.query_row("SELECT COUNT(*) FROM sync_profiles", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "这一格判据的前提：一个服务端档案都没有");

        set_mesh_bind(&c, "space-x", Some("192.168.1.5:8788")).unwrap();
        set_mesh_token(&c, "space-x", Some("lan-token")).unwrap();
        let s = settings(&c, "space-x");
        assert_eq!(s.bind.as_deref(), Some("192.168.1.5:8788"));
        assert_eq!(s.token.as_deref(), Some("lan-token"));
        // 空串 ＝ 关（用空串当"清除"）
        set_mesh_bind(&c, "space-x", Some("   ")).unwrap();
        assert_eq!(settings(&c, "space-x").bind, None);
        // 另一个空间互不串味
        assert_eq!(settings(&c, "space-y").bind, None);
    }

    /// ⭐ **D1（owner 2026-09-30）：配的时候**收**通配**、仍拒**公网** —— 而且**当场**判（不等到开窗）。
    ///
    /// ⚠️ 这条是**把既有判据反过来**（原先它是 `0.0.0.0 ⇒ Err` ＋ `e.contains("内网")`），
    /// 按纪律**不是删断言**，是**拆成两条**：通配 ⇒ `Ok` 且**落库**；公网 ⇒ `Err` 且**不落库**。
    #[test]
    fn configuring_a_bind_accepts_the_wildcard_and_refuses_a_public_address() {
        // ① D1：通配**收**，而且**落库**（用户不用手填 IP）——
        //    ⚠️ 报什么地址由 `announced_bases_with` 算，这里只管"绑得上"。
        let c = space_conn("A");
        set_mesh_bind(&c, "space-x", Some("0.0.0.0:8788")).unwrap();
        assert_eq!(
            settings(&c, "space-x").bind.as_deref(),
            Some("0.0.0.0:8788"),
            "D1：通配要真的落库（不然开窗那一步还是空）"
        );

        // ② 不许放宽：公网字面地址**当场拒**，而且**不落库**（原判据的这一半原样保住）。
        let c2 = space_conn("B");
        let e = set_mesh_bind(&c2, "space-x", Some("8.8.8.8:8788")).unwrap_err();
        assert!(e.contains("内网"), "{e}");
        assert_eq!(settings(&c2, "space-x").bind, None, "拒绝了就不许落库");
        // 顺带：**可操作**的提示里要说得出"想听所有网卡就写 0.0.0.0"（D1 之后这是正路之一）
        assert!(e.contains("0.0.0.0"), "报错要说清出路（含通配这一条）：{e}");
    }

    /// ★★ **`U9` / `INV-PER-unencrypted-needs-strong-secret`**：
    /// **弱口令 ⇒ 当场拒，且理由里说得出怎么办** ✓（判据矩阵 U9 ①）。
    ///
    /// ⚠️ **变异**：把 `set_mesh_token` 放宽成"非空即放行" ⇒ **这个测试必须红** ✓
    /// （那就是本仓最怕的形状：用户以为设了密码，其实同网段三秒被猜中，而**没有任何提示**）。
    #[test]
    fn a_weak_mesh_token_is_refused_with_something_actionable() {
        // ① 三类弱口令逐个拒，而且**都不许落库**（拒了还落库 ＝ 用户以为挡住了）
        for weak in ["123456", "1234567890", "short", "aaaaaaaaaaaa", "  1234  "] {
            let c = space_conn("W");
            let e = set_mesh_token(&c, "space-x", Some(weak)).unwrap_err();
            // ⭐ **可操作**：说清了它为什么是唯一防线 ＋ 给出路（长度／别用纯数字）
            assert!(e.contains("唯一"), "理由要说清“口令是唯一防线”：{e}");
            assert!(e.contains("8"), "理由要给出长度门槛：{e}");
            assert!(e.contains("纯数字") || e.contains("同一"), "理由要点名是哪一类弱：{e}");
            assert_eq!(settings(&c, "space-x").token, None, "拒了就不许落库（{weak}）");
        }

        // ② 达标的口令**收**，而且落库（⛔ 不要把好口令也挡了 —— 那是另一种坏 ✓）
        let c = space_conn("OK");
        set_mesh_token(&c, "space-x", Some("k7Qm-2pRt")).unwrap();
        assert_eq!(settings(&c, "space-x").token.as_deref(), Some("k7Qm-2pRt"));

        // ③ 空 ⇒ **放行**（＝清除这一档；既有语义不变 ✓）
        set_mesh_token(&c, "space-x", Some("   ")).unwrap();
        assert_eq!(settings(&c, "space-x").token, None, "空＝清掉这一档");
        set_mesh_token(&c, "space-x", None).unwrap();
        assert_eq!(settings(&c, "space-x").token, None);
    }

    /// ★★ **产品入口那一层**：`round` 真的把发现到的对端拉回来了（真环回、没有服务端）。
    #[tokio::test]
    async fn the_product_entry_pulls_from_a_discovered_peer_over_loopback() {
        let a = Arc::new(Mutex::new(space_conn("A")));
        let win = start1(
            MeshConfig {
                bind: "127.0.0.1:0".into(),
                device_id: "A".into(),
                // 判据里的窗口默认**不服务附件**（`/mesh/attachment` 会如实回 501）；
                // 要验附件那条路的判据自己塞临时目录。
                data_dir: None,
            },
            a.clone(),
        )
        .unwrap();
        {
            let c = a.lock().unwrap();
            local_edit(&c, &page("p1", "甲写的", 1_000));
        }

        let b = Mutex::new(space_conn("B"));
        {
            let c = b.lock().unwrap();
            set_mesh_bind(&c, "space-x", Some("127.0.0.1:0")).unwrap();
            // ⭐ **P1（2026-10-13）**：这一格**摘掉了** ✗ —— 原来这里存的是"给 A 的那份配对秘密"
            //   （旧那一档 ✓，窗口把它当一张卡 ✓）；现在**本机不出示任何口令** ✓ ⇒ 只剩签名那一档 ✓。
            set_pair_secret(&c, "space-x", "A", None).unwrap();
        }
        // ⭐ P1：签名那一档要过两件事 —— 本机（B）自己签 ✓ ＋ **A 的门上登记过 B 的公钥** ✓
        //   ⇒ 把 **B 的真公钥**登记在 **A 这扇门**上（方向＝"谁进门、谁被登记"✓）。
        trust_conn(&win, "space-x", "B", &b.lock().unwrap());
        let peers = vec![announced("A", &format!("http://{}", win.addr()), &["space-x"])];

        // ⚠️ 这里走 `round_candidates`（而不是 `round`）：回环地址会被 `mesh_peers` 正确过滤掉
        //    （`lan::is_lan_base` 明确排除 `127/8` —— "回环不是网段里的别人"），
        //    所以本机判据只能在**后半**上跑真环回；`mesh_peers` 的过滤自有一条判据。
        let candidates = mesh_peers("space-x", "B", &peers);
        assert!(candidates.is_empty(), "前提：回环基址会被挑对端那一步过滤掉（甲-1 的口径）");
        let cands = vec![mesh_peer("A", &format!("http://{}", win.addr()))];
        let cfg = settings(&b.lock().unwrap(), "space-x");

        let rep = round_candidates(&b, "space-x", cands.clone(), false).await.unwrap();
        assert!(rep.enabled && rep.candidates == 1, "{rep:?}");
        assert_eq!(rep.peers.len(), 1);
        assert_eq!((rep.peers[0].fetched, rep.peers[0].applied), (1, 1), "{rep:?}");
        assert_eq!(rep.peers[0].error, None);
        assert_eq!(
            projection_of(&b.lock().unwrap(), "p1"),
            projection_of(&a.lock().unwrap(), "p1"),
            "产品入口拉回来的东西必须与对端一致"
        );

        // 再跑一轮：水位到批尾 ⇒ 什么都不再拉（幂等，不重复搬运）
        let again = round_candidates(&b, "space-x", cands, false).await.unwrap();
        assert_eq!(again.peers[0].fetched, 0, "{again:?}");
    }

    /// ★ **一只对端拉不动不连坐**：它的错记在自己那一行，别的照拉。
    #[tokio::test]
    async fn a_peer_that_is_down_is_reported_in_its_own_row_and_does_not_block_the_others() {
        let a = Arc::new(Mutex::new(space_conn("A")));
        let win = start1(
            MeshConfig {
                bind: "127.0.0.1:0".into(),
                device_id: "A".into(),
                data_dir: None,
            },
            a.clone(),
        )
        .unwrap();
        {
            let c = a.lock().unwrap();
            local_edit(&c, &page("p1", "甲写的", 1_000));
        }
        let b = Mutex::new(space_conn("B"));
        {
            let c = b.lock().unwrap();
            set_mesh_bind(&c, "space-x", Some("127.0.0.1:0")).unwrap();
            // ⭐ **U11**：门只认卡 ⇒ 本机要出示"给 A 的那一份" ✓（对端窗口登记的就是它 ✓）
            set_pair_secret(&c, "space-x", "A", Some("lan-token")).unwrap();
        }
        // 两台够格的对端：一台活着、一台连不上（端口 9）
        let cands = vec![
            mesh_peer("A", &format!("http://{}", win.addr())),
            mesh_peer("Z", "http://127.0.0.1:9"),
        ];
        let cfg = settings(&b.lock().unwrap(), "space-x");
        let rep = round_candidates(&b, "space-x", cands, false).await.unwrap();
        assert_eq!(rep.candidates, 2);
        let down = rep.peers.iter().find(|r| r.peer == "Z").expect("连不上的那台也要有一行");
        assert!(down.error.is_some(), "拉不动要如实写在自己那一行：{down:?}");
        let up = rep.peers.iter().find(|r| r.peer == "A").expect("活着的那台");
        assert_eq!((up.fetched, up.applied, up.error.is_none()), (1, 1, true), "{up:?}");
        assert!(rep.note.contains("1 台没拉动"), "总读数要把失败数说出来：{}", rep.note);
    }

    // ═══════════ ⭐ T-10 · **十台设备的多端验证**（`U14` 的判据承载） ═══════════ //
    //
    // 判据与目标**照抄**（`docs/specs/2026-09-29-personal-edition-tasks.md` §15.1，**不自创**）：
    //   ① 收敛：10 台同时编辑 60 秒 ⇒ 全库投影**逐字节相同**
    //   ② 不落后：任何一台的"最后成功拉取"距今 ≤ **10 秒**（＝2 个节拍）
    //   ③ 拉取量：**每台 ≤2 次/秒**、合计 ≤**18 次/秒**（＝10×9÷5；扇出是 N²）
    //   ④ 合并余量：合计编辑速率 ≤ 舒适上界（~500/秒）的 **20%**
    //
    // 常量**全部带出处**，一个都不自己发明：
    //   · 台数 10           ＝ `U14`「单个空间最多 10 台设备」（owner 2026-09-30 定）
    //   · 节拍 5 秒         ＝ 产品默认 `src/lib/syncMode.ts:71 PULL_INTERVAL_DEFAULT_MS = 5_000`
    //   · 每台 5 次编辑/秒  ＝ `personal-edition-spec` §14「10 台 × 5 次编辑/秒 ＝ 50 次/秒」
    //   · 判据② 的 10 秒    ＝ `U14`「≤ 两个节拍」
    //   · 舒适上界 ~500/秒  ＝ `docs/plans/2026-09-29-client-frame-rate-loadtest.md`（**实测**）
    /// T-10：台数（`U14`）。
    const T10_DEVICES: usize = 10;
    /// T-10：拉取节拍 ＝ 产品默认 5 秒（`syncMode.ts` 的 `PULL_INTERVAL_DEFAULT_MS`）。
    const T10_CADENCE_MS: i64 = 5_000;
    /// T-10：编辑窗（`U14` 原文"10 台同时编辑 60 秒"）。
    const T10_EDIT_MS: i64 = 60_000;
    /// T-10：每台每秒的编辑次数（`U14`／§14 的 5 次/秒）。
    const T10_EDITS_PER_SEC: i64 = 5;
    /// T-10 判据②：任何一台"最后成功拉取"距今的上限 ＝ 两个节拍。
    const T10_STALENESS_LIMIT_MS: i64 = 10_000;
    /// T-10 判据③：每台／合计的拉取速率上限（合计 ＝ 10×9÷5 ＝ 18 次/秒）。
    const T10_PULLS_PER_DEV_PER_SEC_LIMIT: f64 = 2.0;
    const T10_PULLS_AGG_PER_SEC_LIMIT: f64 = 18.0;
    /// T-10 判据④：舒适上界（实测 ~500 条 update/秒）与允许占它的比例（`U14`：20%）。
    const T10_COMFORT_PER_SEC: f64 = 500.0;
    const T10_COMFORT_SHARE_LIMIT: f64 = 0.20;
    /// T-10：10 台绑同一个空间；单人多设备那条口径 ⇒ 共用一个口令。
    const T10_SPACE: &str = "space-t10";
    const T10_TOKEN: &str = "t10-token";

    /// T-10 判据①的读数：一台设备**整库**的投影（所有页，按 id 排序拼起来）⇒ 与别的设备**逐字节**比。
    fn db_projection(c: &Connection) -> String {
        page_ids(c).iter().map(|id| format!("{id} => {}\n", projection_of(c, id))).collect()
    }

    /// T-10 的**信息项**（**不是判据**）：同一批页的**原始** `content_json`。
    /// 两侧经手路径不同（本地写 vs 合并落库）⇒ 允许不同；判据是上一条投影比对
    /// （口径见 `projection_of` 的头注）。
    fn db_raw(c: &Connection) -> String {
        page_ids(c).iter().map(|id| format!("{id} => {}\n", content_of(c, id))).collect()
    }

    fn page_ids(c: &Connection) -> Vec<String> {
        let mut stmt = c.prepare("SELECT id FROM pages ORDER BY id").unwrap();
        let ids: Vec<String> =
            stmt.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        ids
    }

    /// ⭐ **T-10 · 十台设备的多端验证** —— `U14`（单空间 ≤10 台）的**判据承载**。
    ///
    /// ## 这一档**是什么**
    /// **10 个真网格窗口**（各绑 `127.0.0.1:0` ⇒ 真 TCP 环回、真 HTTP）＋ **10 份独立库文件**
    /// （＝ §15.2 说的"独立 `--db`"），全部绑**同一** `space_id`，**手工把对端清单填成其余 9 台**
    /// ⇒ 走 `round_candidates`（**绕过发现层**）。
    ///
    /// ## ⚠️ 这一档的结论**只能写成"下界"**（硬纪律，不许悄悄升格）
    /// **为什么绕过发现层**：`lan::is_lan_base` **明确把 `127/8` 排除**在"网段里的别人"之外
    /// （甲-1 的口径）⇒ 回环上 `mesh_peers` 挑出来的对端**必然是空集** ⇒ 只能手工给清单。
    /// ⇒ ⇒ 所以它验的是 **①收敛 ②不落后 ③拉取量 ④合并余量** 这四条；
    ///    **验不了**：**真实 UDP 发现 10 台能不能互相发现** ——
    ///    `personal-edition-spec` §14 把那条标成 `[无依据]`，它的载体是 **`M-10`（10 台真机，要人手）**。
    ///
    /// ## 为什么 `#[ignore]`
    /// 它要 **60 秒真实时钟 ＋ 10 个窗口**（≈100 秒）⇒ 不进 `cargo test --lib` 的默认跑
    /// （本仓既有 19 条 ignored 同此纪律）；**由 `scripts/verify-mesh-ten-devices.mjs` 显式跑**。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "T-10：要 60 秒真实时钟 + 10 个网格窗口（≈100 秒）；由 scripts/verify-mesh-ten-devices.mjs 显式跑（--ignored）"]
    async fn ten_devices_converge_with_no_device_left_behind() {
        let dir = temp_dir("t10");
        std::fs::create_dir_all(&dir).unwrap();
        let ids: Vec<String> = (1..=T10_DEVICES).map(|i| format!("dev-{i:02}")).collect();

        // ① 10 份**独立库文件** ＋ 10 个**真窗口**（各自一个端口 ⇒ 真环回、真 HTTP）
        let conns: Vec<Arc<Mutex<Connection>>> =
            ids.iter().map(|id| Arc::new(Mutex::new(device_conn(&dir, id)))).collect();

        // ⚠️⚠️ **2026-10-02（个人版任务单 T8 的「在岗核查」当场抓到的一处坏）**：
        //    owner 2026-10-02 选 A（**门只认卡** ✓）之后，`authorized` 是拿 `sha256(Bearer)`
        //    去 `paired[space]` 里找 ✓，而客户端**出示的**是 `mesh_pair_secret:<space>:<peer>`
        //    （**每对一份** ✓，见 `pair_secret_for`）⇒ 夹具**必须先把每一对的秘密写好**，
        //    否则 10 台全都出示不出凭证 ⇒ **90 次拉开全 401** ✗。
        //    这一段坏掉之所以没人发现：这条判据挂着 `#[ignore]`（不在 `cargo test` 的默认集合里 ✓）、
        //    而它的脚本 `scripts/verify-mesh-ten-devices.mjs` **没有任何调用者** ✗
        //    ⇒ 正是本仓 §3 那两条铁律说的同一件事（「看起来加了门禁、其实没人跑」✓）。
        //    ⇒ 本轮的处置：夹具补上每对的秘密 ＋ **把那条脚本登记进 `gates.mjs` 的 rust 组** ✓。
        //    ⚠️ 10 台**共用同一个**秘密，是**夹具**的取舍（回环 ＋ 本机 10 个窗口）：它验的是
        //    ①收敛 ②不落后 ③拉取量 ④合并余量 ✓；**不**验「每对一份不同秘密」——那是 T5／R110 的判据 ✓。
        for i in 0..T10_DEVICES {
            let g = conns[i].lock().unwrap();
            for k in 0..T10_DEVICES {
                if i != k {
                    set_pair_secret(&g, T10_SPACE, &ids[k], Some(T10_TOKEN)).unwrap();
                }
            }
        }
        let wins: Vec<MeshHandle> = (0..T10_DEVICES)
            .map(|i| {
                start1s_card(
                    T10_SPACE,
                    T10_TOKEN,
                    MeshConfig {
                        bind: "127.0.0.1:0".into(),
                        device_id: ids[i].clone(),
                        data_dir: None,
                    },
                    conns[i].clone(),
                )
                .unwrap()
            })
            .collect();

        // ② **手工对端清单**（每台 ＝ 其余 9 台）—— §15.2 的那条口径，也是"下界"的来源（见头注）。
        let cfg = MeshSettings { bind: Some("127.0.0.1:0".into()), token: Some(T10_TOKEN.into()) };
        let cfg_ref = &cfg;
        // 读数：10 个窗口的实际地址（各自一个端口 ⇒ 10 份独立监听；判据 ③ 的对端清单就是它们）
        println!(
            "[T10] 10 个窗口 = {:?}",
            wins.iter().map(|w| format!("{}", w.addr())).collect::<Vec<_>>()
        );

        struct Round {
            at_ms: i64,
            ok_per_dev: Vec<usize>,
        }

        let start_ms = crate::db::now_ms();
        let edit_deadline = start_ms + T10_EDIT_MS;
        let hard_deadline = start_ms + T10_EDIT_MS + 90_000;
        let tick_ms = 1_000 / T10_EDITS_PER_SEC;
        let mut next_edit = start_ms;
        let mut next_round = start_ms + T10_CADENCE_MS;
        let mut tick: u64 = 0;
        let mut edits: u64 = 0;
        let mut last_ok: Vec<i64> = vec![start_ms; T10_DEVICES];
        let mut worst_staleness: i64 = 0;
        let mut rounds: Vec<Round> = Vec::new();
        let mut empty_after_edit = 0usize;

        while crate::db::now_ms() < hard_deadline {
            let now = crate::db::now_ms();

            // ── 编辑：编辑窗内**每台 5 次/秒**（5 次里 1 次打**共享页** ⇒ 制造真争用；其余打自己那页）
            //    ⚠️ 用 `while` **补齐欠拍**（循环是 50 ms 轮询的）：写成 `if` 时实测只有 ~48 次/秒，
            //    与 `U14` 的"每台 5 次/秒"对不上；补齐之后 60 秒内每台正好 ~300 拍 ⇒ 合计 50 次/秒。
            while crate::db::now_ms() < edit_deadline && crate::db::now_ms() >= next_edit {
                for (i, c) in conns.iter().enumerate() {
                    let g = c.lock().unwrap();
                    let (pid, text) = if tick % 5 == 0 {
                        ("p-shared".to_string(), format!("第 {tick} 拍：{} 改共享页", ids[i]))
                    } else {
                        (format!("p-{}", ids[i]), format!("第 {tick} 拍：{} 改自己那页", ids[i]))
                    };
                    local_edit(&g, &page(&pid, &text, now));
                    edits += 1;
                }
                tick += 1;
                next_edit += tick_ms;
            }

            // ── 拉取轮：每 **5 秒**一轮，10 台**并发**（"同时在线"就是这一句）
            if now >= next_round {
                // ⚠️ ③ 的分母用**轮次触发时刻**（＝调度驱动的 +5 秒），**不是**轮结束时刻 ——
                //    用结束时刻会被"每一轮的耗时差"污染（实测：12 轮跨度 58839 ms < 12×5000
                //    ⇒ 合计速率虚高成 18.36，把一条**合格的**系统判成红）。
                let at = now;
                for i in 0..T10_DEVICES {
                    worst_staleness = worst_staleness.max(at - last_ok[i]);
                }
                let futs = (0..T10_DEVICES).map(|i| {
                    let conn = conns[i].clone();
                    let peers: Vec<MeshPeer> = (0..T10_DEVICES)
                        .filter(|&k| k != i)
                        .map(|k| mesh_peer(&ids[k], &format!("http://{}", wins[k].addr())))
                        .collect();
                    async move { round_candidates(&conn, T10_SPACE, peers, false).await }
                });
                let reports = futures_util::future::join_all(futs).await;
                let mut ok_per_dev = vec![0usize; T10_DEVICES];
                let mut fetched = 0usize;
                let mut errs = 0usize;
                for (i, r) in reports.iter().enumerate() {
                    let rep = r.as_ref().unwrap_or_else(|e| panic!("round 本身不该失败：{e}"));
                    for p in &rep.peers {
                        if let Some(e) = &p.error {
                            // 拉不动就**逐条**打出来（不只第一条）—— 这一档"不许有拉不动"，
                            // 真红了要能一眼看出是"某一台死了"还是"并发下大面积失败"。
                            eprintln!(
                                "[T10] 第 {} 轮 {} 拉 {} 失败（fetched={}）：{e}",
                                rounds.len() + 1,
                                ids[i],
                                p.peer,
                                p.fetched
                            );
                            errs += 1;
                            continue;
                        }
                        ok_per_dev[i] += 1;
                        fetched += p.fetched;
                    }
                    if ok_per_dev[i] > 0 {
                        last_ok[i] = at;
                    }
                }
                if errs > 0 {
                    panic!("T-10：第 {} 轮有 {errs} 次拉不动（诊断见上面 [T10-DIAG]）", rounds.len() + 1);
                }
                rounds.push(Round { at_ms: at, ok_per_dev });
                next_round += T10_CADENCE_MS;
                // 收敛出口：编辑已停 ＋ 这一轮**谁都没有新行** ⇒ 再确认一轮就收工
                if at > edit_deadline && fetched == 0 {
                    empty_after_edit += 1;
                    if empty_after_edit >= 2 {
                        break;
                    }
                } else {
                    empty_after_edit = 0;
                }
            }

            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        let end_ms = crate::db::now_ms();
        assert!(rounds.len() >= 4, "T-10：只跑了 {} 轮（窗口没起来？）", rounds.len());

        // ── ① 收敛：**全库投影逐字节相同**
        let projections: Vec<String> = conns.iter().map(|c| db_projection(&c.lock().unwrap())).collect();
        let converged = projections.iter().all(|p| *p == projections[0]);
        let raws: Vec<String> = conns.iter().map(|c| db_raw(&c.lock().unwrap())).collect();
        let raw_equal = raws.iter().all(|r| *r == raws[0]);
        let pages = page_ids(&conns[0].lock().unwrap()).len();

        // ── ② 不落后：每台的"最后成功拉取"距今 ≤ 10 秒
        let final_staleness: Vec<i64> = last_ok.iter().map(|t| end_ms - t).collect();
        let max_final_staleness = *final_staleness.iter().max().unwrap();

        // ── ③ 拉取量：从**实际发生的拉取**里数速率
        //    分母用**内部窗口**（去掉第一轮与最后一轮）—— 边界轮会把速率算高（真轮次在窗口外）。
        let first = 1usize;
        let last = rounds.len() - 1; // exclusive
        let window_rounds = last - first;
        // ⚠️ 分母用**调度窗口**（`window_rounds × 节拍`），**不用**轮次的时间戳差：
        //    轮是按**绝对时刻**触发的，而触发抖动只可能让**真实**跨度更长；拿结束时刻去量，
        //    实测出现过"12 轮跨度 58839 ms < 12×5000"（各轮耗时不同）⇒ 速率虚高成 18.36，
        //    把一条**合格的**系统判成红。按调度算出来的是**上界**（偏保守）：它 ≤18 ⇒ 真速率也 ≤18。
        let window_ms = window_rounds as i64 * T10_CADENCE_MS;
        // 信息项：时间戳差出来的**真实**跨度（只为透明，不作判据分母）
        let wallclock_ms = (rounds[last].at_ms - rounds[first].at_ms).max(1);
        let wallclock_secs = wallclock_ms as f64 / 1000.0;
        let window_secs = window_ms as f64 / 1000.0;
        let mut per_dev_pulls = vec![0usize; T10_DEVICES];
        for row in &rounds[first..last] {
            for i in 0..T10_DEVICES {
                per_dev_pulls[i] += row.ok_per_dev[i];
            }
        }
        let agg_pulls: usize = per_dev_pulls.iter().sum();
        let per_dev_per_sec: Vec<f64> = per_dev_pulls.iter().map(|n| *n as f64 / window_secs).collect();
        let agg_per_sec = agg_pulls as f64 / window_secs;
        // 信息项：拿**真实**跨度算的同一条速率（判据不吃它，只为"上界 vs 实测"可比）
        let agg_per_sec_wallclock = agg_pulls as f64 / wallclock_secs;
        // 客户端"我发起了几次" vs **服务侧"真的服务过几次"** —— 两者必须相等（否则有额外拉取）
        let client_total: usize = rounds.iter().flat_map(|r| r.ok_per_dev.iter()).sum();
        let server_total: usize = wins.iter().map(|w| w.served_pulls()).sum();

        // ── ④ 合并余量：合计编辑速率 vs 舒适上界（~500/秒）的 20%
        let edit_secs = T10_EDIT_MS as f64 / 1000.0;
        let edits_per_sec = edits as f64 / edit_secs;
        let comfort_share = edits_per_sec / T10_COMFORT_PER_SEC;

        let reading = serde_json::json!({
            "scope": "loopback-lower-bound",
            "note": "本机档：回环 + 手工对端清单（绕过发现层）⇒ 只当下界；真发现层归 M-10",
            "devices": T10_DEVICES,
            "cadence_ms": T10_CADENCE_MS,
            "pages": pages,
            "rounds": rounds.len(),
            "window_rounds": window_rounds,
            "window_ms": window_ms,
            "wallclock_ms": wallclock_ms,
            "pulls_per_sec_aggregate_wallclock": agg_per_sec_wallclock,
            "edits_total": edits,
            "edits_per_sec": edits_per_sec,
            "comfort_per_sec": T10_COMFORT_PER_SEC,
            "comfort_share": comfort_share,
            "pulls_per_device_in_window": per_dev_pulls,
            "pulls_per_device_per_sec": per_dev_per_sec,
            "pulls_aggregate_in_window": agg_pulls,
            "pulls_per_sec_aggregate": agg_per_sec,
            "client_pulls_total": client_total,
            "server_served_pulls_total": server_total,
            "worst_staleness_ms": worst_staleness,
            "final_staleness_ms": final_staleness,
            "converged": converged,
            "raw_content_equal": raw_equal,
            "limits": {
                "staleness_ms": T10_STALENESS_LIMIT_MS,
                "pulls_per_device_per_sec": T10_PULLS_PER_DEV_PER_SEC_LIMIT,
                "pulls_per_sec_aggregate": T10_PULLS_AGG_PER_SEC_LIMIT,
                "comfort_share": T10_COMFORT_SHARE_LIMIT,
            },
        });
        println!("[T10] ⚠️ 本机档（回环 + 手工对端清单）＝ **下界**；真发现层／真机 10 台归 M-10（要人手）");
        println!(
            "[T10] ①收敛 = {converged}（{pages} 页；原始 content_json 相同 = {raw_equal}，**不是判据**）"
        );
        println!(
            "[T10] ②不落后 = 最差 {worst_staleness} ms / 收尾最差 {max_final_staleness} ms（上限 {T10_STALENESS_LIMIT_MS}）"
        );
        println!(
            "[T10] ③拉取 = 每台 {:?} 次/秒（上限 {}）｜合计 {agg_per_sec:.3} 次/秒（上限 {T10_PULLS_AGG_PER_SEC_LIMIT}）｜\
             调度窗口 {window_ms} ms / {window_rounds} 轮（上界口径；时间戳差 {wallclock_ms} ms ⇒ 实测口径 {agg_per_sec_wallclock:.3}）｜\
             服务侧真的服务过 {server_total} 次",
            per_dev_per_sec.iter().map(|r| (r * 100.0).round() / 100.0).collect::<Vec<_>>(),
            T10_PULLS_PER_DEV_PER_SEC_LIMIT
        );
        println!(
            "[T10] ④合并余量 = {edits_per_sec:.1} 次/秒（{edits} 次编辑 / {} 秒）＝ 舒适上界的 {:.1}%（上限 {}%）",
            T10_EDIT_MS / 1000,
            comfort_share * 100.0,
            T10_COMFORT_SHARE_LIMIT * 100.0
        );
        println!("T10-READING {reading}");

        assert!(converged, "① 判据不成立：10 台的最终内容**不是**逐字节相同");
        assert!(
            worst_staleness <= T10_STALENESS_LIMIT_MS,
            "② 判据不成立：有一台落后 {worst_staleness} ms（上限 {T10_STALENESS_LIMIT_MS}）"
        );
        assert!(
            max_final_staleness <= T10_STALENESS_LIMIT_MS,
            "② 判据不成立（收尾）：{final_staleness:?}（上限 {T10_STALENESS_LIMIT_MS}）"
        );
        assert!(
            per_dev_per_sec.iter().all(|r| *r <= T10_PULLS_PER_DEV_PER_SEC_LIMIT),
            "③ 判据不成立：每台速率 {per_dev_per_sec:?}（上限 {T10_PULLS_PER_DEV_PER_SEC_LIMIT}）"
        );
        assert!(
            agg_per_sec <= T10_PULLS_AGG_PER_SEC_LIMIT,
            "③ 判据不成立：合计 {agg_per_sec} 次/秒（上限 {T10_PULLS_AGG_PER_SEC_LIMIT}）"
        );
        assert_eq!(
            server_total, client_total,
            "③ 的交叉验不成立：服务侧真的服务过 {server_total} 次，客户端只报 {client_total} 次 ⇒ **有额外拉取**（判据 ③ 被污染）"
        );
        assert!(
            comfort_share <= T10_COMFORT_SHARE_LIMIT,
            "④ 判据不成立：合计编辑 {edits_per_sec:.1} 次/秒 ＝ 舒适上界的 {:.1}%（上限 {}%）",
            comfort_share * 100.0,
            T10_COMFORT_SHARE_LIMIT * 100.0
        );
    }

    // ══════════════════ ⭐⭐ U8：一个窗口服务多空间（T6） ══════════════════

    /// ⭐ 2026-10-23（S3a）：**一个打不开的空间不许把整扇门按死**。
    ///
    /// 现场（2026-10-23 真机，逐字）：保险柜加密且**未解锁** ⇒ 连报 5 次
    /// 「绑定 0.0.0.0:8788 的窗口起不来（它名下这些空间这一轮都不宣告）」，而同绑定的明文空间
    /// **一个都同步不了**，界面只会说「附近发现 0 台」。⇒ 口径：能开的先服务；打不开的**如实不宣告**
    /// （`window_serves` 就是给公告那一侧核对的那把尺 —— 不核对就会把没服务上的也播出去 ✓）。
    ///
    /// ⚠️ 本判据独占注册表里 `127.0.0.1:00000` 这个键（与上面那条同一条纪律：别的判据不碰它 ✓）。
    #[test]
    fn a_space_that_cannot_open_does_not_take_the_whole_window_down() {
        let dir = temp_dir("s3a-partial-open");
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        {
            crate::db::open_space_conn_at("sp-good", &dir).unwrap();
        }
        // 坏的那个：库路径上放一个**目录** ⇒ sqlite 开不了（与"锁着的密文库"同一档：都是"开不了"）
        std::fs::create_dir_all(crate::db::spaces_dir(&dir).join("sp-bad.db")).unwrap();
        let bind = "127.0.0.1:00000";
        let spaces = vec![
            ("sp-bad".to_string(), "proto-bad".to_string(), false),
            ("sp-good".to_string(), "proto-good".to_string(), false),
        ];
        let addr = ensure_window(&spaces, "dev-me", bind, &dir)
            .expect("能开的那个必须把门开起来（⛔ 不许因为一个打不开的空间整扇门不起）")
            .expect("端口 0 也应当拿到真实地址");
        assert!(addr.port() > 0);
        assert!(window_serves(bind, "proto-good"), "能开的空间必须真的在服务");
        assert!(
            !window_serves(bind, "proto-bad"),
            "打不开的空间⛔ 不许被算成在服务（否则公告就是假话）"
        );
        // 收干净：这门注册在全局表里（键＝绑定串），别的判据不能被它影响
        let _ = stop_window("proto-good");
    }

    /// ⭐⭐ **矩阵 U8-①：三个空间 ⇒ 一个端口** ＋ **U8-②：每空间独立、不串** ＋
    /// **T6「关掉一个空间不许关掉整窗」** —— 三条挤在一条判据里，因为它们是**同一个形状**的三面 ✓。
    ///
    /// ⚠️ **这条判据独占注册表里 `127.0.0.1:0` 这个键**（`WINDOWS` 是进程级、键＝绑定字符串 ✓）——
    /// 同进程里别的判据都用 `open_window_at`（⛔ 不进注册表 ✗）⇒ 不打架 ✓；跑完它自己清干净 ✓。
    ///
    /// **变异**：把 `WINDOWS` 退回「每个空间一扇门」（键改回空间 ✓）⇒ ① 立刻红 ✓。
    #[tokio::test]
    async fn three_spaces_share_one_window_and_stopping_one_leaves_the_others_reachable() {
        let dir = temp_dir("mesh-u8-one-port");
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        // 三个空间各一份库 ＋ 各写一条**只有自己**的记录
        //   ⚠️ 本地库名（`s1`…）与对暗号的空间 id（`proto-1`…）**故意不同名** ✓（真机形状 ✓）
        for i in 1..=3 {
            let db_name = format!("s{i}");
            let c = crate::db::open_space_conn_at(&db_name, &dir).unwrap();
            c.execute_batch("CREATE TABLE IF NOT EXISTS meta.sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
                .unwrap();
            crate::sync::set_meta_state(&c, "device_id", "A").unwrap();
            let slug = format!("only-in-s{i}");
            let mut pg = page(&slug, &format!("只属于空间 {db_name} 的内容"), 1_000);
            pg.workspace_id = db_name.clone();
            local_edit(&c, &pg);
        }
        let pairs: Vec<(String, String)> = (1..=3).map(|i| (format!("s{i}"), format!("proto-{i}"))).collect();

        // ① ⭐⭐ **每个空间各调一次 `ensure_window` ⇒ 三次都落在同一个 `SocketAddr`**
        //    ⚠️ **必须「每次一个空间」**（就像旧的 `lan_state` 逐空间调那样 ✓）——
        //    一开始我写成「一次把三个传进去」，于是「按空间键」和「按绑定键」**结果一样** ⇒
        //    变异（退回每空间一扇门）**照样绿** ✗ ⇒ 判据自己把缺口糊住了 ✓（实测踩到，改掉 ✓）。
        // ⭐ **U11（2026-10-02，门只认卡）**：先按**生产路径**（`db::pair_device` ✓）登记一张卡
        //   ⇒ 判据因此**顺带覆盖**了「登记过的卡真的进得去」✓（而不只是手塞内存表 ✓）。
        {
            let meta = crate::db::open_meta_conn_at(&dir).unwrap();
            for i in 1..=3 {
                crate::db::pair_device(&meta, &format!("proto-{i}"), "me", "lan-token").unwrap();
            }
        }
        let mut addrs = Vec::new();
        for (db, proto) in &pairs {
            let one = [(db.clone(), proto.clone(), false)];
            addrs.push(
                ensure_window(&one, "A", "127.0.0.1:0", &dir)
                    .unwrap()
                    .expect("配了地址就该开起来"),
            );
        }
        assert!(
            addrs.iter().all(|a| *a == addrs[0]),
            "三个空间**分三次**调也必须落在一个端口上（矩阵 U8-① 的正题）：{addrs:?}"
        );
        let a1 = addrs[0];

        // ② **每空间各自拉得到自己的那份**（互不影响 ✓），且**拉不到别人的**（不许串 ✓）
        for i in 1..=3 {
            let (code, body) = http_get(a1, &format!("/mesh/pull?space_id=proto-{i}&since=0&limit=100"), Some("lan-token"));
            assert_eq!(code, 200, "空间 {i} 应当拉得到：{body}");
            assert!(body.contains(&format!("only-in-s{i}")), "空间 {i} 的记录没回来：{body}");
            for j in 1..=3 {
                if i != j {
                    assert!(
                        !body.contains(&format!("only-in-s{j}")),
                        "⛔ 串空间：问 proto-{i} 却拿到了空间 {j} 的记录：{body}"
                    );
                }
            }
        }

        // ③ ⭐ **关掉一个空间 ⇒ 门还在，另外两个照样能拉**（T6：不许关掉整扇门 ✓）
        stop_window("proto-2").unwrap();
        assert_eq!(window_addr("proto-1"), Some(a1), "关掉 proto-2 不许把整扇门也关了");
        assert_eq!(window_addr("proto-2"), None, "proto-2 应当已经摘掉了");
        for i in [1, 3] {
            let (code, _) = http_get(a1, &format!("/mesh/pull?space_id=proto-{i}&since=0&limit=100"), Some("lan-token"));
            assert_eq!(code, 200, "剩下那两个必须照常收敛 ✓");
        }
        // ⭐ 而**被摘掉的那个**再问就是 403（白名单是**当前**范围，不是历史 ✓）
        let (code, body) = http_get(a1, "/mesh/pull?space_id=proto-2&since=0&limit=100", Some("lan-token"));
        assert_eq!(code, 403, "摘掉之后就不在服务范围里了：{body}");

        // ④ 三个都摘掉 ⇒ **整扇门才真关** ✓（不然端口一直听着）
        stop_window("proto-1").unwrap();
        stop_window("proto-3").unwrap();
        assert_eq!(window_addr("proto-1"), None, "最后一个空间也走了 ⇒ 门应当关掉");
        assert_eq!(window_addr("proto-3"), None);
    }

    /// ⭐⭐ **U11/T5：逐台解除** —— 三条挤在一条判据里（T5 的 ①②③ ✓），
    /// 因为它们量的是**同一件事的三面**：只踢那一台 ✓、别人照常 ✓、**库里只有哈希** ✓。
    ///
    /// ⚠️ **这条判据只能这么测**（不能只测 `unpair_device` 那个纯函数 ✗）：
    ///   真正会出错的形状是「**库里删了、但正在跑的窗口还认着那张卡**」✗
    ///   ⇒ 用户看到的是「**删了等于没删**」✓ —— 那正是 T5 判据② 要挡的旧办法（"换窗口口令"）的同类 ✓。
    ///
    /// **变异**：① 把 `forget_paired(...)` 那一步去掉（只删库）⇒ **本判据必须红** ✓
    ///          ② 把 `db::pair_device` 改成**存明文** ⇒ ③ 那段必须红 ✓
    #[tokio::test]
    async fn unpairing_one_device_only_stops_that_device() {
        let dir = temp_dir("mesh-u11-unpair");
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        {
            let c = crate::db::open_space_conn_at("default", &dir).unwrap();
            c.execute_batch("CREATE TABLE IF NOT EXISTS meta.sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
                .unwrap();
            crate::sync::set_meta_state(&c, "device_id", "A").unwrap();
            let mut pg = page("p1", "本机写的一版", 1_000);
            pg.workspace_id = "default".to_string();
            local_edit(&c, &pg);
        }
        // ① 两台设备各配一张卡（走**生产路径** ✓ —— 判据因此也覆盖"配对真的登记进库"✓）
        let secret_b = "sec-B-2f9a1c";
        let secret_c = "sec-C-7d3e50";
        {
            let meta = crate::db::open_meta_conn_at(&dir).unwrap();
            crate::db::pair_device(&meta, "proto-x", "dev-B", secret_b).unwrap();
            crate::db::pair_device(&meta, "proto-x", "dev-C", secret_c).unwrap();
            // ③ **只存哈希**：库里那一格**不是明文** ✓
            let stored: String = meta
                .query_row(
                    "SELECT secret_sha256 FROM mesh_paired_devices WHERE space_id='proto-x' AND device_id='dev-B'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_ne!(stored, secret_b, "⛔ 库里存了**明文**（U11-③ 要挡的正是这个 ✗）");
            assert_eq!(stored, crate::db::sha256_hex(secret_b), "存的应当是 sha256 ✓");
            assert_eq!(stored.len(), 64, "形状就是 64 位十六进制 ✓");
        }
        // 窗口：⭐ **必须走 `ensure_window`**（会进**进程级注册表** ✓）——
        //   ⚠️ `open_window_at` 开的是**不进注册表**的独立门 ✗ ⇒ `forget_paired` 扫不到它
        //   ⇒ 卡摘不掉 ⇒ "删了等于没删" ✓ **实测踩到过**（本判据第一版就是这么红的 ✓）。
        //   ⚠️ 绑定写法要与 U8 判据**不同键**（注册表键＝绑定字符串 ✓）：它用 `127.0.0.1:0`，
        //   这里用 `localhost:0` ⇒ 两条判据不会互相串 ✓。
        let pairs = [("default".to_string(), "proto-x".to_string(), false)];
        let addr = ensure_window(&pairs, "A", "localhost:0", &dir)
            .unwrap()
            .expect("窗口应当起得来");
        let pull = |r: &'static str| format!("/mesh/pull?space_id=proto-x&since=0&limit=100&who={r}");

        // ② 两台都进得来（基线 ✓ —— 别把"谁都进不来"当成"撤销成功" ✗）
        for sec in [secret_b, secret_c] {
            let (code, body) = http_get(addr, &pull("x"), Some(sec));
            assert_eq!(code, 200, "配过对的卡应当进得来：{body}");
            assert!(body.contains("p1"), "而且要真拉到东西：{body}");
        }

        // ① **只踢 dev-B**：库里删那一行 ＋ ⭐ 把它的卡**从正在跑的窗口里也摘掉** ✓
        let hash = {
            let meta = crate::db::open_meta_conn_at(&dir).unwrap();
            let h = crate::db::unpair_device(&meta, "proto-x", "dev-B").unwrap();
            assert!(h.is_some(), "解除前它应当在名单里 ✓");
            h.unwrap()
        };
        crate::mesh::forget_paired("proto-x", &hash).unwrap();

        let (code, body) = http_get(addr, &pull("x"), Some(secret_b));
        assert_eq!(code, 401, "被解除的那台**必须被拒**（不是 200 ✗）：{body}");
        // ② ⭐ **别的那台照常** —— 这一条才是"逐台"的意思 ✓
        //    ⚠️ 变异（把撤销做成"换窗口口令"／或只删库不摘卡）⇒ 上面那条仍会绿 ✗，而**这条会红** ✓
        let (code, body) = http_get(addr, &pull("y"), Some(secret_c));
        assert_eq!(code, 200, "**别的设备不受影响**（这才是逐台解除 ✓）：{body}");
        assert!(body.contains("p1"), "它还要真拉得到：{body}");
        // ⭐ 而且**不必给所有设备换口令** ✓ —— dev-C 用的还是它原来那一份 ✓

        crate::mesh::stop_window("proto-x").unwrap();
    }

    /// ⭐⭐ **R109 缺的那一环：U11 的端到端判据** ——
    /// **先开一扇门（一台都没认）⇒ 走一次「采纳配对」⇒ 门**没有重启**也必须立刻认这一台（200 ✓）
    /// ⇒ 再 `unpair_device` ＋ `forget_paired` ⇒ 立刻 401** ✓。
    ///
    /// ⚠️ **为什么非要这一条**（R109 的洞就是这么活下来的 ✓）：既有那批判据里
    /// **Rust 的几条是直接调 `db::pair_device` 登记的** ✓、**前端几条是文本级**的 ✓
    /// ⇒ **没有一条走「真配对」** ✗ ⇒ 生产路径上"登记卡"这一步**根本没人做**
    ///（`db::pair_device` 只出现在测试里 ✗）也照样全绿 ✓ —— ⛔ **判据绿 ≠ 功能通** ✓。
    ///
    /// ⚠️ 门**必须走 `ensure_window`**（进**进程级注册表** ✓ —— `add_paired`／`forget_paired`
    /// 扫的就是注册表 ✓）；用 `open_window_at` 那种"独立门"会让本判据变成**自欺** ✗
    /// （摘不到、加不上，却看不出 ✓ —— 上一条判据的第一版就是这么红的 ✓）。
    ///
    /// **变异**（两条，都实测过 ⇒ 见提交信息）：
    ///   ① 把 `sync::apply_device_pair_import` 里那句 `mesh::add_paired(...)` 去掉（＝只写库）
    ///      ⇒ ③ 那一格**必须红**（会看到 401 而不是 200 ✓）；
    ///   ② 把它的连接换成 `db::open_meta_conn_at`（**裸 meta**）⇒ `set_pair_secret` 那一步
    ///      以 `no such table: meta.sync_state` **当场崩** ⇒ 也红 ✓（＝ R109 的根因那一格 ✓）。
    #[tokio::test]
    async fn adopting_a_pairing_makes_the_running_door_recognise_it_at_once() {
        let dir = temp_dir("mesh-u11-e2e-adopt");
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        // meta 的表先建起来（`meta_migrate` 只在 `open_meta_conn_at` / `init` 里跑 ✓）
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        // ⭐ **生产形状的连接**（`db.0` 就是它：空间库当 `main` ＋ `ATTACH meta.db AS meta` ✓）——
        //   ⛔ 这条判据**故意**用它而不是 `open_meta_conn_at` ✗（后者是裸 meta ⇒ `meta.`
        //   限定名解析不动 ⇒ 采纳那一步会当场崩 ✓；那条边界由
        //   `sync::tests::the_two_connection_shapes_are_not_interchangeable` 单独钉 ✓）。
        let c = crate::db::open_space_conn_at("default", &dir).unwrap();
        crate::sync::set_meta_state(&c, "device_id", "A").unwrap();
        let mut pg = page("p1", "本机写的一版", 1_000);
        pg.workspace_id = "default".to_string();
        local_edit(&c, &pg);

        // ① **先开一扇门**，门里**一张卡都没有** ✓
        //    ⚠️ 空间 id 用 `proto-e2e`（与另两条判据的 `proto-1…`／`proto-x` **不同** ✓）——
        //    `add_paired`／`forget_paired`／`stop_window` 都按"服务哪个空间"扫注册表 ⇒
        //    两条判据若共用同一个空间 id，会**互相摘对方的卡** ✗（HashMap 遍历顺序不定 ⇒ flaky ✓）。
        //    ⚠️ 绑定键同理要与它们不同（注册表键＝绑定字符串 ✓）：U8 用 `127.0.0.1:0`、
        //    U11 用 `localhost:0` ⇒ 这条用 `0.0.0.0:0` ✓；**连的时候换成回环**（0.0.0.0 不是
        //    可连接的地址 —— 与 `config_state` 那条口径同源 ✓）。
        let pairs = [("default".to_string(), "proto-e2e".to_string(), false)];
        let bound = ensure_window(&pairs, "A", "0.0.0.0:0", &dir).unwrap().expect("窗口应当起得来");
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, bound.port()));
        let secret = "k7Qm-2pRt-e2e";
        let pull = "/mesh/pull?space_id=proto-e2e&since=0&limit=100";
        let (code, body) = http_get(addr, pull, Some(secret));
        assert_eq!(code, 401, "基线：门里零张卡 ⇒ 谁来都得 401（不然这条判据分不出东西）：{body}");

        // ② ⭐ **走真采纳**：真载荷 → 真判定 → **生产同一个落库内核** ✓（门**先开着**、**不重启** ✓）
        //   ⭐ 2026-10-12（1C）：载荷**必须带对方的公钥** ✗（不带 ⇒ 解码那一步就**如实拒** ✓）。
        //   ⚠️ 夹具**借门这台自己的钥匙冒充 dev-B** ✓（门只按 `device_id` 查公钥 ✓ ⇒
        //     这一格量的是"**登记 → 验签放行**"那条链 ✓，⛔ 不是量钥匙归属 ✗）。
        let id_peer = crate::device_key::load_or_create(&c).unwrap();
        let mut payload = crate::pairing::device_pair_from("0.0.0.0:8788", secret, "dev-B", "").unwrap();
        crate::pairing::stamp_pubkey(&mut payload, &id_peer.public_key_hex()).unwrap();
        let text = crate::pairing::encode_device_pair(&payload).unwrap();
        let decision =
            crate::sync::decide_device_pair_import(&text, Some(&crate::pairing::check_code(&text)), "A").unwrap();
        let crate::sync::DevicePairDecision::Accept { peer_device_id, bind, token, .. } = decision else {
            panic!("核对过就该 Accept：{decision:?}")
        };
        assert_eq!(peer_device_id, "dev-B", "对面设备号来自载荷 ✓");
        // ⭐ 2026-10-12（1C）：⭐ 采纳还要交**对面那把公钥** ✗（它来自载荷 ✓）——
        //   ⚠️ 夹具用的就是**上面那把**（⭐ 借门这台自己的钥匙冒充 dev-B ✓，理由见 ② ✓），⛔ 不另凑一个 ✗。
        let added = crate::sync::apply_device_pair_import(
            &c,
            "proto-e2e",
            &peer_device_id,
            &bind,
            &token,
            false,
            &id_peer.public_key_hex(),
        )
        .unwrap();
        assert!(added, "门正开着 ⇒ 新卡必须**当场**加进那扇门（否则就是「配对成功却 401」✓）");

        // ③ ⭐⭐ **门没有重启也必须立刻认这一台** ⇒ 200 ✓（R109 的洞就在这一格）
        let (code, body) = http_get(addr, pull, Some(secret));
        assert_eq!(code, 200, "配好对之后**不许重启门**就该进得来：{body}");
        assert!(body.contains("p1"), "而且要真拉到东西：{body}");
        // ③-b ⭐⭐ **2026-10-12（1C）**：⭐ 采纳登记的**公钥**也要**当场**生效 ✗ ——
        //   ⭐ 这一台此后**凭签名**（⛔ 不带任何口令 ✗）就得进得来 ✓（那正是取代口令的那条路 ✓）。
        let (ts, sig) =
            crate::mesh::sign_request(&c, "dev-B", "proto-e2e", "GET", pull, crate::db::now_ms()).unwrap();
        let (code, body) = http_get_signed(addr, pull, "dev-B", ts, &sig);
        assert_eq!(
            code, 200,
            "⛔ 采纳之后这一台**凭签名**必须进得来 ✗（⭐ 而且一个口令都不带 ✓ —— 1C 之后门认的就是这个 ✓）：{body}"
        );
        // ⭐「本机要出示给那一台」的那一份也存好了（`round_candidates` 读的就是它 ✓）
        assert_eq!(
            crate::mesh::pair_secret_for(&c, "proto-e2e", "dev-B").as_deref(),
            Some(secret),
            "本机要出示的那份秘密必须落在**对面设备号**名下（否则出示不出来 ⇒ 对端 401 ✓）"
        );
        // ⭐ 而库里那张卡**只存哈希**（明文只在本机"我要出示"的那一侧 ✓）
        let hashes = crate::db::paired_secret_hashes(&c, "proto-e2e").unwrap();
        assert!(hashes.contains(&crate::db::sha256_hex(secret)), "库里要有 sha256：{hashes:?}");
        assert!(!hashes.iter().any(|h| h == secret), "⛔ 库里不许存明文 ✗");

        // ④ **逐台解除**：`unpair_device`（删库）＋ `forget_paired`（**门里也摘** ✓）⇒ **立刻 401** ✓
        let h = crate::db::unpair_device(&c, "proto-e2e", "dev-B").unwrap();
        assert!(h.is_some(), "解除前它应当在名单里 ✓");
        crate::mesh::forget_paired("proto-e2e", h.as_deref().unwrap()).unwrap();
        let (code, body) = http_get(addr, pull, Some(secret));
        assert_eq!(code, 401, "被解除之后必须**立刻** 401（同样不许重启门）：{body}");

        crate::mesh::stop_window("proto-e2e").unwrap();
    }

    /// ⭐⭐ **2026-10-11（丙）判据⑤：个人档配对出来的卡，门真的要放行** ✗。
    ///
    /// ## 张力就在"两把键不是一回事"这一点上
    /// 卡片落 ⭐ **空串那一行** ✗（`paired_row_key` ✓），而门服务的是 ⭐ **配对暗号** ✗
    /// （`?space_id=room-…` ✓）⇒ ⭐ 门必须去**那一行**载卡 ✓。
    /// ⛔ 少了这一步，现象就是「**配对显示成功、对端照样 401**」✗（本仓栽过的那一族 ✓）。
    ///
    /// **红读数（真变异）**：把 `load_cards` 里那把键换回 `proto_space`
    /// （＝还按"门服务的空间"读库 ✗）⇒ 本判据**红**（401）✓。
    #[tokio::test]
    async fn a_personal_pairing_is_accepted_by_the_door_that_serves_the_room() {
        let dir = temp_dir("mesh-device-level-door");
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        let c = crate::db::open_space_conn_at("default", &dir).unwrap();
        crate::sync::set_meta_state(&c, "device_id", "dev-me").unwrap();
        // ⭐ 个人档：门服务的那个空间是**配对暗号** ✗（⛔ 不是空串 ✓）。
        let room = "room-personal-1";
        let secret = "k7Qm-2pRt-dev1";
        // ⭐ 2026-10-12（1C）：⭐ 登记**必须有公钥** ✗（`remember_peer_card` 收进一处 ✓）——
        //   ⚠️ 夹具这里给的是**假钥匙** ✓（本条量的是"个人档落同一行"✓，⛔ 不是量那把钥匙 ✓）；
        //   ⭐ 门那一档删除之后，本判据要换成**真钥匙 ＋ 签名请求** ✓（方案 §8.6 的作业单 ✓）。
        crate::sync::remember_peer_card(&c, room, "dev-peer", secret, true, &"ab".repeat(32)).unwrap();
        // 前提：卡片确实落在**空串那一行** ✓（按口径读得到 ✓）
        assert_eq!(
            crate::mesh::paired_devices(&c, room, true).unwrap().len(),
            1,
            "前提：个人档的卡要落在设备级那一行（不然这条判据量的不是它）"
        );
        // ⭐ 门：服务 `room` ✓、按**个人档**载卡（`device_level = true` ✓）。
        let pairs = [("default".to_string(), room.to_string(), true)];
        let bound = ensure_window(&pairs, "dev-me", "0.0.0.0:00", &dir)
            .unwrap()
            .expect("窗口应当起得来");
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, bound.port()));
        let pull = format!("/mesh/pull?space_id={room}&since=0&limit=10");
        let (code, body) = http_get(addr, &pull, Some(secret));
        assert_eq!(
            code, 200,
            "⛔ 个人档配对出来的卡，门必须放行 ✗ —— 否则就是「配对成功、对端照样 401」：{body}"
        );
        // ⛔ 反面：另一串没登记过的秘密仍然进不来（别把"谁都放行"当成通过 ✗）
        let (code, _) = http_get(addr, &pull, Some("not-the-secret"));
        assert_eq!(code, 401, "⛔ 没登记过的秘密不许进 ✗（不是「谁都放行」✓）");

        crate::mesh::stop_window(room).unwrap();
    }

    /// ⭐⭐ **2026-10-12（设备身份第 2 步）判据**：⭐ 门认的是**那一台的签名**，而不是"谁知道口令" ✗。
    ///
    /// 链条一次走全（⭐ 本仓的手法：端到端比"只测纯函数"值钱 ✓）：
    /// ⭐ 库里登记公钥（`db::pair_pubkey` ✓，第 3 步点信任时会做的那件事）⇒ ⭐ `load_cards` 载进内存 ✓
    /// ⇒ ⭐ 门**验签**放行 ✓。
    #[tokio::test]
    async fn a_signed_request_is_let_in_by_the_public_key_it_was_trusted_with() {
        let dir = temp_dir("mesh-sig-door");
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        let c = crate::db::open_space_conn_at("default", &dir).unwrap();
        crate::sync::set_meta_state(&c, "device_id", "dev-peer").unwrap();
        let id = crate::device_key::load_or_create(&c).expect("本机身份");
        let space = "room-sig-1";
        // ⭐ 门那一侧：把**这一台**的公钥登记进这个空间（＝ 第 3 步"允许它来拿我的"那一下 ✓）。
        //   ⚠️⭐ **行键是空串** ✗ —— 个人档的对端表走**设备级那一行** ✓（丙 那套口径 ✓，
        //   与 `remember_peer_card` 用 `paired_row_key` 算出来的**同一把键** ✓）。
        //   ⭐ 夹具写错行键时本判据当场红过 ✓（门只会去读 `''` ⇒ 报"没登记过它的公钥"✓）。
        crate::db::pair_pubkey(&c, "", "dev-peer", &id.public_key_hex()).unwrap();
        // 门：服务 `space` ✓、按**个人档**载卡（⭐ 库里那一行会被载进内存 ✓）
        //   ⚠️⭐ **绑定键必须与别的判据不同** ✗：注册表的键**就是绑定字符串** ✓
        //   ⇒ 撞键 ＝ 两条判据**共用一扇门**（⭐ 而门只认**第一个**开起来的那个库目录 ✓）
        //   ⇒ 症状是"200 但一条记录都没有" ✓（⭐ 实测踩到过：与 R109 那条共用 `0.0.0.0:0` ✓）。
        let pairs = [("default".to_string(), space.to_string(), true)];
        let bound = ensure_window(&pairs, "dev-me", "0.0.0.0:000", &dir).unwrap().expect("窗口应当起得来");
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, bound.port()));
        let target = format!("/mesh/pull?space_id={space}&since=0&limit=10");
        let now = crate::db::now_ms();
        let (ts, sig) =
            crate::mesh::sign_request(&c, "dev-peer", space, "GET", &target, now).expect("签一份");

        // ① ⭐ **一个口令都不带** ⇒ 也必须放行 ✓（⭐ 这就是"门认的是签名" ✓）
        let (code, body) = http_get_signed(addr, &target, "dev-peer", ts, &sig);
        assert_eq!(
            code, 200,
            "⛔ 登记过公钥 ⇒ 这一台签的请求必须放行 ✗（⭐ 而且不必再出示共用口令 ✓）：{body}"
        );

        // ② ⛔ 签名改一个字节 ⇒ 不许过（⭐ 这一档**没有口令可退** ⇒ 必然 401 ✓）
        let mut bad = sig.clone();
        bad.replace_range(0..2, if sig.starts_with("00") { "11" } else { "00" });
        let (code, _) = http_get_signed(addr, &target, "dev-peer", ts, &bad);
        assert_eq!(code, 401, "⛔ 签名被改过 ⇒ 必须 401 ✗");

        // ③ ⛔ 签名绑在**这一条请求**上 ⇒ 换一条 target 不许过 ✓
        let other = format!("/mesh/pull?space_id={space}&since=5&limit=10");
        let (code, _) = http_get_signed(addr, &other, "dev-peer", ts, &sig);
        assert_eq!(code, 401, "⛔ 签名绑在「这一条请求」上 ✗（换 target 不许过 ✓）");

        // ④ ⛔ 过期的时间戳 ⇒ 不许过（⭐ "旧包重放"那一条 ✓）
        let stale_ts = now - AUTH_WINDOW_MS - 1;
        let stale = crate::mesh::sign_request(&c, "dev-peer", space, "GET", &target, stale_ts).unwrap();
        let (code, _) = http_get_signed(addr, &target, "dev-peer", stale.0, &stale.1);
        assert_eq!(code, 401, "⛔ 过期签名不许过 ✗（窗口 {} ms）", AUTH_WINDOW_MS);

        // ⑤ ⛔ **没登记过的那一台**签的 ⇒ 不许过（⭐ 换个 device_id 就用同一把钥匙签 ✓）
        let ghost = crate::mesh::sign_request(&c, "dev-ghost", space, "GET", &target, now).unwrap();
        let (code, _) = http_get_signed(addr, &target, "dev-ghost", ghost.0, &ghost.1);
        assert_eq!(code, 401, "⛔ 这个空间里没登记过它的公钥 ⇒ 不许过 ✗");

        // ⑥ ⭐⭐ **出站那一侧**（`pull_from_peer` 自己拼的 target ✓）也必须过 ✗ ——
        //    ⭐ 这条判据钉的是「⭐ 签的那串」与「⭐ 门重建的那串」**逐字相同** ✓：
        //    ⛔ 两处各拼一份 URL ⇒ 一漂就 401，而"只测纯函数"照不出来 ✓。
        let peer = MeshPeer { device_id: "dev-me".to_string(), base: format!("http://{addr}") };
        let out_target = crate::mesh::pull_target(space, 0, "");
        let (ts2, sig2) = crate::mesh::sign_request(&c, "dev-peer", space, "GET", &out_target, now)
            .expect("签一份");
        let rows = crate::mesh::pull_from_peer(
            &reqwest::Client::new(),
            &peer,
            space,
            0,
            None,
            Some(("dev-peer", ts2, &sig2)),
            "",
        )
        .await
        .expect("⭐ 出站签名的 target 必须与门重建的那一串逐字相同（差一个字符就是 401）");
        // ⭐ 2026-10-20：返回形状从 Vec 变成 (Vec, max_device_seq)
        assert!(rows.0.is_empty(), "这个空间里还没有记录 ⇒ 拉回来是空的一批 ✓（但**放行了** ✓）");

        // ⑦ ⭐⭐ **撤回必须真的生效** ✗（⭐ 走**生产那一半**：`sync::device_unpair_at` ✓）——
        //    ⚠️ 这一条是上一轮查出来的那个洞（"库里删了、**跑着的门**还认"✓）在新那一档上的对照组 ✓：
        //    ⭐ 同一个签名**立刻**就该 401 ✓（⛔ 不必重启门 ✗）。
        // ⚠️ 夹具**不许**用 `INSERT OR IGNORE` ✗：`workspaces` 有 NOT NULL 且**无默认**的列
        //   （`created_at` / `updated_at` ✓）⇒ 少给一列会被它**静默吞掉** ✓
        //   （实测踩到：夹具没插进去 ⇒ 报出来的是"没有同步档案"这种**误导**的话 ✓）⇒ ⭐ 一律大声失败 ✓。
        c.execute_batch(
            "INSERT INTO meta.workspaces (id, name, created_at, updated_at) VALUES ('ws-sig', '个人', 0, 0);
             INSERT INTO meta.sync_profiles (ws_id, space_id, mesh_room) VALUES ('ws-sig', '', 'room-sig-1');",
        )
        .unwrap();
        let st = crate::sync::device_unpair_at(&c, Some("ws-sig"), "dev-peer").expect("撤回不许报错");
        assert!(st.was_paired, "它本来在名单里（不然这条判据量的是空气）");
        let (code, _) = http_get_signed(addr, &target, "dev-peer", ts, &sig);
        assert_eq!(
            code, 401,
            "⛔ 撤回之后**同一个签名必须立刻不认** ✗（⭐ 库里删了 ＋ ⭐ 跑着的门里也摘掉 ✓ —— 缺一件就是'删了等于没删' ✓）"
        );

        crate::mesh::stop_window(space).unwrap();
    }

    // ────── ⭐ P0 片②③（设备直连 · 信任链与门禁）：先在 **lib 层**把链做实 ──────
    //
    // ⚠️ **命令层未验（需真宿主）** ✗：`mesh_trust_begin`／`mesh_trust_state` 是 `tauri::State`
    //    命令（`lib.rs:844/848` ✓）⇒ lib 单测起不了宿主 ✗ ⇒ 按 Lead 2026-10-13 拍的口径，
    //    本片**只钉**「纯函数 `mesh_trust::trust_state_view` ＋ 内核 `pairing_trust::TrustHandshake`」
    //    这一层 ✓；命令层那一段**如实挂账**（真宿主／P5 真机片 ✗）。

    /// ★ 判据 P0-②：信任链的**读数**沿真内核从 `idle` 走到 `trusted` ✓，且每档的人话对得上 ✓。
    ///
    /// ⚠️ 与 P1／P3 的关系：这条钉的是**状态机与投影**（⛔ 不是"名单里认了谁"✗ —— 那是 `mesh.rs` 的
    /// `paired_devices` 那条 ✓）；改坏了 ⇒ 界面会**说错走到哪一步**（`SyncSettingsPane` 读它 ✓）。
    #[test]
    fn p0_trust_state_view_moves_from_idle_to_trusted_along_the_real_handshake_kernel() {
        use crate::pairing_trust::TrustHandshake;
        let now = 1_000i64;
        let ttl = 60_000i64;

        // ① 一开始：idle ＋ 没有任何进行中的握手（兜底那档也要说"下一步做什么" ✓）
        let mut h = TrustHandshake::default();
        let v0 = crate::mesh_trust::trust_state_view(h.state(), h.is_active(now), h.pending_asks(now).len());
        assert_eq!(v0.state, "idle", "默认必须是 idle");
        assert!(!v0.active, "默认没有进行中的握手");
        assert_eq!(v0.pending, 0, "默认没有等采纳的条目");
        assert!(!v0.message.trim().is_empty(), "兜底那档也要给出下一步");

        // ② 对面来问（`note_ask`）⇒ 甲 之下**看到就是采纳** ⇒ 直接 trusted ＋ 有一条等采纳
        h.note_ask("dev-peer", now, ttl);
        let v1 = crate::mesh_trust::trust_state_view(h.state(), h.is_active(now), h.pending_asks(now).len());
        assert_eq!(v1.state, "trusted", "甲：看到对方的「想信任」就是采纳（不再等本机的人点）");
        assert!(v1.active, "这一秒还有进行中的握手");
        assert_eq!(v1.pending, 1, "有一条正等着被采纳");

        // ③ 本机自己点（`begin`）⇒ 同样 trusted；且**点的一方没有"等采纳"条目** ✓
        let mut h2 = TrustHandshake::default();
        h2.begin("dev-peer", "ask-1", now, ttl);
        let v2 = crate::mesh_trust::trust_state_view(h2.state(), h2.is_active(now), h2.pending_asks(now).len());
        assert_eq!(v2.state, "trusted", "点一下就是 trusted");
        assert_eq!(v2.pending, 0, "发问的一方没有「等采纳」的条目");
        // ④ 过期之后 active 必须变假（过期的不算 ✓）
        let later = now + ttl + 1;
        let v3 = crate::mesh_trust::trust_state_view(h2.state(), h2.is_active(later), h2.pending_asks(later).len());
        assert!(!v3.active, "过期的不算 active");
        assert_eq!(v3.pending, 0, "过期的等采纳条目不许再报");
    }

    /// ★ 判据 P0-③：**没被允许过的第三台进不来** —— 登记名单里只有被信任的那一台 ✓。
    ///
    /// ⚠️ **这是"锁"，不是"修"** ✗：⭐ **新加即绿** ✓ —— 同一条不变量在**门那一层**已有真判据：
    /// `one_sided_trust_opens_one_direction_only` 里的 `dev-c` 那段（真 HTTP ＋ 真签名 ⇒ `ghost.is_err()` ✓）。
    /// 本判据只把**名单这一格**单独钉住 ✗：门读的就是它（`mesh.rs` 的
    /// `crate::db::paired_pubkeys(&meta, row)` ✓）⇒ 名单里没有它，门就不可能认它 ✓。
    #[test]
    fn p0_a_third_device_never_enters_the_paired_pubkey_registry() {
        let dir = temp_dir("p0-third-device");
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        let meta = crate::db::open_meta_conn_at(&dir).unwrap();
        let space = "sp-third";
        // 只登记被信任的那一台（＝ A 点了「允许 B 来拿」）
        crate::db::pair_pubkey(&meta, space, "dev-b", "bbbb").unwrap();
        let listed = crate::db::paired_pubkeys(&meta, space).unwrap();
        assert!(
            listed.iter().any(|(d, _)| d == "dev-b"),
            "被信任的那台必须在名单里：{listed:?}"
        );
        assert!(
            !listed.iter().any(|(d, _)| d == "dev-c"),
            "⛔ 没被允许过的第三台不许进名单（门只认这份名单）：{listed:?}"
        );
    }

    /// ⭐⭐ **2026-10-17（owner 拍「一方配对成功，就双向通」）**：⭐ 一趟配对 ⇒ **两个方向都通** ✓。
    ///
    /// ## ⚠️ 本条**取代** 2026-10-12 那版（原话：「单方信任 ⇒ 同步是单向的」✗）
    /// owner 2026-10-12 逐字是「『信任这台设备』是『**允许它来拿我的**』」＋「单方信任时，同步就是单向的」✓；
    /// ⭐ **2026-10-17 owner 改口径**：「**一方配对成功，就双向通**」✓
    /// ⇒ ⭐ 发起侧点一次（登记对面 ✓）＋ 对面收到 ask 后**互相登记** ✓ ⇒ 两个方向都进得来 ✓。
    /// ⚠️ 真机来由：AMD 侧配对后拉本机**每一轮 401**（「这张卡不在名册里」✓）——
    ///    那正是"单方只开一个方向"的形状 ✓。
    #[tokio::test]
    async fn one_pairing_round_opens_both_directions() {
        let dir_a = temp_dir("trust-oneway-a");
        let dir_b = temp_dir("trust-oneway-b");
        for d in [&dir_a, &dir_b] {
            std::fs::create_dir_all(crate::db::spaces_dir(d)).unwrap();
            drop(crate::db::open_meta_conn_at(d).unwrap());
        }
        let ca = crate::db::open_space_conn_at("default", &dir_a).unwrap();
        let cb = crate::db::open_space_conn_at("default", &dir_b).unwrap();
        crate::sync::set_meta_state(&ca, "device_id", "dev-a").unwrap();
        crate::sync::set_meta_state(&cb, "device_id", "dev-b").unwrap();
        let ida = crate::device_key::load_or_create(&ca).unwrap();
        let idb = crate::device_key::load_or_create(&cb).unwrap();
        let space = "room-oneway";

        // ⭐ **A 点一次「信任这台设备」（对象 ＝ B）** ✗ —— ⭐ 生产的落点是 `pair_pubkey`
        //   ＋ `add_paired_pubkey` ✓；这里先只写库 ✓（⭐ 门在**下面才开** ⇒ 开门时载卡 ✓）。
        crate::db::pair_pubkey(&ca, "", "dev-b", &idb.public_key_hex()).unwrap();

        // ⚠️⚠️ **一次只开一扇门** ✗（本仓写过这条：`add_paired*` 是"按**服务哪个空间**找门、
        //   取**第一个**命中的" ✓ ⇒ 两扇门同时服务同一空间时，登记可能落进**另一扇门** ✓
        //   ⇒ 判据会"看起来全绿、其实什么都没证明"✗ —— R110 那条判据里记着同一个坑 ✓）。
        let near = |dev: &str, addr: SocketAddr| MeshPeer {
            device_id: dev.to_string(),
            base: format!("http://{addr}"),
        };
        let client = reqwest::Client::new();
        let sign = |c: &Connection, dev: &str| {
            let target = crate::mesh::pull_target(space, 0, "");
            let (ts, sig) =
                crate::mesh::sign_request(c, dev, space, "GET", &target, crate::db::now_ms()).unwrap();
            (ts, sig)
        };
        // ⚠️ 出站那一趟**不抽闭包** ✗：它要把 `client` ／ `space` 借进 `async` 块 ✓
        //   ⇒ 与后面那几处直用**借不开** ✓（实测：`value borrowed here after move` ✓）。

        // ─── ① 只有 A 的门开着（A 的库里已经有 B 的公钥 ✓）───
        let addr_a =
            ensure_window(&[("default".to_string(), space.to_string(), true)], "dev-a", "127.0.0.1:000", &dir_a)
                .unwrap()
                .expect("A 的门要起得来");
        // ⭐ **B 来拿 A 的** ⇒ 放行 ✓（⭐ A 允许了它 ✓ —— 这一条就是"单方"的那个方向 ✓）
        let (tb, sb) = sign(&cb, "dev-b");
        let ok = crate::mesh::pull_from_peer(
            &client,
            &near("dev-a", addr_a),
            space,
            0,
            None,
            Some(("dev-b", tb, &sb)),
            "",
        )
        .await;
        assert!(ok.is_ok(), "⛔ A 点了「允许 B 来拿」⇒ **B 必须进得来** ✗：{ok:?}");
        // ⛔ 没被允许过的第三台 ⇒ 进不来 ✓（⭐ 换个设备号用同一把钥匙签 ✓）
        let tgt = crate::mesh::pull_target(space, 0, "");
        let (tc, sc) =
            crate::mesh::sign_request(&ca, "dev-c", space, "GET", &tgt, crate::db::now_ms()).unwrap();
        let ghost = crate::mesh::pull_from_peer(
            &client,
            &near("dev-a", addr_a),
            space,
            0,
            None,
            Some(("dev-c", tc, &sc)),
            "",
        )
        .await;
        assert!(ghost.is_err(), "⛔ 没被允许过的那台不许进 ✗：{ghost:?}");
        // 关掉 A 的门（此刻只有它在服务这个空间 ⇒ 摘的就是它 ✓）
        stop_window(space).unwrap();

        // ─── ② ⭐ **B 收到 A 的「想信任」⇒ 这一侧也登记 A**（owner 2026-10-17：一方配对成功，就双向通 ✓）───
        //   ⚠️ 生产里这一步是 `sync::note_pending_trust_asks` 做的 ✓（这里直接落那两行，等价 ✓）——
        //   ⛔ 不再是"B 也点一次"✗：那一侧**不用人再点** ✓。
        crate::db::pair_pubkey(&cb, "", "dev-a", &ida.public_key_hex()).unwrap();
        // ⭐ 跑着的门**也要认它** ✗ —— ⛔ 只写库不算 ✗（那正是"配对成功却 401" ✓）
        crate::mesh::add_paired_pubkey(space, "dev-a", &ida.public_key_hex()).unwrap();
        let addr_b =
            ensure_window(&[("default".to_string(), space.to_string(), true)], "dev-b", "127.0.0.1:0000", &dir_b)
                .unwrap()
                .expect("B 的门要起得来");
        // ⭐ **A 去拿 B 的** ⇒ **必须进得来** ✓（双向已通 ✓；⛔ 门口不用重启 ✗）
        let (ta, sa) = sign(&ca, "dev-a");
        let both =
            crate::mesh::pull_from_peer(&client, &near("dev-b", addr_b), space, 0, None, Some(("dev-a", ta, &sa)), "")
                .await;
        assert!(
            both.is_ok(),
            "⭐ **一方配对成功 ⇒ 双向通** ✓（⛔ 不许只开一个方向 ✗；⭐ 门没重启 ✓）：{both:?}"
        );

        stop_window(space).unwrap();
    }

    /// ⭐⭐ **R110（owner 2026-10-02 拍 A）的端到端判据：一趟配对 ⇒ 两个方向都通** ✓。
    ///
    /// 与上一条的分工：
    ///   · 上一条量**采纳侧**（零卡开门 → 采纳 → 门不重启也 200 → 解除 → 401 ✓）；
    ///   · 这一条量 **A 新加的那一半** —— **发起侧在生成时就登记**（`sync::apply_device_pair_export` ✓）
    ///     ⇒ 只配对**一次**，**两个方向**都进得来 ✓（A 之前必须先"反过来再配一次" ✗）。
    ///
    /// ⚠️ 这条判据是**两台机器**（两个 app data 目录 ＋ 两扇门 ✓），不是"一台机器的两个空间"：
    ///   A 的整个意义就是"**对面那台也认我**"，只用一台机器量不出来 ✓。
    ///
    /// **变异**：把 `sync::apply_device_pair_export` 改成 `Ok(false)`（＝回到 A 之前）
    /// ⇒ 第一个方向（**对面拉发起侧**）必须**红**（401 而不是 200 ✓）—— 那正是 A 要消灭的那一格 ✓。
    #[tokio::test]
    async fn one_pairing_round_connects_both_directions() {
        let dir_a = temp_dir("mesh-r110-a");
        let dir_b = temp_dir("mesh-r110-b");
        for d in [&dir_a, &dir_b] {
            std::fs::create_dir_all(crate::db::spaces_dir(d)).unwrap();
            drop(crate::db::open_meta_conn_at(d).unwrap()); // meta 的表先建起来 ✓
        }
        let secret = "k7Qm-2pRt-r110";
        // ── 甲（发起侧）：设备号 ＋ 接线（生成前必须已经配好地址与口令 ✓）＋ 一条自己的记录
        let ca = crate::db::open_space_conn_at("default", &dir_a).unwrap();
        crate::sync::set_meta_state(&ca, "device_id", "dev-jia").unwrap();
        set_mesh_bind(&ca, "proto-r110", Some("0.0.0.0:8788")).unwrap();
        set_mesh_token(&ca, "proto-r110", Some(secret)).unwrap();
        let mut pa = page("only-in-jia", "只属于甲的内容", 1_000);
        pa.workspace_id = "default".to_string();
        local_edit(&ca, &pa);
        // ── 乙（采纳侧）：只要设备号（它自己的接线由采纳时写 ✓）＋ 一条自己的记录
        let cb = crate::db::open_space_conn_at("default", &dir_b).unwrap();
        crate::sync::set_meta_state(&cb, "device_id", "dev-yi").unwrap();
        let mut pb = page("only-in-yi", "只属于乙的内容", 1_000);
        pb.workspace_id = "default".to_string();
        local_edit(&cb, &pb);

        // ⚠️ **绑定键与另三条判据都不同**（注册表键＝绑定字符串 ✓）：`127.0.0.1:0` / `localhost:0` /
        //    `0.0.0.0:0` 已各有其主 ⇒ 这里用 `…:00`（**另一个键、同一个临时端口** ✓）：键不同才不会
        //    与别人共用一扇门，而端口 0 仍是系统的临时端口 ✓。
        let mk = |bind: &str, dir: &std::path::PathBuf, dev: &str| {
            ensure_window(&[("default".to_string(), "proto-r110".to_string(), false)], dev, bind, dir)
                .unwrap()
                .expect("窗口应当起得来")
        };

        // ① ⭐ **甲先开一扇门**（空卡）—— 生成时登记的那张卡必须**当场**进这扇门 ✓
        let addr_a0 = mk("127.0.0.1:00", &dir_a, "dev-jia");
        assert!(addr_a0.port() > 0, "甲的门要真的绑上端口（不然下面那次「当场加进去」无从谈起）");

        // ② ⭐ **走真产出内核**（＝ `device_pair_export` 那一步 ✓）：真载荷 ＋ 生成时登记
        //   ⭐ 2026-10-12（1C）：载荷**必须带公钥** ✗（不带 ⇒ 解码就拒 ✓）——
        //     ⚠️ 夹具借甲自己那把钥匙当"乙的公钥" ✓（⭐ 这一格量的是"登记 → 验签放行"那条链 ✓）。
        let id_yi = crate::device_key::load_or_create(&ca).unwrap();
        let mut payload =
            crate::pairing::device_pair_from("0.0.0.0:8788", secret, "dev-jia", "dev-yi").unwrap();
        crate::pairing::stamp_pubkey(&mut payload, &id_yi.public_key_hex()).unwrap();
        let text = crate::pairing::encode_device_pair(&payload).unwrap();
        // ⭐ 2026-10-12（1C 第 ②-b 片）：⭐ 生成时登记也要交**乙那把公钥** ✗（它来自界面 ✓）——
        //   ⭐ 于是"一趟配对、两个方向都通"在新模型下照样成立 ✓（落点换成**钥匙** ✓）。
        let added = crate::sync::apply_device_pair_export(
            &ca,
            "proto-r110",
            "dev-yi",
            secret,
            false,
            &id_yi.public_key_hex(),
        )
        .unwrap();
        assert!(added, "甲的门正开着 ⇒ 生成时登记的新卡必须**当场**加进去 ✓");
        // ⭐⭐ **2026-10-12（1C 第 ②-b 片）的命门** ✗：⭐ 生成时登记的那把**公钥**必须**当场**生效 ✓ ——
        //   ⭐ 乙此后**凭签名**（⛔ 不带任何口令 ✗）就得进得来 ✓。
        //   ⚠️ 夹具借甲自己那把钥匙当"乙的公钥" ✓（这一格量的是"登记 → 验签放行"那条链 ✓）。
        let pull_r110 = "/mesh/pull?space_id=proto-r110&since=0&limit=100";
        let (ts_e, sig_e) =
            crate::mesh::sign_request(&ca, "dev-yi", "proto-r110", "GET", pull_r110, crate::db::now_ms())
                .unwrap();
        let (code, body) = http_get_signed(addr_a0, pull_r110, "dev-yi", ts_e, &sig_e);
        assert_eq!(
            code, 200,
            "⛔ 生成时登记的**公钥**必须当场生效 ✗（⭐ 1C 之后「一趟配对两个方向都通」靠的就是它 ✓）：{body}"
        );

        // ⚠️⚠️ **这里必须先把甲的门关掉**（判据自己差点把缺口糊住 —— 第一版就栽在这 ✓）：
        //   `mesh::add_paired` 是按「**服务哪个空间**」找门的，而它取的是**第一个**命中的 ✓。
        //   生产里一个进程只有一份 app data ⇒ **同一个空间只会有一扇门** ✓；而这条判据是
        //   **两台机器**（两个目录）⇒ 两扇门同时开着时，乙那次登记可能被加到**甲的门**上 ✗
        //   —— 而两侧用的是**同一个 S** ⇒ 甲的门照样放行 ⇒ 判据**看起来全绿**，其实什么都没证明 ✗
        //   （＝"判据自己把缺口糊住"，本仓栽过好几次 ✓）。
        //   ⇒ 所以：**只在对应那扇门开着的时候做登记**；之后再两扇门各自从**自己的库**里载卡 ✓。
        crate::mesh::stop_window("proto-r110").unwrap();

        // ③ ⭐ **乙走真采纳**（真判定 ＋ 同一个落库内核 ✓）—— 此刻注册表里没有服务这个空间的门 ✓
        let decision = crate::sync::decide_device_pair_import(
            &text,
            Some(&crate::pairing::check_code(&text)),
            "dev-yi",
        )
        .unwrap();
        let crate::sync::DevicePairDecision::Accept { peer_device_id, bind, token, .. } = decision else {
            panic!("给本机的码应当能采纳：{decision:?}")
        };
        assert_eq!(peer_device_id, "dev-jia");
        crate::sync::apply_device_pair_import(
            &cb,
            "proto-r110",
            &peer_device_id,
            &bind,
            &token,
            false,
            &id_yi.public_key_hex(),
        )
        .unwrap();
        crate::mesh::stop_window("proto-r110").unwrap(); // 幂等：此刻没有门在服务它 ✓

        // ④ **两扇门各自重开**（卡由 `load_cards` 从**各自的库**里载 ✓ ⇒ 不再靠内存里的临时状态 ✓）
        let addr_a = mk("127.0.0.1:00", &dir_a, "dev-jia");
        let addr_b = mk("localhost:00", &dir_b, "dev-yi");

        // ⑤ ⭐⭐ **两个方向都通**（只配对过**一次** ✓）
        let pull = "/mesh/pull?space_id=proto-r110&since=0&limit=100";
        //   方向一：**乙拉甲** ⇒ 甲要放行 S —— 靠的正是**生成时登记的那张卡** ★（变异就打在这里 ✓）
        let (code, body) = http_get(addr_a, pull, Some(secret));
        assert_eq!(code, 200, "生成时登记过 ⇒ 甲必须当场放行（A 的意义全在这一格）：{body}");
        assert!(body.contains("only-in-jia"), "而且要真拉到甲的东西：{body}");
        //   方向二：**甲拉乙** ⇒ 乙要放行 S —— 靠的是**采纳时登记** ✓（与 A 之前一样 ✓）
        let (code, body) = http_get(addr_b, pull, Some(secret));
        assert_eq!(code, 200, "采纳时登记过 ⇒ 乙必须放行：{body}");
        assert!(body.contains("only-in-yi"), "而且要真拉到乙的东西：{body}");
        // ⑤ 两侧**各自要出示的那一份**也都在（`round_candidates` 读的就是它 ✓）
        assert_eq!(
            crate::mesh::pair_secret_for(&ca, "proto-r110", "dev-yi").as_deref(),
            Some(secret),
            "甲要出示给乙的那份（生成时就存好 ✓）"
        );
        assert_eq!(
            crate::mesh::pair_secret_for(&cb, "proto-r110", "dev-jia").as_deref(),
            Some(secret),
            "乙要出示给甲的那份（采纳时存好 ✓）"
        );
        // ⑥ 而两边都**只存哈希**（⛔ 明文只在"我要出示"的那一侧 ✓）
        for c in [&ca, &cb] {
            let hashes = crate::db::paired_secret_hashes(c, "proto-r110").unwrap();
            assert!(hashes.contains(&crate::db::sha256_hex(secret)), "库里要有 sha256：{hashes:?}");
            assert!(!hashes.iter().any(|h| h == secret), "⛔ 库里不许存明文 ✗");
        }

        // 清理：两扇门各摘一次（`stop_window` 按空间找，摘完一个再摘下一个 ✓）
        crate::mesh::stop_window("proto-r110").unwrap();
        crate::mesh::stop_window("proto-r110").unwrap();
    }

    /// ⭐⭐ **2026-10-20（真机：游标一旦过大就永久静默）**：两格。
    /// ① `max_own_device_seq` 真的报**我这一栏**的高水位（不是全表的）；
    /// ② 老对端的响应里**没有** `max_device_seq` ⇒ 读成 0（客户端据此不敢乱重基）。
    /// **变异**：把 SQL 的 `WHERE device_id = ?1` 删掉 ⇒ ① 必红（会报成别人的 999）；
    ///          把 `#[serde(default)]` 删掉 ⇒ ② 必红（整条响应解析失败）。
    #[test]
    fn high_water_mark_and_old_peer_compat() {
        let dir = temp_dir("mesh-high-water");
        // ⚠️ 必须先把 spaces/ 建好（open_space_conn_at 不会替你建目录 ✗）
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        let c = crate::db::open_space_conn_at("sp-hw", &dir).unwrap();
        for (dev, seq) in [("dev-me", 5_i64), ("dev-me", 19), ("dev-other", 999)] {
            c.execute(
                "INSERT INTO changes (device_id, device_seq, entity, entity_id, op, payload, updated_at) \
                 VALUES (?1, ?2, 'page', ?3, 'upsert', NULL, 1)",
                rusqlite::params![dev, seq, format!("p-{dev}-{seq}")],
            )
            .unwrap();
        }
        assert_eq!(
            max_own_device_seq(&c, "dev-me").unwrap(),
            19,
            "高水位必须是**我这一栏**的最大值：dev-other 的 999 不算进来"
        );
        assert_eq!(max_own_device_seq(&c, "dev-nobody").unwrap(), 0, "一行都没有 ⇒ 0");

        let old = r#"{"records":[]}"#;
        let parsed: PullResponse = serde_json::from_str(old).expect("老对端不带那一格也必须能解析");
        assert_eq!(parsed.max_device_seq, 0, "没有这一格 ⇒ 0（⇒ 客户端不重基）");
        assert!(parsed.records.is_empty());
    }

    /// ⭐ 2026-10-24：`round_touched_pages` —— 网格拉完要告诉前端"改了哪些页"，
    /// 否则编辑器里那份旧 doc 之后一保存，就把刚并进来的块盖掉（真机：页 B 两边各缺一块）。
    #[test]
    fn round_touched_pages_lists_the_pages_this_round_changed() {
        fn item(entity: &str, id: &str, op: &str) -> crate::sync::SyncItem {
            crate::sync::SyncItem {
                entity: entity.to_string(),
                entity_id: id.to_string(),
                op: op.to_string(),
                dir: "pull".to_string(),
                title: String::new(),
            }
        }
        fn peer(
            applied: usize,
            superseded: usize,
            awaiting: usize,
            items: Vec<crate::sync::SyncItem>,
        ) -> PeerPullReport {
            PeerPullReport {
                peer: "B".to_string(),
                fetched: items.len(),
                applied,
                cursor: 0,
                max_seq: 0,
                superseded,
                awaiting,
                items,
                merge: PeerMergeState::Merged,
                error: None,
            }
        }
        fn report(peers: Vec<PeerPullReport>) -> MeshRoundReport {
            MeshRoundReport {
                enabled: true,
                note: String::new(),
                candidates: peers.len(),
                peers,
                window: None,
            }
        }

        // ① 应用了页 ⇒ 收；附件不算；重复的页去重
        let r = report(vec![peer(
            2,
            0,
            0,
            vec![
                item("page", "p1", "upsert"),
                item("attachment", "a1", "upsert"),
                item("page", "p1", "upsert"),
            ],
        )]);
        assert_eq!(round_touched_pages(&r), vec!["p1".to_string()]);

        // ② 这一台一个字节都没动 ⇒ 整台跳过（即便 items 里有东西）
        let r = report(vec![peer(0, 0, 0, vec![item("page", "p1", "upsert")])]);
        assert!(round_touched_pages(&r).is_empty(), "没改东西的 peer 不许报“改了”");

        // ③ 「等你裁决」（awaiting）也是改了 —— 远端版本进了待取回，编辑器同样要刷新
        let r = report(vec![peer(0, 0, 1, vec![item("page", "p2", "upsert")])]);
        assert_eq!(round_touched_pages(&r), vec!["p2".to_string()]);

        // ④ 删除不进（编辑器刷新按页 id 取，删除由列表那条路管）
        let r = report(vec![peer(1, 0, 0, vec![item("page", "p3", "delete")])]);
        assert!(round_touched_pages(&r).is_empty());
    }
}
