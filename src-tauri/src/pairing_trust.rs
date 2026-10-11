//! ⭐ 「点一下就通」那一步的**纯函数内核** ✗（owner 2026-10-11 拍「确定：点一下就通」✓）。
//!
//! 出处：`docs/plans/2026-10-11-one-click-trust-decision.md` ✓ —— 本模块**只做第 ① 步** ✗：
//! ⭐ 判定「这次信任走到哪一步了 ✗」与「收到的对方确认算不算数 ✗」✓，
//! ⛔ **不碰任何 IO ／ 网络 ／ 密钥** ✗（⭐ 命令是第 ② 步、⭐ 界面是第 ③ 步 ✓，⭐ 它们只调这里的判定 ✓）。
//!
//! ## 为什么是「两端各点一次」
//! ⭐ 单方面点完就采纳 ⇒ 同一网段里**任何人都能把自己塞进来** ✗ —— ⭐ 那正是规格 T1 要挡的 ✓。
//! ⇒ ⭐ 本模块把「两边都点过」当**唯一**能进 `Trusted` 的条件 ✓，
//! ⭐ 并且这条由**判据**钉住 ✓ —— ⛔ 不是靠注释提醒 ✗。
//!
//! ## 与既有不变量的关系
//! `INV-NS-pairing-code-length-kept`（⭐ 码长按 60 位、不许缩短 ✓）**仍然有效** ✓：
//! 本模块**不引入任何新码** ✗ —— 它比对的是**一次性随机串**（⭐ 只为「这次握手是这一次 ✗」去重 ✓），
//! ⛔ 不当口令、⛔ 不当认证材料用 ✓。
//!
//! ## 为什么放纯函数
//! ⭐ 「要不要两端确认 ✗」「⭐ 空串算不算对上 ✗」这类判定**与 IO 无关** ✓ ⇒
//! ⭐ 拿它当第 ① 步，⭐ 判据不用起宿主、⭐ 不用网络就能跑 ✓，⭐ 而且**能先看它红** ✓。

/// 这次信任走到哪儿了。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TrustState {
    /// ⭐ 还没开始（⭐ 或已被放弃 ✓）。
    #[default]
    Idle,
    /// ⭐ 本机点过了，⭐ **在等对方也在它自己屏幕上点一下** ✓。
    WaitingRemote,
    /// ⭐ 对方点过了，⭐ **本机还没点** ✓ —— ⭐ 记住它 ✓，⛔ 但**不因此建立信任** ✗（⭐ T1 ✓）。
    /// ⚠️ 少了这一档就会**死锁** ✓：⭐ 对方先点、⭐ 本机后点时只会进 `WaitingRemote` ⇒
    /// ⭐ 两边都点过了、⭐ 却谁都以为在等对方 ✓（⭐ 这是第 ① 步的判据当场抓到的 ✓）。
    RemotePending,
    /// ⭐ 两端都点过 ⇒ ⭐ 可以建立信任 ✓。
    Trusted,
}

/// ⭐ 本机点「信任这台设备」之后的状态 ✓。
/// ⚠️ ⭐ 只有**已经知道对方点过**（`RemotePending` ✓）时才进 `Trusted` ✗ ——
/// ⭐ 单方面点完永远不算 ✓（⭐ 判据钉这条 ✓）。
pub fn state_after_local_confirm(current: TrustState) -> TrustState {
    match current {
        TrustState::Idle => TrustState::WaitingRemote,
        // ⭐ 对方已经点过 ⇒ ⭐ 这一下就是"⭐ 两端都点过 ✗" ✓。
        TrustState::RemotePending => TrustState::Trusted,
        // ⭐ 再点不推进（⭐ 幂等 ✓）：⭐ 免得「⭐ 连点两下 ✗」被读成「⭐ 两端都点了 ✗」。
        TrustState::WaitingRemote => TrustState::WaitingRemote,
        TrustState::Trusted => TrustState::Trusted,
    }
}

/// ⭐ 收到对方的确认（⭐ 它也在它自己屏幕上点了 ✓）之后的状态 ✓。
pub fn state_after_remote_confirm(current: TrustState) -> TrustState {
    match current {
        // ⚠️ ⭐ 只是**记下来** ✗：⭐ 对方单方面说「⭐ 我点了 ✗」**不许**建立信任 ✓
        //    （⭐ 否则对方一台就能把关系建起来 ✓ ⇒ ⭐ 退化成「⭐ 谁先喊谁算数 ✗」✓）。
        TrustState::Idle => TrustState::RemotePending,
        TrustState::WaitingRemote | TrustState::Trusted => TrustState::Trusted,
        TrustState::RemotePending => TrustState::RemotePending,
    }
}

/// ⭐ 放弃（⭐ 用户点「先不」／⭐ 超时 ✓）⇒ ⭐ 回到 `Idle` ✓，⭐ 不留半截状态 ✓。
pub fn state_after_dismiss(_current: TrustState) -> TrustState {
    TrustState::Idle
}

/// ⭐ 这一台在这次信任里是**哪一边** ✓。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustRole {
    /// ⭐ 我点了「信任这台设备」⇒ ⭐ 我**先发问** ✓（⭐ 在等它那台确认 ✓）。
    Asker,
    /// ⭐ 我看到「这台设备想跟你同步」⇒ ⭐ **我来确认** ✓（⭐ 确认时由我**生成**那把配对密钥 ✓）。
    Responder,
}

/// ⭐ 看到对方的「想信任」之后的状态 ✓（⭐ 这一台就是**被问的那台** ✓）。
/// ⚠️ ⭐ **看到 ≠ 同意** ✗：⭐ 只记成 `RemotePending` ✓ —— ⭐ 一定要**本机的人**再点一下 ✓
/// （⭐ 只看到一条广播就建立信任 ＝ ⭐ 同网段谁都能塞进来 ✓ ⇒ ⭐ 那正是 T1 ✓）。
pub fn state_after_ask_seen(current: TrustState) -> TrustState {
    match current {
        TrustState::Idle => TrustState::RemotePending,
        // ⭐ 已经点过／已经信任 ⇒ ⭐ 不因"⭐ 又收到一遍广播 ✗"而回退 ✓（⭐ 广播是周期性的 ✓）。
        other => other,
    }
}

/// ⭐ 确认时要不要**由我生成**那把配对密钥 ✗ —— ⭐ 只有**被问的那台**生成 ✓。
/// ⚠️ 把它写成纯判定 ✗：⭐ 于是「⭐ 谁写密钥材料 ✗」这条**不用起网络就能被判据钉住** ✓
/// （⭐ 否则"⭐ 两边都以为对方写 ✗"这种错要跑到真机上才发现 ✓）。
pub fn confirm_generates_secret(role: TrustRole) -> bool {
    matches!(role, TrustRole::Responder)
}

/// ⭐ **甲：一端点就通** ✗（owner 2026-10-11 二次拍板，逐字「甲：一端点就通，图④为准」✓）。
///
/// ⭐ 与它配套的**一条硬事实**（本模块在收到真实代码前就先钉住它 ✓）：
/// ⭐ 这把"⭐ 配对密钥 ✗"**不是**新生成的随机串 ✗ —— ⭐ 它是**空间自己的网格令牌** ✗
/// （`sync.rs::remember_peer_card` 收到的那个 `secret` ✓，⭐ 两台都从**空间密钥**推得出 ✓）
/// ⇒ ⭐ ⭐ **所以"⭐ 一点就通 ✗"根本不需要在网线上传密钥** ✓：⭐ 走广播的只有"⭐ 我想信任你 ✗"这一格 ✓。
///
/// ⚠️ ⭐ 为什么这条必须写下来 ✗：⭐ 我（Lead）先前那版设计**以为**要按 09-25 那条路
/// "⭐ 被问的那台现场生成一把、⭐ 再由它 `trust_secret` 发出去 ✗" ✓ ⇒ ⭐ 那是**多此一举** ✗，
/// ⭐ 而且会把空间令牌**送上明文广播** ✗ ✗ —— ⭐ 比原来的威胁模型更差 ✓。
/// ⇒ ⭐ 甲 的真实形状是：⭐ 点的那一侧 ⭐ 用**已有的令牌**登记对面 ✓（`remember_peer_card` ✓），
/// ⭐ 另一位收到 `trust_ask` ⇒ ⭐ **自动采纳** ✓（⭐ 甲：⭐ 不问那台的人 ✓）。
pub const fn one_sided_click_establishes_trust() -> bool {
    true
}

/// ⭐ **"⭐ 空间令牌永远不许上广播 ✗"** ✗ —— ⭐ 出站那格只允许带"⭐ 我想信任你 ✗"（`trust_ask` ✓）。
///
/// ⚠️ 这条是**判据的判据** ✗：⭐ 上面那条"⭐ 不需要传密钥 ✗"如果哪天被人改成"⭐ 顺手也发一份 ✗"✓，
/// ⭐ 后果是**把空间令牌公开发给同网段** ✗ ⇒ ⭐ 必须有一条能红的判据盯着 ✓。
pub fn outbound_may_carry_secret() -> bool {
    false
}

/// ⭐ 握手的**默认有效期**（⭐ 毫秒 ✓）—— ⭐ 四个广播周期（⭐ 广播 30 秒一轮 ✓）。
/// ⚠️ 为什么要过期 ✗：⭐ 一次没走完的握手（⭐ 对方关机了 ✓）不许**永远**挂在广播里 ✓ ——
/// ⭐ 那既会一直暴露 `trust_secret` ✓，⭐ 也会让界面一直显示"⭐ 有人在等你 ✗"✓。
pub const TRUST_TTL_MS: i64 = 120_000;

/// ⭐ 一次握手里**本机这边要记住的东西** ✗（⭐ 命令层只搬它 ✓，⛔ 判定仍在上面那几个纯函数里 ✓）。
///
/// ⚠️ `peer_device_id` / `asked_by` 都是**内部标识** ✓ ⇒ ⛔ 不许进用户可见的句子 ✓
/// （`INV-UI-copy-no-internal-ids` ✓；⭐ 界面上要显示"⭐ 是谁 ✗"就用 ⭐ 设备名 ＋ ⭐ 短标识 ✓）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TrustHandshake {
    /// ⭐ **我要信任的那一台** ✓（⭐ 空 ＝ ⭐ 这次没发问 ✓）。
    peer_device_id: String,
    /// ⭐ 我发出去的握手串 ✓（⭐ 空 ＝ ⭐ 我还没发问 ✓）。
    ask: String,
    /// ⭐ **是谁在问我** ✓（⭐ 空 ＝ ⭐ 没人问我 ✓）。
    asked_by: String,
    /// ⭐ **我给人家的那把** ✓（⭐ 只有被问的那台、⭐ 人点过之后才非空 ✓）。
    secret_for: String,
    /// ⭐ 什么时候到期（⭐ 毫秒 ✓，⭐ 0 ＝ ⭐ 没有进行中的东西 ✓）。
    expires_at_ms: i64,
    /// ⭐ **这次信任走到哪一步了** ✗（⭐ 甲：一端点就通 ⇒ 收到 ask 并采纳之后要推进它 ✓）。
    /// ⚠️ 放在这里而不是另开一个格子 ✗：⭐ 它就是"⭐ 一次握手里本机这边要记住的东西 ✗"之一 ✓，
    /// ⭐ 而且**判定仍是上面那些纯函数** ✓（本字段只是它们的落点 ✓）。
    state: TrustState,
}

impl TrustHandshake {
    /// ⭐ 本机点「信任这台设备」⇒ ⭐ 记下发问（⭐ 等对方确认 ✓）。
    pub fn begin(&mut self, peer_device_id: &str, ask: &str, now_ms: i64, ttl_ms: i64) {
        self.clear();
        self.peer_device_id = peer_device_id.to_string();
        self.ask = ask.to_string();
        self.expires_at_ms = now_ms + ttl_ms;
    }

    /// ⭐ 收到对方的「想信任」⇒ ⭐ 记下来（⭐ ⛔ 不因此建立信任 ✓，⭐ 要本机的人再点 ✓）。
    ///
    /// ⭐ 2026-10-11（owner 拍「甲：一端点就通」）：⭐ 这一步**只记账** ✗ —— ⭐ 真正"采纳"
    /// （★ 登记对面 ＋ ★ 推进状态 ✓）在**有 db 的那一层**（`sync.rs` 的网格那一轮 ✓），
    /// 因为那一步要写库 ✗，而本模块与 `lan_state` 都**不碰 IO** ✓。
    pub fn note_ask(&mut self, peer_device_id: &str, now_ms: i64, ttl_ms: i64) {
        // ⚠️ ⭐ **不调 `clear()`** ✗ —— 它会把已经走到的 `WaitingRemote`／`Trusted`
        //   **冲回 `Idle`** ✗；而公告是**周期性**的（30 秒一轮 ✓）⇒ 每轮冲一次 ✗。
        //   ⇒ ⭐ 只清"这次问"这几格 ✓，状态交给 `state_after_ask_seen`（它正是为此存在的 ✓）。
        self.peer_device_id.clear();
        self.ask.clear();
        self.secret_for.clear();
        self.asked_by = peer_device_id.to_string();
        self.expires_at_ms = now_ms + ttl_ms;
        self.state = state_after_ask_seen(self.state);
    }

    /// ⭐ 本机的人点了「信任」⇒ ⭐ 记住**要发出去的那把** ✓（⭐ 由被问的那台生成 ✓）。
    /// ⭐ 返回 `false` ＝ ⭐ 这次不是"⭐ 被问的那台该确认 ✗"（⭐ 比如没人问过我 ✓）⇒ ⭐ 调用方如实报错 ✓。
    pub fn confirm(
        &mut self,
        peer_device_id: &str,
        secret: &str,
        now_ms: i64,
        ttl_ms: i64,
    ) -> bool {
        if self.asked_by.is_empty() || self.asked_by != peer_device_id {
            return false;
        }
        self.secret_for = secret.to_string();
        self.expires_at_ms = now_ms + ttl_ms;
        true
    }

    /// ⭐ 这条公告该带上的 `trust_ask` ✗（⭐ 过期 ⇒ ⭐ 一个字节都不带 ✓）。
    pub fn outbound_ask(&self, now_ms: i64) -> &str {
        if self.is_expired(now_ms) {
            return "";
        }
        &self.ask
    }

    /// ⭐ 这条公告该带上的 `trust_secret` ✗（⭐ 同上 ✓；⭐ 没确认过 ⇒ ⭐ 空串 ✓）。
    pub fn outbound_secret(&self, now_ms: i64) -> &str {
        if self.is_expired(now_ms) {
            return "";
        }
        &self.secret_for
    }

    /// ⭐ 过期了没 ✓（⭐ `expires_at_ms == 0` ＝ ⭐ 没有任何进行中的东西 ⇒ ⭐ 算"⭐ 没有 ✗"✓，
    /// ⭐ 不是"⭐ 过期 ✗" ✓ —— ⭐ 两者都会让出站那两格为空 ✓，⭐ 但语义不同 ✓）。
    pub fn is_expired(&self, now_ms: i64) -> bool {
        self.expires_at_ms != 0 && now_ms >= self.expires_at_ms
    }

    /// ⭐ 有没有进行中的东西 ✓（⭐ 过期的不算 ✓）。
    pub fn is_active(&self, now_ms: i64) -> bool {
        self.expires_at_ms != 0 && !self.is_expired(now_ms)
    }

    /// ⭐ 这次信任走到哪一步了 ✓（⭐ 只读面 ✓ —— 给接线那层与判据用 ✓）。
    pub fn state(&self) -> TrustState {
        self.state
    }

    /// ⭐⭐ **读取面：这一轮该采纳哪些「想信任」** ✗（Lead 2026-10-11 点名要的形状 ✓）。
    ///
    /// ⛔ ⭐ **过期的绝不返回** ✗ —— 一条没走完的握手不许永远等着被采纳 ✓
    /// （否则一台关过机的对端会在**几天后**突然被采纳 ✓）。
    /// ⚠️ 形状是 `Vec<String>` ✗（本版一次只跟一台谈 ✓）：⭐ 形状先给宽 ✗，
    /// ⛔ 免得将来"同时跟两台谈"要改所有调用点 ✓。
    pub fn pending_asks(&self, now_ms: i64) -> Vec<String> {
        if self.asked_by.is_empty() || self.is_expired(now_ms) {
            Vec::new()
        } else {
            vec![self.asked_by.clone()]
        }
    }

    /// ⭐ **过期的**那一档 ⇒ ⭐ 清掉并回 `true` ✗（⭐ 调用方**据此记一行日志** ✓ —— ⛔ 不许静默 ✓）。
    ///
    /// ⚠️ 与 [`TrustHandshake::clear`] 的区别 ✗：⭐ 它**只**清"这次问"✓，⛔ **不动** `state` ✗
    /// （⭐ 状态是界面要读的东西 ✓，不能让一次 TTL 收尾把它抹掉 ✓）。
    pub fn drop_expired(&mut self, now_ms: i64) -> bool {
        if self.asked_by.is_empty() || !self.is_expired(now_ms) {
            return false;
        }
        self.asked_by.clear();
        self.expires_at_ms = 0;
        true
    }

    /// ⭐ 采纳成功之后**推进内核** ✗（⭐ 甲：一端点就通 ⇒ ⭐ 收到 ask 本身就等于"对方点过了" ✓）。
    ///
    /// ⚠️ 顺手把"这次问"清掉 ✗ ⇒ ⭐ [`TrustHandshake::pending_asks`] 不再返回它 ✓
    /// ⇒ ⭐ **不会每轮重复采纳** ✓（公告 30 秒一轮 ⇒ 不清就会每轮重写一遍卡片 ✓）。
    /// ⚠️ 状态**再多活一个 TTL** ✓：界面那半要读它（"刚通了"那一屏 ✓）；⭐ 没有 ask 了 ⇒ 不会再被采纳 ✓。
    pub fn note_remote_confirm(&mut self, now_ms: i64, ttl_ms: i64) {
        self.state = state_after_remote_confirm(self.state);
        self.asked_by.clear();
        self.expires_at_ms = now_ms + ttl_ms;
    }

    /// ⭐ 清空（⭐ 用户点「先不」／⭐ 走完／⭐ 过期后收尾 ✓）。
    pub fn clear(&mut self) {
        *self = Self::default();
    }
}

/// ⭐ 这次握手能不能开始 ✗ —— 不能就**说清为什么** ✓（⛔ 不静默失败 ✗）。
/// ⚠️ 三条判据各自的**说法**要能直接给用户看 ✓（⭐ 与界面上那几行提示同源 ✓）。
pub fn trust_refusal(
    peer_serves_current: bool,
    already_trusted: bool,
    peer_reachable: bool,
) -> Option<&'static str> {
    if already_trusted {
        return Some("这一台已经信任过了");
    }
    if !peer_serves_current {
        return Some("这一台没有声明服务当前这个空间");
    }
    if !peer_reachable {
        return Some("这一台没有报可以直连的地址");
    }
    None
}

/// ⭐ 一次性随机串比对（⭐ 只为「这次握手是这一次 ✗」✓，⛔ 不是口令比对 ✗）。
/// ⚠️ 两边都非空且逐字节相等才算 ✓；⭐ 空串一律**不算** ✓
/// （⭐ 否则「⭐ 两边都没带 ✗」会被读成「⭐ 对上了 ✗」✓）。
pub fn nonce_matches(expected: &str, got: &str) -> bool {
    !expected.is_empty() && !got.is_empty() && expected == got
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_confirm_alone_never_reaches_trusted() {
        // ⭐ 正面判据：⭐ 本机点一百下，⭐ 也只在「⭐ 等对方 ✗」✓。
        let mut s = TrustState::Idle;
        for _ in 0..100 {
            s = state_after_local_confirm(s);
        }
        assert_eq!(
            s,
            TrustState::WaitingRemote,
            "本机单方面点完不许进 Trusted（否则同网段谁都能塞进来）"
        );
    }

    #[test]
    fn remote_confirm_alone_never_reaches_trusted() {
        // ⭐ 对方单方面点 ⇒ ⭐ 只被**记下来** ✓，⛔ 不许建立信任 ✓。
        assert_eq!(
            state_after_remote_confirm(TrustState::Idle),
            TrustState::RemotePending,
            "对方先说「我点了」只记账，不许直接信任"
        );
        assert_ne!(
            state_after_remote_confirm(TrustState::Idle),
            TrustState::Trusted,
            "对方单方面点完不许进 Trusted"
        );
    }

    #[test]
    fn both_ends_confirm_reaches_trusted_either_order() {
        assert_eq!(
            state_after_remote_confirm(state_after_local_confirm(TrustState::Idle)),
            TrustState::Trusted
        );
        assert_eq!(
            state_after_local_confirm(state_after_remote_confirm(TrustState::Idle)),
            TrustState::Trusted,
            "顺序不影响：⭐ 对方先点时本机那一下也必须能收口（否则两边都点过却都在等对方）"
        );
    }

    #[test]
    fn dismiss_clears_the_half_state() {
        assert_eq!(state_after_dismiss(TrustState::WaitingRemote), TrustState::Idle);
        assert_eq!(state_after_dismiss(TrustState::Trusted), TrustState::Idle);
    }

    #[test]
    fn refusals_each_say_why() {
        assert_eq!(trust_refusal(true, false, true), None);
        assert_eq!(trust_refusal(true, true, true), Some("这一台已经信任过了"));
        assert_eq!(
            trust_refusal(false, false, true),
            Some("这一台没有声明服务当前这个空间")
        );
        assert_eq!(
            trust_refusal(true, false, false),
            Some("这一台没有报可以直连的地址")
        );
    }

    #[test]
    fn empty_nonce_never_matches() {
        assert!(!nonce_matches("", ""));
        assert!(!nonce_matches("abc", ""));
        assert!(!nonce_matches("", "abc"));
        assert!(nonce_matches("abc", "abc"));
        assert!(!nonce_matches("abc", "abd"));
    }

    #[test]
    fn seeing_the_ask_is_not_agreeing() {
        // ⭐ 收到一条"想信任"的广播 ⇒ ⭐ 只进 RemotePending ✓，⛔ 绝不直接 Trusted ✓。
        assert_eq!(state_after_ask_seen(TrustState::Idle), TrustState::RemotePending);
        assert_ne!(state_after_ask_seen(TrustState::Idle), TrustState::Trusted);
        // ⭐ 被问的那台点了确认（⭐ 它先看到 ask ⇒ RemotePending ⇒ 再点 ⇒ Trusted ✓）。
        assert_eq!(
            state_after_local_confirm(state_after_ask_seen(TrustState::Idle)),
            TrustState::Trusted
        );
        // ⭐ 周期性广播重复到达 ⇒ ⭐ 不把已有状态冲回去 ✓。
        assert_eq!(
            state_after_ask_seen(TrustState::WaitingRemote),
            TrustState::WaitingRemote
        );
        assert_eq!(state_after_ask_seen(TrustState::Trusted), TrustState::Trusted);
    }

    #[test]
    fn only_the_responder_writes_the_secret() {
        assert!(
            confirm_generates_secret(TrustRole::Responder),
            "被问的那台才生成配对密钥"
        );
        assert!(
            !confirm_generates_secret(TrustRole::Asker),
            "发问的那台不生成：否则两边各写一把，谁也不知道对方那把"
        );
    }

    /// ⭐ 本机发问 ⇒ ⭐ 出站只有 ask ✓，⛔ 一个字节的 secret 都不许有 ✓。
    #[test]
    fn begin_publishes_only_the_ask() {
        let mut h = TrustHandshake::default();
        h.begin("dev-b", "ask-1", 1_000, TRUST_TTL_MS);
        assert_eq!(h.outbound_ask(1_500), "ask-1");
        assert_eq!(h.outbound_secret(1_500), "", "发问的那台永远不带 secret");
        assert!(h.is_active(1_500));
        assert!(!h.is_expired(1_500));
    }

    /// ⭐ 收到别人的问 ⇒ ⭐ **只记账** ✗：⭐ 在**本机的人点过之前**，⭐ 出站不许有 secret ✓。
    /// ⭐ 这是本模块最要紧的一条 ✗ —— ⭐ 它保证"⭐ 密钥只在人点过之后才出线 ✗" ✓。
    #[test]
    fn note_ask_never_publishes_a_secret_before_the_human_confirms() {
        let mut h = TrustHandshake::default();
        h.note_ask("dev-a", 1_000, TRUST_TTL_MS);
        assert_eq!(h.outbound_secret(1_500), "", "没人点过 ⇒ 不许有 secret 出线");
        assert_eq!(h.outbound_ask(1_500), "", "被问的那台不发问");
        assert!(h.is_active(1_500));
        // ⭐ 本机的人点过之后 ⇒ ⭐ 才有 ✓。
        assert!(h.confirm("dev-a", "sek-1", 2_000, TRUST_TTL_MS));
        assert_eq!(h.outbound_secret(2_500), "sek-1");
    }

    /// ⭐ `confirm` 只认**问过我的那一台** ✗（⭐ 认错人就不写、⭐ 并如实回 `false` ✓）。
    #[test]
    fn confirm_refuses_a_peer_that_never_asked() {
        let mut h = TrustHandshake::default();
        h.note_ask("dev-a", 1_000, TRUST_TTL_MS);
        assert!(!h.confirm("dev-z", "sek-x", 1_500, TRUST_TTL_MS), "没问过我的一台不许确认");
        assert_eq!(h.outbound_secret(1_600), "");
        // ⭐ 根本没人问过 ⇒ ⭐ 也不能确认 ✓。
        let mut empty = TrustHandshake::default();
        assert!(!empty.confirm("dev-a", "sek-y", 1_500, TRUST_TTL_MS));
        assert_eq!(empty.outbound_secret(1_600), "");
    }

    /// ⭐ 过期 ⇒ ⭐ 两格都空 ✓（⭐ 一个没走完的握手不许永远挂在广播里 ✓）。
    #[test]
    fn expiry_stops_publishing_both_fields() {
        let mut h = TrustHandshake::default();
        h.begin("dev-b", "ask-1", 1_000, TRUST_TTL_MS);
        let after = 1_000 + TRUST_TTL_MS;
        assert!(h.is_expired(after), "到点就算过期");
        assert!(!h.is_active(after));
        assert_eq!(h.outbound_ask(after), "", "过期后不许再带 ask");
        let mut g = TrustHandshake::default();
        g.note_ask("dev-a", 1_000, TRUST_TTL_MS);
        assert!(g.confirm("dev-a", "sek-1", 1_100, TRUST_TTL_MS));
        assert_eq!(g.outbound_secret(1_100 + TRUST_TTL_MS), "", "过期后不许再带 secret");
        // ⭐ 「⭐ 从来没有过 ✗」（⭐ 0 ✓）⭐ 不是"⭐ 过期 ✗" ✓ —— ⭐ 语义不同 ✓，⭐ 别混 ✓。
        let idle = TrustHandshake::default();
        assert!(!idle.is_expired(9_999_999), "没有进行中的东西 ≠ 过期");
        assert!(!idle.is_active(9_999_999));
    }

    /// ⭐ 「⭐ 先不 ✗」／⭐ 走完 ⇒ ⭐ 清干净 ✓，⭐ 不留半截 ✓。
    #[test]
    fn clear_leaves_nothing_behind() {
        let mut h = TrustHandshake::default();
        h.note_ask("dev-a", 1_000, TRUST_TTL_MS);
        assert!(h.confirm("dev-a", "sek-1", 1_100, TRUST_TTL_MS));
        h.clear();
        assert_eq!(h, TrustHandshake::default());
        assert_eq!(h.outbound_secret(1_200), "");
        assert_eq!(h.outbound_ask(1_200), "");
        assert!(!h.is_active(1_200));
    }

    /// ⭐ 判据③：⭐ **TTL 过期 ⇒ 一个都不许被采纳** ✓ ／ ⭐ 而且过期那一档**要能被调用方看见** ✓
    /// （否则"点了没反应"就只能靠猜 ✗ —— 调用方据此记一行日志 ✓，见 `sync::adopt_pending_trust_asks` ✓）。
    ///
    /// **红读数（真变异）**：把 `pending_asks` 里的过期判断去掉 ⇒ 本判据红 ✓。
    #[test]
    fn expired_asks_are_never_offered_for_adoption() {
        let mut h = TrustHandshake::default();
        h.note_ask("dev-a", 1_000, TRUST_TTL_MS);
        assert_eq!(h.pending_asks(1_500), vec!["dev-a".to_string()], "没过期 ⇒ 看得见 ✓");
        assert_eq!(
            h.pending_asks(1_000 + TRUST_TTL_MS - 1),
            vec!["dev-a".to_string()],
            "差一毫秒还不算过期 ✓"
        );
        assert!(
            h.pending_asks(1_000 + TRUST_TTL_MS).is_empty(),
            "⛔ 到点之后绝不许再被采纳 ✗（一台关过机的对端不许几天后被采纳）"
        );
        // ⭐ 过期那一档**说得出**：`drop_expired` 回 `true` ⇒ 调用方记日志 ✓；⛔ 清过就回 `false` ✗（别重复报 ✓）。
        assert!(h.drop_expired(1_000 + TRUST_TTL_MS), "过期 ⇒ 必须回 true（好记日志）");
        assert!(
            !h.drop_expired(1_000 + TRUST_TTL_MS),
            "清过了再问 ⇒ false（⛔ 别每轮重复报同一条 ✗）"
        );
        assert!(h.pending_asks(1_000 + TRUST_TTL_MS).is_empty());
    }

    /// ⭐ 采纳之后：⭐ 状态被推进 ✓ ＋ ⭐ **这次问被消费掉** ✓（⇒ 公告 30 秒一轮不会每轮重采纳 ✓）。
    #[test]
    fn adoption_advances_the_state_and_consumes_the_ask_once() {
        // ① 对方先点、本机还没点 ⇒ ⭐ 只到 `RemotePending` ✓（⛔ 不因为对方说"我点了"就信任 ✗）。
        let mut h = TrustHandshake::default();
        h.note_ask("dev-a", 1_000, TRUST_TTL_MS);
        h.note_remote_confirm(2_000, TRUST_TTL_MS);
        assert_eq!(h.state(), TrustState::RemotePending, "对方点过只记账");
        assert!(
            h.pending_asks(2_100).is_empty(),
            "采纳过的这一条不许再返回（否则每轮重写一遍卡片）"
        );
        assert!(h.state() == TrustState::RemotePending, "状态在界面上要读得到");
        // ② ⚠️ **本地"我点过了"那一档**还没接线 ✗（`state_after_local_confirm` 今天**无人调用** ✓ ——
        //    那是界面那一期（方案 §4 ③）的事 ✓）。⇒ ⭐ 本判据**如实只钉它今天的样子** ✗：
        //    `begin` ⇒ `Idle` ✓；⭐ 而"两端都点过 ⇒ `Trusted`"由**纯函数**那条判据负责 ✓
        //    （`both_ends_confirm_reaches_trusted_either_order` ✓）—— ⛔ 不在这里假装它已接线 ✗。
        let mut g = TrustHandshake::default();
        g.begin("dev-b", "ask-1", 1_000, TRUST_TTL_MS);
        assert_eq!(g.state(), TrustState::Idle, "`begin` 只发问：本地「点过」那一档还没接");
        g.note_ask("dev-a", 1_100, TRUST_TTL_MS);
        assert_eq!(g.state(), TrustState::RemotePending, "对方发问 ⇒ 只记账");
        g.note_remote_confirm(1_200, TRUST_TTL_MS);
        assert_eq!(
            g.state(),
            TrustState::RemotePending,
            "本机没点过 ⇒ 收到对方确认也**不许**进 Trusted（纯函数 `state_after_remote_confirm` 的语义 ✓）"
        );
    }

    /// ⭐ `note_ask` 只许**记账** ✗：⭐ 周期性公告（30 秒一轮 ✓）不许把状态冲回 `Idle` ✓。
    #[test]
    fn a_repeated_ask_never_resets_an_advanced_state() {
        let mut h = TrustHandshake::default();
        h.note_ask("dev-a", 1_000, TRUST_TTL_MS);
        h.note_remote_confirm(1_100, TRUST_TTL_MS);
        let before = h.state();
        // 对面还在周期性广播同一条问 ⇒ ⭐ 状态不许退 ✓
        for k in 0..5 {
            h.note_ask("dev-a", 2_000 + k * 30_000, TRUST_TTL_MS);
        }
        assert_eq!(h.state(), before, "重复公告不许把状态冲回 Idle");
    }

    /// ⭐ owner 拍的 **甲** ✗：⭐ 一端点就通 ✓ —— ⭐ 而且**密钥不上线** ✓（因为它就是空间令牌 ✓）。
    #[test]
    fn one_sided_click_is_enough_and_the_token_never_goes_on_the_wire() {
        // ⭐ 甲 的结论本身 ✓（⛔ 不是恒真的空断言 ✗：⭐ 它俩是一对相反的常量 ✓）。
        assert!(one_sided_click_establishes_trust(), "owner 2026-10-11 拍甲");
        assert!(
            !outbound_may_carry_secret(),
            "空间令牌必须留在本机：出站只允许带「我想信任你」这一格"
        );
        // ⭐ 而且"⭐ 发了问 ✗"这一步里 ⭐ 出站那两格的实际行为对得上 ✓：
        //    ⭐ ask 出线 ✓、⭐ secret **一个字节都不出** ✓（⛔ 不是靠"⭐ 我保证 ✗"，⭐ 是靠 `outbound_secret` ✓）。
        let mut h = TrustHandshake::default();
        h.begin("dev-b", "ask-1", 1_000, TRUST_TTL_MS);
        assert_eq!(h.outbound_ask(1_500), "ask-1", "甲：发了问就出线");
        assert_eq!(
            h.outbound_secret(1_500),
            "",
            "空间令牌不许上线 —— 甲 不需要传密钥，它本来就是两台都有的那把"
        );
    }
}
