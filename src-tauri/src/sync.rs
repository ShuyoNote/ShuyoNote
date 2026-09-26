use crate::db::Db;
use crate::hlc::Hlc;
use crate::lan::{self, Peer};
use crate::lan_state::LanState;
use crate::models::PageDetail;
use crate::search;
use crate::security;
use futures_util::StreamExt;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager, State};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

const KEY_DEVICE_ID: &str = "device_id";
const KEY_SERVER_URL: &str = "server_url";
const KEY_TOKEN: &str = "token";
const KEY_SPACE_ID: &str = "space_id";
const KEY_LAST_PUSHED: &str = "last_pushed_seq";
const KEY_LAST_PULLED: &str = "last_pulled_seq";

// ---- state helpers ----

pub fn get_state(c: &Connection, key: &str) -> Option<String> {
    c.query_row(
        "SELECT value FROM sync_state WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

// App-level key-value state lives in meta.db (shared across every workspace).
// Only these go to meta: device_id + server_url + token. Per-workspace state
// (E2EE keys, sync cursor) stays in the space DB's own `sync_state`.
pub fn get_meta_state(c: &Connection, key: &str) -> Option<String> {
    c.query_row(
        "SELECT value FROM meta.sync_state WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn set_meta_state(c: &Connection, key: &str, value: &str) -> Result<(), String> {
    c.execute(
        "INSERT INTO meta.sync_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ─────────────── 丙-③（2026-09-25）：本机时钟 ＋ "这一页当前那枚戳" ───────────────
//
// 两件都放 `meta.sync_state` 的 KV 里，**不新开 schema 列**：值就是 `Hlc::encode()` 那串
// 定长文本（字典序 == HLC 序），将来真需要索引时直接落成一列。键按设备 / 空间命名，互不串味。

/// KV 键：本机时钟上一次发出的戳 —— **跨重启单调**的保证就在这一格。
fn clock_key(device: &str) -> String {
    format!("hlc:{device}")
}

/// KV 键：某一页**当前那一版**的戳（收侧拿它跟远端那枚比）。
fn page_stamp_key(ws: &str, page_id: &str) -> String {
    format!("hlc_page:{ws}:{page_id}")
}

/// ★ 本机产生一枚戳：读回上次那枚 ⇒ `tick(now_ms)` ⇒ **写回**。
///
/// ⚠️ **每次都要落库**：只在内存里推进的话，"进程重启 ＋ 物理钟回拨"会让戳**倒退**，
/// 而戳是判序的依据（倒退 ＝ 两台设备对"谁更新"各执一词）。
/// ⚠️ `now_ms` 是**参数**：判据要能编排"物理钟回拨"这一格（不在这里读表）。
/// ⚠️ 存着的那格**读不出来就报错**，**不猜着重置** —— 重置会让戳倒退，比什么都糟。
pub fn local_stamp(c: &Connection, now_ms: i64) -> Result<Hlc, String> {
    let mut clock = read_clock(c)?;
    let next = clock.tick(now_ms);
    set_meta_state(c, &clock_key(&device_id(c)?), &next.encode())?;
    Ok(next)
}

/// 读回本机时钟（不存在 ⇒ `genesis`）。**读不出来就报错、不猜着重置**（见 `local_stamp`）。
fn read_clock(c: &Connection) -> Result<Hlc, String> {
    let device = device_id(c)?;
    let key = clock_key(&device);
    match get_meta_state(c, &key) {
        None => Ok(Hlc::genesis(&device)),
        Some(stored) => Hlc::decode(&stored).ok_or_else(|| {
            format!("本机时钟那一格（{key}）读不出来：{stored}（**不猜着重置**：重置会让戳倒退）")
        }),
    }
}

/// ★★ 丙-③ **收侧**：把收到的这枚戳**并进本机时钟**（HLC 的 `observe`）⇒ 本机时钟严格越过它。
///
/// 为什么必须在收这一侧做：HLC 那条"因果一定在序里"（`stamp(收) > stamp(发)`）**只由 `observe`
/// 提供**。不 observe 的话，对端时钟快时，本机随后的一次编辑会拿到**小于**刚收到那枚戳的戳
/// ⇒ "因果上更晚的改动"在 `verdict` 里反而被判给远端 —— **那一错就是丢更新**。
/// 判据：`absorbing_a_fast_peers_stamp_pushes_the_local_clock_past_it`（含变异实测）。
///
/// ⚠️ 与 `local_stamp` 共用同一格 KV（`hlc:<device>`）⇒ **跨重启单调**那条保证照旧。
/// ⚠️ **与"这一笔谁赢"无关**：输了的那一枚戳同样要 observe（不然下一个本地编辑还会栽在它上面）。
/// ⚠️ 缓存性质：写不进去只影响后续判序，**绝不让已经落库的这一笔失败**（更不连坐整批）。
fn observe_remote_stamp(c: &Connection, remote: &Hlc, now_ms: i64) -> Result<(), String> {
    let mut clock = read_clock(c)?;
    clock.observe(remote, now_ms);
    set_meta_state(c, &clock_key(&device_id(c)?), &clock.encode())?;
    Ok(())
}

/// 这一页**当前那一版**的戳。⚠️ 读不出来 / 没有 ⇒ `None`（＝"没带戳"⇒ 收侧走今天那条路）。
///
/// 这一格是**缓存性质**的：丢了只会让下一笔退回老判序（不会丢数据），
/// 所以这里读不出来时**不当致命**，只当"没有"。
pub fn page_stamp(c: &Connection, ws: &str, page_id: &str) -> Option<Hlc> {
    get_meta_state(c, &page_stamp_key(ws, page_id)).and_then(|s| Hlc::decode(&s))
}

fn set_page_stamp(c: &Connection, ws: &str, page_id: &str, stamp: &Hlc) -> Result<(), String> {
    set_meta_state(c, &page_stamp_key(ws, page_id), &stamp.encode())
}

/// 把"这一页当前那枚戳"**清掉** —— 用在"本地那一版被一个**没带戳**的远端覆盖了"之后。
///
/// ⚠️ 不清就是留着一个**指向已经不是当前版本**的旧戳：下一轮拿它比会判错边，而那一错就是丢更新。
/// 清掉之后下一笔自然退回今天那条路（缺一边）——**安全的方向**。
fn clear_page_stamp(c: &Connection, ws: &str, page_id: &str) -> Result<(), String> {
    c.execute("DELETE FROM meta.sync_state WHERE key = ?1", params![page_stamp_key(ws, page_id)])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Store/refresh a per-server team session in `meta.auth_sessions`. Used by login/
/// register; token TTL is 30 days (server expires_at drives the real expiry).
fn set_auth_session(c: &Connection, server_url: &str, email: &str, token: &str) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    c.execute(
        "INSERT INTO auth_sessions (server_url, email, user_id, token, created_at, expires_at)
         VALUES (?1, ?2, '', ?3, ?4, ?4 + 2592000000)
         ON CONFLICT(server_url) DO UPDATE SET email=excluded.email, token=excluded.token, created_at=excluded.created_at, expires_at=excluded.expires_at",
        params![server_url, email, token, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Best-effort read of a per-server session token (`meta.auth_sessions`).
fn get_auth_token(c: &Connection, server_url: &str) -> Option<String> {
    c.query_row(
        "SELECT token FROM auth_sessions WHERE server_url = ?1",
        params![server_url],
        |row| row.get(0),
    )
    .ok()
}

/// Best-effort read of the email last logged in for a server (`meta.auth_sessions`).
/// Used to prefill the login form so a previously-synced server's account is remembered.
fn get_auth_email(c: &Connection, server_url: &str) -> Option<String> {
    c.query_row(
        "SELECT email FROM auth_sessions WHERE server_url = ?1",
        params![server_url],
        |row| row.get(0),
    )
    .ok()
}

pub fn device_id(c: &Connection) -> Result<String, String> {
    get_meta_state(c, KEY_DEVICE_ID).ok_or_else(|| "设备 ID 未初始化".to_string())
}

// ---- outbox recording ----

pub fn record_change(
    c: &Connection,
    entity: &str,
    entity_id: &str,
    op: &str,
    payload: Option<&str>,
    updated_at: i64,
) -> Result<(), String> {
    let did = device_id(c)?;
    c.execute(
        "INSERT INTO changes (device_id, device_seq, entity, entity_id, op, payload, updated_at)
         VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6)",
        params![did, entity, entity_id, op, payload, updated_at],
    )
    .map_err(|e| e.to_string())?;
    let seq = c.last_insert_rowid();
    // device_seq mirrors local auto-increment seq (unique per device).
    c.execute(
        "UPDATE changes SET device_seq = ?1 WHERE seq = ?1",
        params![seq],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn record_page_upsert(c: &Connection, page: &PageDetail) -> Result<(), String> {
    let payload = serde_json::to_string(page).map_err(|e| e.to_string())?;
    // ★ §11.4 收口（第 42 轮）· **推**那一半：这一页有 CRDT 状态 ⇒ 把它挂到载荷上
    //   （与 TS 的 `withCrdtWire` 同一形状、同一字段名）。在此之前**桌面推出去的载荷从不带状态**
    //   ⇒ 桌面↔Web 之间那条 CRDT 链路是断的（Web 对端只能按块级 LWW 收）。
    //   ⚠️ **没有状态 ⇒ 载荷逐字不变**（老路径零感知：这条路不经过序列化改写）。
    let payload = match crate::page_crdt::read_page_crdt_state(c, &page.id)? {
        Some(state) if !state.is_empty() => crate::crdt_wire::with_wire_state(&payload, &state)?,
        _ => payload,
    };
    // ★ 丙-③（2026-09-25）：把**本机这一刻的戳**挂进载荷，并把"本页当前那一版"记下来。
    //   挂在这里（而不是推的那一侧）是因为戳要反映"**改的时候**"：一批积压的改动若在发送时
    //   才一起取戳，它们的先后会被压平成一个晚戳。
    //   ⚠️ 只挂**页 upsert** 这一条路（丙的页级 LWW 就是改它）；附件与页删除的路今天不动。
    //   ⚠️ 老对端读不懂这一项就忽略 ⇒ 与接线前**逐字节相同**（`with_stamp` 只加一项）。
    //   ⚠️ **这是保存路径**：取不到戳 / 戳写不进 KV **都不许**让保存失败 —— 如实打一行，
    //      这一条就不带戳（收侧自然按今天那条路判）。丢的是"丙的判序"，不是用户的编辑。
    let payload = match local_stamp(c, crate::db::now_ms()) {
        Ok(stamp) => {
            if let Err(e) = set_page_stamp(c, &page.workspace_id, &page.id, &stamp) {
                eprintln!("[sync] page {} 的「本页戳」没写进去（只影响下一轮判序）：{e}", page.id);
            }
            crate::hlc::with_stamp(&payload, &stamp)?
        }
        Err(e) => {
            eprintln!("[sync] page {} 取不到本机戳 ⇒ **这一条不带戳**（收侧按今天那条路判）：{e}", page.id);
            payload
        }
    };
    record_change(c, "page", &page.id, "upsert", Some(&payload), page.updated_at)
}

// ---- remote apply (LWW) ----

/// 一次远端页 upsert 的**处置结果**。
///
/// ★ 为什么必须是枚举，而不是像旧版那样返回 `usize`（取证文件 §5，B 方案第①条）：
///   旧的 `0` 同时表示 ①"应用了远端、而且**没有**未裁决冲突"与 ②"**压根没应用**（页级保留本地）"。
///   调用方（游标）只看计数 ⇒ 把"没应用"的那条也当"处理完了" ⇒ 推进游标 ⇒ **那笔远端编辑再也取不回**
///   （取证 §3.2 的 L，而且层里一条痕都没有）。
///   这与 `RemoteMerge` 当初那个 `Option` 是**同一类错误**：返回值必须先说清"发生了什么"，再谈计数。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpsertApply {
    /// 远端这一版**已应用**（逐块合并产物，或远端原样）。`unresolved` = 其中判不了而落进
    /// `page_conflicts` 的块数（`0` = 应用干净）。
    Applied { unresolved: usize },
    /// 页级**保留本地**：远端这一版**没有被应用**（本地那份未推送的编辑优先，裁定 ④，语义正确）。
    ///
    /// ⚠️ 调用方**必须**为这一支留痕（`doc_content::stash_pending_remote`）—— 否则就是取证里的 L：
    /// 游标过去了、对端那笔编辑再也取不回、层里什么都没有。
    KeptLocal,
}

/// ★ §11.4 收口（第 42 轮）：把页载荷里的 **CRDT 状态**收进旁路表。
///
/// **收到就收** —— 与"这一条变更最后用谁的版本"**无关**：页级保留本地（`KeptLocal`）时那一版状态
/// 同样不能丢，否则桌面永远追不上对端（编辑器 hydration 以本地状态为准 ⇒ 跨设备编辑被静默覆盖）。
///
/// 三种情形**分开**处置（混成一种的下场是静默丢块，与 `wireState.ts` 同一张表）：
///   · 解出来        ⇒ 收进 `page_crdt_pending`（同一 `seq` 重放幂等）；
///   · 版本不认识    ⇒ **不猜**，留一条 warn；
///   · 载荷坏了      ⇒ 同样**留痕**（不静默截断、不当空状态）；
///   · 没有这一项    ⇒ 什么也不做（老载荷 ⇒ 与接线前**逐字相同**）。
///
/// 抽成独立函数是为了让判据能直接钉它（不必起一次真 pull）；返回值＝"这次有没有收下"。
fn absorb_incoming_crdt_state(
    c: &Connection,
    page_id: &str,
    seq: i64,
    plain: &str,
    now: i64,
) -> Result<bool, String> {
    match crate::crdt_wire::extract_wire_state(plain) {
        Ok(crate::crdt_wire::WireState::None) => Ok(false),
        Ok(crate::crdt_wire::WireState::Ok(bytes)) => {
            crate::page_crdt::put_pending_state(c, page_id, seq, &bytes, now)?;
            Ok(true)
        }
        Ok(crate::crdt_wire::WireState::UnknownVersion(v)) => {
            eprintln!(
                "[sync] page {page_id} 的 CRDT 状态版本 {v} 本机不认识 ⇒ **未收下**（不猜；内容按今天那条路落库）"
            );
            Ok(false)
        }
        Err(e) => {
            eprintln!("[sync] page {page_id} 的 CRDT 载荷坏了：{e}（**未收下**；内容按今天那条路落库）");
            Ok(false)
        }
    }
}

/// ★ 丙-③：页级胜负改由**戳**说了算 —— 判定来自 `crate::hlc::verdict`，`None` ⇒ 今天那条路。
///
/// ⚠️ `stamp == None` 时**逐字节等于今天**（连代码都是同一处：`doc_content::merge`）——这条由
/// 既有那一整批 `doc_content` / `sync` 判据看着（它们一条都不带戳）。
/// ⚠️ 戳**只决定页级**谁赢；块级怎么合仍然在 `apply_remote_page` 里（两侧改不同块 ⇒ 两边都留）。
fn apply_upsert(
    c: &Connection,
    page: &PageDetail,
    sync_seq: i64,
    stamp: Option<crate::doc_content::StampWins>,
) -> Result<UpsertApply, String> {
    // ★ 合并判定搬进「文档内容」那一层（`crate::doc_content::merge`）——**唯一的合并点**：
    // 页级 LWW + dirty 优先本地 + seq 权威；阶段 1/2/3 换块级 LWW、CRDT 时只改那个函数。
    let local = crate::doc_content::local_state(c, &page.id)?;
    if crate::doc_content::merge_with_stamp(local, sync_seq, stamp) == crate::doc_content::MergeDecision::KeepLocal {
        return Ok(UpsertApply::KeptLocal);
    }

    // 「用远端」那一笔落库也走那一层（`doc_content::upsert_remote`）——
    // 于是**判定与落库在同一个文件里**，将来换 CRDT 时这一整条只改一处。
    // 前端侧的同名一份是 `docContent.upsertRemoteContent`（两侧 SQL 的列集本就不同，
    // 语义必须一致：`sync_seq` 记远端的、`dirty` 硬写 0）。
    //
    // ★ **阶段 1**：页级说"用远端"之后，**逐块合并 + 落库 + 派生**都在那一层的唯一入口
    //   `doc_content::apply_remote_page` 里做（两端各自改**不同块** ⇒ 两边的编辑都保留；
    //   老内容 / 有冲突 ⇒ 它内部回落成"远端原样"，与接线前逐字相同）。
    //
    // ★ **返回值 = 这次留下了几处未裁决的冲突**（AMD 2026-09-22 的要求："留痕 ≠ 已裁决" ⇒
    //   调用方必须能看见"有未裁决冲突"，哪怕只是个计数）。它由 `apply_remote_page` 的
    //   `RemoteMerge::Conflicted(..)` 直接给出 —— 调用方不必"再去查一次表"才知道。
    let outcome = crate::doc_content::apply_remote_page(c, page, sync_seq)?;
    Ok(UpsertApply::Applied {
        unresolved: match outcome {
            crate::doc_content::RemoteMerge::Conflicted(conflicts) => conflicts.len(),
            _ => 0,
        },
    })
}

// ---- B 方案（2026-09-22）：页级保留本地时留下的那一版远端，怎么收场 ----
//
// 取证与三个候选修法见 `docs/plans/2026-09-22-merge-push-and-cursor-forensics.md` §6。
// 这里落的是**方案 B**：游标照旧推进（不做方案 A，那会 livelock），但被跳过的那一版
// **在本地存下来**（`pending_remote_pages`），于是"静默"变成"看得见 ＋ 可收场"。
//
// ⚠️ 三个选项**都必须真的动数据**：旧横幅那句"已放弃本地未推送改动"是**假的**（`dirty` 还在，
//    下一次 push 照样把本地那版推上去）—— 那正是取证文件 §4 记的 F3。

/// 用户对"待取回的那一版远端"的处置。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingChoice {
    /// 合并这一页：与自动路径同一套（先逐块合并，两端各改不同块 ⇒ 都保留）。
    Merge,
    /// 采用远端：整页换成远端那一版（**不走**块级合并），并放弃本地**还没推上去**的改动。
    TakeRemote,
    /// 保留本地：什么都不动（本地那笔改动会在下一次 push 推上去）。
    KeepLocal,
}

impl PendingChoice {
    /// ⚠️ 只认三个字面量，**其余一律 `None`**（与 `resolve_page_conflict` 同一纪律：不默认选边）。
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "merge" => Some(PendingChoice::Merge),
            "take_remote" => Some(PendingChoice::TakeRemote),
            "keep_local" => Some(PendingChoice::KeepLocal),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            PendingChoice::Merge => "merge",
            PendingChoice::TakeRemote => "take_remote",
            PendingChoice::KeepLocal => "keep_local",
        }
    }
}

/// 裁决结果（给界面写状态行用；每个字段都是"到底做了什么"的读数）。
#[derive(Debug, Clone, Serialize)]
pub struct PendingChoiceReport {
    pub page_id: String,
    pub choice: String,
    /// `merge`：产物那一笔是不是**逐块合并**（`false` = 没有可合的，用了远端原样）。
    pub merged: bool,
    /// `merge`：这一轮落表的未裁决冲突条数（> 0 ⇒ 那一页还要走块级裁决）。
    pub unresolved: usize,
    /// `take_remote`：采用的远端 `seq`（另两个选项是 0）。
    pub adopted_seq: i64,
    /// `take_remote`：**真的丢掉了 N 笔没推上去的本地改动**（那句"已放弃本地未推送改动"的证据）。
    pub discarded_local_changes: usize,
    /// `merge`：本地还有 M 笔没推上去的改动 ⇒ 产物里那些"只在本地"的块要靠它们进 log ⇒ 已把这一页标回 dirty。
    pub local_changes_pending: usize,
}

/// 这一页所属空间"**已经推上去**"的水位。
///
/// ⚠️ 必须与 `do_push` 用来挑变更的是**同一个值**：`sync_profiles.last_pushed_seq`（按该页的
/// `workspace_id`）。写在这里当注释是因为中途踩过一次：`sync_state` 里**也有**一个同名 KV，
/// 但 `get_profile` 读的是 `sync_profiles` 那一列（`state_i64` 读的是另一个库的表）——
/// 用错那个，`unsent_*` 会永远算成"全都还没推"。
fn pushed_watermark_for_page(c: &Connection, page_id: &str) -> Result<i64, String> {
    let ws: Option<String> = c
        .query_row("SELECT workspace_id FROM pages WHERE id = ?1", params![page_id], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(ws) = ws else {
        return Ok(0);
    };
    let v: Option<i64> = c
        .query_row(
            "SELECT last_pushed_seq FROM sync_profiles WHERE ws_id = ?1",
            params![ws],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(v.unwrap_or(0))
}

/// 这一页**还没推上去**的本地整页变更条数（判定与 `do_push` 同一口径：同一设备 ＋ `seq > 水位`）。
pub fn unsent_page_change_count(c: &Connection, page_id: &str) -> Result<usize, String> {
    let (device, last_pushed) = (device_id(c)?, pushed_watermark_for_page(c, page_id)?);
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM changes
             WHERE entity = 'page' AND entity_id = ?1 AND device_id = ?2 AND seq > ?3",
            params![page_id, device, last_pushed],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(n as usize)
}

/// 丢掉这一页**还没推上去**的那笔本地整页变更 ——「采用远端」＝真的放弃本地那一版。
///
/// ⚠️ 只删 `seq > 水位` 的：已经推上去的那些是历史（`do_push` 的 `MAX(seq)` 记账也靠它们），
/// 删了会让游标账目错乱；而那些已经推到服务端的编辑**不该**被本地丢掉（它们是对端的既成事实）。
pub fn discard_unsent_page_changes(c: &Connection, page_id: &str) -> Result<usize, String> {
    let (device, last_pushed) = (device_id(c)?, pushed_watermark_for_page(c, page_id)?);
    let n = c
        .execute(
            "DELETE FROM changes
             WHERE entity = 'page' AND entity_id = ?1 AND device_id = ?2 AND seq > ?3",
            params![page_id, device, last_pushed],
        )
        .map_err(|e| e.to_string())?;
    Ok(n)
}

/// ★ **裁决入口**（桌面侧唯一）：把"页级保留本地时存下的那一版远端"按用户选择收场。
///
/// 三条分支都会**真的改数据**（见 `PendingChoice`），而且都会清掉那条待取回的存档 ——
/// 于是"游标过去了、对端那笔编辑再也取不回、层里什么都没有"这件事不再可能发生。
pub fn resolve_pending_remote(
    c: &Connection,
    page_id: &str,
    choice: PendingChoice,
) -> Result<PendingChoiceReport, String> {
    let (seq, payload) = crate::doc_content::pending_remote_payload(c, page_id)?
        .ok_or_else(|| "这一页没有待取回的远端版本（可能已经裁决过）".to_string())?;
    let page: PageDetail =
        serde_json::from_str(&payload).map_err(|e| format!("存档的远端版本读不出来：{e}"))?;

    let mut report = PendingChoiceReport {
        page_id: page_id.to_string(),
        choice: choice.as_str().to_string(),
        merged: false,
        unresolved: 0,
        adopted_seq: 0,
        discarded_local_changes: 0,
        local_changes_pending: 0,
    };

    match choice {
        // 「保留本地」= 现状：本地那份照旧，它会在下一次 push 推上去（对端届时会走块级合并）。
        PendingChoice::KeepLocal => {}
        PendingChoice::TakeRemote => {
            crate::doc_content::take_remote_page(c, &page, seq)?;
            report.adopted_seq = seq;
            // ⚠️ 这一半不能省：本地那笔**还没推上去**的整页改动要丢掉，否则下一次 push 又把本地那版
            //    推上去 —— 用户看到的"已放弃本地未推送改动"就成了假话。
            report.discarded_local_changes = discard_unsent_page_changes(c, page_id)?;
        }
        PendingChoice::Merge => {
            // 与自动路径**同一套**（`apply_remote_page`：先逐块合并，判不了才回落远端原样并留痕）。
            let outcome = crate::doc_content::apply_remote_page(c, &page, seq)?;
            report.merged = matches!(outcome, crate::doc_content::RemoteMerge::Merged { .. });
            if let crate::doc_content::RemoteMerge::Conflicted(conflicts) = &outcome {
                report.unresolved = conflicts.len();
            }
            // 合并产物里含**本地那一版独有的块**，而那些块只在"本地还没推上去的那笔变更"里 ⇒
            // 这一步之后必须把这一页标回 `dirty`（`apply_remote_page` 走的是"远端应用"那一支，
            // 会把 `dirty` 压成 0），否则页级判定会把本地那些块当"已经同步过"。
            report.local_changes_pending = unsent_page_change_count(c, page_id)?;
            if report.local_changes_pending > 0 {
                crate::doc_content::mark_page_dirty(c, page_id)?;
            }
        }
    }

    crate::doc_content::clear_pending_remote(c, page_id)?;
    Ok(report)
}

fn apply_delete(c: &Connection, id: &str, updated_at: i64) -> Result<(), String> {
    let local_updated: Option<i64> = c
        .query_row(
            "SELECT updated_at FROM pages WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some(local) = local_updated {
        if local > updated_at {
            return Ok(()); // local edit wins over remote delete
        }
    }

    c.execute(
        "UPDATE pages SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![updated_at, id],
    )
    .map_err(|e| e.to_string())?;
    search::remove_fts(c, id)?;
    Ok(())
}

// ---- wire types ----

#[derive(Serialize, Deserialize)]
struct OutgoingChange {
    device_seq: i64,
    entity: String,
    entity_id: String,
    op: String,
    payload: Option<String>,
    updated_at: i64,
}

#[derive(Serialize)]
struct PushRequest {
    device_id: String,
    space_id: String,
    changes: Vec<OutgoingChange>,
}

#[derive(Deserialize)]
pub(crate) struct IncomingChange {
    pub(crate) seq: i64,
    pub(crate) entity: String,
    pub(crate) entity_id: String,
    pub(crate) op: String,
    pub(crate) payload: Option<String>,
    pub(crate) updated_at: i64,
}

#[derive(Deserialize)]
struct PullResponse {
    changes: Vec<IncomingChange>,
}

#[derive(Serialize)]
pub struct SyncReport {
    pub pushed: usize,
    pub pulled: usize,
    pub last_pushed_seq: i64,
    pub last_pulled_seq: i64,
    /// Per-entity detail for "同步明细" (see SyncItem).
    pub items: Vec<SyncItem>,
    /// P0.1 conflict hint: local dirty page that received a newer server change.
    pub conflicts: Vec<SyncConflict>,
    /// 阶段 1（2026-09-22）：本轮**因块级合并判不了而落表的页面数**（未裁决）。
    ///
    /// ⚠️ 与 `conflicts` **不是一回事**（AMD 要求分开报，别合成一个值）：
    ///   · `conflicts` = 页级"本地有未推送改动 + 服务端有新 seq" ⇒ 要用户选**保留本地 / 采用远端**；
    ///   · 这个 = 逐块判不了（同 rev 不同内容 / 任一侧缺 rev）⇒ **已经**逐块留痕（表 `page_conflicts`），
    ///     只需让用户知道"这一页有未裁决的冲突"，详情走 `list_page_conflicts`。
    /// 单位是**页面数**（同一页一轮里可能被应用多次，只算一次）。
    pub block_conflict_pages: usize,
    /// ★ B 方案（2026-09-22）：本轮**页级保留本地**、因而把"那一版远端内容"存进本地待裁决清单的**页面数**。
    ///
    /// 与 `conflicts` 的关系（**别合成一个值**）：`conflicts` 是"要你选保留本地 / 采用远端"的提示，
    /// 而这个是"**已经替你留了痕**、随时可以在「待取回的远端版本」里裁决"的件数 ——
    /// 修好之前这一支是**完全静默**的（游标过去了，对端那笔编辑再也取不回，层里什么都没有）。
    /// 详情走 `list_pending_remote_pages`。
    pub pending_remote_pages: usize,
    /// P6.1：**本轮附件同步因"开关被关掉"而中途停止**（不是在入口就没开）。
    /// 界面据此显示"因开关关闭而停止"，而不是"同步完成"——否则用户以为全下完了。
    pub attachments_paused: bool,
    /// P6.1：本轮**因开关关闭而未传**的附件件数（入口就是关的 ⇒ 等于全部待传件数；
    /// 中途关掉 ⇒ 剩余未尝试的件数）。界面据此显示"未上传 N 个"（§六 验收 #4）。
    /// ⚠️ 定义是"**被开关挡下**的件数"，**不含**因网络失败而没传成功的件数。
    pub attachments_skipped_upload: usize,
    /// P6.1：同上，下载侧（"未下载 M 个"）。
    pub attachments_skipped_download: usize,
    /// C1（2026-09-15）：**停止原因**——`""` / `"switch"`（P6.1 开关）/ `"disk_floor"`（磁盘余量不足）
    /// / `"run_cap"`（撞上本轮总量上限）。`attachments_paused` 只说"停了"，这个说清"为什么停"。
    pub attachments_paused_reason: String,
    /// C1：因**单文件超过阈值**而跳过的件数（"N 个因超过 X MB 未自动下载"）。
    pub attachments_skipped_too_large: usize,
    /// C1：**传输失败**（网络抖动 / 服务端错误）而跳过的件数。⚠️ 与"被开关挡下"是两码事：
    /// 这些是本该传、但没传成功的 ⇒ 必须单独可见，否则就是静默丢件。
    pub attachments_failed: usize,
    /// C1：本轮**实际下载的字节数**。"本次下载总量上限"默认只报告不拦截（`DEFAULT_MAX_RUN_MB = 0`），
    /// 报告的就是这个数——先拿数据，再定硬数字。
    pub attachments_bytes_downloaded: u64,
}

/// A page that both has an unsynced local edit (dirty) and a newer server change.
/// Frontend prompts the user to keep local / adopt server.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct SyncConflict {
    pub entity_id: String,
    pub title: String,
}

/// One entity touched by a sync run — shown in the "同步明细" list.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct SyncItem {
    pub entity: String,   // "page" | "attachment" | ...
    pub entity_id: String,
    pub op: String,       // "upsert" | "delete"
    pub dir: String,      // "push" | "pull"
    pub title: String,    // human-readable name (page title, etc.), best-effort
}

/// 整批预扫：这批变更里**有没有本机构建解不开的密文版本**（§0-C）。
///
/// 抽成独立函数是为了能单测（`prescan_payload_formats_refuses_the_whole_batch`）——
/// 它必须在应用循环**之前**调用，这一点由调用点的位置保证（见 `do_pull`）。
/// 批量应用期间的**临时关外键**，`Drop` 时恢复原值 —— `?` 早退也不会漏掉。
///
/// ★ 为什么必须是 RAII（2026-09-20 修）：老写法是"先进循环、循环里到处 `?`、循环之后再
/// `PRAGMA foreign_keys = orig`"。只要循环里**任何一条**变更失败（网络/格式/约束），`?` 直接
/// 早退 ⇒ 那句恢复**永远不会执行** ⇒ 外键在**这条长命的主连接**上**永久 OFF**，
/// 之后整个应用的外键约束都不生效（孤儿行静默堆积）。SECURITY.md §四 早列了这条，
/// 这里用守卫把它从"看运气"变成"结构上不可能漏"。
struct ForeignKeysOff<'a> {
    conn: &'a rusqlite::Connection,
    orig: i64,
}

impl<'a> ForeignKeysOff<'a> {
    fn new(conn: &'a rusqlite::Connection) -> Self {
        // 原值读不到就按"本来是开的"恢复（宁可多开一次，也别把外键永久关掉）。
        let orig: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap_or(1);
        let _ = conn.execute_batch("PRAGMA foreign_keys = OFF;");
        Self { conn, orig }
    }
}

impl Drop for ForeignKeysOff<'_> {
    fn drop(&mut self) {
        let _ = self.conn.execute_batch(&format!("PRAGMA foreign_keys = {};", self.orig));
    }
}

fn prescan_payload_formats(changes: &[IncomingChange]) -> Result<(), String> {
    security::ensure_payloads_supported(changes.iter().filter_map(|c| c.payload.as_deref()))
}

/// Best-effort human-readable name for a change payload (page title, etc.).
fn item_title(entity: &str, payload: Option<&String>) -> String {
    if entity == "page" && payload.is_some() {
        if let Some(v) = serde_json::from_str::<serde_json::Value>(payload.unwrap()).ok() {
            if let Some(t) = v.get("title").and_then(|t| t.as_str()) {
                return t.to_string();
            }
            // Some page payloads nest the page object.
            if let Some(t) = v.get("page").and_then(|p| p.get("title")).and_then(|t| t.as_str()) {
                return t.to_string();
            }
        }
    }
    String::new()
}

#[derive(Deserialize)]
pub struct SyncConfigArgs {
    pub server_url: String,
    pub token: Option<String>,
    pub space_id: Option<String>,
}

#[derive(Serialize)]
pub struct SyncConfig {
    pub server_url: String,
    pub token: String,
    pub space_id: String,
    pub device_id: String,
    pub last_pushed_seq: i64,
    pub last_pulled_seq: i64,
}

// ---- S8: per-workspace sync profiles (multi-server / multi-space) ----

#[derive(Serialize, Deserialize, Clone)]
pub struct SyncProfile {
    pub ws_id: String,
    pub server_url: String,
    pub token: String,
    pub space_id: String,
    pub last_pushed_seq: i64,
    pub last_pulled_seq: i64,
    /// P6.1「每空间开关」：1 = 同步附件**字节**（默认）；0 = 只同步元数据、字节按需。
    /// ⚠️ 它**只管字节，不管元数据**——附件行仍随 `changes` 同步，所以对端"看得见但打不开"。
    /// `serde(default)` = 1：容忍缺字段的旧载荷，且默认与升级前行为一致。
    #[serde(default = "default_sync_attachments")]
    pub sync_attachments: i64,
}

fn default_sync_attachments() -> i64 {
    1
}

const PROFILE_COLS: &str =
    "ws_id, server_url, token, space_id, last_pushed_seq, last_pulled_seq, sync_attachments";

fn row_to_profile(r: &rusqlite::Row<'_>) -> rusqlite::Result<SyncProfile> {
    Ok(SyncProfile {
        ws_id: r.get(0)?,
        server_url: r.get(1)?,
        token: r.get(2)?,
        space_id: r.get(3)?,
        last_pushed_seq: r.get::<_, i64>(4)?,
        last_pulled_seq: r.get::<_, i64>(5)?,
        sync_attachments: r.get::<_, i64>(6)?,
    })
}

fn get_profile(c: &Connection, ws_id: &str) -> Result<SyncProfile, String> {
    let profile = c
        .query_row(
            &format!("SELECT {PROFILE_COLS} FROM sync_profiles WHERE ws_id = ?1"),
            params![ws_id],
            row_to_profile,
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(SyncProfile {
            ws_id: ws_id.to_string(),
            server_url: String::new(),
            token: String::new(),
            space_id: String::new(),
            last_pushed_seq: 0,
            last_pulled_seq: 0,
            // 没有行 = 还没配同步 ⇒ 开关按"开"（与 `DEFAULT 1` 一致，不改变既有行为）。
            sync_attachments: 1,
        });
    Ok(profile)
}

/// List the sync profiles of **live** workspaces only.
///
/// Workspaces are soft-deleted (`meta.workspaces.deleted_at`), and their profile
/// row is deliberately kept (so a recovered workspace keeps its binding), but a
/// deleted workspace must not show up in the sync panel as a bare UUID row, and
/// must not be pushed/pulled by `sync_now`. So the join is the single filter for
/// both call sites.
fn list_profiles(c: &Connection) -> Result<Vec<SyncProfile>, String> {
    let mut stmt = c
        .prepare(&format!(
            "SELECT {PROFILE_COLS} FROM sync_profiles p
             WHERE EXISTS (
                 SELECT 1 FROM meta.workspaces w
                 WHERE w.id = p.ws_id AND w.deleted_at IS NULL
             )
             ORDER BY p.ws_id"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_profile)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn set_profile(c: &Connection, ws_id: &str, server_url: &str, token: &str, space_id: &str) -> Result<(), String> {
    let url = server_url.trim().trim_end_matches('/').to_string();
    c.execute(
        "INSERT INTO sync_profiles (ws_id, server_url, token, space_id, last_pushed_seq, last_pulled_seq)
         VALUES (?1, ?2, ?3, ?4, 0, 0)
         ON CONFLICT(ws_id) DO UPDATE SET
           server_url = excluded.server_url,
           token = excluded.token,
           space_id = excluded.space_id",
        params![ws_id, url, token, space_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Update a single numeric field on a workspace's sync profile (best-effort).
///
/// ⚠️ `field` 会被**格式化进 SQL**，所以这里必须是**白名单**（P6.1 加固，2026-09-15）：
/// 原先只有一句注释「`field` is one of the trusted constants」——一旦哪天有人把入参透传进来，
/// 那行 `format!` 就是注入面。现在不匹配直接报错；**加字段必须同时加到这里**。
fn set_profile_field(c: &Connection, ws_id: &str, field: &str, value: i64) -> Result<(), String> {
    let col = match field {
        "last_pushed_seq" => "last_pushed_seq",
        "last_pulled_seq" => "last_pulled_seq",
        other => return Err(format!("不支持的 sync_profiles 字段：{other}")),
    };
    c.execute(
        &format!("UPDATE sync_profiles SET {col} = ?1 WHERE ws_id = ?2"),
        params![value, ws_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// P6.1「每空间开关」——读某个空间的附件字节开关（缺行/缺列按"开"处理，与 `DEFAULT 1` 一致）。
///
/// ⚠️ **为什么必须从 DB 读、而不是用 `profile.sync_attachments`**：`sync_now` 在
/// `list_profiles` 时**一次性快照**了全部 profile，之后整轮同步用的都是那份不可变快照。
/// 用快照 ⇒ **中途关掉开关不会生效**（会一直下完），而"中途关掉"正是这个开关最该起作用的时刻。
fn attachments_enabled(c: &Connection, ws_id: &str) -> bool {
    c.query_row(
        "SELECT COALESCE(sync_attachments, 1) FROM sync_profiles WHERE ws_id = ?1",
        params![ws_id],
        |r| r.get::<_, i64>(0),
    )
    .optional()
    .ok()
    .flatten()
    .map(|v| v != 0)
    .unwrap_or(true)
}

/// P6.1「每空间开关」：切换某个空间的**附件字节**同步（1 = 同步，0 = 只同步元数据）。
///
/// ⚠️ **刻意不复用 `set_sync_profile`**：那个命令对**未传的字段是"清空"**语义
/// （`token.as_deref().unwrap_or("")`），而 UI 里已有 5 处在利用这种"部分传参"
/// （`SyncPanel.tsx:250/262/405/422/450`）。若拿它翻转开关并省略凭证字段，
/// **会把该空间的 token / space_id 清掉**。这个窄命令只动一列，碰不到凭证。
#[tauri::command]
pub fn set_sync_attachments(db: State<'_, Db>, ws_id: String, enabled: bool) -> Result<(), String> {
    let c = db.0.lock().expect("db mutex poisoned");
    set_attachments_enabled(&c, &ws_id, enabled)
}

/// **基址只出一处**（甲-1 接线第 2 件的第一步）：这次同步该往哪个地址说话。
///
/// 口径（owner 2026-09-25 拍板 ② 的下游）：局域网发现到的中枢优先，否则配置地址。
/// ⚠️ 纯函数（对端表由调用方给）⇒ 判据**不需要**去动进程级单例，也就不会污染同进程里别的测试。
fn base_for(profile: &SyncProfile, peers: &[Peer]) -> String {
    lan::resolve_base(&profile.space_id, &profile.server_url, peers)
        .map(|r| r.url)
        .unwrap_or_default()
}

/// 生产路径的那一层薄壳：把**进程级**对端表接进 `base_for`。
///
/// ⚠️ 归属已由 owner 拍板为**应用级单例 ＋ 按需启用**（`lan_state`）：
/// 未启用时 `peers()` 返回空 ⇒ 这里拿到空 ⇒ **基址逐字节等于今天**（发现层是加分项，不是必经路）。
fn effective_base(c: &Connection, profile: &SyncProfile) -> String {
    let peers = match device_id(c) {
        Ok(id) => LanState::global(&id).peers(crate::db::now_ms()),
        // 拿不到 device_id（老库/异常）⇒ **不挡同步**：回落到"没发现到任何对端"。
        Err(_) => Vec::new(),
    };
    base_for(profile, &peers)
}

/// 同 [`effective_base`]，但**直接吃 `(space_id, server_url)`** —— 给 `claim_config`
/// 那一族用：`lineage-claim` 读的是 `sync_profiles` 的列，**手上没有 `SyncProfile`**
/// （见 `claim_config` 的注释），所以基址解析不能只认 `SyncProfile` 这一种入参形状。
///
/// ⚠️ `None` 而不是空串：调用方本来就有一支"没绑定 ⇒ 连请求都不发"（`claim_config` 给 `None`），
/// 返回空串会让那条分支多一个"地址为空"的暗礁。`Some("")` 在 `claim_config` 那条路上不可达
/// （它已经把空 `server_url` 挡在外面了）。
pub(crate) fn effective_base_for(c: &Connection, space_id: &str, server_url: &str) -> Option<String> {
    let peers = match device_id(c) {
        Ok(id) => LanState::global(&id).peers(crate::db::now_ms()),
        Err(_) => Vec::new(),
    };
    if peers.is_empty() {
        // 没发现到任何对端 ⇒ **逐字节**就是配置地址（连 `resolve_base` 的 URL 规整都不抄一遍）。
        return Some(server_url.to_string());
    }
    effective_base_from(space_id, server_url, &peers)
}

/// [`effective_base_for`] 的**纯函数**那一半（对端表由调用方给）⇒ 判据不去动进程级单例。
///
/// ⚠️ 没有对端时**不做任何规整**（原样回配置地址）：发现层没东西时，基址必须与今天逐字节相同。
fn effective_base_from(space_id: &str, server_url: &str, peers: &[Peer]) -> Option<String> {
    if peers.is_empty() {
        return Some(server_url.to_string());
    }
    lan::resolve_base(space_id, server_url, peers).map(|r| r.url)
}

/// 上面那一族拼出来的**三条 URL**（纯函数 ⇒ 每一处的地址都有判据钉着）。
///
/// 抽出来的理由与 `attachment_base` 同一条：这几条 URL 以前散在 `do_push` / `do_pull` /
/// `claim_page_lineage` 里各写一遍格式串，而甲-1 要把**基址**换掉 —— 只改一处、别处漏掉
/// 的表现是"push 走局域网、pull 还走公网"，**能编译、单测照绿**，只有真机拔网线才看得出来。
fn push_url(base: &str) -> String {
    format!("{}/push", base.trim_end_matches('/'))
}

/// `since` 与两个可选的过滤参数（`space_id` / `exclude_device`）都要**原样拼上**：
/// 少了 `space_id` 服务端会按"没绑空间"那一支回，少了 `exclude_device` 会把自己推的拉回来。
fn pull_url(base: &str, since: i64, space_id: &str, exclude_device: Option<&str>) -> String {
    let mut url = format!("{}/pull?since={since}&limit=500", base.trim_end_matches('/'));
    if !space_id.is_empty() {
        url.push_str(&format!("&space_id={space_id}"));
    }
    if let Some(d) = exclude_device {
        url.push_str(&format!("&exclude_device={d}"));
    }
    url
}

fn lineage_claim_url(base: &str) -> String {
    format!("{}/lineage-claim", base.trim_end_matches('/'))
}

/// 附件接口的 URL 前缀。**同步下载与按需下载必须走同一处**（P6.3 抽出）：
/// 绑了团队空间走 space 作用域，否则退回旧的全局路径 —— 服务端两条路由都在，
/// 但"哪一条"由 `space_id` 决定，两边各写一遍迟早会漂。
///
/// ⚠️ 顺手按本文件的既有约定 `trim_end_matches('/')`（见 presence/comments/notifications 那批）：
/// `set_profile` 落库前本来就会 trim，所以这只是防"手改过的 / 老库里的带斜杠地址"拼出
/// `https://host//spaces/x` 这种带双斜杠的 URL。
fn attachment_base(base: &str, space_id: &str) -> String {
    let server = base.trim_end_matches('/');
    if space_id.is_empty() {
        server.to_string()
    } else {
        format!("{server}/spaces/{space_id}")
    }
}

/// `set_sync_attachments` 的实际实现（抽出来是为了能在单测里直接跑 SQL——
/// `#[tauri::command]` 收 `State<Db>`，没有 Tauri App 就构造不出来）。
fn set_attachments_enabled(c: &Connection, ws_id: &str, enabled: bool) -> Result<(), String> {
    let n = c
        .execute(
            "UPDATE sync_profiles SET sync_attachments = ?1 WHERE ws_id = ?2",
            params![if enabled { 1 } else { 0 }, ws_id],
        )
        .map_err(|e| e.to_string())?;
    // 0 行 = 该空间还没有 profile 行。**报错而不是静默成功**：面板据此提示"先填服务器地址
    // 并绑定空间"，否则用户以为开关生效了（实际没有任何一行被写）。
    if n == 0 {
        return Err("该空间还没有同步配置（请先填服务器地址并绑定空间）".to_string());
    }
    Ok(())
}

/// P6.3「按需取字节」（2026-09-15）：用户**主动**要求下载其中一件附件。
///
/// 复用 `download_one_attachment()` —— **同一个函数，不允许再写第二份下载实现**
/// （见 `docs/plans/2026-09-15-attachment-on-demand-plan.md` §七：P6.3 若复制一份循环
/// 就会变成两套下载逻辑，落盘 / 加密 / 落库三件事只要有一边忘了改就是数据问题）。
///
/// ⚠️ **刻意不受 C1 预算闸门约束**（单文件阈值 / 本轮总量上限 / 磁盘余量下限都不拦）：
/// C1 管的是"**自动**拉取别在用户不知情时把设备填满"（scope plan 的上架判据），
/// 而这里是用户明确点了"下载这一件"——与"手动点同步不受 C2 仅 Wi-Fi 限制"
/// 是同一条原则：**显式操作照做**。磁盘真满了由写失败兜底（错误会原样返回）。
///
/// 成功返回落盘的**明文字节数**（界面据此提示"已下载 X"）。
#[tauri::command]
pub async fn download_attachment(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    ws_id: String,
    hash: String,
) -> Result<i64, String> {
    // 这个 hash 会被拼进文件路径 ⇒ 先当成**不可信输入**校验（与同步下载同一道门）。
    if !is_valid_attachment_hash(&hash) {
        return Err("附件标识不合法".to_string());
    }
    let (profile, mime) = {
        let c = db.0.lock().expect("db mutex poisoned");
        let p = get_profile(&c, &ws_id)?;
        // 落盘名是 `hash.<ext>`，而 ext 由 mime 决定 —— 只有本地那行元数据知道 mime；
        // 拿不到就退化成 octet-stream（与同步路径的兜底一致）。
        let mime = c
            .query_row(
                "SELECT mime FROM attachments WHERE hash = ?1 LIMIT 1",
                params![hash],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| "application/octet-stream".to_string());
        (p, mime)
    };
    if profile.server_url.is_empty() {
        return Err("请先配置同步服务器".to_string());
    }
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // ★ 附件按空间分（owner 2026-09-24 拍板 ②）：单个附件也下到**这个空间自己**的目录里。
    let attachments_dir: PathBuf = crate::attachments::space_attachments_dir(&app_data_dir, &profile.ws_id);
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;
    // URL 组装规则与 `sync_attachments` **完全一致**（同一个 `attachment_base`，不是各写一遍）。
    // ★ 甲-1 接线：基址也走同一个 `effective_base`（局域网中枢优先）——两处**同源**才不会漂。
    let att_base = {
        let c = db.0.lock().expect("db mutex poisoned");
        attachment_base(&effective_base(&c, &profile), &profile.space_id)
    };
    let session_key = {
        let c = db.0.lock().expect("db mutex poisoned");
        security::key_if_enabled(&c)
    };
    let client = reqwest::Client::new();
    // 凭证取法与同步下载保持一致（都用 `profile.token`）：两条路若取不同的 token，就会出现
    // "同步能下、点按钮下不了"这种最难查的不一致。
    let item = RemoteAttachment { hash: hash.clone(), mime };
    download_one_attachment(&client, &att_base, &profile.token, &item, &attachments_dir, session_key.as_ref(), &db).await
}

#[tauri::command]
pub fn list_sync_profiles(db: State<'_, Db>) -> Result<Vec<SyncProfile>, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    list_profiles(&c)
}

/// ★ 隐私边界**第 2 步**（2026-09-23）：**绑定同步关系**那一刻的闸门。
///
/// 返回 `Ok(Some(提示))` ＝ 放行但**这个空间还没分类**（上层该如实说出来，不静默）；
/// `Ok(None)` ＝ 正常放行；`Err` ＝ **拦住**（可操作文本：先按空间加密，或把它标成团队空间）。
///
/// ⚠️ 抽成独立函数就是为了**能被判据直接驱动**（命令那层要 `State<Db>`，测不了）。
pub(crate) fn sync_bind_gate(
    c: &Connection,
    dir: &Path,
    ws_id: &str,
) -> Result<Option<String>, String> {
    let mut st = crate::space_crypto::space_status(dir, ws_id);
    // ★ 名字（不是 uuid）：拦人的那句话与"没分类"那句提示都要说名字（owner 2026-09-24 指出）。
    crate::space_crypto::fill_space_name(c, &mut st);
    let kind = crate::space_crypto::space_kind(c, ws_id);
    match crate::space_crypto::sync_gate(&st, kind) {
        crate::space_crypto::SyncGate::Allowed => Ok(None),
        crate::space_crypto::SyncGate::Blocked(msg) => Err(msg),
        crate::space_crypto::SyncGate::AllowedUnclassified => Ok(Some(format!(
            "{}还没分类（个人/团队）：同步闸门这次**没有管到它** —— \
             若它是个人空间，请先按空间加密再绑定同步。",
            st.label()
        ))),
    }
}

#[tauri::command]
pub fn set_sync_profile(
    db: State<'_, Db>,
    ws_id: String,
    server_url: String,
    token: Option<String>,
    space_id: Option<String>,
    email: Option<String>,
) -> Result<(), String> {
    let c = db.0.lock().expect("db mutex poisoned");
    // ★ 第 2 步：**绑定之前**过闸门（个人空间没加密 ⇒ 拦；团队空间免检；未分类 ⇒ 放行但留痕）。
    if let Some(dir) = crate::db::app_data_dir_ref() {
        if let Some(note) = sync_bind_gate(&c, dir, &ws_id)? {
            eprintln!("[sync] {note}");
        }
    }
    set_profile(&c, &ws_id, &server_url, token.as_deref().unwrap_or(""), space_id.as_deref().unwrap_or(""))?;
    // 记住本次填的登录邮箱（供重开面板预填），只更新 email，保留已有 token/user_id。
    if let Some(e) = email.filter(|e| !e.trim().is_empty()) {
        let url = server_url.trim().trim_end_matches('/').to_string();
        let now = crate::db::now_ms();
        c.execute(
            "INSERT INTO auth_sessions (server_url, email, user_id, token, created_at, expires_at)
             VALUES (?1, ?2, '', '', ?3, 0)
             ON CONFLICT(server_url) DO UPDATE SET email = excluded.email",
            rusqlite::params![url, e, now],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn state_i64(c: &Connection, key: &str) -> i64 {
    get_state(c, key).and_then(|v| v.parse().ok()).unwrap_or(0)
}

#[tauri::command]
pub fn get_sync_config(db: State<'_, Db>) -> Result<SyncConfig, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    let device_id = device_id(&c)?;
    Ok(SyncConfig {
        server_url: get_meta_state(&c, KEY_SERVER_URL).unwrap_or_default(),
        token: get_meta_state(&c, KEY_TOKEN).unwrap_or_default(),
        space_id: get_meta_state(&c, KEY_SPACE_ID).unwrap_or_default(),
        device_id,
        last_pushed_seq: state_i64(&c, KEY_LAST_PUSHED),
        last_pulled_seq: state_i64(&c, KEY_LAST_PULLED),
    })
}

#[tauri::command]
pub fn set_sync_config(db: State<'_, Db>, args: SyncConfigArgs) -> Result<(), String> {
    let c = db.0.lock().expect("db mutex poisoned");
    let url = args.server_url.trim().trim_end_matches('/').to_string();
    set_meta_state(&c, KEY_SERVER_URL, &url)?;
    set_meta_state(&c, KEY_TOKEN, args.token.as_deref().unwrap_or(""))?;
    set_meta_state(&c, KEY_SPACE_ID, args.space_id.as_deref().unwrap_or(""))?;
    Ok(())
}

// ---- M27 团队版认证（客户端）----
// 对齐 sync-server `/auth/register` `/auth/login` `/auth/logout`。成功后把会话
// token 写入 meta.sync_state（复用 KEY_TOKEN），前端 auth store 据此维持登录态。

#[derive(serde::Serialize)]
pub struct TeamAuthResult {
    pub token: String,
}

#[tauri::command]
pub async fn team_register(
    db: State<'_, Db>,
    server_url: String,
    email: String,
    password: String,
    display: Option<String>,
    register_code: Option<String>,
) -> Result<TeamAuthResult, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/auth/register"))
        .json(&serde_json::json!({ "email": email, "password": password, "display": display, "register_code": register_code }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("注册失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let token = v.get("token").and_then(|t| t.as_str()).unwrap_or("").to_string();
    if token.is_empty() {
        return Err("服务端未返回 token".to_string());
    }
    let c = db.0.lock().expect("db mutex poisoned");
    set_meta_state(&c, KEY_SERVER_URL, &url)?;
    set_meta_state(&c, KEY_TOKEN, &token)?;
    set_auth_session(&c, &url, &email, &token)?;
    Ok(TeamAuthResult { token })
}

#[tauri::command]
pub async fn team_login(
    db: State<'_, Db>,
    server_url: String,
    email: String,
    password: String,
) -> Result<TeamAuthResult, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/auth/login"))
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("登录失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let token = v.get("token").and_then(|t| t.as_str()).unwrap_or("").to_string();
    if token.is_empty() {
        return Err("服务端未返回 token".to_string());
    }
    let c = db.0.lock().expect("db mutex poisoned");
    set_meta_state(&c, KEY_SERVER_URL, &url)?;
    set_meta_state(&c, KEY_TOKEN, &token)?;
    set_auth_session(&c, &url, &email, &token)?;
    Ok(TeamAuthResult { token })
}

#[tauri::command]
pub async fn team_logout(db: State<'_, Db>, server_url: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    // 先读 token（锁在块内释放，避免跨 await 持锁）。
    let token = {
        let c = db.0.lock().expect("db mutex poisoned");
        get_meta_state(&c, KEY_TOKEN).unwrap_or_default()
    };
    if !token.is_empty() {
        let client = reqwest::Client::new();
        let _ = client
            .post(format!("{url}/auth/logout"))
            .bearer_auth(&token)
            .send()
            .await;
    }
    {
        let c = db.0.lock().expect("db mutex poisoned");
        set_meta_state(&c, KEY_TOKEN, "")?;
        let _ = c.execute("DELETE FROM auth_sessions WHERE server_url = ?1", params![url]);
    }
    Ok(())
}

// ---- M27 团队空间 / 成员（客户端，Rust 代理绕过 WebView2 CORS）----
// 这些命令由前端传 server_url + token（登录态由 auth store 管理），用 reqwest
// 直连 sync-server，避免浏览器 fetch 触发 preflight 被无 CORS 层的服务端拦截。

#[derive(serde::Serialize)]
pub struct TeamSpace {
    pub id: String,
    pub name: String,
    pub role: String,
    pub owner_id: String,
}

#[derive(serde::Serialize)]
pub struct TeamMember {
    pub user_id: String,
    pub email: String,
    pub role: String,
}

#[tauri::command]
pub async fn team_list_spaces(server_url: String, token: String) -> Result<Vec<TeamSpace>, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{url}/spaces"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("拉取空间失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v["spaces"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|s| TeamSpace {
                    id: s["id"].as_str().unwrap_or("").to_string(),
                    name: s["name"].as_str().unwrap_or("").to_string(),
                    role: s["role"].as_str().unwrap_or("").to_string(),
                    owner_id: s["owner_id"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn team_create_space(server_url: String, token: String, name: String, org_id: Option<String>) -> Result<TeamSpace, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/spaces"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "name": name, "org_id": org_id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("创建空间失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(TeamSpace {
        id: v["id"].as_str().unwrap_or("").to_string(),
        name: v["name"].as_str().unwrap_or("").to_string(),
        role: v["role"].as_str().unwrap_or("").to_string(),
        owner_id: v["owner_id"].as_str().unwrap_or("").to_string(),
    })
}

#[tauri::command]
pub async fn team_list_members(server_url: String, token: String, space_id: String) -> Result<Vec<TeamMember>, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{url}/spaces/{space_id}/members"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("拉取成员失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v["members"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|m| TeamMember {
                    user_id: m["user_id"].as_str().unwrap_or("").to_string(),
                    email: m["email"].as_str().unwrap_or("").to_string(),
                    role: m["role"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn team_invite_member(server_url: String, token: String, space_id: String, email: String, role: String) -> Result<(), String> {
    team_member_post(&server_url, &token, &space_id, &email, &role).await
}

#[tauri::command]
pub async fn team_set_member_role(server_url: String, token: String, space_id: String, email: String, role: String) -> Result<(), String> {
    team_member_post(&server_url, &token, &space_id, &email, &role).await
}

async fn team_member_post(server_url: &str, token: &str, space_id: &str, email: &str, role: &str) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/spaces/{space_id}/members"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "user_email": email, "role": role }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("成员操作失败 {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn team_remove_member(server_url: String, token: String, space_id: String, user_id: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .delete(format!("{url}/spaces/{space_id}/members/{user_id}"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("移除成员失败 {}", resp.status()));
    }
    Ok(())
}

// ---- P0 org management (research group) ----
// A group leader (admin) manages member accounts and sees group-owned spaces.
// These call the sync-server /org/* endpoints (desktop only; the Web driver
// throws "仅桌面").

#[derive(serde::Serialize)]
pub struct TeamOrg {
    pub id: String,
    pub name: String,
    pub role: String,
    pub owner_id: String,
}

#[derive(serde::Serialize)]
pub struct TeamOrgMember {
    pub user_id: String,
    pub email: String,
    pub role: String,
    pub disabled: bool,
}

#[derive(serde::Serialize)]
pub struct TeamOrgInvite {
    pub email: String,
    pub status: String,
}

#[derive(serde::Serialize)]
pub struct TeamOrgMemberList {
    pub members: Vec<TeamOrgMember>,
    pub pending: Vec<TeamOrgInvite>,
}

#[tauri::command]
pub async fn team_list_orgs(server_url: String, token: String) -> Result<Vec<TeamOrg>, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{url}/orgs"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("拉取组织失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v["orgs"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|s| TeamOrg {
                    id: s["id"].as_str().unwrap_or("").to_string(),
                    name: s["name"].as_str().unwrap_or("").to_string(),
                    role: s["role"].as_str().unwrap_or("").to_string(),
                    owner_id: s["owner_id"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn team_create_org(server_url: String, token: String, name: String) -> Result<TeamOrg, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/orgs"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "name": name }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("创建组织失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(TeamOrg {
        id: v["id"].as_str().unwrap_or("").to_string(),
        name: v["name"].as_str().unwrap_or("").to_string(),
        role: v["role"].as_str().unwrap_or("").to_string(),
        owner_id: v["owner_id"].as_str().unwrap_or("").to_string(),
    })
}

#[tauri::command]
pub async fn team_list_org_members(server_url: String, token: String, org_id: String) -> Result<TeamOrgMemberList, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{url}/orgs/{org_id}/members"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("拉取成员失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let members = v["members"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|s| TeamOrgMember {
                    user_id: s["user_id"].as_str().unwrap_or("").to_string(),
                    email: s["email"].as_str().unwrap_or("").to_string(),
                    role: s["role"].as_str().unwrap_or("").to_string(),
                    disabled: s["disabled"].as_bool().unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default();
    let pending = v["pending"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|s| TeamOrgInvite {
                    email: s["email"].as_str().unwrap_or("").to_string(),
                    status: s["status"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(TeamOrgMemberList { members, pending })
}

#[tauri::command]
pub async fn team_approve_org_invite(server_url: String, token: String, org_id: String, email: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/orgs/{org_id}/invites/approve"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "email": email }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("批准成员失败 {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn team_reject_org_invite(server_url: String, token: String, org_id: String, email: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/orgs/{org_id}/invites/reject"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "email": email }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("拒绝成员失败 {}", resp.status()));
    }
    Ok(())
}

/// Self-deactivation (graduation handover). Revokes the session, disables the
/// account, and hands the caller's owned spaces to the org leader.
#[tauri::command]
pub async fn team_deactivate_account(server_url: String, token: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .delete(format!("{url}/auth/account"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("注销账号失败 {}", resp.status()));
    }
    Ok(())
}

/// Leader deactivates a group member (graduation handover).
#[tauri::command]
pub async fn team_deactivate_org_member(server_url: String, token: String, org_id: String, user_id: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/orgs/{org_id}/members/{user_id}/deactivate"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("注销成员失败 {}", resp.status()));
    }
    Ok(())
}

/// Leader generates / resets an org invite code; returns the code to hand out.
#[tauri::command]
pub async fn team_generate_org_invite_code(server_url: String, token: String, org_id: String) -> Result<String, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/orgs/{org_id}/invite-code"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("生成邀请码失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v["invite_code"].as_str().unwrap_or("").to_string())
}

/// A user joins an org by invite code (the code is the authorization).
#[tauri::command]
pub async fn team_join_org_by_code(server_url: String, token: String, code: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/orgs/join"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("加入组织失败 {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn team_invite_org_member(server_url: String, token: String, org_id: String, email: String, role: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{url}/orgs/{org_id}/members"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "email": email, "role": role }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("邀请成员失败 {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn team_set_org_member_active(server_url: String, token: String, org_id: String, user_id: String, active: bool) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .patch(format!("{url}/orgs/{org_id}/members/{user_id}"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "active": active }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("切换成员状态失败 {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn team_remove_org_member(server_url: String, token: String, org_id: String, user_id: String) -> Result<(), String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .delete(format!("{url}/orgs/{org_id}/members/{user_id}"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("移除成员失败 {}", resp.status()));
    }
    Ok(())
}

/// M27 当前会话（后端存于 meta.sync_state 的 KEY_SERVER_URL/KEY_TOKEN）。
/// 前端启动时读取以恢复登录态（有 token 即视为已登录）。
#[derive(serde::Serialize)]
pub struct TeamSession {
    pub server_url: String,
    pub token: String,
}

#[tauri::command]
pub fn team_get_session(db: State<'_, Db>) -> Result<TeamSession, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    Ok(TeamSession {
        server_url: get_meta_state(&c, KEY_SERVER_URL).unwrap_or_default(),
        token: get_meta_state(&c, KEY_TOKEN).unwrap_or_default(),
    })
}

/// Return the current user's identity (email) for the given server, so the UI can
/// show which account is logged in.
#[derive(serde::Serialize)]
pub struct TeamMe {
    pub email: String,
}

#[tauri::command]
pub async fn team_get_me(server_url: String, token: String) -> Result<TeamMe, String> {
    let url = server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{url}/auth/me"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("获取账号失败 {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(TeamMe {
        email: v["email"].as_str().unwrap_or("").to_string(),
    })
}

/// Return the email last logged in for a server (local `meta.auth_sessions`), so a
/// previously-synced server's account can be prefilled in the login form.
#[tauri::command]
pub fn team_get_server_email(db: State<'_, Db>, server_url: String) -> Result<Option<String>, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    Ok(get_auth_email(&c, &server_url))
}

// ---- S9 桌面侧（2026-09-23）：CRDT 血统 claim ----
//
// 与 `src/lib/platform/web.ts` 的 `claim_page_lineage` **成对**：同一端点
// （`POST {server}/lineage-claim`）、同一取配置口径、同一结果形状。
//
// ⚠️ 路径**没有 `/sync` 前缀**：服务端把 `sync_routes` 挂在根上（与 `/push` 同一形状）。
//    上游（TS 侧）第一版写成 `/sync/lineage-claim`，**部署后探针实测 404**
//    （`/lineage-claim` 回 401＝路由在、只是没带鉴权）⇒ 已于 `f45ab8c3` 改正。
//    本命令照改后的口径写：**跨仓路径这种东西上线后必须用真探针核一遍**。
//
// ⚠️ **两套 id 别混**（第 42 轮修的真 bug）：入参是**本地工作空间 id**（页所属那一个），
//    发出去的 `space_id` 必须是该工作空间档案里的**远端** `space_id`（服务端生成的 32 位十六进制）。
//    第一版把本地 id 直接当远端 space 发 ⇒ 服务端 `require_space` 查不到成员行 ⇒ **必然 403**；
//    而 403 又被读成 `denied` ⇒ 每张没本地状态的页在桌面上都会被拒建血统 ＋ 弹一句错话。
//    完整来龙去脉见 TS 侧 `src/lib/crdt/claimScope.ts` 文件头（那一份是口径的唯一说明处）。
//
// 为什么要有它：在此之前这条命令**只登记为 web 专属**（`scripts/check-web-commands.mjs`
// 的 `WEB_ONLY_COMMANDS`）⇒ 桌面侧 `claimVerdict` 永远拿不到端口 ⇒ 一直落"离线临时建"那
// 一支（**不报错**，但服务端的"首写者裁定"在桌面上从未生效）。接上它才是两侧同行为。

/// claim 的入参（与前端 `api.claimPageLineage({ workspace_id, page_id })` 成对）。
/// ⚠️ `workspace_id` 是**本地**工作空间 id —— 远端 `space_id` 由 `claim_config` 从档案里取。
#[derive(Deserialize)]
pub struct LineageClaimArgs {
    pub workspace_id: String,
    pub page_id: String,
}

/// claim 的结果形状 —— 与 `web.ts` 那一支**逐字对齐**（界面侧 `src/editor/Editor.tsx`
/// 按 `res.unavailable` / `res.granted` 读）。
#[derive(Serialize)]
pub struct LineageClaimResult {
    /// 只有服务端**真回了话**才有意义：`true` ＝ 本机是这一页的首写者。
    pub granted: bool,
    /// 只有"**问不到**"（没配同步／没选空间／网络不通／401／**403**／5xx／载荷读不懂）时才出现
    /// ⇒ 界面侧见到它就把这次 claim 当异常交给 `claimVerdict` 归一成 `unavailable`
    /// （离线临时建，照旧能写）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<bool>,
}

impl LineageClaimResult {
    /// 服务端**裁定过了**（拿到或没拿到都是裁定）。
    fn decided(granted: bool) -> Self {
        Self { granted, unavailable: None }
    }
    /// **问不到** —— 这不是错误，是"离线"那一支（离线可用性不能让路）。
    fn offline() -> Self {
        Self { granted: false, unavailable: Some(true) }
    }
}

/// ★ **纯函数**：把一次 HTTP 回话映射成结果 —— 判据只钉这一处，与前端 `crdt/claimClient.ts`
/// 的同一张表成对（改一边必须看另一边）：
///   ① 只有 `granted === true` 才算拿到（缺字段／别的类型 ⇒ denied，**不猜**）；
///   ② **403 ⇒ `offline`**（第 42 轮改）：服务端把"别人先 claim"表达成 **200 ＋ `granted:false`**，
///      把"你不是这个空间的成员／空间没选"表达成 **403** —— 两件不同的事。把 403 当 `denied`
///      会给用户一句错话（"另一台设备正在编辑"），还会让这台设备在这一页上**永远** `wait-for-remote`；
///   ③ 其余非 2xx（含 401／5xx）⇒ `offline`（＝"现在问不到"）；
///   ④ 2xx 但载荷读不懂 ⇒ 同样 `offline`（**不猜**成 granted）。
fn lineage_claim_verdict(status: u16, body: Option<&serde_json::Value>) -> LineageClaimResult {
    if !(200..300).contains(&status) {
        // 含 403（授权/配置）与 401/5xx（会话/服务）—— 都归"问不到"。
        return LineageClaimResult::offline();
    }
    match body {
        Some(v) => LineageClaimResult::decided(v["granted"] == serde_json::Value::Bool(true)),
        None => LineageClaimResult::offline(),
    }
}

/// 从库里取 claim 要用的三件（`server_url` / `token` / **远端 `space_id`**）。
///
/// **口径与 TS 侧 `resolveClaimScope` 完全一致**（两侧成对，改一边必须看另一边）：
///   · 只认**这一页所属工作空间**（`workspace_id`）那一条档案 —— 不是"第一个配了 `server_url` 的"；
///   · 档案缺 `server_url`，或**缺远端 `space_id`**（登录了但还没选空间）⇒ `None`
///     ⇒ 上层回 `unavailable`（**连请求都不发**：发出去只会换来 403，然后把 403 误读成裁定）；
///   · token 优先用 `auth_sessions` 里那份会话、退回档案里那份。
///
/// `device_id` 不在这里取（它不是"配置"，是应用级事实）—— 由命令自己 `device_id()` 拿，
/// 保证与同步请求用的是同一个 id（服务端看到的"设备"是同一台）。
///
/// ⚠️ `pub(crate)`：**桌面流通道**（`sync_stream.rs`）也用它来回答"这个工作空间该订哪台服务器/哪个
/// 远端空间"—— 与 claim 共用**同一处**解析（设计稿 §4.1："订谁复用既有解析"），不另写一份。
pub(crate) fn claim_config(c: &Connection, workspace_id: &str) -> Result<Option<(String, String, String)>, String> {
    let profile: Option<(String, String, String)> = c
        .query_row(
            "SELECT server_url, token, space_id FROM sync_profiles WHERE ws_id = ?1",
            rusqlite::params![workspace_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(match profile {
        None => None,
        Some((server_url, profile_token, space_id)) => {
            let server_url = server_url.trim().trim_end_matches('/').to_string();
            let space_id = space_id.trim().to_string();
            // 只填了地址还没选空间（登录+选空间是两步）是**正常中间态**，不是错误：
            // 但那一步的请求必然是 403 ⇒ 干脆不发。
            if server_url.is_empty() || space_id.is_empty() {
                return Ok(None);
            }
            let token = get_auth_token(c, &server_url).unwrap_or(profile_token);
            Some((server_url, token, space_id))
        }
    })
}

/// 冲刺 S9 桌面侧：把"这一页的首条 CRDT 血统归谁"问同步服务（`POST /lineage-claim`）。
///
/// 与 web 侧（`src/lib/platform/web.ts` 的 `claim_page_lineage`）同端点、同口径；
/// 服务端那一侧是 `shuyonote-sync-server` 的 `sync::lineage_claim`。
///
/// ⚠️ **不许对"正常情况"抛异常**（2026-09-23 的教训：第 38 轮浏览器门禁抓到
/// `[web] invoke error claim_page_lineage` —— 没有同步配置时抛异常会被平台 invoke 层记成一条
/// error）。所以"没有同步配置"、"没选空间"与"网络不通"都用**结果标记**回（`offline()`）。
/// 只有**真出了不该出的错**（库读不了）才 `Err` —— 那是 bug，要响。
#[tauri::command]
pub async fn claim_page_lineage(db: State<'_, Db>, args: LineageClaimArgs) -> Result<LineageClaimResult, String> {
    let (token, space_id, device_id, effective) = {
        let c = db.0.lock().expect("db mutex poisoned");
        match claim_config(&c, &args.workspace_id)? {
            // 没配同步／没选空间都是**正常情况**（本机就该走"离线"那一支）⇒ 不抛。
            None => return Ok(LineageClaimResult::offline()),
            Some((server_url, token, space_id)) => {
                // ★ 甲-1 接线：`claim_config` 手上只有 `(space_id, server_url)`（不是 `SyncProfile`）
                //   ⇒ 基址由 `effective_base_for` 解析（局域网发现到的中枢优先）。
                let effective = effective_base_for(&c, &space_id, &server_url);
                (token, space_id, device_id(&c).unwrap_or_default(), effective)
            }
        }
    };
    // 没发现到对端 ⇒ 逐字节就是配置地址；`effective_base_for` 只在配置地址为空时给 `None`
    //（那条路 `claim_config` 已经挡掉了）⇒ 这里`None` 等同于"没有地址可发"。
    let Some(base) = effective else {
        return Ok(LineageClaimResult::offline());
    };
    // 凭证仍按**配置地址**取（`claim_config` 就是这么取的），只有请求地址换档。
    let url = lineage_claim_url(&base);
    let client = reqwest::Client::new();
    let mut req = client.post(&url).json(&serde_json::json!({
        // ★ **远端** space id（档案里那一个），不是 `args.workspace_id`。
        "space_id": space_id,
        "page_id": args.page_id,
        "device_id": device_id,
    }));
    if !token.is_empty() {
        req = req.bearer_auth(&token);
    }
    // 网络不通／超时／DNS 失败 ⇒ 同为"问不到"（离线那一支），**不抛**。
    let resp = match req.send().await {
        Ok(r) => r,
        Err(_) => return Ok(LineageClaimResult::offline()),
    };
    let status = resp.status().as_u16();
    // 载荷读不懂时 `None` ⇒ `lineage_claim_verdict` 归 `offline`（**不猜**成 granted）。
    let body: Option<serde_json::Value> = resp.json().await.ok();
    Ok(lineage_claim_verdict(status, body.as_ref()))
}

// ─────────────────────── ③ 0b（2026-09-24）：公开材料的**推**与**取**

/// ③ 0b 的载荷：**本地**工作空间 id；远端 space id 由同步档案解析（与 `claim_page_lineage` 同口径）。
#[derive(serde::Deserialize)]
pub struct SpaceKeyringArgs {
    pub workspace_id: String,
    /// 取回时是否允许**覆盖**本机已有的公开材料（默认 false）。
    ///
    /// ⚠️ 为什么要这个开关：本机已经有袋子时覆盖它是**危险动作** —— 别的设备轮换过之后，
    /// 服务端那一份是新的、而本机这一份才可能是能开当前库的那一把；闷头覆盖会让本机
    /// **打不开自己的空间**。所以默认拒绝并把这件事说出来，要覆盖必须显式传 `true`。
    #[serde(default)]
    pub overwrite: bool,
}

/// ③ 0b 的结果。**"正常的不顺利"不抛异常**（与 `claim_page_lineage` 同一纪律：
/// 没配同步 / 服务端上没有 / 网络不通都不是 bug，抛出去会被平台 invoke 层记成一条 error）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SpaceKeyringResult {
    /// `ok` / `not_configured` / `no_material` / `not_on_server` / `already_local` / `offline` / `rejected`
    pub outcome: String,
    /// `ok` 时是材料的字节数。
    pub bytes: usize,
    /// 服务端 HTTP 状态码（没走到服务端 ⇒ 0）。
    pub status: u16,
    /// 一句**人话**（说清下一步该做什么）。
    pub message: String,
}

impl SpaceKeyringResult {
    fn plain(outcome: &str, message: &str) -> Self {
        Self {
            outcome: outcome.to_string(),
            bytes: 0,
            status: 0,
            message: message.to_string(),
        }
    }
    fn ok(bytes: usize, status: u16, message: String) -> Self {
        Self {
            outcome: "ok".to_string(),
            bytes,
            status,
            message,
        }
    }
    fn rejected(status: u16) -> Self {
        Self {
            outcome: "rejected".to_string(),
            bytes: 0,
            status,
            message: keyring_status_message(status),
        }
    }
}

/// 状态码 ⇒ **可操作**的人话（只照着服务端实际会回的那几个说，**不猜**"为什么"）。
fn keyring_status_message(status: u16) -> String {
    match status {
        401 => "同步服务说这个身份无效（401）：先重新登录 / 重绑这个空间的同步，再试一次".to_string(),
        403 => "同步服务说你不该动这个空间的公开材料（403）：改它会影响**别的设备还能不能解开**，所以要管理员 / 所有者".to_string(),
        404 => "同步服务上没有这个空间（404）".to_string(),
        413 => "这一份公开材料超过了服务端的上限（413）—— 它现在只有几 KB，先看是不是推错了东西".to_string(),
        _ => format!("同步服务拒绝了这一次（{status}）"),
    }
}

/// PUT 那一半 —— **可被判据直接驱动**（不碰 `State`，也不碰库）。
pub(crate) async fn http_put_keyring(
    client: &reqwest::Client,
    server_url: &str,
    token: &str,
    remote_space_id: &str,
    material: &str,
) -> SpaceKeyringResult {
    let url = format!(
        "{}/spaces/{}/keyring",
        server_url.trim_end_matches('/'),
        remote_space_id
    );
    let mut req = client.put(&url).json(&serde_json::json!({ "keyring_json": material }));
    if !token.is_empty() {
        req = req.bearer_auth(token);
    }
    match req.send().await {
        Err(e) => SpaceKeyringResult::plain(
            "offline",
            &format!("没能连上同步服务（{e}）：材料还在本机，网络好了再推一次"),
        ),
        Ok(resp) => {
            let status = resp.status().as_u16();
            if (200..300).contains(&status) {
                SpaceKeyringResult::ok(
                    material.len(),
                    status,
                    format!(
                        "已把这一份公开材料（{} 字节）交给同步服务；第二台设备从此只凭主口令就能解开",
                        material.len()
                    ),
                )
            } else {
                SpaceKeyringResult::rejected(status)
            }
        }
    }
}

/// GET 那一半：返回 `(读数, 拿到的材料原文)`（没拿到时第二个是 `None`）。
pub(crate) async fn http_get_keyring(
    client: &reqwest::Client,
    server_url: &str,
    token: &str,
    remote_space_id: &str,
) -> (SpaceKeyringResult, Option<String>) {
    let url = format!(
        "{}/spaces/{}/keyring",
        server_url.trim_end_matches('/'),
        remote_space_id
    );
    let mut req = client.get(&url);
    if !token.is_empty() {
        req = req.bearer_auth(token);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                SpaceKeyringResult::plain(
                    "offline",
                    &format!("没能连上同步服务（{e}）：这一次没取到，本机什么都没改"),
                ),
                None,
            )
        }
    };
    let status = resp.status().as_u16();
    if status == 404 {
        return (
            // ⚠️ 别用 `plain()` 造这一支：它把 `status` 填 0，而这里**真的**从服务端收到了 404 ——
            //    "没到服务端"与"服务端说没有"是两件事，读数必须分得开（判据当场抓过这一处）。
            SpaceKeyringResult {
                outcome: "not_on_server".to_string(),
                bytes: 0,
                status,
                message: "这台服务器上还没有这个空间的公开材料（404）：先在原来那台设备上推一次"
                    .to_string(),
            },
            None,
        );
    }
    if !(200..300).contains(&status) {
        return (SpaceKeyringResult::rejected(status), None);
    }
    match resp.json::<serde_json::Value>().await {
        Ok(v) => match v["keyring_json"].as_str() {
            Some(s) if !s.trim().is_empty() => {
                let s = s.to_string();
                let r = SpaceKeyringResult::ok(
                    s.len(),
                    status,
                    format!("从服务端取回了公开材料（{} 字节）", s.len()),
                );
                (r, Some(s))
            }
            // 2xx 但载荷里没有那一列 ⇒ **不猜**成空材料（空材料写进本机比不写危险得多）
            _ => (
                SpaceKeyringResult {
                    outcome: "rejected".to_string(),
                    bytes: 0,
                    status,
                    message: "服务端的回话里没有 keyring_json（读不懂就不猜，本机什么都没改）"
                        .to_string(),
                },
                None,
            ),
        },
        Err(_) => (
            SpaceKeyringResult {
                outcome: "rejected".to_string(),
                bytes: 0,
                status,
                message: "服务端的回话不是 JSON（本机什么都没改）".to_string(),
            },
            None,
        ),
    }
}

/// ③ 0b 桌面侧：把本机这一份**公开材料**推到同步服务（`PUT /spaces/{id}/keyring`）。
///
/// 什么时候用：在这台设备上开启了（或轮换了）加密之后，把它交给自己那台服务端 ——
/// 这样**第二台设备**只凭主口令就能解开，不必再手工拷贝那份 JSON。
/// ⚠️ 推的是"钥匙袋"里**可以公开的那一半**（盐 / KDF 参数 / 被口令包裹的盒子）；
/// 服务端**解不开**它（没有口令推不出主密钥，没有主密钥开不了盒子）。
/// ⚠️ 但它仍然是一份**元数据**：服务端因此能看到你有几个盒子、以及它们的**本地空间 id**
/// （不是内容、不是钥匙）—— 别在文档里写成"服务端什么都看不到"。
#[tauri::command]
pub async fn push_space_keyring(
    db: State<'_, Db>,
    args: SpaceKeyringArgs,
) -> Result<SpaceKeyringResult, String> {
    let (server_url, token, remote_space_id, material) = {
        let c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
        let Some((server_url, token, space_id)) = claim_config(&c, &args.workspace_id)? else {
            return Ok(SpaceKeyringResult::plain(
                "not_configured",
                "这个空间还没绑好同步（缺服务地址，或登录了还没选空间）：先在上面绑好，再推公开材料",
            ));
        };
        let Some(material) = crate::space_crypto::stored_material(&c)? else {
            return Ok(SpaceKeyringResult::plain(
                "no_material",
                "本机还没有公开材料：先在这个空间上「开启加密」（那一步会建钥匙袋）",
            ));
        };
        (server_url, token, space_id, material)
    };
    Ok(
        http_put_keyring(
            &reqwest::Client::new(),
            &server_url,
            &token,
            &remote_space_id,
            &material,
        )
        .await,
    )
}

/// ③ 0b 桌面侧：从同步服务**取回**公开材料并**装进本机**（第二台设备的那一步）。
///
/// ⚠️ 默认**不覆盖**本机已有的那一份（回 `already_local`）：覆盖是危险动作，理由见 `SpaceKeyringArgs`。
/// ⚠️ 取回之后**不会自动解锁**：主口令仍然由人来输 —— 这正是"服务端拿不到你的钥匙"的原因。
#[tauri::command]
pub async fn pull_space_keyring(
    db: State<'_, Db>,
    args: SpaceKeyringArgs,
) -> Result<SpaceKeyringResult, String> {
    let (server_url, token, remote_space_id) = {
        let c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
        let Some((server_url, token, space_id)) = claim_config(&c, &args.workspace_id)? else {
            return Ok(SpaceKeyringResult::plain(
                "not_configured",
                "这个空间还没绑好同步（缺服务地址，或登录了还没选空间）：先绑好再来取",
            ));
        };
        (server_url, token, space_id)
    };
    let (result, body) = http_get_keyring(
        &reqwest::Client::new(),
        &server_url,
        &token,
        &remote_space_id,
    )
    .await;
    let Some(json) = body else { return Ok(result) };
    let c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    let report = crate::space_crypto::adopt_material(&c, &json, args.overwrite)?;
    if report.already_local {
        return Ok(SpaceKeyringResult::plain(
            "already_local",
            "本机已经有这一份公开材料了，所以**没有动它**；确实要用服务端那一份覆盖，请显式选「覆盖本机」",
        ));
    }
    Ok(SpaceKeyringResult {
        outcome: "ok".to_string(),
        bytes: json.len(),
        status: result.status,
        message: format!(
            "已取回并装进本机（{} 个盒子，{} 字节）；现在输入主口令就能解开这个空间",
            report.spaces,
            json.len()
        ),
    })
}

// ── B 片 ①-a：换设备的**文本搬运**（复制/粘贴、存/读文件）──────────────────────────────
//
// 路线 ①（owner 2026-09-25 拍板）：不做 6 位短码 ⇒ **不引任何密码学实现**；
// "来源真实性"由**比对码**兜（见 `pairing::check_code` 与 `verify_confirm_code`）。
// ⚠️ 这里**只搬运**：载荷本身（公开材料 ＋ 设备标识）**不含任何新秘密** ——
// 它今天就在服务端上躺着。真正要防的是**掉包**，所以 `confirmed_check_code` 那条不是装饰。

/// B 片 ①-a：**换设备的载体**（粘贴的文本 / 存成文件的那份内容）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct PairingImportArgs {
    /// 另一端给出的配对载荷原文。
    pub text: String,
    /// 用户**在另一端念/抄下来的比对码**（可选）。
    ///
    /// ⚠️ 传了就必须与这段载荷算出来的**逐位相同**，否则拒绝 —— 这是路线 ① 唯一能挡住
    /// "换码"的机制。两台设备就在一起、用眼睛对屏幕看的那条路可以不传。
    #[serde(default)]
    pub confirmed_check_code: Option<String>,
    /// 本机已有公开材料时是否允许覆盖（默认 false）。理由与 `SpaceKeyringArgs::overwrite` 同。
    #[serde(default)]
    pub overwrite: bool,
}

/// B 片 ①-a 产出侧读数。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PairingExportResult {
    /// `ok` / `no_material`
    pub outcome: String,
    /// 配对载荷原文（紧凑 JSON）。`no_material` 时是空串。
    pub text: String,
    /// **比对码**：另一端算出来的必须与这个逐位相同。
    pub check_code: String,
    pub bytes: usize,
    /// 袋子里有几个盒子。
    pub spaces: usize,
    /// 本机设备标识（给界面显示"来自哪台设备"）。**不是秘密**（服务端与局域网公告都用它）。
    pub device_id: String,
    /// 这段载荷**装得进一张二维码**吗。装不下时 `message` 里会说明走文本/拆码。
    pub qr_fits: bool,
    /// 装得下时：**一张二维码的 SVG**（前端当 data URI 贴进 `<img>`）；装不下 ⇒ `None`。
    ///
    /// ⚠️ **装不下就一定是 `None`** —— 绝不画一张装不下的码（扫出来是残缺材料，见 `pairing::qr_svg`）。
    pub qr_svg: Option<String>,
    pub message: String,
}

/// B 片 ①-a 采纳侧读数。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PairingImportResult {
    /// `ok` / `already_local` / `rejected`
    pub outcome: String,
    /// 这段载荷的比对码 —— 界面**必须把它显示出来**让人核对（`rejected` 时为空）。
    pub check_code: String,
    pub spaces: usize,
    /// `already_local` 时：本机已有的空间（给人看"你本来有这些"）。
    pub local_spaces: Vec<String>,
    /// `already_local` 时：覆盖之后会**失去**的空间 —— 最贵的那一半
    /// （失去的空间＝那台设备再也开不开它自己的库）。
    pub would_lose: Vec<String>,
    pub message: String,
}

/// B 片 ①-a 桌面侧：**导出**一段配对载荷（换设备那一步的"给出去"）。
///
/// ⚠️ 产出的载荷**不含任何秘密**（公开材料本来就可以公开）；它唯一的作用是让第二台设备
/// 能解开自己的空间 —— 而**主口令仍然由人来输**（这正是"服务端拿不到你的钥匙"的原因）。
#[tauri::command]
pub fn pairing_export(db: State<'_, Db>) -> Result<PairingExportResult, String> {
    let c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    let Some(material) = crate::space_crypto::stored_material(&c)? else {
        return Ok(PairingExportResult {
            outcome: "no_material".to_string(),
            text: String::new(),
            check_code: String::new(),
            bytes: 0,
            spaces: 0,
            device_id: String::new(),
            qr_fits: false,
            qr_svg: None,
            message: "本机还没有钥匙袋（公开材料）⇒ 没有东西可以配对过去。\
                      先在本机启用加密、或先从别处取回一份，再来换设备。"
                .to_string(),
        });
    };
    // 设备指纹取应用级事实 `device_id`（与局域网公告用的是同一个值，**非秘密**）。
    // ✅ **2026-09-25 拍板（owner「按建议执行」）**：`fp` 就用**设备标识**，不用"设备密钥材料的指纹"。
    //    理由：① 它已经在服务端与局域网公告里流通，不是新暴露面；② 稳定 —— 轮换钥匙不会让用户
    //    看到"设备名变了"；③ 它要挡的是**掉包**（这段码是不是你那台设备给的），而不是"同一台设备
    //    换了钥匙"那种更细的区分。⚠️ 真需要后者时（例如"钥匙轮换后要认出还是这台机器"），
    //    那是**另一条**判据、要另立一处字段——**不要**把这里的语义悄悄改成密钥材料指纹。
    let device = device_id(&c)?;
    let payload = crate::pairing::payload_from_material(&material, &device)?;
    let text = crate::pairing::encode_payload(&payload)?;
    let check_code = crate::pairing::check_code(&text);
    let spaces = crate::keyring::Keyring::from_json(&material)
        .map(|k| k.spaces.len())
        .unwrap_or(0);
    let qr_fits = crate::pairing::fits_single_qr(&text);
    // ⚠️ 装得下却画不出来 = **真问题**（只有编码器坏了这一种可能）⇒ 不静默当 None，直接报错。
    let qr_svg = if qr_fits {
        Some(crate::pairing::qr_svg(&text).map_err(|e| format!("二维码没画出来：{e}"))?)
    } else {
        None
    };
    let mut message = format!(
        "把下面这段配对码交给第二台设备（{} 个空间，{} 字节）。\
         它**不是秘密**，但请只交给你自己那台设备 —— 收下它的人才可能解开你的空间。",
        spaces,
        text.len()
    );
    if !qr_fits {
        if let Some(warn) = crate::pairing::qr_capacity_error(&text) {
            message.push('\n');
            message.push_str(&warn);
        }
    }
    // ⚠️ 长度要**在移动进返回值之前**取好（结构体字面量按书写顺序求值）。
    let bytes = text.len();
    Ok(PairingExportResult {
        outcome: "ok".to_string(),
        text,
        check_code,
        bytes,
        spaces,
        device_id: device,
        qr_fits,
        qr_svg,
        message,
    })
}

/// B 片 ①-a 桌面侧：**采纳**一段配对载荷（换设备那一步的"收下来"）。
///
/// 三条都**先说清、再动手**：载荷读不懂 / 比对码对不上 ⇒ 拒绝，**本机一个字节都不改**；
/// 本机已有材料且没给 `overwrite` ⇒ 回 `already_local` **并把"会失去哪些空间"摆出来**。
#[tauri::command]
pub fn pairing_import(db: State<'_, Db>, args: PairingImportArgs) -> Result<PairingImportResult, String> {
    // ① 解码（严格：版本 / 字段白名单 / 材料得像钥匙袋 —— 见 `pairing::decode_payload`）
    let payload = match crate::pairing::decode_payload(&args.text) {
        Ok(p) => p,
        Err(e) => {
            return Ok(PairingImportResult {
                outcome: "rejected".to_string(),
                check_code: String::new(),
                spaces: 0,
                local_spaces: Vec::new(),
                would_lose: Vec::new(),
                message: format!("这段配对码没用上（**本机一个字节都没改**）：{e}"),
            })
        }
    };
    // ② 比对码（传了就必须对得上 —— 路线 ① 唯一的防换码手段）
    let check_code = match crate::pairing::verify_confirm_code(&args.text, args.confirmed_check_code.as_deref()) {
        Ok(code) => code,
        Err(e) => {
            return Ok(PairingImportResult {
                outcome: "rejected".to_string(),
                check_code: crate::pairing::check_code(&args.text),
                spaces: 0,
                local_spaces: Vec::new(),
                would_lose: Vec::new(),
                message: e,
            })
        }
    };
    // ③ 采纳（`adopt_material` 自己保证：拒绝/出错时一个字节都不改）
    let c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    let report = crate::space_crypto::adopt_material(&c, &payload.material, args.overwrite)?;
    if report.already_local {
        let message = if report.would_lose.is_empty() {
            format!(
                "本机已经有这一份公开材料（{} 个空间），覆盖**不会失去**任何空间。\
                 确认要用这一段覆盖，就再来一次并选「覆盖本机」。",
                report.local_spaces.len()
            )
        } else {
            format!(
                "本机已经有这一份公开材料。覆盖会**失去**这些空间：{} —— \
                 覆盖之后那台设备**再也开不开它自己的库**。\
                 确认要覆盖，就再来一次并选「覆盖本机」。",
                report.would_lose.join("、")
            )
        };
        return Ok(PairingImportResult {
            outcome: "already_local".to_string(),
            check_code,
            spaces: 0,
            local_spaces: report.local_spaces,
            would_lose: report.would_lose,
            message,
        });
    }
    Ok(PairingImportResult {
        outcome: "ok".to_string(),
        check_code,
        spaces: report.spaces,
        local_spaces: Vec::new(),
        would_lose: Vec::new(),
        message: format!(
            "已装进本机（{} 个盒子）；现在输入主口令就能解开这个空间",
            report.spaces
        ),
    })
}

/// List recent sync-history entries (newest first).
#[tauri::command]
pub fn list_sync_history(db: State<'_, Db>, limit: Option<usize>) -> Result<Vec<SyncHistoryEntry>, String> {
    let limit = limit.unwrap_or(20);
    let c = db.0.lock().expect("db mutex poisoned");
    let mut stmt = c
        .prepare("SELECT ws_id, ws_name, at, pushed, pulled, ok, message, items FROM sync_history ORDER BY at DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![limit as i64], |r| {
            let items_json: String = r.get(7)?;
            let items: Vec<SyncItem> = if items_json.is_empty() {
                Vec::new()
            } else {
                serde_json::from_str(&items_json).unwrap_or_default()
            };
            Ok(SyncHistoryEntry {
                ws_id: r.get(0)?,
                ws_name: r.get(1)?,
                at: r.get(2)?,
                pushed: r.get(3)?,
                pulled: r.get(4)?,
                ok: r.get(5)?,
                message: r.get(6)?,
                items,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Clear all sync-history entries (local meta).
#[tauri::command]
pub fn clear_sync_history(db: State<'_, Db>) -> Result<(), String> {
    let c = db.0.lock().expect("db mutex poisoned");
    c.execute("DELETE FROM sync_history", []).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct SyncHistoryEntry {
    pub ws_id: String,
    pub ws_name: String,
    pub at: i64,
    pub pushed: i64,
    pub pulled: i64,
    pub ok: bool,
    pub message: String,
    pub items: Vec<SyncItem>,
}


async fn do_push(
    db: &State<'_, Db>,
    profile: &SyncProfile,
) -> Result<(usize, i64, Vec<SyncItem>), String> {
    let (device_id, last_pushed, changes): (String, i64, Vec<OutgoingChange>) = {
        let c = db.0.lock().expect("db mutex poisoned");
        security::sync_gate(&c)?;
        let device_id = device_id(&c)?;
        let last_pushed = profile.last_pushed_seq;
        let mut stmt = c
            .prepare(
                "SELECT device_seq, entity, entity_id, op, payload, updated_at
                 FROM changes WHERE device_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT 500",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![device_id, last_pushed], |row| {
                Ok(OutgoingChange {
                    device_seq: row.get(0)?,
                    entity: row.get(1)?,
                    entity_id: row.get(2)?,
                    op: row.get(3)?,
                    payload: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let changes = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        // ★ 每一段载荷**都**过 `encrypt_payload`（**不许**先拿 `key_if_enabled().is_some()` 当闸门）：
        //   那个写法在"袋里有它、但会话没解锁/盒子拿不到"时会**跳过加密** ⇒ 明文上云（静默降级）。
        //   `encrypt_payload` 自己判三种出口：明文空间 ⇒ 原样；有盒子 ⇒ 加密；
        //   密文库而袋里没有它（应用级加密的存量库）⇒ `Err`（整条推不出去，这是对的）。
        let mut out = Vec::with_capacity(changes.len());
        for mut ch in changes {
            if let Some(p) = ch.payload.take() {
                ch.payload = Some(security::encrypt_payload(&c, &p)?);
            }
            out.push(ch);
        }
        (device_id, last_pushed, out)
    };

    if changes.is_empty() {
        return Ok((0, last_pushed, Vec::new()));
    }
    // 收集本次 push 的实体明细（供「同步明细」显示）。
    let items: Vec<SyncItem> = changes
        .iter()
        .map(|ch| {
            let title = item_title(&ch.entity, ch.payload.as_ref());
            SyncItem { entity: ch.entity.clone(), entity_id: ch.entity_id.clone(), op: ch.op.clone(), dir: "push".to_string(), title }
        })
        .collect();
    // 本次 push 将同步的 page 实体 id（在 changes 被 move 进 PushRequest 前先收集）。
    let pushed_page_ids: Vec<String> = changes
        .iter()
        .filter(|ch| ch.entity == "page")
        .map(|ch| ch.entity_id.clone())
        .collect();

    let client = reqwest::Client::new();
    // ★ 甲-1 接线：基址走 `effective_base`（局域网中枢优先；没发现到对端 ⇒ 与今天逐字节相同）。
    // ⚠️ 只有**请求地址**换档；凭证仍然按**配置地址**取（`auth_sessions` 是按配置的
    //    `server_url` 存的，拿局域网地址去查必然查不到 ⇒ 会静默退化成档案里那份旧 token）。
    let base = { let c = db.0.lock().expect("db mutex poisoned"); effective_base(&c, profile) };
    let mut req = client
        .post(push_url(&base))
        .json(&PushRequest { device_id, space_id: profile.space_id.clone(), changes });
    let token = { let c = db.0.lock().expect("db mutex poisoned"); get_auth_token(&c, &profile.server_url).unwrap_or_else(|| profile.token.clone()) };
    if !token.is_empty() {
        req = req.bearer_auth(&token);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            "同步失败：会话已失效，请重新登录".to_string()
        } else {
            format!("同步服务返回错误: {}", resp.status())
        });
    }

    // On success advance last_pushed_seq to the max local seq pushed.
    let (max_seq, count): (i64, usize) = {
        let c = db.0.lock().expect("db mutex poisoned");
        let max_seq: i64 = c
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM changes WHERE seq > ?1",
                params![last_pushed],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM changes WHERE seq > ?1",
                params![last_pushed],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        set_profile_field(&c, &profile.ws_id, "last_pushed_seq", max_seq)?;
        // 本次 push 已同步到服务端 → 清这些 page 的 dirty（标记无未同步改动）。
        for pid in &pushed_page_ids {
            let _ = c.execute("UPDATE pages SET dirty = 0 WHERE id = ?1", params![pid]);
        }
        (max_seq, count as usize)
    };

    Ok((count, max_seq, items))
}

/// 一条变更**应用失败**时的两类处置（2026-09-23，Windows 侧；与 Web `doPull` 的 catch 对齐）。
///
/// 改前的写法是 `let unresolved = apply_upsert(...)?` —— **一条坏变更中止整批**、游标不前进
/// ⇒ 只要服务端还在返回这一条，它就**永久堵住后面所有变更**（Web 侧同处的注释记的就是这条 livelock）。
/// Web 侧已改成「归档 ＋ 前进」：能定位到页面就存进「待取回的远端版本」（用户可裁决、可收场），
/// 定位不到也至少留一条 warn，而 `maxSeq` **照旧推进**。这里把 Rust 侧做成同口径。
enum ApplyFailure {
    /// **解密失败**：整批中止、游标不前进（**故意不改**）—— 各设备 E1 口令/密钥不一致时，
    /// "继续跑"只会把读不了的变更**静默消费掉**；`do_pull` 另有一道 `prescan_payload_formats` 整批预扫。
    Fatal(String),
    /// 其余（落库失败 / 附件行自愈失败…）：**归档 ＋ 前进 ＋ warn**。
    Recoverable(String),
}

impl From<String> for ApplyFailure {
    fn from(e: String) -> Self {
        ApplyFailure::Recoverable(e)
    }
}

/// 把一批**已取回**的变更应用到本地（**不碰网络**）。
///
/// 为什么抽出来：`do_pull` 的另一半是 HTTP / 令牌 / 密文预扫，单测跑不了；而
/// "**一条坏变更不许中止整批**"（**归档 ＋ 前进 ＋ warn**，与 Web 侧 `doPull` 的 catch 逐条对应）
/// 这条政策必须有判据能直接钉住 —— 抽成这个函数就是为了它。
///
/// 失败分类见 `ApplyFailure`：`Fatal`（解密失败）整批中止；`Recoverable` 归档 ＋ 前进。
pub(crate) fn apply_pulled_changes(
    c: &Connection,
    changes: Vec<IncomingChange>,
    last_pulled: i64,
    now: i64,
) -> Result<PulledApply, String> {
let mut max_pulled = last_pulled;
let mut count: usize = 0;
let mut items: Vec<SyncItem> = Vec::new();
let mut conflicts: Vec<SyncConflict> = Vec::new();
// ★ 阶段 1：本轮**留下未裁决块级冲突**的页面（按页面去重 —— 同一页一轮里可能被应用多次）。
// ⚠️ 与上面那个 `conflicts`（页级 dirty 提示）**含义不同、分开报**：那个要用户选"保留本地/采用远端"，
// 这个已经有逐块留痕（`page_conflicts`），只需让用户知道"这一页有未裁决冲突"。
let mut unresolved_page_ids: Vec<String> = Vec::new();
// ★ B 方案（2026-09-22）：本轮**页级保留本地**的页面（按页面去重）。这些页面的远端那一版
// 已经存进 `pending_remote_pages`（本地表）⇒ 界面要能告诉用户"有 N 页等你裁决"，
// 而不是像修好之前那样"游标过去了、什么都没有"（取证文件 §3.2）。
let mut pending_remote_ids: Vec<String> = Vec::new();
// ★ F7b（2026-09-25）：本轮收到**本端不认识的「对象种类 ＋ 动作」搭配**（去重后的 `entity:op`）。
// 见下面 `_` 那一支的说明 —— 以前那里是无条件 `_ => {}`：**照旧忽略，但不再无声**。
let mut unrecognized: Vec<String> = Vec::new();
    for change in changes {
        let title = item_title(&change.entity, change.payload.as_ref());
        items.push(SyncItem { entity: change.entity.clone(), entity_id: change.entity_id.clone(), op: change.op.clone(), dir: "pull".to_string(), title });
        // 这一条**能归档的那一版**（解密后的 payload JSON）：若后面应用失败，用它进「待取回的远端版本」
        //（与 Web 的 `pageRowOfChangeForStash` 同口径：只有 page/非 delete 且能解析出 id 才谈得上归档）。
        let mut stash_source: Option<String> = None;
        // ★ 一条变更的"应用"整个包进闭包：内部照旧用 `?`，失败时由下面的统一策略处置
        //   —— `Fatal` 中止整批（解密），`Recoverable` 归档 ＋ 前进（其余）。
        let applied: Result<(), ApplyFailure> = (|| {
            match (change.entity.as_str(), change.op.as_str()) {
            ("page", "upsert") => {
                if let Some(payload) = &change.payload {
                    // Decrypt if E2EE is enabled (passthrough otherwise).
                    // ⚠️ 解密失败是 `Fatal`（整批中止、游标不前进）—— 与改前一致，见 `ApplyFailure`。
                    let plain = security::decrypt_payload(&c, payload)
                        .map_err(|e| ApplyFailure::Fatal(format!("同步解密失败：{e}（可能各设备 E1 口令/密钥不一致，已停止以免静默丢数据）")))?;
                    if let Ok(page) = serde_json::from_str::<PageDetail>(&plain) {
                        // 能解析出 id ⇒ 万一后面应用失败，用**这一版**归档（与 Web 的 pageRowOfChangeForStash 同口径）
                        stash_source = Some(plain.clone());
                        // ★ §11.4 收口（第 42 轮）：载荷里带了 **CRDT 状态** ⇒ **收到就收进旁路表**。
                        //   与"最后用谁的版本"无关（`KeptLocal` 那一支的状态同样不能丢）；真正的合并在
                        //   **打开页面**时由 WebView 里那份唯一实现（`mergeRemotePageState`）做。
                        absorb_incoming_crdt_state(&c, &page.id, change.seq, &plain, now)?;
                        // P0.1 冲突提示：应用远端变更前，若本地该页有未推送改动
                        // （dirty=1），说明"本地未同步 + 服务端有新 seq"——记为冲突，
                        // 交给前端提示用户选择（保留本地 / 采用服务端）。
                        let local_dirty: i64 = c
                            .query_row("SELECT dirty FROM pages WHERE id = ?1", params![page.id], |r| r.get(0))
                            .unwrap_or(0);
                        if local_dirty != 0 {
                            conflicts.push(SyncConflict { entity_id: page.id.clone(), title: page.title.clone() });
                        }
                        // ★ 丙-③（2026-09-25）：**页级胜负先看戳** —— 判定只有一处（`hlc::verdict`）。
                        //   两边都带戳 ⇒ 戳说了算；**缺一边（含"带了但读不出来"）⇒ 原样走今天那条路**，
                        //   并**留痕**：不留痕的话，"为什么这一笔按老规矩判"就只能靠猜。
                        let remote_stamp = crate::hlc::stamp_of_payload(&plain);
                        // ★★ 丙-③ **收侧先把收到的戳并进本机时钟**（HLC 的 `observe`），再判胜负。
                        //   为什么不能省：`verdict` 只回答"这一笔谁赢"，它**不推进本机时钟** ——
                        //   不 observe 的话，对端时钟快时本机随后的一次编辑会拿到小于刚收到那枚戳的戳
                        //   ⇒ "因果上更晚的改动"反而被判给远端（丢更新）。
                        //   ⚠️ 与"这一笔谁赢"无关：**输了的那一枚同样要 observe**（否则下一个本地编辑
                        //      还会栽在它上面）；⚠️ 与 `record_page_upsert` 共用同一格 KV，跨重启单调照旧。
                        //   ⚠️ 缓存性质：写不进去只影响后续判序，**不许**因此让这一笔失败、更不许连坐整批。
                        //   判据：`absorbing_a_fast_peers_stamp_pushes_the_local_clock_past_it`。
                        if let crate::hlc::PayloadStamp::Ok(s) = &remote_stamp {
                            if let Err(e) = observe_remote_stamp(&c, s, now) {
                                eprintln!(
                                    "[sync] page {} 的远端戳没并进本机时钟（只影响后续判序，这一笔照旧）：{e}",
                                    page.id
                                );
                            }
                        }
                        let local_stamp_kv = page_stamp(&c, &page.workspace_id, &page.id)
                            .map_or(crate::hlc::PayloadStamp::Missing, crate::hlc::PayloadStamp::Ok);
                        let stamp_wins = match crate::hlc::verdict(&local_stamp_kv, &remote_stamp) {
                            crate::hlc::Verdict::ByStamp { remote_wins } => Some(if remote_wins {
                                crate::doc_content::StampWins::Remote
                            } else {
                                crate::doc_content::StampWins::Local
                            }),
                            crate::hlc::Verdict::Today(why) => {
                                eprintln!(
                                    "[sync] page {} 这一笔按**今天那条路**判（{why}）—— \
                                     戳不全时不许按戳判（否则升级方会永久压过未升级方的后改）",
                                    page.id
                                );
                                None
                            }
                        };
                        let unresolved = apply_upsert(&c, &page, change.seq, stamp_wins)?;
                        match unresolved {
                            UpsertApply::Applied { unresolved } => {
                                if unresolved > 0 && !unresolved_page_ids.contains(&page.id) {
                                    unresolved_page_ids.push(page.id.clone());
                                }
                                // ★ 丙-③：远端这一版**已经应用** ⇒ "本页当前那一版"就是它。
                                //   ⚠️ 远端**没带戳**而本地原来有一枚 ⇒ 要把那枚**清掉**：留着它就是一个
                                //   指向"已经不是当前版本"的旧戳，下一轮拿它比会判错边（那一错就是丢更新）。
                                //   清掉之后下一笔自然退回今天那条路（缺一边）——**安全的方向**。
                                //   ⚠️ 这一格是**缓存性质**的：写不进去只影响下一轮判序，**不许**因此让
                                //   已经落库的这一笔失败（更不许连坐整批）。
                                let write_back = match (&remote_stamp, &local_stamp_kv) {
                                    (crate::hlc::PayloadStamp::Ok(s), _) => {
                                        set_page_stamp(&c, &page.workspace_id, &page.id, s)
                                    }
                                    (_, crate::hlc::PayloadStamp::Ok(_)) => {
                                        clear_page_stamp(&c, &page.workspace_id, &page.id)
                                    }
                                    // 两边本来都没有戳 ⇒ 没什么可动的
                                    _ => Ok(()),
                                };
                                if let Err(e) = write_back {
                                    eprintln!(
                                        "[sync] page {} 的「本页戳」没写进去（只影响下一轮判序，这一次落库照旧）：{e}",
                                        page.id
                                    );
                                }
                                // B 方案：**更新的远端版本已经应用** ⇒ 之前存下的那一版（seq 更小）
                                // 已经是陈的，清掉（不清就是"清单永远挂着几条假账"）。
                                if let Some(stashed) = crate::doc_content::pending_remote_seq(&c, &page.id)? {
                                    if stashed <= change.seq {
                                        crate::doc_content::clear_pending_remote(&c, &page.id)?;
                                    }
                                }
                            }
                            UpsertApply::KeptLocal => {
                                // ★★ B 方案（2026-09-22）：页级保留本地**语义正确**，但那一版远端内容
                                // 会被游标吃掉（取证文件 §3.2 的 L）⇒ **在本地存下来**，让用户还能裁决。
                                // 游标照旧推进（朴素方案 A 会 livelock：这一页可能永远 KeepLocal，
                                // 后面所有变更都取不到）—— 所以"留痕"是这条路的代价，也是它的收场。
                                crate::doc_content::stash_pending_remote(&c, &page, change.seq, now)?;
                                if !pending_remote_ids.contains(&page.id) {
                                    pending_remote_ids.push(page.id.clone());
                                }
                            }
                        }
                        count += 1;
                    }
                }
            }
            ("page", "delete") => {
                apply_delete(&c, &change.entity_id, change.updated_at)?;
                count += 1;
            }
            ("attachment", "upsert") => {
                if let Some(payload) = &change.payload {
                    let plain = security::decrypt_payload(&c, payload)
                        .map_err(|e| ApplyFailure::Fatal(format!("同步解密失败：{e}（可能各设备 E1 口令/密钥不一致，已停止以免静默丢数据）")))?;
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&plain) {
                        let id = v["id"].as_str().unwrap_or("").to_string();
                        if !id.is_empty() {
                            let page_id: Option<String> = v["page_id"].as_str().map(|s| s.to_string());
                            let name = v["name"].as_str().unwrap_or("").to_string();
                            let hash = v["hash"].as_str().unwrap_or("").to_string();
                            let mime = v["mime"].as_str().unwrap_or("").to_string();
                            let size = v["size"].as_i64().unwrap_or(0);
                            // B4-b：先收编 / 自愈"兜底行"，再走正常的 upsert
                            // （为什么、以及兜底行是什么，见 `adopt_or_heal_fallback_row`）。
                            adopt_or_heal_fallback_row(&c, &id, &name, page_id.as_deref(), &hash)?;
                            c.execute(
                                "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
                                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                                 ON CONFLICT(id) DO UPDATE SET page_id=excluded.page_id, name=excluded.name, hash=excluded.hash, mime=excluded.mime, size=excluded.size",
                                params![id, page_id, name, hash, mime, size, crate::db::now_ms()],
                            )
                            .map_err(|e| e.to_string())?;
                            count += 1;
                        }
                    }
                }
            }
            ("attachment", "delete") => {
                c.execute("DELETE FROM attachments WHERE id = ?1", params![change.entity_id])
                    .map_err(|e| e.to_string())?;
                count += 1;
            }
            // ★ F7b（2026-09-25）：**这一格以前是无条件 `_ => {}`** —— 真到了就一句话不说地丢掉。
            // 桌面只认上面 4 种搭配（`page` / `attachment` 各自的 `upsert` / `delete`），而 Web 那套
            // TypeScript 引擎还会写 `page_tag` / `attr` / `prop` 三类对象（`web.ts` 的 `recordChange`）。
            // 它们今天到不了生产（Web 产品上**不提供**多设备同步，简报 F7），但"**收到读不懂的东西
            // 就静默丢掉**"正是本仓已经付过一次账的那种 bug（冲刺 §11.4：桌面静默丢掉 `crdt_state`，
            // 专门开了一轮才查出来）。口径与 `crdt_wire::WireState::UnknownVersion` 同一条：
            // **照旧忽略（前向兼容），但不许无声** —— 去重后由 `do_pull` 打一行实情日志。
            _ => {
                let tag = format!("{}:{}", change.entity, change.op);
                if !unrecognized.contains(&tag) {
                    unrecognized.push(tag);
                }
            }
        }
            Ok(())
        })();
        // ★ 一条变更失败的**统一处置**（与 Web 的 `doPull` catch 逐条对应，2026-09-23）：
        match applied {
            Ok(()) => {}
            Err(ApplyFailure::Fatal(e)) => return Err(e), // 解密失败：整批中止（游标不前进）
            Err(ApplyFailure::Recoverable(e)) => {
                // 能定位到页面 ⇒ **归档**（与 KeptLocal 同一本账，用户可裁决）；
                // 定位不到（附件 / 坏 payload）⇒ 至少一条 warn，**不许一声不响**。
                let archived = stash_source
                    .as_deref()
                    .and_then(|plain| serde_json::from_str::<PageDetail>(plain).ok())
                    .and_then(|page| {
                        crate::doc_content::stash_pending_remote(c, &page, change.seq, now).ok().map(|_| page.id)
                    });
                match archived {
                    Some(id) => {
                        if !pending_remote_ids.contains(&id) {
                            pending_remote_ids.push(id.clone());
                        }
                        eprintln!("[sync] 变更应用失败 ⇒ 已存进「待取回的远端版本」：page={id} seq={}：{e}", change.seq);
                    }
                    None => eprintln!(
                        "[sync] 变更应用失败且无法归档（entity={} op={} seq={}）：{e}",
                        change.entity, change.op, change.seq
                    ),
                }
            }
        }
        // ★ 游标**照旧推进**（这一句就是"归档 ＋ 前进"里那个"前进"）：不推进＝这一条会永久堵住
        //   它后面所有变更（livelock；Web 侧同处的注释记的是同一件事）。
        if change.seq > max_pulled {
            max_pulled = change.seq;
        }
    }
    Ok(PulledApply { count, max_pulled, items, conflicts, unresolved_page_ids, pending_remote_ids, unrecognized })
}

/// `apply_pulled_changes` 的产物（`do_pull` 直接摊平进它的返回元组）。
pub(crate) struct PulledApply {
    pub(crate) count: usize,
    max_pulled: i64,
    items: Vec<SyncItem>,
    conflicts: Vec<SyncConflict>,
    unresolved_page_ids: Vec<String>,
    pending_remote_ids: Vec<String>,
    /// ★ F7b：本轮**本端不认识**的 `entity:op`（去重、按首次出现顺序）。空 = 全都认识。
    /// ⚠️ 它**不是**失败：那些变更被**有意忽略**（前向兼容），只是不许无声 —— `do_pull` 会把它打出来。
    /// ⚠️ 别把它读成"游标停住了"：游标照旧前进（见下面那段"必须前进"的注释），
    /// 否则一种读不懂的搭配会把它后面所有变更**永久堵死**。
    unrecognized: Vec<String>,
}

async fn do_pull(
    db: &State<'_, Db>,
    profile: &SyncProfile,
) -> Result<(usize, i64, Vec<SyncItem>, Vec<SyncConflict>, usize, usize), String> {
    let last_pulled = {
        let c = db.0.lock().expect("db mutex poisoned");
        security::sync_gate(&c)?;
        profile.last_pulled_seq
    };

    let client = reqwest::Client::new();
    let my_device = {
        let c = db.0.lock().expect("db mutex poisoned");
        device_id(&c).ok()
    };
    // ★ 甲-1 接线：基址同样走 `effective_base`（"基址只出一处"——与 push/附件同源）。
    // 凭证按**配置地址**取（理由同 `do_push` 那一处）。
    let base = { let c = db.0.lock().expect("db mutex poisoned"); effective_base(&c, profile) };
    let url = pull_url(
        &base,
        last_pulled,
        &profile.space_id,
        my_device.as_deref(),
    );
    let mut req = client.get(&url);
    let token = { let c = db.0.lock().expect("db mutex poisoned"); get_auth_token(&c, &profile.server_url).unwrap_or_else(|| profile.token.clone()) };
    if !token.is_empty() {
        req = req.bearer_auth(&token);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            "同步失败：会话已失效，请重新登录".to_string()
        } else {
            format!("同步服务返回错误: {}", resp.status())
        });
    }
    let body: PullResponse = resp.json().await.map_err(|e| e.to_string())?;

    // ★ §0-C：**动手之前**把整批载荷的密文版本过一遍 —— 只要有一段本构建解不开就整批拒绝
    //   （返回 Err ⇒ 下面一条都不应用、游标不推进）。逐条 decrypt 失败会**应用一半**，
    //   而用户看到的是"同步了一部分、剩下的老报错"，真正原因却是"这版应用读不了那个空间的数据"。
    prescan_payload_formats(&body.changes)?;

    let now = crate::db::now_ms();
    let out = {
        let c = db.0.lock().expect("db mutex poisoned");
        // 跨设备 pull 的变更可能引用了「尚未先到达」的父页 / 关联页，触发本地外键约束
        // （attachments.page_id / pages.parent_id 等）。批量应用期间临时关闭外键，应用完恢复原状态。
        // ⚠️ RAII 守卫：调用里的 `?` 早退也会 drop 掉它 ⇒ 外键**一定**被恢复。
        let _fk_guard = ForeignKeysOff::new(&c);
        let out = apply_pulled_changes(&c, body.changes, last_pulled, now)?;
        set_profile_field(&c, &profile.ws_id, "last_pulled_seq", out.max_pulled)?;
        // 外键由 `_fk_guard` 在离开作用域时恢复（成功路径也一样，顺序与原来一致）。
        out
    };

    // ★ F7b（2026-09-25）：**不静默**。忽略是对的（前向兼容），但要让实情有地方可查 ——
    // 以前这一格是无条件 `_ => {}`，"收到读不懂的变更"在场面上与"什么都没收到"完全一样。
    if !out.unrecognized.is_empty() {
        eprintln!(
            "[sync] 收到 {} 种本端**不认识**的变更类型 ⇒ 已忽略（如实留痕，不静默）：{}。\
             本端只认 page / attachment 的 upsert / delete；出现别的种类说明对端写的协议比本端宽\
             （Web 那套引擎还会写 page_tag / attr / prop —— 见简报 F7b）。",
            out.unrecognized.len(),
            out.unrecognized.join("、")
        );
    }

    Ok((
        out.count,
        out.max_pulled,
        out.items,
        out.conflicts,
        out.unresolved_page_ids.len(),
        out.pending_remote_ids.len(),
    ))
}

/// 丙-③-b 的**产品入口**：确认网格窗口（配了监听地址才开）＋ 从发现到的对端各拉一轮。
///
/// 三条口径都写在这里，免得被后面的人读歪：
/// 1. **没配监听地址 ⇒ 整档关着**：`round` 早退，一个字节都不动（默认零行为变化）；
/// 2. **它不看 `server_url`** —— 这一层只认"空间 ＋ 网格设置 ＋ 对端表" ⇒
///    **一个没有服务端可绑的空间照样能靠网格同步**（这正是甲-2 冻结之后改走丙要兑现的那件事）；
/// 3. **一只对端拉不动不连坐**：错记在它自己那一行里（`error`），别的照拉。
///
/// ⚠️ 窗口与本轮拉取都用**这条空间自己的**连接（窗口那条由 `mesh::ensure_window` 自己开），
/// 不碰界面那条 —— 否则一次网络卡顿会把整个库锁住。
/// ⚠️ ★★ 2026-09-26 真机修：**开库要按"本地空间 id"**（`spaces/<本地 id>.db`），
/// 而"对暗号"用的是**远端组织空间 id** —— 两个 id 在真机上**不同名**。这里把 `MeshScope`
/// 的两个字段分别喂给两个用途（改前把远端 id 当库名 ⇒ 窗口服务一个空库、一条也换不过去）。
#[tauri::command]
pub async fn mesh_sync_now(
    db: State<'_, Db>,
    workspace_id: Option<String>,
) -> Result<crate::mesh::MeshRoundReport, String> {
    // ① 认空间（**两个**空间 id ＋ 本机设备号）
    let scope = mesh_scope(&db, workspace_id.as_deref())?;

    // ② 设置 ＋ 发现层（没开发现层 ⇒ 对端表是空的，**如实**回"网段里没人"）
    let (cfg, peers) = {
        let c = db.0.lock().expect("db mutex poisoned");
        let cfg = crate::mesh::settings(&c, &scope.space);
        let peers = crate::lan_state::LanState::global(&scope.device).peers(crate::db::now_ms());
        (cfg, peers)
    };

    // ③ 开窗（配了地址才开）＋ 拉一轮
    //    窗口的库 = **本地空间那一份**（`scope.db_space`）；它服务/匹配的空间 = `scope.space`。
    let window = crate::mesh::ensure_window(&scope.db_space, &scope.space, &scope.device, &cfg)?
        .map(|a| format!("http://{a}"));
    let mut report = crate::mesh::round(&db.0, &scope.space, &scope.device, &peers).await?;
    report.window = window;
    if report.enabled && report.window.is_none() {
        // 配了地址却没窗口 ⇒ 上面 `ensure_window` 会直接报错，走不到这里；留一句兜底说明。
        report.note.push_str("（⚠️ 设置里配了监听地址，但窗口没起来）");
    }
    Ok(report)
}

/// 丙-③-b-2b 的**设置面**：写网格设置（监听地址 / 口令），并把窗口的开关跟着改。
///
/// 两条口径：
/// 1. **`None` ＝ 不动这一项；`Some("")` ＝ 清除它**（所以"关掉网格"就是 `bind: Some("")`）——
///    两条参数同一套规则，不要各写一套；
/// 2. **公网地址在写的时候就被拒**（`set_mesh_bind` 里把关），错误原样带回给调用方；
///    关掉时**立刻松口**（`stop_window`），不留一个还在听着的窗口。
///
/// ⚠️ 回的是**读数**（`MeshConfigState`）—— 含"**别人拉不拉得到**"那句人话，**不含口令本身**。
#[tauri::command]
pub fn mesh_set_config(
    db: State<'_, Db>,
    workspace_id: Option<String>,
    bind: Option<String>,
    token: Option<String>,
) -> Result<crate::mesh::MeshConfigState, String> {
    let scope = mesh_scope(&db, workspace_id.as_deref())?;
    let cfg = {
        let c = db.0.lock().expect("db mutex poisoned");
        if let Some(b) = bind.as_deref() {
            crate::mesh::set_mesh_bind(&c, &scope.space, Some(b))?;
        }
        if let Some(t) = token.as_deref() {
            crate::mesh::set_mesh_token(&c, &scope.space, Some(t))?;
        }
        crate::mesh::settings(&c, &scope.space)
    };
    if cfg.bind.is_none() {
        // 关掉 ⇒ **立刻松口**（不留一个还在听的窗口）。
        crate::mesh::stop_window(&scope.space)?;
        return Ok(crate::mesh::config_state(&cfg, None));
    }
    // 窗口的库 = **本地空间那一份**（`scope.db_space`）；服务/匹配的空间 = `scope.space`。
    let window = crate::mesh::ensure_window(&scope.db_space, &scope.space, &scope.device, &cfg)?;
    Ok(crate::mesh::config_state(&cfg, window))
}

/// 网格要用的那**两个**空间 id ＋ 本机设备号 —— `mesh_sync_now` 与 `mesh_set_config` 共用一处
/// （两份各自写一遍的下场是"设置面认得、同步面不认得"，而那种不一致没有任何编译期信号）。
///
/// ★★ **为什么必须是两个、不许合成一个**（2026-09-26 真机实测的教训）：档案表里
/// `sync_profiles.space_id` 是**远端组织空间 id**（对暗号用），`sync_profiles.ws_id` 是**本地空间 id**
/// —— 也就是 `spaces/<id>.db` 的文件名那一半。真机上两者**不同名**（本地 `default` / 远端
/// `8be69ab5…`）：把它们当成同一个，窗口就会去开一个**按远端 id 新建的空库**，
/// 然后安静地服务 0 条记录（HTTP 200、不报错）。
struct MeshScope {
    /// 远端组织空间 id：**对暗号**用（窗口的 403 检查、对端匹配、设置的 KV 键）。
    space: String,
    /// 本地空间 id：**开库**用（`spaces/<db_space>.db`）。
    db_space: String,
    /// 本机设备号（发现层与"只服务我自己产生的记录"都用它）。
    device: String,
}

fn mesh_scope(db: &State<'_, Db>, workspace_id: Option<&str>) -> Result<MeshScope, String> {
    // 读法与 `lan_status` 同一套：profiles × 未删除的 workspaces
    let (device_id, rows) = {
        let c = db.0.lock().expect("db mutex poisoned");
        let mut stmt = c
            .prepare(
                "SELECT p.space_id, p.ws_id FROM sync_profiles p
                 WHERE EXISTS (
                     SELECT 1 FROM meta.workspaces w
                     WHERE w.id = p.ws_id AND w.deleted_at IS NULL
                 )",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        (device_id(&c).unwrap_or_default(), rows)
    };
    let pick = match workspace_id.filter(|w| !w.is_empty()) {
        Some(want) => rows
            .iter()
            .find(|(_, ws)| ws == want)
            .cloned()
            .ok_or_else(|| format!("这个空间没有同步档案（或它不是当前工作区）：{want}"))?,
        None => match rows.len() {
            1 => rows[0].clone(),
            0 => return Err("本机还没有任何绑过同步的空间 —— 网格交换要先有一个空间".to_string()),
            n => return Err(format!("本机有 {n} 个空间，这条命令要指名其中一个")),
        },
    };
    if pick.0.trim().is_empty() {
        return Err("这个空间的同步档案还没有 space_id（网格交换要它来对暗号）".to_string());
    }
    Ok(MeshScope { space: pick.0, db_space: pick.1, device: device_id })
}

/// ★ 甲-1 接线第 3 件：**局域网的读数 ＋ 状态行**（施工单 §2 ④）。
///
/// 口径（简报 §7）：**「没走成直连」必须是一个可断言的结果，不是静默降级** ——
/// 所以这里回的是 `lan::status_line` 的**原文**加几个可断言的读数，界面直接显示：
///   · `enabled`：发现层现在开着吗（没绑同步 ⇒ 关，广播/监听整条不起）；
///   · `peers`：**活着**的对端数（过 TTL 的不算 —— 与地址解析用的是同一把尺）。
///
/// ⚠️ **档位只由 `Route` 决定**（`lan::status_line` 内部那条纪律）：这里**不**按地址形状
/// 自己判一次，否则用户把配置地址填成 `http://192.168.x.y` 时界面会说「局域网」而实际走公网。
/// ⚠️ 这是**唯一**会把地址解析结果拿出来给人看的地方（同步请求本身照旧不打印地址）。
#[tauri::command]
pub fn lan_status(
    db: State<'_, Db>,
    workspace_id: Option<String>,
) -> Result<LanStatus, String> {
    let now = crate::db::now_ms();
    let (device_id, profiles) = {
        let c = db.0.lock().expect("db mutex poisoned");
        let mut stmt = c
            .prepare(
                "SELECT p.space_id, p.server_url, p.ws_id FROM sync_profiles p
                 WHERE EXISTS (
                     SELECT 1 FROM meta.workspaces w
                     WHERE w.id = p.ws_id AND w.deleted_at IS NULL
                 )",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?;
        let profiles: Vec<(String, String, String)> =
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        (device_id(&c).unwrap_or_default(), profiles)
    };

    // ★ 启动监听/广播（施工单 §7 第 1 件）由 **Tauri `setup`** 在进程起来时就做了
    //   （见 `lib.rs` 里那一段的注释：不等界面第一次调本命令 —— 否则"面板没开过"的会话
    //   永远不会有局域网路由）。这里只如实读数，**不再**顺手起一次（起两次虽然幂等，
    //   但那是第二个入口，多一条能走岔的路）。
    let state = LanState::global(&device_id);
    let enabled = state.is_enabled();
    // ⚠️ 状态行的"N 台"用**活着**的（与地址解析同源，同一把尺）；`observed` 只作诊断
    //   （表里一共有过多少台 —— "来过又走了"由状态行自己如实说出来）。
    let peers = state.peers(now);
    let observed = state.observed_all().len();

    // 这一轮要显示的是**哪个空间**：指定了就用它，否则第一条绑定（面板是"当前空间"的）。
    // ⚠️ 选哪个空间是**纯函数**（`pick_lan_scope`，带判据）：选错空间的表现是状态行说
    //    "其中没有服务这个空间的中枢"，而用户明明配的就是那一个 —— 这种错单测之外的抓不住。
    let picked = {
        let c = db.0.lock().expect("db mutex poisoned");
        let explicit = workspace_id.as_deref().and_then(|ws| get_profile(&c, ws).ok());
        let fallback = profiles
            .first()
            .and_then(|(_, _, ws)| get_profile(&c, ws).ok());
        pick_lan_scope(explicit, fallback)
    };
    let (space_id, server_url) = match picked {
        Some((space, url)) => (space, url),
        None => (String::new(), String::new()),
    };
    let route = lan::resolve_base(&space_id, &server_url, &peers);
    // ★ 契约字面量由 `LinkKind::as_str` 出（与 `lan::tests` 判据 ⑥ 同一处）：
    //   界面据此**只换标题、不重判档位**（重判就会说出与真实路由矛盾的档）。
    let kind = route.as_ref().map(|r| r.kind.as_str()).unwrap_or("").to_string();
    let line = lan::status_line(route.as_ref(), &peers, &space_id, observed);

    // ★ 丙-③-b-2b-2：把**网格（对等交换）那一档的读数**一并交出去 —— 设置面板要用的就是它。
    //   ⚠️ **只读**：这里**不**开窗（开窗归 `mesh_set_config` / 发现层循环），
    //   面板打开一次不该顺手开一个端口；已经开着的话 `window_addr` 会把**实际地址**读出来。
    let mesh = {
        let c = db.0.lock().expect("db mutex poisoned");
        let cfg = if space_id.trim().is_empty() {
            crate::mesh::MeshSettings::default()
        } else {
            crate::mesh::settings(&c, &space_id)
        };
        let window = crate::mesh::window_addr(&space_id);
        crate::mesh::config_state(&cfg, window)
    };

    Ok(LanStatus { enabled, peers: peers.len(), kind, line, mesh })
}

/// 状态行该报**哪个空间**（纯函数，带判据）：显式指定的那条优先，否则第一条绑定。
///
/// ⚠️ 两条路都可能"查不到"（指定的工作空间其实没配、或库里一条都没有）⇒ 一律回落，
/// **不许**报错：这只是"面板上那一行字显示哪个空间"，不是同步请求。
fn pick_lan_scope(
    explicit: Option<SyncProfile>,
    fallback: Option<SyncProfile>,
) -> Option<(String, String)> {
    let p = explicit.or(fallback)?;
    Some((p.space_id, p.server_url))
}

/// `lan_status` 的形状（**前端契约**，见 `src/lib/platform/commands.ts` 的同名 interface）。
#[derive(Serialize)]
pub struct LanStatus {
    /// 发现层现在开着吗（没绑同步 ⇒ 关）。
    pub enabled: bool,
    /// **活着**的对端数（过 `lan::PEER_TTL_MS` 的不算）。
    ///
    /// ⚠️ 与状态行里那个"N 台"**是同一个数**：界面不该自己再数一遍（数两遍就会漂）。
    pub peers: usize,
    /// 这一次走的是哪一档：`"lan"` / `"configured"` / `""`（尚未绑定）。
    ///
    /// ⚠️ 它来自 `Route`（`LinkKind::as_str`）—— 界面**只能拿它换标题**，
    /// **不许**按地址形状自己再判一次档（判据 ⑭ 钉这条）。
    pub kind: String,
    /// **状态行原文**（`lan::status_line`）—— 界面直接显示这一串，
    /// **不要**自己按地址形状再拼一次档位（那会说出与真实路由矛盾的档）。
    pub line: String,
    /// ★ 丙-③-b-2b-2：**网格（对等交换）这一档的读数** —— 设置、窗口实际地址，以及
    /// "**别人拉不拉得到**"那句人话（`mesh::config_state`，与设置面同一处口径）。
    ///
    /// ⚠️ 它在这里**只读**：`lan_status` 不负责开窗（那是 `mesh_set_config` 与发现层循环的事）。
    pub mesh: crate::mesh::MeshConfigState,
}

#[derive(Serialize)]
pub struct WorkspaceSyncResult {
    pub ws_id: String,
    pub pushed: usize,
    pub pulled: usize,
    pub last_pushed_seq: i64,
    pub last_pulled_seq: i64,
    pub error: Option<String>,
    pub conflicts: Vec<SyncConflict>,
    /// 阶段 1：本轮**因块级合并判不了而落表的页面数**（定义与"为什么与 `conflicts` 分开"
    /// 见 `SyncReport::block_conflict_pages`）。
    pub block_conflict_pages: usize,
    /// ★ B 方案：本轮**页级保留本地**、已把远端那一版存进待裁决清单的页面数
    /// （定义见 `SyncReport::pending_remote_pages`；详情走 `list_pending_remote_pages`）。
    pub pending_remote_pages: usize,
    /// P6.1：附件同步**因开关被关掉而中途停止**（见 `SyncReport::attachments_paused`）。
    pub attachments_paused: bool,
    /// P6.1：本轮因开关关闭而未上传 / 未下载的件数（见 `SyncReport` 同名字段的定义）。
    pub attachments_skipped_upload: usize,
    pub attachments_skipped_download: usize,
    /// C1：停止原因 / 因超阈值跳过 / 传输失败 / 本轮下载字节（定义见 `SyncReport`）。
    pub attachments_paused_reason: String,
    pub attachments_skipped_too_large: usize,
    pub attachments_failed: usize,
    pub attachments_bytes_downloaded: u64,
}

async fn sync_workspace_only(
    app: &tauri::AppHandle,
    db: &State<'_, Db>,
    profile: &SyncProfile,
) -> Result<SyncReport, String> {
    let (pushed, last_pushed_seq, pushed_items) = do_push(db, profile).await?;
    let (pulled, last_pulled_seq, pulled_items, conflicts, block_conflict_pages, pending_remote_pages) =
        do_pull(db, profile).await?;
    let att = sync_attachments(app, db, profile).await?;
    let mut items = pushed_items;
    items.extend(pulled_items);
    items.extend(att.items);
    Ok(SyncReport {
        pushed,
        pulled,
        last_pushed_seq,
        last_pulled_seq,
        items,
        conflicts,
        block_conflict_pages,
        pending_remote_pages,
        attachments_paused: att.paused,
        attachments_skipped_upload: att.skipped_upload,
        attachments_skipped_download: att.skipped_download,
        attachments_paused_reason: att.paused_reason,
        attachments_skipped_too_large: att.skipped_too_large,
        attachments_failed: att.failed,
        attachments_bytes_downloaded: att.bytes_downloaded,
    })
}

#[tauri::command]
pub async fn sync_now(app: tauri::AppHandle, db: State<'_, Db>) -> Result<Vec<WorkspaceSyncResult>, String> {
    let profiles = {
        let c = db.0.lock().expect("db mutex poisoned");
        list_profiles(&c)?
    };
    let mut results = Vec::new();
    for profile in profiles {
        // Skip empty/unbound profiles (no remote target configured).
        if profile.server_url.is_empty() || profile.space_id.is_empty() {
            continue;
        }
        let r = sync_workspace_only(&app, &db, &profile).await;
        results.push(match r {
            Ok(rep) => WorkspaceSyncResult {
                ws_id: profile.ws_id.clone(),
                pushed: rep.pushed,
                pulled: rep.pulled,
                last_pushed_seq: rep.last_pushed_seq,
                last_pulled_seq: rep.last_pulled_seq,
                error: None,
                conflicts: rep.conflicts,
                block_conflict_pages: rep.block_conflict_pages,
                pending_remote_pages: rep.pending_remote_pages,
                attachments_paused: rep.attachments_paused,
                attachments_skipped_upload: rep.attachments_skipped_upload,
                attachments_skipped_download: rep.attachments_skipped_download,
                attachments_paused_reason: rep.attachments_paused_reason,
                attachments_skipped_too_large: rep.attachments_skipped_too_large,
                attachments_failed: rep.attachments_failed,
                attachments_bytes_downloaded: rep.attachments_bytes_downloaded,
            },
            Err(e) => WorkspaceSyncResult {
                ws_id: profile.ws_id.clone(),
                pushed: 0,
                pulled: 0,
                last_pushed_seq: 0,
                last_pulled_seq: 0,
                error: Some(e),
                conflicts: Vec::new(),
                block_conflict_pages: 0,
                pending_remote_pages: 0,
                attachments_paused: false,
                attachments_skipped_upload: 0,
                attachments_skipped_download: 0,
                attachments_paused_reason: String::new(),
                attachments_skipped_too_large: 0,
                attachments_failed: 0,
                attachments_bytes_downloaded: 0,
            },
        });
    }
    Ok(results)
}

#[tauri::command]
pub async fn sync_workspace(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    ws_id: String,
) -> Result<WorkspaceSyncResult, String> {
    let profile = {
        let c = db.0.lock().expect("db mutex poisoned");
        get_profile(&c, &ws_id)?
    };
    // 服务端 S5+ 的 push/pull 强制 require_space——多设备同步必须绑定一个团队空间。
    // space_id 留空（单用户）无法走 require_space，服务端会 403。这里提前挡下，
    // 给出明确的「需绑定团队空间」提示，而不是让请求打到服务端才 403。
    if profile.server_url.is_empty() {
        return Err("请先配置同步服务器".to_string());
    }
    if profile.space_id.is_empty() {
        return Err("需绑定团队空间才能同步（多设备同步不支持留空）".to_string());
    }
    match sync_workspace_only(&app, &db, &profile).await {
        Ok(rep) => {
            write_sync_history(
                &db,
                &ws_id,
                &profile,
                rep.pushed,
                rep.pulled,
                true,
                "",
                &rep.items,
            );
            Ok(WorkspaceSyncResult {
                ws_id,
                pushed: rep.pushed,
                pulled: rep.pulled,
                last_pushed_seq: rep.last_pushed_seq,
                last_pulled_seq: rep.last_pulled_seq,
                error: None,
                conflicts: rep.conflicts,
                block_conflict_pages: rep.block_conflict_pages,
                pending_remote_pages: rep.pending_remote_pages,
                attachments_paused: rep.attachments_paused,
                attachments_skipped_upload: rep.attachments_skipped_upload,
                attachments_skipped_download: rep.attachments_skipped_download,
                attachments_paused_reason: rep.attachments_paused_reason,
                attachments_skipped_too_large: rep.attachments_skipped_too_large,
                attachments_failed: rep.attachments_failed,
                attachments_bytes_downloaded: rep.attachments_bytes_downloaded,
            })
        }
        Err(e) => {
            write_sync_history(&db, &ws_id, &profile, 0, 0, false, &e, &[]);
            Err(e)
        }
    }
}

/// Record one sync run in `meta.sync_history` (best-effort; never blocks sync).
fn write_sync_history(
    db: &State<'_, Db>,
    ws_id: &str,
    _profile: &SyncProfile,
    pushed: usize,
    pulled: usize,
    ok: bool,
    message: &str,
    items: &[SyncItem],
) {
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let items_json = serde_json::json!(items).to_string();
    let r = || -> rusqlite::Result<()> {
        let c = db.0.lock().expect("db mutex poisoned");
        c.execute(
            "INSERT INTO sync_history (ws_id, ws_name, at, pushed, pulled, ok, message, items)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![ws_id, "", at, pushed as i64, pulled as i64, ok as i64, message, items_json],
        )?;
        // 只保留最近 100 条，避免无限增长。
        let _ = c.execute(
            "DELETE FROM sync_history WHERE id NOT IN (SELECT id FROM sync_history ORDER BY at DESC LIMIT 100)",
            [],
        );
        Ok(())
    };
    let _ = r();
}

#[derive(Deserialize)]
struct RemoteAttachment {
    hash: String,
    mime: String,
}

#[derive(Deserialize)]
struct RemoteAttachmentList {
    items: Vec<RemoteAttachment>,
}

/// P6.1：`sync_attachments` 的返回。加了"被开关挡下的件数"后已经是 4 个值，
/// 元组读起来全是位置，改成一个具名结构。
struct AttachmentSyncOutcome {
    items: Vec<SyncItem>,
    /// 本轮**中途停止**了（开关被关 / 磁盘余量不足 / 撞上本轮总量上限）。
    /// 入口就是关的不算——那是稳态，不是"停止"。
    paused: bool,
    /// 停止原因：`""` / `"switch"` / `"disk_floor"` / `"run_cap"`。
    /// 界面据此说清**为什么停了**（三种原因的文案不同，混在一起用户只会以为同步坏了）。
    paused_reason: String,
    /// 因开关关闭而未上传 / 未下载的件数（定义见 `SyncReport` 同名字段）。
    skipped_upload: usize,
    skipped_download: usize,
    /// C1：因**单文件超过阈值**而跳过的件数（这些件不是"停止"，是"轮不到"）。
    skipped_too_large: usize,
    /// C1：**传输失败**（网络抖动 / 服务端 5xx）而被跳过的件数——原先这里是 `?`，
    /// 一件失败就炸掉整轮；现在记一笔、继续，件数必须可见，否则是静默丢件。
    failed: usize,
    /// C1：本轮**实际下载的明文字节数**（"本次总量上限"默认只报告不拦截，报告的就是它）。
    bytes_downloaded: u64,
}

impl AttachmentSyncOutcome {
    /// 开关关着且连清单都没拉到：不传字节、不报错、件数未知（记 0）。
    fn skip_all() -> Self {
        Self {
            items: Vec::new(),
            paused: false,
            paused_reason: String::new(),
            skipped_upload: 0,
            skipped_download: 0,
            skipped_too_large: 0,
            failed: 0,
            bytes_downloaded: 0,
        }
    }
}

/// 拉取远端附件清单。抽成函数是为了让调用方能对"开关关着时拉不到"做优雅降级
/// （见 `sync_attachments` 里的 `Err(_) if !att_on` 分支）。
async fn fetch_remote_attachments(
    client: &reqwest::Client,
    att_base: &str,
    token: &str,
) -> Result<RemoteAttachmentList, String> {
    let mut req = client.get(format!("{att_base}/attachments"));
    if !token.is_empty() {
        req = req.bearer_auth(token);
    }
    req.send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

// ---- C1 预算刹车 / C2 网络闸门：设备级设置 ----
//
// 存 `meta.sync_state` 的 KV（那张表本来就是 app 级 KV：device_id / token / 活动空间 id 都在里面），
// **不新建表**：四个数字不值得为它加一张表 + 一次迁移。
//
// 为什么是**设备级**而不是每空间：磁盘余量是**设备**的属性（跟哪个空间无关）；单文件阈值与
// 总量上限虽然可以想象成每空间，但用户的心智是"我这台手机别被塞满"⇒ 设备级更贴合，也少一层 UI。
const KEY_DISK_FLOOR_MB: &str = "sync_disk_floor_mb";
const KEY_MAX_FILE_MB: &str = "sync_max_file_mb";
const KEY_MAX_RUN_MB: &str = "sync_max_run_mb";
const KEY_WIFI_ONLY: &str = "sync_wifi_only";

/// 磁盘余量下限默认 **1 GB**（2026-09-15 发布者拍板）。**硬性、不可关**：见 `set_sync_budget` 的夹取。
pub const DEFAULT_DISK_FLOOR_MB: u64 = 1024;
/// 单文件跳过阈值默认 **100 MB**（同日拍板）。它直接决定"海量视频"能不能被自动拉下来。
pub const DEFAULT_MAX_FILE_MB: u64 = 100;
/// 本次下载总量上限默认 **0 = 只报告不拦截**（同日拍板：先拿数据，再定硬数字）。
pub const DEFAULT_MAX_RUN_MB: u64 = 0;
/// C2「仅 Wi-Fi 时自动同步」默认 **开**（Android 尚未对外发布，先按"不偷跑流量"设默认）。
pub const DEFAULT_WIFI_ONLY: bool = true;

/// 磁盘余量下限的**兜底最小值**：允许用户调大，**不允许调成 0**——"硬性、不可关"是它的定义。
const MIN_DISK_FLOOR_MB: u64 = 256;
/// 上限的兜底最大值：防止把 `u64` 乘爆（1 TiB 足够表达"其实等于不限"）。
const MAX_BUDGET_MB: u64 = 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SyncBudget {
    /// 磁盘余量下限（MB）。**硬性、不可关**（≥ `MIN_DISK_FLOOR_MB`）。
    pub disk_floor_mb: u64,
    /// 单文件跳过阈值（MB）；`0` = 不限。
    pub max_file_mb: u64,
    /// 本次下载总量上限（MB）；`0` = 只报告不拦截。
    pub max_run_mb: u64,
    /// C2：只在 Wi-Fi 下自动同步。
    pub wifi_only: bool,
}

impl Default for SyncBudget {
    fn default() -> Self {
        Self {
            disk_floor_mb: DEFAULT_DISK_FLOOR_MB,
            max_file_mb: DEFAULT_MAX_FILE_MB,
            max_run_mb: DEFAULT_MAX_RUN_MB,
            wifi_only: DEFAULT_WIFI_ONLY,
        }
    }
}

impl SyncBudget {
    /// 夹取成合法范围。**读与写都过这一道**：写入要拦住坏值，读出也要拦——
    /// 老库 / 手改过的 DB 里可能存着 `0` 或荒唐大的数字。
    fn clamped(mut self) -> Self {
        self.disk_floor_mb = self.disk_floor_mb.clamp(MIN_DISK_FLOOR_MB, MAX_BUDGET_MB);
        self.max_file_mb = self.max_file_mb.min(MAX_BUDGET_MB);
        self.max_run_mb = self.max_run_mb.min(MAX_BUDGET_MB);
        self
    }
}

fn parse_mb(c: &Connection, key: &str, default: u64) -> u64 {
    get_meta_state(c, key).and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(default)
}

/// 读设备级预算。**任何一项缺失 / 解析失败都退回默认值**（升级上来的老库没有这几个键）。
pub fn read_budget(c: &Connection) -> SyncBudget {
    SyncBudget {
        disk_floor_mb: parse_mb(c, KEY_DISK_FLOOR_MB, DEFAULT_DISK_FLOOR_MB),
        max_file_mb: parse_mb(c, KEY_MAX_FILE_MB, DEFAULT_MAX_FILE_MB),
        max_run_mb: parse_mb(c, KEY_MAX_RUN_MB, DEFAULT_MAX_RUN_MB),
        wifi_only: get_meta_state(c, KEY_WIFI_ONLY)
            .map(|v| v.trim() != "0")
            .unwrap_or(DEFAULT_WIFI_ONLY),
    }
    .clamped()
}

#[tauri::command]
pub fn get_sync_budget(db: State<'_, Db>) -> Result<SyncBudget, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    Ok(read_budget(&c))
}

/// 写设备级预算。**磁盘余量下限不可关**：传 0 会被夹到 `MIN_DISK_FLOOR_MB`（见 `clamped`）。
#[tauri::command]
pub fn set_sync_budget(db: State<'_, Db>, budget: SyncBudget) -> Result<SyncBudget, String> {
    let b = budget.clamped();
    let c = db.0.lock().expect("db mutex poisoned");
    set_meta_state(&c, KEY_DISK_FLOOR_MB, &b.disk_floor_mb.to_string())?;
    set_meta_state(&c, KEY_MAX_FILE_MB, &b.max_file_mb.to_string())?;
    set_meta_state(&c, KEY_MAX_RUN_MB, &b.max_run_mb.to_string())?;
    set_meta_state(&c, KEY_WIFI_ONLY, if b.wifi_only { "1" } else { "0" })?;
    // 回显**夹取后**的值：界面据此立刻纠正自己（比如用户填 0，回显 256）。
    Ok(b)
}

/// C1：下载**单件**附件并落库，成功返回落盘的明文字节数。
///
/// 抽成函数有两个用处：① C1 要求"某一件失败**不该**炸掉整轮"——用 `Result` 表达最直接
/// （原先这里是 `?`，一次网络抖动就让整轮同步失败，也就谈不上"优雅停止"）；
/// ② P6.3 的"按需取字节"要复用它，**不许再写第二份下载实现**
/// （见 `docs/plans/2026-09-15-attachment-on-demand-plan.md` §七）。
#[allow(clippy::too_many_arguments)]
async fn download_one_attachment(
    client: &reqwest::Client,
    att_base: &str,
    token: &str,
    item: &RemoteAttachment,
    attachments_dir: &Path,
    session_key: Option<&crate::crypto::AppKeys>,
    db: &State<'_, Db>,
) -> Result<i64, String> {
    let mut req = client.get(format!("{att_base}/attachments/{}", item.hash));
    if !token.is_empty() {
        req = req.bearer_auth(token);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("服务端返回 {}", resp.status()));
    }
    let ext = ext_from_mime(&item.mime);
    let path = attachments_dir.join(&item.hash[0..2]).join(format!("{}.{}", item.hash, ext));
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut size: i64 = 0;
    if !path.exists() {
        // ⚠️ 临时文件名**必须唯一**（2026-09-15 真机验收修）：原先固定用 `<hash>.part`，
        // 于是"同一件被并发下载"时两个请求会抢同一个临时文件——一个 rename 走之后，
        // 另一个 rename 就 ENOENT（真机上观测到 `取回文件失败：No such file or directory (os error 2)`，
        // 且白下了一遍）。用 uuid 后缀让每次尝试各写各的。
        // （`.part` 结尾仍被 `local_set` 排除，不会被当成本地已有字节。）
        let tmp = attachments_dir.join(format!("{}.{}.part", item.hash, uuid::Uuid::new_v4()));
        let mut file = tokio::fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(chunk) => {
                    size += chunk.len() as i64;
                    file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                }
                Err(e) => {
                    // 半成品必须删掉：留着白占磁盘，也让"本轮下了多少"说不清。
                    // （`.part` 已被 `local_set` 排除，不会被当成本地已有，但仍要清。）
                    drop(file);
                    let _ = std::fs::remove_file(&tmp);
                    return Err(e.to_string());
                }
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        // E1: when at-rest encryption is on, store the downloaded PLAINTEXT
        // encrypted (nonce||ct) like every other attachment, so the read path
        // (decrypt/passthrough) and the at-rest guarantee stay consistent.
        if let Some(k) = session_key {
            if let Ok(plain) = std::fs::read(&path) {
                if let Ok(bytes) = security::encrypt_attachment_bytes(Some(k), &plain) {
                    let _ = std::fs::write(&path, &bytes);
                }
            }
        }
    }
    // B4（2026-09-15）：**只有当这个 hash 还没有任何行时**才插一行兜底。
    {
        let c = db.0.lock().expect("db mutex poisoned");
        record_downloaded_attachment(&c, &item.hash, &item.mime, size, &format!("{}.{}", item.hash, ext))?;
    }
    Ok(size)
}

/// 把"刚下载完字节的附件"记进 `attachments`（**兜底行**），成功返回 `()`。
///
/// ## 为什么必须有"已经有行就不插"这条前置判断（B4 的结论）
///
/// 原先这里无条件插一行：**新 uuid + `page_id = NULL` + `INSERT OR IGNORE`**。
/// 而 `INSERT OR IGNORE` 只对**主键**冲突生效 —— `attachments` 的主键是 `id`
/// （`db.rs:622-632`），`hash` 上只有一个**非唯一**索引 ⇒ 这条 insert 永远不会被忽略。
///
/// 于是在**第二台设备**上，同一个 hash 会有两行：
/// ① 附件**元数据**随 `changes` 同步进来那一行（`page_id` 正确、指向真实目录）；
/// ② 这里插的兜底行（`page_id = NULL`）。
/// 而根目录（「未整理」）视图正是按 `page_id IS NULL` 取的（`attachments.rs:643`）
/// ⇒ **文件在「未整理」里多出一份 `hash.ext` 的副本**。
///
/// ⚠️ **Web 引擎没有这个毛病**：它的下载路径**根本不在 `attachments` 表里插行**
/// （只 `blobStore.put(hash, blob)`，行由 `applyChange` 建），所以这条只是 Rust 侧的问题。
///
/// ⚠️ **这一步不能直接删掉**（"反正元数据会来"是错的）：兜底行存在的意义是
/// **服务端有字节、而本地没有对应元数据行**时（老数据 / 元数据变更没拉到），
/// 下载完的字节至少能被用户看见并管理。所以是"有就不插"，不是"不插"。
///
/// 另：`attachments.rs:743-755` 的"零引用才删字节"规则**本来就假设同一 hash 可以有多行**
/// （本地重复添加同一份内容会出现），所以多行本身不是非法状态 —— 这里修的只是
/// **同步下载路径制造出来的那一份重复**。
fn record_downloaded_attachment(
    c: &Connection,
    hash: &str,
    mime: &str,
    size: i64,
    name: &str,
) -> Result<(), String> {
    let existing: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM attachments WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if existing > 0 {
        return Ok(());
    }
    c.execute(
        "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
         VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6)",
        params![uuid::Uuid::new_v4().to_string(), name, hash, mime, size, crate::db::now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// P1（2026-09-15）：**附件同步进度**（Rust → 前端）。
///
/// ⚠️ **字段名故意用 camelCase，与前端 `useSyncStatus.setProgress` 逐个对齐**
/// （`phase` / `message` / `attCurrent` / `attTotal` / `attName`）：前端拿到就能直接塞进 store，
/// 不必在两侧各翻译一次字段名（那正是"改一处忘另一处"的老路）。
///
/// 为什么需要它：`web.ts`（Web 引擎）**自己**会 `setProgress`，而桌面 / 安卓走 Rust 命令——
/// 那条链上原先**一处进度都没有**（全仓 `attCurrent`/`attTotal` 只出现在 `web.ts`），
/// 于是面板上那段 `N/M` + 进度条**永远收不到数据**：只有 Web 版看得见进度。
/// 见 `docs/plans/2026-09-15-attachment-sync-scope-plan.md` §4.4。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentSyncProgress {
    /// 固定 `"attachments"`（与 `SyncPhase` 对齐）。
    phase: &'static str,
    /// 人话文案，与 `web.ts` 的两句保持一致（"正在上传附件（3/12）"）。
    message: String,
    att_current: usize,
    att_total: usize,
    /// 上传侧放 mime、下载侧放 hash 前 8 位（与 `web.ts` 同样处理）。
    att_name: String,
}

/// 发一条附件进度。**失败只记一行日志**：进度上报是"锦上添花"，
/// 它不该让同步本身失败（与 `attachments.rs` 的导入进度同样处理）。
fn emit_attachment_progress(
    app: &tauri::AppHandle,
    direction: &str,
    current: usize,
    total: usize,
    name: &str,
) {
    let message = if direction == "up" {
        format!("正在上传附件（{current}/{total}）")
    } else {
        format!("正在下载附件（{current}/{total}）")
    };
    let _ = app.emit(
        "attachment-sync-progress",
        AttachmentSyncProgress {
            phase: "attachments",
            message,
            att_current: current,
            att_total: total,
            att_name: name.to_string(),
        },
    );
}

async fn sync_attachments(
    app: &tauri::AppHandle,
    db: &State<'_, Db>,
    profile: &SyncProfile,
) -> Result<AttachmentSyncOutcome, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // ★ 附件按空间分（owner 2026-09-24 拍板 ②）：本轮的字节都落在**这个空间自己**的目录里
    //   （`profile.ws_id` 就是本轮同步的那个空间）。
    let attachments_dir: PathBuf = crate::attachments::space_attachments_dir(&app_data_dir, &profile.ws_id);
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;
    let mut att_items: Vec<SyncItem> = Vec::new();
    // P6.1：本轮是否"因开关被关掉而中途停止"（与"入口就没开"区分——后者不算 paused）。
    let mut paused = false;
    // C1：停止原因（`""` / `"switch"` / `"disk_floor"` / `"run_cap"`）。上传与下载两侧共用。
    let mut paused_reason = String::new();
    // C1：**传输失败**（网络抖动 / 服务端 5xx）而跳过的件数。上传与下载两侧共用。
    // 原先两侧都是 `?` —— 一件失败就炸掉整轮同步，既谈不上"优雅停止"，也让用户
    // 只看到"同步失败"而不知道坏在哪一件。
    let mut failed = 0usize;

    // P6.1「每空间开关」（2026-09-15）：关掉 ⇒ **只跳过第 3/4 步的字节传输**
    // （上传循环 / 下载循环），而**第 1 步列远端 hash、第 2 步列本地 hash 照常做**。
    // 这正是 §四 步骤 5 说的"跳过第 3/4 步"——代码里的步骤编号就是上面这两句注释
    // （1. List remote hashes / 2. Local hashes / 3. Upload / 4. Download）。清单照拉
    // 是有回报的：两份清单的差集**正好**就是"未上传 N 个 / 未下载 M 个"（§六 验收 #4）。
    // ⚠️ 开关**只**管字节：附件**元数据**已由 do_push / do_pull 经 `changes` 同步过，
    // 所以对端仍然看得见这些文件，只是没有字节（点开提示未下载）。
    // ⚠️ 这里**从 DB 读、不用 `profile.sync_attachments`**：`profile` 是本轮开始时的快照，
    // 用它会导致"中途关掉不生效"（详见 `attachments_enabled` 的注释）。
    let att_on = {
        let c = db.0.lock().expect("db mutex poisoned");
        attachments_enabled(&c, &profile.ws_id)
    };

    let client = reqwest::Client::new();
    // ★ 甲-1 接线：基址走 `effective_base`（局域网中枢优先；未发现/未启用 ⇒ 与今天逐字节相同）。
    let att_base = {
        let c = db.0.lock().expect("db mutex poisoned");
        attachment_base(&effective_base(&c, profile), &profile.space_id)
    };

    // 1. List remote hashes.
    let token = { let c = db.0.lock().expect("db mutex poisoned"); get_auth_token(&c, &profile.server_url).unwrap_or_else(|| profile.token.clone()) };
    let remote = match fetch_remote_attachments(&client, &att_base, &token).await {
        Ok(r) => r,
        // 开关关着时，附件清单拉不到**不该让整轮同步失败**：本轮本来就不传字节，
        // 拿不到清单只是"未上传/未下载件数"显示不出来（按 0 返回）。
        // 开关开着时保持原样：拉不到清单就是同步失败（原先的行为）。
        Err(_) if !att_on => return Ok(AttachmentSyncOutcome::skip_all()),
        Err(e) => return Err(e),
    };
    let remote_set: HashSet<String> = remote.items.iter().map(|i| i.hash.clone()).collect();

    // 2. Local hashes (files on disk).
    //    ★ 按空间分之后：本空间目录 ＋ **老位置**（`<根>/<桶>/…` 与 `<根>/<hash>.<ext>`）。
    //      老位置那份照样算"本地已有"——否则升级后每台设备都会把老附件重新下一遍
    //      （而读路径本来就回退得到它）。
    let mut local_set = scan_local_attachment_hashes(&attachments_dir);
    local_set.extend(scan_local_attachment_hashes(&crate::attachments::attachments_root(
        &app_data_dir,
    )));

    // 3/4 步的待传清单：**一次算清**，既是循环的输入，也是"未上传/未下载 N 个"的来源。
    let up_items: Vec<String> = local_set.difference(&remote_set).cloned().collect();
    let down_items: Vec<&RemoteAttachment> = remote
        .items
        .iter()
        .filter(|i| is_valid_attachment_hash(&i.hash) && !local_set.contains(&i.hash))
        .collect();
    // 入口就是关的 ⇒ 全部待传件都被开关挡下（这一支不算 `paused`：稳态不是"停止"）。
    let mut skipped_upload = if att_on { 0 } else { up_items.len() };
    let mut skipped_download = if att_on { 0 } else { down_items.len() };

    // 3. Upload local attachments missing on server. When at-rest encryption is on
    // (session unlocked), the on-disk bytes are ciphertext (nonce||ct) while the
    // server verifies SHA-256 against the claimed (plaintext) hash — so we must
    // decrypt before upload. When encryption is off, stream the plaintext file
    // directly to keep large-file memory usage low.
    let session_key = {
        let c = db.0.lock().expect("db mutex poisoned");
        security::key_if_enabled(&c)
    };
    for (idx, hash) in up_items.iter().enumerate() {
        // 入口就是关的 ⇒ 本轮不传字节（件数已在上面的初始化里记好），而且**不算"停止"**。
        // ⚠️ 2026-09-15 真机验收修：原先只设了件数、循环照进，于是第一轮循环的开关检查立刻把
        // `paused` 置真 ⇒ 面板报"**途中**关闭了附件同步"，而用户是在同步**之前**关的（文案与事实不符）。
        if !att_on {
            break;
        }
        // P6.1：**每次迭代之间重读开关**——中途关掉要能停（§五.7）。
        // 粒度 = 文件级：最坏等待 = 当前这一件的传输时间；**已完成的不回滚**。
        {
            let c = db.0.lock().expect("db mutex poisoned");
            if !attachments_enabled(&c, &profile.ws_id) {
                paused = true;
                paused_reason = "switch".to_string();
                // 剩余（含当前这件）都被挡下 ⇒ 面板能报出"未上传 N 个"。
                skipped_upload = up_items.len() - idx;
                break;
            }
        }
        // ★ 按空间找（本空间目录 → 老位置）：老附件在升级后照样传得上去。
        let path = match crate::attachments::find_attachment(&app_data_dir, &profile.ws_id, hash) {
            Some(p) => p,
            None => continue,
        };
        // ⚠️ 上传前先确认这个 stem **就是内容哈希**（64 位十六进制）。不是 ⇒ 跳过。
        //
        // 2026-09-15 真机验收发现：设备上残留了 9 个**两字符名**的文件（`9d.png` / `ac.png` …，
        // 看着像旧版本"忘了分桶目录"写出来的），上传循环把它们当成本地待上传附件 ⇒
        // 服务端 `valid_hash` 直接 400 并在**读完 body 之前关掉连接** ⇒ 客户端只看到
        // `error sending request for url (...)`——这个报错与真实原因（名字不是哈希）
        // 毫不相干，而且白传一遍大文件。
        // 下载侧本来就有同一道校验（`is_valid_attachment_hash`），上传侧一直缺。
        if !is_valid_attachment_hash(hash) {
            failed += 1;
            eprintln!("[sync] 附件 {hash} 的存储名不是 SHA-256（历史遗留文件？）——跳过上传");
            continue;
        }
        // Determine mime from local DB row.
        let mime = {
            let c = db.0.lock().expect("db mutex poisoned");
            c.query_row(
                "SELECT mime FROM attachments WHERE hash = ?1 LIMIT 1",
                params![hash],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
            .unwrap_or_else(|| "application/octet-stream".to_string())
        };
        let body = match &session_key {
            Some(k) => {
                let raw = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
                let plain = security::decrypt_attachment_bytes(Some(k), &raw)?;
                reqwest::Body::from(plain)
            }
            None => {
                let file = tokio::fs::File::open(&path).await.map_err(|e| e.to_string())?;
                reqwest::Body::wrap_stream(ReaderStream::new(file))
            }
        };
        // P1：上报进度（放在真正发请求之前，和 `web.ts` 的时机一致）。
        emit_attachment_progress(app, "up", idx + 1, up_items.len(), &mime);
        let mut req = client
            .post(format!("{att_base}/attachments/{hash}?mime={mime}"))
            .body(body);
        if !profile.token.is_empty() {
            req = req.bearer_auth(&profile.token);
        }
        // C1：**一件失败不炸整轮**（原先这里是 `?`）。上传失败多半是网络抖动或服务端
        // 4xx/5xx；整轮失败会让"优雅停止"永远做不到，也让已经成功的部分白跑。
        match req.send().await.and_then(|r| r.error_for_status()) {
            Ok(_) => {
                att_items.push(SyncItem { entity: "attachment".to_string(), entity_id: hash.clone(), op: "upsert".to_string(), dir: "push".to_string(), title: String::new() });
            }
            Err(e) => {
                failed += 1;
                eprintln!("[sync] 附件 {hash} 上传失败（跳过）：{e}");
            }
        }
    }

    // 4. Download remote attachments missing locally.
    //
    // C1：文件大小取自**同步过来的 `attachments.size`**（元数据本来就随 `changes` 到本地，
    // 也正是"看得见但打不开"那条状态的来源）⇒ **不需要改服务端**、也不用为每个文件多发一次
    // HEAD 请求。⚠️ 拿不到大小（本地还没有那行元数据）时不预判，交给磁盘余量与总量上限兜底。
    let local_sizes: std::collections::HashMap<String, i64> = {
        let c = db.0.lock().expect("db mutex poisoned");
        let mut map = std::collections::HashMap::new();
        let mut stmt = c
            .prepare("SELECT hash, size FROM attachments")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            map.insert(r.0, r.1);
        }
        map
    };

    // ---- C1 预算刹车（2026-09-15）----
    // 三道闸门，触发即**优雅停止 + 说明原因**，都不报错：
    //   ① 磁盘余量 < 下限（硬性、不可关）——**停止**
    //   ② 单文件超过阈值 —— **跳过该件、继续下一件**（不是停止）
    //   ③ 本轮下载总量上限 —— **停止**（默认 `0` = 只报告不拦截）
    let budget = { let c = db.0.lock().expect("db mutex poisoned"); read_budget(&c) };
    let mb = 1024u64 * 1024;
    let disk_floor_bytes = budget.disk_floor_mb.saturating_mul(mb);
    let max_file_bytes = if budget.max_file_mb == 0 { u64::MAX } else { budget.max_file_mb.saturating_mul(mb) };
    let run_cap_bytes = if budget.max_run_mb == 0 { u64::MAX } else { budget.max_run_mb.saturating_mul(mb) };
    let mut bytes_downloaded: u64 = 0;
    let mut skipped_too_large = 0usize;

    for (idx, item) in down_items.iter().enumerate() {
        // 入口就是关的 ⇒ 本轮不传字节、也**不算"停止"**（同上传侧，2026-09-15 真机验收修）。
        if !att_on {
            break;
        }
        // P6.1：**每次迭代之间重读开关**——中途关掉要能停（§五.7）。
        {
            let c = db.0.lock().expect("db mutex poisoned");
            if !attachments_enabled(&c, &profile.ws_id) {
                paused = true;
                paused_reason = "switch".to_string();
                skipped_download = down_items.len() - idx;
                break;
            }
        }
        let known_size = local_sizes.get(&item.hash).copied().unwrap_or(-1);
        // ② 单文件阈值：跳过这一件，**继续**（用户要的是"别自动拉大视频"，不是"整个同步停摆"）。
        if known_size > 0 && (known_size as u64) > max_file_bytes {
            skipped_too_large += 1;
            continue;
        }
        // ③ 本轮总量上限：把这一件算进去再判，避免"最后一件把上限顶穿"。
        if known_size > 0 && bytes_downloaded.saturating_add(known_size as u64) > run_cap_bytes {
            paused = true;
            paused_reason = "run_cap".to_string();
            skipped_download = down_items.len() - idx;
            break;
        }
        // ① 磁盘余量下限：**硬性**。把这一件的大小一起算进去，否则会贴着下限把它写满。
        // 查不到剩余空间时**不拦**（fail-open，见 `crate::disk` 的模块注释）。
        if let Some(free) = crate::disk::available_bytes(&attachments_dir) {
            let need = disk_floor_bytes.saturating_add(if known_size > 0 { known_size as u64 } else { 0 });
            if free < need {
                paused = true;
                paused_reason = "disk_floor".to_string();
                skipped_download = down_items.len() - idx;
                break;
            }
        }
        // The hash comes from the server (untrusted): reject anything that is not a
        // canonical SHA-256 hex before joining it into a filesystem path, to prevent
        // a malicious server from writing outside the attachments dir.
        //
        // ⚠️ 这条校验和"本地已有就跳过"**都在构造 `down_items` 时用同一个谓词过滤过了**
        // （见上面 `is_valid_attachment_hash(&i.hash) && !local_set.contains(...)`）。
        // 这里不再重复判断：同一件事写两处，改了一处忘了另一处就是 bug。
        //
        // P1：上报进度（与 `web.ts` 的时机、文案、字段一致）。
        emit_attachment_progress(app, "down", idx + 1, down_items.len(), &item.hash[..8.min(item.hash.len())]);
        match download_one_attachment(&client, &att_base, &profile.token, item, &attachments_dir, session_key.as_ref(), db).await {
            Ok(size) => {
                bytes_downloaded = bytes_downloaded.saturating_add(size.max(0) as u64);
                att_items.push(SyncItem { entity: "attachment".to_string(), entity_id: item.hash.clone(), op: "upsert".to_string(), dir: "pull".to_string(), title: String::new() });
            }
            Err(e) => {
                // C1：**一件失败不炸整轮**（原先这里是 `?`：一次网络抖动就让整轮同步失败，
                // 也就无法"优雅停止"）。记一笔、继续下一件，件数进报告——否则是静默丢件。
                failed += 1;
                eprintln!("[sync] 附件 {} 下载失败（跳过）：{e}", item.hash);
            }
        }
    }

    Ok(AttachmentSyncOutcome { items: att_items, paused, paused_reason, skipped_upload, skipped_download, skipped_too_large, failed, bytes_downloaded })
}

/// 扫出本地 `attachments/` 目录里**已经落地**的附件内容哈希（文件名的主干）。
///
/// 两种布局都认：新的分桶布局 `attachments/<hh>/<hash>.<ext>`，以及老版本的平铺
/// `attachments/<hash>.<ext>`。
///
/// ⚠️ 2026-09-22 真机验收修（连同 `sync.rs` 上传循环里那条 `failed += 1`）：
/// 平铺那一支原先**没有排除目录**，而分桶目录名恰好是**两个十六进制字符**
/// （`08` / `0a` / …），于是每个桶都被当成本地待上传附件进了 `up_items`，再在上传
/// 循环里过不了 `is_valid_attachment_hash` ⇒ `failed += 1`。面板于是报出
/// 「N 个传输失败」，而 **N == 分桶目录数**，与真实传输毫无关系：
/// 桌面端实测同一份数据先报 33 个（那时 33 个桶），附件收完再报 57 个（57 个桶），
/// 两次都是「上传 0 / 拉取 0」——而两端的字节其实已经 56/56/56 完全一致
/// （本地 56 件 = 服务端 meta 56 行 = 服务端 blob 56 个），页面与附件都同步到位。
///
/// 目录**只认**两字符十六进制的分桶目录；其它目录（用户自己塞进来的）一概不算附件。
fn scan_local_attachment_hashes(dir: &Path) -> HashSet<String> {
    let mut set = HashSet::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return set;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // 排除 `.part` 临时文件（下载中断残留）：其内容哈希与目标不符，
        // 作为“本地待上传附件”上传会被服务端 SHA-256 校验拒绝（400）。
        if name.ends_with(".part") {
            continue;
        }
        let is_bucket = name.len() == 2 && name.chars().all(|c| c.is_ascii_hexdigit());
        if entry.path().is_dir() {
            if !is_bucket {
                continue;
            }
            if let Ok(files) = std::fs::read_dir(entry.path()) {
                for f in files.flatten() {
                    let fname = f.file_name().to_string_lossy().into_owned();
                    if fname.ends_with(".part") {
                        continue;
                    }
                    if let Some(stem) = fname.split('.').next() {
                        if !stem.is_empty() {
                            set.insert(stem.to_string());
                        }
                    }
                }
            }
            continue;
        }
        if let Some(stem) = name.split('.').next() {
            if !stem.is_empty() {
                set.insert(stem.to_string());
            }
        }
    }
    set
}

/// Canonical SHA-256 hex (64 chars). Used to validate server-supplied hashes
/// before joining them into a local filesystem path — prevents path traversal if
/// a malicious/compromised sync server returns e.g. `../../meta.db` as a hash.
fn is_valid_attachment_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())
}

/// B4-b：**收编 / 自愈"兜底行"**（调用点与完整来龙去脉见 `do_pull` 的附件分支）。
///
/// 兜底行 = 下载路径在"元数据还没到"时建的那行：`name = <hash>.<ext>`、`page_id = NULL`、
/// **纯本地**（不记 `change`，uuid 从未上过服务端）。元数据行到了之后：
/// - 元数据行**已经**在 ⇒ 删掉多余的兜底行（自愈历史重复）；
/// - 元数据行**还不在** ⇒ 把兜底行**原地改写**成元数据行（收编，不新增行）。
///
/// 判据里的 `page_id IS NULL AND name LIKE hash || '.%'` 是**防止误伤**：
/// 用户自己导入的文件也是 `page_id = NULL`，但名字是原名（不带 hash 前缀）⇒ 不会被碰。
fn adopt_or_heal_fallback_row(
    c: &Connection,
    id: &str,
    name: &str,
    page_id: Option<&str>,
    hash: &str,
) -> Result<(), String> {
    // ① 自愈：元数据行已在 ⇒ 删掉那条多余的兜底行
    c.execute(
        "DELETE FROM attachments
          WHERE hash = ?1 AND page_id IS NULL AND name LIKE ?1 || '.%'
            AND EXISTS (SELECT 1 FROM attachments WHERE id = ?2)",
        params![hash, id],
    )
    .map_err(|e| e.to_string())?;
    // ② 收编：元数据行不在、但有兜底行 ⇒ 原地改写（`NOT EXISTS` 避开主键冲突）
    c.execute(
        "UPDATE attachments SET id = ?1, name = ?2, page_id = ?3
          WHERE hash = ?4 AND page_id IS NULL AND name LIKE ?4 || '.%'
            AND NOT EXISTS (SELECT 1 FROM attachments WHERE id = ?1)",
        params![id, name, page_id, hash],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn ext_from_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "application/pdf" => "pdf",
        _ => "bin",
    }
}

// ---------------------------------------------------------------------------
// Near-realtime collaboration (P0.2 presence / P1 comments+notifications / P1.5 SSE).
// Client-side thin clients to the sync-server's collab endpoints. The desktop
// client speaks HTTP via reqwest (no browser origin policy), so these mirror the
// web.ts branches that use syncFetch — same endpoint, same auth.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn team_presence_beat(server_url: String, token: String, space_id: String, page_id: Option<String>, device_id: Option<String>) -> Result<serde_json::Value, String> {
    let url = format!("{}/spaces/{}/presence", server_url.trim_end_matches('/'), space_id);
    let client = reqwest::Client::new();
    let resp = client.post(&url).bearer_auth(&token).json(&serde_json::json!({
        "page_id": page_id.unwrap_or_default(),
        "device_id": device_id.unwrap_or_default(),
    })).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("presence 心跳失败 {}", resp.status())); }
    Ok(resp.json().await.map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn team_online(server_url: String, token: String, space_id: String) -> Result<serde_json::Value, String> {
    let url = format!("{}/spaces/{}/online", server_url.trim_end_matches('/'), space_id);
    let client = reqwest::Client::new();
    let resp = client.get(&url).bearer_auth(&token).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("获取在线失败 {}", resp.status())); }
    Ok(resp.json().await.map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn team_list_comments(server_url: String, token: String, space_id: String, page_id: String) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("{}/spaces/{}/pages/{}/comments", server_url.trim_end_matches('/'), space_id, page_id);
    let client = reqwest::Client::new();
    let resp = client.get(&url).bearer_auth(&token).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("拉取评论失败 {}", resp.status())); }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v["items"].as_array().cloned().unwrap_or_default())
}

#[tauri::command]
pub async fn team_add_comment(server_url: String, token: String, space_id: String, page_id: String, body: String, parent_id: Option<String>, mentions: Option<Vec<String>>) -> Result<serde_json::Value, String> {
    let url = format!("{}/spaces/{}/pages/{}/comments", server_url.trim_end_matches('/'), space_id, page_id);
    let client = reqwest::Client::new();
    let resp = client.post(&url).bearer_auth(&token).json(&serde_json::json!({
        "body": body,
        "parent_id": parent_id,
        "mentions": mentions.unwrap_or_default(),
    })).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("添加评论失败 {}", resp.status())); }
    Ok(resp.json().await.map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn team_delete_comment(server_url: String, token: String, space_id: String, comment_id: String) -> Result<(), String> {
    let url = format!("{}/spaces/{}/comments/{}", server_url.trim_end_matches('/'), space_id, comment_id);
    let client = reqwest::Client::new();
    let resp = client.delete(&url).bearer_auth(&token).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("删除评论失败 {}", resp.status())); }
    Ok(())
}

#[tauri::command]
pub async fn team_list_notifications(server_url: String, token: String) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("{}/notifications", server_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client.get(&url).bearer_auth(&token).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("拉取通知失败 {}", resp.status())); }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v["items"].as_array().cloned().unwrap_or_default())
}

#[tauri::command]
pub async fn team_seen_notification(server_url: String, token: String, id: String) -> Result<(), String> {
    let url = format!("{}/notifications/{}/seen", server_url.trim_end_matches('/'), id);
    let client = reqwest::Client::new();
    let resp = client.post(&url).bearer_auth(&token).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("标记已读失败 {}", resp.status())); }
    Ok(())
}

#[tauri::command]
pub async fn team_seen_all_notifications(server_url: String, token: String) -> Result<(), String> {
    let url = format!("{}/notifications/seen-all", server_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client.post(&url).bearer_auth(&token).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("全部已读失败 {}", resp.status())); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ───── ③ 0b（2026-09-24）：公开材料的推 / 取 ＋ **第二台设备只凭口令**的端到端判据

    /// 假同步服务端：`PUT /spaces/{id}/keyring` 把材料存下来，`GET` 再原样回给它。
    /// 返回 `(port, 句柄)`。用裸 TCP 写最小 HTTP 响应，不引额外依赖（同 `sync_stream` 那族）。
    ///
    /// ⚠️ 读 body **按字节收齐再转字符串**：分块读时在多字节字符中间切开会让中文变乱码
    /// （这一条当场踩过 —— 材料里有中文 key 时会把"存进去的"和"取回来的"弄成不一样）。
    async fn fake_keyring_server() -> (u16, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let handle = tokio::spawn(async move {
            let mut stored: Option<String> = None;
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let mut raw: Vec<u8> = Vec::new();
                let mut tmp = [0u8; 4096];
                let head_end = loop {
                    if let Some(p) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                        break p + 4;
                    }
                    let n = sock.read(&mut tmp).await.unwrap_or(0);
                    if n == 0 {
                        break 0;
                    }
                    raw.extend_from_slice(&tmp[..n]);
                };
                if head_end == 0 {
                    continue; // 半截请求：丢掉这条连接
                }
                let head = String::from_utf8_lossy(&raw[..head_end]).to_string();
                let want: usize = head
                    .lines()
                    .find_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        if k.eq_ignore_ascii_case("content-length") {
                            v.trim().parse().ok()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);
                while raw.len() < head_end + want {
                    let n = sock.read(&mut tmp).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    raw.extend_from_slice(&tmp[..n]);
                }
                let body = String::from_utf8_lossy(&raw[head_end..]).to_string();
                let method = head.split_whitespace().next().unwrap_or("").to_string();
                let (status, payload) = match method.as_str() {
                    "PUT" => {
                        let v: serde_json::Value =
                            serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
                        stored = v["keyring_json"].as_str().map(|s| s.to_string());
                        (200u16, "{\"ok\":true}".to_string())
                    }
                    _ => match stored.clone() {
                        Some(m) => (200u16, serde_json::json!({ "keyring_json": m }).to_string()),
                        None => (404u16, "{\"error\":\"none\"}".to_string()),
                    },
                };
                let resp = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    payload.len(),
                    payload
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.flush().await;
                drop(sock); // 一条连接一次（reqwest 会自己重连）
            }
        });
        (port, handle)
    }

    /// 造一个全新的"设备目录"（带 meta，丢弃连接）。
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "shuyo-0b-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(crate::db::spaces_dir(&d)).unwrap();
        drop(crate::db::open_meta_conn_at(&d).unwrap());
        d
    }

    /// ★★ ③ 0b 的**端到端判据**：A 设备把公开材料推上去 ⇒ B 设备（全新目录、什么都没拷）
    /// 取回来装进本机 ⇒ **只凭主口令**解出**同一把**空间钥匙 —— 这就是"换设备只输一次口令"本身。
    ///
    /// ⚠️ 用**单线程 flavor**（`#[tokio::test]`）：本判据要握着 `SEC_LOCK` 走完整个流程
    /// （`KEYRING`/`SESSION_MASTER` 是进程级全局），而 `std::sync::MutexGuard` 不是 `Send`
    /// ⇒ 多线程 flavor 编译不过。
    #[tokio::test]
    async fn a_second_device_unlocks_the_space_with_the_passphrase_alone() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let (port, server) = fake_keyring_server().await;
        let base = format!("http://127.0.0.1:{port}");
        let client = reqwest::Client::new();

        // ── 设备 A：用口令建袋子 ＋ 给本机的 default 空间包一把钥匙 ⇒ 把材料推上去
        let dir_a = temp_dir("a");
        let c_a = crate::db::open_space_conn_at("default", &dir_a).unwrap();
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
        let mut kr = crate::keyring::Keyring::new();
        let master_a = kr.kdf.derive_master("我家猫叫mimi").unwrap();
        let key_a = crate::keyring::random_space_key();
        kr.wrap(&master_a, "default", &key_a).unwrap();
        crate::space_crypto::store_keyring(&c_a, &kr).unwrap();
        let material = crate::space_crypto::stored_material(&c_a)
            .unwrap()
            .expect("A 本机应当有材料");

        let pushed = http_put_keyring(&client, &base, "tok", "remote-sp", &material).await;
        assert_eq!(pushed.outcome, "ok", "{}", pushed.message);
        assert_eq!(pushed.bytes, material.len());
        assert_eq!(pushed.status, 200);

        // ── 设备 B：全新目录，本机什么都没有（＝换了一台机器、什么都没拷）
        let dir_b = temp_dir("b");
        let mut c_b = crate::db::open_space_conn_at("default", &dir_b).unwrap();
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
        assert!(
            crate::space_crypto::stored_material(&c_b).unwrap().is_none(),
            "B 本机一开始不该有材料"
        );
        assert!(!crate::space_crypto::space_status(&dir_b, "default").in_keyring);

        // 取回 ⇒ 装进本机
        let (got, body) = http_get_keyring(&client, &base, "tok", "remote-sp").await;
        assert_eq!(got.outcome, "ok", "{}", got.message);
        let body = body.expect("取回成功就要有材料原文");
        let report = crate::space_crypto::adopt_material(&c_b, &body, false).unwrap();
        assert!(report.adopted && report.spaces == 1, "{report:?}");

        // ★★ 只凭主口令
        let master_b = crate::space_crypto::master_from_passphrase(&c_b, "我家猫叫mimi")
            .unwrap()
            .expect("B 有了袋子 ⇒ 口令能推出主密钥");
        let key_b = crate::space_crypto::keyring()
            .unwrap()
            .unwrap_key(&master_b, "default")
            .unwrap();
        assert_eq!(key_b, key_a, "★★ 第二台设备只凭口令就把同一把空间钥匙拿回来了");
        assert!(
            crate::space_crypto::space_status(&dir_b, "default").in_keyring,
            "采纳之后：闸门眼里这个空间就是「已加密」"
        );

        // ★★ 把这一步走完 —— 这才是"换设备"真正的用途：B 在**自己**这个空间上开加密时，
        //    用的应当是**取回来的那把**空间钥匙（不是又随机一把）⇒ 两台设备的库被同一把钥匙保护。
        //    （闸门那一步也靠它：B 本机这个空间是"个人 ＋ 还没加密" ⇒ 不加密就**绑不上同步**。）
        crate::space_crypto::set_session_master(Some(master_b)).unwrap();
        let key_b2 = crate::space_crypto::enable_space(&mut c_b, &dir_b, "default", None)
            .expect("取回材料 ＋ 输过口令 ⇒ 开加密应当成功");
        assert_eq!(key_b2, key_a, "★★ 新设备开加密复用的是**同一把**空间钥匙（不是又随机一把）");
        assert!(
            crate::space_crypto::space_status(&dir_b, "default").encrypted_on_disk,
            "开完之后 B 自己的库应当**真的**是密文"
        );
        // ⚠️ 分类要**真的写进库**再让闸门参战：拿 `SpaceKind::Personal` 硬编码去调 `sync_gate`
        //    会把这条判据弄软（它测的就只剩"我把参数填对了"）。B 本机这个空间走的就是 A=3 那条路
        //    （本地新建 ⇒ 个人空间）⇒ 直接调那个真 API，再用**库里读出来的**分类去问闸门。
        crate::workspaces::insert_new_local_space(&c_b, "default", "新设备", "blue", 1.0, 1).unwrap();
        assert_eq!(
            crate::space_crypto::space_kind(&c_b, "default"),
            crate::space_crypto::SpaceKind::Personal,
            "本地新建 ⇒ 个人空间（A=3）"
        );
        assert_eq!(
            crate::space_crypto::sync_gate(
                &crate::space_crypto::space_status(&dir_b, "default"),
                crate::space_crypto::space_kind(&c_b, "default")
            ),
            crate::space_crypto::SyncGate::Allowed,
            "★ 到这一步闸门才放行：B 的空间现在敢绑同步了"
        );

        server.abort();
        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
    }

    /// 服务端上**还没有**那一份 ⇒ `not_on_server`（不是一个"空材料"，更不是错误）；
    /// 而且**不许给出 body** —— 空材料写进本机比不写危险得多。
    #[tokio::test]
    async fn pulling_from_a_server_that_has_nothing_is_a_plain_result_not_an_error() {
        let (port, server) = fake_keyring_server().await;
        let base = format!("http://127.0.0.1:{port}");
        let (r, body) = http_get_keyring(&reqwest::Client::new(), &base, "tok", "remote-sp").await;
        assert_eq!(r.outcome, "not_on_server");
        assert_eq!(r.status, 404);
        assert!(body.is_none(), "没取到就不许给上层一个 body");
        assert!(r.message.contains("先在原来那台设备上推一次"), "{}", r.message);
        server.abort();
    }

    /// 状态码 ⇒ 人话：**可操作**（说清是谁的问题、下一步怎么办），不把码原样丢给用户。
    #[test]
    fn keyring_status_messages_are_actionable() {
        assert!(keyring_status_message(403).contains("管理员"), "403 要说清要管理员");
        assert!(keyring_status_message(401).contains("重新登录"), "401 要说清下一步");
        assert!(keyring_status_message(413).contains("上限"), "413 要说清是上限");
        assert!(keyring_status_message(500).contains("500"), "认不出的码要把它报出来");
    }

    /// ★★ **"服务端不可信也不怕"这句话的判据**：服务端交过来的那份材料**不是你那一袋**
    /// （换过了 / 本来就是别人的），第二台设备装进去之后**解不开**，而且报一句**可操作**的话 ——
    /// 既不静默、也不会给出一把**错的**钥匙。
    ///
    /// 为什么必须有这一条：服务端**不解析、也不校验**那份材料（这是刻意的：真伪靠客户端解盒子时的
    /// AEAD）⇒ 如果没人钉住"换过的材料 ⇒ 打不开"，"服务端可以悄悄换盒子"这个洞就没人守。
    #[test]
    fn a_server_that_hands_over_a_different_bag_makes_the_second_device_fail_loudly() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let dir = temp_dir("swapped");
        let c = crate::db::open_space_conn_at("default", &dir).unwrap();
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();

        // ① 我自己那份（口令 P）—— 只是拿来对照，不进本机
        let mut mine = crate::keyring::Keyring::new();
        let m_mine = mine.kdf.derive_master("我的口令八个字").unwrap();
        mine.wrap(&m_mine, "default", &crate::keyring::random_space_key())
            .unwrap();

        // ② 服务端交过来的却是**别人那一袋**（口令 Q ＋ 另一把盐 ⇒ 另一把主密钥）
        let mut theirs = crate::keyring::Keyring::new();
        let m_theirs = theirs.kdf.derive_master("别人的口令八个字").unwrap();
        theirs
            .wrap(&m_theirs, "default", &crate::keyring::random_space_key())
            .unwrap();
        let swapped = theirs.to_json().unwrap();

        // ③ 装进本机（本机还没有袋子 ⇒ 采纳这一层不该拒绝：它**只验格式**，不验真伪）
        assert!(
            crate::space_crypto::adopt_material(&c, &swapped, false)
                .unwrap()
                .adopted,
            "格式合法就该装进来（真伪不在这里判）"
        );

        // ④ ★ 用**我的口令**去解 ⇒ 必须**报错**（AEAD 认出来），而且要说清两种可能
        let master = crate::space_crypto::master_from_passphrase(&c, "我的口令八个字")
            .unwrap()
            .unwrap();
        match crate::space_crypto::keyring().unwrap().unwrap_key(&master, "default") {
            Ok(k) => panic!(
                "★ 换过的盒子竟然解开了（拿到 {} 字节的钥匙）—— 这条判据塌了",
                k.len()
            ),
            Err(e) => {
                assert!(e.contains("盒子打不开"), "{e}");
                assert!(e.contains("口令不对或盒子被改过"), "要说清两种可能：{e}");
            }
        }

        // ⑤ 连那个空间的盒子都没有时，也要是一句人话（不是 panic、更不是空钥匙）
        let empty = crate::keyring::Keyring::new();
        let m_empty = empty.kdf.derive_master("空袋口令八个字").unwrap();
        let e = empty.unwrap_key(&m_empty, "default").unwrap_err();
        assert!(e.contains("没有空间"), "{e}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ ③ 0b 的**真服务端**判据（默认 `#[ignore]`：它要一台真服务端 ＋ 一把真设备密钥）。
    ///
    /// **为什么不能只在桩服务端上验**：桩服务端**不看 `Authorization`**、也**不在乎路径** ——
    /// 而"客户端到底有没有带 bearer、打的是不是 `/spaces/{id}/keyring`"正是最容易写错、
    /// 而桩一定发现不了的那一处（写错路径的客户端在桩上全绿，在真服务端上 404）。
    ///
    /// 跑法（详见交接文档 `docs/plans/2026-09-24-crdt-privacy-handoff.md` §7.0）：
    /// ```text
    /// # ① 拿一把真设备密钥（服务端仓库）
    /// shuyonote-sync-server --issue-device-key --space sp-e2e --db <tmp>/sync.db
    /// # ② 起服务
    /// shuyonote-sync-server --bind 127.0.0.1 --port 8799 --db <tmp>/sync.db
    /// # ③ 跑这一条
    /// $env:SYNCSRV_BASE="http://127.0.0.1:8799"; $env:SYNCSRV_DEVICE_KEY="sk_…"
    /// cargo test --lib the_client_talks_to_a_real_server -- --ignored --nocapture
    /// ```
    /// ⚠️ 跑完会在那台服务端上**留下一份公开材料**（客户端侧没有"删"这条路：删是"关闭加密"那一步的事）。
    #[tokio::test]
    #[ignore = "需要真服务端与真设备密钥（SYNCSRV_BASE / SYNCSRV_DEVICE_KEY），见交接文档 §7.0"]
    async fn the_client_talks_to_a_real_server_and_needs_its_bearer() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let base = std::env::var("SYNCSRV_BASE").expect("要设 SYNCSRV_BASE（例如 http://127.0.0.1:8799）");
        let token = std::env::var("SYNCSRV_DEVICE_KEY").expect("要设 SYNCSRV_DEVICE_KEY（sk_…）");
        let client = reqwest::Client::new();

        // ① 先钉一件事：**真服务端要 bearer** —— 空 token 必须被它挡回来（401 或 403，都算挡）
        let (no_auth, _) = http_get_keyring(&client, &base, "", "sp-e2e").await;
        assert!(
            no_auth.status == 401 || no_auth.status == 403,
            "★ 没带 token 竟然没被挡：outcome={} status={} msg={}",
            no_auth.outcome,
            no_auth.status,
            no_auth.message
        );
        assert_ne!(no_auth.outcome, "ok", "没带 token 不许当成功");

        // ② 设备 A：口令建袋 ＋ 包一把钥匙 ⇒ 推给**真服务端**
        let dir_a = temp_dir("real-a");
        let c_a = crate::db::open_space_conn_at("default", &dir_a).unwrap();
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
        let mut kr = crate::keyring::Keyring::new();
        let master_a = kr.kdf.derive_master("真服务端口令八个字").unwrap();
        let key_a = crate::keyring::random_space_key();
        kr.wrap(&master_a, "default", &key_a).unwrap();
        crate::space_crypto::store_keyring(&c_a, &kr).unwrap();
        let material = crate::space_crypto::stored_material(&c_a).unwrap().unwrap();

        let pushed = http_put_keyring(&client, &base, &token, "sp-e2e", &material).await;
        assert_eq!(pushed.outcome, "ok", "推失败：{}", pushed.message);

        // ③ 设备 B：全新目录 ⇒ 从真服务端取回 ⇒ 只凭口令解出**同一把**钥匙
        let dir_b = temp_dir("real-b");
        let c_b = crate::db::open_space_conn_at("default", &dir_b).unwrap();
        crate::space_crypto::set_keyring_for_test(None);
        crate::space_crypto::set_session_master(None).unwrap();
        let (got, body) = http_get_keyring(&client, &base, &token, "sp-e2e").await;
        assert_eq!(got.outcome, "ok", "取失败：{}", got.message);
        let body = body.expect("取回成功就要有材料原文");
        assert_eq!(body, material, "真服务端上取回来的必须与推上去的**逐字节相同**");
        let report = crate::space_crypto::adopt_material(&c_b, &body, false).unwrap();
        assert!(report.adopted, "{report:?}");
        let master_b = crate::space_crypto::master_from_passphrase(&c_b, "真服务端口令八个字")
            .unwrap()
            .unwrap();
        let key_b = crate::space_crypto::keyring()
            .unwrap()
            .unwrap_key(&master_b, "default")
            .unwrap();
        assert_eq!(key_b, key_a, "★★ 真服务端这条链路上，第二台设备只凭口令也拿回了同一把钥匙");

        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
    }

    /// ★ 外键守卫：**循环里任何一条变更失败（`?` 早退）都不能把外键永久关掉**。
    /// 老写法（恢复那句放在循环之后）在这条用例下会留下 `foreign_keys=0`，
    /// 而它作用在**长命的主连接**上 ⇒ 之后整个应用的外键约束都不生效。
    #[test]
    fn foreign_keys_guard_restores_even_when_the_batch_bails_early() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        let read = |c: &rusqlite::Connection| -> i64 {
            c.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap()
        };
        assert_eq!(read(&c), 1, "前置：外键本来是开的");

        // 模拟"批量应用中途失败"：进守卫 → 关外键 → 早退。
        fn apply_batch(c: &rusqlite::Connection) -> Result<(), String> {
            let _fk = ForeignKeysOff::new(c);
            assert_eq!(
                c.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0)).unwrap(),
                0,
                "守卫生效期间外键应当是关的"
            );
            Err("模拟第 3 条变更失败".to_string())
        }
        assert!(apply_batch(&c).is_err());
        assert_eq!(read(&c), 1, "早退之后外键必须已恢复（这正是老写法的漏洞）");

        // 成功路径同样恢复。
        {
            let _fk = ForeignKeysOff::new(&c);
        }
        assert_eq!(read(&c), 1);

        // 本来关着 ⇒ 恢复成关着（不许把用户/调用方的原状态改掉）。
        c.pragma_update(None, "foreign_keys", "OFF").unwrap();
        {
            let _fk = ForeignKeysOff::new(&c);
        }
        assert_eq!(read(&c), 0, "原状态是关的，恢复后也该是关的");
    }

    /// 2026-09-22 真机验收：本地附件清单**不许把分桶目录当成附件**。
    ///
    /// 判据（对着那次真机读数写）：同一个 `attachments/` 下
    ///   - `0a/<64 位 hash>.png`（新分桶布局）要认；
    ///   - `<64 位 hash>.pdf`（老平铺布局）要认；
    ///   - `0a` 这个**目录名**不能进集合——它就是"面板报 N 个传输失败、而 N == 桶数"的根源
    ///     （见 `scan_local_attachment_hashes` 的注释）；
    ///   - `*.part` 半成品不能进集合（名字里的哈希与内容不符，传上去会被服务端 400）。
    #[test]
    fn local_attachment_scan_ignores_bucket_dirs_and_part_files() {
        let dir = std::env::temp_dir().join(format!("shuyonote-att-scan-{}", uuid::Uuid::new_v4()));
        let bucket = dir.join("0a");
        std::fs::create_dir_all(&bucket).unwrap();
        let bucketed = "a".repeat(64);
        let flat = "b".repeat(64);
        let partial = "c".repeat(64);
        std::fs::write(bucket.join(format!("{bucketed}.png")), b"x").unwrap();
        std::fs::write(dir.join(format!("{flat}.pdf")), b"y").unwrap();
        std::fs::write(dir.join(format!("{partial}.7f3a.part")), b"z").unwrap();

        let got = scan_local_attachment_hashes(&dir);

        assert!(got.contains(&bucketed), "分桶布局里的 hash 要认：{got:?}");
        assert!(got.contains(&flat), "老平铺布局里的 hash 要认：{got:?}");
        assert_eq!(
            got.len(),
            2,
            "桶目录名与 .part 都不得进集合（进去就会被上传循环计成“传输失败”）：{got:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §0-C：**整批预扫**——这批变更里只要有一段本构建解不开，就要在应用**之前**整批拒绝。
    ///
    /// 为什么值得单独一条判据：逐条 `decrypt` 失败会**应用一半**（游标停在中途），
    /// 用户看到的是"同步了一部分、剩下老报错"，而真正原因是"这版应用读不了那个空间的数据"。
    /// 判据只覆盖这个**纯函数**的语义；"必须在应用循环之前调用"由 `do_pull` 里的调用点位置保证
    /// （⚠️ 诚实边界：这里没有起真服务端做端到端，属真机/集成验收）。
    #[test]
    fn prescan_payload_formats_refuses_the_whole_batch() {
        let ch = |payload: Option<String>| IncomingChange {
            seq: 1,
            entity: "page".to_string(),
            entity_id: "p1".to_string(),
            op: "upsert".to_string(),
            payload,
            updated_at: 1,
        };
        // 明文载荷（加密未开）：一律放行
        assert!(prescan_payload_formats(&[ch(Some(r#"{"id":"p1"}"#.to_string()))]).is_ok());
        // 没有载荷（delete 之类）：放行
        assert!(prescan_payload_formats(&[ch(None)]).is_ok());

        let keys = crate::crypto::derive_app_keys("pw", &crate::crypto::random_salt()).unwrap();
        let v1 = crate::crypto::encrypt_str("ok", &crate::crypto::AppKeys::legacy_only(keys.legacy)).unwrap();
        assert!(prescan_payload_formats(&[ch(Some(v1.clone()))]).is_ok(), "v1 载荷应当放行");

        // 伪造一段 v2（本构建解不开）：**一批里只要有一段**就必须整批拒绝
        let mut blob = crate::crypto::b64_decode(&v1).unwrap();
        blob[1] = crate::crypto::VERSION_SM4;
        let v2 = crate::crypto::b64_encode(&blob);
        let batch = [ch(Some(v1)), ch(Some(v2)), ch(None)];
        if cfg!(feature = "sm-crypto") {
            assert!(prescan_payload_formats(&batch).is_ok(), "国密构建读得了 v2，不该拦");
        } else {
            let err = prescan_payload_formats(&batch).unwrap_err();
            assert!(err.contains("整批拒绝"), "错误要说清'一条都没应用'：{err}");
            assert!(err.contains("国密版"), "错误要可操作：{err}");
        }
    }

    /// 复刻生产布局：main 为空间库，meta 作为 ATTACH 库承载 workspaces/sync_profiles。
    ///
    /// ⚠️ 这里的建表语句**必须和 `db.rs::meta_migrate` 的 `sync_profiles` 保持同形**：
    /// `PROFILE_COLS` 是按列名 SELECT 的，助手少一列 ⇒ `list_profiles` 直接 Err、
    /// 老测试全红（P6.1 加 `sync_attachments` 时就踩过一次）。
    fn conn_with_meta() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("ATTACH DATABASE ':memory:' AS meta").unwrap();
        c.execute_batch(
            "CREATE TABLE meta.workspaces (id TEXT PRIMARY KEY, deleted_at INTEGER);
             -- C1/C2 的设备级 KV（`read_budget` / `set_sync_budget` 依赖它；
             --  与 `db.rs::meta_migrate` 里的同名表同形）。
             CREATE TABLE meta.sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE meta.sync_profiles (
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
        c
    }

    /// `meta.auth_sessions` 的同形建表（与 `db.rs::meta_migrate` 一致）—— `claim_config`
    /// 的会话 token 那半要用它。
    fn with_auth_sessions(c: &Connection) {
        c.execute_batch(
            "CREATE TABLE meta.auth_sessions (
                 server_url TEXT PRIMARY KEY,
                 email      TEXT NOT NULL DEFAULT '',
                 user_id    TEXT NOT NULL DEFAULT '',
                 token      TEXT NOT NULL DEFAULT '',
                 created_at INTEGER NOT NULL DEFAULT 0,
                 expires_at INTEGER NOT NULL DEFAULT 0
             );",
        )
        .unwrap();
    }

    /// ★ 与前端 `crdt/claimClient.ts` 的三条口径成对（两侧各一份判据、同一套语义）：
    /// 200/`granted:true` ⇒ 拿到；200/`granted:false`／缺字段 ⇒ denied；
    /// **403 ⇒ denied（是裁定，不是"问不到"）**；401／5xx ⇒ "问不到"；2xx 但载荷读不懂 ⇒ 也"问不到"。
    #[test]
    fn lineage_claim_verdict_matches_client_semantics() {
        let got = lineage_claim_verdict(200, Some(&serde_json::json!({ "granted": true })));
        assert!(got.granted);
        assert!(got.unavailable.is_none(), "服务端回了话就不该标'问不到'");

        let got = lineage_claim_verdict(200, Some(&serde_json::json!({ "granted": false })));
        assert!(!got.granted);
        assert!(got.unavailable.is_none());

        // 缺字段／类型不对 ⇒ denied（**不猜**成 granted）
        assert!(!lineage_claim_verdict(200, Some(&serde_json::json!({ "ok": 1 }))).granted);
        assert!(!lineage_claim_verdict(200, Some(&serde_json::json!({ "granted": "true" }))).granted);

        // ★ 403 = "你不是这个空间的成员／空间没选" ⇒ **`offline`**（第 42 轮改）。
        //   它**不是**"别人先 claim"—— 那件事由 200 ＋ `granted:false` 表达（上一段）。
        //   第一版把 403 当 denied ⇒ 每张没本地状态的页在桌面上都被拒建血统 ＋ 弹一句错话。
        let got = lineage_claim_verdict(403, None);
        assert!(!got.granted);
        assert_eq!(got.unavailable, Some(true), "403 是授权/配置问题 ⇒ 归'问不到'（离线那一支）");

        for status in [401u16, 500, 502] {
            let got = lineage_claim_verdict(status, None);
            assert!(!got.granted);
            assert_eq!(got.unavailable, Some(true), "HTTP {status} 应当归'问不到'（离线那一支）");
        }
        assert_eq!(
            lineage_claim_verdict(200, None).unavailable,
            Some(true),
            "2xx 但载荷读不懂 ⇒ 不猜成 granted，归'问不到'"
        );
    }

    /// 与 TS 侧 `claimScope.test.ts` ② 成对：**问不到就不发请求**（`None` —— 不是错误，更不该 panic）。
    /// 三种"正常但没法 claim"的中间态都要落这一支：没档案／只填了地址／只填了空间。
    #[test]
    fn claim_config_without_a_complete_binding_is_none() {
        let c = conn_with_meta();
        with_auth_sessions(&c);
        set_meta_state(&c, KEY_DEVICE_ID, "dev-1").unwrap();
        // ① 完全没有档案
        assert!(claim_config(&c, "ws").unwrap().is_none());

        // ② 解绑后只留地址（登录了但**还没选空间**：保存地址与选空间是两步）
        c.execute_batch("INSERT INTO meta.sync_profiles (ws_id, server_url) VALUES ('ws', 'http://a');")
            .unwrap();
        assert!(claim_config(&c, "ws").unwrap().is_none());

        // ③ 只填了空间、没有地址
        c.execute_batch("UPDATE meta.sync_profiles SET server_url = '', space_id = 'SP' WHERE ws_id = 'ws';")
            .unwrap();
        assert!(claim_config(&c, "ws").unwrap().is_none());

        // ④ 档案在**别人**名下 ⇒ 这一页的工作空间仍然拿不到（不是"随便挑一个"）
        c.execute_batch(
            "UPDATE meta.sync_profiles SET server_url = 'http://a', space_id = 'SP' WHERE ws_id = 'ws';
             INSERT INTO meta.sync_profiles (ws_id, server_url, space_id) VALUES ('other', 'http://b', 'SP-B');",
        )
        .unwrap();
        let got = claim_config(&c, "ws").unwrap().expect("自己的档案该找得到");
        assert_eq!(got.2, "SP", "必须取**这一页那个工作空间**的档案，不是排序第一个");
    }

    /// 与 TS 侧 `claimScope.test.ts` ①/③ 成对：**发出去的是远端 `space_id`**（不是本地工作空间 id），
    /// 地址归一成不带结尾斜杠，会话 token 优先于档案里那份（与 `do_push` 同一口径）。
    #[test]
    fn claim_config_resolves_remote_space_and_prefers_session_token() {
        let c = conn_with_meta();
        with_auth_sessions(&c);
        c.execute_batch(
            "INSERT INTO meta.sync_profiles (ws_id, server_url, token, space_id)
                 VALUES ('ws', 'http://a/', 'stale', 'REMOTE-SP');
             INSERT INTO meta.auth_sessions (server_url, token) VALUES ('http://a', 'fresh');",
        )
        .unwrap();

        let (server, token, space_id) = claim_config(&c, "ws").unwrap().expect("有配置就该拿到三件");
        assert_eq!(server, "http://a", "结尾斜杠归一（与同步请求同一形状）");
        assert_eq!(token, "fresh", "会话 token 优先于档案里那份");
        // ★ 承重：这是**远端** space id；本地工作空间 id 是 "ws" —— 第一版就是把 "ws" 发出去的
        assert_eq!(space_id, "REMOTE-SP");
        assert_ne!(space_id, "ws");
    }

    /// ★ §11.4 收口（第 42 轮）：页载荷里的 **CRDT 状态**要**收进旁路表**；没有/不认识/坏了
    /// 三种情形**分开**处置（"没有"⇒ 与接线前逐字相同；后两种 ⇒ **不猜**且留痕）。
    #[test]
    fn absorb_incoming_crdt_state_keeps_bytes_and_never_guesses() {
        let (c, dir) = pending_conn("absorb-crdt");
        let page = "p1";

        // ① 有状态 ⇒ 收下（逐字节）
        let with_state = r#"{"id":"p1","title":"t","crdt_state":{"v":1,"state":[0,255,128]}}"#;
        assert_eq!(absorb_incoming_crdt_state(&c, page, 11, with_state, 1).unwrap(), true);
        let got = crate::page_crdt::read_pending_states(&c, page).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].state, vec![0, 255, 128]);

        // ② 没有这一项 ⇒ 什么也不做（**与接线前逐字相同**），原来那条不动
        assert_eq!(absorb_incoming_crdt_state(&c, page, 12, r#"{"id":"p1"}"#, 2).unwrap(), false);
        assert_eq!(crate::page_crdt::read_pending_states(&c, page).unwrap().len(), 1);

        // ③ 版本不认识 ⇒ **不猜**、不落库（内容按今天那条路走）
        let unknown = r#"{"id":"p1","crdt_state":{"v":99,"state":[1]}}"#;
        assert_eq!(absorb_incoming_crdt_state(&c, page, 13, unknown, 3).unwrap(), false);
        assert_eq!(crate::page_crdt::read_pending_states(&c, page).unwrap().len(), 1);

        // ④ 载荷坏了 ⇒ 同样不收（**留痕**），更不许当空状态
        let broken = r#"{"id":"p1","crdt_state":{"v":1,"state":[1,300]}}"#;
        assert_eq!(absorb_incoming_crdt_state(&c, page, 14, broken, 4).unwrap(), false);
        assert_eq!(crate::page_crdt::read_pending_states(&c, page).unwrap().len(), 1);

        // ⑤ 同一笔重放（同 seq）⇒ 幂等，不新增行
        assert_eq!(absorb_incoming_crdt_state(&c, page, 11, with_state, 5).unwrap(), true);
        assert_eq!(crate::page_crdt::read_pending_states(&c, page).unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(dir);
    }

    /// ★ §11.4 收口 · **推**那一半：有状态才挂字段，没状态**载荷逐字不变**（老路径零感知）。
    #[test]
    fn record_page_upsert_attaches_crdt_state_only_when_present() {
        let (c, dir) = pending_conn("push-crdt");
        let page = remote_page("p1", &page_json("b1", 1, "字"));

        // ① **没有 CRDT 状态** ⇒ 载荷里**不许凭空长出一个 `crdt_state`**。
        //    ⚠️ **判据替换（2026-09-25，丙-③）**：这里原先断言"载荷与直接序列化 `PageDetail`
        //    **逐字节相同**"。在"每条页 upsert 都要带 HLC 戳"之后那句**不再成立** ——
        //    戳是**无条件**挂的（它是判序的依据），所以"逐字不变"这个**形式**已经错了，
        //    不是判据被放宽了。真正的意图用下面三条钉住：没有 `crdt_state` ＋ **戳在**
        //    ＋ **去掉戳之后**与裸 `PageDetail` 同值。
        record_page_upsert(&c, &page).unwrap();
        let plain: String = c
            .query_row("SELECT payload FROM changes WHERE entity_id = 'p1' ORDER BY seq DESC LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            crate::crdt_wire::extract_wire_state(&plain).unwrap(),
            crate::crdt_wire::WireState::None,
            "没有状态 ⇒ 不许凭空长出一个 `crdt_state`"
        );
        assert!(
            matches!(crate::hlc::stamp_of_payload(&plain), crate::hlc::PayloadStamp::Ok(_)),
            "丙-③ 之后，页 upsert 的载荷必须带本机戳：{plain}"
        );
        let bare: serde_json::Value = serde_json::from_str(&serde_json::to_string(&page).unwrap()).unwrap();
        let after: serde_json::Value = serde_json::from_str(&crate::hlc::without_stamp(&plain)).unwrap();
        assert_eq!(after, bare, "去掉那枚戳之后，载荷必须**同值于**直接序列化的 PageDetail");

        // ② 有状态 ⇒ 挂上 crdt_state，且能按同一张表读回来
        crate::page_crdt::write_page_crdt_state(&c, "p1", &[7, 8, 9], 1).unwrap();
        record_page_upsert(&c, &page).unwrap();
        let tagged: String = c
            .query_row("SELECT payload FROM changes WHERE entity_id = 'p1' ORDER BY seq DESC LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_ne!(tagged, plain);
        assert_eq!(
            crate::crdt_wire::extract_wire_state(&tagged).unwrap(),
            crate::crdt_wire::WireState::Ok(vec![7, 8, 9])
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn list_profiles_skips_deleted_and_orphan_workspaces() {
        let c = conn_with_meta();
        c.execute_batch(
            "INSERT INTO meta.workspaces (id, deleted_at) VALUES ('live', NULL), ('gone', 1730000000000);
             INSERT INTO meta.sync_profiles (ws_id, server_url) VALUES
                 ('live', 'http://a'), ('gone', 'http://b'), ('orphan', 'http://c');",
        )
        .unwrap();

        let got = list_profiles(&c).unwrap();

        // 软删除的空间（gone）与没有 workspaces 行的孤儿档案（orphan）都不出现，
        // 面板不会再显示裸 UUID 行，sync_now 也不会去同步已删除的空间。
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].ws_id, "live");
        assert_eq!(got[0].server_url, "http://a");
    }

    #[test]
    fn list_profiles_keeps_row_after_workspace_restore() {
        let c = conn_with_meta();
        c.execute_batch(
            "INSERT INTO meta.workspaces (id, deleted_at) VALUES ('ws', 1730000000000);
             INSERT INTO meta.sync_profiles (ws_id, server_url) VALUES ('ws', 'http://a');",
        )
        .unwrap();
        assert!(list_profiles(&c).unwrap().is_empty());

        // 档案行只是被「隐藏」而非删除：空间恢复后绑定原样回来。
        c.execute_batch("UPDATE meta.workspaces SET deleted_at = NULL WHERE id = 'ws'").unwrap();
        let got = list_profiles(&c).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].server_url, "http://a");
    }

    // ---- P6.1「每空间开关」 ----

    #[test]
    fn attachments_enabled_defaults_on_for_missing_row_and_column() {
        let c = conn_with_meta();
        // 没有这一行 ⇒ 按"开"（与 `DEFAULT 1` 一致）：升级 / 新库都不能静默改同步范围。
        assert!(attachments_enabled(&c, "nope"));
        c.execute_batch(
            "INSERT INTO meta.workspaces (id, deleted_at) VALUES ('ws', NULL);
             INSERT INTO meta.sync_profiles (ws_id, server_url, space_id) VALUES ('ws', 'http://a', 'sp');",
        )
        .unwrap();
        // 建表默认值就是"开"。
        assert!(attachments_enabled(&c, "ws"));
    }

    #[test]
    fn set_attachments_enabled_round_trips_and_rejects_unknown_workspace() {
        let c = conn_with_meta();
        c.execute_batch(
            "INSERT INTO meta.workspaces (id, deleted_at) VALUES ('ws', NULL);
             INSERT INTO meta.sync_profiles (ws_id, server_url, space_id) VALUES ('ws', 'http://a', 'sp');",
        )
        .unwrap();

        set_attachments_enabled(&c, "ws", false).unwrap();
        assert!(!attachments_enabled(&c, "ws"));
        set_attachments_enabled(&c, "ws", true).unwrap();
        assert!(attachments_enabled(&c, "ws"));

        // 没有 profile 行 ⇒ 报错（面板据此提示"先绑定空间"），而不是静默成功。
        assert!(set_attachments_enabled(&c, "ghost", false).is_err());
    }

    #[test]
    fn set_attachments_enabled_leaves_credentials_untouched() {
        // 这是 P6.1 最要紧的一条：翻转开关**绝不能**碰 token / space_id。
        // （不用 `set_sync_profile` 的原因就是它对未传字段是"清空"语义。）
        let c = conn_with_meta();
        c.execute_batch(
            "INSERT INTO meta.workspaces (id, deleted_at) VALUES ('ws', NULL);
             INSERT INTO meta.sync_profiles (ws_id, server_url, token, space_id)
             VALUES ('ws', 'http://a', 'tok-secret', 'sp-1');",
        )
        .unwrap();

        set_attachments_enabled(&c, "ws", false).unwrap();

        let got = get_profile(&c, "ws").unwrap();
        assert_eq!(got.token, "tok-secret");
        assert_eq!(got.space_id, "sp-1");
        assert_eq!(got.server_url, "http://a");
        assert_eq!(got.sync_attachments, 0);
    }

    // ---- C1 预算刹车 ----

    #[test]
    fn budget_defaults_match_the_decided_numbers() {
        // 2026-09-15 发布者拍板：磁盘余量下限 1 GB（硬性）/ 单文件 100 MB / 本轮只报告不拦截。
        // 这条钉的是**数字本身**：改默认值必须是有意的，不能顺手漂。
        let c = conn_with_meta();
        let b = read_budget(&c);
        assert_eq!(b.disk_floor_mb, 1024, "磁盘余量下限默认必须是 1 GB");
        assert_eq!(b.max_file_mb, 100, "单文件阈值默认必须是 100 MB");
        assert_eq!(b.max_run_mb, 0, "本轮总量默认必须是 0 = 只报告不拦截");
        assert!(b.wifi_only, "「仅 Wi-Fi」默认必须开（Android 未发布，先按不偷跑流量）");
    }

    #[test]
    fn budget_round_trips_and_survives_garbage_values() {
        let c = conn_with_meta();
        set_meta_state(&c, KEY_MAX_FILE_MB, "50").unwrap();
        set_meta_state(&c, KEY_MAX_RUN_MB, "2048").unwrap();
        set_meta_state(&c, KEY_WIFI_ONLY, "0").unwrap();
        let b = read_budget(&c);
        assert_eq!(b.max_file_mb, 50);
        assert_eq!(b.max_run_mb, 2048);
        assert!(!b.wifi_only);

        // 老库 / 手改过的 DB：解析不出来就退回默认值，**不许 panic、也不许当成 0**。
        set_meta_state(&c, KEY_MAX_FILE_MB, "abc").unwrap();
        set_meta_state(&c, KEY_DISK_FLOOR_MB, "").unwrap();
        let b = read_budget(&c);
        assert_eq!(b.max_file_mb, DEFAULT_MAX_FILE_MB);
        assert_eq!(b.disk_floor_mb, DEFAULT_DISK_FLOOR_MB);
    }

    #[test]
    fn the_disk_floor_cannot_be_switched_off() {
        // 「硬性、不可关」是这条闸门的定义（§五 的设计决定）：写 0 必须被夹到下限，
        // 而且**读出**也要夹——否则手改过的 DB 能让它失效。
        let b = SyncBudget { disk_floor_mb: 0, max_file_mb: 0, max_run_mb: 0, wifi_only: false }.clamped();
        assert_eq!(b.disk_floor_mb, MIN_DISK_FLOOR_MB, "0 必须被夹到最小下限");
        // 同时确认"0 = 不限"在另外两项上仍然成立（它们是可关的）。
        assert_eq!(b.max_file_mb, 0);
        assert_eq!(b.max_run_mb, 0);

        let c = conn_with_meta();
        set_meta_state(&c, KEY_DISK_FLOOR_MB, "0").unwrap();
        assert_eq!(read_budget(&c).disk_floor_mb, MIN_DISK_FLOOR_MB, "读出时也要夹");
        // 荒唐大的值同样夹住（防止 u64 乘法溢出）。
        set_meta_state(&c, KEY_MAX_RUN_MB, "18446744073709551615").unwrap();
        assert!(read_budget(&c).max_run_mb <= MAX_BUDGET_MB);
    }

    // ---- P6.3：按需取字节 ----

    /// 同步下载与按需下载**必须拼出同一个 URL**：绑了空间走 space 作用域，否则旧的全局路径。
    /// 这条钉住的是"两处各写一遍迟早会漂"——P6.3 之前这两段代码就是复制关系。
    #[test]
    fn attachment_base_is_space_scoped_only_when_bound_to_a_space() {
        let mk = |space: &str| SyncProfile {
            ws_id: "ws".into(),
            server_url: "https://s.example.com/".into(),
            token: "t".into(),
            space_id: space.into(),
            last_pushed_seq: 0,
            last_pulled_seq: 0,
            sync_attachments: 1,
        };
        // 没发现到任何对端 ⇒ 基址就是配置地址（下面那条判据单独钉这个）
        let base = |space: &str| base_for(&mk(space), &[]);
        // 绑了空间：`<server>/spaces/<id>`（服务端 space 作用域路由）。
        assert_eq!(attachment_base(&base("sp-1"), "sp-1"), "https://s.example.com/spaces/sp-1");
        // 没绑（个人自建 / 旧配置）：就是 server_url 本身（旧的全局路由）。
        assert_eq!(attachment_base(&base(""), ""), "https://s.example.com");
        // ⚠️ **不产生双斜杠**：地址末尾带 `/` 时也要拼对（`set_profile` 会 trim，
        //    但老库 / 手改过的值不能靠这个假设）。
        assert!(!attachment_base(&base("sp-1"), "sp-1").contains("//spaces"));
    }

    fn profile_for(space: &str, server: &str) -> SyncProfile {
        SyncProfile {
            ws_id: "ws".into(),
            server_url: server.into(),
            token: "t".into(),
            space_id: space.into(),
            last_pushed_seq: 0,
            last_pulled_seq: 0,
            sync_attachments: 1,
        }
    }

    fn lan_peer(device: &str, base: &str, spaces: &[&str]) -> Peer {
        Peer {
            announce: crate::lan::LanAnnounce {
                v: crate::lan::WIRE_VERSION,
                device_id: device.into(),
                device_name: device.into(),
                hub_base: Some(base.into()),
                hub_spaces: spaces.iter().map(|s| s.to_string()).collect(),
                fp: "fp".into(),
            },
            addr: "192.168.1.9".into(),
            seen_at_ms: 0,
        }
    }

    /// ★ 承重判据（甲-1 接线第 2 件）：**没发现到对端时，基址逐字节等于今天**。
    /// 发现层是加分项 —— 它没东西时，**不许**改变任何一条既有请求的地址（含末尾斜杠的规整）。
    #[test]
    fn with_nothing_discovered_the_base_is_byte_identical_to_today() {
        assert_eq!(base_for(&profile_for("sp-1", "https://s.example.com/"), &[]), "https://s.example.com");
        assert_eq!(base_for(&profile_for("", "http://localhost:8787"), &[]), "http://localhost:8787");
        // 没绑 server_url ⇒ 空（与今天"没绑定"的处境一致，调用方照旧按未绑定处理）
        assert_eq!(base_for(&profile_for("", ""), &[]), "");
    }

    /// ★ 判据：发现到**服务本空间**的局域网中枢 ⇒ **附件那条路的基址也跟着换**
    /// ——"基址只出一处"的实测（不是只改了 push/pull 那条，附件漏在外头）。
    /// 顺带钉住"用对了那一个"：别个空间的中枢不许改变本空间的地址。
    #[test]
    fn a_discovered_hub_moves_the_attachment_base_to_the_lan_address() {
        let p = profile_for("sp-1", "https://s.example.com");
        let mine = vec![lan_peer("dev-a", "http://192.168.1.5:8787", &["sp-1"])];
        assert_eq!(base_for(&p, &mine), "http://192.168.1.5:8787");
        assert_eq!(
            attachment_base(&base_for(&p, &mine), "sp-1"),
            "http://192.168.1.5:8787/spaces/sp-1",
            "space 作用域要照旧拼上去"
        );
        // 只服务**别个空间**的中枢 ⇒ 回落配置地址
        let other = vec![lan_peer("dev-b", "http://192.168.1.6:8787", &["sp-other"])];
        assert_eq!(base_for(&p, &other), "https://s.example.com");
        // 公网地址的公告 ⇒ 不许当直连（`lan::is_lan_base` 那条口径在基址这一层的实测）
        let bogus = vec![lan_peer("dev-c", "http://8.8.8.8:8787", &["sp-1"])];
        assert_eq!(base_for(&p, &bogus), "https://s.example.com");
    }

    // ---- 甲-1 接线第 2 件的剩下 4 处（push / pull / lineage-claim / SSE 订流）----
    //
    // 手法与上面那两处**同形**：★ 没发现到对端时**逐字节等于今天**；
    // ★ 发现到服务本空间的中枢 ⇒ 地址跟着换。四处共用 `effective_base` / `effective_base_from`
    // 与三个 `*_url` 纯函数 ⇒ 判据喂**假的 `Peer` 列表**就够，**不碰进程级单例**
    // （`cargo test` 是同进程多线程，动单例会污染别的测试）。

    /// ★ 判据：**push 这条路的地址**。没发现到对端时逐字节等于今天（含 `https://…/` 的规整
    /// 与"没绑地址 ⇒ 空"），发现到本空间的中枢时换成局域网地址。
    #[test]
    fn a_discovered_hub_moves_the_push_url_to_the_lan_address() {
        let p = profile_for("sp-1", "https://s.example.com/");
        // 没发现到任何对端 ⇒ 与今天**逐字节相同**
        assert_eq!(effective_base_from("sp-1", &p.server_url, &[]).unwrap(), "https://s.example.com/");
        assert_eq!(push_url(&p.server_url), "https://s.example.com/push");
        // 发现到服务本空间的中枢 ⇒ 换成局域网地址
        let mine = vec![lan_peer("dev-a", "http://192.168.1.5:8787", &["sp-1"])];
        let base = effective_base_from("sp-1", &p.server_url, &mine).unwrap();
        assert_eq!(push_url(&base), "http://192.168.1.5:8787/push");
        // 别个空间的中枢 / 公网公告 ⇒ 回落配置地址
        for peers in [
            vec![lan_peer("dev-b", "http://192.168.1.6:8787", &["sp-other"])],
            vec![lan_peer("dev-c", "http://8.8.8.8:8787", &["sp-1"])],
        ] {
            let base = effective_base_from("sp-1", &p.server_url, &peers).unwrap();
            assert_eq!(push_url(&base), "https://s.example.com/push", "不许换档");
        }
    }

    /// ★ 判据：**pull 这条路的地址**（基址换档，而 `since` / `space_id` / `exclude_device`
    /// 这三段过滤参数**一个都不许少** —— 少了 `space_id` 服务端按"没绑空间"回，
    /// 少了 `exclude_device` 会把自己推的又拉回来）。
    #[test]
    fn a_discovered_hub_moves_the_pull_url_and_keeps_its_filters() {
        let p = profile_for("sp-1", "https://s.example.com/");
        let today = pull_url(&p.server_url, 42, "sp-1", Some("dev-me"));
        assert_eq!(today, "https://s.example.com/pull?since=42&limit=500&space_id=sp-1&exclude_device=dev-me");
        // 没发现到对端 ⇒ 与今天逐字节相同；没绑空间 / 没设备 id 时那两段也不许凭空冒出来
        assert_eq!(pull_url(&p.server_url, 7, "", None), "https://s.example.com/pull?since=7&limit=500");
        let mine = vec![lan_peer("dev-a", "http://192.168.1.5:8787", &["sp-1"])];
        let base = effective_base_from("sp-1", &p.server_url, &mine).unwrap();
        assert_eq!(
            pull_url(&base, 42, "sp-1", Some("dev-me")),
            "http://192.168.1.5:8787/pull?since=42&limit=500&space_id=sp-1&exclude_device=dev-me",
            "只换基址，三段过滤参数原样"
        );
    }

    /// ★ 判据：**`lineage-claim` 这条路的地址**。
    ///
    /// ⚠️ 这一处**不许**复用 `base_for(&SyncProfile)`：`claim_config` 手上只有
    /// `(space_id, server_url)` 两列，没有 `SyncProfile` ⇒ 它走 `effective_base_for` 那一支。
    /// 这条判据顺便钉住"两把尺同源"：同样的对端列表下，这一支与 `base_for` **给出同一个地址**。
    #[test]
    fn a_discovered_hub_moves_the_lineage_claim_url_too() {
        let p = profile_for("sp-1", "https://s.example.com/");
        assert_eq!(lineage_claim_url(&p.server_url), "https://s.example.com/lineage-claim");
        let mine = vec![lan_peer("dev-a", "http://192.168.1.5:8787", &["sp-1"])];
        let base = effective_base_from("sp-1", &p.server_url, &mine).unwrap();
        assert_eq!(lineage_claim_url(&base), "http://192.168.1.5:8787/lineage-claim");
        assert_eq!(base, base_for(&p, &mine), "与 SyncProfile 那一支必须同源（两把尺会漂）");
        // 别个空间的中枢 ⇒ 回落
        let other = vec![lan_peer("dev-b", "http://192.168.1.6:8787", &["sp-other"])];
        let base = effective_base_from("sp-1", &p.server_url, &other).unwrap();
        assert_eq!(lineage_claim_url(&base), "https://s.example.com/lineage-claim");
    }

    /// ★ 判据：**SSE 订流这条路的地址**（`sync_stream::stream_url` 吃的是**解析后的基址**）。
    /// 与 push/pull/附件同源；没发现到对端时逐字节等于今天（前端 `useSyncStream.ts` 那条也是）。
    #[test]
    fn a_discovered_hub_moves_the_stream_url_to_the_lan_address() {
        let p = profile_for("sp-1", "https://s.example.com/");
        assert_eq!(
            crate::sync_stream::stream_url(&p.server_url, "sp-1"),
            "https://s.example.com/spaces/sp-1/changes-stream"
        );
        let mine = vec![lan_peer("dev-a", "http://192.168.1.5:8787", &["sp-1"])];
        let base = effective_base_from("sp-1", &p.server_url, &mine).unwrap();
        assert_eq!(
            crate::sync_stream::stream_url(&base, "sp-1"),
            "http://192.168.1.5:8787/spaces/sp-1/changes-stream"
        );
        // 别个空间的中枢 / 公网公告 ⇒ 回落配置地址
        for peers in [
            vec![lan_peer("dev-b", "http://192.168.1.6:8787", &["sp-other"])],
            vec![lan_peer("dev-c", "http://8.8.8.8:8787", &["sp-1"])],
        ] {
            let base = effective_base_from("sp-1", &p.server_url, &peers).unwrap();
            assert_eq!(
                crate::sync_stream::stream_url(&base, "sp-1"),
                "https://s.example.com/spaces/sp-1/changes-stream"
            );
        }
    }

    /// ★ 判据（`lan_status` 的那一半）：状态行报的**是哪一个空间** —— 显式指定的优先，
    /// 查不到就回落第一条绑定，一条都没有 ⇒ `None`（那时状态行说「尚未绑定」）。
    ///
    /// 钉的是"选错空间"这一种：选错的话状态行会说「其中没有服务这个空间的中枢」，
    /// 而用户配的明明就是那一个 —— 它**能编译、别处单测照绿**，只有真机看得见。
    #[test]
    fn the_status_line_reports_the_space_that_was_actually_asked_for() {
        let mine = profile_for("sp-mine", "https://s.example.com");
        let other = profile_for("sp-other", "https://other.example.com");
        // 指定了就报指定那个（**不是**第一条）
        assert_eq!(
            pick_lan_scope(Some(mine.clone()), Some(other.clone())),
            Some(("sp-mine".to_string(), "https://s.example.com".to_string()))
        );
        // 指定的查不到（工作空间没配）⇒ 回落第一条绑定，**不报错**
        assert_eq!(
            pick_lan_scope(None, Some(other.clone())),
            Some(("sp-other".to_string(), "https://other.example.com".to_string()))
        );
        // 一条都没有 ⇒ None（调用方据此走 `resolve_base("", "")` ⇒ 状态行「尚未绑定」）
        assert_eq!(pick_lan_scope(None, None), None);
    }

    // ---- B4-b：兜底行的收编与自愈 ----

    fn conn_with_attachments() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE attachments (
                 id TEXT PRIMARY KEY, page_id TEXT, name TEXT NOT NULL, hash TEXT NOT NULL,
                 mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL
             );",
        )
        .unwrap();
        c
    }
    fn rows_for(c: &Connection, hash: &str) -> Vec<(String, Option<String>, String)> {
        c.prepare("SELECT id, page_id, name FROM attachments WHERE hash = ?1 ORDER BY id")
            .unwrap()
            .query_map(params![hash], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .flatten()
            .collect()
    }

    /// **收编**：元数据还没到、只有兜底行 ⇒ 原地改写成元数据行（不新增行）。
    #[test]
    fn metadata_adopts_a_lone_fallback_row() {
        let c = conn_with_attachments();
        let hash = "a".repeat(64);
        c.execute(
            "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
             VALUES ('fallback-uuid', NULL, ?1, ?2, 'text/markdown', 12, 1)",
            params![format!("{hash}.bin"), hash],
        )
        .unwrap();

        adopt_or_heal_fallback_row(&c, "row-from-changes", "验收说明.md", Some("folder-1"), &hash).unwrap();

        let rows = rows_for(&c, &hash);
        assert_eq!(rows.len(), 1, "收编之后仍应只有一行（不许变成两行）");
        assert_eq!(rows[0].0, "row-from-changes", "id 应被改写成元数据行的 id");
        assert_eq!(rows[0].1.as_deref(), Some("folder-1"), "page_id 应落到真实目录");
        assert_eq!(rows[0].2, "验收说明.md", "名字应被改写成真名");
    }

    /// **自愈**：元数据行与兜底行都在（历史重复）⇒ 删掉多余的兜底行。
    #[test]
    fn metadata_heals_an_existing_duplicate_fallback_row() {
        let c = conn_with_attachments();
        let hash = "b".repeat(64);
        c.execute_batch(&format!(
            "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
             VALUES ('row-from-changes', 'folder-1', '验收说明.md', '{hash}', 'text/markdown', 12, 1),
                    ('fallback-uuid', NULL, '{hash}.bin', '{hash}', 'text/markdown', 12, 2);"
        ))
        .unwrap();
        assert_eq!(rows_for(&c, &hash).len(), 2, "前提：先造出重复");

        adopt_or_heal_fallback_row(&c, "row-from-changes", "验收说明.md", Some("folder-1"), &hash).unwrap();

        let rows = rows_for(&c, &hash);
        assert_eq!(rows.len(), 1, "自愈之后只剩元数据那一行");
        assert_eq!(rows[0].0, "row-from-changes");
        assert_eq!(rows[0].1.as_deref(), Some("folder-1"));
    }

    /// **不许误伤**：用户自己导入的文件也是 `page_id = NULL`，但名字是原名（不带 hash 前缀）
    /// ⇒ 同一个 hash 上那条行必须原样保留。
    #[test]
    fn a_user_imported_row_with_the_same_hash_is_left_alone() {
        let c = conn_with_attachments();
        let hash = "c".repeat(64);
        c.execute(
            "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
             VALUES ('user-import', NULL, '我的笔记.md', ?1, 'text/markdown', 12, 1)",
            params![hash],
        )
        .unwrap();

        adopt_or_heal_fallback_row(&c, "row-from-changes", "验收说明.md", Some("folder-1"), &hash).unwrap();
        // ⚠️ 这条测的是"**真实序列**不误伤"，而真实序列是**两步**：调用点（`sync.rs:1472-1479`）
        // 先 reconcile、**紧接着自己 INSERT** 元数据行。`adopt_or_heal_fallback_row` 从设计上只做
        // DELETE / UPDATE（两条语句的过滤都是 `name LIKE hash || '.%'`，只认"兜底行"那种形态），
        // 所以**只调它拿不到第 2 行**——2026-09-16 这条断言 `left:1 right:2` 就是这么红的：
        // 不是实现缺了 INSERT，是测试断言了"调用方那半件事"却只调了被调方。
        // 定位在 Windows 侧（他们本机跑不了 cargo test：测试二进制 STATUS_ENTRYPOINT_NOT_FOUND），
        // 补丁在 Mac 侧落、Mac 侧验。这里补上调用方那一步（SQL 与生产逐字一致）。
        c.execute(
            "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
             VALUES (?1, ?2, ?3, ?4, 'text/markdown', 12, 2)
             ON CONFLICT(id) DO UPDATE SET page_id=excluded.page_id, name=excluded.name,
                                           hash=excluded.hash, mime=excluded.mime, size=excluded.size",
            params!["row-from-changes", Some("folder-1"), "验收说明.md", hash],
        )
        .unwrap();

        let rows = rows_for(&c, &hash);
        assert_eq!(rows.len(), 2, "用户导入的那行不该被删、也不该被改写");
        let user = rows.iter().find(|r| r.0 == "user-import").expect("user-import 必须还在");
        assert_eq!(user.2, "我的笔记.md", "原件名字不许被改");
        assert_eq!(user.1, None, "page_id 不许被改");
    }

    // ---- B4：同步下载不再制造重复行 ----

    /// B4 的判据（2026-09-15）：**同一个 hash 在第二台设备上只能有一行**。
    ///
    /// 场景复刻：① 元数据随 `changes` 到了本地（`page_id` 指向真实目录）；
    /// ② 字节下载完成，走兜底行插入。修复前这里是**两行**（`id` 是新 uuid、
    /// `page_id = NULL`，而 `INSERT OR IGNORE` 只对主键生效）⇒ 文件在「未整理」
    /// 里多出一份 `hash.ext` 副本。修复后必须仍是 1 行，且**保留原来那条真目录行**。
    #[test]
    fn downloading_bytes_does_not_duplicate_an_existing_attachment_row() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE attachments (
                 id TEXT PRIMARY KEY, page_id TEXT, name TEXT NOT NULL, hash TEXT NOT NULL,
                 mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL
             );
             CREATE INDEX idx_attachments_hash ON attachments(hash);",
        )
        .unwrap();
        // ① 元数据路径（do_pull 的 upsert）：真 id + 真目录。
        c.execute(
            "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
             VALUES ('row-from-changes', 'folder-1', '报告.pdf', 'h1', 'application/pdf', 12, 1)",
            [],
        )
        .unwrap();

        // ② 字节下载完成的兜底插入：必须**什么都不做**。
        record_downloaded_attachment(&c, "h1", "application/pdf", 12, "h1.pdf").unwrap();

        let rows: Vec<(String, Option<String>)> = c
            .prepare("SELECT id, page_id FROM attachments WHERE hash = 'h1'")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(rows.len(), 1, "同一 hash 不许出现第二行（多出来的那份会显示在「未整理」里）");
        assert_eq!(rows[0].0, "row-from-changes", "必须保留元数据那一行（真目录），不能替换成兜底行");
        assert_eq!(rows[0].1.as_deref(), Some("folder-1"), "page_id 必须还是真实目录");

        // ③ 兜底行该出现的时候仍要出现：服务端有字节、本地没有元数据行。
        record_downloaded_attachment(&c, "h2", "image/png", 34, "h2.png").unwrap();
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM attachments WHERE hash = 'h2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "没有元数据行时，下载完的字节仍要能被用户看见（兜底行必须插）");
        let page: Option<String> = c
            .query_row("SELECT page_id FROM attachments WHERE hash = 'h2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(page, None, "兜底行落在「未整理」（page_id IS NULL）");
    }

    #[test]
    fn list_profiles_carries_attachment_switch() {
        // `PROFILE_COLS` 必须带上 `sync_attachments`：漏列会让整条 SELECT 报错
        // （不是"少一个字段"而已），这里把它钉住。
        let c = conn_with_meta();
        c.execute_batch(
            "INSERT INTO meta.workspaces (id, deleted_at) VALUES ('ws', NULL);
             INSERT INTO meta.sync_profiles (ws_id, server_url, sync_attachments) VALUES ('ws', 'http://a', 0);",
        )
        .unwrap();

        let got = list_profiles(&c).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].sync_attachments, 0);
    }

    // ---- 阶段 1（2026-09-22）：apply 的返回值必须把"有未裁决冲突"交出来 ----

    /// 冲突那条路径用的连接：**走仓库自己的建库路径**（真 schema：pages / page_fts / page_conflicts）。
    /// 与 `doc_content` 测试里的 `conflict_conn` 同一思路，这里用内存库（同步这一层只碰那几张表）。
    fn pages_conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c, "ws").unwrap();
        c
    }

    fn remote_page(id: &str, json: &str) -> PageDetail {
        PageDetail {
            id: id.into(),
            workspace_id: "ws".into(),
            parent_id: None,
            title: "页".into(),
            content_json: json.into(),
            content_text: "远端正文".into(),
            cover: String::new(),
            icon: String::new(),
            cover_height: 300,
            cover_pos: 50.0,
            kind: "page".into(),
            sort_order: 0.0,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn page_json(block_id: &str, rev: i64, text: &str) -> String {
        serde_json::json!({ "root": { "children": [
            { "type": "paragraph", "blockId": block_id, "blockRev": rev,
              "children": [{ "type": "text", "text": text }] }
        ] } })
        .to_string()
    }

    /// ★ AMD 2026-09-22 的要求（"留痕 ≠ 已裁决"）：`apply_upsert` 必须**回报**这次留下了几处未裁决的
    /// 冲突 —— 调用方不许只能靠"再去查一次表"才知道。判据同时钉住"合得上时回报 0"。
    #[test]
    fn apply_upsert_reports_unresolved_block_conflicts() {
        let c = pages_conn();
        // 本地这一行：干净（dirty=0）、seq 更旧 ⇒ 页级判定会走"用远端"。
        c.execute(
            "INSERT INTO pages (id, workspace_id, title, content_json, content_text, kind, created_at, updated_at, deleted_at, sync_seq, dirty)
             VALUES ('p1', 'ws', '页', ?1, '本地正文', 'page', 0, 0, NULL, 1, 0)",
            params![page_json("b1", 2, "我改的")],
        )
        .unwrap();

        // 同 rev、不同内容 ⇒ 判不了 ⇒ 落表 + 回报条数
        let out = apply_upsert(&c, &remote_page("p1", &page_json("b1", 2, "他改的")), 9, None).unwrap();
        assert_eq!(out, UpsertApply::Applied { unresolved: 1 }, "必须把『有 1 处未裁决冲突』交回来");
        let recorded: i64 = c
            .query_row("SELECT COUNT(*) FROM page_conflicts WHERE page_id='p1' AND resolved_at IS NULL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(recorded, 1, "回报的条数要对得上表里的行");

        // 同一页再来一次干净的应用（内容逐字相同）⇒ 这一轮没有未裁决冲突 ⇒ 回报 0
        c.execute("UPDATE pages SET sync_seq = 1, dirty = 0 WHERE id='p1'", []).unwrap();
        let out = apply_upsert(&c, &remote_page("p1", &page_json("b1", 2, "他改的")), 10, None).unwrap();
        assert_eq!(
            out,
            UpsertApply::Applied { unresolved: 0 },
            "内容相同 ⇒ 没有新冲突 ⇒ 回报 0（旧的那条未裁决记录仍在，那是上一轮的事）"
        );
    }

    // ---- B 方案（2026-09-22）：页级保留本地时，那一版远端内容**不许**被游标静默吃掉 ----
    // 判据对着 `docs/plans/2026-09-22-merge-push-and-cursor-forensics.md` §3.2 的 L 写。

    /// B 那几条判据要的连接：真建库路径（`pages` / `changes` / `pending_remote_pages` / meta 都齐）。
    fn pending_conn(tag: &str) -> (Connection, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("shuyonote-pending-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        let c = crate::db::open_space_conn_at("ws", &dir).unwrap();
        set_meta_state(&c, "device_id", "test-device").unwrap();
        (c, dir)
    }

    /// ★★ 隐私边界**第 2 步**：**绑定同步关系那一刻的闸门**（真库、真路径）。
    ///
    /// 四支都要有读数：个人空间没加密 ⇒ **拦**；加密过（袋里有它）⇒ 放行；
    /// 团队空间 ⇒ **免检**（明文也放行）；未分类 ⇒ 放行但**带一条提示**（不静默）。
    #[test]
    fn the_sync_bind_gate_blocks_only_personal_spaces_without_encryption() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let (c, dir) = pending_conn("syncgate");
        c.execute(
            "INSERT INTO meta.workspaces (id, name, created_at, updated_at) VALUES ('ws', '甲', 1, 1)",
            [],
        )
        .unwrap();

        // ① 未分类 ⇒ 放行 ＋ 提示（这是**今天所有空间**的状态：闸门不掐断任何人的同步）
        let note = sync_bind_gate(&c, &dir, "ws").unwrap();
        assert!(note.is_some(), "未分类要如实报出来");
        assert!(note.unwrap().contains("没分类"));

        // ② 标成个人空间 ⇒ **拦**（库是明文）
        crate::space_crypto::set_space_kind(&c, "ws", crate::space_crypto::SpaceKind::Personal).unwrap();
        let err = sync_bind_gate(&c, &dir, "ws").unwrap_err();
        assert!(err.contains("明文"), "{err}");

        // ③ 给它按空间加密 ⇒ 放行
        let mut c2 = c;
        crate::space_crypto::enable_space(&mut c2, &dir, "ws", Some("我家猫叫mimi")).unwrap();
        assert!(sync_bind_gate(&c2, &dir, "ws").unwrap().is_none(), "加密过就该放行");

        // ④ 团队空间 ⇒ **免检**（即使明文）
        crate::space_crypto::set_space_kind(&c2, "ws", crate::space_crypto::SpaceKind::Team).unwrap();
        crate::space_crypto::disable_space(&mut c2, &dir, "ws").unwrap();
        assert!(
            crate::security::space_db_is_encrypted(&crate::db::space_db_path(&dir, "ws")) == false,
            "前置：已经回明文"
        );
        assert!(sync_bind_gate(&c2, &dir, "ws").unwrap().is_none(), "★ 团队空间明文也免检");

        drop(c2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn insert_local_page(c: &Connection, id: &str, json: &str, sync_seq: i64, dirty: i64) {
        c.execute(
            "INSERT INTO pages (id, workspace_id, title, content_json, content_text, kind, created_at, updated_at, deleted_at, sync_seq, dirty)
             VALUES (?1, 'ws', '页', ?2, '', 'page', 0, 0, NULL, ?3, ?4)",
            params![id, json, sync_seq, dirty],
        )
        .unwrap();
    }

    /// 造一笔"本地整页改动"（`changes` 里的一行），返回它的 `seq`（行号，就是游标比的那个数）。
    /// `device_seq` 照 `record_change` 的写法回填成行号（表上有 `UNIQUE(device_id, device_seq)`）。
    fn insert_local_change(c: &Connection, id: &str, json: &str) -> i64 {
        c.execute(
            "INSERT INTO changes (device_id, device_seq, entity, entity_id, op, payload, updated_at)
             VALUES ('test-device', 0, 'page', ?1, 'upsert', ?2, 0)",
            params![id, json],
        )
        .unwrap();
        let seq = c.last_insert_rowid();
        c.execute("UPDATE changes SET device_seq = ?1 WHERE seq = ?1", params![seq]).unwrap();
        seq
    }

    /// 把"已经推上去"的水位钉在 `seq`（**与 `do_push` 挑变更时读的是同一个值**：
    /// `sync_profiles.last_pushed_seq`）。
    fn set_pushed_watermark(c: &Connection, seq: i64) {
        c.execute(
            "INSERT INTO sync_profiles (ws_id, server_url, token, space_id, last_pushed_seq, last_pulled_seq, sync_attachments)
             VALUES ('ws', 'http://a', '', 'sp', ?1, 0, 1)
             ON CONFLICT(ws_id) DO UPDATE SET last_pushed_seq = excluded.last_pushed_seq",
            params![seq],
        )
        .unwrap();
    }

    fn stash(c: &Connection, page: &PageDetail, seq: i64) {
        crate::doc_content::stash_pending_remote(c, page, seq, 1000).unwrap();
    }

    fn local_json(c: &Connection, id: &str) -> String {
        c.query_row("SELECT content_json FROM pages WHERE id = ?1", params![id], |r| r.get(0)).unwrap()
    }

    fn dirty_of(c: &Connection, id: &str) -> i64 {
        c.query_row("SELECT dirty FROM pages WHERE id = ?1", params![id], |r| r.get(0)).unwrap()
    }

    /// ★ **返回值分义**：`KeptLocal`（压根没应用）与 `Applied{unresolved:0}`（应用了且无冲突）
    /// 必须是**两个不同的值** —— 旧版把这两件事都返回 `0`，游标因此分不出来（取证文件 §5）。
    #[test]
    fn apply_upsert_says_whether_it_applied_or_kept_local() {
        let (c, dir) = pending_conn("split");
        let mine = page_json("b1", 1, "我本地改的");
        insert_local_page(&c, "p1", &mine, 1, 1); // dirty ⇒ 页级判定 = 保留本地

        assert_eq!(
            apply_upsert(&c, &remote_page("p1", &page_json("b1", 9, "他改的")), 9, None).unwrap(),
            UpsertApply::KeptLocal,
            "本地有未推送改动 ⇒ 这一支是『没应用』，不许当成『应用干净』"
        );
        assert_eq!(local_json(&c, "p1"), mine, "保留本地 ⇒ 内容一个字都不许动");

        // 把本地清零（已同步）⇒ 同一笔远端变更这次真的应用了
        c.execute("UPDATE pages SET dirty = 0 WHERE id = 'p1'", []).unwrap();
        assert_eq!(
            apply_upsert(&c, &remote_page("p1", &page_json("b1", 9, "他改的")), 9, None).unwrap(),
            UpsertApply::Applied { unresolved: 0 },
            "应用了且没有未裁决冲突 ⇒ 另一支"
        );
        assert!(local_json(&c, "p1").contains("他改的"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ **B 的核心判据**：「采用远端」要**真的**放弃本地还没推上去的那笔改动，
    /// 而**已经推上去的**历史一行都不许删（删了游标账目就错乱，而且那些是对端的既成事实）。
    #[test]
    fn taking_the_remote_version_really_drops_the_unsent_local_change() {
        let (c, dir) = pending_conn("take");
        insert_local_page(&c, "p1", &page_json("b1", 1, "我本地改的"), 1, 1);
        insert_local_change(&c, "p1", &page_json("b1", 1, "我本地改的")); // 未推（水位 = 0）

        let remote = remote_page("p1", &page_json("b1", 9, "他改的"));
        stash(&c, &remote, 9);
        let report = resolve_pending_remote(&c, "p1", PendingChoice::TakeRemote).unwrap();

        assert_eq!(report.choice, "take_remote");
        assert_eq!(report.adopted_seq, 9);
        assert_eq!(report.discarded_local_changes, 1, "未推的那一笔被丢掉了（这句才是真话）");
        assert!(local_json(&c, "p1").contains("他改的"), "整页换成远端那一版");
        assert_eq!(dirty_of(&c, "p1"), 0, "远端应用 ⇒ 没有未推送改动");
        assert_eq!(unsent_page_change_count(&c, "p1").unwrap(), 0);
        assert_eq!(crate::doc_content::pending_remote_seq(&c, "p1").unwrap(), None, "裁决完存档要清掉");

        // 已经推上去的那一笔**不许**被删
        insert_local_page(&c, "p2", &page_json("b1", 1, "旧的本地版"), 1, 1);
        let sent = insert_local_change(&c, "p2", &page_json("b1", 1, "旧的本地版"));
        set_pushed_watermark(&c, sent); // 这一笔算"已经推上去了"
        insert_local_change(&c, "p2", &page_json("b1", 2, "新的本地版")); // 未推
        stash(&c, &remote_page("p2", &page_json("b1", 9, "他改的")), 9);
        assert_eq!(
            discard_unsent_page_changes(&c, "p2").unwrap(),
            1,
            "只丢未推的那一笔"
        );
        let left: i64 = c
            .query_row("SELECT COUNT(*) FROM changes WHERE entity_id = 'p2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1, "已推上去的那一笔是历史，必须留着");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ 「合并这一页」：两端各改**不同块** ⇒ 都保留；而产物里那些"只在本地"的块要靠
    /// **本地那笔还没推上去的改动**进 log ⇒ 这一步之后必须把这一页**标回 dirty**。
    #[test]
    fn merging_re_marks_dirty_while_the_local_change_is_still_unsent() {
        let (c, dir) = pending_conn("merge");
        let mine = serde_json::json!({ "root": { "children": [
            { "type": "paragraph", "blockId": "b1", "blockRev": 2,
              "children": [{ "type": "text", "text": "我改的 b1" }] },
            { "type": "paragraph", "blockId": "b2", "blockRev": 1,
              "children": [{ "type": "text", "text": "b2 原样" }] }
        ] } })
        .to_string();
        let theirs = serde_json::json!({ "root": { "children": [
            { "type": "paragraph", "blockId": "b1", "blockRev": 1,
              "children": [{ "type": "text", "text": "b1 原样" }] },
            { "type": "paragraph", "blockId": "b2", "blockRev": 2,
              "children": [{ "type": "text", "text": "他改的 b2" }] }
        ] } })
        .to_string();
        insert_local_page(&c, "p1", &mine, 1, 1);
        insert_local_change(&c, "p1", &mine);
        stash(&c, &remote_page("p1", &theirs), 9);

        let report = resolve_pending_remote(&c, "p1", PendingChoice::Merge).unwrap();
        let merged = local_json(&c, "p1");
        assert!(report.merged, "这一支走的是逐块合并");
        assert!(merged.contains("我改的 b1"), "本地那一块要留下：{merged}");
        assert!(merged.contains("他改的 b2"), "远端那一块也要进来：{merged}");
        assert_eq!(report.unresolved, 0, "两端改的是不同块 ⇒ 没有要裁决的");
        assert_eq!(report.local_changes_pending, 1);
        assert_eq!(dirty_of(&c, "p1"), 1, "产物里的本地块还只在本地那笔变更里 ⇒ 必须标回 dirty");
        assert_eq!(crate::doc_content::pending_remote_seq(&c, "p1").unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 「保留本地」＝现状：内容、脏标记、未推变更**一个都不动**，只把存档清掉（用户认下这个分歧）。
    #[test]
    fn keeping_local_changes_nothing_except_clearing_the_archive() {
        let (c, dir) = pending_conn("keep");
        let mine = page_json("b1", 1, "我本地改的");
        insert_local_page(&c, "p1", &mine, 1, 1);
        insert_local_change(&c, "p1", &mine);
        stash(&c, &remote_page("p1", &page_json("b1", 9, "他改的")), 9);

        let report = resolve_pending_remote(&c, "p1", PendingChoice::KeepLocal).unwrap();
        assert_eq!(report.choice, "keep_local");
        assert_eq!(report.discarded_local_changes, 0);
        assert_eq!(local_json(&c, "p1"), mine, "内容不许动");
        assert_eq!(dirty_of(&c, "p1"), 1, "本地那笔改动还在 ⇒ 脏标记还在（下一次 push 推它）");
        assert_eq!(unsent_page_change_count(&c, "p1").unwrap(), 1);
        assert_eq!(crate::doc_content::pending_remote_seq(&c, "p1").unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 裁决口径只认三个字面量（**不默认选边** —— 与 `resolve_page_conflict` 同一纪律）。
    #[test]
    fn pending_choice_only_accepts_the_three_documented_words() {
        assert_eq!(PendingChoice::parse("merge"), Some(PendingChoice::Merge));
        assert_eq!(PendingChoice::parse("take_remote"), Some(PendingChoice::TakeRemote));
        assert_eq!(PendingChoice::parse("keep_local"), Some(PendingChoice::KeepLocal));
        for bad in ["", "remote", "local", "Merge", "take-remote"] {
            assert_eq!(PendingChoice::parse(bad), None, "{bad} 不该被认");
        }
    }

    // ---- 「一条坏变更不许中止整批」（W2，2026-09-23，Windows 侧）-----------------------------
    //
    // 改前：`let unresolved = apply_upsert(...)?` ⇒ 一条坏变更**中止整批**、游标不前进
    // ⇒ 只要服务端还在返回这一条，它后面的变更**永远取不到**（livelock）。
    // 改后（与 Web `doPull` 的 catch 同口径）：`Recoverable` ⇒ **归档 ＋ 前进 ＋ warn**；
    // `Fatal`（解密失败）⇒ 仍然整批中止。下面两条钉住这个分界，另一条钉住"不连坐"。

    /// 造一条 `page/upsert` 的入站变更（载荷就是 `PageDetail` 的 JSON）。
    fn page_change(seq: i64, id: &str, json: &str) -> IncomingChange {
        IncomingChange {
            seq,
            entity: "page".to_string(),
            entity_id: id.to_string(),
            op: "upsert".to_string(),
            payload: Some(serde_json::to_string(&remote_page(id, json)).unwrap()),
            updated_at: seq,
        }
    }

    /// 造一条**任意** `entity` / `op` 的入站变更 —— 给"本端不认识"那一格（F7b）用。
    fn odd_change(seq: i64, entity: &str, op: &str) -> IncomingChange {
        IncomingChange {
            seq,
            entity: entity.to_string(),
            entity_id: format!("{entity}-{seq}"),
            op: op.to_string(),
            payload: Some("{}".to_string()),
            updated_at: seq,
        }
    }

    /// ★ F7b 判据（2026-09-25）：本端**不认识**的变更类型 —— **照旧忽略，但不许无声**。
    ///
    /// 咬人的地方：把它改回无条件 `_ => {}` ⇒ `unrecognized` 是空的 ⇒ 这条立刻红。
    /// 同时钉住三件容易写坏的事：
    ///   ① 认识的照常落库（不许连坐）；
    ///   ② 不认识的**一条都不落库**（禁的是"顺手当 page 处理"）；
    ///   ③ ★ **游标照旧前进** —— 否则一种读不懂的搭配会把它**后面所有变更永久堵死**（livelock）。
    #[test]
    fn unrecognized_entity_kinds_are_ignored_loudly_and_never_wedge_the_cursor() {
        let c = pages_conn();
        let changes = vec![
            page_change(1, "p1", &page_json("b1", 1, "甲")),
            odd_change(2, "prop", "upsert"),
            odd_change(3, "attr", "delete"),
            odd_change(4, "prop", "upsert"), // 同一种搭配再来一次 ⇒ 只记一次（否则一次 pull 能刷几百行）
            page_change(5, "p2", &page_json("b1", 1, "乙")),
        ];
        let out = apply_pulled_changes(&c, changes, 0, 1_000).unwrap();

        // ① **留痕**：两种不认识的搭配、去重、按首次出现顺序 —— 这就是"不静默"的可断言形态。
        assert_eq!(
            out.unrecognized,
            vec!["prop:upsert".to_string(), "attr:delete".to_string()],
            "本端不认识的搭配必须被数出来（把它改回无条件忽略那一支，这条就空）"
        );
        // ② 认识的两条照常落库；不认识的一条都不落。
        assert_eq!(out.count, 2, "只有那两条 page 变更该被应用");
        for id in ["p1", "p2"] {
            let n: i64 = c
                .query_row("SELECT COUNT(*) FROM pages WHERE id = ?1", params![id], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 1, "{id} 应当被应用");
        }
        // ③ ★ 游标走到批尾（不认识的搭配不许把后面堵死），且它们**不是失败**：不归档、不报冲突。
        assert_eq!(out.max_pulled, 5, "游标必须走到批尾 —— 否则下一条读不懂的搭配就是死锁");
        assert!(out.pending_remote_ids.is_empty(), "忽略 ≠ 失败归档");
        assert!(out.conflicts.is_empty(), "忽略 ≠ 冲突");
    }

    /// ★ 正面：一条落库失败的变更 ⇒ **不连坐**（其余变更照常落库）＋ **游标前进** ＋ **留痕**（归档）。
    #[test]
    fn a_failing_change_is_archived_and_the_batch_continues() {
        let c = pages_conn();
        // 只让 p2 的落库失败（真库 + 一条只对它生效的触发器）：其余页面完全正常。
        c.execute_batch(
            "CREATE TRIGGER boom BEFORE INSERT ON pages WHEN NEW.id = 'p2'
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();

        let changes = vec![
            page_change(1, "p1", &page_json("b1", 1, "甲")),
            page_change(2, "p2", &page_json("b1", 1, "乙")),
            page_change(3, "p3", &page_json("b1", 1, "丙")),
        ];
        let out = apply_pulled_changes(&c, changes, 0, 1_000).unwrap();

        // ① 游标**前进到批尾**（"归档 ＋ 前进"里那个"前进"；改前这里会 Err ⇒ 游标停在 0）
        assert_eq!(out.max_pulled, 3, "坏变更不许把游标钉住");
        // ② 同批其余变更照常落库（一条坏变更不许连坐）
        for id in ["p1", "p3"] {
            let n: i64 = c
                .query_row("SELECT COUNT(*) FROM pages WHERE id = ?1", params![id], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 1, "{id} 应当被应用");
        }
        let p2: i64 = c.query_row("SELECT COUNT(*) FROM pages WHERE id = 'p2'", [], |r| r.get(0)).unwrap();
        assert_eq!(p2, 0, "p2 自己没落库（触发器拦的）");
        // ③ **留痕**：坏的那一版远端进了「待取回的远端版本」（与页级保留本地同一本账，用户可裁决）
        assert_eq!(
            crate::doc_content::pending_remote_seq(&c, "p2").unwrap(),
            Some(2),
            "应用失败也要留下那一版远端，不能静默消费"
        );
        assert_eq!(out.pending_remote_ids, vec!["p2".to_string()]);
    }

    /// ★ 反面：**解密失败仍然是 Fatal**（整批中止、游标不前进）—— 这是**故意保留**的例外，
    /// 别被"归档＋前进"顺手改成一律 Recoverable。
    ///
    /// 为什么用**源码级**判据而不是构造一段真解不开的载荷：那需要打开 E2EE（会话密钥是**进程全局**
    /// + `SEC_LOCK`），而 cargo 的测试是同进程多线程 ⇒ 会与别的用例互相踩（`security` 那几条自己带锁）。
    /// 真正"读不了的载荷"在批量层面还有一道整批预扫（`prescan_payload_formats_refuses_the_whole_batch`
    /// 已经钉住）。这里钉的是**分类**：默认 Recoverable、两处解密都必须是 Fatal。
    #[test]
    fn the_failure_split_defaults_to_recoverable_and_keeps_decrypt_fatal() {
        // 默认（落库失败 / 附件行自愈失败…）⇒ Recoverable
        assert!(matches!(ApplyFailure::from("boom".to_string()), ApplyFailure::Recoverable(_)));

        // 两处解密（page / attachment）都必须归 Fatal —— 数它出现的次数，少一处就红。
        let src = include_str!("sync.rs");
        let fatal_decrypt_sites = src.matches("ApplyFailure::Fatal(format!(\"同步解密失败").count();
        assert_eq!(
            fatal_decrypt_sites, 2,
            "page 与 attachment 两处解密都必须走 Fatal（否则读不了的变更会被'归档＋前进'静默消费）：{fatal_decrypt_sites}"
        );
    }

    // ═══════════════ 丙-③（2026-09-25）：戳真的过网 ＋ **页级胜负按戳判** ═══════════════

    /// 空间表（`db::migrate`）**＋** `meta` 的 KV / 档案表 —— 丙-③ 的判据两边都要用。
    fn stamped_conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
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
        set_meta_state(&c, "device_id", "A").unwrap();
        c
    }

    fn stamp_of(device: &str, wall: i64) -> Hlc {
        let mut h = Hlc::genesis(device);
        h.tick(wall)
    }

    /// 造一条 `page/upsert` 变更；`Some(..)` ⇒ 载荷上带那枚戳，`None` ⇒ **老对端的形状**（不带戳）。
    fn stamped_change(seq: i64, page: &PageDetail, s: Option<&Hlc>) -> IncomingChange {
        let plain = serde_json::to_string(page).unwrap();
        let payload = match s {
            Some(s) => crate::hlc::with_stamp(&plain, s).unwrap(),
            None => plain,
        };
        IncomingChange {
            seq,
            entity: "page".to_string(),
            entity_id: page.id.clone(),
            op: "upsert".to_string(),
            payload: Some(payload),
            updated_at: page.updated_at,
        }
    }

    /// 先让"本地那一版"**走真 apply 路径**落地（不手写 INSERT：`pages` 的列集不归本判据管），
    /// 再把两个**判定输入**调成想要的样子（`sync_seq` / `dirty`）。
    fn seed_local(c: &Connection, content_json: &str, sync_seq: i64, dirty: i64) {
        let p = remote_page("p1", content_json);
        apply_pulled_changes(c, vec![stamped_change(1, &p, None)], 0, 1).unwrap();
        c.execute("UPDATE pages SET sync_seq = ?1, dirty = ?2 WHERE id = 'p1'", params![sync_seq, dirty])
            .unwrap();
    }

    /// 本页现在那份内容（`remote_page` 造出来的**标题恒为"页"** ⇒ 区分版本只能看正文）。
    fn content_of(c: &Connection) -> String {
        c.query_row("SELECT content_json FROM pages WHERE id = 'p1'", [], |r| r.get(0)).unwrap()
    }

    /// ★ 丙-③：**两边都带戳 ⇒ 按戳判**，哪怕今天的规则一定会保留本地（`dirty=1` 且 `seq` 更大）。
    #[test]
    fn a_stamped_remote_is_judged_by_the_stamp_even_when_today_would_keep_local() {
        let c = stamped_conn();
        seed_local(&c, &page_json("b1", 1, "本地那一版"), 99, 1); // dirty=1 ＋ seq 更大 ⇒ 今天必留本地
        set_page_stamp(&c, "ws", "p1", &stamp_of("A", 1_000)).unwrap();

        let late = stamp_of("B", 2_000);
        let p = remote_page("p1", &page_json("b1", 2, "远端那一版"));
        apply_pulled_changes(&c, vec![stamped_change(3, &p, Some(&late))], 0, 1).unwrap();

        assert!(
            content_of(&c).contains("远端那一版"),
            "两边都带戳 ⇒ 按戳判（戳更晚的远端必须赢）：{}",
            content_of(&c)
        );
        assert_eq!(page_stamp(&c, "ws", "p1"), Some(late), "本页当前那枚戳要跟到赢家");
    }

    /// ★ 反面：本地那枚戳更晚 ⇒ **保留本地**，哪怕远端的 `seq` 大得多（今天那条路会采用远端）。
    #[test]
    fn a_stamped_local_that_is_later_is_kept_even_against_a_much_bigger_remote_seq() {
        let c = stamped_conn();
        seed_local(&c, &page_json("b1", 2, "本地那一版"), 1, 0); // 干净、seq 小 ⇒ 今天必采用远端
        let late = stamp_of("A", 5_000);
        set_page_stamp(&c, "ws", "p1", &late).unwrap();

        let early = stamp_of("B", 2_000);
        let p = remote_page("p1", &page_json("b1", 3, "远端那一版"));
        apply_pulled_changes(&c, vec![stamped_change(900, &p, Some(&early))], 0, 1).unwrap();

        assert!(
            content_of(&c).contains("本地那一版"),
            "本地那枚戳更晚 ⇒ 保留本地（远端的 seq 再大也不算数）：{}",
            content_of(&c)
        );
        assert_eq!(page_stamp(&c, "ws", "p1"), Some(late), "赢家是本地 ⇒ 那枚戳不动");
    }

    /// ★★ 丙-③ **收侧必须把收到的戳并进本机时钟**（HLC 的 `observe`）——
    /// 否则"对端时钟快"会把本机**后改**的那一版判输（**那一错就是丢更新**）。
    ///
    /// 编排全走**产品路径**（不手搓 KV）：
    ///   ① `apply_pulled_changes` 收下一枚"来自未来"的远端戳（对端的表快一小时）；
    ///   ② 本机随后改一次这一页（`record_page_upsert`）；
    ///   ③ 问 `verdict`：本机这一版必须赢。
    ///
    /// ⚠️ 第 ① 步之后是**直接读时钟那一格**（不是调 `local_stamp`）—— 调它会顺手 tick 一次，
    /// 那样就算库里根本没 observe 过，断言也会绿（判据自己把缺口补上了）。
    ///
    /// **变异实测**：把收侧那句 `observe_remote_stamp(…)` 去掉 ⇒ 本机时钟仍停在物理钟上
    /// （比那枚快戳小）⇒ 下面两条断言当场红。
    #[test]
    fn absorbing_a_fast_peers_stamp_pushes_the_local_clock_past_it() {
        let c = stamped_conn();
        let now = 1_000_000i64;
        let far = stamp_of("FAST", now + 3_600_000); // 对端的表快一小时
        let clock_now = |c: &Connection| -> Hlc {
            let dev = device_id(c).unwrap();
            Hlc::decode(&get_meta_state(c, &clock_key(&dev)).expect("本机时钟那一格必须已经写过")).unwrap()
        };

        // ① 收下这条"来自未来"的页 upsert（真收侧路径）
        let p = remote_page("p1", &page_json("b1", 1, "远端那一版（它的表快一小时）"));
        apply_pulled_changes(&c, vec![stamped_change(2, &p, Some(&far))], 0, 1).unwrap();

        assert!(
            clock_now(&c) > far,
            "收下一枚更晚的远端戳之后，本机时钟必须**严格越过**它（HLC 的 observe）：\
             现在是 {}，那枚是 {}",
            clock_now(&c).encode(),
            far.encode()
        );

        // ② 本机随后改一次（真推侧路径）——它拿到的戳必须比刚收到那枚更晚
        let local_page = remote_page("p1", &page_json("b1", 2, "本机收下之后改的那一版"));
        record_page_upsert(&c, &local_page).unwrap();
        let local_after = page_stamp(&c, "ws", "p1").expect("推侧会给这一页记下当前那枚戳");

        assert!(
            local_after > far,
            "收下之后发生的本地改动，序上**一定**比收到的那枚更晚：本地 {} vs 对端 {}",
            local_after.encode(),
            far.encode()
        );
        // ③ 后果（这才是"丢更新"那一格）：胜负必须判给本地
        assert_eq!(
            crate::hlc::verdict(
                &crate::hlc::PayloadStamp::Ok(local_after),
                &crate::hlc::PayloadStamp::Ok(far)
            ),
            crate::hlc::Verdict::ByStamp { remote_wins: false },
            "对端时钟快**不该**压住本机后改的那一版（不 observe 就会压住）"
        );
    }

    /// ★★ 网格那两个空间 id **各司其职**：**开库**用本地空间 id（`MeshScope.db_space`），
    /// **对暗号 / 匹配对端 / 设置 KV 键**用远端空间 id（`MeshScope.space`）。
    ///
    /// 为什么这一格用**源码级**判据：这两个 id 都来自 `sync_profiles` 那一行，要在这里造出
    /// "真档案 ＋ 真库文件"的现场得拉起 `State<Db>` 那套（`mesh_sync_now` 是 `#[tauri::command]`）
    /// —— 而那正是"单跑红、全量绿"那一族（本仓吃过亏，见 `rust-plugins-alone` 那条门禁的来历）。
    /// 所以分工是：
    ///   · **行为**那一半由 `mesh::tests::the_window_serves_the_local_spaces_db_not_a_file_named_after_the_remote_id`
    ///     在**真库文件**上钉住（含变异实测：把开库那一格换回远端 id ⇒ 当场红）；
    ///   · 这里钉**调用点有没有把两个 id 喂对** —— 2026-09-26 真机就是因为喂错了（开库喂了远端 id）
    ///     才会"两台手机互相拉得动、却一条也换不过去"。
    ///
    /// ⚠️ 匹配时先把空白**压平**：rustfmt 会在参数之间换行，按整行字面量匹配会在某次格式化后假红。
    #[test]
    fn the_two_mesh_space_ids_are_wired_to_their_own_purposes() {
        let flat = include_str!("sync.rs").split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            flat.contains("crate::mesh::ensure_window(&scope.db_space, &scope.space, &scope.device, &cfg)"),
            "开窗必须是（本地 id 开库, 远端 id 对暗号, 设备号）—— 喂错就是真机那条：窗口服务一个空库"
        );
        assert!(
            flat.contains("SELECT p.space_id, p.ws_id FROM sync_profiles p"),
            "`mesh_scope` 必须**两个** id 一起取（少一个就只剩一个 id 可用）"
        );
        assert!(
            flat.contains("db_space: pick.1"),
            "`MeshScope::db_space` 必须取那一行的 `ws_id`（＝ `spaces/<id>.db` 的文件名那一半）"
        );
        // 设置 KV 键、对端匹配、关窗键 —— 三处都还是**远端**那个 id（注册表按远端空间记一份窗口）。
        assert!(
            flat.contains("let cfg = crate::mesh::settings(&c, &scope.space);"),
            "设置是**按远端空间**记的 KV（`mesh_bind:<远端 id>`），别顺手改成库名那个 id"
        );
        assert!(
            flat.contains("crate::mesh::round(&db.0, &scope.space, &scope.device, &peers)"),
            "挑对端 / 服务哪个空间都按**远端** id"
        );
        assert!(
            flat.contains("crate::mesh::stop_window(&scope.space)"),
            "关窗的键必须与开窗一致（远端 id），否则窗口会留着不放"
        );
    }

    /// ★★ 丙-② 定下的那条规则在**真 apply 路径**上成立：**远端没带戳 ⇒ 整条走今天那条路**。
    ///
    /// 今天那条路（`dirty` 优先本地 ＋ `seq` 权威）在下面两个方向上各验一次，两次都**逐字节**
    /// 是接线前的结论 —— 老对端零感知。
    #[test]
    fn a_remote_without_a_stamp_still_follows_exactly_todays_rule() {
        // ① dirty=1 且本地 seq 更大 ⇒ 保留本地（今天）
        let c = stamped_conn();
        seed_local(&c, &page_json("b1", 1, "本地那一版"), 99, 1);
        set_page_stamp(&c, "ws", "p1", &stamp_of("A", 9_000)).unwrap(); // 本地有戳，远端没有 ⇒ 仍走今天
        let p = remote_page("p1", &page_json("b1", 2, "远端那一版"));
        apply_pulled_changes(&c, vec![stamped_change(3, &p, None)], 0, 1).unwrap();
        assert!(content_of(&c).contains("本地那一版"), "缺一边 ⇒ 不许按戳判：{}", content_of(&c));

        // ② 干净且本地 seq 更小 ⇒ 采用远端（今天）
        let c = stamped_conn();
        seed_local(&c, &page_json("b1", 1, "本地那一版"), 1, 0);
        let p = remote_page("p1", &page_json("b1", 2, "远端那一版"));
        apply_pulled_changes(&c, vec![stamped_change(500, &p, None)], 0, 1).unwrap();
        assert!(content_of(&c).contains("远端那一版"), "缺一边 ⇒ 走今天那条路：{}", content_of(&c));
    }

    /// ★ 一个**不带戳**的远端把本地覆盖掉之后，本页那枚旧戳**必须被清掉**。
    ///
    /// 不清的后果是实打实的：那一枚指向"已经不是当前版本"的旧戳，下一轮拿它比会判错边 ——
    /// 而判错边就是丢更新。清掉之后下一笔自然退回今天那条路（缺一边），是安全的方向。
    #[test]
    fn an_unstamped_remote_that_wins_clears_the_page_stamp_instead_of_leaving_a_stale_one() {
        let c = stamped_conn();
        seed_local(&c, &page_json("b1", 1, "本地那一版"), 1, 0);
        set_page_stamp(&c, "ws", "p1", &stamp_of("A", 9_000)).unwrap();

        let p = remote_page("p1", &page_json("b1", 2, "远端那一版"));
        apply_pulled_changes(&c, vec![stamped_change(500, &p, None)], 0, 1).unwrap();

        assert!(content_of(&c).contains("远端那一版"), "这一笔按今天那条路判、采用远端");
        assert_eq!(page_stamp(&c, "ws", "p1"), None, "旧戳必须清掉（留着会误导下一轮）");
    }

    /// ★ 本机时钟：**每条页 upsert 都带戳**，戳**只增不减**（含物理钟回拨 / 进程重启）。
    #[test]
    fn every_recorded_page_upsert_carries_a_stamp_and_the_local_clock_only_moves_forward() {
        let c = stamped_conn();
        let p = remote_page("p1", &page_json("b1", 1, "甲"));

        record_page_upsert(&c, &p).unwrap();
        let payload: String =
            c.query_row("SELECT payload FROM changes ORDER BY seq DESC LIMIT 1", [], |r| r.get(0)).unwrap();
        let first = match crate::hlc::stamp_of_payload(&payload) {
            crate::hlc::PayloadStamp::Ok(s) => s,
            other => panic!("记下来的那一条必须带戳：{other:?}"),
        };
        assert_eq!(page_stamp(&c, "ws", "p1"), Some(first.clone()), "本页当前戳跟着本地这一版");

        record_page_upsert(&c, &p).unwrap();
        let second = local_stamp(&c, crate::db::now_ms()).unwrap();
        assert!(second > first, "第二笔的戳必须更晚");

        // 物理钟**回拨**（甚至拨到 0）：戳仍然只增不减 —— 每次从 KV 读回上次那枚就是为这个。
        let third = local_stamp(&c, 0).unwrap();
        assert!(third > second, "表被拨回去也不许倒退（倒退＝两台设备对'谁更新'各执一词）");

        // 存着的那格**读不出来就报错**，不猜着重演（重置会让戳倒退）
        let device = device_id(&c).unwrap();
        set_meta_state(&c, &clock_key(&device), "不是一枚戳").unwrap();
        assert!(local_stamp(&c, 1).is_err(), "读不出来不许猜着重置");
    }
}
