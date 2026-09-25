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

use std::sync::atomic::{AtomicBool, Ordering};
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
        Self {
            table: PeerTable::new(local_device_id),
            enabled: AtomicBool::new(false),
        }
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

    /// 收**一条原始报文**：解开 ⇒ 入库 ⇒ 把入库的那一条还回来（`Ok(Some)`）。
    ///
    /// 三种结果与 [`crate::lan::recv_into`] 一一对应（它就是这一层的薄壳）：
    /// - `Ok(Some(peer))` ＝ 收了、记了；
    /// - `Ok(None)` ＝ 是我自己的公告（回环回来的）⇒ **忽略**（不是错误，也**不入表**）；
    /// - `Err(原因)` ＝ 报文不合法 ⇒ **丢弃且不入表**（四种原因见 `lan::AnnounceReject::reason`）。
    ///
    /// ⚠️ **解码只在这一处**：`recv_into` 不再自己 `decode_announce` 一遍 —— 两处各解一次
    /// 迟早会漂（那种漂的表现是"某一种坏报文在一处被丢、在另一处被收下"）。
    pub fn record_datagram(&self, raw: &str, from_ip: &str, now_ms: i64) -> Result<Option<Peer>, String> {
        let announce = crate::lan::decode_announce(raw).map_err(|r| r.reason().to_string())?;
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

/// 这一轮该发哪几条公告（纯函数）。
///
/// ⚠️ **"没在代言"与"代言着"必须都发**：`lan::announce_for_own_hub` 在配置地址不是私有网段时
/// 给 `None`（那台设备没什么可代言的），此时若"干脆什么都不发"，这台设备在网段里就
/// **整个消失了**（别人状态行的「发现 N 台」会凭空少一台），而它明明还在听。
/// 所以：**每个绑了同步的空间都发一条存在声明**，`hub_base` 那一半按代言资格给。
///
/// 绑了多个空间 ⇒ 多条（一条公告只替**一个**空间代言，`hub_spaces` 就是那个匹配键）。
/// `profiles` 的形状与 [`bound_profile_count`] 同一套：`(space_id, server_url, ws_id)`。
pub fn announces_for(
    local_device_id: &str,
    device_name: &str,
    profiles: &[(String, String, String)],
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
        if !is_fully_bound(space_id, server_url) {
            continue;
        }
        let mut a = lan::announce_for_own_hub(dev, device_name, url, space)
            .unwrap_or_else(|| lan::LanAnnounce {
                v: lan::WIRE_VERSION,
                device_id: dev.to_string(),
                device_name: device_name.trim().to_string(),
                hub_base: None,
                hub_spaces: Vec::new(),
                fp: String::new(),
            });
        a.hub_spaces =
            if a.hub_base.is_some() { vec![space.to_string()] } else { Vec::new() };
        out.push(a);
    }
    out
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
    let device_name = host_name();
    let _ = STARTED.set(());
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        // 绑这里（**循环外面**）：绑不上就没得听也没得喊，如实打一行日志就收工。
        let sock = match lan::bind_listener(lan::LAN_PORT).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[lan] 绑不上 UDP {}（发现层没起来，同步照旧）：{e}", lan::LAN_PORT);
                return;
            }
        };
        let targets = lan::default_targets(lan::LAN_PORT);
        let state = LanState::global(&device_id);
        let mut last_announce_ms: i64 = 0;
        loop {
            let now = crate::db::now_ms();
            // ① 收（有超时 ⇒ "网段里没人说话"时循环照常推进，广播与腾表不会被卡住）。
            //    ⚠️ 收报走 `recv_into_within` ⇒ **解码只有一处**（`record_datagram`）。
            let _ = lan::recv_into_within(&sock, state, RECV_SLICE_MS).await;
            // ② 按需启用（每轮重读：绑了同步才发言，见口径 2）。
            //    ⚠️ 判别式走 `should_enable(bound_profile_count(..))` —— 与判据用的是**同一把尺**
            //    （不是 `profiles.len()`）：只填了地址还没选空间的行**不许**让我们开始广播。
            let profiles = bound_profiles(&app2);
            state.set_enabled(should_enable(bound_profile_count(&profiles)));
            // ③ 到点就喊一轮。
            if state.is_enabled() && announce_due(last_announce_ms, now, ANNOUNCE_INTERVAL_MS) {
                for a in announces_for(&device_id, &device_name, &profiles) {
                    let _ = lan::announce_once(&sock, &targets, &a).await;
                }
                // ⚠️ **不管发出去几条都记时刻**：一条没发出去只说明"这个网段的广播被禁了"
                //    （受限网络），每 1s 重试一次等于自己打自己 ⇒ 到点才试下一轮。
                last_announce_ms = now;
            }
            // ④ 腾过期行（表不是只增不减的；`lan::PEER_TTL_MS` 是唯一的判死依据）。
            if state.is_enabled() {
                state.sweep(now);
            }
        }
    });
    Ok(())
}

/// 本机名（公告里的 `device_name`，只给人看）：拿不到就留空，**不编**一个假的。
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
                hub_base: Some(base.to_string()),
                hub_spaces: spaces.iter().map(|s| s.to_string()).collect(),
                fp: "fp".into(),
            },
            addr: "192.168.1.9".into(),
            seen_at_ms: 1_000,
        }
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
        assert!(announces_for("dev-me", "本机", &[]).is_empty());
        assert!(
            announces_for("dev-me", "本机", &profiles_of(&[("", "http://192.168.1.5:8787")])).is_empty(),
            "只填了地址没选空间 ⇒ 不许发言（产出的公告没人能用）"
        );
        // 没有设备身份 ⇒ 一条都不发（`decode_announce` 会以 NoDeviceId 丢掉它）
        assert!(announces_for("  ", "本机", &profiles_of(&[("sp-1", "http://192.168.1.5:8787")])).is_empty());

        // 两个空间、地址是私有网段 ⇒ 两条，各自代言各自的空间
        let got = announces_for(
            "dev-me",
            "本机",
            &profiles_of(&[("sp-1", "http://192.168.1.5:8787"), ("sp-2", "http://192.168.1.5:8787")]),
        );
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].hub_spaces, vec!["sp-1".to_string()]);
        assert_eq!(got[1].hub_spaces, vec!["sp-2".to_string()]);
        assert_eq!(got[0].device_id, "dev-me");
        assert_eq!(got[0].hub_base.as_deref(), Some("http://192.168.1.5:8787"));
    }

    /// ★ 判据 ⑧：**"没在代言"也照样要发一条存在声明** —— 配置地址是公网时
    /// `announce_for_own_hub` 给 `None`，那是"没什么可代言的"，**不是"别说话"**。
    /// 退化了会怎样：这台设备在网段里**整个消失**（别人状态行的「发现 N 台」凭空少一台），
    /// 而它明明还在听。
    #[test]
    fn a_device_with_nothing_to_vouch_for_still_says_it_is_here() {
        let got = announces_for("dev-me", "本机", &profiles_of(&[("sp-1", "https://s.example.com")]));
        assert_eq!(got.len(), 1, "没得代言也要露面（否则别人看不见这台设备）");
        assert_eq!(got[0].hub_base, None, "公网地址 ⇒ 不代言");
        assert!(got[0].hub_spaces.is_empty(), "不代言就不带空间（`resolve_base` 只认 hub_base 那一条）");
        assert_eq!(got[0].device_id, "dev-me");
        // 空公告也要**是自己会收下的那种**（往返性质，见 `lan.rs` 判据 ⑫）
        let raw = crate::lan::encode_announce(&got[0]).unwrap();
        assert_eq!(crate::lan::decode_announce(&raw).unwrap(), got[0]);
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
