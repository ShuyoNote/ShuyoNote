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
//! ⚠️ 这一层**不含任何 IO**：不绑 socket、不起任务（那是接线那一片）。它只回答
//! "现在该不该听/该不该喊"与"现在听到了谁"。
#![allow(dead_code)] // ← 接线那一片删掉（与 `lan.rs` 同一约定：这一层还没有调用方）

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use crate::lan::{Peer, PeerTable};

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
}
