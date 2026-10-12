// ⭐ 2026-10-11（owner 拍「甲：一端点就通，图④为准」）：⭐ 一键信任的**命令层** ✗。
//!
//! ## 它做什么
//! ⭐ 用户在图④ 那一屏点「信任这台设备」⇒ ⭐ **一端点就通** ✓：
//!   ① ⭐ 用**这台空间已有的网格令牌**把对面登记好 ✓ ⇒ ⭐ 调 `sync::remember_peer_card`
//!      （⭐ 那是"⭐ 登记对面 ✗"的**唯一实现** ✓：⭐ 卡 ＋ ⭐ 出示的那份 ＋ ⭐ 加进跑着的门 ✓；
//!      ⭐ 它的头部写着「⭐ 一处实现、两处调用 ✗ … ⛔ 两处各写一遍迟早会漂 ✗」⇒ ⛔ 这里不许自己写那三步 ✓）；
//!   ② ⭐ 发一条"⭐ 我想信任你 ✗"到广播上 ✓（⭐ `LanAnnounce::trust_ask` ✓）。
//!
//! ## ⚠️ 两条**不许省**的话
//! 1. ⭐ **空间令牌不上线** ✗：⭐ 那把"⭐ 配对密钥 ✗"就是**空间自己的网格令牌** ✓
//!    （⭐ 两台都从空间密钥推得出 ✓）⇒ ⭐ 广播里**只许**出现"⭐ 我想信任你 ✗"这一格 ✓
//!    （⭐ 判据 `pairing_trust::outbound_may_carry_secret()` ＝ `false` ✓ 钉这条 ✓）。
//! 2. ⚠️ **甲 的代价已写进规格** ✗（`docs/plans/2026-10-11-one-click-trust-decision.md` §2 ✓）：
//!    ⭐ 去掉逐位对码与两端各点之后 ✓，⭐ **同网段里能喊出这台设备名的人 ＋ ⭐ 用户在屏幕上点了一下 ⇒ 就可能建立信任** ✓
//!    ⇒ ⭐ 兜底只剩两条（⭐ 身份摆出来 ＋ ⭐ 逐台可撤回 ✓），⭐ 界面上必须都在 ✓。
//!
//! ## ⚠️ 平台边界
//! ⭐ 只有桌面有发现层（⭐ Web 没有 UDP 那一层 ✓）⇒ ⭐ 非桌面前端**根本不该调它** ✓；
//! ⭐ 真调了 ⇒ ⭐ 这里照实回"⭐ 这台设备没有可配对的同步档案 ✗"那一档 ✓（⭐ 不假成功 ✓）。

use tauri::State;

use crate::pairing_trust::TrustState;

/// ⭐ 这次信任的结果 ✓ —— ⭐ 给前端直接显示 ✓（⛔ 里面不许出现裸设备号／空间号 ✗）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct MeshTrustOutcome {
    /// ⭐ `trusted` ／ `not_configured` ／ `no_token` ／ `bad_peer` ✓（⭐ 前端的三种处置都靠它 ✓）。
    pub outcome: String,
    /// ⭐ 一句能给用户看的话 ✓（⭐ 人话 ✓，⛔ 不含内部标识 ✗）。
    pub message: String,
}

/// ⭐⭐ **2026-10-11（任务 B）：信任走到哪一步的读数** ✗ —— ⭐ 给界面读 ✓。
///
/// ⚠️ 为什么要有它 ✗：⭐ `TrustHandshake::state()` 一直在内核里推进 ✗，而**前端没有读它的口子** ✓
/// （`commands.ts` 里原先只有 `mesh_trust_begin` ✓）⇒ ⭐ "点了到底通没通"在界面上**说不出来** ✓。
///
/// ⛔ **不含任何内部标识** ✗（`INV-UI-copy-no-internal-ids` ✓）：⭐ 只回"走到哪一步" ＋ ⭐ 人话 ＋
/// ⭐ **有几条在等采纳**（⭐ 一个数 ✓，⛔ 不给设备号 ✗）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshTrustStateView {
    /// ⭐ `idle` ／ `trusted` ✓（⭐ 前端的显示靠它 ✓，⛔ 不靠猜人话 ✓）。
    pub state: String,
    /// ⭐ 一句能给用户看的话 ✓（⭐ 人话 ✓，⛔ 不含内部标识 ✗）。
    pub message: String,
    /// ⭐ 有没有**进行中**的握手 ✓（⭐ 过期的不算 ✓）—— 界面用它说"刚点了、正在处理" ✓。
    pub active: bool,
    /// ⭐ 有几条「我想信任你」**正等着被采纳** ✓（⭐ 只给**条数** ✗，⛔ 不给设备号 ✓）。
    pub pending: usize,
}

/// ⭐ 把内核那两档变成**给人看的两格** ✗ —— ⭐ **纯函数** ✓（⭐ 判据不用起宿主就能钉住"哪档说哪句话" ✓）。
///
/// ⚠️ 兜底那一档要说**下一步做什么** ✗，⛔ 不是只说"没有" ✗（owner 口径：界面上的话要能照着做 ✓）。
///
/// ⭐⭐ **2026-10-12（第 3 步改口径 ✓）** ✗：⭐ 那两句**声称的是双向** ✗ ⇒ 与 owner 的口径矛盾 ⇒ 换掉 ✓
/// （「『信任这台设备』＝『**允许它来拿我的**』」✓ ＋「**单方信任 ⇒ 同步是单向的**」✓）——
/// ⚠️ 这一格是**进程级的一个槽** ✗（它分不出方向 ✓）⇒ ⭐ 所以人话里**必须**把"方向"说出来 ✓，
/// ⛔ 不许再声称"已经建立信任"✗（那是上一版的说法 ✓）。
pub fn trust_state_view(state: TrustState, active: bool, pending: usize) -> MeshTrustStateView {
    let (state, message) = match state {
        TrustState::Idle => (
            "idle",
            "还没有允许过哪台设备来拿你的内容 —— 在「附近的设备」里点一下「接入」就是允许它",
        ),
        TrustState::Trusted => (
            "trusted",
            "已经有过信任动作了（⭐ 一方点一次只开一个方向：要双向，两台各点一次）\
             —— 谁在名单里看下面那份「这台机器认了 N 台设备」",
        ),
    };
    MeshTrustStateView {
        state: state.to_string(),
        message: message.to_string(),
        active,
        pending,
    }
}

/// ⭐⭐ **2026-10-11（任务 B）：读一眼"信任走到哪一步"** ✗（⭐ 只读 ✓，⛔ 一个字节都不写 ✗）。
///
/// ⚠️ **没有 `space_id` 参数** ✗ —— ⭐ 这是**本机**的握手状态 ✓（`lan_state` 里那一格是进程级的 ✓），
/// ⛔ 不是"某个空间认了谁" ✗（那个在 `mesh_set_config` 的 `paired` 里 ✓，另有一处 ✓）。
#[tauri::command]
pub fn mesh_trust_state() -> MeshTrustStateView {
    let now = crate::lan_state::now_ms();
    let (state, active, pending) = crate::lan_state::with_trust(|h| {
        (h.state(), h.is_active(now), h.pending_asks(now).len())
    });
    trust_state_view(state, active, pending)
}

/// ⭐ 把随机字节写成十六进制 ✗（⭐ 自带小函数 ✓：⛔ 不为一个 nonce 引依赖 ✓）。
fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

/// ⭐ 一次握手的随机串 ✗（⭐ 32 字节 ⇒ ⭐ 64 个十六进制字符 ✓，⭐ 人看不见它 ✓，⭐ 它只用来配"⭐ 这一次 ✗"✓）。
fn new_trust_ask() -> String {
    hex_lower(&crate::crypto::random_32())
}

/// ⭐ **一键信任** ✗：⭐ 点一下就通 ✓（⭐ owner 拍的甲 ✓）。
///
/// ⚠️ **它一次也不碰** `device_pair_export` ／ `device_pair_import` ✗（⭐ 那两个照旧服务"⭐ 抄码 ✗"那条路 ✓）。
#[tauri::command]
pub fn mesh_trust_begin(
    db: State<'_, crate::db::Db>,
    space_id: String,
    peer_device_id: String,
    // ⭐⭐ 2026-10-12（设备身份第 3 步 ✓）：⭐ 对面那一台的**公钥**（十六进制 ✓）✗ ——
    //   ⭐ 界面从「附近的设备」里那一台的公告拿 ✓（公钥**不是秘密** ✓，它随公告走 ✓）。
    peer_pubkey: String,
) -> Result<MeshTrustOutcome, String> {
    let peer = peer_device_id.trim().to_string();
    if peer.is_empty() {
        return Ok(MeshTrustOutcome {
            outcome: "bad_peer".to_string(),
            message: "不知道要信任哪一台设备（没有指定对面）".to_string(),
        });
    }
    // ⭐ 2026-10-12（第 3 步）：⭐ "信任"的产物**不再是"共用口令的哈希"** ✗，⭐ 而是**它的公钥** ✗
    //   ⇒ ⭐ 门此后**验签** ✓（⭐ 谁都不能靠"知道口令"混进来 ✓ —— 那是 ⓒ 落地后的完整形态 ✓）。
    let pk = peer_pubkey.trim().to_ascii_lowercase();
    if !crate::device_key::is_public_key_hex(&pk) {
        return Ok(MeshTrustOutcome {
            outcome: "no_identity".to_string(),
            message: "这一台还没报出它的身份（⭐ 它需要这一版的程序、并且开过一次设备直连 ✓）\
                      —— 现在信任它的话，**它凭什么证明自己是它**就无从谈起 ✓"
                .to_string(),
        });
    }
    let c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    // ⭐ 用户给的是**空间 id** ✓；⭐ 库里那套一律用**协议空间** ✗ ⇒ ⭐ 走那一个既有入口换算 ✓
    //    （⛔ 不自己拼名字 ✗：`mesh_scope_at` 是"⭐ 空间 id ⇒ 那套 ✗"的唯一入口 ✓）。
    let scope = match crate::sync::mesh_scope_at(&c, Some(space_id.as_str())) {
        Ok(s) => s,
        Err(e) => {
            return Ok(MeshTrustOutcome {
                outcome: "not_configured".to_string(),
                message: format!("这台设备还没有可配对的同步档案 ⇒ 先把这个空间同步开起来\n{e}"),
            })
        }
    };
    // ⭐⭐ **"允许它来拿我的"就落在这一行** ✗：
    //   ⭐ 行键照**同一处判定**算 ✓（个人档 ⇒ 设备级那一行 ✓，方案 §10.3 ✓），
    //   ⛔ 不在这里反推"是不是个人档" ✗。
    let row = crate::mesh::paired_row_key(&scope.space, scope.device_level);
    crate::db::pair_pubkey(&c, row, &peer, &pk)?;
    // ⭐ 跑着的门**也要认它** ✗ —— ⛔ 只写库不算 ✗（那正是"配对成功却 401" ✓，与 `add_paired` 同一条纪律 ✓）。
    crate::mesh::add_paired_pubkey(&scope.space, &peer, &pk)?;
    // ⚠️ 口令**不再需要** ✗：旧口径下这里要先把空间的共用口令读出来当"配对密钥" ✓；
    //   ⭐ 第 3 步之后**信任与口令无关** ✓（门认签名 ✓）⇒ ⛔ 没有口令也照样能信任 ✓
    //   （⚠️ 那是**有意的**：口令从此只在"旧那一档"里有意义 ✓ —— 见 `authorized` 那一段 ✓）。
    // ⭐ 那条 ask 照旧发 ✗：⭐ 它的含义变了 —— ⭐ 让**对面知道"你允许了它"** ✓
    //   （⭐ 好让它能如实显示"对面允许你来拿"，⛔ **不是**"它在请求你同意" ✗）。
    let ask = new_trust_ask();
    let now = crate::lan_state::now_ms();
    crate::lan_state::with_trust(|h| {
        h.begin(&peer, &ask, now, crate::pairing_trust::TRUST_TTL_MS);
    });
    Ok(MeshTrustOutcome {
        outcome: "trusted".to_string(),
        message: "已允许这台设备来拿你的内容（⭐ 单方就算数 ✓）。\
                  ⚠️ 反过来你要拿它的，得**它那边也允许你一次** ✓ —— 那时候才是双向 ✓"
            .to_string(),
    })
}

/// ⚠️ 2026-10-12：本模块**原先**有一份自己的"公钥形状"判定（`fn is_pubkey_hex` ✓）——
/// ⭐ 现在**整条删掉** ✗，改用 [`crate::device_key::is_public_key_hex`] ✓
/// （⭐ 一处实现 ✓：抄码载荷那边按**同一把尺**判 ✓；⛔ 两处各写一份 ⇒ 迟早"这边收、那边拒" ✓）。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_lower_writes_two_chars_per_byte() {
        assert_eq!(hex_lower(&[]), "");
        assert_eq!(hex_lower(&[0x00, 0x0f, 0xff, 0xa5]), "000fffa5");
    }

    #[test]
    fn a_trust_ask_is_long_and_hex_and_never_repeats() {
        let a = new_trust_ask();
        let b = new_trust_ask();
        assert_eq!(a.len(), 64, "32 字节 ⇒ 64 个十六进制字符");
        assert!(a.chars().all(|ch| ch.is_ascii_hexdigit()), "只许十六进制：{a}");
        assert_ne!(a, b, "两次握手串不许相同（⛔ 那不是一次性 ✗）");
        // ⚠️ 它是"一次性"的凭据本身 ⇒ ⛔ 不许退化成空串（空串在 `nonce_matches` 里一律不算对上 ✓）。
        assert!(!a.is_empty());
    }
}
