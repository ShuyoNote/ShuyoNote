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
/// ⭐⭐ **2026-10-26（owner 拍 A：两边各点一次确认，R208）** ✗：⭐ 撤销 2026-10-17 的「一方配对成功，就双向通」——
/// 看到 ask **不算配对** ✓；要双向 ⇒ 两边各点「接入」并确认 ✓（这一格的人话也随之改 ✓）。
pub fn trust_state_view(state: TrustState, active: bool, pending: usize) -> MeshTrustStateView {
    let (state, message) = match state {
        TrustState::Idle => (
            "idle",
            "还没有配对过设备 —— 在「附近的设备」里点那一行右端的「接入」，核对比对码一致后确认即可",
        ),
        TrustState::Trusted => (
            "trusted",
            "已经配对过（⭐ 2026-10-26 owner 拍 A：两边各点一次确认，双向才通 ✓）—— 谁在名单里看下面那份「这台机器认了 N 台设备」",
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
    let (state, active, pending) =
        crate::lan_state::with_trust(|h| (h.state(), h.is_active(now), h.pending_asks(now).len()));
    trust_state_view(state, active, pending)
}

/// ⭐⭐ **2026-10-17**：⭐ **只开一轮比对** ✗ —— ⭐ 生成 `trust_ask` ＋ 让本机能按那一台读到它 ✓，
/// ⛔ **不登记信任** ✗（⭐ 登记仍然是 [`mesh_trust_begin`] 那一下 ✓）。
///
/// ## ⚠️ 为什么必须有这一条命令（owner 2026-10-17 真机："点接入了，也没有（码）" ✗）
/// 比对码 ＝ `f(本机公钥, 对面公钥, 这一轮 trust_ask)` ✓；而 `trust_ask` 原来**只在**
/// `mesh_trust_begin`（登记 ＋ 广播 ✓）里生成 ✗ ⇒ ⭐ 而登记是**信任动作** ✓，必须等**人看过码**
/// 之后才做 ✓ ⇒ ⭐ 结构性死锁：⭐ 码要在"登记之前"看到 ✓，而码的料只在"登记那一格里" ✗。
/// ⇒ ⭐ 这一条把"开一轮"和"登记"拆开 ✓：⭐ 前端点「接入」调它 ⇒ 码可读 ✓；
///   ⭐ 点「码对得上，确认」才调 `mesh_trust_begin` ⇒ 登记 ✓。
///
/// ## ⛔ 它**不写库**、⛔ **不碰信任名单**
/// ⭐ 只推进 `lan_state` 里那格进程内的握手（⭐ `TrustHandshake::prepare` ✓ —— ⛔ 连 `state` 都不动 ✓）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct MeshTrustPrepare {
    /// ⭐ `prepared: false` ⇒ 没开成（⭐ 如没给对面 ✓）；理由在人话里 ✓。
    pub prepared: bool,
    /// ⭐ 一句给用户看的话 ✓（⭐ 人话 ✓，⛔ 不含内部标识 ✗）。
    pub message: String,
}

#[tauri::command]
pub fn mesh_trust_prepare(peer_device_id: String) -> Result<MeshTrustPrepare, String> {
    let peer = peer_device_id.trim().to_string();
    if peer.is_empty() {
        return Ok(MeshTrustPrepare {
            prepared: false,
            message: "不知道要跟哪一台核对（没有指定对面）".to_string(),
        });
    }
    let now = crate::lan_state::now_ms();
    // ⭐⭐ **2026-10-17 第二版（重要 ✓）**：⭐ **已经有这一轮的 ask ⇒ 采纳它，不另生成** ✗。
    //
    // ⚠️ 为什么必须这样：公告 30 秒一轮（`lan_state::ANNOUNCE_INTERVAL_MS` ✓）⇒ 两台机器
    //   几乎不可能同时互相听到 ✓。真实顺序是：甲点「接入」⇒ 甲的 ask 广播出去（≤30 秒）⇒
    //   乙收到、点「接入」✓。⭐ 若乙这时**自己新造一串** ⇒ 两边码必然不同 ⇒ 永远对不上 ✗
    //   （这正是"点接入了也没有"的第二半 ✓）。⇒ ⭐ 有现成那串（自己发起的 ／ 对面发起的 ✓）
    //   **就沿用它** ✓；只有一发都没有时才新造 ✓。
    // ⭐ 顺带一个好处：重复点「接入」是**幂等**的（同一轮 ⇒ 同一串 ⇒ 同一个码 ✓）。
    let existing = crate::lan_state::with_trust(|h| h.ask_for(&peer, now));
    let ask = existing.unwrap_or_else(new_trust_ask);
    crate::lan_state::with_trust(|h| {
        h.prepare(&peer, &ask, now, crate::pairing_trust::TRUST_TTL_MS)
    });
    Ok(MeshTrustPrepare {
        prepared: true,
        message: "已发起这一轮比对（还没登记信任 —— 码对上之后再确认）".to_string(),
    })
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
    // ⭐ **2026-10-26（owner：个人版不该卡在同一空间）**：个人档是**设备级信任** ⇒ 当前空间不同也照样能配；
    //    但门是按协议空间存公钥的 ⇒ 必须给**所有正在运行的个人空间**都加上，否则别的空间仍 401。
    //    团队档不动（仍是当前空间那一扇门）。
    if scope.device_level {
        let mut protos = crate::lan_state::personal_proto_spaces(&c);
        if !protos.iter().any(|p| p == &scope.space) {
            protos.push(scope.space.clone());
        }
        for proto in protos {
            let _ = crate::mesh::add_paired_pubkey(&proto, &peer, &pk);
        }
    } else {
        crate::mesh::add_paired_pubkey(&scope.space, &peer, &pk)?;
    }
    // ⚠️ 口令**不再需要** ✗：旧口径下这里要先把空间的共用口令读出来当"配对密钥" ✓；
    //   ⭐ 第 3 步之后**信任与口令无关** ✓（门认签名 ✓）⇒ ⛔ 没有口令也照样能信任 ✓
    //   （⚠️ 那是**有意的**：口令从此只在"旧那一档"里有意义 ✓ —— 见 `authorized` 那一段 ✓）。
    // ⭐ 那条 ask 照旧发 ✗：⭐ 它的含义变了 —— ⭐ 让**对面知道"你允许了它"** ✓
    //   （⭐ 好让它能如实显示"对面允许你来拿"，⛔ **不是**"它在请求你同意" ✗）。
    // ⭐⭐ **2026-10-25（owner：「配对码还是不一样」→ 按建议改）**：这里是**第二处**造 ask 的地方，
    //   原来它**无条件** `new_trust_ask()` ⇒ 每点一次「确认」码就换一串 ⇒ 两端永远在被比较的两串之间漂。
    //   判据（真机已复现）：同一会话连续调两次，`[pairing]` 行里的 `my_ask` 长度一样但**内容变了**，
    //   于是码也变（`code=2456…` → `code=8311…`）。
    //   ⇒ 与 `mesh_trust_prepare` **同一口径**：这一轮已经有 ask（自己发起的／对面发起的）就沿用它，
    //     只有一发都没有时才新造 ✓。
    let now = crate::lan_state::now_ms();
    let existing = crate::lan_state::with_trust(|h| h.ask_for(&peer, now));
    let ask = existing.unwrap_or_else(new_trust_ask);
    crate::lan_state::with_trust(|h| {
        h.begin(&peer, &ask, now, crate::pairing_trust::TRUST_TTL_MS);
    });
    Ok(MeshTrustOutcome {
        outcome: "trusted".to_string(),
        message: "配对成功：这一侧已开（允许它来拿我的）✓\n\
                  ⚠️ 对面也要点一次「接入」并核对确认，**双向**才通（owner 2026-10-26 拍 A）"
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
        assert!(
            a.chars().all(|ch| ch.is_ascii_hexdigit()),
            "只许十六进制：{a}"
        );
        assert_ne!(a, b, "两次握手串不许相同（⛔ 那不是一次性 ✗）");
        // ⚠️ 它是"一次性"的凭据本身 ⇒ ⛔ 不许退化成空串（空串在 `nonce_matches` 里一律不算对上 ✓）。
        assert!(!a.is_empty());
    }
}
