//! **每台设备一把自己的钥匙（Ed25519 设备身份）** —— 方案
//! `docs/plans/2026-10-11-device-identity-keys.md`（owner 2026-10-11 拍 ③）。
//!
//! ## 为什么要有它
//! 现在的门禁是"一串**两家共用**的口令" ⇒ ⭐ ① 分不出"是哪一台" ✗、⭐ ② 知道口令的第三方照样能拿 ✗、
//! ⭐ ③ "逐台撤回"名不副实 ✗（三条都有实测，见方案 §1 ✓）。本模块只做**第 1 步**：
//! ⭐ **钥匙的生成与落盘** ✗ —— ⛔ 不碰门、不碰配对流程 ✗（那些是第 2／3 步 ✓）。
//!
//! ## 三条纪律
//! 1. ⭐ **私钥不出这个模块** ✗：对外只有两件事 —— ⭐ 公钥（十六进制 ✓）与 ⭐ 对一段字节的签名 ✓；
//!    ⛔ 没有"把私钥取出来"的出口 ✗（判据 `the_private_key_never_leaves_the_module` ✓ 钉这条 ✓）。
//! 2. ⭐ **绝不覆盖已有的那把** ✗：换身份 ＝ 所有已建立的信任**全部失效** ✓
//!    （判据 `an_existing_key_is_never_overwritten` ✓）。
//! 3. ⭐ **私钥不进日志、不进界面、不进广播** ✗（⭐ 出去的只有公钥 ✓）。
//!
//! ## 存哪（⚠️ 改这里之前先读方案 §3 那一整段）
//! ⭐ 明文进 `meta.sync_state`（键 `device_identity_sk` ✓）。⭐ 已知代价如实写 ✗：
//! 能读 `meta.db` 的人就能冒充这台设备 ✓；⭐ 但**不比今天更差** ✗ ——
//! 今天那把万能钥匙（`mesh_token`）就在同一个库里明摆着 ✓。想抬这一档是**另一片**（方案 §3 的乙/丙 ✓）。
//!
//! ## ⚠️ 一条算法层边界
//! 本模块用 **Ed25519**（`ed25519-dalek` ✓，仓里许可证验签已在用 ✓，⛔ 零新依赖 ✓）。
//! ⛔ 它**不是国密算法** ✗ —— 但两者**不是同一层**：国密那边管的是**内容加密**（`crypto_sm` ✓），
//! 这里管的是**设备身份与请求签名** ✓。⭐ 这条边界由 owner 在选 ③ 时拍过 ✓（方案 §0.1 ③ ✓）。

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use rusqlite::Connection;

/// 设备身份私钥的存储键（⭐ 明文十六进制 ✗ —— 见头注"存哪" ✓）。
///
/// ⚠️ **这个名字换了 ＝ 老机器上的身份就"不见了"** ✗（不等于丢，等于**换了一把新的** ✓）
/// ⇒ ⭐ 判据里用**字面量**再钉一遍 ✓（⛔ 不跟着常量走 ✗：常量改了判据照样绿就没意义了 ✓）。
const DEVICE_IDENTITY_SK: &str = "device_identity_sk";

/// ⭐ 本机的设备身份 ✗（⭐ 私钥封在里面 ✓，⛔ 没有任何取私钥的出口 ✗）。
pub struct DeviceIdentity {
    signing: SigningKey,
}

impl DeviceIdentity {
    /// ⭐ 公钥的十六进制（64 个字符 ✓）—— ⭐ 这是**可以示人**的那一半 ✓（随公告走 ✓）。
    pub fn public_key_hex(&self) -> String {
        hex::encode(self.signing.verifying_key().as_bytes())
    }

    /// ⭐ 对一段字节签名 ⇒ 十六进制（128 个字符 ✓）—— ⭐ 门那一侧用公钥验 ✓。
    pub fn sign_hex(&self, message: &[u8]) -> String {
        hex::encode(self.signing.sign(message).to_bytes())
    }
}

/// ⭐⭐ **取出本机身份；库里还没有就当场生成一把** ✗。
///
/// ⛔ **已有那把一个字节都不动** ✗（建新的 ＝ 换身份 ＝ 已建立的信任**全部失效** ✓，
/// 而且**不会有任何报错** ✗ —— 只在对端那边变成"谁都进不来" ✓）。
pub fn load_or_create(c: &Connection) -> Result<DeviceIdentity, String> {
    if let Some(stored) = crate::sync::get_meta_state(c, DEVICE_IDENTITY_SK) {
        let t = stored.trim();
        if !t.is_empty() {
            return Ok(DeviceIdentity { signing: secret_from_hex(t)? });
        }
    }
    let seed = crate::crypto::random_32();
    let signing = SigningKey::from_bytes(&seed);
    // ⚠️ 先落库再返回 ✗：⛔ 不能"先用着、晚点再存"✗ —— 那样一次崩溃就换了一次身份 ✓。
    crate::sync::set_meta_state(c, DEVICE_IDENTITY_SK, &hex::encode(seed))?;
    Ok(DeviceIdentity { signing })
}

/// ⭐ **只读**：本机公钥的十六进制（⭐ 还没建过 ⇒ `None` ✓，⛔ **不**在这里生成 ✗）。
///
/// ⚠️ 给**公告**用（⭐ 那是一条每秒都可能跑的读路径 ✓）—— ⛔ 读路径不写库 ✗（本仓的老规矩 ✓）；
/// 建键只发生在**写路径**上（`mesh_set_config` ✓，与 `migrate_device_level_mesh` 同一处 ✓）。
pub fn public_key_hex_of(c: &Connection) -> Result<Option<String>, String> {
    let Some(stored) = crate::sync::get_meta_state(c, DEVICE_IDENTITY_SK) else {
        return Ok(None);
    };
    let t = stored.trim();
    if t.is_empty() {
        return Ok(None);
    }
    // ⭐ 连**形状**一起核 ✓：库里那一格坏了 ⇒ 如实报"读不出来" ✓，⛔ 不许当成"没有身份"✗
    //   （两者的处置完全不同 ⇒ 界面上/日志里必须长得不一样 ✓）。
    Ok(Some(hex::encode(secret_from_hex(t)?.verifying_key().as_bytes())))
}

/// ⭐ 拿**公钥**验一段签名 ✗（⭐ 第 2 步的门要用它 ✓；本步先与"签"配成一对判据 ✓）。
///
/// ⚠️ 形状不对（长度／十六进制／点不在曲线上）⇒ ⭐ **如实回 `false`** ✗，⛔ 不 panic ✗ ——
/// ⭐ 门的输入来自网线 ✓ ⇒ 烂输入是**常态** ✓。
pub fn verify_hex(public_key_hex: &str, message: &[u8], signature_hex: &str) -> bool {
    let Ok(pk) = hex::decode(public_key_hex.trim()) else { return false };
    let Ok(pk_arr) = <[u8; 32]>::try_from(pk.as_slice()) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&pk_arr) else { return false };
    let Ok(sig) = hex::decode(signature_hex.trim()) else { return false };
    let Ok(sig_arr) = <[u8; 64]>::try_from(sig.as_slice()) else { return false };
    let sig = ed25519_dalek::Signature::from_bytes(&sig_arr);
    use ed25519_dalek::Verifier;
    vk.verify(message, &sig).is_ok()
}

/// 十六进制 ⇒ 那一把私钥（⚠️ 报错里 ⛔ **不含**私钥内容 ✗）。
fn secret_from_hex(t: &str) -> Result<SigningKey, String> {
    let raw = hex::decode(t)
        .map_err(|_| "库里那把设备私钥不是十六进制 ⇒ **不猜**（把这一格清掉会换一把新身份，请先确认）".to_string())?;
    let seed = <[u8; 32]>::try_from(raw.as_slice()).map_err(|_| {
        format!("库里那把设备私钥长度不对（{} 字节，应当是 32）⇒ 不猜", raw.len())
    })?;
    Ok(SigningKey::from_bytes(&seed))
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 自带夹具：`meta` 那个 schema ＋ `sync_state` 那张表就够（⭐ 与 `sync.rs` 的夹具同形 ✓）。
    /// ⚠️ **不能**用裸 meta 连接或裸内存库 ✗：`set_meta_state` 写的是**限定名** `meta.sync_state` ✓
    /// ⇒ 没有 `meta` 这个 schema 的连接上必然 `no such table` ✗（本仓栽过，见 `sync.rs` 那条判据 ✓）。
    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "ATTACH DATABASE ':memory:' AS meta;
             CREATE TABLE meta.sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
        c
    }

    /// ⭐ 判据①：⭐ 同一台设备**两次读出来是同一把** ✗（⛔ 不是每次现生成 ✗）。
    #[test]
    fn two_calls_hand_back_the_same_identity() {
        let c = fixture();
        let a = load_or_create(&c).expect("第一次应当能建起来");
        let b = load_or_create(&c).expect("第二次应当读得回来");
        assert_eq!(
            a.public_key_hex(),
            b.public_key_hex(),
            "⛔ 两次读出来必须是同一把公钥 ✗（每次现生成 ＝ 每次都在换身份 ✓）"
        );
        assert_eq!(a.public_key_hex().len(), 64, "Ed25519 公钥 ＝ 32 字节 ⇒ 64 个十六进制字符");
    }

    /// ⭐⭐ 判据②（**这条最要紧**）：⭐ 库里已经有那把 ⇒ ⛔ **一个字节都不许动** ✗。
    ///
    /// ⚠️ 换身份 ＝ 所有已建立的信任**全部失效** ✓ —— 而这件事**不会有任何报错** ✗，
    /// 只会在对端那边变成"谁都进不来" ✓（与"删了等于没删"同一族的静默事故 ✓）。
    #[test]
    fn an_existing_key_is_never_overwritten() {
        let c = fixture();
        // 一把**已知的**私钥（32 字节 ⇒ 十六进制 64 字符 ✓）
        let known = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
        crate::sync::set_meta_state(&c, "device_identity_sk", known).unwrap();
        let id = load_or_create(&c).expect("已有那把 ⇒ 必须读得回来");
        assert_eq!(
            crate::sync::get_meta_state(&c, "device_identity_sk").as_deref(),
            Some(known),
            "⛔ 已有那把被改写了 ✗（＝ 悄悄换身份 ⇒ 对端那边所有信任一起失效 ✓）"
        );
        // ⭐ 而且读回来的**确实是那一把**（⛔ 不是"没动库、但用的是新生成的"✗）
        let again = load_or_create(&c).unwrap();
        assert_eq!(id.public_key_hex(), again.public_key_hex(), "同一把私钥 ⇒ 同一个公钥");
        assert_eq!(id.public_key_hex().len(), 64);
    }

    /// ⭐ 判据③：⭐ 签出来的东西，拿**公钥**验得过 ✗（第 2 步的门就靠这一对 ✓）。
    #[test]
    fn a_signature_verifies_against_the_public_key() {
        let c = fixture();
        let id = load_or_create(&c).unwrap();
        let msg = b"mesh/pull?space_id=room-1&device=dev-a&ts=1700000000";
        let sig = id.sign_hex(msg);
        assert_eq!(sig.len(), 128, "Ed25519 签名 ＝ 64 字节 ⇒ 128 个十六进制字符");
        assert!(
            verify_hex(&id.public_key_hex(), msg, &sig),
            "⭐ 自己签的、拿自己的公钥验 ⇒ 必须过 ✓"
        );
        // ⛔ 反面（别把"永远返回 true"当成通过 ✗）：换一个字、换一段消息、换一把公钥 ⇒ 都必须**不过**
        // ⚠️⭐ **"改一个字节"必须真的改掉它** ✗：我原先写的是无条件 `replace_range(0..2, "00")` ✓ ——
        //    ⭐ 而这一把钥匙是**每次现场随机生成**的 ✓ ⇒ 签名头两位**本来**就是 `"00"` 的概率约
        //    **1/256** ✗ ⇒ 那一次"篡改后"与原件**逐字节相同** ⇒ 下面那条断言**红在空气上** ✓。
        //    ⭐ **实测就是这么红的**：CI 的 `rust-sm-wired` 那一趟（`--features sm-library` 全量单测）
        //    报 `device_key::tests::a_signature_verifies_against_the_public_key ... FAILED` ✓，
        //    而本机连跑几趟都是绿的 ✓（⇒ 1/256 的偶发 ✗ —— 本地绿 ≠ CI 绿的那一族 ✓）。
        let mut tampered = sig.clone();
        let flipped = if sig.starts_with("00") { "11" } else { "00" };
        tampered.replace_range(0..2, flipped);
        // ⭐ 前提**明写出来** ✓：不写这一句，将来谁再把它改成"可能等于原件"的写法，
        //   下面那条断言仍然会**偶发地**绿过去 ✓（本仓老手法：把前提也钉成判据 ✓）。
        assert_ne!(tampered, sig, "⭐ 前提：这一步必须**真的改掉**它（⛔ 否则下面那条量的是空气 ✗）");
        assert!(!verify_hex(&id.public_key_hex(), msg, &tampered), "改了签名 ⇒ 不许过");
        assert!(!verify_hex(&id.public_key_hex(), b"another-message", &sig), "换了消息 ⇒ 不许过");
        let other = load_or_create(&fixture()).unwrap();
        assert!(
            !verify_hex(&other.public_key_hex(), msg, &sig),
            "⛔ 换一把公钥就验不过 ✗（否则签名不绑定身份 ✓）"
        );
    }

    /// ⭐ 判据④：⭐ 形状不对的输入 ⇒ **如实回 false** ✗，⛔ 不 panic ✗
    /// （⭐ 门的输入来自网线 ✓ ⇒ 烂输入是**常态** ✓）。
    #[test]
    fn malformed_inputs_are_refused_instead_of_panicking() {
        let c = fixture();
        let id = load_or_create(&c).unwrap();
        let sig = id.sign_hex(b"x");
        for bad in ["", "zz", "00", &"0".repeat(126)] {
            assert!(!verify_hex(bad, b"x", &sig), "公钥形状不对（{bad}）⇒ false");
        }
        for bad in ["", "zz", &"0".repeat(126)] {
            assert!(!verify_hex(&id.public_key_hex(), b"x", bad), "签名形状不对（{bad}）⇒ false");
        }
    }

    /// ⭐ 判据⑤（**文本级** ✓，⭐ 这条钉的是"出口只有那两个" ✗）：⭐ 私钥**没有**任何取出去的函数 ✓。
    ///
    /// ⚠️ 为什么用文本级 ✗：类型层面"私钥不许泄漏"是**可以被类型表达**的 ✓（`SigningKey` 只以私有字段存在 ✓），
    /// 但"将来有人顺手加一个 `pub fn secret_hex(&self)`"这件事**类型拦不住** ✗ ⇒ 用一条会红的判据钉住 ✓
    /// （本仓的手法：⭐ 门禁先剥注释再匹配 ✓）。
    #[test]
    fn the_private_key_never_leaves_the_module() {
        let src = include_str!("device_key.rs");
        let code: String = src
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        // ⚠️ ⭐ **这几个模式必须"拼出来"** ✗：`include_str!` 把**本判据自己**也读进去了 ✓
        //   ⇒ 直接写字面量 ⇒ **红在自己的说明上** ✓（本仓早记过这条：一条"不许出现 X"的判据，
        //     它的源码里就有 X ⇒ 永远红 ✓）。
        for banned in [
            concat!("pub fn ", "secret"),
            concat!("pub fn ", "private"),
            concat!("pub fn ", "export_sk"),
            concat!("pub fn ", "to_bytes"),
        ] {
            assert!(
                !code.contains(banned),
                "⛔ 出现了取私钥的出口「{banned}」✗ —— 私钥只在模块内部用 ✓"
            );
        }
        // ⭐ 正向：公开面**只有**这几件东西 ✓（多一件就要在这里显式加一行 ⇒ 想加的人得先说服判据 ✓）
        //   ⚠️ 第 5 件（`public_key_hex_of`）是**公告那条读路径**要的只读出口 ✓ ——
        //     它只回**公钥** ✓（⛔ 一个字节的私钥都不回 ✗），所以上面那串"取私钥的出口"照样是空的 ✓。
        let pubs: Vec<&str> = code
            .lines()
            .filter(|l| l.trim_start().starts_with("pub fn "))
            .map(|l| l.trim())
            .collect();
        assert_eq!(
            pubs.len(),
            5,
            "公开面变了 ⇒ 在这里逐条交代（现在应当是：load_or_create ／ public_key_hex ／ sign_hex ／ public_key_hex_of ／ verify_hex）：{pubs:?}"
        );
    }
}
