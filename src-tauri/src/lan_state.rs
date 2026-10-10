//! **局域网发现的运行时归属**：对端表 ＝ **应用级单例**，并且**按需启用**。
//!
//! ## 这一层为什么单独存在
//!
//! owner 2026-09-25 拍板（见 `docs/plans/2026-09-24-lan-discovery-workorder.md` §8 第 ② 条）：
//! **「对端表归谁」= 应用级单例 ＋ 按需启用**。它是§7 那四件的门闩 —— 在它定下来之前，
//! 接线那一片谁都不敢落（"谁都能 `new` 一个对端表"这种形态，错了会让整个发现层白做）。
//!
//! 三条口径：
//! 1. **一个进程一份**：发现是**网络环境**的属性，不是某个空间的属性 ⇒ 不按空间各来一份；
//! 2. **按需启用**：只有当**确实有空间绑了同步**时才启用广播/监听 —— 不做无谓广播
//!    （发现层挂了也不许让本来能同步的用户同步不了，见 `lan::resolve_base` 的口径 3）；
//! 3. **关掉＝看不见**：`peers()` 在未启用时**一律返回空**（不是"表里有但不用"），
//!    这样"没启用"与"网段里没人"在调用方看来**是同一种处境**，地址解析自然回落到配置地址。
//!
//! ⚠️ 这一层**不含任何路由判断**：它回答"现在该不该听/该不该喊"与"现在听到了谁"，
//! 以及**驱动那两件事的循环**（[`start`]：一个 tokio 任务，绑 UDP ＋ 周期广播 ＋ 收报入库 ＋
//! 按 TTL 腾过期行）。"这一轮走哪个地址"仍是 `lan::resolve_base` 的活（纯函数、判据在那儿）。

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::OnceLock;

use tauri::Manager;

use crate::db::Db;
use crate::lan::{self, Peer, PeerTable};

/// 应用级的发现状态：一张对端表 ＋ 一个"要不要听/喊"的开关。
pub struct LanState {
    table: PeerTable,
    enabled: AtomicBool,
}

impl LanState {
    /// 造一个（测试与"想自己持有一份"的调用方用）。**生产路径请走 [`LanState::global`]**。
    pub fn new(local_device_id: String) -> Self {
        Self { table: PeerTable::new(local_device_id), enabled: AtomicBool::new(false) }
    }

    /// 进程级的唯一一份。`local_device_id` 只在**第一次**调用时用得上（之后忽略）——
    /// 这与"进程里只有一个 device_id"这件事是一致的。
    pub fn global(local_device_id: &str) -> &'static LanState {
        static GLOBAL: OnceLock<LanState> = OnceLock::new();
        GLOBAL.get_or_init(|| LanState::new(local_device_id.to_string()))
    }

    /// 记一条公告（**未启用时也不拒绝**：收到就记，看不看得见由 [`LanState::peers`] 决定）。
    /// 返回 `false` ＝ 这条是我自己的（[`PeerTable::upsert`] 的语义）。
    pub fn observe(&self, p: Peer) -> bool {
        self.table.upsert(p)
    }

    /// 收**一条原始报文**：按公告解 ⇒ 入库 ⇒ 把入库的那一条还回来（`Ok(Some)`）。
    ///
    /// 返回值与 [`crate::lan::recv_into`] 一一对应（它就是这一层的薄壳）：
    /// - `Ok(Some(peer))` ＝ 收了、记了；
    /// - `Ok(None)` ＝ **这一条不是"新的对端"**：是我自己的公告（回环回来的）⇒ 忽略。
    ///   它不入对端表、也不是错误 —— 调用方（那条循环）把它读成"这一片收到了东西"。
    /// - `Err(原因)` ＝ 报文不合法 ⇒ **丢弃且不入表**（公告四种原因见 `lan::AnnounceReject::reason`）。
    ///
    /// ⚠️ **解码只在这一处**：`recv_into` 不再自己 `decode_announce` 一遍 —— 两处各解一次
    /// 迟早会漂（那种漂的表现是"某一种坏报文在一处被丢、在另一处被收下"）。
    /// ⚠️ **`decode_announce` 一个字节都没动**（它的"不认识就不猜"是承重的）。
    pub fn record_datagram(&self, raw: &str, from_ip: &str, now_ms: i64) -> Result<Option<Peer>, String> {
        let announce = match crate::lan::decode_announce(raw) {
            Ok(a) => a,
            Err(r) => return Err(r.reason().to_string()),
        };
        let peer = Peer { announce, addr: from_ip.to_string(), seen_at_ms: now_ms };
        if !self.observe(peer.clone()) {
            return Ok(None);
        }
        Ok(Some(peer))
    }

    /// 启用 / 停用。**停用不清表**（网段里还是那些人，只是这一次我们不看）——
    /// 但 [`LanState::peers`] 会立刻当它不存在，见口径 3。
    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::SeqCst);
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// 现在能用的对端：**未启用 ⇒ 空**（口径 3）。
    pub fn peers(&self, now_ms: i64) -> Vec<Peer> {
        if !self.is_enabled() {
            return Vec::new();
        }
        self.table.live(now_ms)
    }

    /// 诊断用：不管开关，表里现在有什么。
    pub fn observed_all(&self) -> Vec<Peer> {
        self.table.snapshot()
    }

    /// 腾掉过期的行（由周期任务调用）。
    pub fn sweep(&self, now_ms: i64) -> usize {
        self.table.sweep(now_ms)
    }
}

/// **按需启用的判别式**（口径 2）：只有当**至少有一个空间绑了同步**时才该启用。
///
/// 抽成一个纯函数是为了让这条口径有判据 —— 它是"要不要在用户的网段里发声"这件事的唯一开关，
/// 写错的表现是"用户没绑同步，我们却在广播"（用户看不见、但那是隐私与噪音的两重错）。
pub fn should_enable(bound_profiles: usize) -> bool {
    bound_profiles > 0
}

/// [`should_enable`] 的直接上游：**绑了同步的空间数** —— `(space_id, server_url)` 两条都非空
/// 才算"真绑上了"（只填了地址还没选空间是**正常中间态**，那种行不许让整个进程开始广播）。
///
/// ⚠️ 与 `sync::claim_config` 的口径**逐条对齐**（同一件事两侧各判一次就会漂）：那边也只认
/// `space_id` 与 `server_url` 都非空的行。
pub fn bound_profile_count(rows: &[(String, String, String)]) -> usize {
    rows.iter()
        .filter(|(space_id, server_url, _)| is_fully_bound(space_id, server_url))
        .count()
}

/// 一行档案算不算"绑上了"（[`bound_profile_count`] 与 [`announces_for`] 共用的那一把尺）。
///
/// ⚠️ **两处必须用同一把尺**：若"算不算绑上"与"要不要发言"用了两条判据，
/// 就会出现"计数说绑了、却不发言"（或反过来）—— 现象是网段里该露面的时候不露面，
/// **没有编译期信号、单测也照绿**。
fn is_fully_bound(space_id: &str, server_url: &str) -> bool {
    !space_id.trim().is_empty() && !server_url.trim().is_empty()
}

// ── 接线（甲-1 接线第 1 件）：周期循环的**纯函数**那一半 ───────────────────────────────────

/// 广播间隔。**只决定"多久喊一次"，不决定"还在不在"** —— 那个由 `lan::PEER_TTL_MS` 管，
/// 判据 `the_peer_ttl_outlives_the_announce_interval`（本文件 `tests`）钉着两者的大小关系。
///
/// ⚠️ 30s 不是随手取的：网段里 N 台设备 ≈ 每 30s 就有 N 条广播（噪音可控），
/// 而它对 `PEER_TTL_MS`（90s）有 3× 余量 ⇒ **连丢两条公告也还不至于把对端判死**。
pub const ANNOUNCE_INTERVAL_MS: i64 = 30_000;

/// 收报的等待上限：每这么久回一次头，好让**广播与腾表**即使网段里一条公告都没有
/// （`recv_from` 会一直等）也照常发生。
pub const RECV_SLICE_MS: u64 = 1_000;

/// 这一轮"该不该喊"（纯函数）。
///
/// `last_announce_ms <= 0` ＝ 还没喊过（第一轮就要喊，别让新设备等一个间隔才露面）。
pub fn announce_due(last_announce_ms: i64, now_ms: i64, interval_ms: i64) -> bool {
    last_announce_ms <= 0 || now_ms.saturating_sub(last_announce_ms) >= interval_ms
}

// ── ⭐⭐ task-12（owner 拍 C「后台每 5 分钟跑一次，打开面板时更勤」）────────────────────────────

/// **后台自主节拍**：多久**不靠界面**跑一轮网格交换（owner 原话「后台每 5 分钟」✓）。
///
/// ⚠️ 它**只管后台那一轮** ✗ —— 面板打开时前端那条路**保留**（更快 ✓，owner 原话「打开面板时更勤」✓）；
/// 两条路**共用同一套落库**（`sync::mesh_round_once` ✓）⇒ 不会出现"面板跑的记、后台跑的不记" ✗。
pub const BACKGROUND_ROUND_MS: i64 = 5 * 60 * 1000;

/// ⭐ **task-12（Lead 拍 B）**：本轮 **`候选 0`** ⇒ 下次约 60 秒再来 ✓（"没找到对端"**不算**"跑过一轮" ✓）。
pub const BACKGROUND_RETRY_MS: i64 = 60 * 1000;

/// ⭐ **task-12（Lead 拍上限）**：**连续这么多次仍然 `候选 0`** ⇒ ⭐ **退回 5 分钟** ✓
/// （⛔ 别在没对端的网段里每 60 秒空转一小时 ✗）。
pub const BACKGROUND_EMPTY_GIVE_UP: usize = 5;

/// ⭐ **task-12**：**启动后第一轮等一会儿再跑** ✓ —— 实测（真机日志）启动后 3 秒就跑了，
/// 而 **对端的公告 27 秒后才到** ✗ ⇒ 那一轮 `候选 0`、白跑 ✓，而下一次要等满 5 分钟 ✓。
pub const BACKGROUND_WARMUP_MS: i64 = 45 * 1000;

/// ⭐ **task-12（Lead 拍 B ＋ 上限）**：**下一次后台轮该等多久** —— 纯函数（判据够得着 ✓）。
///
/// 三条口径（Lead 逐条拍 ✓）：
/// · `empty_streak == 0`（上一轮找到了对端）⇒ ⭐ **5 分钟常态** ✓；
/// · `1..5`（最近有空手）⇒ ⭐ **60 秒**再来一次 ✓；
/// · `>= 5` ⇒ ⭐ **退回 5 分钟** ✓（放弃这次"快试" ✓）。
/// ⚠️ ⭐ **只影响后台这一条** ✗ —— 面板那条的节拍**一个字不动** ✓（owner 拍的是"面板打开时更勤"✓）。
pub fn background_round_interval_ms(empty_streak: usize) -> i64 {
    if empty_streak == 0 || empty_streak >= BACKGROUND_EMPTY_GIVE_UP {
        BACKGROUND_ROUND_MS
    } else {
        BACKGROUND_RETRY_MS
    }
}

/// ⭐ **task-12**：后台那一轮的**起算时刻**（启动时用一次 ✓）——
/// ⭐ 让第一轮落在**启动后约 [`BACKGROUND_WARMUP_MS`]**，⛔ 不是"启动那一瞬间" ✗（实测那一轮必然空手 ✓）。
pub fn background_round_initial_last(started_ms: i64) -> i64 {
    started_ms - BACKGROUND_ROUND_MS + BACKGROUND_WARMUP_MS
}

/// ⭐ **task-12 的判据面**：**后台这一轮该不该跑** —— 纯函数（**可注入时钟** ✓，判据不打桩 ✓）。
///
/// 三条一次说清：
/// · **一个网格空间都没有 ⇒ `false`** ✓ —— ⛔ "没配 ⇒ 一个字节都不动"这条口径**一个字不变** ✗
///   （`meshed` 是**解析后且配了监听地址**的那些 ✓，与发现层同尺 ✓）；
/// · `last_ms <= 0` ⇒ 第一次就该跑 ✓（复用 `announce_due` 的同一口径 ✓，⛔ 不另立一套 ✗）；
/// · 到点（≥ [`background_round_interval_ms`]）⇒ 跑 ✓。
pub fn background_round_due(last_ms: i64, now_ms: i64, meshed_n: usize, empty_streak: usize) -> bool {
    // ⭐ ① **一个网格空间都没有 ⇒ 不跑** ✓ —— "没配 ⇒ 一个字节都不动"一个字不变 ✓（判据钉着 ✓）。
    if meshed_n == 0 {
        return false;
    }
    // ⭐ ② 到点就跑 ✓（`last_ms <= 0` ＝ 还没跑过 ⇒ 第一轮就跑 ✓ —— 复用 `announce_due` 的同一口径 ✓，
    //    ⛔ 不另立一套 ✗：两处各写一遍的间隔判断迟早会漂 ✓）。
    announce_due(last_ms, now_ms, background_round_interval_ms(empty_streak))
}

/// ⭐ **task-12**：后台那一轮**是不是还在跑**（⛔ 不许两轮叠在一起 ✗）。
static BACKGROUND_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// ⭐ **task-12（Lead 拍）**：最近**连续几次**后台轮是空手的（`候选 0` ✓）——
/// ⭐ 找到对端 ⇒ **清零** ✓／空手 ⇒ **+1** ✓／收到公告 ⇒ **清零** ✓ ⇒ 下一次等多久由
/// [`background_round_interval_ms`] 决定 ✓。
static BACKGROUND_EMPTY_STREAK: AtomicUsize = AtomicUsize::new(0);

/// ⭐ **task-12（Lead 批）**：**累计收到过多少条公告**（⭐ 与"候选"是**两件不同的事** ✗ ——
/// "候选 0" 可能是"没看到对端"✗、也可能是"看到了但没什么可拉"✓ ⇒ 两个数一分开就不必猜 ✓）。
static BACKGROUND_HEARD_TOTAL: AtomicUsize = AtomicUsize::new(0);

/// ⭐ **task-12（Lead 批）**：把"这一轮看到了什么"落成**两个可核读数** —— 纯函数（判据够得着 ✓）。
///
/// ⚠️ 为什么要落**库**而不是日志：⭐ 日志会被句柄/重定向/轮转弄丢 ✗（真机上**已经**发生过一次 ✓），
/// 而 ⭐ **库里的键不会** ✓。
/// · `mesh_bg_last_candidates` ＝ 上一轮**挑出几台对端**（0 ⇒ 没看到能拉的人 ✗）；
/// · `mesh_bg_last_heard` ＝ 上一轮**期间收到过几条公告**（>0 而 candidates=0 ⇒ ⭐ 看见了但对不上 ✗）。
pub fn background_round_readings(candidates: usize, heard: usize) -> Vec<(&'static str, String)> {
    vec![
        ("mesh_bg_last_candidates", candidates.to_string()),
        ("mesh_bg_last_heard", heard.to_string()),
    ]
}

/// ⭐ **task-12**：**归还**那把闸 —— 用 RAII（⛔ 手写"跑完再置回 false" ✗：一轮里任何 `?`/panic
/// 都会把它永远留在 `true` ⇒ **后台节拍从此死掉** ✓，而那正是"静默失效"的形状 ✓）。
struct BackgroundInFlightGuard;

impl Drop for BackgroundInFlightGuard {
    fn drop(&mut self) {
        BACKGROUND_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

/// ⭐ **task-12（owner 拍 C）**：把后台那一轮**扔出去跑** ✓（⛔ 不阻塞发现循环 ✗）。
///
/// 返回一句人话（这一轮真的要跑了）／`None`（上一轮还没跑完 ⇒ **这一轮跳过** ✓，不是错误 ✓）。
///
/// ⚠️ `mesh_cfgs` 就是上面那份 `(解析后的空间, 本地空间 id, 设置)` ✓ ⇒ ⛔ **没配网格的空间
/// 根本不在这个清单里** ✗ ⇒ "没配 ⇒ 一个字节都不动"这条口径**一个字不变** ✓（有判据 ✓）。
fn spawn_background_round(
    app: &tauri::AppHandle,
    device_id: &str,
    mesh_cfgs: &[(String, String, crate::mesh::MeshSettings)],
    peers: &[lan::Peer],
) -> Option<String> {
    if BACKGROUND_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return None;
    }
    let pairs: Vec<(String, String)> =
        mesh_cfgs.iter().map(|(space, ws, _)| (space.clone(), ws.clone())).collect();
    let count = pairs.len();
    let dev = device_id.to_string();
    let peers: Vec<lan::Peer> = peers.to_vec();
    let app2 = app.clone();
    // ⭐ **Lead 拍（缺陷 2）**：**两个计数器都要** ✓ ——
    //   · `mesh_bg_rounds:<空间>`（在 `sync::mesh_round_once` 里）＝ **空间 × 轮** ✓（诊断"哪个空间被服务"✓）；
    //   · `mesh_bg_rounds_total`（这里）＝ ⭐ **跑了几轮** ✓。
    //   ⚠️ ⭐ **两个数不一样，差的就是空间数** ✗（真机实测 `=4` 而只跑了 **1** 轮 ✓ —— 4 个活空间共用一个暗号 ✓）；
    //   ⭐ 两个键**都是空转轮也 +1** ✓（那是要的口径 ✓）。
    {
        let db = app.state::<Db>();
        let c = db.0.lock().unwrap_or_else(|e| e.into_inner());
        let n: i64 = crate::sync::get_meta_state(&c, "mesh_bg_rounds_total")
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let _ = crate::sync::set_meta_state(&c, "mesh_bg_rounds_total", &(n + 1).to_string());
    }
    tauri::async_runtime::spawn(async move {
        let _guard = BackgroundInFlightGuard; // ⭐ 无论怎么退出都归还 ✓
        let db = app2.state::<Db>();
        let mut found_any = false;
        let mut candidates_total: usize = 0;
        let heard_before = BACKGROUND_HEARD_TOTAL.load(Ordering::SeqCst);
        for (proto_space, db_space) in pairs {
            match crate::sync::mesh_round_once(&db.0, &proto_space, &db_space, &dev, &peers).await {
                Ok(r) => {
                    candidates_total += r.candidates;
                    if r.candidates > 0 {
                        found_any = true;
                    }
                    let pulled: usize = r.peers.iter().map(|p| p.applied).sum();
                    let bad = r.peers.iter().filter(|p| p.error.is_some()).count();
                    eprintln!(
                        "[{}] [mesh] 后台一轮完成：空间 {} ｜ 候选 {} ｜ 收下 {} 条{}",
                        lan::log_stamp(),
                        crate::lan::mask_space(&proto_space),
                        r.candidates,
                        pulled,
                        if bad > 0 { format!("（{bad} 台没拉动，见历史那一行 ✓）") } else { String::new() }
                    );
                }
                Err(e) => eprintln!(
                    "[{}] [mesh] 后台一轮失败：空间 {} ｜ {e}",
                    lan::log_stamp(),
                    crate::lan::mask_space(&proto_space)
                ),
            }
        }
        // ⭐ **task-12（Lead 拍 B ＋ 上限）**：⭐ **找到对端 ⇒ 清零** ✓／**空手 ⇒ +1** ✓ ——
        //   下一次等多久由 `background_round_interval_ms(streak)` 决定 ✓：
        //   0 ⇒ 5 分钟常态 ✓；1..5 ⇒ 60 秒再来 ✓；≥5 ⇒ 退回 5 分钟 ✓。
        if found_any {
            BACKGROUND_EMPTY_STREAK.store(0, Ordering::SeqCst);
        } else {
            BACKGROUND_EMPTY_STREAK.fetch_add(1, Ordering::SeqCst);
        }
        // ⭐ **task-12（Lead 批）**：把"这一轮看到了什么"**落进库** ✓ ——
        //   ① `候选 0` 与 ② `看到了但没什么可拉` **再也不用猜** ✓（⭐ 日志会被句柄弄丢 ✗，⭐ 库里的键不会 ✓）。
        {
            let heard = BACKGROUND_HEARD_TOTAL.load(Ordering::SeqCst).saturating_sub(heard_before);
            let db_read = app2.state::<Db>();
            let c = db_read.0.lock().unwrap_or_else(|e| e.into_inner());
            for (key, value) in background_round_readings(candidates_total, heard) {
                let _ = crate::sync::set_meta_state(&c, key, &value);
            }
        }
    });
    Some(format!("{count} 个空间，设备直连、不靠界面 ✓"))
}

/// 这一轮该发哪几条公告（纯函数）。
///
/// ⚠️ **"没在代言"与"代言着"必须都发**：`lan::announce_for_own_hub` 在配置地址不是私有网段时
/// 给 `None`（那台设备没什么可代言的），此时若"干脆什么都不发"，这台设备在网段里就
/// **整个消失了**（别人状态行的「发现 N 台」会凭空少一台），而它明明还在听。
/// 所以：**每个绑了同步的空间都发一条存在声明**，`hub_base` 那一半按代言资格给。
///
/// 绑了多个空间 ⇒ 多条（一条公告只替**一个**空间代言，`hub_spaces` 就是那个匹配键）。
/// `profiles` 的形状与 [`bound_profile_count`] 同一套：`(space_id, server_url, ws_id)`。
/// ⚠️ **只有判据在用**：产品路径一律走 [`announces_for_with_mesh`]（真循环那条）。
/// 留着三参数这一版，是为了让"**没开网格**那条路"有一条**照着老样子写**的对照可比对 ——
/// 它调用的是同一段代码（`mesh_bases` 传空），所以"逐字节相同"不是靠人盯，是靠**同一处实现**。
#[cfg(test)]
pub fn announces_for(
    local_device_id: &str,
    device_name: &str,
    short_id: &str,
    profiles: &[(String, String, String)],
) -> Vec<lan::LanAnnounce> {
    announces_for_with_mesh(local_device_id, device_name, short_id, profiles, &[])
}

/// ⭐★ **2026-10-09（task-8「设备直连」）**：**这一轮该发哪些公告** —— 产品路径的**唯一入口** ✓。
///
/// ## 为什么必须抽成函数（＝为什么这条 bug 活了这么久）
///
/// 它原先**内联在 `start()` 那条无限循环里** ✗ ⇒ 判据够不着 ⇒ 判据只能各自去测两半
/// （`window_serve_space` 测"窗口服务哪个空间" ✓、`announces_for_with_mesh` 测"公告怎么发" ✓），
/// 而**接起来对不上**这件事**没有任何判据** ✗ —— 与 R146 同一条理由（"挂在命令体里 ⇒ 判据够不着"✓）。
///
/// ## 它多做的**那一件事**（就是今天这条真机的断点）
///
/// `profiles` 来自 `bound_profiles()`，`space_id` 是**原始列** ✓；而窗口/网格匹配用的是
/// `window_serve_space()` 解析出来的空间 ✓ ⇒ **两把尺不同名**：
/// · 个人空间（`sync_profiles.space_id` 就是**空串** ✓）⇒ `mesh_bases` 的 `find` 永远 miss ✗；
/// · `is_fully_bound("", url)` 也永远 false ✗ ⇒ 那条 `continue` 把**每一行档案**都跳过
/// ⇒ ⭐ **0 条公告** ✗ ⇒ 同一热点里的两台设备**互相看不见**（对端表恒空 ⇒ `mesh_peers` 恒空
/// ⇒ `round` 永远走「网段里没有能直接拉的对端」那一支）⇒ **网格那条路从未发起** ✓。
/// 真机读数：面板「附近的设备」**为空** ✗、`sync_history` **零条设备直连**（`pushed/pulled/items` 全 0 ✗），
/// 而 `8788` 在听 ✓、`UDP 47821` 在听 ✓、双向包都通 ✓、两边配对表各一行且 `secret_sha256` 同源 ✓。
/// ⚠️ 上一笔 `dde69cbe`（2026-10-08）修的是**窗口服务/匹配**那一半 ✗ —— 公告产出这一半没跟着改
/// ⇒ **只修好了一半**，而每一片单测照绿 ✓（承重判据见 `mesh::direct_sync_tests` ✓）。
///
/// ## 三条语义（改这一处时逐条守住 ✓）
/// ① 个人空间 ⇒ 公告报 `hub_spaces=[配对暗号]` ✓（与窗口/网格**同一把尺** ✓）；
/// ② 团队空间 ⇒ **逐字不变**（`window_serve_space` 对非空 `space_id` 原样返回 ✓）；
/// ③ 解析不出来（没填暗号 / 没档案行）⇒ `window_serve_space` 保持旧口径回落成 `''` ✓
///   ⇒ 与改前**逐字相同**地不发言 ✓（放宽 ≠ 乱认 ✓，`mesh_read_scope_tests` ②③ 钉着 ✓）。
pub(crate) fn announces_for_this_round(
    c: &rusqlite::Connection,
    local_device_id: &str,
    device_name: &str,
    profiles: &[(String, String, String)],
    mesh_bases: &[(String, String)],
) -> Vec<lan::LanAnnounce> {
    // ⭐ **08-b②（合 `origin/dev` 时并进来）**：本机短标识**在本函数里读一次** ✓ ——
    //    本函数**每轮只调一次** ⇒ 这就是"一轮读一次" ✓，⛔ **不是"一条公告读一次"** ✗
    //    （dev 那侧把它写在 `start()` 的调用点上；⭐ 收进唯一入口后**两件事只有一处管** ✓，
    //     且 ⛔ 不必去动 `mesh.rs`：⭐ 那里既有 4 参调用点、⭐ 还有一条**源码级判据**盯着这行文本 ✓）。
    //    拿不到 ⇒ **如实用空串** ✓（对端显示「对方没报短标识」✓），
    //    ⛔ **绝不回落成 `device_id` 前几位** ✗。
    let short_id = local_short_id(c).unwrap_or_default();
    // ⭐ 本笔的修：把档案里的 `space_id` 换成**解析后的空间**（个人空间 ⇒ 配对暗号 ✓）——
    //   与窗口服务（`window_serve_space` ✓）和 `mesh_bases` 的键**同一把尺** ✓。
    //   ⚠️ 红读数（改前逐字的行为 ＝ 下面这行换成 `profiles.to_vec()`）：
    //      `announces_for_this_round ⇒ 0 条`（`mesh::direct_sync_tests` 两条全红 ✓）。
    let resolved: Vec<(String, String, String)> = profiles
        .iter()
        .map(|(s, url, ws)| (window_serve_space(c, s, ws), url.clone(), ws.clone()))
        .collect();
    // ⭐ 两段合起来：**唯一入口**（把空间解析对 ✓）＋ **短标识**（跟着公告出去 ✓）——
    //    ⛔ 少任何一半都会丢东西：少了前者 ⇒ 个人空间 0 条公告；少了后者 ⇒ 公告里没短标识。
    announces_for_with_mesh(local_device_id, device_name, &short_id, &resolved, mesh_bases)
}

/// ★ 丙-③-b-2b：**网格开着的那几个空间，公告里报的是我自己的窗口地址。**
///
/// `mesh_bases` ＝ `(space_id, "http://<窗口实际绑上的地址>")`（由 `mesh::announced_base` 把关）。
/// 两条语义要说清，否则会被读歪：
/// 1. **字段没变、语义变宽**：甲-1 的 `hub_base` 是"本网段的服务端在 `<base>`，它服务这些空间"；
///    丙 里同一格读作"**你可以直接来拉我**，我在 `<base>`"（简报 §13 ③-b-1 已经把同一格读成"谁可以被直接拉"）。
/// 2. **网格只覆盖 `hub_base`，不覆盖"该不该发言"**：发言的判据仍然是"这个空间有东西可说"——
///    甲是"绑了服务端"，丙是"开了网格"（见下面的 `or` 那一支）。**一个没有任何服务端、
///    只开了网格的空间**正是靠这一支才露面的（这就是"不装服务端也能同步"在发现层这一格的样子）。
pub fn announces_for_with_mesh(
    local_device_id: &str,
    device_name: &str,
    short_id: &str,
    profiles: &[(String, String, String)],
    mesh_bases: &[(String, String)],
) -> Vec<lan::LanAnnounce> {
    let dev = local_device_id.trim();
    // ⚠️ 没有设备身份 ⇒ **一条都不发**：`decode_announce` 会以 `NoDeviceId` 丢掉它，
    // 发出去只是往网段里灌噪音（产出的东西必须是自己也会收下的那种，见 `lan::tests` 判据 ⑫）。
    if dev.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (space_id, server_url, _) in profiles {
        let space = space_id.trim();
        let url = server_url.trim();
        // 只填了地址还没选空间 ⇒ 不发言（与 `bound_profile_count` 同一把尺：算不算绑上）。
        // ★ 丙-③-b-2b：**例外是"这个空间开了网格"** —— 那种情况下本来就不需要服务端地址
        //   （宣告的是我自己的窗口），它正是靠这一支才在网段里露面的。
        let mesh_base = mesh_bases.iter().find(|(s, _)| s.trim() == space).map(|(_, b)| b.trim());
        if !is_fully_bound(space_id, server_url) && mesh_base.is_none() {
            continue;
        }
        let mut a = lan::announce_for_own_hub(dev, device_name, short_id, url, space)
            .unwrap_or_else(|| lan::LanAnnounce {
                v: lan::WIRE_VERSION,
                device_id: dev.to_string(),
                device_name: device_name.trim().to_string(),
                // ⭐ 08-b②：那一格**同样显式给**（这个兜底分支也是产出点 ✓）
                short_id: short_id.trim().to_string(),
                hub_base: None,
                hub_spaces: Vec::new(),
                // ★ 存在声明也带指纹（owner 2026-09-25 拍板，B 片施工单 §8.3）：那台设备可能
                //   **没资格代言**（`hub_base: None`），而 `fp` 留空会让它在"谁在说话"这件事上
                //   完全隐形 —— 掉包判据要看的就是这个。
                fp: dev.to_string(),
            });
        // 网格开着 ⇒ **覆盖**成我自己的窗口地址（字段没变、语义变宽，见函数头口径 1）。
        // ⚠️ 覆盖之后 `hub_base` **一定有值**，"不代言"那一支（`hub_base: None`）在这里不成立。
        if let Some(base) = mesh_base.filter(|b| !b.is_empty()) {
            a.hub_base = Some(base.to_string());
        }
        a.hub_spaces =
            if a.hub_base.is_some() { vec![space.to_string()] } else { Vec::new() };
        out.push(a);
    }
    out
}

/// ★ 丙-③-b-2b：这一轮**要不要开发现层** —— 绑了同步（甲）**或**开了网格（丙）。
///
/// ⚠️ 为什么必须加这一支：发现层的开关原来只看"绑了同步的空间数"，
/// 而**"只开网格、不绑服务端"**恰恰是丙 要支持的那种配置 ⇒ 不加这一支，
/// 那台设备**既不听也不喊**，网格永远找不到它（而每一片单测都照绿）。
pub fn should_run_discovery(profiles: &[(String, String, String)], meshed_spaces: &[String]) -> bool {
    should_enable(bound_profile_count(profiles)) || !meshed_spaces.is_empty()
}

// ── 接线（甲-1 接线第 1 件）：真循环 ─────────────────────────────────────────────────────

/// ★ **启动监听 ＋ 广播**（施工单 §7 第 1 件）。**幂等**：同一个进程起过一次就直接返回。
///
/// ⚠️ **不在调用线程上绑 socket**：`bind_listener` 走一次 `spawn` 在 Tauri 的 tokio 运行时里
/// 完成（本函数**不 `block_on`**）—— 生产那条路是 Tauri `setup`（主线程、窗口还没起），
/// 在那里等一次 UDP 绑定属于"能用但没必要"，而且运行时的初始化时序不由这层保证。
/// 代价是：绑不上时**这里返回不了错**，只能打一行日志。这是**故意**的取舍 ——
/// 发现层是加分项，它起不来时 `resolve_base` 的回落口径让同步照旧（与今天逐字节相同），
/// 所以"起不来"不需要打断调用方（连 `setup` 也不该为它失败）。
///
/// - 每 [`RECV_SLICE_MS`] 回一次头 ⇒ 重读一次"绑了同步的空间数"（用户改配置不必重启进程）：
///   **绑没了就关掉开关**（删掉同步配置之后我们不该继续在网络里发声）。
/// - 关掉开关时**照旧收报入库**（`observe` 不过问开关）：再打开时不必重新等一整轮。
///
/// ⚠️ `device_id` 只在**第一次**取到（`LanState::global` 是 `OnceLock`）：取不到（老库）⇒
/// 用空 id 起（那时 `announces_for` 会一条都不发，别人也看不见我们 —— 这是对的）。
pub fn start(app: tauri::AppHandle) -> Result<(), String> {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.get().is_some() {
        return Ok(());
    }
    let device_id = {
        let db = app.state::<Db>();
        let c = db.0.lock().unwrap_or_else(|e| e.into_inner());
        crate::sync::device_id(&c).unwrap_or_default()
    };
    let device_name = {
        let db = app.state::<Db>();
        let c = db.0.lock().unwrap_or_else(|e| e.into_inner());
        local_device_name(&c)
    };
    let _ = STARTED.set(());
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        // ⚠️ **2026-10-04 改**：原先这里是"绑一次，绑不上就 `return`" ✗ ——
        //    ⭐ 而 `start()` 自身有 `OnceLock` 幂等 ⇒ ⭐ **首次失败之后这次会话永久没有发现层** ✓
        //    （⭐ 即使占用者（多半是"上一个实例还没退干净"）两秒后就退出了 ✓）。
        //    真机读数：本机 12 天里 10048 出现过 **9 次**，全是偶发（⭐ 端口随时能绑上 ✓）。
        //    ⇒ ⭐ 现在走 `bind_listener_with_retry`：**退避重试到绑上为止** ✓（1s→2s→…→30s 封顶 ✓）。
        //    ⚠️ 它**不会返回错误** ✓ ⇒ 下面那句"没得听也没得喊"的旧注释不再成立 ✓。
        let sock = lan::bind_listener_with_retry(lan::LAN_PORT).await;
        // ⚠️ 这里**不再**预先把目标算死（原来是这样）——目标要每一轮带上"已经认识的对端"，
        //    见下面 ③ 里 `lan::announce_targets` 那段注释（真机抓到的单向发现）。
        let state = LanState::global(&device_id);
        let mut last_announce_ms: i64 = 0;
    // ⭐ **task-12**：后台那一轮的**上一次跑的时刻** —— ⭐ 起算值刻意**不是 0** ✗：
    //   真机日志显示"启动后 3 秒就跑第一轮 ⇒ 候选 0（对端公告 27 秒后才到）⇒ 白跑一次 ✓"
    //   ⇒ 从 `background_round_initial_last()` 起算 ⇒ 第一轮落在**启动后约 45 秒** ✓。
    let mut last_bg_round_ms: i64 = background_round_initial_last(crate::db::now_ms());
        // ⭐ **2026-10-09（task-8）**：本机**在用**哪些空间（解析后 ✓）—— 只为**日志**里
        //   「这条公告与本机空间匹不匹配」那一句判定 ✓（⛔ 不参与任何路由决策 ✗）。
        //   ⚠️ 先取一次再进循环：否则第一片收到的公告会报"本机还没有可匹配的空间"（假读数 ✗）。
        let mut own_spaces: Vec<String> = {
            let profiles0 = bound_profiles(&app2);
            let db = app2.state::<Db>();
            let c = db.0.lock().unwrap_or_else(|e| e.into_inner());
            let mut v: Vec<String> = Vec::new();
            for (s, _, ws) in &profiles0 {
                let served = window_serve_space(&c, s, ws);
                if served.trim().is_empty() {
                    continue;
                }
                if settings_for_profile(&c, s, ws).bind.is_some() && !v.contains(&served) {
                    v.push(served);
                }
            }
            v
        };
        loop {
            let now = crate::db::now_ms();
            // ① 收（有超时 ⇒ "网段里没人说话"时循环照常推进，广播与腾表不会被卡住）。
            //    ⚠️ 收报走 `recv_into_within` ⇒ **解码只有一处**（`record_datagram`）。
            // ⭐ **2026-10-09（task-8）**：⭐ **四种结果各自打一行** ✓ —— 真机上「发了没」「收了没」
            //   「收到了为什么没用上」**除了日志没有别的观测面**（`47821` 被应用独占 ⇒ 外部绑不上 ✗）。
            //   口径：⭐ 收到并入库 ⇒ 说清来源/对端/它代言的空间/**与本机匹不匹配** ✓；
            //        收到但没进表（自己的回环 / 坏报文 / 超长）⇒ ⭐ **必须说出原因** ✓；
            //        这一片什么都没收到 ⇒ ⛔ **不打日志** ✗（每 1s 一次，打就是刷屏 ✓）。
            match lan::recv_into_within(&sock, state, RECV_SLICE_MS).await {
                Ok(lan::RecvOutcome::Peer(p)) => {
                    // ⭐ **task-12（Lead 拍）**：⭐ **收到公告 ⇒ 这一档有戏** ✓ ⇒ 把"空转连击"清零 ✓
                    //   （"一旦候选 ≥1 或收到过公告 ⇒ 恢复常态" ✓）。
                    BACKGROUND_EMPTY_STREAK.store(0, Ordering::SeqCst);
                    BACKGROUND_HEARD_TOTAL.fetch_add(1, Ordering::SeqCst);
                    eprintln!("{}", lan::announce_recv_line(&p, &own_spaces));
                }
                Ok(lan::RecvOutcome::OwnAnnounce { from }) => {
                    eprintln!(
                        "{}",
                        lan::announce_drop_line(&from, "这是**我自己**的公告（回环回来的）⇒ 有意丢弃")
                    );
                }
                Ok(lan::RecvOutcome::Rejected { from, reason }) => {
                    eprintln!("{}", lan::announce_drop_line(&from, &reason));
                }
                // 这一片没人说话 —— 正常，不刷屏 ✓
                Ok(lan::RecvOutcome::Nothing) => {}
                Err(e) => eprintln!("[mesh] 收公告出错：{e}"),
            }
            // ② 按需启用（每轮重读：绑了同步才发言，见口径 2）。
            //    ⚠️ 判别式走 `should_enable(bound_profile_count(..))` —— 与判据用的是**同一把尺**
            //    （不是 `profiles.len()`）：只填了地址还没选空间的行**不许**让我们开始广播。
            let profiles = bound_profiles(&app2);
            // ★ 丙-③-b-2b：先看哪几个空间开了网格 ⇒ ① 把窗口确保跑起来 ② 拿**实际绑上的地址**
            //   当公告基址。⚠️ 窗口起不来的那一个**不宣告**（宁可这一轮不露面，也不报一个拉不到的地址）。
            // ⚠️ 发现层开关用的是 `meshed`（**配了**网格的空间），不是 `mesh_bases`（**宣告得出去**的）：
            //    绑在回环上的那台宣告不出去，但它**照样要听**（它是客户端那一侧，要能拉别人）。
            let mesh_cfgs: Vec<(String, String, crate::mesh::MeshSettings)> = {
                let db = app2.state::<Db>();
                let c = db.0.lock().unwrap_or_else(|e| e.into_inner());
                profiles
                    // ⚠️ 两个 id 都要留着：`space` 是对暗号（公告里报的就是它），`ws` 才是**库文件名**
                    //    —— 2026-09-26 真机修（把远端 id 当库名 ⇒ 窗口服务一个新建的空库）。
                    .iter()
                    .map(|(s, _, ws)| (window_serve_space(&c, s, ws), ws.clone(), settings_for_profile(&c, s, ws)))
                    // ⭐ **2026-10-08（第三笔）**：**没暗号的行不许进开窗名单** ✗ —— 它的"服务空间"是 `''` ✓，
                    //   而 `''` 会去读 **`mesh_bind:` 那个空键**（写入路径**永远写不出来** ✓ ⇒ 只可能是更早版本残留 ✓）
                    //   ⇒ 它就在 `served` 里留一个**空项** ✓：面板/日志会显示
                    //   「这一扇门服务 2 个空间：**、**123456789Ok,./」✗（owner 2026-10-08 截图逐字 ✓，本机日志同形 ✓）。
                    //   ⚠️ 这条红读数＝**截图与日志那两行** ✓；修法＝**按"服务空间非空"过滤** ✓。
                    .filter(|(space, _, cfg)| !space.trim().is_empty() && cfg.bind.is_some())
                    .collect()
            };
            let meshed: Vec<String> = mesh_cfgs.iter().map(|(s, _, _)| s.clone()).collect();
            // ⭐ 2026-10-09（task-8）：日志那一句「匹不匹配」用的就是这份（去重 ✓、与网格**同一把尺** ✓）。
            own_spaces = {
                let mut v: Vec<String> = Vec::new();
                for s in &meshed {
                    if !v.contains(s) {
                        v.push(s.clone());
                    }
                }
                v
            };
            let mut mesh_bases: Vec<(String, String)> = Vec::new();
            // ⭐ **U8（2026-10-01）：一次开窗，而不是"逐空间开"** ——
            //   把配了地址的那些空间**按绑定分组** ⇒ **一个绑定只调一次** ✓
            //   （同一绑定的空间**共用一扇门** ✓；矩阵 U8-① 的判据就是"三次 ⇒ 同一个地址"）。
            //
            //   ⭐ **U11（2026-10-02，owner 选 A「门只认卡」）之后，口令**不再是窗口级的授权因素** ✓
            //      ⇒ 原来那段"口令取哪一份"（§7-R3）**随之退役** ✗ —— 门的授权只有**卡表** ✓
            //      （`mesh_paired_devices` 的 `secret_sha256` ✓）。⚠️ 旧 `mesh_token:<space>` KV
            //      **保留可读**（不静默删 ✓）但**不再作任何凭证** ✗。
            //   ⚠️ 用 **BTreeMap**（键有序）⇒ 同一组网卡/同一组配置**每次跑出来的顺序一样** ✓
            //      （HashMap 的遍历顺序不定 ⇒ 判据会 flaky ✗）。
            let mut by_bind: std::collections::BTreeMap<String, Vec<(String, String)>> =
                std::collections::BTreeMap::new();
            for (space, ws, cfg) in &mesh_cfgs {
                let Some(bind) = cfg.bind.as_deref().map(str::trim).filter(|b| !b.is_empty()) else {
                    continue;
                };
                by_bind
                    .entry(bind.to_string())
                    .or_default()
                    .push((ws.clone(), space.clone()));
            }
            for (bind, pairs) in &by_bind {
                // ⚠️ 取不到 app data 目录 ⇒ **如实说、这一轮不开窗**（⛔ 不静默跳过 ✗）
                let Some(mesh_dir) = crate::db::app_data_dir_ref() else {
                    eprintln!("[mesh] 取不到 app data 目录 ⇒ 绑定 {bind} 这一轮不开窗（不是「没有空间」，是读不到目录）");
                    continue;
                };
                match crate::mesh::ensure_window(pairs, &device_id, bind, mesh_dir) {
                    Ok(Some(addr)) => match crate::mesh::announced_base(addr) {
                        Some(base) => {
                            // ⭐ 一扇门服务多个空间 ⇒ **每个空间都记一条基址**（公告是按空间发的 ✓）
                            for (_, space) in pairs {
                                mesh_bases.push((space.clone(), base.clone()));
                            }
                        }
                        None => eprintln!(
                            "[mesh] 绑定 {bind} 的窗口在 {addr}（回环 / 端口 0）⇒ **不宣告**：别人拉不到，报出去只会往网段里灌噪音"
                        ),
                    },
                    Ok(None) => {}
                    Err(e) => eprintln!("[mesh] 绑定 {bind} 的窗口起不来（它名下这些空间这一轮都不宣告）：{e}"),
                }
            }
            state.set_enabled(should_run_discovery(&profiles, &meshed));
            // ③ 到点就喊一轮。
            if state.is_enabled() && announce_due(last_announce_ms, now, ANNOUNCE_INTERVAL_MS) {
                // ★★ 2026-09-26（真机抓到的**单向发现**）：目标**每一轮重算**，而且要带上
                //    **已经认识的对端地址**（单播）。理由见 `lan::announce_targets` 的头注：
                //    热点主机那条 `255.255.255.255` 按默认路由走**蜂窝** ⇒ 底下的客户端永远收不到；
                //    单播那一条把反方向补回来（客户端先被主机听见 ⇒ 主机直接发回给它）。
                // ⚠️ 以前这里是循环外算一次的 `default_targets` ⇒ 表里就算有对端也发不到它们。
                let targets = lan::announce_targets(lan::LAN_PORT, &state.peers(now));
                // ⭐ **2026-10-09（task-8）**：走**唯一入口** `announces_for_this_round` ✓ ——
                //    它在发之前把 `space_id` 换成**解析后的空间**（个人空间 ⇒ 配对暗号 ✓）。
                //    ⛔ 不要再退回"把 `profiles` 直接喂给 `announces_for_with_mesh`" ✗
                //    （那就是今天这条断点：`''` 与暗号**两把尺不同名** ⇒ 一条公告都发不出去 ✓）。
                // ⭐ **08-b②（合 `origin/dev`）**：本机短标识**在唯一入口里读**（一轮一次 ✓）——
                //    ⛔ 别挪回这里当"调用点自己读" ✗：`mesh.rs` 既有 4 参调用点、又有一条
                //    **源码级判据**盯着这一行的文本（见 `mesh.rs::…` 那条）⇒ 两边会打架 ✓。
                //    ⚠️ 锁只在这一个小块里拿（不在 `.await` 上跨着 ✓）：算完就把清单移出去发。
                let announced = {
                    let db = app2.state::<Db>();
                    let c = db.0.lock().unwrap_or_else(|e| e.into_inner());
                    announces_for_this_round(&c, &device_id, &device_name, &profiles, &mesh_bases)
                };
                for a in announced {
                    // ⭐ **2026-10-09（task-8）**：**每一轮公告都留一行读数** ✓ ——
                    // "发出去几条 / 目标长什么样 / **哪一条失败了、为什么**" 以前**完全不可见** ✗
                    // （`announce_once` 只留最后一条错误、且只在**全部**失败时才报 ⇒ 部分失败静默 ✗）。
                    match lan::announce_once(&sock, &targets, &a).await {
                        Ok(o) => eprintln!(
                            "{}",
                            lan::announce_send_line(&o, a.hub_spaces.first().map(String::as_str).unwrap_or(""))
                        ),
                        Err(e) => eprintln!("[mesh] 公告一条都没发出去：{e}"),
                    }
                }
                // ⚠️ **不管发出去几条都记时刻**：一条没发出去只说明"这个网段的广播被禁了"
                //    （受限网络），每 1s 重试一次等于自己打自己 ⇒ 到点才试下一轮。
                last_announce_ms = now;
            }
            // ⭐⭐ **task-12（owner 拍 C）**：**后台自主节拍** —— 不靠界面也跑一轮 ✓（每 ≥5 分钟 ✓）。
            //   ⚠️ 三条边界：① 只在**真的开了网格**的空间上跑 ✓（`meshed` ✓ ⇒ ⛔ 没配的一个字节都不动 ✗）；
            //   ② **`spawn`**（⛔ 不阻塞这条每秒的发现循环 ✗ —— 一轮 HTTP 可能十几秒 ✓）；
            //   ③ **同时只跑一轮** ✓（`BACKGROUND_IN_FLIGHT` ＋ RAII 归还 ✓，上一轮没完就跳过 ✓）。
            if background_round_due(
                last_bg_round_ms,
                now,
                meshed.len(),
                BACKGROUND_EMPTY_STREAK.load(Ordering::SeqCst),
            ) {
                last_bg_round_ms = now;
                match spawn_background_round(&app2, &device_id, &mesh_cfgs, &state.peers(now)) {
                    Some(what) => eprintln!("[{}] [mesh] 后台一轮：开跑（{what}）", lan::log_stamp()),
                    None => eprintln!(
                        "[{}] [mesh] 后台一轮：**跳过** —— 上一轮还没跑完（5 分钟后再来 ✓）",
                        lan::log_stamp()
                    ),
                }
            }
            // ④ 腾过期行（表不是只增不减的；`lan::PEER_TTL_MS` 是唯一的判死依据）。
            if state.is_enabled() {
                state.sweep(now);
            }
        }
    });
    Ok(())
}

/// `sync_state` 里**用户自己设的**本机名（规格 `merge-semantics.md:150` 逐字
/// 「**名字是用户自己起的**」✓）—— 键与 `device_id` 同一个表 ✓（`crate::sync::get_meta_state` ✓）。
///
/// ⚠️ 空串/纯空白**不算设过** ✓（否则用户清空一次就再也回不到主机名 ✗）。
fn stored_device_name(c: &rusqlite::Connection) -> Option<String> {
    crate::sync::get_meta_state(c, KEY_DEVICE_NAME)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// ⭐ **本机名的回退链**（2026-10-10；纯函数 ⇒ 可单测 ✓）：
/// ① **用户设的名** ⇒ ② 没有就**主机名** ⇒ ③ 仍然空 ⇒ **一个非空的如实默认** ✓。
///
/// ⛔ 三档都**不许**回落成 `device_id`（或它的前几位／哈希）✗ —— 规格逐字禁 ✓
/// （同一条也写在 `sync.rs` 的 `NearbyPeer::device_name` 注释里 ✓）；
/// ⛔ 也**不许**返回空串 ✗ —— 修前 `host_name()` 拿不到环境变量就返回空 ✗，
/// 于是对端只能显示一个空白名字 ✗（`lan.rs` 那侧 `trim()` 之后确实会判成"没报名字" ✓）。
fn resolve_local_name(stored: Option<&str>, host: &str) -> String {
    if let Some(n) = stored.map(str::trim).filter(|n| !n.is_empty()) {
        return n.to_string();
    }
    let h = host.trim();
    if !h.is_empty() {
        return h.to_string();
    }
    DEFAULT_DEVICE_NAME.to_string()
}

/// 本机名（公告里的 `device_name`，只给人看 ✓）＝ 回退链的**取数入口** ✓。
fn local_device_name(c: &rusqlite::Connection) -> String {
    resolve_local_name(stored_device_name(c).as_deref(), &host_name())
}

/// `sync_state` 里那个键 ✓（与 `KEY_DEVICE_ID` 同在 `crate::sync` 的口径下 ✓）。
const KEY_DEVICE_NAME: &str = "device_name";

/// 主机名与用户设置都拿不到时的**如实默认** ✓（⛔ 不是编造的身份 ✗；也不含任何码 ✓）。
const DEFAULT_DEVICE_NAME: &str = "未命名设备";

/// 主机名（公告里的第三个回退档，只给人看）：拿不到就留空，**不编**一个假的
/// （⇒ 交给 [`resolve_local_name`] 的第三档 ✓）。
fn host_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default()
}

/// 库里"绑了同步的空间"：`(space_id, server_url, ws_id)`，**只算活工作空间**。
///
/// ⚠️ 口径与 `sync::claim_config` 对齐（只填地址没选空间的行不算绑上），
/// 判别式在 [`bound_profile_count`] 里（有判据）；这里只负责把行取出来。
fn bound_profiles(app: &tauri::AppHandle) -> Vec<(String, String, String)> {
    let db = app.state::<Db>();
    let c = db.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = match c.prepare(
        "SELECT p.space_id, p.server_url, p.ws_id FROM sync_profiles p
         WHERE EXISTS (
             SELECT 1 FROM meta.workspaces w
             WHERE w.id = p.ws_id AND w.deleted_at IS NULL
         )",
    ) {
        Ok(s) => s,
        // 读不了库（老库/锁坏）⇒ **不发言**：发现层不许因为库异常把进程搞出声。
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)));
    match rows {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

/// ⭐ **2026-10-08**：面板/发现层**读**网格设置时走的口径。
///
/// ⚠️ **来由（owner 实测截图逐字）**：面板显示「设备直连 **关**」＋「口令：未设 ⚠️」＋三个输入框**全空** ✗，
///   而同一时刻 `8788` **正在听** ✓、`UDP 47821` 在 ✓、KV 里 `mesh_bind:<配对暗号>='0.0.0.0:8788'` ✓
///   ⇒ **面板是"读错了"，不是"没配上"** ✗。
///   真因：这里原来直接 `settings(&c, s)`，而 `s` 是 `sync_profiles.space_id` ✓ ——
///   **个人空间那一列就是空串** ✗ ⇒ 读的是 `mesh_bind:`（空键）⇒ **一个字节都读不到** ✗；
///   而值存在 `mesh_bind:<配对暗号>` ✓（写路径走 `sync::mesh_scope` 会回落到 `mesh_room` ✓，我 R146 修的就是那条 ✓）。
/// ⇒ 后果：面板看不见"开着" ⇒ **「附近设备」那一块不渲染** ⇒ **配对入口进不去** ✗（挡住 R1 ✓）。
///
/// ⚠️ **只动"读"** ✗：`s`（原始 `space_id`）仍照旧用于**公告** —— ⛔ 不动线上报文形状 ✗。
/// ⭐ **2026-10-08**：**口径解析**（只这一处 ✓）—— 个人空间（`space_id` 空）用用户填的「配对暗号」`mesh_room` ✓；
/// 团队空间用 `space_id` ✓；解析不出来 ⇒ **保持旧口径**回落到 `space_id` ✓。
///
/// ⚠️ 抽出来是为了**三个调用点共用**（发现层 `settings_for_profile` ✓、面板读数 `sync::mesh_config_state_at` ✓）
/// —— 今天这条 bug 的本质就是"读写各弹各的调"✗：写路径走 `sync::mesh_scope` ✓、读路径三处各写一遍 ✗。
pub(crate) fn resolved_space(c: &rusqlite::Connection, space_id: &str, ws_id: &str) -> String {
    crate::sync::mesh_scope_at(c, Some(ws_id))
        .map(|x| x.space)
        .unwrap_or_else(|_| space_id.to_string())
}

fn settings_for_profile(
    c: &rusqlite::Connection,
    space_id: &str,
    ws_id: &str,
) -> crate::mesh::MeshSettings {
    // ⭐ **修（2026-10-08）**：与**写路径同一口径**（`resolved_space` ✓）。
    // ⚠️ 解析不出来（个人空间没填暗号 / 库里没有档案行）⇒ **保持旧口径**回落到 `space_id` ✓
    //   （同模块判据 ② 把这条**钉住** ✓；它顺带暴露的"空键假显示为开着"属另一笔 ✓ 已记台账 ✓）。
    let space = resolved_space(c, space_id, ws_id);
    crate::mesh::settings(c, &space)
}

/// ⭐ **2026-10-08 第二笔**：**窗口该服务/宣告哪个空间** —— 与写路径（`sync::mesh_scope`）同一条口径 ✓：
/// 个人空间（`space_id` 空）⇒ 用户填的「配对暗号」✓；团队空间 ⇒ `space_id` ✓。
///
/// ⚠️ 来由（app 日志逐字）：`网格窗口已启动：0.0.0.0:8788 ｜ 服务 1 个空间：` ✗ —— **空间名是空的** ✓
/// ⇒ 对端在发现层匹配不上 ⇒ 面板写「附近的设备里暂时没有服务这个空间的设备」✗ ⇒ **一轮都跑不起来** ✓
/// （连带读数：`last_pushed_seq = last_pulled_seq = 0` ✗、`changes` 64 行一条没发 ✗、`meta` 里没有 `mesh_cursor:*` ✗）。
/// ⚠️ **同一族的另一半**：配对采纳会 `mesh::add_paired(scope.space＝暗号)`，而门服务 `''` ✗ ⇒ **找不到那扇门**
/// ⇒ 卡片进不了内存卡表 ⇒ 现象＝「配对显示成功、对端照样 401」✗ ⇒ 本笔把**根**一起修掉 ✓。
pub(crate) fn window_serve_space(c: &rusqlite::Connection, space_id: &str, ws_id: &str) -> String {
    // ⭐ **修**：与写路径同口径 —— 个人空间（`space_id` 空）⇒ 配对暗号 ✓（`resolved_space` 是唯一那处解析 ✓）。
    // ⚠️ 解析不出来（没填暗号 / 没有档案行）⇒ **保持旧口径**回落 ✓（判据 ③ 把这条钉住 ✓）。
    resolved_space(c, space_id, ws_id)
}

#[cfg(test)]
mod mesh_serve_space_tests {
    use super::*;

    fn fixture() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
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
             INSERT INTO meta.sync_state (key, value) VALUES ('device_id', 'dev-a');",
        )
        .unwrap();
        c
    }

    /// ⭐ 本笔判据：个人空间（`space_id` 空）＋ 暗号有值 ⇒ **窗口报的空间必须是暗号** ✓。
    /// ⚠️ 未修时得到 `''` ✗ ⇒ **必红** ✓（红读数＝日志里「服务 1 个空间：（空）」✗）。
    #[test]
    fn a_personal_space_serves_its_room_not_an_empty_name() {
        let c = fixture();
        c.execute(
            "INSERT INTO meta.sync_profiles (ws_id, mesh_room) VALUES ('ws-personal', 'room-123')",
            [],
        )
        .unwrap();
        assert_eq!(
            window_serve_space(&c, "", "ws-personal"),
            "room-123",
            "个人空间没有 space_id ⇒ 窗口/公告必须报**配对暗号**（报空串 ⇒ 对端永远匹配不上 ✗）"
        );
    }

    /// ⭐⭐ **合 `origin/dev` 的 08-b②**：短标识**真的进公告** ✓ —— 而"拿不到"⇒ **如实空串** ✓。
    ///
    /// ⚠️ 三种情形都要判，⛔ 少一种就会漏掉一种坏法：
    /// · ① 有 ⇒ **逐字进公告** ✓（只判"能拿到"⇒ 看不出"`short_id` 压根没进公告"✗：那样每台设备都报空，
    ///   对端全都显示「对方没报短标识」✓）；
    /// · ② **没有** ⇒ `local_short_id` **当场生成并落库**（⭐ dev 的设计：`short_id_or_init` 自愈 ✓）
    ///   ⇒ 公告里是一个**合法短标识**、⭐ **不是 `device_id` 前几位** ✗、⭐ 而且**第二次是同一个**（落了库 ✓）；
    /// · ③ **读不到**（库坏了／表没了）⇒ ⭐ **如实的空串** ✓（⛔ 不编一个、⛔ 不回落 `device_id` ✗）。
    ///
    /// ⚠️ 红读数（定向变异 β ＝ 入口里把 `&short_id` 恒写成 `""`）⇒ ① 红 ✓；
    /// ⚠️ 红读数（定向变异 γ ＝ "拿不到"回落成 `device_id`）⇒ ③ 红 ✓。
    #[test]
    fn the_short_id_really_lands_in_the_announce_and_missing_stays_honestly_empty() {
        let profiles = vec![(String::new(), String::new(), "ws-personal".to_string())];
        let bases = vec![("room-123".to_string(), "http://192.168.1.5:8788".to_string())];
        let with_room = |c: &rusqlite::Connection| {
            c.execute(
                "INSERT INTO meta.sync_profiles (ws_id, mesh_room) VALUES ('ws-personal', 'room-123')",
                [],
            )
            .unwrap();
        };

        // ① 有短标识 ⇒ 逐字进公告（⭐ 它就是要给对端看的那一格）
        // ⚠️ 值必须是**合法**短标识：`SHORT_ID_ALPHABET` ＝ `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`
        //    （**没有 `0`／`1`／`I`／`O`** ✓）⇒ ⚠️ 拿 `"T3ST1"` 当夹具会被 `short_id_or_init`
        //    **判非法当场换掉**（⭐ 实得 `"Z8HMK"` ✗）—— ⭐ 这正是本条判据**要盯住**的行为 ✓。
        let c = fixture();
        with_room(&c);
        crate::sync::set_meta_state(&c, "short_id", "K7M2Q").unwrap();
        let got = announces_for_this_round(&c, "dev-a", "本机", &profiles, &bases);
        assert_eq!(got.len(), 1, "前提：开了网格的个人空间要发言（{got:#?}）");
        assert_eq!(
            got[0].short_id, "K7M2Q",
            "⭐ 短标识没进公告 ⇒ 对端全都显示「对方没报短标识」✗"
        );
        assert_ne!(got[0].short_id, got[0].device_id, "⛔ 不许回落成 device_id 前几位");

        // ② 没有 ⇒ 生成并落库（自愈 ✓）；第二次必须是同一个（落了库 ✓）
        let c2 = fixture();
        with_room(&c2);
        let first = announces_for_this_round(&c2, "dev-a", "本机", &profiles, &bases);
        assert_eq!(first.len(), 1);
        assert!(
            !first[0].short_id.is_empty() && first[0].short_id != "dev-a",
            "⭐ 没有短标识时应当**生成一个**（⛔ 不是空串、⛔ 不是 device_id）：得到 {:?}",
            first[0].short_id
        );
        assert_eq!(
            announces_for_this_round(&c2, "dev-a", "本机", &profiles, &bases)[0].short_id,
            first[0].short_id,
            "⭐ 第二次必须一样（说明**落库了** ⇒ 对端看到的是稳定的一个标识 ✓）"
        );

        // ③ 读不到（表没了）⇒ 如实空串 ✓（⛔ 不编、⛔ 不回落 device_id）
        let c3 = fixture();
        with_room(&c3);
        c3.execute_batch("DROP TABLE meta.sync_state;").unwrap();
        let got3 = announces_for_this_round(&c3, "dev-a", "本机", &profiles, &bases);
        assert_eq!(got3.len(), 1, "短标识读不到⛔ 不该连公告一起没了 ✓");
        assert_eq!(
            got3[0].short_id, "",
            "拿不到就得**如实说没有** ✓（⛔ 不许编一个 / ⛔ 不许回落 device_id）"
        );
        assert_ne!(got3[0].short_id, got3[0].device_id, "⛔ 更不许回落成 device_id");
    }

    /// 反向：团队空间照旧用 `space_id` ✓（不许串味 ✓）。
    #[test]
    fn a_team_space_still_serves_its_space_id() {
        let c = fixture();
        c.execute(
            "INSERT INTO meta.sync_profiles (ws_id, space_id, mesh_room) VALUES ('ws-personal', 'team-9', 'room-123')",
            [],
        )
        .unwrap();
        assert_eq!(window_serve_space(&c, "team-9", "ws-personal"), "team-9", "团队空间口径不变 ✓");
    }

    /// 反向：个人空间**没填暗号** ⇒ 保持旧口径（回落 `space_id`）✓（放宽 ≠ 乱认 ✓）。
    #[test]
    fn a_personal_space_without_a_room_keeps_the_old_value() {
        let c = fixture();
        c.execute(
            "INSERT INTO meta.sync_profiles (ws_id, mesh_room) VALUES ('ws-personal', '')",
            [],
        )
        .unwrap();
        assert_eq!(window_serve_space(&c, "", "ws-personal"), "", "没暗号 ⇒ 保持旧口径 ✓");
    }
}

#[cfg(test)]
mod mesh_read_scope_tests {
    use super::*;

    /// 自带夹具（与 `sync.rs` 的 R146 判据同一形状 ✓）：四张表够 `mesh_scope_at` 读 ✓。
    fn fixture() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
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
             INSERT INTO meta.sync_state (key, value) VALUES ('device_id', 'dev-a');",
        )
        .unwrap();
        c
    }

    /// ⭐ **本笔的判据**：个人空间（`space_id` 空）＋ 暗号有值 ＋ KV 按**暗号**存 ⇒
    ///   面板/发现层必须**读得到**那份设置 ✓。
    /// ⚠️ 未修时这里读到 `None` ✗ ⇒ **必红** ✓ —— 而那条红读数就是 owner 截图里的
    ///   「设备直连 **关** ＋ 口令：未设」✓（= 面板看不见已经在听的窗口 ✓）。
    #[test]
    fn a_personal_space_reads_the_settings_keyed_by_its_room() {
        let c = fixture();
        c.execute(
            "INSERT INTO meta.sync_profiles (ws_id, mesh_room) VALUES ('ws-personal', 'room-123')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO meta.sync_state (key, value) VALUES ('mesh_bind:room-123', '0.0.0.0:8788')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO meta.sync_state (key, value) VALUES ('mesh_token:room-123', 'k7Qm-2pRt')",
            [],
        )
        .unwrap();
        let st = settings_for_profile(&c, "", "ws-personal");
        assert_eq!(
            st.bind.as_deref(),
            Some("0.0.0.0:8788"),
            "个人空间的地址是按**配对暗号**存的 ⇒ 面板必须读得到（读不到就会显示『关』✗）"
        );
        assert_eq!(st.token.as_deref(), Some("k7Qm-2pRt"), "口令同理 ✓");
    }

    /// 反向①：**团队空间照旧按 `space_id` 读** ✓ —— 不许把暗号串到团队那条路上 ✓。
    #[test]
    fn a_team_space_still_reads_by_its_space_id() {
        let c = fixture();
        c.execute(
            "INSERT INTO meta.sync_profiles (ws_id, space_id, mesh_room) VALUES ('ws-personal', 'team-9', '')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO meta.sync_state (key, value) VALUES ('mesh_bind:team-9', '0.0.0.0:8788')",
            [],
        )
        .unwrap();
        let st = settings_for_profile(&c, "team-9", "ws-personal");
        assert_eq!(st.bind.as_deref(), Some("0.0.0.0:8788"), "团队空间口径不变 ✓");
    }

    /// 反向②：个人空间但**暗号也是空** ⇒ **保持旧口径**（回落到 `space_id` ＝ 空串）✓ ——
    ///   本笔**不顺手改**它 ✗，只把它**钉住**（免得哪天被无意改掉 ✓）。
    /// ⚠️ **已知遗留（记台账、不在本笔改 ✗）**：那个 `mesh_bind:`（空键）**写入路径永远写不出来**
    ///   （没暗号时 `mesh_set_config` 直接 `Err` ✓）⇒ 只可能是**更早版本的残留** ✓；
    ///   而它会让人一个"没配过的"个人空间**假显示为开着** ✗ —— 与"假显示为关"是同一族的另一半 ✓。
    #[test]
    fn a_personal_space_without_a_room_keeps_the_old_reading() {
        let c = fixture();
        c.execute(
            "INSERT INTO meta.sync_profiles (ws_id, mesh_room) VALUES ('ws-personal', '')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO meta.sync_state (key, value) VALUES ('mesh_bind:', '0.0.0.0:8788')",
            [],
        )
        .unwrap();
        let st = settings_for_profile(&c, "", "ws-personal");
        assert_eq!(
            st.bind.as_deref(),
            Some("0.0.0.0:8788"),
            "本笔只保证「个人空间＋有暗号」读得到；「没暗号」这条**保持旧口径**（遗留另记 ✓）"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lan::{LanAnnounce, WIRE_VERSION};

    fn peer_of(device: &str, base: &str, spaces: &[&str]) -> Peer {
        Peer {
            announce: LanAnnounce {
                v: WIRE_VERSION,
                device_id: device.to_string(),
                device_name: device.to_string(),
                short_id: "T3ST1".into(),
                hub_base: Some(base.to_string()),
                hub_spaces: spaces.iter().map(|s| s.to_string()).collect(),
                fp: "fp".into(),
            },
            addr: "192.168.1.9".into(),
            seen_at_ms: 1_000,
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // ⭐⭐ task-12（owner 拍 C：「后台每 5 分钟跑一次，打开面板时更勤」）
    //
    // 真机实锤（两条独立采样一致）：`mesh_sync_now` 是 `#[tauri::command]` ⇒ **只在面板那一页时才跑** ✗
    // —— stderr `[mesh]` **259 行**（发现层照常 ✓）而网格历史**停在面板关闭那一刻**（09:01:45 ✓）；
    // 把 app 从同步面板切走 ⇒ **8+ 分钟里一次 TCP 连接都没有** ✗。
    // ─────────────────────────────────────────────────────────────────────────────

    /// ⭐ **task-12（Lead 批）**：⭐ 「**候选 0**」与「**收到了公告但没进候选**」是**两件不同的事** ✗
    /// ⇒ 两个读数必须**都**落进库 ✓（⭐ 日志会被句柄弄丢 ✗ —— 真机上已经发生过一次 ✓）。
    /// ⚠️ 未修时（两个读数都不存在）**必红** ✓。
    #[test]
    fn a_background_round_records_both_what_it_saw_and_what_it_heard() {
        let rows = background_round_readings(0, 3);
        assert_eq!(rows.len(), 2, "两个读数都要 ✓（⭐ 少一个就又要猜 ✗）");
        let got: Vec<(&str, String)> = rows.into_iter().collect();
        assert_eq!(got[0], ("mesh_bg_last_candidates", "0".to_string()), "候选数要落库 ✓");
        assert_eq!(got[1], ("mesh_bg_last_heard", "3".to_string()), "收到的公告条数要落库 ✓");
        // ⭐ 就是这一格：⭐ 收到了 3 条公告、⭐ 却一台候选都没有 ⇒ ⭐ "看见了但对不上" ✓（不是"没看见"✗）
        assert_eq!(background_round_readings(2, 0)[0].1, "2", "看到了能拉的 ⇒ 候选数如实 ✓");
    }

    /// ⭐ **task-12 判据 a**：⭐ **不打开任何面板也要有轮次** ✓（可注入时钟 ✓）。
    /// ⚠️ 未修时（没有后台节拍）这里恒 `false` ⇒ **必红** ✓（红读数＝真机那条"面板一走就不跑"✓）。
    #[test]
    fn a_background_round_happens_without_any_panel() {
        // ① 从没跑过 ⇒ 该跑（`last <= 0` 那一支 ✓ —— 复用 `announce_due` 的同一口径 ✓）
        assert!(
            background_round_due(0, 1_000, 1, 0),
            "⛔ 没有后台节拍 ⇒ 关掉面板就一轮都不跑 ✗（真机实测：8+ 分钟零连接 ✓）"
        );
        // ② 到点 ⇒ 跑
        assert!(background_round_due(1_000, 1_000 + BACKGROUND_ROUND_MS, 1, 0), "到点必须跑 ✓");
        // ③ 没到点 ⇒ 不跑（⛔ 也不能退化成"每秒一次" ✗）
        assert!(!background_round_due(1_000, 1_000 + BACKGROUND_ROUND_MS - 1, 1, 0), "没到点不跑 ✓");
    }

    /// ⭐ **task-12（Lead 拍 B）**：⭐ **`候选 0` ⇒ 下次 < 5 分钟** ✓（"没找到对端"**不算**"跑过一轮" ✓）。
    /// ⚠️ 未修时（永远 5 分钟）这里必红 ✓ —— 真机日志就是它抓到的：启动后 3 秒那一轮 `候选 0`，
    /// 而下一次要等满 5 分钟 ✓。
    #[test]
    fn an_empty_background_round_is_retried_sooner_than_five_minutes() {
        assert_eq!(
            background_round_interval_ms(1),
            BACKGROUND_RETRY_MS,
            "⛔ 空手也要等满 5 分钟 ⇒ 对端 27 秒后才出现，白等一轮 ✗"
        );
        assert!(background_round_interval_ms(1) < BACKGROUND_ROUND_MS, "必须**短于**常态 ✓");
    }

    /// ⭐ **task-12（Lead 拍上限）**：⭐ **连续 5 次仍 `候选 0` ⇒ 退回 5 分钟** ✓
    /// —— ⛔ 别在"网段里根本没有对端"的地方每 60 秒空转一小时 ✗。
    #[test]
    fn a_long_empty_streak_gives_up_the_fast_retry() {
        assert_eq!(background_round_interval_ms(BACKGROUND_EMPTY_GIVE_UP), BACKGROUND_ROUND_MS);
        assert_eq!(background_round_interval_ms(BACKGROUND_EMPTY_GIVE_UP + 9), BACKGROUND_ROUND_MS);
        // ⭐ 反向：**上一轮找到了对端**（streak 0）⇒ 常态 5 分钟 ✓（⛔ 不许永久停在 60 秒 ✗）
        assert_eq!(background_round_interval_ms(0), BACKGROUND_ROUND_MS, "找到对端 ⇒ 回到常态 ✓");
    }

    /// ⭐ **task-12**：⭐ **启动后第一轮不是"立刻"** ✓ —— 实测启动后 3 秒跑 ⇒ `候选 0`（对端公告 27 秒后才到）
    /// ⇒ 白跑一次 ✓。修法：起算值让第一轮落在**启动后约 45 秒** ✓。
    #[test]
    fn the_first_background_round_waits_for_the_discovery_layer() {
        let t0 = 1_000_000i64;
        let last = background_round_initial_last(t0);
        assert!(
            !background_round_due(last, t0, 1, 0),
            "⛔ 启动**那一瞬间**就跑 ⇒ 必然 `候选 0`（真机日志逐字 ✓）"
        );
        assert!(
            !background_round_due(last, t0 + BACKGROUND_WARMUP_MS - 1, 1, 0),
            "还没热够 ⇒ 再等等"
        );
        assert!(
            background_round_due(last, t0 + BACKGROUND_WARMUP_MS, 1, 0),
            "热够 45 秒 ⇒ 该跑了 ✓（对端的公告通常 ~30 秒内就到 ✓）"
        );
    }

    /// ⭐ **task-12 判据 c（反向）**：⭐ **一个网格空间都没有 ⇒ 后台这一轮不许跑** ✗ ——
    /// "没配 ⇒ 一个字节都不动"这条口径**一个字不变** ✓。
    #[test]
    fn a_background_round_never_runs_when_no_space_has_the_mesh() {
        assert!(!background_round_due(0, 1_000_000, 0, 0), "⭐ 没配网格 ⇒ 后台**不许**碰任何东西 ✗");
        assert!(!background_round_due(0, i64::MAX, 0, 0), "⛔ 时间再久也一样：没有空间就没有轮次 ✗");
        // ⚠️ 连"空手在重试"也一样不跑 ✓（⭐ 否则"没配 + 刚空手"会绕开这一关 ✗）
        assert!(!background_round_due(0, i64::MAX, 0, 1), "空手重试那支也不许碰没配的空间 ✗");
    }

    /// 判据 ①：**默认是关的**（新进程不会一上来就往网段里发声）。
    #[test]
    fn a_fresh_state_starts_disabled() {
        let st = LanState::new("dev-me".into());
        assert!(!st.is_enabled());
        assert!(st.peers(1_000).is_empty());
    }

    /// ★ 判据 ②（口径 3）：**关掉＝看不见** —— 表里明明有对端，未启用也必须返回空。
    /// 这条是承重的：它让"没启用"与"网段里没人"在调用方眼里**同一种处境**
    /// （地址解析于是自然回落到配置地址，不需要调用方再判一次开关）。
    #[test]
    fn disabled_means_invisible_even_when_the_table_has_peers() {
        let st = LanState::new("dev-me".into());
        assert!(st.observe(peer_of("dev-a", "http://192.168.1.5:8787", &["sp-1"])));
        // 关着：看不见，但**表里确实有**（诊断接口看得见）
        assert!(st.peers(1_000).is_empty());
        assert_eq!(st.observed_all().len(), 1);
        // 打开：同一张表立刻可见
        st.set_enabled(true);
        assert_eq!(st.peers(1_000).len(), 1);
        assert_eq!(st.peers(1_000)[0].announce.device_id, "dev-a");
        // 再关：又看不见（且**没有清表** —— 只是不看）
        st.set_enabled(false);
        assert!(st.peers(1_000).is_empty());
        assert_eq!(st.observed_all().len(), 1);
    }

    /// 判据 ③：**自己的公告**即便在启用后也不许进"能用的对端"（`upsert` 的语义要穿透这一层）。
    #[test]
    fn my_own_announce_stays_out_even_when_enabled() {
        let st = LanState::new("dev-me".into());
        st.set_enabled(true);
        assert!(!st.observe(peer_of("dev-me", "http://192.168.1.5:8787", &["sp-1"])));
        assert!(st.peers(1_000).is_empty());
    }

    /// 判据 ⑤：**收报这一段只有一条路**（公告）—— 合法的入库并**原样还回来**，
    /// 不合法的**当场丢且不入表**（原因就是公告那一句）。
    ///
    /// ⚠️ 这条是 2026-09-29 owner 裁定 §14（撤掉邀请那套）之后**还原**出来的读数：
    /// `record_datagram` 回到"只走公告"，所以"坏报文报的是公告的原因"重新成为**唯一**行为
    /// （此前它被"两条线都不认时报更贴切的那句"分过一次流）。
    #[test]
    fn a_datagram_is_an_announce_or_nothing() {
        let st = LanState::new("dev-me".into());
        st.set_enabled(true);
        // ① 合法公告 ⇒ 收了、记了，且**还回来的是入库的那一条**
        let raw = crate::lan::encode_announce(&peer_of("dev-a", "http://192.168.1.5:8787", &["sp-1"]).announce)
            .unwrap();
        let got = st.record_datagram(&raw, "192.168.1.9", 1_000).unwrap().expect("合法公告要入库");
        assert_eq!(got.announce.device_id, "dev-a");
        assert_eq!(got.addr, "192.168.1.9", "来源地址取自收到的那个 ip");
        assert_eq!(st.observed_all().len(), 1);
        // ② 自己的公告（回环）⇒ `Ok(None)`（不是错误，也不入表）
        let own = crate::lan::encode_announce(&peer_of("dev-me", "http://192.168.1.4:8787", &["sp-1"]).announce)
            .unwrap();
        assert_eq!(st.record_datagram(&own, "192.168.1.4", 1_000).unwrap(), None);
        assert_eq!(st.observed_all().len(), 1, "自己的公告不许进表");
        // ③ 不合法 ⇒ 报**公告**那一句，且**一个字节都不入表**
        assert_eq!(
            st.record_datagram("{ 这不是 json", "192.168.1.9", 1_000).unwrap_err(),
            crate::lan::AnnounceReject::BadJson.reason(),
        );
        assert_eq!(st.observed_all().len(), 1);
    }

    /// 判据 ④（口径 2）：按需启用的判别式 —— **绑了同步才启用**；
    /// 没有绑定就**不在用户的网段里发声**（用户看不见，但那是隐私与噪音的两重错）。
    #[test]
    fn we_only_speak_up_when_some_space_is_actually_bound() {
        assert!(!should_enable(0));
        assert!(should_enable(1));
        assert!(should_enable(3));
    }

    /// 判据 ⑤：过期的对端会被腾掉（周期任务靠它，免得表只增不减）。
    #[test]
    fn sweeping_drops_peers_that_stopped_announcing() {
        let st = LanState::new("dev-me".into());
        st.observe(peer_of("dev-a", "http://192.168.1.5:8787", &["sp-1"]));
        st.set_enabled(true);
        assert_eq!(st.peers(1_000).len(), 1);
        let gone = st.sweep(crate::lan::PEER_TTL_MS + 2_000);
        assert_eq!(gone, 1);
        assert!(st.peers(crate::lan::PEER_TTL_MS + 2_000).is_empty());
    }

    // ---- 接线那一片（甲-1 第 1 件）：按需启用的上游 ＋ 广播的内容 ----

    fn profiles_of(rows: &[(&str, &str)]) -> Vec<(String, String, String)> {
        rows.iter()
            .map(|(space, url)| (space.to_string(), url.to_string(), "ws".to_string()))
            .collect()
    }

    // ---- 丙-③-b-2b：网格开着时，公告报的是**我自己的窗口** ----

    fn mesh_bases_of(rows: &[(&str, &str)]) -> Vec<(String, String)> {
        rows.iter().map(|(s, b)| (s.to_string(), b.to_string())).collect()
    }

    /// ★ 丙-③-b-2b：**只开网格、不绑服务端**的空间 —— 它照样要发言，而且报的是**我自己的窗口**。
    ///
    /// 咬人的地方：少了"网格也算有话可说"这一支 ⇒ 这种配置**既不听也不喊**
    /// （发现层不起、公告一条没有），网段里的别人**永远找不到它** —— 而每一片单测都照绿。
    /// 这就是"不装服务端也能同步"落在发现层这一格的样子。
    #[test]
    fn a_mesh_only_space_is_announced_and_opens_the_discovery_layer() {
        let profiles = profiles_of(&[("sp-1", "")]); // **没有**服务端地址
        assert!(!should_enable(bound_profile_count(&profiles)), "前提：按甲的口径它没绑");
        let bases = mesh_bases_of(&[("sp-1", "http://192.168.1.5:8788")]);

        assert!(should_run_discovery(&profiles, &["sp-1".to_string()]), "开了网格 ⇒ 发现层要起");
        let got = announces_for_with_mesh("dev-me", "本机", "T3ST1", &profiles, &bases);
        assert_eq!(got.len(), 1, "{got:#?}");
        assert_eq!(got[0].hub_base.as_deref(), Some("http://192.168.1.5:8788"));
        assert_eq!(got[0].hub_spaces, vec!["sp-1".to_string()]);
        assert_eq!(got[0].device_id, "dev-me");
    }

    /// ★ 网格开着 ⇒ 公告里的基址是**窗口**，不是配置的服务端（同一格在丙里的读法）。
    #[test]
    fn a_mesh_base_overrides_the_configured_server_in_the_announce() {
        let profiles = profiles_of(&[("sp-1", "https://s.example.com")]);
        let bases = mesh_bases_of(&[("sp-1", "http://10.0.0.7:9000")]);
        let got = announces_for_with_mesh("dev-me", "本机", "T3ST1", &profiles, &bases);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].hub_base.as_deref(), Some("http://10.0.0.7:9000"), "覆盖成我自己的窗口");
    }

    /// ★ 没开网格 ⇒ **两道口径都是老样子**（走的是**同一段代码**：`mesh_bases` 传空）。
    #[test]
    fn without_the_mesh_the_gate_and_the_announce_are_what_they_were() {
        // ① 半截配置（有地址没空间）：不开发现层、不发言
        let half = profiles_of(&[("", "http://192.168.1.5:8787")]);
        assert!(!should_run_discovery(&half, &[]));
        assert!(announces_for_with_mesh("dev-me", "本机", "T3ST1", &half, &[]).is_empty());
        // ② 绑上了：开，而且报的是配置地址（甲那条路）
        let bound = profiles_of(&[("sp-1", "http://192.168.1.5:8787")]);
        assert!(should_run_discovery(&bound, &[]));
        let got = announces_for_with_mesh("dev-me", "本机", "T3ST1", &bound, &[]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].hub_base.as_deref(), Some("http://192.168.1.5:8787"));
        // ③ 什么都没配：不开、不发言
        assert!(!should_run_discovery(&[], &[]));
        assert!(announces_for_with_mesh("dev-me", "本机", "T3ST1", &[], &[]).is_empty());
    }

    /// ★ 判据 ⑥（口径 2 的直接上游）：**"绑了同步"才算绑** —— 只填了地址还没选空间
    /// （登录+选空间是两步，是**正常中间态**）不算 ⇒ 那种半截配置**不许**让我们开始广播。
    /// 退化了会怎样：用户刚填完地址、还没选空间，进程已经在网段里喊了。
    #[test]
    fn a_half_configured_profile_does_not_count_as_bound() {
        assert_eq!(bound_profile_count(&[]), 0);
        assert!(!should_enable(bound_profile_count(&[])));
        // 有地址没空间 / 有空间没地址 / 全是空白 ⇒ 都不算
        assert_eq!(bound_profile_count(&profiles_of(&[("", "http://192.168.1.5:8787")])), 0);
        assert_eq!(bound_profile_count(&profiles_of(&[("sp-1", "")])), 0);
        assert_eq!(bound_profile_count(&profiles_of(&[("  ", "  ")])), 0);
        // 两条都齐 ⇒ 算一条（空白的那些不把数字灌高）
        assert_eq!(
            bound_profile_count(&profiles_of(&[("sp-1", "https://s.example.com"), ("", "")])),
            1
        );
        assert!(should_enable(bound_profile_count(&profiles_of(&[("sp-1", "https://s.example.com")]))));
    }

    /// ★ 判据 ⑦（口径 2 的下游）：**没绑定就一条公告都不产出**；绑了才产出，
    /// 而且**每个空间一条**（一条公告只替一个空间代言，`hub_spaces` 就是那个匹配键）。
    #[test]
    fn we_announce_only_the_spaces_that_are_actually_bound() {
        assert!(announces_for("dev-me", "本机", "T3ST1", &[]).is_empty());
        assert!(
            announces_for("dev-me", "本机", "T3ST1", &profiles_of(&[("", "http://192.168.1.5:8787")])).is_empty(),
            "只填了地址没选空间 ⇒ 不许发言（产出的公告没人能用）"
        );
        // 没有设备身份 ⇒ 一条都不发（`decode_announce` 会以 NoDeviceId 丢掉它）
        assert!(announces_for("  ", "本机", "T3ST1", &profiles_of(&[("sp-1", "http://192.168.1.5:8787")])).is_empty());

        // 两个空间、地址是私有网段 ⇒ 两条，各自代言各自的空间
        let got = announces_for(
            "dev-me",
            "本机",
            "T3ST1",
            &profiles_of(&[("sp-1", "http://192.168.1.5:8787"), ("sp-2", "http://192.168.1.5:8787")]),
        );
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].hub_spaces, vec!["sp-1".to_string()]);
        assert_eq!(got[1].hub_spaces, vec!["sp-2".to_string()]);
        assert_eq!(got[0].device_id, "dev-me");
        assert_eq!(got[0].hub_base.as_deref(), Some("http://192.168.1.5:8787"));
        // ★ 代言那一条也带指纹（owner 2026-09-25 拍板：fp ＝ device_id）
        assert_eq!(got[0].fp, "dev-me");
    }

    /// ★ 判据 ⑧：**"没在代言"也照样要发一条存在声明** —— 配置地址是公网时
    /// `announce_for_own_hub` 给 `None`，那是"没什么可代言的"，**不是"别说话"**。
    /// 退化了会怎样：这台设备在网段里**整个消失**（别人状态行的「发现 N 台」凭空少一台），
    /// 而它明明还在听。
    #[test]
    fn a_device_with_nothing_to_vouch_for_still_says_it_is_here() {
        let got = announces_for("dev-me", "本机", "T3ST1", &profiles_of(&[("sp-1", "https://s.example.com")]));
        assert_eq!(got.len(), 1, "没得代言也要露面（否则别人看不见这台设备）");
        assert_eq!(got[0].hub_base, None, "公网地址 ⇒ 不代言");
        assert!(got[0].hub_spaces.is_empty(), "不代言就不带空间（`resolve_base` 只认 hub_base 那一条）");
        assert_eq!(got[0].device_id, "dev-me");
        // ★ 存在声明**也带指纹**（owner 2026-09-25 拍板）：没资格代言的设备同样要说清"我是谁"，
        //   否则它在"谁在说话"这件事上对 B 片的掉包判据完全隐形。
        assert_eq!(got[0].fp, "dev-me", "`fp` 是 device_id，不是密钥材料指纹");
        // 空公告也要**是自己会收下的那种**（往返性质，见 `lan.rs` 判据 ⑫）
        let raw = crate::lan::encode_announce(&got[0]).unwrap();
        assert_eq!(crate::lan::decode_announce(&raw).unwrap(), got[0]);
    }

    /// ★★ 2026-09-26（真机抓到的**单向发现**）：那轮广播的目标必须**按活的表现算**。
    ///
    /// 为什么是源码级：那条循环是**无限 async 循环**（`loop { 收 … 按需喊 … 腾表 }`），
    /// 本机判据起不来它（要真网卡 ＋ 真 30 秒节拍）。所以这里钉**接线**：
    /// 目标必须是 `announce_targets(…, &state.peers(now))` 现算的，而不是循环外算一次的
    /// `default_targets` —— 后者正是"表里明明有对端、却永远发不到它"的形状（单向发现的成因）。
    /// ⚠️ 断言对着**去过注释**的源码：这个文件的注释里到处在讲这件事。
    #[test]
    fn the_announce_loop_recomputes_targets_from_the_live_peer_table() {
        let code = include_str!("lan_state.rs")
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            code.contains("lan::announce_targets(lan::LAN_PORT, &state.peers(now))"),
            "公告目标没有按「活的表」现算 ⇒ 认识的对端也发不到（单向发现会回来）"
        );
        // ⚠️ 这条"不许出现"的模式**必须拼出来**：`include_str!` 把**本判据自己**也读进去了，
        //    写成字面量就会自己命中自己（第一版就是这么假红的）。
        let forbidden = format!("let targets = lan::{}(", "default_targets");
        assert!(
            !code.contains(&forbidden),
            "又退回「循环外算一次」了 ⇒ 补方向的那条单播没了"
        );
    }

    /// ★ 判据 ⑨：**广播间隔与存活期的关系** —— 存活期必须**明显大于**广播间隔，
    /// 否则一次丢包（或一次忙等）就会把还在线的设备判死。
    /// 退化了会怎样：网段里两台明明都在，却互相看不见（表现是"时好时坏的直连"）。
    #[test]
    fn the_peer_ttl_outlives_the_announce_interval() {
        assert!(
            crate::lan::PEER_TTL_MS >= ANNOUNCE_INTERVAL_MS * 2,
            "存活期要留至少两轮公告的余量（TTL={} 间隔={}）",
            crate::lan::PEER_TTL_MS,
            ANNOUNCE_INTERVAL_MS
        );
        // 到点判别式本身：还没喊过 ⇒ 立刻喊；喊过 ⇒ 要等满一个间隔
        assert!(announce_due(0, 1_000, ANNOUNCE_INTERVAL_MS), "第一轮就要露面，别等一个间隔");
        assert!(!announce_due(10_000, 10_000 + ANNOUNCE_INTERVAL_MS - 1, ANNOUNCE_INTERVAL_MS));
        assert!(announce_due(10_000, 10_000 + ANNOUNCE_INTERVAL_MS, ANNOUNCE_INTERVAL_MS));
        // 时刻回绕（系统时钟被调回去）⇒ **不 panic、也不狂喊**（`saturating_sub` 夹到 0，
        // 于是"再等一个间隔"；宁可晚一轮，也不要在时钟乱跳时往网段里刷公告）。
        assert!(!announce_due(10_000, 5, ANNOUNCE_INTERVAL_MS));
        assert_eq!(announce_due(10_000, i64::MIN, ANNOUNCE_INTERVAL_MS), false, "极端回绕也不许 panic");
    }
}

/// 「本机名回退链」的判据（2026-10-10，08-a①）—— **行为**读数 ✓。
///
/// ⭐ 这次要修的两条，各有一条判据钉住 ✓：
///   ① **空串不许再出现** ✗（修前 `host_name()` 拿不到环境变量就返回空 ⇒ 对端显示空白 ✗）；
///   ② ⛔ **不许回落成 `device_id` 前几位/哈希** ✗（规格逐字禁 ✓）。
#[cfg(test)]
mod device_name_tests {
    use super::*;

    #[test]
    fn user_set_name_wins() {
        assert_eq!(resolve_local_name(Some("书房的那台"), "MacBook-Pro"), "书房的那台");
    }

    #[test]
    fn blank_stored_name_falls_back_to_host() {
        // 用户清空一次（或数据里是空白）⇒ 回到主机名 ✓，**不是**空串 ✗
        assert_eq!(resolve_local_name(Some("   "), "MacBook-Pro"), "MacBook-Pro");
        assert_eq!(resolve_local_name(None, "MacBook-Pro"), "MacBook-Pro");
    }

    #[test]
    fn never_blank_when_host_is_missing_too() {
        // ⭐ 这就是修前的那条错：两档都拿不到 ⇒ 旧 `host_name()` 返回 **空串** ✗
        let n = resolve_local_name(None, "");
        assert!(!n.trim().is_empty(), "本机名**永远不许是空白** ✗（对端会显示成没名字）");
        assert_eq!(n, DEFAULT_DEVICE_NAME);
        assert_eq!(resolve_local_name(Some("  "), "   "), DEFAULT_DEVICE_NAME);
    }

    #[test]
    fn never_looks_like_a_device_id_prefix() {
        // ⛔ 规格逐字不许用 `device_id`（或其前几位/哈希）当兜底 ✓ ⇒ 兜底值里不许像 uuid/hex ✗
        let fallback = resolve_local_name(None, "");
        assert!(!fallback.contains('-'), "兜底名里不许出现 uuid 形状的连字符 ✗");
        assert!(
            fallback.chars().all(|c| !c.is_ascii_hexdigit() || !c.is_ascii()),
            "兜底名不许是纯 ascii 十六进制（那就是 id 前几位的形状 ✗）"
        );
    }
}

// ─────────────── 08-a②（2026-10-10）：设备名的读写命令 ───────────────
//
// ⚠️ 落库位置与 `device_id` **同一张表**（`meta.sync_state` ✓，走 `crate::sync::get_meta_state`
//   ／`set_meta_state` ✓）⇒ **不需要迁移** ✓。
// ⚠️ 语义：**没设过 ⇒ `None`** ✓（界面据此显示"用的是主机名"✓，⛔ 不编一个假名字 ✗）；
//    **设成空串 ⇒ 等于清掉**设置 ✓（回退链接管 ✓），⛔ 不落一个空值 ✗（那会让对端显示空白 ✗）。

/// 读**用户设的**本机名（没设过／被清空 ⇒ `None` ✓）。
#[tauri::command]
pub fn get_device_name(db: tauri::State<'_, Db>) -> Result<Option<String>, String> {
    let c = db.0.lock().unwrap_or_else(|e| e.into_inner());
    Ok(stored_device_name(&c))
}

/// 设本机名；`name` 为空白 ⇒ **清掉设置** ✓。返回**落库后真正生效的名字** ✓
/// （＝回退链的结果 ✓，界面拿它显示"现在叫什么"✓）。
#[tauri::command]
pub fn set_device_name(db: tauri::State<'_, Db>, name: String) -> Result<String, String> {
    let c = db.0.lock().unwrap_or_else(|e| e.into_inner());
    let trimmed = name.trim();
    if trimmed.is_empty() {
        c.execute("DELETE FROM meta.sync_state WHERE key = ?1", rusqlite::params![KEY_DEVICE_NAME])
            .map_err(|e| e.to_string())?;
    } else {
        crate::sync::set_meta_state(&c, KEY_DEVICE_NAME, trimmed)?;
    }
    Ok(local_device_name(&c))
}

// ─────────────── 08-b①（2026-10-10）：随机短标识 ───────────────
//
// 用途：**信任前要展示对方身份**（规格 J21：设备名 ＋ 短标识 ✓）—— 而设备名可能为空 ✓、
// `device_id` **不许进用户可见的句子** ✗（`sync.rs:3923` 逐字禁 ✓）⇒ 需要一个**可显示**的短标识 ✓。
//
// ⛔ **硬要求（逐字）**：**随机生成** ✗ **不许**从 `device_id` 截断／取前缀／哈希 ✗
//   （规格逐字：「不许回落成 `device_id` **前缀**」✗）⇒ 这里是**独立随机源** ✓，函数**不接受**
//   任何身份输入 ✓（结构上就派生不出来 ✓）。
// ⚠️ 长度 **4–6 字符** ✓；**必须持久化** ✓（否则重启就变 ✗ ⇒ 用户刚认过的身份下一次又变了 ✗）；
//   落在 `meta.sync_state` 的 `short_id` 键 ✓（与 `device_id` / `device_name` **同表 ⇒ 免迁移** ✓）。

/// `meta.sync_state` 里的键 ✓。
const KEY_SHORT_ID: &str = "short_id";

/// 短标识长度：**4–6** 之间取 5 ✓（够短能念、够长不易撞：32⁵ ≈ 3.3×10⁷ ✓）。
const SHORT_ID_LEN: usize = 5;

/// 字母表：**去掉易混字符**（`0/O`、`1/I`）✓ —— 它是要**念给人听/对着看**的 ✓。
const SHORT_ID_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 个 ⇒ 256 % 32 == 0，取模无偏 ✓

/// 生成一个**随机**短标识 ✓（⛔ 与任何身份字段无关 ✗ —— 见上面那段硬要求 ✓）。
fn new_short_id() -> String {
    let raw = uuid::Uuid::new_v4();
    let bytes = raw.as_bytes();
    (0..SHORT_ID_LEN)
        .map(|i| SHORT_ID_ALPHABET[(bytes[i] as usize) % SHORT_ID_ALPHABET.len()] as char)
        .collect()
}

/// 短标识的**取值规则**（纯函数 ⇒ 可单测 ✓）：
/// **已有且合法 ⇒ 原样返回** ✓（⇒ 重启后不变 ✓）；否则**新生成一个** ✓。
fn short_id_or_init(existing: Option<&str>) -> String {
    if let Some(v) = existing {
        let v = v.trim();
        let ok = (4..=6).contains(&v.len()) && v.chars().all(|c| SHORT_ID_ALPHABET.contains(&(c as u8)));
        if ok {
            return v.to_string();
        }
    }
    new_short_id()
}

/// 读写口：库里没有（或值非法）就**生成并落库** ✓，有就原样用 ✓。
fn local_short_id(c: &rusqlite::Connection) -> Result<String, String> {
    let existing = crate::sync::get_meta_state(c, KEY_SHORT_ID);
    let id = short_id_or_init(existing.as_deref());
    if existing.as_deref() != Some(id.as_str()) {
        crate::sync::set_meta_state(c, KEY_SHORT_ID, &id)?;
    }
    Ok(id)
}

/// 08-b① 的四条判据（Lead 照收的那四条 ✓）—— **行为**读数，不是注释 ✓。
#[cfg(test)]
mod short_id_tests {
    use super::*;

    #[test]
    fn length_is_within_4_to_6() {
        for _ in 0..64 {
            let id = new_short_id();
            assert!((4..=6).contains(&id.len()), "短标识长度必须在 4–6，实际 {}", id.len());
        }
    }

    #[test]
    fn is_random_two_calls_differ() {
        // 32⁵ ≈ 3.3×10⁷ ⇒ 连测 16 对，撞上的概率可忽略 ✓（真撞了说明随机源没在动 ✗）
        for _ in 0..16 {
            assert_ne!(new_short_id(), new_short_id(), "连续两次生成相同 ⇒ 不是随机 ✗");
        }
    }

    #[test]
    fn never_derived_from_device_id() {
        // ⛔ 规格逐字禁"截断／前缀／哈希 `device_id`" ✗ —— 这一条**就是**钉它的 ✓。
        let device_id = uuid::Uuid::new_v4().to_string(); // 小写 uuid（与线上同形 ✓）
        assert!(!device_id.starts_with(&new_short_id()));
        // 取一批生成值，都不许出现在 device_id 里（大写字母表 ⇒ 与小写 uuid 天然不重叠 ✓）
        for _ in 0..32 {
            let id = new_short_id();
            assert!(!device_id.contains(&id), "短标识不许是 device_id 的片段 ✗：{id}");
            assert!(!device_id.to_uppercase().contains(&id), "短标识不许是 device_id 的派生 ✗：{id}");
        }
    }

    #[test]
    fn stable_across_restart_when_already_stored() {
        // ⭐ "重启后不变"的**规则本身**：已有合法值 ⇒ 原样返回 ✓（不重新生成 ✗）
        let stored = "K7M2Q";
        assert_eq!(short_id_or_init(Some(stored)), stored);
        assert_eq!(short_id_or_init(Some("  K7M2Q  ")), stored, "空白要折掉再判定 ✓");
        // 库里是空/非法（老库、被手改过）⇒ 补一个新生成的 ✓（那也算"重启后有个稳定值" ✓）
        let healed = short_id_or_init(Some(""));
        assert!((4..=6).contains(&healed.len()));
        let healed2 = short_id_or_init(Some("abc")); // 小写/太短 ⇒ 非法 ✓
        assert!((4..=6).contains(&healed2.len()));
        assert!(healed2.chars().all(|c| SHORT_ID_ALPHABET.contains(&(c as u8))));
    }
}
