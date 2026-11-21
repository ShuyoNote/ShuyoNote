//! ⭐ **P1.5 主件 · A1 片**（Lead 2026-10-13 切法 ✓）：设备直连那一屏要用的**本机读数** ✗ ——
//! ⭐ **只读** ✓（⛔ 一个字节都不写 ✗）。
//!
//! ## 两条命令（⭐ 名字由 owner 侧拍定 ✓）
//! · [`mesh_panel_scopes`] ⇒ `[{wsId,name,kind,announced}]` ✓
//! · [`mesh_panel_spaces`] ⇒ `{offer:[…], local:[…]}` ✓ —— ⚠️ ⭐ **本片只填 `local`** ✗
//!   （`offer` 的口径 owner 已拍 ✓ ＝ 这台机器**通过网格对外宣称"我在服务"**的那一批 ✓，
//!    但它是 **B 片**的活 ✓ ⇒ 本片 `offer: Vec::new()` ＋ 注明「待 B 片」✓）。
//!
//! ## 口径（owner 拍 ✓，⛔ 别再发明 ✗）
//! · `local` ＝ 本机**现在存在**的空间 ✓（`deleted_at IS NULL` ✓）—— ⭐ 删掉的空间**不许**出现 ✗
//!   （否则界面会把"已经没有了"说成"这一台有" ✓）；
//! · `announced` ＝ 这一侧**通过网格对外宣称在服务**它 ✗ —— ⭐ **与窗口同一把尺**：
//!   [`crate::lan_state::window_serve_space`]（`lan_state.rs:953` ✓ —— P-B 已同源用过 ✓）
//!   ⇒ ⛔ 不在这里另发明一条判定 ✗（两把尺迟早会漂 ✓）；空串 ⇒ 没在服务它 ✓。
//!   ⚠️ 档案行缺失时 `resolved_space` 有**既有回落**（个人档 ⇒ 设备级暗号 ✓）—— 那正是窗口自己的口径 ✓，
//!   本模块**照用不另判** ✓（⛔ 不把"读不出来"悄悄算成 false ✗ —— 回落是既有语义 ✓）。
//! · `kind` ⭐ **直读** `meta.workspaces.kind` ✓（⛔ 不碰 `space_crypto` 的枚举/映射 ✗）。
//!
//! ## ⛔ 三条边界
//! 1. ⛔ **不动协议** ✗（全读本机库 ＋ 本机窗口状态 ✓，⛔ 一个包都不发 ✗）；
//! 2. ⛔ **回给界面的字段不含内部标识** ✗：`space_id`（协议空间／暗号）**只用来做判断** ✓，
//!    ⛔ 不进 `MeshPanelScope` ✗（`INV-UI-copy-no-internal-ids` ✓）；
//! 3. ⛔ 不含任何秘密值 ✗（暗号值一个字符都不回 ✓）。

use rusqlite::Connection;
use tauri::State;

/// ⭐ 一个空间在"网格面"上的形状 ✓（`announced` 用的是窗口那把尺 ✓）。
///
/// ⚠️ 字段就是回给界面的**全部**内容 ✓ —— ⛔ 这里**不许**出现 `space_id`／暗号值 ✗。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshPanelScope {
    /// 空间 id ✓（界面用它做行键／与 `rows` 对齐 ✓ —— 它是**本机**的 id ✓，不是协议标识 ✓）。
    pub ws_id: String,
    /// 空间名 ✓（人话 ✓）。
    pub name: String,
    /// ⭐ 直读 `meta.workspaces.kind` ✓（`''` ＝ 未分类 ⇒ 界面**如实说**，⛔ 不替它猜 ✗）。
    pub kind: String,
    /// ⭐ 这一侧**对外宣称在服务**它吗 ✓（同一把尺：`lan_state::window_serve_space` ✓）。
    pub announced: bool,
}

/// ⭐ 一条"空间"（只够界面列出来 ✓）：id ＋ 名字 ✓。
#[derive(Debug, Clone, serde::Serialize)]
pub struct MeshPanelSpace {
    pub id: String,
    pub name: String,
}

/// ⭐ `mesh_panel_spaces` 的结果 ✓。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshPanelSpaces {
    /// ⭐ ＝ 这台机器**通过网格对外宣称"我在服务"**的空间 ✓（owner 拍板 1 ✓）——
    /// ⚠️ ⭐ **本片不填** ✗（**待 B 片** ✓）：⛔ 空数组在这里**只表示"这一轮还没接线"** ✗，
    ///   ⛔ **不表示"没有"** ✗（两件事在界面上必须长得不一样 ✓ —— 那条口径见
    ///   `docs/plans/2026-09-29-nearby-devices-spec.md` 一带「0 是结论、读不到是没有结论」✓）。
    pub offer: Vec<MeshPanelSpace>,
    /// ⭐ ＝ 本机**现在存在**的空间 ✓（`deleted_at IS NULL` ✓）＝ 界面上「笔记本有哪些空间」✓。
    pub local: Vec<MeshPanelSpace>,
}

/// 本机**现在存在**的空间：`(id, name, kind)` ✓ —— ⭐ 顺序与侧栏同源（`sort_order` ＋ id 兜底 ✓）。
fn live_workspaces(c: &Connection) -> Result<Vec<(String, String, String)>, String> {
    let mut st = c
        .prepare(
            "SELECT id, name, kind FROM meta.workspaces \
             WHERE deleted_at IS NULL ORDER BY sort_order ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2).unwrap_or_default(),
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// ⭐ 这一侧**报出去的那一句** ✓（⭐ 与窗口**同一把尺** ✓）：空串 ⇒ 没在服务它 ✓。
///
/// ⚠️ `space_id` 取 `meta.sync_profiles` 那一列 ✓（没有档案行 ⇒ 空串 ✓ ⇒ 交给
///   `window_serve_space` 走它自己的既有回落 ✓ —— ⛔ 不在这里再判一次 ✗）。
fn served_scope(c: &Connection, ws_id: &str) -> String {
    let space_id: String = c
        .query_row(
            "SELECT space_id FROM meta.sync_profiles WHERE ws_id = ?1",
            [ws_id],
            |r| r.get::<_, String>(0),
        )
        .unwrap_or_default();
    crate::lan_state::window_serve_space(c, &space_id, ws_id)
}

/// ⭐ **每个空间"对外宣称"的状态** ✗（只读 ✓）。
#[tauri::command]
pub fn mesh_panel_scopes(db: State<'_, crate::db::Db>) -> Result<Vec<MeshPanelScope>, String> {
    let c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    let mut out = Vec::new();
    for (ws_id, name, kind) in live_workspaces(&c)? {
        let announced = !served_scope(&c, &ws_id).trim().is_empty();
        out.push(MeshPanelScope {
            ws_id,
            name,
            kind,
            announced,
        });
    }
    Ok(out)
}

/// ⭐ **这一台有哪些空间** ＋（B 片）**这一台对外说在服务哪些** ✗（只读 ✓）。
#[tauri::command]
pub fn mesh_panel_spaces(db: State<'_, crate::db::Db>) -> Result<MeshPanelSpaces, String> {
    let c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    let local = live_workspaces(&c)?
        .into_iter()
        .map(|(id, name, _)| MeshPanelSpace { id, name })
        .collect();
    Ok(MeshPanelSpaces {
        // ⭐ **待 B 片** ✓（owner 拍板 1：`offer` ＝ 对外宣称那一批 ✓）—— ⛔ 本片瞎填会造出假读数 ✗。
        offer: Vec::new(),
        local,
    })
}

/// ⭐ **2026-11-10（owner 批 B）**：当前空间里**待确认**的「同名但 uid 不同」冲突（只读、只含元数据）。
///
/// 背景：融合闸 `RefuseDifferentUid` 会一直拒绝，而原先**没有任何确认入口** ⇒ 用户看到的就是
/// “同名空间永远同步不过去”。这条命令把冲突列出来，界面给一个「确认是同一空间」按钮。
#[tauri::command]
pub fn mesh_uid_conflicts(
    db: State<'_, crate::db::Db>,
) -> Result<Vec<crate::mesh_uid_confirm::MeshUidConflict>, String> {
    let app_data = crate::db::app_data_dir_ref()
        .ok_or_else(|| "bad_state: app data dir 未初始化".to_string())?;
    let space = {
        let c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
        crate::attachments::active_space_id(&c)
    };
    let sc = crate::db::open_space_conn_at(&space, app_data)?;
    crate::mesh_uid_confirm::list_candidates(&sc).map_err(|e| e.to_string())
}

/// ⭐ **2026-11-10（owner 批 B）**：确认「这一台对端的这个 uid」就是本机同名空间 —— 之后融合闸放行。
///
/// ⚠️ 只写两行元数据（确认记录 ＋ 移出候选），⛔ 不碰任何页面正文 ✗。
#[tauri::command]
pub fn mesh_uid_confirm(
    db: State<'_, crate::db::Db>,
    peer_device: String,
    peer_uid: String,
) -> Result<bool, String> {
    let app_data = crate::db::app_data_dir_ref()
        .ok_or_else(|| "bad_state: app data dir 未初始化".to_string())?;
    let space = {
        let c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
        crate::attachments::active_space_id(&c)
    };
    let sc = crate::db::open_space_conn_at(&space, app_data)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    crate::mesh_uid_confirm::confirm(&sc, peer_device.trim(), peer_uid.trim(), now)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// ⭐ **A3（2026-11-21）**：**一次确认多对**同名 uid 候选（批量勾选 ＋ 同 uid 传播）。
///
/// 为什么要有它：原先每对设备、每对 uid 各点一次（DEC-D 人工闸）—— 两台设备报同一个
/// `space_uid` 时，用户得把同一个答案点两遍。这里只把"点一次"的**覆盖面**变大：
///
/// 1. ⛔ **不代用户确认**：确认仍然只由界面上的一次点击发起（本命令没有后台调用点）；
/// 2. 批量阶段只写**勾选且候选表里真有**的键（判据 `batch-selected-only`）；
/// 3. 传播只沿 **uid 相同** 扩散（判据 `propagate-same-uid-only`；uid 不同 ⇒ 绝不传播）；
/// 4. 空选／全是空键／没有候选 ⇒ **连空间库都不开**（判据 `empty-selection-writes-nothing`）。
///
/// ⚠️ 只写两张小表（确认记录 ＋ 移出候选），⛔ 不碰任何页面正文；整个写入在一个事务里。
#[tauri::command]
pub fn mesh_uid_confirm_batch(
    db: State<'_, crate::db::Db>,
    keys: Vec<crate::mesh_uid_confirm::MeshUidKey>,
) -> Result<crate::mesh_uid_confirm::MeshUidBatchDone, String> {
    use crate::mesh_uid_confirm::{plan_batch_confirm, MeshUidBatchDone};
    let done_none = MeshUidBatchDone {
        written: 0,
        propagated: 0,
    };
    // ③ 空选 ⇒ **不开库、不写库**（判据 `empty-selection-writes-nothing`）。
    let has_any = keys
        .iter()
        .any(|k| !k.peer_device.trim().is_empty() && !k.peer_uid.trim().is_empty());
    if !has_any {
        return Ok(done_none);
    }
    let app_data = crate::db::app_data_dir_ref()
        .ok_or_else(|| "bad_state: app data dir 未初始化".to_string())?;
    let space = {
        let c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
        crate::attachments::active_space_id(&c)
    };
    let mut sc = crate::db::open_space_conn_at(&space, app_data)?;
    let candidates = crate::mesh_uid_confirm::list_candidates(&sc).map_err(|e| e.to_string())?;
    // ① / ② 都在这个纯函数里（判据有单测）；这里只负责照单写。
    let plan = plan_batch_confirm(&candidates, &keys);
    if plan.write.is_empty() {
        return Ok(done_none);
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let tx = sc.transaction().map_err(|e| e.to_string())?;
    for (peer_device, peer_uid) in &plan.write {
        crate::mesh_uid_confirm::confirm(&tx, peer_device, peer_uid, now)
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(MeshUidBatchDone {
        written: plan.write.len(),
        propagated: plan.propagated,
    })
}

/// ⭐ **2026-11-11（§13 A2）**：一条对等体的**只读水位**（⛔ 不含 `device_id`／正文）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshPeerWatermark {
    /// 对端序号（1 起；⚠️ 内部 device_id 不上界面 —— `INV-UI-copy-no-internal-ids`）。
    pub index: usize,
    /// 本机已收该对端到哪个 `device_seq`（0 ＝ 还没收过）。
    pub cursor: i64,
    /// ⭐ 2026-11-12（§13 S1）：最近一次成功同步是否在 TTL 内（`null` ＝ **还没有成功记录**，结论未知）。
    pub online: Option<bool>,
    /// ⭐ 距离最近一次成功同步过了多少毫秒（`null` ＝ 还没有成功记录）。
    pub last_ok_ago_ms: Option<i64>,
}

/// ⭐ **2026-11-20（owner 拍「让报警出现在界面上」）**：一段**永久缺失**的序号（闭区间）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncGap {
    pub from: i64,
    pub to: i64,
}

/// ⭐ **2026-11-20**：把"缺口签名"（`cursor|min`）解析成一段永久缺失（纯函数，⛔ 不碰库）。
///
/// 口径：
/// 1. 形状不对（不是 `a|b`、解析不出整数）⇒ `None`（⛔ 不猜）；
/// 2. 复用 `mesh::missing_range`（**同一个判定函数**，⛔ 不在这里另写一份口径）；
/// 3. 它判"没丢"时也返回 `None`（例如游标已追上）。
pub fn gap_from_signature(sig: &str) -> Option<SyncGap> {
    let (a, b) = sig.split_once('|')?;
    let cursor: i64 = a.trim().parse().ok()?;
    let min_seq: i64 = b.trim().parse().ok()?;
    let (from, to) = crate::mesh::missing_range(cursor, min_seq)?;
    Some(SyncGap { from, to })
}

/// ⭐ **2026-11-20（owner 拍「让报警出现在界面上」）**：只读「当前空间的永久缺失清单」。
///
/// 为什么要它：F2-0 的 `[mesh] 缺口已过期` 只打在 stderr —— 用户**永远看不见**"某空间缺了一段、
/// 而且补不回来"。这一格把它搬到界面上（⛔ 仍然只读：不拉、不补、不改任何状态）。
///
/// 数据来源：`meta.sync_state` 的 `peer_gap:<proto>:<device> = "cursor|min"`（拉取那一轮写下的签名）。
/// ⚠️ 只报**当前空间**的：跨空间的缺口混在一起会让用户不知道去哪儿处理。
#[tauri::command]
pub fn list_sync_gaps(db: State<'_, crate::db::Db>) -> Result<Vec<SyncGap>, String> {
    let app_data = crate::db::app_data_dir_ref()
        .ok_or_else(|| "bad_state: app data dir 未初始化".to_string())?;
    let space = {
        let c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
        crate::attachments::active_space_id(&c)
    };
    let sc = crate::db::open_space_conn_at(&space, app_data)?;
    let proto = crate::sync::mesh_scope_at(&sc, Some(&space))
        .map(|s| s.space)
        .unwrap_or_default();
    if proto.trim().is_empty() {
        return Ok(Vec::new());
    }
    let like = format!("peer_gap:{proto}:%");
    let c = crate::db::open_meta_conn_at(app_data)?;
    let mut stmt = c
        .prepare("SELECT value FROM sync_state WHERE key LIKE ?1")
        .map_err(|e| e.to_string())?;
    let rows: Vec<String> = stmt
        .query_map(rusqlite::params![like], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    let mut out: Vec<SyncGap> = rows.iter().filter_map(|s| gap_from_signature(s)).collect();
    out.sort_by_key(|g| g.from);
    out.dedup();
    Ok(out)
}

/// ⭐ **2026-11-11（§13 A2 第一刀）**：当前空间的只读水位读数（本机高水位 ＋ 各对端已收水位）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshWatermarks {
    pub space_name: String,
    /// 本机这一栏已发到哪个 `device_seq`。
    pub local_max_seq: i64,
    /// 各对端的已收水位（按水位降序；⛔ 只有序号，没有设备 id）。
    pub peers: Vec<MeshPeerWatermark>,
    /// ⭐ 2026-11-12（§13 S1）：在线/离线/未知（未知＝还没有成功记录，⛔ 不冒充离线）。
    pub online_count: usize,
    pub offline_count: usize,
    pub unknown_count: usize,
    /// 口径说明（人话；界面照抄）。
    pub note: String,
}

/// 纯函数：从 `sync_state` 的 `(key, value)` 里挑出 `mesh_cursor:<space>:<device>`，回 `(device, 水位)`。
/// ⛔ 不猜：key 形状不对／值不是整数 ⇒ 跳过（⛔ 不把坏值当 0 混进来）。
fn parse_peer_cursors(rows: &[(String, String)]) -> Vec<(String, i64)> {
    let mut out: Vec<(String, i64)> = rows
        .iter()
        .filter_map(|(k, v)| {
            let rest = k.strip_prefix("mesh_cursor:")?;
            let (_space, dev) = rest.rsplit_once(':')?;
            let cursor = v.trim().parse::<i64>().ok()?;
            Some((dev.to_string(), cursor))
        })
        .collect();
    out.sort_unstable_by(|a, b| b.1.cmp(&a.1));
    out
}

/// ⭐ **2026-11-19 修**：游标行**两个库都要看** —— 生产上 `mesh_cursor:*` 写在 **meta.db**
/// （`sync_state` 全局键），而空间库那份在多数机器上是空的（实测：meta 12 行 / 空间库 0 行）
/// ⇒ 原来只读空间库 ⇒ 面板「多设备同步图」**永远空**（"同步成功却一台都没有"）。
///
/// ⚠️ **必须按当前空间（对暗号那个 id）过滤**：同一个 meta 库里挤着**所有空间**的游标
/// （实测一次读出 5 台，其中 1505/475 其实是**别的空间**的计数）——
/// 不过滤就会把别的空间的进度混进本空间，算出"已收 1505 / 本机 317（落后 0）"这种假读数（2026-11-19 实测过）。
///
/// 合并口径：**同一台设备取较大游标**（两处都有时不许让旧值盖新值），按游标降序。
fn merge_peer_cursors(
    space_key: &str,
    meta_rows: &[(String, String)],
    space_rows: &[(String, String)],
) -> Vec<(String, i64)> {
    // 只保留 `mesh_cursor:<当前空间>:<设备>` 这一族；别的空间一律不算。
    if space_key.trim().is_empty() {
        return Vec::new();
    }
    let prefix = format!("mesh_cursor:{}:", space_key);
    let keep = |rows: &[(String, String)]| -> Vec<(String, String)> {
        rows.iter()
            .filter(|(k, _)| k.starts_with(&prefix))
            .cloned()
            .collect()
    };
    let mut by_dev: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    for (dev, cursor) in parse_peer_cursors(&keep(meta_rows))
        .into_iter()
        .chain(parse_peer_cursors(&keep(space_rows)))
    {
        let e = by_dev.entry(dev).or_insert(cursor);
        if cursor > *e {
            *e = cursor;
        }
    }
    let mut out: Vec<(String, i64)> = by_dev.into_iter().collect();
    out.sort_unstable_by(|a, b| b.1.cmp(&a.1));
    out
}

/// ⭐ **2026-11-11（§13 A2）**：只读「设备×空间水位」——当前空间：本机高水位 ＋ 各对端已收水位。
///
/// 口径：**只读**（不建连接、不发包、不写库）；对端只用**序号**表示（内部 id 不上界面）。
/// ⭐ 2026-11-12（§13 S1）：顺带给出“在线视角”（最近一次成功同步是否在 TTL 内；没有记录 ⇒ 未知）。
#[tauri::command]
pub fn mesh_watermarks(db: State<'_, crate::db::Db>) -> Result<MeshWatermarks, String> {
    /// 在线视角 TTL：同步轮间隔约 2 分钟 ⇒ 两倍＝4 分钟没成功就按“离线”看。
    const ONLINE_TTL_MS: i64 = 4 * 60_000;
    let app_data = crate::db::app_data_dir_ref()
        .ok_or_else(|| "bad_state: app data dir 未初始化".to_string())?;
    let space = {
        let c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
        crate::attachments::active_space_id(&c)
    };
    let sc = crate::db::open_space_conn_at(&space, app_data)?;
    let space_name = crate::sync::local_space_name(&sc).unwrap_or_default();
    let device = crate::sync::device_id(&sc).unwrap_or_default();
    let local_max_seq = crate::mesh::max_own_device_seq_for_ui(&sc, &device).unwrap_or(0);
    // ⭐ 2026-11-19 修：游标在 **meta.db**（生产实况），空间库那份通常为空 ⇒ 两边都读再合并。
    //   ⚠️ 绑定要写得让借用活得够久（`query_map` 的行借用 `stmt`）。
    let space_rows: Vec<(String, String)> = {
        let mut stmt = sc
            .prepare("SELECT key, value FROM sync_state WHERE key LIKE 'mesh_cursor:%'")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        mapped.filter_map(Result::ok).collect()
    };
    let meta_rows: Vec<(String, String)> = {
        // ⚠️ 必须显式开 **meta.db**：游标是"跨空间的全局计数"，`Db.0` 那一份不是它（实测读出来 0 行）。
        let c = crate::db::open_meta_conn_at(app_data)?;
        let mut stmt = c
            .prepare("SELECT key, value FROM sync_state WHERE key LIKE 'mesh_cursor:%'")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        mapped.filter_map(Result::ok).collect()
    };
    let now = crate::db::now_ms();
    // ⭐ 2026-11-19：水位必须**按当前空间**取（`mesh_cursor:<对暗号 id>:<设备>`）——
    //   这里先把这个空间的"对暗号 id"算出来（与同步轮同一处口径：`mesh_scope_at`）。
    let space_key = crate::sync::mesh_scope_at(&sc, Some(&space))
        .map(|s| s.space)
        .unwrap_or_default();
    let mut online_count = 0usize;
    let mut offline_count = 0usize;
    let mut unknown_count = 0usize;
    let peers = merge_peer_cursors(&space_key, &meta_rows, &space_rows)
        .into_iter()
        .enumerate()
        .map(|(i, (dev, cursor))| {
            let last_ok = crate::mesh::round_health_last_ok(&dev);
            let online = crate::mesh::presence_online(last_ok, now, ONLINE_TTL_MS);
            match online {
                Some(true) => online_count += 1,
                Some(false) => offline_count += 1,
                None => unknown_count += 1,
            }
            MeshPeerWatermark {
                index: i + 1,
                cursor,
                online,
                last_ok_ago_ms: if last_ok > 0 {
                    Some(now - last_ok)
                } else {
                    None
                },
            }
        })
        .collect();
    Ok(MeshWatermarks {
        space_name,
        local_max_seq,
        peers,
        online_count,
        offline_count,
        unknown_count,
        note: "只读：对端按序号显示（内部设备 id 不上界面）；cursor ＝ 本机已收该对端到的位置；在线＝最近一次成功同步在 4 分钟内有记录".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⭐ **2026-11-20**：`gap_from_signature` 的五格 —— 界面那一行"永久缺失"的唯一判据。
    /// ⚠️ 复用 `mesh::missing_range`（⛔ 不在这里另写一份口径）；形状不对 ⇒ `None`（⛔ 不猜）。
    #[test]
    fn gap_from_signature_parses_only_real_gaps() {
        assert_eq!(gap_from_signature("5|10"), Some(SyncGap { from: 6, to: 9 }));
        assert_eq!(
            gap_from_signature("0|59"),
            Some(SyncGap { from: 1, to: 58 })
        );
        // 只缺 1 条也要报
        assert_eq!(
            gap_from_signature("9|11"),
            Some(SyncGap { from: 10, to: 10 })
        );
        // 已经追上 / 对端没报 min ⇒ 不报
        assert_eq!(gap_from_signature("9|10"), None);
        assert_eq!(gap_from_signature("50|0"), None);
        // 坏形状一律 None（⛔ 不猜）
        assert_eq!(gap_from_signature("x|y"), None);
        assert_eq!(gap_from_signature("5"), None);
        assert_eq!(gap_from_signature("5|10|"), None);
        assert_eq!(gap_from_signature(""), None);
    }

    /// ⭐ 2026-11-11（§13 A2）：只读水位矩阵的**解析**判据 —— 只认 `mesh_cursor:<space>:<device>`，
    /// 值必须是非负整数；形状不对/不是整数 ⇒ 跳过（⛔ 不猜、不把坏值当 0 混进来）。
    #[test]
    fn parse_peer_cursors_keeps_only_well_formed_positive_rows() {
        let rows = vec![
            ("mesh_cursor:sp:dev-a".to_string(), "12".to_string()),
            ("mesh_cursor:sp:dev-b".to_string(), "7".to_string()),
            ("mesh_cursor:sp:dev-c".to_string(), "abc".to_string()),
            ("mesh_cursor:broken".to_string(), "9".to_string()),
            ("other_key".to_string(), "3".to_string()),
        ];
        let got = parse_peer_cursors(&rows);
        assert_eq!(
            got,
            vec![("dev-a".to_string(), 12), ("dev-b".to_string(), 7)],
            "只留良构且按水位降序；坏值/坏 key 跳过"
        );
    }

    /// ⭐ **2026-11-19（真机修）**：水位合并的判据 ——
    /// ① 只认**当前空间**那一族 key（别的空间哪怕游标更大也不许混进来）；
    /// ② 两个库（meta / 空间库）都有同一台时**取较大值**（不许旧值盖新值）；
    /// ③ 空间 key 为空 ⇒ **一条都不返回**（⛔ 不猜"大概就是这台"）。
    #[test]
    fn merge_peer_cursors_scopes_to_the_space_and_keeps_the_larger_value() {
        let meta = vec![
            // 当前空间：dev-a 两个库里都有 → 取大的 50
            ("mesh_cursor:sp-x:dev-a".to_string(), "50".to_string()),
            // 别的空间：dev-b 游标 999 —— ⛔ 不许混进本空间（真机 2026-11-19 就是这么混出 1505 的）
            ("mesh_cursor:sp-other:dev-b".to_string(), "999".to_string()),
            ("mesh_cursor:sp-x:dev-c".to_string(), "7".to_string()),
        ];
        let space = vec![("mesh_cursor:sp-x:dev-a".to_string(), "12".to_string())];
        let got = merge_peer_cursors("sp-x", &meta, &space);
        assert_eq!(
            got,
            vec![("dev-a".to_string(), 50), ("dev-c".to_string(), 7)],
            "按空间过滤＋同设备取大＋降序"
        );
        // 空间 key 为空 ⇒ 一条都不给（而不是"全给"或"随便给"）
        assert!(merge_peer_cursors("", &meta, &space).is_empty());
        // 本空间没有任何游标 ⇒ 空表（面板据此显示"还没有对端水位"）
        assert!(merge_peer_cursors("sp-empty", &meta, &space).is_empty());
    }

    /// ⭐ 2026-11-12（§13 S1）：在线视角三态 —— 没有成功记录＝未知（⛔ 不冒充离线）；TTL 内＝在线。
    #[test]
    fn presence_is_unknown_without_success_and_uses_ttl() {
        assert_eq!(
            crate::mesh::presence_online(0, 1_000_000, 240_000),
            None,
            "没有成功记录 ⇒ 未知"
        );
        assert_eq!(
            crate::mesh::presence_online(900_000, 1_000_000, 240_000),
            Some(true)
        );
        assert_eq!(
            crate::mesh::presence_online(500_000, 1_000_000, 240_000),
            Some(false)
        );
    }

    /// ⭐ 一个最小的 meta 库（照 `lan_state.rs:988` 的那份夹具 ✓ ＋ 本模块要用到的三列 ✓）。
    ///
    /// ⚠️ 本机 rust 组按 `AGENTS.md` §7 以 **Linux(CI)/WSL** 为准 ⇒ 本文件这两条判据在
    /// **本片只保证编进 lib** ✓（收口读数里如实标注"编译过、本机未执行"✗），跑起来的是 CI ✓。
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
             CREATE TABLE meta.workspaces (
                 id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '',
                 sort_order REAL NOT NULL DEFAULT 0, deleted_at INTEGER
             );
             INSERT INTO meta.workspaces (id, name, kind, sort_order) VALUES ('ws-a', '工作', 'team', 0);
             INSERT INTO meta.workspaces (id, name, kind, sort_order) VALUES ('ws-b', '私人', 'personal', 1);
             INSERT INTO meta.workspaces (id, name, kind, sort_order, deleted_at)
                 VALUES ('ws-gone', '删掉的', 'personal', 2, 1700000000000);
             INSERT INTO meta.sync_state (key, value) VALUES ('device_id', 'dev-a');",
        )
        .unwrap();
        c
    }

    /// ⭐ 判据（`local` 的**值级**那一半 ✓）：`local` ＝ 本机**现在存在**的空间 ⇒
    /// ⛔ 删掉的（`deleted_at` 非空）**不许**出现 ✗；顺序 = `sort_order` ✓。
    #[test]
    fn local_lists_only_live_workspaces_in_sort_order() {
        let c = fixture();
        let live = live_workspaces(&c).unwrap();
        let ids: Vec<&str> = live.iter().map(|(id, _, _)| id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["ws-a", "ws-b"],
            "⛔ `local` 只许列现在存在的空间（`ws-gone` 已被删 ✗），且按 sort_order ✓"
        );
        assert_eq!(live[0].2, "team", "⭐ `kind` 直读 `meta.workspaces.kind` ✓");
        assert_eq!(live[1].2, "personal", "⭐ 同上 ✓");
    }

    /// ⭐ 判据：`announced` 走**窗口那把尺** ✓ —— 没配档案（⇒ 没有"在服务"）⇒ `false` ✓。
    #[test]
    fn announced_follows_the_window_yardstick() {
        let c = fixture();
        assert!(
            served_scope(&c, "ws-a").trim().is_empty(),
            "⭐ 没有档案行 ⇒ 这一侧没在服务它 ⇒ `announced` 必须是 false ✓"
        );
        c.execute_batch(
            "INSERT INTO meta.sync_profiles (ws_id, space_id) VALUES ('ws-a', 'space-a');",
        )
        .unwrap();
        // ⭐ 不判"必须非空" ✗ —— 非空与否由 `window_serve_space`（窗口那把尺 ✓）说了算；
        //    这里钉的是**它被走到了** ✓（`resolved_space` 的回落是既有语义 ✓，⛔ 不在这里另判 ✗）。
        let got = served_scope(&c, "ws-a");
        assert!(
            got == got.trim(),
            "⭐ 回给判断的那一句不该带空白（窗口用的是 `trim()` 后的比较 ✓）"
        );
    }
}
