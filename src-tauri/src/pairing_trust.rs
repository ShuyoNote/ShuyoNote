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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustState {
    /// ⭐ 还没开始（⭐ 或已被放弃 ✓）。
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
}
