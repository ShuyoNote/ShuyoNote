// ⭐ 2026-10-11：⭐ 客户端侧的**许可证校验** ✗ —— ⭐ 纯函数，⛔ 不联网、⛔ 不碰 IO。
//!
//! ## 它补的是哪一格
//! `relay_client.rs` 今天把许可证当**配置占位**读（`license_nbf` / `license_exp` / `license_grace_days`），
//! 它自己的模块头就写着 ⚠️「这是**占位**，⛔ 不是"许可已验证"」（读不到就报 `missing`，⛔ 不编一个数字）。
//! 本模块就是那一格：⭐ **文本 ⇒ 验过的声明** ✗。
//!
//! ## ⛔ 边界（两条，都是铁律，别踩）
//! 1. ⭐ **自己写，⛔ 不许从专有中继仓拷代码** ✗ —— 那个仓是**专有**、产品仓是 **AGPL-3.0**；
//!    它自己的铁律是「仓库边界 ＝ 交付边界」「⛔ 不许回流进产品仓」。⭐ 需要核格式时**只读**它 ✓。
//! 2. ⚠️ ⭐ **公钥先用占位** ✗：真公钥由 owner 给（签发侧生成）。⛔ **不许自己造一把真钥匙** ✗；
//!    `kid` 查不到 ⇒ ⭐ **直接拒**（fail-closed ✓）。
//!
//! ## 凭证形状（与中继仓的公开面逐字一致 ✓，⭐ 只读核对出来的）
//! ```text
//! {PREFIX}{version}.{payload_b64}.{sig_b64}
//! · base64 = URL_SAFE_NO_PAD
//! · ⭐ 被签名的字节 = format!("{PREFIX}{version}.{payload_b64}")  ← ⛔ 不含签名那一格
//! · Ed25519：公钥 32 字节 / 签名 64 字节
//! · CLOCK_TOLERANCE_SECS = 600
//! ```
//!
//! ## ⭐ 判定顺序（⭐ 顺序本身就是规格 ✗，判据逐条钉着）
//! ① 形状 ⇒ ② `kid` 查表（⭐ 查不到 ⇒ `UnknownKid` ✓）⇒ ③ 验签（⭐ 不过 ⇒ `BadSignature` ✓）
//! ⇒ ④ 时间窗 ⇒ ⑤ `cap` 必须含 `"crossnet"`（⭐ `Ok` 但缺 cap ⇒ **拒** ✗ ——
//! ⛔ 别把"时间对"当成"能跨网"，那是两件事 ✗）。

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

/// ⭐ 许可证前缀 ✗（⭐ 租约是另一个前缀，本模块这轮不碰 ✓）。
pub const LICENSE_PREFIX: &str = "SHUYO-LIC-";
/// 被签名字节里那一格 `version` 的**唯一**取值。
pub const FORMAT_VERSION: u32 = 1;
/// 时钟容差（秒）—— ⭐ 与中继仓逐字同值（只读核过 ✓）。
pub const CLOCK_TOLERANCE_SECS: i64 = 600;
/// 宽限期缺省天数 —— ⭐ 与中继仓 `DEFAULT_GRACE_DAYS` 逐字同值 ✓。
pub const DEFAULT_GRACE_DAYS: i64 = 14;
/// Ed25519 公钥长度。
pub const PUBKEY_LEN: usize = 32;
/// Ed25519 签名长度。
pub const SIG_LEN: usize = 64;
/// ⭐ 能力位里必须有这一格，才允许**跨网**（⭐ 中继仓 `allows_crossnet()` 同口径 ✓）。
pub const CROSSNET_CAP: &str = "crossnet";

/// ⭐ 一张卡：`kid` ⇒ 公钥 ✗（⭐ 做成数组 ⇒ 换卡时新 `kid` 能先随版本发出去 ✓）。
#[derive(Clone)]
pub struct KeyEntry {
    pub kid: &'static str,
    pub public_key: [u8; PUBKEY_LEN],
}

/// ⭐ **真 keyring**（2026-10-21 起）—— 签发侧（`shuyo-site/api` 的发卡服务）的真实公钥。
///
/// 来历：`issuer-key.json` 由 `api/lib/license.mjs` 的 `loadOrCreateIssuerKey()` 在部署机
/// `/var/lib/shuyo-api/` 生成；⭐ 私钥只在服务器（600），这里**只有公钥** ✓。
///
/// 第 0 代 `kid = shuyo-lic-2026-10`：2026-10-21 真机付 0.01 元产出的那张卡就是它签的
/// （`grace = 14`、`cap = ["crossnet"]`、`prev = null`），已用签发侧 `verifyCard()` 自验通过。
///
/// ⚠️ 换卡流程（`rot` / `prev`）：新 `kid` **先随版本发出去**，这里加一行；
/// ⛔ 别删旧行 —— 手上还留着旧卡的人要能继续验过。
pub const KEYRING: &[KeyEntry] = &[KeyEntry {
    kid: "shuyo-lic-2026-10",
    public_key: [
        0x30, 0xea, 0xfc, 0x05, 0x27, 0x84, 0xc4, 0x4c, 0xb4, 0xa2, 0x6a, 0x58, 0x30, 0x27, 0x27, 0x0f,
        0xbd, 0xb5, 0xb8, 0x6c, 0x8f, 0xcb, 0x1c, 0x06, 0xde, 0x9e, 0x3b, 0x9f, 0x71, 0x0b, 0xba, 0x99,
    ],
}];

/// ⭐ 拒收的原因 ✗（⭐ 每一档都能在界面上说成一句人话 ✓，⛔ 不合并 ✓）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LicenseRefusal {
    /// 形状不对（⭐ 前缀／三段／base64／UTF-8 任一不过 ✓）。
    BadShape,
    /// `kid` 不在 keyring 里 —— ⭐ fail-closed 的那一档 ✓。
    UnknownKid,
    /// 签名验不过（⭐ 或者 `kid` 那把公钥本身不是合法点 ✓）。
    BadSignature,
    /// 时间窗还没开始（⭐ `now + 容差 < nbf` ✓）。
    NotYet,
    /// 已过期（⭐ 连宽限都过了 ✓）—— ⭐ 铁律③：这只收回**跨网** ✓，⛔ 不碰客户端本地 ✗。
    Expired,
    /// 时间没问题，⭐ 但**缺 `"crossnet"` 能力位** ✗ ⇒ ⭐ 仍然不许跨网 ✓。
    NoCrossnetCap,
}

/// ⭐ 许可窗口的四态 ✗（⭐ 与中继仓 `window_state` 同口径 ✓）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LicenseWindow {
    NotYet,
    Ok,
    /// ⭐ 宽限期内：⭐ **仍然放行跨网** ✗（⭐ 与"已暂停"必须分开 ✓）。
    Grace,
    Expired,
}

/// ⭐ 验过之后的声明 ✗（⭐ 只有**验签通过**的文本才配变成它 ✓）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LicenseClaims {
    pub sub: String,
    pub devices: Vec<String>,
    pub seats: i64,
    pub nbf: i64,
    pub exp: i64,
    pub grace_days: i64,
    pub jti: String,
    /// ⭐ 能力位里有没有 `"crossnet"` ✗（⭐ 单独留着 ⇒ 界面能说清"为什么不能跨网"✓）。
    pub crossnet: bool,
}

impl LicenseClaims {
    /// ⭐ 这一份声明现在落在哪一档 ✗。
    pub fn window(&self, now: i64) -> LicenseWindow {
        if now + CLOCK_TOLERANCE_SECS < self.nbf {
            return LicenseWindow::NotYet;
        }
        if now <= self.exp {
            return LicenseWindow::Ok;
        }
        let until = self
            .exp
            .saturating_add(self.grace_days.saturating_mul(86_400))
            .saturating_add(CLOCK_TOLERANCE_SECS);
        if now <= until {
            LicenseWindow::Grace
        } else {
            LicenseWindow::Expired
        }
    }

    /// ⭐ 现在允不允许跨网 ✗ —— ⭐ `Ok` 与 `Grace` 都允许 ✓；⭐ 但**还必须**有 `crossnet` 能力位 ✗。
    pub fn allows_crossnet(&self, now: i64) -> bool {
        matches!(self.window(now), LicenseWindow::Ok | LicenseWindow::Grace) && self.crossnet
    }
}

/// ⭐ 许可证 payload 的字段面 ✗ —— ⭐ 14 格，⛔ **多了少了都拒** ✗（⭐ 别只判"数值不对"✓）。
const LICENSE_FIELDS: [&str; 14] = [
    "v", "typ", "sub", "dev", "seats", "nbf", "exp", "grace", "kid", "iat", "jti", "cap", "rot",
    "prev",
];

fn bad_shape() -> LicenseRefusal {
    LicenseRefusal::BadShape
}

/// ⭐ 把 `{PREFIX}{version}.{payload_b64}.{sig_b64}` 拆开 ✗ ⇒ ⭐ `(version, payload_b64, sig_b64)` ✓。
fn split_license(text: &str) -> Result<(String, String, String), LicenseRefusal> {
    let rest = text.strip_prefix(LICENSE_PREFIX).ok_or_else(bad_shape)?;
    let mut parts = rest.split('.');
    let version = parts.next().ok_or_else(bad_shape)?.to_string();
    let payload_b64 = parts.next().ok_or_else(bad_shape)?.to_string();
    let sig_b64 = parts.next().ok_or_else(bad_shape)?.to_string();
    // ⭐ 恰好三段 ✗（⭐ 多一段就是另一种东西 ⇒ ⛔ 不收 ✓）。
    if parts.next().is_some() {
        return Err(bad_shape());
    }
    if version != FORMAT_VERSION.to_string() || payload_b64.is_empty() || sig_b64.is_empty() {
        return Err(bad_shape());
    }
    Ok((version, payload_b64, sig_b64))
}

/// ⭐ 被签名的字节 ✗ —— ⭐ 判据要能**逐字复现**它 ✓（⛔ 不含签名那一格 ✗）。
pub fn signing_message(version: &str, payload_b64: &str) -> String {
    format!("{LICENSE_PREFIX}{version}.{payload_b64}")
}

/// ⭐ 用**指定的** keyring 验一份许可证 ✗（⭐ keyring 可注入 ⇒ 判据能自己签一份来试 ✓；
/// ⭐ 生产入口 [`verify_license`] 用的是那份**占位**常量 ✓）。
pub fn verify_license_with(
    text: &str,
    now: i64,
    keyring: &[KeyEntry],
) -> Result<LicenseClaims, LicenseRefusal> {
    let (version, payload_b64, sig_b64) = split_license(text)?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload_b64.as_bytes())
        .map_err(|_| bad_shape())?;
    let value: serde_json::Value = serde_json::from_slice(&payload).map_err(|_| bad_shape())?;
    let obj = value.as_object().ok_or_else(bad_shape)?;
    // ⭐ 字段面严格 ✗：⭐ 14 格**一格不多、一格不少** ✓。
    if obj.len() != LICENSE_FIELDS.len() || LICENSE_FIELDS.iter().any(|f| !obj.contains_key(*f)) {
        return Err(bad_shape());
    }
    if obj.get("v").and_then(|v| v.as_u64()) != Some(FORMAT_VERSION as u64) {
        return Err(bad_shape());
    }
    let kid = obj.get("kid").and_then(|v| v.as_str()).ok_or_else(bad_shape)?;
    // ① `kid` 查表 ⇒ ⭐ 查不到就拒（fail-closed ✓）
    let entry = keyring
        .iter()
        .find(|e| e.kid == kid)
        .ok_or(LicenseRefusal::UnknownKid)?;
    // ② 验签：⭐ 签的是 `{PREFIX}{version}.{payload_b64}` ✗
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64.as_bytes())
        .map_err(|_| bad_shape())?;
    if sig_bytes.len() != SIG_LEN {
        return Err(LicenseRefusal::BadSignature);
    }
    let mut sig_arr = [0u8; SIG_LEN];
    sig_arr.copy_from_slice(&sig_bytes);
    let vk = ed25519_dalek::VerifyingKey::from_bytes(&entry.public_key)
        .map_err(|_| LicenseRefusal::BadSignature)?;
    let sig = ed25519_dalek::Signature::from_bytes(&sig_arr);
    use ed25519_dalek::Verifier;
    vk.verify(signing_message(&version, &payload_b64).as_bytes(), &sig)
        .map_err(|_| LicenseRefusal::BadSignature)?;
    // ③ 取字段（⭐ 类型不对也算形状问题 ✓）
    let sub = obj.get("sub").and_then(|v| v.as_str()).ok_or_else(bad_shape)?;
    let jti = obj.get("jti").and_then(|v| v.as_str()).ok_or_else(bad_shape)?;
    let devices = obj
        .get("dev")
        .and_then(|v| v.as_array())
        .ok_or_else(bad_shape)?
        .iter()
        .map(|d| d.as_str().map(|s| s.to_string()).ok_or_else(bad_shape))
        .collect::<Result<Vec<String>, LicenseRefusal>>()?;
    let seats = obj.get("seats").and_then(|v| v.as_i64()).ok_or_else(bad_shape)?;
    let nbf = obj.get("nbf").and_then(|v| v.as_i64()).ok_or_else(bad_shape)?;
    let exp = obj.get("exp").and_then(|v| v.as_i64()).ok_or_else(bad_shape)?;
    let grace_days = obj
        .get("grace")
        .and_then(|v| v.as_i64())
        .unwrap_or(DEFAULT_GRACE_DAYS);
    let crossnet = obj
        .get("cap")
        .and_then(|v| v.as_array())
        .ok_or_else(bad_shape)?
        .iter()
        .any(|c| c.as_str() == Some(CROSSNET_CAP));
    let claims = LicenseClaims {
        sub: sub.to_string(),
        devices,
        seats,
        nbf,
        exp,
        grace_days,
        jti: jti.to_string(),
        crossnet,
    };
    // ④ 时间窗 ⇒ ⑤ 能力位（⭐ 顺序就是规格：⭐ 时间不对先说时间 ✓）
    match claims.window(now) {
        LicenseWindow::NotYet => return Err(LicenseRefusal::NotYet),
        LicenseWindow::Expired => return Err(LicenseRefusal::Expired),
        LicenseWindow::Ok | LicenseWindow::Grace => {}
    }
    if !claims.crossnet {
        return Err(LicenseRefusal::NoCrossnetCap);
    }
    Ok(claims)
}

/// ⭐ **生产入口** ✓：用那份内嵌 keyring（2026-10-21 起是真公钥 ⇒ 发卡站签的卡能验过 ✓）。
pub fn verify_license(text: &str, now: i64) -> Result<LicenseClaims, LicenseRefusal> {
    verify_license_with(text, now, KEYRING)
}

// ─────────────────────────── ⭐ 租约（`SHUYO-TOK-`）✗ ───────────────────────────
//
// ⭐ 两种凭证**同形不同格** ✗（⭐ 只读核对出来的）：
//   · ⭐ 租约 **9 格** ✗：`v/typ/dev[]/nbf/exp/kid/iat/jti/cap` ✓
//     —— ⚠️ ⭐ **没有** `sub/seats/grace/rot/prev` ✗（⛔ 别照许可证那份写 ✓）
//   · ⭐ **租约上限** ✗：`exp - nbf ≤ 30 天`（⭐ 中继仓 `MAX_LEASE_SECS` 同值 ✓）
//   · ⭐ 判定顺序 ✗（⭐ 与中继仓一致 ✓）：验签 ⇒ ⭐ **租约上限** ⇒ 时间窗 ⇒ ⭐ **设备位** ⇒ `cap` ✓
//   · ⭐ 设备身份是**握手已证明的 `EndpointId`** ✗（⭐ ⛔ 不信客户端自报的任何字段 ✓）
//     ⇒ ⭐ 所以这里**要把本机端点 id 传进来对** ✓（⭐ 对不上 ⇒ `DeviceNotListed` ✓）

/// ⭐ 租约前缀 ✗。
pub const LEASE_PREFIX: &str = "SHUYO-TOK-";
/// ⭐ 租约**最长 30 天** ✗ —— ⭐ 与中继仓逐字同值（只读核过 ✓）。
pub const MAX_LEASE_SECS: i64 = 30 * 86_400;
/// ⭐ 租约 payload 的字段面 ✗ —— ⭐ **9 格**（⛔ 与许可证那 14 格不是同一张表 ✓）。
const LEASE_FIELDS: [&str; 9] = ["v", "typ", "dev", "nbf", "exp", "kid", "iat", "jti", "cap"];

/// ⭐ 租约被拒的原因 ✗。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseRefusal {
    BadShape,
    UnknownKid,
    BadSignature,
    /// ⭐ 超过 30 天上限 ✗（⭐ 或者 `exp` 早于 `nbf` ✓）—— ⭐ 长期凭证必须由**许可证**那条路给 ✓。
    TooLong,
    NotYet,
    Expired,
    /// ⭐ 这份租约**不是发给本机端点的** ✗（⭐ 设备位里没有本机 id ✓）。
    DeviceNotListed,
    /// ⭐ 时间与设备都对，⭐ 但缺 `"crossnet"` 能力位 ✗ ⇒ ⭐ 仍不许跨网 ✓。
    NoCrossnetCap,
}

/// ⭐ 验过的租约声明 ✗。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseClaims {
    pub devices: Vec<String>,
    pub nbf: i64,
    pub exp: i64,
    pub jti: String,
    pub crossnet: bool,
}

impl LeaseClaims {
    /// ⭐ 落在哪一档 ✗（⭐ 与许可证**同一把尺** ✓ —— 租约没有自己的宽限期 ✓）。
    pub fn window(&self, now: i64) -> LicenseWindow {
        if now + CLOCK_TOLERANCE_SECS < self.nbf {
            return LicenseWindow::NotYet;
        }
        if now <= self.exp {
            return LicenseWindow::Ok;
        }
        LicenseWindow::Expired
    }

    /// ⭐ 现在允不允许跨网 ✗（⭐ 租约没有宽限 ✓ ⇒ 只有 `Ok` ＋ `cap` ✓）。
    pub fn allows_crossnet(&self, now: i64) -> bool {
        self.window(now) == LicenseWindow::Ok && self.crossnet
    }

    /// ⭐ 这份租约是不是发给某个端点的 ✗。
    pub fn names_device(&self, device_id: &str) -> bool {
        self.devices.iter().any(|d| d == device_id)
    }
}

/// ⭐ 把 `{prefix}{version}.{payload_b64}.{sig_b64}` 拆开 ✗（⭐ 两种凭证共用 ✓）。
fn split_credential(text: &str, prefix: &str) -> Result<(String, String, String), LicenseRefusal> {
    let rest = text.strip_prefix(prefix).ok_or_else(bad_shape)?;
    let mut parts = rest.split('.');
    let version = parts.next().ok_or_else(bad_shape)?.to_string();
    let payload_b64 = parts.next().ok_or_else(bad_shape)?.to_string();
    let sig_b64 = parts.next().ok_or_else(bad_shape)?.to_string();
    if parts.next().is_some() {
        return Err(bad_shape());
    }
    if version != FORMAT_VERSION.to_string() || payload_b64.is_empty() || sig_b64.is_empty() {
        return Err(bad_shape());
    }
    Ok((version, payload_b64, sig_b64))
}

/// ⭐ 带前缀的签名消息 ✗（⭐ 租约与许可证各签各的 ⇒ ⛔ 不能互相冒充 ✓）。
pub fn signing_message_for(prefix: &str, version: &str, payload_b64: &str) -> String {
    format!("{prefix}{version}.{payload_b64}")
}

/// ⭐ 验签那一步 ✗（⭐ 两种凭证共用 ✓）。
fn check_signature(
    version: &str,
    payload_b64: &str,
    sig_b64: &str,
    prefix: &str,
    entry: &KeyEntry,
) -> Result<(), LicenseRefusal> {
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64.as_bytes())
        .map_err(|_| bad_shape())?;
    if sig_bytes.len() != SIG_LEN {
        return Err(LicenseRefusal::BadSignature);
    }
    let mut sig_arr = [0u8; SIG_LEN];
    sig_arr.copy_from_slice(&sig_bytes);
    let vk = ed25519_dalek::VerifyingKey::from_bytes(&entry.public_key)
        .map_err(|_| LicenseRefusal::BadSignature)?;
    let sig = ed25519_dalek::Signature::from_bytes(&sig_arr);
    use ed25519_dalek::Verifier;
    vk.verify(signing_message_for(prefix, version, payload_b64).as_bytes(), &sig)
        .map_err(|_| LicenseRefusal::BadSignature)
}

/// ⭐ 用**指定的** keyring 验一份租约 ✗（⭐ keyring 可注入 ⇒ 判据能自己签一份 ✓）。
pub fn verify_lease_with(
    text: &str,
    now: i64,
    device_id: &str,
    keyring: &[KeyEntry],
) -> Result<LeaseClaims, LeaseRefusal> {
    let (version, payload_b64, sig_b64) = split_credential(text, LEASE_PREFIX).map_err(lease_map)?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload_b64.as_bytes())
        .map_err(|_| LeaseRefusal::BadShape)?;
    let value: serde_json::Value =
        serde_json::from_slice(&payload).map_err(|_| LeaseRefusal::BadShape)?;
    let obj = value.as_object().ok_or(LeaseRefusal::BadShape)?;
    // ⭐ 字段面严格 9 格 ✗（⭐ 多了少了都拒 ✓）
    if obj.len() != LEASE_FIELDS.len() || LEASE_FIELDS.iter().any(|f| !obj.contains_key(*f)) {
        return Err(LeaseRefusal::BadShape);
    }
    if obj.get("v").and_then(|v| v.as_u64()) != Some(FORMAT_VERSION as u64) {
        return Err(LeaseRefusal::BadShape);
    }
    let kid = obj
        .get("kid")
        .and_then(|v| v.as_str())
        .ok_or(LeaseRefusal::BadShape)?;
    // ① `kid` 查表 ⇒ 查不到就拒（fail-closed ✓）
    let entry = keyring
        .iter()
        .find(|e| e.kid == kid)
        .ok_or(LeaseRefusal::UnknownKid)?;
    // ② 验签
    check_signature(&version, &payload_b64, &sig_b64, LEASE_PREFIX, entry).map_err(lease_map)?;
    // ③ 取字段
    let devices = obj
        .get("dev")
        .and_then(|v| v.as_array())
        .ok_or(LeaseRefusal::BadShape)?
        .iter()
        .map(|d| {
            d.as_str()
                .map(|s| s.to_string())
                .ok_or(LeaseRefusal::BadShape)
        })
        .collect::<Result<Vec<String>, LeaseRefusal>>()?;
    let nbf = obj
        .get("nbf")
        .and_then(|v| v.as_i64())
        .ok_or(LeaseRefusal::BadShape)?;
    let exp = obj
        .get("exp")
        .and_then(|v| v.as_i64())
        .ok_or(LeaseRefusal::BadShape)?;
    let jti = obj
        .get("jti")
        .and_then(|v| v.as_str())
        .ok_or(LeaseRefusal::BadShape)?;
    let crossnet = obj
        .get("cap")
        .and_then(|v| v.as_array())
        .ok_or(LeaseRefusal::BadShape)?
        .iter()
        .any(|c| c.as_str() == Some(CROSSNET_CAP));
    let claims = LeaseClaims {
        devices,
        nbf,
        exp,
        jti: jti.to_string(),
        crossnet,
    };
    // ④ ⭐ **租约上限** ✗：⭐ 短期租约不许超 30 天（⭐ 长期能力由许可证给 ✓）
    if exp < nbf || exp.saturating_sub(nbf) > MAX_LEASE_SECS {
        return Err(LeaseRefusal::TooLong);
    }
    // ⑤ 时间窗
    match claims.window(now) {
        LicenseWindow::NotYet => return Err(LeaseRefusal::NotYet),
        LicenseWindow::Expired => return Err(LeaseRefusal::Expired),
        _ => {}
    }
    // ⑥ ⭐ **设备位** ✗：⭐ 必须是发给本机端点的（⭐ 握手已证明的那个 id ✓）
    if !claims.names_device(device_id) {
        return Err(LeaseRefusal::DeviceNotListed);
    }
    // ⑦ 能力位
    if !claims.crossnet {
        return Err(LeaseRefusal::NoCrossnetCap);
    }
    Ok(claims)
}

/// ⭐ **生产入口** ✗：⭐ 用那份内嵌 keyring（⭐ 占位 ⇒ ⭐ 真租约一律验不过 ✓）。
pub fn verify_lease(text: &str, now: i64, device_id: &str) -> Result<LeaseClaims, LeaseRefusal> {
    verify_lease_with(text, now, device_id, KEYRING)
}

/// ⭐ 把共用的形状错误映射成租约那种 ✗。
fn lease_map(e: LicenseRefusal) -> LeaseRefusal {
    match e {
        LicenseRefusal::BadShape => LeaseRefusal::BadShape,
        LicenseRefusal::UnknownKid => LeaseRefusal::UnknownKid,
        LicenseRefusal::BadSignature => LeaseRefusal::BadSignature,
        _ => LeaseRefusal::BadShape,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
    use ed25519_dalek::{Signer, SigningKey};

    /// ⭐ 判据专用的一把钥匙 ✗（⭐ 只活在测试里 ✓，⛔ 与生产 keyring 无关 ✓）。
    fn judge_key() -> (SigningKey, KeyEntry) {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let entry = KeyEntry {
            kid: "JUDGE-KID",
            public_key: sk.verifying_key().to_bytes(),
        };
        (sk, entry)
    }

    /// ⭐ 真卡判据（2026-10-21 真机付 0.01 元换来的那张）：**生产 keyring 必须认得它** ✓。
    ///
    /// 为什么非要钉一张真卡：它是发卡站（`shuyo-site/api`）用 `kid = shuyo-lic-2026-10` 的
    /// **真实私钥**签出来的 ⇒ 验得过就说明「客户端内嵌公钥」与「服务器私钥」是同一对 ✓。
    /// ⛔ 别改成“本地自签一张再验” ✗ —— 那样只证明代码自洽，证明不了钥匙配对。
    ///
    /// 这张卡测试专用（`sub` 是 `probe@shuyo.cn` 的散列，30 天，⛔ 不可用于真实用户）。
    #[test]
    fn a_real_card_from_the_issuer_verifies_with_the_production_keyring() {
        const CARD: &str = "SHUYO-LIC-1.eyJ2IjoxLCJ0eXAiOiJjYXJkIiwic3ViIjoiYzU4ZjFmMmM3YjlmMDgwOTkzMWUzODdiMmE3ZmJlOWUiLCJkZXYiOltdLCJzZWF0cyI6MSwibmJmIjoxNzkyNTgwOTYxLCJleHAiOjE3OTUxNzI5NjEsImdyYWNlIjoxNCwia2lkIjoic2h1eW8tbGljLTIwMjYtMTAiLCJpYXQiOjE3OTI1ODA5NjEsImp0aSI6ImVjODQ0MTNiMzc3OTA3OWUiLCJjYXAiOlsiY3Jvc3NuZXQiXSwicm90IjowLCJwcmV2IjpudWxsfQ.Q8YKT7YymMr3uQTqaylEGSVZh3nXEnQD4JPzmnAJ0sn30NeBJqUlyqyZRKffUUcLGZTqAId3uXTPcE2PhjtRBQ";
        let now = 1_792_580_961 + 60; // 签发后 1 分钟
        let claims = verify_license(CARD, now).expect("真卡必须验得过");
        assert!(claims.crossnet, "cap 必须含 crossnet");
        assert_eq!(claims.exp - claims.nbf, 30 * 86400, "30 天卡");
        assert_eq!(claims.grace_days, DEFAULT_GRACE_DAYS, "宽限期与签发侧同值");

        // 反向：改掉签名里一个字符 ⇒ 必须拒（不是“没验就算过”）
        let mut tampered = CARD.to_string();
        let last = tampered.pop().unwrap();
        tampered.push(if last == 'A' { 'B' } else { 'A' });
        assert!(verify_license(&tampered, now).is_err(), "改过签名必须拒");
    }

    fn payload(extra: Option<(&str, serde_json::Value)>, fields: Option<serde_json::Value>) -> String {
        let mut map = serde_json::Map::new();
        map.insert("v".into(), serde_json::json!(FORMAT_VERSION));
        map.insert("typ".into(), serde_json::json!("license"));
        map.insert("sub".into(), serde_json::json!("space-1"));
        map.insert("dev".into(), serde_json::json!(["device-1"]));
        map.insert("seats".into(), serde_json::json!(2));
        map.insert("nbf".into(), serde_json::json!(1_000));
        map.insert("exp".into(), serde_json::json!(2_000));
        map.insert("grace".into(), serde_json::json!(DEFAULT_GRACE_DAYS));
        map.insert("kid".into(), serde_json::json!("JUDGE-KID"));
        map.insert("iat".into(), serde_json::json!(1_000));
        map.insert("jti".into(), serde_json::json!("jti-1"));
        map.insert(
            "cap".into(),
            fields.unwrap_or_else(|| serde_json::json!([CROSSNET_CAP])),
        );
        map.insert("rot".into(), serde_json::Value::Null);
        map.insert("prev".into(), serde_json::Value::Null);
        if let Some((k, v)) = extra {
            map.insert(k.to_string(), v);
        }
        serde_json::Value::Object(map).to_string()
    }

    fn mint(sk: &SigningKey, payload_json: &str) -> String {
        let p64 = B64.encode(payload_json.as_bytes());
        let msg = signing_message(&FORMAT_VERSION.to_string(), &p64);
        let sig = sk.sign(msg.as_bytes());
        format!("{}{}.{}.{}", LICENSE_PREFIX, FORMAT_VERSION, p64, B64.encode(sig.to_bytes()))
    }

    // ─────────────────────── ⭐ 租约那半的判据 ✗ ───────────────────────

    /// ⭐ 租约 payload ✗（⭐ **9 格**，⛔ 不带 `sub/seats/grace/rot/prev` ✓）。
    fn lease_payload(
        dev: serde_json::Value,
        cap: serde_json::Value,
        nbf: i64,
        exp: i64,
        extra: Option<(&str, serde_json::Value)>,
    ) -> String {
        let mut map = serde_json::Map::new();
        map.insert("v".into(), serde_json::json!(FORMAT_VERSION));
        map.insert("typ".into(), serde_json::json!("token"));
        map.insert("dev".into(), dev);
        map.insert("nbf".into(), serde_json::json!(nbf));
        map.insert("exp".into(), serde_json::json!(exp));
        map.insert("kid".into(), serde_json::json!("JUDGE-KID"));
        map.insert("iat".into(), serde_json::json!(nbf));
        map.insert("jti".into(), serde_json::json!("lease-1"));
        map.insert("cap".into(), cap);
        if let Some((k, v)) = extra {
            map.insert(k.to_string(), v);
        }
        serde_json::Value::Object(map).to_string()
    }

    /// ⭐ 签一份租约 ✗（⭐ 前缀是 `SHUYO-TOK-` ✓，⭐ 签名字节也带那个前缀 ✓）。
    fn mint_lease(sk: &SigningKey, payload_json: &str) -> String {
        let p64 = B64.encode(payload_json.as_bytes());
        let msg = signing_message_for(LEASE_PREFIX, &FORMAT_VERSION.to_string(), &p64);
        let sig = sk.sign(msg.as_bytes());
        format!(
            "{}{}.{}.{}",
            LEASE_PREFIX,
            FORMAT_VERSION,
            p64,
            B64.encode(sig.to_bytes())
        )
    }

    fn good_lease(sk: &SigningKey) -> String {
        mint_lease(
            sk,
            &lease_payload(
                serde_json::json!(["endpoint-1"]),
                serde_json::json!([CROSSNET_CAP]),
                1_000,
                1_000 + 86_400,
                None,
            ),
        )
    }

    /// ⭐ 判据⑦：⭐ 一份好租约验得过，⭐ 而且**设备位真的对得上** ✗（⭐ 对不上是本条的另一半 ✓）。
    #[test]
    fn a_good_lease_verifies_and_must_name_this_endpoint() {
        let (sk, entry) = judge_key();
        let claims = verify_lease_with(&good_lease(&sk), 1_500, "endpoint-1", &[entry.clone()])
            .expect("该过");
        assert_eq!(claims.jti, "lease-1");
        assert!(claims.crossnet);
        assert!(claims.allows_crossnet(1_500));
        assert!(claims.names_device("endpoint-1"));
        // ⭐ 设备位里没有本机 id ⇒ ⭐ **拒** ✗（⭐ ⛔ 不信自报字段，⭐ 只认握手证明过的那个 ✓）
        assert_eq!(
            verify_lease_with(&good_lease(&sk), 1_500, "some-other-endpoint", &[entry]),
            Err(LeaseRefusal::DeviceNotListed)
        );
    }

    /// ⭐ 判据⑧：⭐ **租约上限 30 天** ✗ —— ⭐ 超一天就拒 ✓（⭐ 长期能力只能由许可证给 ✓）。
    #[test]
    fn a_lease_longer_than_thirty_days_is_refused() {
        let (sk, entry) = judge_key();
        let at_limit = mint_lease(
            &sk,
            &lease_payload(
                serde_json::json!(["endpoint-1"]),
                serde_json::json!([CROSSNET_CAP]),
                1_000,
                1_000 + MAX_LEASE_SECS,
                None,
            ),
        );
        assert!(
            verify_lease_with(&at_limit, 1_500, "endpoint-1", &[entry.clone()]).is_ok(),
            "正好 30 天应当放行"
        );
        let one_over = mint_lease(
            &sk,
            &lease_payload(
                serde_json::json!(["endpoint-1"]),
                serde_json::json!([CROSSNET_CAP]),
                1_000,
                1_001 + MAX_LEASE_SECS,
                None,
            ),
        );
        assert_eq!(
            verify_lease_with(&one_over, 1_500, "endpoint-1", &[entry.clone()]),
            Err(LeaseRefusal::TooLong)
        );
        // ⭐ `exp < nbf` 也是形状坏（⭐ 别让它当成"永不过期" ✓）
        let backwards = mint_lease(
            &sk,
            &lease_payload(
                serde_json::json!(["endpoint-1"]),
                serde_json::json!([CROSSNET_CAP]),
                2_000,
                1_000,
                None,
            ),
        );
        assert_eq!(
            verify_lease_with(&backwards, 1_500, "endpoint-1", &[entry]),
            Err(LeaseRefusal::TooLong)
        );
    }

    /// ⭐ 判据⑨：⭐ 租约的**字段面是 9 格** ✗ —— ⭐ 把许可证那几格塞进来必须拒 ✓
    /// （⭐ 而且**少了** `cap` 之类也要拒 ✓）；⭐ 另外：⭐ 前缀不对／⭐ 缺 `cap`／⭐ 过期都要各自拒 ✓。
    #[test]
    fn the_lease_field_face_is_nine_and_the_prefix_cannot_be_swapped() {
        let (sk, entry) = judge_key();
        // 多一格（⭐ 塞一个许可证才有的 `seats` ✓）
        let extra = mint_lease(
            &sk,
            &lease_payload(
                serde_json::json!(["endpoint-1"]),
                serde_json::json!([CROSSNET_CAP]),
                1_000,
                2_000,
                Some(("seats", serde_json::json!(3))),
            ),
        );
        assert_eq!(
            verify_lease_with(&extra, 1_500, "endpoint-1", &[entry.clone()]),
            Err(LeaseRefusal::BadShape)
        );
        // 少一格
        let mut map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(
            &lease_payload(
                serde_json::json!(["endpoint-1"]),
                serde_json::json!([CROSSNET_CAP]),
                1_000,
                2_000,
                None,
            ),
        )
        .expect("对象");
        map.remove("typ");
        let missing = mint_lease(&sk, &serde_json::Value::Object(map).to_string());
        assert_eq!(
            verify_lease_with(&missing, 1_500, "endpoint-1", &[entry.clone()]),
            Err(LeaseRefusal::BadShape)
        );
        // ⭐ 缺 `cap` ⇒ ⭐ 时间与设备都对也拒 ✓（⛔ 别把"时间对"当"能跨网" ✗）
        let no_cap = mint_lease(
            &sk,
            &lease_payload(
                serde_json::json!(["endpoint-1"]),
                serde_json::json!([]),
                1_000,
                2_000,
                None,
            ),
        );
        assert_eq!(
            verify_lease_with(&no_cap, 1_500, "endpoint-1", &[entry.clone()]),
            Err(LeaseRefusal::NoCrossnetCap)
        );
        // ⭐ 前缀不能互换 ✗：⭐ 许可证文本当租约 ⇒ 形状坏 ✓（⭐ 反之亦然 ✓）
        assert_eq!(
            verify_lease_with(&ok_text(&sk), 1_500, "endpoint-1", &[entry.clone()]),
            Err(LeaseRefusal::BadShape)
        );
        // 过期／还没开始
        // ⚠️ "还没开始"要把**容差**让出来 ✗：`nbf = 1000` ＋ 容差 600 ⇒ 999 **本来就在容差内** ✓
        //    （⭐ 我第一版写成 999 ⇒ 判据自己错 ✗，⭐ 代码是对的 ✓）
        assert_eq!(
            verify_lease_with(
                &good_lease(&sk),
                1_000 - CLOCK_TOLERANCE_SECS - 1,
                "endpoint-1",
                &[entry.clone()]
            ),
            Err(LeaseRefusal::NotYet)
        );
        // ⭐ 容差边界上仍然算对得上 ✓
        assert!(verify_lease_with(
            &good_lease(&sk),
            1_000 - CLOCK_TOLERANCE_SECS,
            "endpoint-1",
            &[entry.clone()]
        )
        .is_ok());
        assert_eq!(
            verify_lease_with(&good_lease(&sk), 1_000 + 86_400 + 10, "endpoint-1", &[entry]),
            Err(LeaseRefusal::Expired),
            "租约没有宽限 ⇒ 过期就是过期"
        );
    }

    fn ok_text(sk: &SigningKey) -> String {
        mint(sk, &payload(None, None))
    }

    #[test]
    fn a_good_license_verifies_and_carries_the_declaration() {
        let (sk, entry) = judge_key();
        let claims = verify_license_with(&ok_text(&sk), 1_500, &[entry]).expect("该过");
        assert_eq!(claims.sub, "space-1");
        assert_eq!(claims.devices, vec!["device-1".to_string()]);
        assert_eq!(claims.seats, 2);
        assert_eq!(claims.exp, 2_000);
        assert_eq!(claims.grace_days, DEFAULT_GRACE_DAYS);
        assert!(claims.crossnet);
        assert!(claims.allows_crossnet(1_500));
        assert_eq!(claims.window(1_500), LicenseWindow::Ok);
    }

    /// ⭐ 判据①：`kid` 查不到 ⇒ ⭐ **拒** ✗（fail-closed ✓）。
    #[test]
    fn an_unknown_kid_is_refused() {
        let (sk, _entry) = judge_key();
        let other = KeyEntry {
            kid: "SOMEONE-ELSE",
            public_key: sk.verifying_key().to_bytes(),
        };
        assert_eq!(
            verify_license_with(&ok_text(&sk), 1_500, &[other]),
            Err(LicenseRefusal::UnknownKid)
        );
        // ⚠️ 而且**生产入口**（占位 keyring）现在对**任何**真凭证都必须拒 ⇒ ⭐ 这是有意的 fail-closed ✓。
        assert_eq!(
            verify_license(&ok_text(&sk), 1_500),
            Err(LicenseRefusal::UnknownKid)
        );
    }

    /// ⭐ 判据②：⭐ 签名不过 ⇒ **拒** ✗（⭐ 改一个字节就该拒 ✓）。
    #[test]
    fn a_tampered_payload_is_refused() {
        let (sk, entry) = judge_key();
        let good = ok_text(&sk);
        // 把 payload 那一格换掉（⭐ 签名因此对不上 ✓）
        let (head, tail) = good.rsplit_once('.').expect("三段");
        let tampered = format!("{head}x.{tail}");
        assert!(
            matches!(
                verify_license_with(&tampered, 1_500, &[entry.clone()]),
                Err(LicenseRefusal::BadSignature) | Err(LicenseRefusal::BadShape)
            ),
            "改过 payload 必须拒"
        );
        // 另一把钥匙签的也拒（⭐ 签名值本身是合法的 64 字节，只是对不上 ✓）
        let (other_sk, _) = {
            let sk2 = SigningKey::from_bytes(&[9u8; 32]);
            (sk2, ())
        };
        let wrong_sig = mint(&other_sk, &payload(None, None));
        assert_eq!(
            verify_license_with(&wrong_sig, 1_500, &[entry]),
            Err(LicenseRefusal::BadSignature)
        );
    }

    /// ⭐ 判据③：⭐ 时间窗三档 ✗ —— ⭐ 还没开始 / ⭐ 已过期 / ⭐ **宽限期内仍放行** ✓。
    #[test]
    fn the_window_has_four_states_and_grace_still_allows_crossnet() {
        let (sk, entry) = judge_key();
        let text = ok_text(&sk);
        // 还没开始（⭐ 容差 600 之内算"还没到"之前 ✓）
        assert_eq!(
            verify_license_with(&text, 1_000 - CLOCK_TOLERANCE_SECS - 1, &[entry.clone()]),
            Err(LicenseRefusal::NotYet)
        );
        // 容差之内仍然算对得上
        assert!(verify_license_with(&text, 1_000 - CLOCK_TOLERANCE_SECS, &[entry.clone()]).is_ok());
        // ⭐ 宽限期内 ⇒ ⭐ **仍然放行** ✓（⭐ 与"已暂停"必须分开 ✓）
        let grace_at = 2_000 + DEFAULT_GRACE_DAYS * 86_400;
        let claims = verify_license_with(&text, grace_at, &[entry.clone()]).expect("宽限期内该过");
        assert_eq!(claims.window(grace_at), LicenseWindow::Grace);
        assert!(claims.allows_crossnet(grace_at), "宽限期内必须仍可跨网");
        // 宽限也过了 ⇒ ⭐ 收的是**跨网** ✓（⭐ 铁律③：⛔ 不碰客户端本地 ✗）
        let expired_at = grace_at + CLOCK_TOLERANCE_SECS + 1;
        assert_eq!(
            verify_license_with(&text, expired_at, &[entry]),
            Err(LicenseRefusal::Expired)
        );
    }

    /// ⭐ 判据④（⭐ 最要紧的一条）：⭐ **时间对、但缺 `cap` ⇒ 拒** ✗ ——
    /// ⛔ 不许把"时间对"当成"能跨网" ✗。
    #[test]
    fn right_now_but_without_the_capability_is_still_refused() {
        let (sk, entry) = judge_key();
        let no_cap = mint(&sk, &payload(None, Some(serde_json::json!(["something-else"]))));
        assert_eq!(
            verify_license_with(&no_cap, 1_500, &[entry.clone()]),
            Err(LicenseRefusal::NoCrossnetCap)
        );
        // 窗口本身是好的 ⇒ ⭐ 界面上要能说"时间没问题、是能力位不许" ✓
        let empty_cap = mint(&sk, &payload(None, Some(serde_json::json!([]))));
        assert_eq!(
            verify_license_with(&empty_cap, 1_500, &[entry]),
            Err(LicenseRefusal::NoCrossnetCap)
        );
    }

    /// ⭐ 判据⑤：⭐ 字段面严格 ✗ —— ⭐ **多一格也拒、少一格也拒** ✓（⭐ 别只判"数值不对"✓）。
    #[test]
    fn the_field_face_is_exact_fourteen_extra_or_missing_is_refused() {
        let (sk, entry) = judge_key();
        // 多一格
        let extra = mint(
            &sk,
            &payload(Some(("sneaky", serde_json::json!(1))), None),
        );
        assert_eq!(
            verify_license_with(&extra, 1_500, &[entry.clone()]),
            Err(LicenseRefusal::BadShape)
        );
        // 少一格（⭐ 去掉 `prev` ✓）
        let mut map: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&payload(None, None)).expect("对象");
        map.remove("prev");
        let missing = mint(&sk, &serde_json::Value::Object(map).to_string());
        assert_eq!(
            verify_license_with(&missing, 1_500, &[entry.clone()]),
            Err(LicenseRefusal::BadShape)
        );
        // 形状不对的几种
        assert_eq!(verify_license_with("", 1_500, &[entry.clone()]), Err(LicenseRefusal::BadShape));
        assert_eq!(
            verify_license_with("SHUYO-TOK-1.aa.bb", 1_500, &[entry.clone()]),
            Err(LicenseRefusal::BadShape),
            "⛔ 租约不是许可证（前缀不同）"
        );
        assert_eq!(
            verify_license_with("SHUYO-LIC-1.a.b.c", 1_500, &[entry]),
            Err(LicenseRefusal::BadShape),
            "⛔ 多一段就不收"
        );
    }

    /// ⭐ 判据⑩：⭐ **三态读数的来源** ✗ —— ⭐ 验过 ／ ⭐ 拒收 ／ ⭐ 占位，⭐ 三者必须分得开 ✓。
    ///
    /// ⚠️ 最要紧的是**最后那一条** ✗：⭐ 配置里同时有"⭐ 一份验不过的文本 ✗"和"⭐ 几个很好看的裸数字 ✗"时，
    /// ⭐ 结果必须是 **`Refused`** ✗ —— ⛔ 不许退回裸数字 ✗（⭐ 那等于**绕过验签** ✓）。
    #[test]
    fn the_three_sources_of_the_license_window_are_distinguishable() {
        use crate::relay_client::{verified_window_with, LicenseWindow, RelayConfig as Cfg, VerifiedLicense};
        let (sk, entry) = judge_key();
        // ① 有文本、⭐ 验得过 ⇒ ⭐ `Verified`，⭐ 而且天数来自**验过的声明** ✓
        let good = Cfg {
            license: Some(mint(&sk, &payload(None, None))),
            license_exp: Some(9_999_999), // ⭐ 故意塞一个假数字：⭐ 它**不该**被采用 ✓
            ..Default::default()
        };
        assert_eq!(
            verified_window_with(&good, 1_500, &[entry.clone()]),
            VerifiedLicense::Verified(LicenseWindow::Active { days_left: 0 }),
            "天数只能来自验过的 exp=2000（now=1500 ⇒ 0 天）"
        );
        // ② 有文本、⭐ 验不过 ⇒ ⭐ `Refused`，⛔ **不许**退回裸数字 ✓
        let bad_text_good_numbers = Cfg {
            license: Some("SHUYO-LIC-1.notbase64.notasig".to_string()),
            license_exp: Some(9_999_999),
            ..Default::default()
        };
        match verified_window_with(&bad_text_good_numbers, 1_500, &[entry.clone()]) {
            VerifiedLicense::Refused(_) => {}
            other => panic!("⭐ 验不过就必须是 Refused ✗（⛔ 不许拿裸数字顶上）——实际 {other:?}"),
        }
        // ③ 没有文本 ⇒ ⭐ `Placeholder`（⭐ 与 `Verified` 必须**不是**同一个东西 ✓）
        let placeholder = Cfg {
            license_exp: Some(9_999_999),
            ..Default::default()
        };
        let got = verified_window_with(&placeholder, 1_500, &[entry]);
        assert!(matches!(got, VerifiedLicense::Placeholder(_)), "实际 {got:?}");
        assert!(!got.is_verified(), "没有签名文本就不许自称验过");
        // ④ ⭐ 生产入口 ⭐（占位 keyring）⭐ 对真文本也必须 `Refused` ✗（fail-closed ✓）
        let prod = crate::relay_client::verified_window(&good, 1_500);
        assert!(matches!(prod, VerifiedLicense::Refused(_)), "实际 {prod:?}");
        assert_eq!(prod.window(), None, "拒收那一档**没有**窗口（⛔ 不许编一个）");
    }

    /// ⭐ 判据⑪：⭐ **读数那一格**也要分得开 ✗ —— ⭐ 拒收时 ⛔ 不许带天数、⛔ 不许放行跨网 ✓。
    ///
    /// ⚠️ 这是 Step C 的**端到端**那一条：⭐ 从"⭐ 配置里一份假文本 ＋ ⭐ 好看的裸数字 ✗"一路走到
    /// ⭐ **界面读数** ✓，⭐ 结论必须是"⭐ 验不过 ✗"（⭐ 不是"⭐ 剩余 N 天 ✗"✓）。
    #[test]
    fn the_reading_itself_refuses_to_borrow_numbers_from_an_unverified_text() {
        use crate::relay_client::{
            license_view_from, status_payload_from, verified_window_with, RelayConfig as Cfg,
        };
        let (sk, entry) = judge_key();
        // ① 验过 ⇒ `verified` ＋ ⭐ 天数来自**验过的声明** ✓（⭐ 配置里那个假数字不许被采用 ✓）
        let good = Cfg {
            url: Some("http://127.0.0.1:8899".to_string()),
            license: Some(mint(&sk, &payload(None, None))),
            license_exp: Some(9_999_999),
            ..Default::default()
        };
        let view = license_view_from(&verified_window_with(&good, 1_500, &[entry.clone()]));
        assert_eq!(view.source, "verified");
        assert_eq!(view.refusal, None);
        assert!(view.crossnet_allowed, "验过且在有效期内 ⇒ 放行跨网");
        // ② 文本验不过 ⇒ ⭐ 读数里**一个天数都不许有** ✗ ＋ ⭐ 不许放行 ✓
        let bad = Cfg {
            url: Some("http://127.0.0.1:8899".to_string()),
            license: Some("SHUYO-LIC-1.zzz.zzz".to_string()),
            license_nbf: Some(1),
            license_exp: Some(9_999_999),
            ..Default::default()
        };
        let bad_view = license_view_from(&verified_window_with(&bad, 1_500, &[entry.clone()]));
        assert_eq!(bad_view.source, "refused");
        assert_eq!(bad_view.state, "refused");
        assert_eq!(bad_view.days_left, None, "⛔ 验不过就不许有天数");
        assert_eq!(bad_view.grace_days_left, None);
        assert!(!bad_view.crossnet_allowed, "验不过 ⇒ 跨网不放行");
        assert!(bad_view.refusal.is_some(), "要给出机器可读的原因码");
        assert!(
            !bad_view.label.contains("剩余"),
            "那句话里⛔ 不许出现天数说法：{}",
            bad_view.label
        );
        // ③ ⭐ **整份读数**（⭐ 界面真正吃到的那份 ✓）⭐ 也必须是拒收 ✗
        let whole = status_payload_from(Ok(bad), 1_500, None);
        assert_eq!(whole.license.source, "refused");
        assert_eq!(whole.license.days_left, None);
        assert!(!whole.license.crossnet_allowed);
        // ④ 没有签名文本 ⇒ ⭐ 才是占位（⭐ 与"验过"分开 ✓）
        let placeholder = Cfg {
            license_exp: Some(9_999_999),
            ..Default::default()
        };
        let p_view = license_view_from(&verified_window_with(&placeholder, 1_500, &[entry]));
        assert_eq!(p_view.source, "placeholder");
        assert!(!p_view.source.contains("verified"));
    }
    ///
    /// ⚠️ ⭐ 第一版这条判据**太钝** ✗（实测当场红）：它按"提到名字"扫 `.rs` ⇒ 命中三处，
    /// 一处是**注释里写明出处**（⭐ 好习惯，⛔ 不该判 ✗）、一处是**临时目录名**（⭐ 无害 ✓）、
    /// 一处是**它自己的 needle 清单**（⭐ 自吃 ✓）。⇒ ⭐ 收窄到**真泄漏面** ✗：
    ///   · ⭐ **依赖行** ✗：`Cargo.toml` 里不许把那几个包当依赖（⭐ 唯一真能把代码带进来的路 ✓）
    ///   · ⭐ **路径引用** ✗：不许 `path = …` 指向那个仓（⭐ 或者 `include!` 它的文件 ✓）
    ///   · ⭐ **不许出现它的 crate 名当 Rust 标识符** ✗（`use` ／ `extern crate` ✓）
    #[test]
    fn no_proprietary_relay_code_leaked_into_the_product_repo() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let names = ["shuyonote-relay", "relay-license-gate", "license-format"];
        let names_us = ["shuyonote_relay", "relay_license_gate", "license_format"];
        let mut hits: Vec<String> = Vec::new();

        // ⭐ ① 依赖行 ✗：⭐ 唯一真能把专有代码带进来的路 ✓
        let manifest = std::fs::read_to_string(root.join("Cargo.toml")).expect("读得到 Cargo.toml");
        for line in manifest.lines() {
            let code = line.split('#').next().unwrap_or("").trim();
            if code.is_empty() || code.starts_with('[') {
                continue;
            }
            if names.iter().any(|n| code.contains(n)) {
                hits.push(format!("Cargo.toml 依赖行：{code}"));
            }
        }

        // ⭐ ②③ 逐个 `.rs` ✗（⭐ 排除本判据自己 —— 它必然写着这些名字 ✓）
        let mut stack = vec![root.join("src")];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("读得到 src").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                    continue;
                }
                if path.file_name().and_then(|n| n.to_str()) == Some("relay_license.rs") {
                    continue; // ⭐ 就这一份判据自己 ✓
                }
                let text = std::fs::read_to_string(&path).expect("读得到 .rs");
                for (i, line) in text.lines().enumerate() {
                    let code = line.split("//").next().unwrap_or("").trim();
                    // ⭐ 路径引用 ✗（⭐ `path = "…"` ／ `include!` ／ `include_str!` ✓）
                    if (code.contains("path") || code.contains("include!"))
                        && names.iter().any(|n| code.contains(n))
                    {
                        hits.push(format!("{}:{} 路径引用：{code}", path.display(), i + 1));
                    }
                    // ⭐ 当 Rust 标识符用 ✗（⭐ `use` ／ `extern crate` ✓）
                    if (code.contains("use ") || code.contains("extern crate"))
                        && names_us.iter().any(|n| code.contains(n))
                    {
                        hits.push(format!("{}:{} 引入专有 crate：{code}", path.display(), i + 1));
                    }
                }
            }
        }
        assert!(
            hits.is_empty(),
            "⛔ 产品仓里出现了专有中继仓的**依赖／路径／crate 引用**：{hits:?}（⭐ 提到名字写清出处是可以的 ✓）"
        );
    }
}
