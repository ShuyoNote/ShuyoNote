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
/// ⭐⭐ **甲（owner 2026-10-11「一端点就通」）之后只剩两档** ✗ —— 原先的 `WaitingRemote`（⭐ 等对方 ✓）
/// 与 `RemotePending`（⭐ 对方先点 ✓）**已随旧口径一起退休** ✗ ✓（⭐ 甲 之下没有"⭐ 一端点了、⭐ 另一端还没点 ✗"
/// 这种半截状态 ✓，⭐ 所以那两档**不可达** ⇒ 留着就是"⭐ 已废的形状 ✗"✓）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TrustState {
    /// ⭐ 还没开始（⭐ 或已被放弃 ✓）。
    #[default]
    Idle,
    /// ⭐ 通了 ✗（⭐ 本机点过 ✓ ／ ⭐ 收到对方的"⭐ 我想信任你 ✗"✓ ／ ⭐ 两端都动过 ✓ —— ⭐ 任一条即达 ✓）。
    Trusted,
}

/// ⭐ 本机点「信任这台设备」之后的状态 ✓。
/// ⭐⭐ **甲（owner 2026-10-11 二次拍板，逐字「甲：一端点就通」）** ✗：⭐ 点一下**就算通** ✓ ——
/// ⚠️ 原先那句"⭐ 只有已经知道对方点过才进 `Trusted` ✗、⭐ 单方面点完永远不算 ✗"**已被取代** ✗
/// （⭐ 代价当初记在 `docs/plans/2026-10-11-one-click-trust-decision.md` §2 ✓：⭐ 兜底只剩
/// 「⭐ 身份在信任前可见 ✓」＋「⭐ 逐台可撤回 ✓」✓ —— ⛔ 不是悄悄消失的 ✗）。
pub fn state_after_local_confirm(current: TrustState) -> TrustState {
    match current {
        // ⭐ 甲：本机这一点就够 ⇒ 直接通 ✓（⭐ 再点是**幂等** ✓，⛔ 不许来回抖）。
        TrustState::Idle => TrustState::Trusted,
        TrustState::Trusted => TrustState::Trusted,
    }
}

/// ⭐ 对方那边动了（⭐ 它点了 ／ ⭐ 它发来「我想信任你」✓）之后的状态 ✓。
/// ⭐ 甲 之下**这一侧自动采纳** ✗ ⇒ ⭐ 直接通 ✓（⭐ "不问那台的人" ✓）。
pub fn state_after_remote_confirm(current: TrustState) -> TrustState {
    match current {
        // ⭐ 甲：对面动过 ⇒ 自动采纳 ⇒ 直接信 ✓（⭐ 原先"⭐ 只记成 `RemotePending` ✗"已取代 ✓）。
        TrustState::Idle => TrustState::Trusted,
        TrustState::Trusted => TrustState::Trusted,
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

/// ⭐ 看到对方的「想信任」之后的状态 ✓。
/// ⭐⭐ **甲** ✗：⭐ 看到就是采纳 ⇒ ⭐ 直接通 ✓（⭐ "不问那台的人" ✓）。
/// ⚠️ 原先那句"⭐ 看到 ≠ 同意 ✗、⭐ 一定要本机的人再点一下 ✓"**已被 owner 的甲取代** ✗ ✓。
pub fn state_after_ask_seen(current: TrustState) -> TrustState {
    match current {
        TrustState::Idle => TrustState::Trusted,
        // ⭐ 已经信任 ⇒ ⭐ 不因"⭐ 又收到一遍广播 ✗"而变化 ✓（⭐ 广播是周期性的 ✓）。
        TrustState::Trusted => TrustState::Trusted,
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
/// ⇒ ⭐ 甲 的真实形状是：⭐ 点的那一侧 ⭐ 用**已有的令牌**登记对面 ✓（`remember_peer_card` ✓）。
/// ⭐⭐ **2026-10-13（P-4 片①）按代码实际行为订正** ✗ —— 这一句原来是「另一位收到 `trust_ask` ⇒
/// ⭐ **自动采纳** ✓」，⚠️ 它**半对半错** ✗（以代码为准，⛔ 不凭注释 ✗）：
/// · ✅ 还成立的：⭐ 收到 ask ⇒ ⭐ 本机**状态**推进到已信任 ✓（`state_after_ask_seen` ✓，判据
///   `remote_side_acting_alone_also_reaches_trusted` ✓ 仍在 ✓）；
/// · ⭐⭐ **2026-10-17（owner 拍「一方配对成功，就双向通」）** ✗：⭐ 「自动采纳」那半**又成立**了 ✓
///   —— ⭐ 收到 ask ⇒ ⭐ 这一侧**也把对面登记上** ✓（`sync::note_pending_trust_asks` ⇒
///   `pair_pubkey` ＋ `add_paired_pubkey` ✓；判据 `receiving_a_trust_ask_registers_the_asker_so_both_directions_work` ✓）。
///   ⚠️ 2026-10-12 那条「登记只在点的那一侧」**已被推翻** ✓（真机来由：AMD 侧配对后拉本机每轮 401 ✓）。
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

/// ⭐⭐ **P-4 片①（2026-10-13）**：⭐ 把**两台的身份 ＋ 这一次的 nonce** 拼成**一段文本** ⇒
/// ⭐ 交给既有的 [`crate::pairing::check_code`] 派生出**两端一致**的比对码 ✗。
///
/// ## ⭐ 为什么只需要这一小片（⭐ 前一位逐字量过 ✓，别重查 ✗）
/// ⭐ **一次性 nonce 已经存在** ✗ ⇒ ⭐ 就是 `lan::LanAnnounce.trust_ask`（`lan.rs:150` ✓）：
/// · 生成 ＝ `mesh_trust::new_trust_ask()`（`mesh_trust.rs:108` ✓，⭐ 32 字节随机 ⇒ 64 个十六进制字符 ✓；
///   ⭐ 随机源只在 `crypto::random_32()`（`crypto.rs:263` ✓，⭐ `OsRng` 只在这一层 ✓））；
/// · 捎带 ＝ `lan_state.rs:550` 逐字 `a.trust_ask = ask;` ✓；
/// · ⭐ "**每轮不同**"**已有判据** ＝ `mesh_trust.rs:194-196`（`a_trust_ask_is_long_and_hex_and_never_repeats` ✓）。
/// ⇒ ⭐ ⭐ **本片不加任何字段** ✗、⛔ **不碰 `LanAnnounce` 的结构** ✗（⭐ 复用那一格更安全 ✓）；
/// ⭐ 也⛔ **不升 `WIRE_VERSION`** ✗（既有锁：`lan.rs:1936-1983` ＋ `mesh.rs:2752-2763` ✓）。
///
/// ## ⚠️ 三条承重口径
/// 1. ⭐ **两端必须算出同一个码** ✗ ⇒ ⭐ 顺序**固定**：两把公钥按 ⭐ **字典序**排 ✓
///    （⛔ 不按"我／他"排 ✗ —— 那两端就反了 ✓；⭐ 相同也无妨：交换后是同一个串 ✓）；
/// 2. ⭐ **整段参与** ✓（那是 `check_code` 自己的承重性质：载荷里**任一字节**变了 ⇒ 码就变 ✓）。
///    ⇒ ⭐ 于是 ⭐ **换一个 `trust_ask` ⇒ 码必然不同** ✓（重放/换 nonce 才看得出差别 ✓）；
/// 3. ⚠️ 域分隔**不在这里** ✗：`check_code` 自己用 `CHECK_DOMAIN`（`pairing.rs:344` ✓）＋ 一个 `0u8`
///    隔开域（`pairing.rs:360` ✓）⇒ ⛔ 别在这儿再拼一个自己的前缀 ✗（那会变成两份口径 ✓）。
///
/// ## ⚠️ 一次如实交代（⭐ 免得被读成"6 位码做完了" ✗）
/// ⭐ 本函数派生的是 ⭐ **既有那段 20 位十进制** ✓（`CHECK_CODE_MIN_BITS = 60` 照旧 ✓）；
/// ⭐ ⛔ **不是** owner 口径里那个「**6 位码**」✗ —— ⭐ 设计稿逐字：⭐ **短码需要 PAKE，而 PAKE 没做** ✓
/// ⇒ ⭐ 那一格归后续 ✓，⛔ 本片不假装做了 ✗。
///
/// ⚠️ 本函数是 ⭐ **纯函数** ✗（⛔ 不读库、⛔ 不取本机公钥 ✗）：本机那把由**调用方**给 ✓
/// （`device_key` 的 `public_key_hex()` ✓／⭐ 对方那把**就在公告里** ✓）⇒ ⭐ 判据不起宿主就能钉住"两端一致" ✓。
/// ⭐⭐ **2026-10-25（真机：配对码对不上）**：两端各自生成了自己的 `trust_ask`
/// ⇒ 各自算出来的码**必然不同**。这里给出**唯一的挑 ask 规则**（两端算出来必须同一个）：
///
/// ```text
/// ① 两边都有 ask ⇒ 按 **device_id 字典序小的一方**那份（确定性，两端算出同一个）
/// ② 只有一边有 ⇒ 用那一份（另一方还没开始握手时不至于算不出）
/// ③ 都没有 ⇒ None（⛔ 不拿空串凑一个码）
/// ```
///
/// ⚠️ 为什么不用"谁先点接入"：那个信息今天**不在**两端都能读到的同一份数据里；
///   而 device_id 两端各有一份（自己的 + 公告里的）⇒ 谁都能算出同一个顺序 ✓。
pub fn pick_trust_ask<'a>(
    my_ask: &'a str,
    peer_ask: &'a str,
    my_device_id: &str,
    peer_device_id: &str,
) -> Option<&'a str> {
    let mine = my_ask.trim();
    let theirs = peer_ask.trim();
    match (mine.is_empty(), theirs.is_empty()) {
        (true, true) => None,
        (false, true) => Some(mine),
        (true, false) => Some(theirs),
        (false, false) => {
            // ⚠️ 两端各自比较同一对数 ⇒ 必然选出同一份（字典序小的那台当"发起方"）
            if my_device_id.trim() <= peer_device_id.trim() {
                Some(mine)
            } else {
                Some(theirs)
            }
        }
    }
}

/// ⭐ 按 [`pick_trust_ask`] 的规则算码（两端都调它 ⇒ 码一致）。
pub fn pairing_code_reading_both(
    my_pubkey_hex: Option<&str>,
    peer_pubkey_hex: &str,
    my_ask: &str,
    peer_ask: &str,
    my_device_id: &str,
    peer_device_id: &str,
) -> PairingCodeReading {
    let ask = pick_trust_ask(my_ask, peer_ask, my_device_id, peer_device_id).unwrap_or("");
    pairing_code_reading_of(my_pubkey_hex, peer_pubkey_hex, ask)
}

pub fn pairing_code_for(my_pubkey_hex: &str, peer_pubkey_hex: &str, trust_ask: &str) -> String {
    let me = my_pubkey_hex.trim().to_ascii_lowercase();
    let peer = peer_pubkey_hex.trim().to_ascii_lowercase();
    // ⭐ 字典序（⭐ 两端各算一次 ⇒ 必须落在同一个顺序上 ✓）
    let (a, b) = if me <= peer { (me, peer) } else { (peer, me) };
    // ⚠️ 用 `\n` 分隔 ✗：公钥是定长十六进制、`trust_ask` 是无换行的随机十六进制 ✓
    //   ⇒ ⛔ 不存在"两段拼起来产生歧义" ✓（⛔ 也不需要再加自己的域串 ✗，见上第 3 条 ✓）。
    let payload = format!("{a}\n{b}\n{}", trust_ask.trim());
    crate::pairing::check_code(&payload)
}

/// ⭐ **P-4 片③-a（2026-10-14）**：⭐ 命令要上抛的那一格 ✗ —— ⭐ `code: None` ＝ **读不到** ✓
///   （⛔ 不硬凑一个码 ✗ —— ⭐ 与既有的"读不到 ≠ 0"同一条脾气 ✓）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PairingCodeReading {
    /// ⭐ 比对码（20 位十进制、4 位一组 ✓）；`None` ＝ ⭐ **这一格今天读不到** ✓。
    pub code: Option<String>,
    /// ⭐ 为什么读不到（⭐ 人话 ✓）；读到了就是 `"ok"` ✓。
    pub reason: String,
}

/// ⭐ 纯编排（⭐ 命令只是它的薄壳 ⇒ ⭐ 判据不起宿主就能钉住"码一字不差"＋"读不到不给假码" ✓）：
/// ⭐ 三样齐（本机公钥 ✓ ／ 对面公钥 ✓ ／ 这一轮的 `trust_ask` ✓）⇒ [`pairing_code_for`] ✓；
/// ⭐ 缺任何一样 ⇒ `code: None` ＋ ⭐ **人话原因** ✓（⛔ 绝不拿空串或随便一个串凑成"码" ✗）。
pub fn pairing_code_reading_of(
    my_pubkey_hex: Option<&str>,
    peer_pubkey_hex: &str,
    trust_ask: &str,
) -> PairingCodeReading {
    let my = my_pubkey_hex.unwrap_or("").trim();
    if my.is_empty() {
        return PairingCodeReading {
            code: None,
            reason: "本机还没有自己的身份（公钥）⇒ 现在算不出比对码".to_string(),
        };
    }
    if peer_pubkey_hex.trim().is_empty() {
        return PairingCodeReading {
            code: None,
            reason: "这一台还没报出它的身份（公钥）⇒ 现在算不出比对码".to_string(),
        };
    }
    if trust_ask.trim().is_empty() {
        return PairingCodeReading {
            code: None,
            reason: "这一轮没有进行中的握手（trust_ask 是空的）⇒ 先点「接入」，再对这一屏".to_string(),
        };
    }
    PairingCodeReading {
        code: Some(pairing_code_for(my, peer_pubkey_hex, trust_ask)),
        reason: "ok".to_string(),
    }
}

/// ⭐ **薄薄一层命令** ✓（⭐ 包住上面那个纯函数 ✓ —— ⛔ 一行算法都没有 ✗）。
///
/// ⚠️ ⭐ **入参为什么是这两格（⭐ 与我派单里那两格不同处，如实说明 ✗）**：
/// · `peer_device_id` ⇒ ⭐ 去 `lan_state` 取**这一轮**那一串 `trust_ask` ✓（⭐ 走新加的只读小口
///   [`TrustHandshake::ask_for`] ✓ —— ⭐ 它会核"这一轮对的是不是这一台" ✓，⛔ 不是拿"反正有一串"顶上 ✗）；
/// · `peer_pubkey` ⇒ ⭐ 由**前端**给 ✓ —— ⚠️ 理由是**省一次查表**：⭐ 前端手上那份就是
///   `NearbyPeer.pubkey` ✓（⭐ 同一个源 ✓）；⛔ 而且**不给 `NearbyPeer` 加格** ✗（⭐ 读数契约不动 ✓）；
/// · ⛔ **没有 `space_id`** ✗ —— ⭐ [`pairing_code_for`] 只要**三样**（本机公钥／对面公钥／ask ✓），
///   ⭐ 空间**不参与派生** ✓ ⇒ ⭐ 收一个用不上的参数 ＝ 噪音 ＋ 让"参数即口径"变模糊 ✓。
#[tauri::command]
pub fn pairing_code_reading(
    db: tauri::State<'_, crate::db::Db>,
    peer_device_id: String,
    peer_pubkey: String,
) -> Result<PairingCodeReading, String> {
    let my = {
        // ⭐ 本机那把：⭐ `None`（还没生成）⇒ **如实读不到** ✓（⛔ 不硬凑 ✗）
        let c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
        crate::device_key::public_key_hex_of(&c)?
    };
    // ⭐ 这一轮那一串：⭐ 没在跟这一台握手 ／ 已过期 ⇒ 空串 ⇒ ⭐ 如实读不到 ✓
    let ask = crate::lan_state::with_trust(|h| h.ask_for(&peer_device_id, crate::db::now_ms()))
        .unwrap_or_default();
    Ok(pairing_code_reading_of(my.as_deref(), &peer_pubkey, &ask))
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
    /// ⭐⭐ **对面发起的那一轮 `trust_ask` 值** ✗（⭐ 2026-10-17 补 ✓）。
    ///
    /// ⚠️ 为什么要它：比对码 ＝ `f(本机公钥, 对面公钥, 这一轮 trust_ask)` ✓ ——
    ///   **发起方**那一半有自己那串 ✓，而被问的那一半原来是**只记了"谁问的"**（`asked_by` ✓，
    ///   ⛔ 没记那串值 ✗）⇒ ⭐ 它算不出码 ⇒ 两端永远不会有**同一串**可比 ✓
    ///   （owner 2026-10-17 真机："两边都要有自己的码才能核对" ✓）。
    asked_ask: String,
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
    /// ⭐ 本机点「信任这台设备」⇒ ⭐ 记下发问 ✓ ＋ ⭐ **把本机状态推到 `Trusted`** ✗。
    /// ⚠️ 甲 之下"⭐ 点了 ✗"和"⭐ 通了 ✗"是**同一下** ✓（⭐ 登记对面那一半在同一次点击里由
    /// `sync::remember_peer_card` 做完 ✓）⇒ ⭐ 所以状态在这里就推进 ✓，⛔ 不是等对方回执 ✗
    /// （⭐ 甲 里根本没有回执那条路 ✓）。
    pub fn begin(&mut self, peer_device_id: &str, ask: &str, now_ms: i64, ttl_ms: i64) {
        self.clear();
        self.peer_device_id = peer_device_id.to_string();
        self.ask = ask.to_string();
        self.expires_at_ms = now_ms + ttl_ms;
        self.state = state_after_local_confirm(self.state);
    }

    /// ⭐⭐ **2026-10-17**：⭐ **只开一轮比对** ✗（⭐ 生成/记下 `trust_ask` ✓，⛔ **不登记信任** ✗）。
    ///
    /// ⚠️ 为什么不能用 [`Self::begin`] 代替 ✗：`begin` 是"本机点了『信任这台设备』"那一下 ✓，
    ///   ⭐ 它把状态推到 `Trusted` ✓（⛔ 那是**一个信任动作** ✗）。而比对码的用途是
    ///   **在信任之前**先核对对面是不是那一台 ✓ ⇒ ⭐ 需要一个"只开一轮、不做信任动作"的口 ✓。
    ///
    /// ⚠️ 与 `begin` 的共同点：⭐ 都会把**同一台**正在进行的旧那一轮**清掉重开** ✓（⭐ 重放/换 nonce ✓）。
    pub fn prepare(&mut self, peer_device_id: &str, ask: &str, now_ms: i64, ttl_ms: i64) {
        // ⚠️ 用 `clear()` 会把 `state` 冲回 `Idle` ✗（那是**上一个信任动作**的结果 ✓）⇒ ⛔ 不调它 ✗。
        self.peer_device_id = peer_device_id.to_string();
        self.ask = ask.to_string();
        self.asked_by.clear();
        self.asked_ask.clear();
        self.secret_for.clear();
        self.expires_at_ms = now_ms + ttl_ms;
        // ⭐ `state` 一个字都不动 ✓（⭐ 开一轮比对 **不是** 信任动作 ✓）。
    }

    /// ⭐ 收到对方的「想信任」⇒ ⭐ 记下来（⭐ ⛔ 不因此建立信任 ✓，⭐ 要本机的人再点 ✓）。
    ///
    /// ⭐ 2026-10-11（owner 拍「甲：一端点就通」）：⭐ 这一步**只记账** ✗ —— ⭐ 真正"采纳"
    /// （★ 登记对面 ＋ ★ 推进状态 ✓）在**有 db 的那一层**（`sync.rs` 的网格那一轮 ✓），
    /// 因为那一步要写库 ✗，而本模块与 `lan_state` 都**不碰 IO** ✓。
    ///
    /// ⭐⭐ **2026-10-13（P-4 片①）按代码实际行为订正** ✗ —— 上面那段「采纳（登记对面 ＋ 推进状态）
    /// 在 `sync.rs`」⚠️ **两头都不准** ✗（以代码为准，⛔ 不凭注释 ✗）：
    /// · ⛔ "推进状态在 sync.rs" ✗ —— ⭐ 它就在**本函数紧下面那一行**（`state_after_ask_seen` ✓）；
    /// · ⭐⭐ **2026-10-17（owner 拍「一方配对成功，就双向通」）** ✗：⭐ "登记对面在 sync.rs" 那半**又成立**了 ✓
    ///   —— ⭐ 这一侧收到 ask ⇒ `sync::note_pending_trust_asks` 会登记对面 ✓
    ///   （判据 `sync.rs` 的 `receiving_a_trust_ask_registers_the_asker_so_both_directions_work` ✓
    ///   ＋ `receiving_a_pending_ask_registers_the_asker_and_respects_space_and_ttl` ✓）。
    ///   ⚠️ 2026-10-12 的「收到 ask 一个字节都不登记」**已被 owner 推翻** ✓（真机来由：AMD 侧 401 ✓）。
    pub fn note_ask(&mut self, peer_device_id: &str, now_ms: i64, ttl_ms: i64) {
        // ⚠️ 兼容旧调用点（⭐ 只记"谁问的" ✓）；⭐ 要算比对码的那条路走 [`Self::note_ask_with`] ✓
        self.note_ask_with(peer_device_id, "", now_ms, ttl_ms);
    }

    /// ⭐⭐ **2026-10-17**：收下对面那一轮 `trust_ask` 的**值** ✗ —— ⭐ 只给"算比对码"用 ✓。
    ///
    /// ## 与 [`Self::note_ask`] 的关系
    /// ⛔ 不替换 ✗：旧调用点（只关心"谁在问我"、⛔ 不算码 ✓）保持原样 ✓ —— 这里多记一格**只读值** ✓，
    /// ⭐ 判定一行都没改 ✓（`state_after_ask_seen` 照旧 ✓、`pending_asks` 照旧 ✓）。
    ///
    /// ## ⚠️ 一条承重口径：**不清自己那串** ✗（对面正是同一台时）
    /// 原来的 `note_ask` 会把 `peer_device_id` / `ask` **一起清掉** ✓（那是对面**别人**来问的时候，
    /// 本机手上那轮就不该再算数 ✓）。⭐ 但**两边同时点「接入」**是真实情形 ✓：
    /// 本机刚 `begin(对面, 我的 ask)` ✓，紧接着收到**同一台**的 ask ⇒ ⛔ 不许把本机那串清掉 ✗
    /// （清了 ⇒ 两边各用对面的 ⇒ 又算不到一起 ✓）。⇒ ⭐ 只要对面还是同一台，**两串都留着** ✓，
    /// 由 [`Self::ask_for`] 按**字典序取小**保证两端选到同一串 ✓。
    pub fn note_ask_with(&mut self, peer_device_id: &str, ask: &str, now_ms: i64, ttl_ms: i64) {
        // ⚠️ ⭐ **不调 `clear()`** ✗ —— 它会把已经走到的 `WaitingRemote`／`Trusted`
        //   **冲回 `Idle`** ✗；而公告是**周期性**的（30 秒一轮 ✓）⇒ 每轮冲一次 ✗。
        //   ⇒ ⭐ 只清"这次问"这几格 ✓，状态交给 `state_after_ask_seen`（它正是为此存在的 ✓）。
        let same_peer = !self.peer_device_id.trim().is_empty()
            && self.peer_device_id.trim() == peer_device_id.trim();
        if !same_peer {
            // 对面换了另一台 ⇒ 本机手上那轮（对着旧那台）就不该再算数了 ✓（原 `note_ask` 的行为 ✓）
            self.peer_device_id.clear();
            self.ask.clear();
        }
        self.secret_for.clear();
        self.asked_by = peer_device_id.to_string();
        self.asked_ask = ask.to_string();
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

    /// ⭐ **P-4 片③-a（2026-10-14）加的只读小口** ✗ —— ⭐ 按 `peer_device_id` 取**这一轮**那一串
    /// `trust_ask` ✓（⭐ 命令侧要用 ✓，⛔ 不改任何既有函数签名 ✗、⛔ 不改任何判定 ✗）。
    ///
    /// ⚠️ ⭐ **必须核"这一轮对的是不是这一台"** ✗：⭐ 光调 [`Self::outbound_ask`] 拿到的是
    /// **当前那次握手**的串 ✓ —— ⭐ 若它正对着**另一台** ⇒ 拿它去算码会算出一个**看着像**、
    /// 其实属于别的设备的码 ✗（⭐ 那正是"读不到"应当出现的地方 ✓）。
    /// ⇒ ⭐ 不是这一台（或那一串为空 ／ 已过期 ✓）⇒ `None` ＝ **读不到** ✓（⛔ 不硬凑 ✗）。
    pub fn ask_for(&self, peer_device_id: &str, now_ms: i64) -> Option<String> {
        let peer = peer_device_id.trim();
        if peer.is_empty() || self.is_expired(now_ms) {
            return None;
        }
        // ⭐ 本机**发起**的那一轮（`begin` ⇒ `peer_device_id` / `ask` ✓）
        let own = if self.peer_device_id.trim() == peer {
            self.outbound_ask(now_ms).trim()
        } else {
            ""
        };
        // ⭐⭐ 2026-10-17：**对面发起**的那一轮（`note_ask_with` 记下的那一串值 ✓）——
        //   ⭐ 被问的那一半也要能算出**同一串**码 ✓（原来只有发起方算得出 ✓）。
        let theirs = if self.asked_by.trim() == peer {
            self.asked_ask.trim()
        } else {
            ""
        };
        // ⚠️ **两边同时点「接入」**（真实情形 ✓）：两串都留着 ⇒ ⭐ **按字典序取小** ✓
        //   ⇒ 两端各算一次，**选到同一串** ✓（⛔ 不许"各用对面那串" —— 那会反着选 ✗）。
        let chosen = match (own.is_empty(), theirs.is_empty()) {
            (true, true) => return None,
            (false, true) => own,
            (true, false) => theirs,
            (false, false) => {
                if own <= theirs {
                    own
                } else {
                    theirs
                }
            }
        };
        if chosen.is_empty() {
            None
        } else {
            Some(chosen.to_string())
        }
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
        self.asked_ask.clear();
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
        self.asked_ask.clear();
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
    fn one_sided_click_reaches_trusted() {
        // ⭐⭐ 甲（owner 2026-10-11 二次拍板，逐字「甲：一端点就通，图④为准」）⭐ **取代**了原先
        //    "两端各点一次、单方面点完不算"那条口径 ✓。⚠️ 那道安全职责**换人承担** ✓：
        //    兜底只剩「身份在信任前可见」＋「逐台可撤回」—— ⭐ 代价当初就记在
        //    `docs/plans/2026-10-11-one-click-trust-decision.md` §2 ✓，⛔ 不是悄悄消失的 ✗。
        //    判据改名（原 `local_confirm_alone_never_reaches_trusted` ✓）就是为了让"它是**反**的"这件事
        //    在文件里看得见 —— ⛔ 不改名的话，下一个人会以为它还在断言旧口径 ✗。
        let mut s = TrustState::Idle;
        for _ in 0..100 {
            s = state_after_local_confirm(s);
        }
        assert_eq!(
            s,
            TrustState::Trusted,
            "甲：本机点一下就算通（而且再点是**幂等**的，⛔ 不许来回抖）"
        );
    }

    #[test]
    fn remote_side_acting_alone_also_reaches_trusted() {
        // ⭐ 甲 的另一半：⭐ 对面那条路 ⇒ ⭐ 这一侧**自动采纳** ⇒ ⭐ 直接通 ✓（"不问那台的人" ✓）。
        assert_eq!(
            state_after_remote_confirm(TrustState::Idle),
            TrustState::Trusted,
            "甲：收到对面的确认 ⇒ 自动采纳 ⇒ 直接信"
        );
        assert_eq!(
            state_after_ask_seen(TrustState::Idle),
            TrustState::Trusted,
            "甲：看到「我想信任你」那条广播 ⇒ 自动采纳 ⇒ 直接信（⛔ 不要人再点一下）"
        );
    }

    #[test]
    fn both_ends_confirm_reaches_trusted_either_order() {
        // ⚠️ 甲 之下这条**仍然成立**（⭐ 只是不再需要"两端"才成立 ✓）—— ⭐ 留着它当**顺序无关**的证据 ✓。
        assert_eq!(
            state_after_remote_confirm(state_after_local_confirm(TrustState::Idle)),
            TrustState::Trusted
        );
        assert_eq!(
            state_after_local_confirm(state_after_remote_confirm(TrustState::Idle)),
            TrustState::Trusted,
            "顺序不影响"
        );
    }

    #[test]
    fn dismiss_clears_the_half_state() {
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
    fn seeing_the_ask_agrees_under_jia() {
        // ⭐⭐ 甲 之后**反过来了** ✗（原判据名 `seeing_the_ask_is_not_agreeing` ✓ —— ⭐ 改名是为了让翻转看得见 ✓）：
        //    ⭐ 收到"想信任"那条广播 ⇒ ⭐ 这一侧**自动采纳** ⇒ ⭐ 直接 `Trusted` ✓（"不问那台的人" ✓）。
        assert_eq!(state_after_ask_seen(TrustState::Idle), TrustState::Trusted);
        // ⭐ 周期性广播重复到达 ⇒ ⭐ 不把已有状态冲回去 ✓（这一条甲前后都成立 ✓）。
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

    /// ⭐⭐ **2026-10-17**：⭐ `prepare` **只开一轮** ✗ —— ⭐ 能读到 ask ✓、⛔ **不动信任状态** ✗
    /// （⭐ 开一轮比对不是信任动作 ✓；登记仍是 `mesh_trust_begin` ✓）。
    #[test]
    fn prepare_opens_a_round_without_touching_the_trust_state() {
        let mut h = TrustHandshake::default();
        let before = h.state();
        h.prepare("dev-b", "ask-1", 1_000, TRUST_TTL_MS);
        assert_eq!(h.state(), before, "⛔ 开一轮比对不许推进信任状态 ✗");
        assert_eq!(
            h.ask_for("dev-b", 1_500),
            Some("ask-1".to_string()),
            "⭐ 开完就能按那一台读到 ask ✓（⭐ 比对码的料 ✓）"
        );
        assert_eq!(h.outbound_secret(1_500), "", "⛔ 一个字节的 secret 都不许出线 ✗");
        assert_eq!(h.pending_asks(1_500), Vec::<String>::new(), "⭐ 不是「被人问」那一支 ✓");
    }

    /// 否则它算不出比对码（owner 2026-10-17 真机："点接入了，也没有（码）" ✓）。
    #[test]
    fn the_asked_side_can_also_read_the_incoming_ask() {
        let mut h = TrustHandshake::default();
        h.note_ask_with("dev-a", "ask-1", 1_000, TRUST_TTL_MS);
        assert_eq!(
            h.ask_for("dev-a", 1_500),
            Some("ask-1".to_string()),
            "⭐ 对面发起的那一轮：⭐ 本机必须能按那一台读到那串 ask ✓（此前只记了「谁问的」✗）"
        );
        assert_eq!(h.ask_for("dev-z", 1_500), None, "⛔ 不是这一台 ⇒ 读不到 ✓");
    }

    /// ⭐⭐ **2026-10-17**：⭐ **两边同时点「接入」**（真实情形 ✓）⇒ 两串都留着，
    /// ⭐ 按**字典序取小** ⇒ 两端选到**同一串** ✓（⛔ 不各用对面的 —— 那会反着选 ✗）。
    #[test]
    fn when_both_sides_start_at_once_they_pick_the_same_ask() {
        // A：本机发起 "bbb"，紧接着收到 B 的 "aaa"
        let mut a = TrustHandshake::default();
        a.begin("dev-b", "bbb", 1_000, TRUST_TTL_MS);
        a.note_ask_with("dev-b", "aaa", 1_000, TRUST_TTL_MS);
        // B：本机发起 "aaa"，紧接着收到 A 的 "bbb"
        let mut b = TrustHandshake::default();
        b.begin("dev-a", "aaa", 1_000, TRUST_TTL_MS);
        b.note_ask_with("dev-a", "bbb", 1_000, TRUST_TTL_MS);
        assert_eq!(a.ask_for("dev-b", 1_500), Some("aaa".to_string()));
        assert_eq!(b.ask_for("dev-a", 1_500), Some("aaa".to_string()));
        assert_eq!(
            a.ask_for("dev-b", 1_500),
            b.ask_for("dev-a", 1_500),
            "⭐ 两端必须选到同一串（否则码必然不同 ✓）"
        );
    }

    /// ⭐ 对面**换了另一台** ⇒ ⭐ 本机手上那轮（对着旧那台）不再算数 ✓（原 `note_ask` 的行为 ✓）。
    #[test]
    fn an_incoming_ask_from_another_peer_replaces_the_round() {
        let mut h = TrustHandshake::default();
        h.begin("dev-b", "bbb", 1_000, TRUST_TTL_MS);
        h.note_ask_with("dev-c", "ccc", 1_000, TRUST_TTL_MS);
        assert_eq!(h.ask_for("dev-b", 1_500), None, "⛔ 对着旧那台的那轮已作废 ✓");
        assert_eq!(h.ask_for("dev-c", 1_500), Some("ccc".to_string()));
    }

    /// ⭐ 过期的 incoming ask ⇒ ⭐ 读不到 ✓（⛔ 不拿旧 nonce 凑码 ✗）。
    #[test]
    fn an_expired_incoming_ask_is_not_readable() {
        let mut h = TrustHandshake::default();
        h.note_ask_with("dev-a", "ask-1", 1_000, 1_000);
        assert_eq!(h.ask_for("dev-a", 2_500), None, "过了 TTL ⇒ 读不到 ✓");
    }

    /// ⭐⭐ **2026-10-17**：⭐ 已经收到对面的 ask 时，本机 `prepare` **沿用它** ⇒ 两端同一串 ✓
    /// （否则第二台会自己新造一串 ⇒ 码永远对不上 ✓）。委托 `mesh_trust_prepare` 采用这一判定 ✓。
    #[test]
    fn prepare_can_adopt_the_incoming_ask_so_both_ends_agree() {
        let mut h = TrustHandshake::default();
        h.note_ask_with("dev-a", "ask-from-a", 1_000, TRUST_TTL_MS);
        // 第二台在收到 ask 之后才点「接入」：命令层会把 `ask_for` 读到的这一串原样交给 prepare ✓
        let adopted = h.ask_for("dev-a", 1_500).expect("对面那串必须读得到");
        assert_eq!(adopted, "ask-from-a");
        h.prepare("dev-a", &adopted, 1_500, TRUST_TTL_MS);
        assert_eq!(
            h.ask_for("dev-a", 1_600),
            Some("ask-from-a".to_string()),
            "⭐ 采纳之后本机读到的仍是**同一串** ⇒ 两端同一个码 ✓"
        );
    }

    /// ⭐ `begin` 之后**过期**也读不到（⭐ 与 incoming 同一条口径 ✓）。
    #[test]
    fn an_expired_outgoing_ask_is_not_readable() {
        let mut h = TrustHandshake::default();
        h.begin("dev-b", "ask-1", 1_000, 1_000);
        assert_eq!(h.ask_for("dev-b", 2_500), None);
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
        // ⭐ 甲 之后：⭐ 对面动过 ⇒ ⭐ 这一侧自动采纳 ⇒ ⭐ 直接 `Trusted` ✓
        //    （⭐ 原先"⭐ 只到 `RemotePending` ✓、⭐ 本机还得再点 ✗"已被 owner 的甲取代 ✓）。
        let mut h = TrustHandshake::default();
        h.note_ask("dev-a", 1_000, TRUST_TTL_MS);
        h.note_remote_confirm(2_000, TRUST_TTL_MS);
        assert_eq!(h.state(), TrustState::Trusted, "甲：对面动过 ⇒ 自动采纳 ⇒ 直接信");
        assert!(
            h.pending_asks(2_100).is_empty(),
            "采纳过的这一条不许再返回（否则每轮重写一遍卡片）"
        );
        // ② ⭐ 本机点过那一档**现在接线了** ✗（`begin` 里推进 ✓ —— 这正是本轮修的缺口 ✓）。
        let mut g = TrustHandshake::default();
        g.begin("dev-b", "ask-1", 1_000, TRUST_TTL_MS);
        assert_eq!(g.state(), TrustState::Trusted, "甲：`begin` ＝ 本机点过了 ⇒ 直接信");
        g.note_ask("dev-a", 1_100, TRUST_TTL_MS);
        assert_eq!(g.state(), TrustState::Trusted, "甲：对方发问 ⇒ 自动采纳 ⇒ 还是 Trusted");
        g.note_remote_confirm(1_200, TRUST_TTL_MS);
        assert_eq!(g.state(), TrustState::Trusted, "甲：两端都动过 ⇒ 仍 Trusted（幂等 ✓）");
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

    // ═══════════════════════════════════════════════════════════════════════════════
    // ⭐⭐ **P-4 片①（2026-10-13）**：⭐ 两端一致的比对码 ✗（⭐ 复用既有那一格 nonce ✓，⛔ 不加字段 ✗）
    // ═══════════════════════════════════════════════════════════════════════════════

    /// ⭐⭐ **判据①（本片的新行为）**：⭐ 同一对 `(公钥A, 公钥B, nonce)` ⇒ ⭐ **两端算出的码相同** ✓；
    /// ⭐ 换一个 nonce ⇒ ⭐ **码不同** ✓。
    ///
    /// ⚠️ **本片先红（如实）**：⭐ 落下 [`pairing_code_for`] 之前这条**编译不过** ✓ —— ⭐ 可核：
    /// `git show HEAD:src-tauri/src/pairing_trust.rs` 里 `pairing_code_for` 是 **0 命中** ✓。
    /// ⚠️ 且本机 rust 组按 `AGENTS.md` §7 以 **Linux(CI)/WSL** 为准 ⇒ ⭐ 本组**编进 lib** ✓、
    /// ⭐ **本机未执行** ✗（⭐ 真因：`mt.exe` 不在 ⇒ 注入不了 v6 清单 ⇒ lib 测试 exe 起不来 ✓）。
    #[test]
    fn pairing_code_is_identical_on_both_ends_and_follows_the_nonce() {
        const PK_A: &str = "aa11";
        const PK_B: &str = "bb22";
        let ask = "f".repeat(64);
        // ⭐ ① 两端一致：A 看 B ／ B 看 A（⭐ 参数**反着传**）⇒ 必须同一个码 ✓
        let a_sees_b = pairing_code_for(PK_A, PK_B, &ask);
        let b_sees_a = pairing_code_for(PK_B, PK_A, &ask);
        assert_eq!(
            a_sees_b, b_sees_a,
            "⛔ 两端算出的码必须一致 ✗（顺序没定死 ⇒ 两边永远对不上 ✓）"
        );
        assert!(!a_sees_b.trim().is_empty(), "码不许是空串");
        // ⭐ 大小写／空白不该改变结果（两端的写法可能不同 ✓）
        assert_eq!(
            pairing_code_for(" AA11 ", "BB22", &ask),
            a_sees_b,
            "⭐ 去空白 ＋ 小写之后必须同码 ✓"
        );
        // ⭐ ② 换 nonce ⇒ 码必须不同 ✓（⭐ 相同的话"一次性"这一格形同虚设 ✓）
        assert_ne!(
            a_sees_b,
            pairing_code_for(PK_A, PK_B, &"0".repeat(64)),
            "⛔ 换 nonce 必须换码 ✗（⭐ 那是整段参与那条性质给的 ✓）"
        );
        // ⭐ ③ 换公钥 ⇒ 码也必须不同 ✓
        assert_ne!(
            a_sees_b,
            pairing_code_for("aa12", PK_B, &ask),
            "⛔ 换公钥必须换码 ✗"
        );
    }

    /// ⭐⭐ **P-4 片③-a 判据②（本机：⭐ 只能编译 ✓ —— 如实标 ✗）**：⭐ 命令那一层算出的码
    /// 与**直接调** [`pairing_code_for`] ⭐ **一字不差** ✓（⭐ 它只是薄壳 ⇒ 必须如此 ✓）。
    ///
    /// ⚠️ 本机 rust 组按 `AGENTS.md` §7 以 **Linux(CI)/WSL** 为准 ⇒ ⭐ 本组**编进 lib** ✓、
    /// ⭐ **本机未执行** ✗。
    #[test]
    fn the_command_layer_returns_the_same_code_as_the_pure_function() {
        let my = "aa11";
        let peer = "bb22";
        let ask = "f".repeat(64);
        let via_command = pairing_code_reading_of(Some(my), peer, &ask);
        assert_eq!(
            via_command.code.as_deref(),
            Some(pairing_code_for(my, peer, &ask).as_str()),
            "⛔ 命令那一层**不许**自己另算一遍（⭐ 那就会出现两个算法 ✓）"
        );
        assert_eq!(via_command.reason, "ok");
    }

    /// ⭐⭐ **判据③**：⭐ **取不到 ⇒ `None` ＋ 人话原因** ✓，⛔ **绝不返回一个假码** ✗
    /// （⭐ 三种取不到：本机没身份 ／ 对面没报公钥 ／ 这一轮没在握手 ✓）。
    #[test]
    fn unreadable_inputs_yield_no_code_and_a_human_reason() {
        let ask = "f".repeat(64);
        for (name, got) in [
            ("本机没身份", pairing_code_reading_of(None, "bb22", &ask)),
            ("本机身份是空串", pairing_code_reading_of(Some("  "), "bb22", &ask)),
            ("对面没报公钥", pairing_code_reading_of(Some("aa11"), "", &ask)),
            ("这一轮没握手", pairing_code_reading_of(Some("aa11"), "bb22", "   ")),
        ] {
            assert_eq!(got.code, None, "⛔ {name} ⇒ 必须**读不到** ✗（⛔ 不许拿一个码冒充 ✗）");
            assert!(
                got.reason.trim().len() > 8,
                "⛔ {name} ⇒ 必须给**人话原因** ✗（⭐ 实测 {}）",
                got.reason
            );
        }
        // ⭐ 反面：⭐ 三样齐时**必须真给码** ✓（⛔ 不许永远读不到 ✗ —— 那与永远为真同罪 ✓）
        let ok = pairing_code_reading_of(Some("aa11"), "bb22", &ask);
        assert!(ok.code.is_some(), "⛔ 三样齐还不给码 ⇒ 这一格永远不会亮 ✗");
    }

    /// ⭐ **P-4 片③-a 判据④ 的两条锁（今天已绿 ✓，⛔ 不是本片的修 ✗）**：
    /// ⭐ `WIRE_VERSION` 仍 1 ✓ ＋ ⭐ `NearbyPeer` 仍是 **8 格** ✓（⭐ 读数契约没动 ✓）。
    ///
    /// ⚠️⚠️ **2026-10-16 更新（owner 拍「同意」✓）：第二条的"格数"从 8 改成 11** ✗
    /// —— 那条锁**本来就是片级的**（上句逐字"⛔ 不是本片的修"，它锁的是**当时那一片**不许动契约 ✓），
    /// 而后面几片按**既定手法**合法加了格：**可选字段 ＋ 不升 `WIRE_VERSION`**
    /// （`lan.rs:148`／`:167` 逐字：「与 `short_id`（08-b②）／`trust_ask` 同一个手法 ✓」✓）。
    /// ⇒ 计数断言**过期**（实测 11 格 ✓），**不是产品错了** ✗。
    /// ⭐ **本锁的用意保留** ✓：谁给 `NearbyPeer` 加格，**谁就必须来改这一行并写明来由** ✓ ——
    /// 它是个 **tripwire**（⛔ 不是"永远不许加" ✗）；`WIRE_VERSION == 1` 那半**继续**有效 ✓
    /// （加可选字段**不许**升版本 ✓，否则新老互不可见 ✗）。
    /// 本次只动计数与这段说明，⛔ 不动任何产品代码 ✗。
    #[test]
    fn the_wire_version_and_the_nearby_contract_are_untouched() {
        let lan_src = include_str!("lan.rs");
        assert!(
            lan_src.contains("pub const WIRE_VERSION: u32 = 1;"),
            "⛔ **不许**升 `WIRE_VERSION` ✗（加字段只能「可选 ＋ 不升版本」✓；升了 ⇒ 新老互不可见 ✗）"
        );
        let sync_src = include_str!("sync.rs");
        let at = sync_src.find("pub struct NearbyPeer {").expect("`NearbyPeer` 必须在");
        let body = &sync_src[at..sync_src[at..].find("\n}").map(|e| at + e).unwrap_or(at)];
        let fields = body
            .lines()
            .filter(|l| l.trim_start().starts_with("pub ") && l.trim_end().ends_with(','))
            .count();
        assert_eq!(
            fields, 11,
            "⛔ 给 `NearbyPeer` 加/删格**必须同时来改这一行并写明来由** ✗（tripwire ✓；实际 {fields} 格）\
             —— ⚠️ 2026-10-16 由 8 改 11：08-b② 的 `short_id` ＋ P-B 的原因码等（各带日期注释 ✓）"
        );
    }

    /// ⭐ **判据②（锁，今天已绿 ✓，⛔ 不是本片的修 ✗）**：⭐ 出站**过期 ⇒ 一个字节都不带** ✓。
    ///
    /// ⚠️ ⭐ **如实交代**（⭐ 前一位没核这一格 ✓）：⭐ 我核了 ⭐ **"用后作废"没有专门的实现** ✗ ——
    /// ⭐ 收到 ask 那一侧只**记账**、**不登记** ✓（判据③那条 ✓）⇒ ⭐ 所以本格**不写成"重放被拒"** ✗
    /// （⭐ 那是我们**没有**的行为 ✓，⛔ 不许假装有 ✗）；⭐ 只钉**真正成立**的那条：
    /// ⭐ 出站**过期不带** ✓（本文件的 `outbound_ask` ✓）⇒ ⭐ 一条过期的 ask
    /// **不可能被本机再发出去** ✓。
    #[test]
    fn expired_ask_is_never_carried_out() {
        let mut h = TrustHandshake::default();
        h.begin("dev-b", "abc", 1_000, TRUST_TTL_MS);
        assert_eq!(h.outbound_ask(1_000), "abc", "⭐ 没过期 ⇒ 照带 ✓");
        assert_eq!(
            h.outbound_ask(1_000 + TRUST_TTL_MS),
            "",
            "⛔ 过期 ⇒ 一个字节都不许带 ✗"
        );
        assert_eq!(
            h.outbound_secret(1_000 + TRUST_TTL_MS),
            "",
            "⭐ 那把（`trust_secret`）同样不许带 ✓"
        );
        // ⭐ 没有任何进行中的东西（`expires_at_ms == 0`）⇒ 也空 ✓（⭐ 与"过期"语义不同、结果同 ✓）
        let idle = TrustHandshake::default();
        assert_eq!(idle.outbound_ask(9_999_999), "", "⭐ 没在等 ⇒ 空 ✓");
    }

    /// ⭐ **判据③（锁，今天已绿 ✓）**：⭐ 收到 ask ⇒ ⭐ **一个字节都不登记** ✓
    /// （⭐ 与 `sync.rs` 那两条**同源** ✓ —— 本格只是把"我还认这条"钉在这里 ✓）。
    /// ⭐ **判据③（**2026-10-17 改口径** ✗）**：⭐ 收到 ask ⇒ ⭐ **这一侧也登记对面** ✓
    /// （owner 拍「一方配对成功，就双向通」✓ —— ⛔ 不再是 2026-10-12 的"一个字节都不登记"✗）。
    #[test]
    fn receiving_an_ask_registers_reciprocally() {
        let src = include_str!("sync.rs");
        assert!(
            src.contains("pub(crate) fn note_pending_trust_asks("),
            "⭐ 那条**唯一实现**要在 ✓（⭐ 名字改了这条要跟着改 ✓）"
        );
        assert!(
            src.contains("receiving_a_trust_ask_registers_the_asker_so_both_directions_work"),
            "⭐ 它是「收到 ask ⇒ 本侧也登记（双向通）」那条判据的名字 ✓"
        );
        assert!(
            src.contains("receiving_a_trust_ask_writes_only_the_pubkey_registration"),
            "⭐ 同上（登记面收窄那条真变异 ✓）"
        );
    }

    /// ⭐ **判据④（锁，今天已绿 ✓）**：⭐ 「服务不服务我」的判定**仍旧只有** `lan::serves_space` ✓
    /// （⭐ 本片只**新增**一个纯函数 ⇒ ⛔ 一个字都没动判定 ✗）。
    #[test]
    fn the_judgement_is_still_lan_serves_space() {
        let src = include_str!("sync.rs");
        assert!(
            src.contains("serves_current: lan::serves_space(space_id, p)"),
            "⛔ 不许拿别的读数去决定「服务不服务我」✗（判定只有 `lan::serves_space` 一条 ✓）"
        );
    }
}


/// ⭐⭐ **2026-10-25（配对码对不上）判据**：把"两端"的输入互换，**必须算出同一个码**。
///
/// 真机现场：两端各自生成 `trust_ask`，各自算 ⇒ 码不同（截图里对不上）。
/// **变异**：`pick_trust_ask` 改回"总是用我自己的" ⇒ 第一段断言红。
#[cfg(test)]
mod pairing_code_agreement_tests {
    use super::*;

    const MY_PUB: &str = "aaaa0000111122223333444455556666777788889999000011112222333344ff";
    const PEER_PUB: &str = "bbbb0000111122223333444455556666777788889999000011112222333344ee";
    const MY_DEV: &str = "11111111-1111-1111-1111-111111111111";
    const PEER_DEV: &str = "22222222-2222-2222-2222-222222222222";

    #[test]
    fn both_sides_pick_the_same_ask_and_therefore_the_same_code() {
        let my_ask = "aaaa1111";
        let peer_ask = "bbbb2222";

        // A 侧（我=MY，端=PEER）
        let a = pairing_code_reading_both(
            Some(MY_PUB), PEER_PUB, my_ask, peer_ask, MY_DEV, PEER_DEV,
        );
        // B 侧（我=PEER，端=MY）—— 公钥/设备号/ask 全部互换
        let b = pairing_code_reading_both(
            Some(PEER_PUB), MY_PUB, peer_ask, my_ask, PEER_DEV, MY_DEV,
        );

        let ca = a.code.expect("A 侧应算得出");
        let cb = b.code.expect("B 侧应算得出");
        assert_eq!(ca, cb, "两端算出的码必须一致（否则用户永远对不上）");
    }

    #[test]
    fn only_one_side_has_an_ask_so_the_other_still_matches() {
        // 只有我这边有 ask（对方还没开始握手）
        let a = pairing_code_reading_both(Some(MY_PUB), PEER_PUB, "aaaa1111", "", MY_DEV, PEER_DEV);
        // 对方视角：它自己的 ask 为空、我的在"peer_ask"里
        let b = pairing_code_reading_both(Some(PEER_PUB), MY_PUB, "", "aaaa1111", PEER_DEV, MY_DEV);
        assert_eq!(a.code, b.code);
        assert!(a.code.is_some());
    }

    #[test]
    fn no_ask_anywhere_means_no_code_not_a_fake_one() {
        let r = pairing_code_reading_both(Some(MY_PUB), PEER_PUB, "", "", MY_DEV, PEER_DEV);
        assert!(r.code.is_none(), "⛔ 不许拿空串凑一个码");
        assert!(r.reason.contains("trust_ask"), "要说清原因：{}", r.reason);
    }
}
