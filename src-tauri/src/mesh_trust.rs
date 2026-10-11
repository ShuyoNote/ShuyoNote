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

/// ⭐ 这次信任的结果 ✓ —— ⭐ 给前端直接显示 ✓（⛔ 里面不许出现裸设备号／空间号 ✗）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct MeshTrustOutcome {
    /// ⭐ `trusted` ／ `not_configured` ／ `no_token` ／ `bad_peer` ✓（⭐ 前端的三种处置都靠它 ✓）。
    pub outcome: String,
    /// ⭐ 一句能给用户看的话 ✓（⭐ 人话 ✓，⛔ 不含内部标识 ✗）。
    pub message: String,
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
) -> Result<MeshTrustOutcome, String> {
    let peer = peer_device_id.trim().to_string();
    if peer.is_empty() {
        return Ok(MeshTrustOutcome {
            outcome: "bad_peer".to_string(),
            message: "不知道要信任哪一台设备（没有指定对面）".to_string(),
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
    // ⭐ 令牌就是那把"⭐ 配对密钥 ✗" ✓（⭐ 两台都从空间密钥推得出 ✓，⭐ 所以**不上线** ✓）。
    let token = crate::mesh::settings(&c, &scope.space)
        .token
        .unwrap_or_default()
        .trim()
        .to_string();
    if token.is_empty() {
        return Ok(MeshTrustOutcome {
            outcome: "no_token".to_string(),
            message: "这个空间还没设口令 ⇒ 先去同步设置里设一个，两台要用同一个".to_string(),
        });
    }
    // ⭐ 唯一实现 ✓ —— ⭐ 三件一起做 ✓（⭐ 少一件就是"⭐ 配对成功却 401 ✗"✓）。
    crate::sync::remember_peer_card(&c, &scope.space, &peer, &token)?;
    // ⭐ 甲 ✗：⭐ 把"⭐ 我想信任你 ✗"发出去 ✓（⭐ ⛔ 令牌不在这一格里 ✓）。
    let ask = new_trust_ask();
    let now = crate::lan_state::now_ms();
    crate::lan_state::with_trust(|h| {
        h.begin(&peer, &ask, now, crate::pairing_trust::TRUST_TTL_MS);
    });
    Ok(MeshTrustOutcome {
        outcome: "trusted".to_string(),
        message: "已信任这台设备：它和你在同一个网络里时就能直接连".to_string(),
    })
}

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
