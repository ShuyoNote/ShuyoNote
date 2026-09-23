//! **钥匙袋（keyring）**：把"每个空间一把**随机**密钥"用**主密钥包裹**起来 ——
//! 决策稿 [加密作用域](../docs/plans/2026-09-23-encryption-scope-decision.md) 的第 0 步。
//!
//! ## 为什么是这个形状（三层，缺一层都不行）
//!
//! ```text
//! 口令 ──(Argon2id ＋ 公开的盐/参数)──▶ 主密钥（只在内存里，不落盘）
//!                                          │  包裹（wrap）
//!                     ┌────────────────────┼────────────────────┐
//!                     ▼                    ▼                    ▼
//!              📦空间A的盒子          📦空间B的盒子          📦空间C的盒子
//!               （空间A的随机密钥）    （空间B的随机密钥）    （空间C的随机密钥）
//! ```
//!
//! · **一个口令**：用户只记一句话 ⇒ 不是"每空间一个口令"（那要记 N 句）；
//! · **每空间随机密钥**：不是"口令直接算出每空间钥匙"（那种做法里"分享一个空间"＝交出全部空间）；
//! · **盒子可以公开**：它是密文，没有主密钥打不开 ⇒ 所以"盐 ＋ 参数 ＋ 盒子"这一半
//!   **可以同步、可以放服务端**，换设备时把盒子取回来 ＋ 输一次口令即可。
//!
//! ## 第 0 步的边界（**先格式与判据，不接线**）
//!
//! · 本模块**不碰**任何现有路径：`encryption_enabled` / `key_space_conn` / `encrypt_payload` 一字不动
//!   ⇒ 存量行为零变化（"现状按空间"是第 1 步、闸门是第 2 步）；
//! · **参数驱动派生**（`Argon2::new(Params::new(m,t,p))`、SM 侧迭代数）留 **0a-2**：
//!   它要动"全应用密钥派生"那条路，得单独一片 ＋ 实测解锁耗时。本步**存参数 ＋ 校验**
//!   （不一致 ⇒ **报错**，绝不静默换参数推出一把错钥匙）；
//! · 盒子的**加解密复用 `crypto`**（同一套 AEAD 与密文头、含国密构建的 v2 路径）⇒ 不写第二份加密。
//!
//! ## 两条纪律
//!
//! 1. **绑定空间**：盒子里装的是 `空间id ＋ 密钥`（长度前缀），解开时必须逐字节核对
//!    ⇒ 有人把"空间B的盒子"塞到"空间A"的位置，**当场报错**而不是给出一把错钥匙；
//! 2. **认不出的版本不许猜**：`v` 不是本构建认识的 ⇒ 报错（与 wire 的 `crdt_state` 同一纪律）。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::crypto::{self, AppKeys};

/// 钥匙袋的格式版本。
pub const KEYRING_VERSION: u16 = 1;
/// 每空间密钥的长度（32 字节，与 `AppKeys.legacy` 同宽）。
pub const SPACE_KEY_LEN: usize = 32;

/// 本构建**今天的** Argon2id 参数（与 `crypto::derive_app_keys` 里的 `Argon2::default()` 一致）。
///
/// ⚠️ 这三个数字是"要写进公开材料"的东西：写下来、跟着袋子走 ⇒ 将来默认值变了，
/// 老袋子仍按**它自己记的**参数解（0a-2 做参数驱动派生；本步先做到"不一致就报错"）。
/// 判据 `current_params_match_the_library_default` 会盯着它们不许和库默认悄悄漂开。
pub const ARGON2_M_KIB: u32 = 19456; // 19 MiB
pub const ARGON2_T: u32 = 2;
pub const ARGON2_P: u32 = 1;

/// KDF 的**公开参数**（＝可以进"公开材料"的那一半；盐不是秘密）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    /// 算法名（今天恒为 `"argon2id"`；国密构建下 SM 侧另有 `sm_iterations`）。
    pub algo: String,
    /// 盐（hex）。**不是秘密** —— 它必须能被第二台设备拿到，否则同一句口令推出不同的钥匙。
    pub salt_hex: String,
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
    /// SM（PBKDF2-HMAC-SM3）侧的迭代数；`None` ＝ "用本构建默认"。
    pub sm_iterations: Option<u32>,
}

impl KdfParams {
    /// 本构建今天的参数 ＋ 一个新随机盐。
    pub fn fresh() -> Self {
        Self {
            algo: "argon2id".to_string(),
            salt_hex: hex::encode(crypto::random_salt()),
            m_kib: ARGON2_M_KIB,
            t: ARGON2_T,
            p: ARGON2_P,
            sm_iterations: None,
        }
    }

    /// 与"本构建当前的参数"是否一致。**不一致 ⇒ 报错**（不许静默换一套参数推出另一把钥匙）。
    pub fn ensure_supported(&self) -> Result<(), String> {
        if self.algo != "argon2id" {
            return Err(format!("钥匙袋用的 KDF 是 {}，本版只认 argon2id", self.algo));
        }
        if (self.m_kib, self.t, self.p) != (ARGON2_M_KIB, ARGON2_T, ARGON2_P) {
            return Err(format!(
                "钥匙袋的 KDF 参数（m={} t={} p={}）与本版（m={ARGON2_M_KIB} t={ARGON2_T} p={ARGON2_P}）不同 —— \
                 参数驱动派生还没落地（0a-2）：**不要**用另一套参数去解，那会得到一把错钥匙并报成'口令错'",
                self.m_kib, self.t, self.p
            ));
        }
        if self.sm_iterations.is_some() {
            return Err("钥匙袋指定了 SM 侧迭代数，但参数驱动派生还没落地（0a-2）".to_string());
        }
        Ok(())
    }

    /// 盐（字节）。
    pub fn salt(&self) -> Result<Vec<u8>, String> {
        hex::decode(&self.salt_hex).map_err(|e| format!("钥匙袋的盐不是合法 hex：{e}"))
    }

    /// 口令 ⇒ **主密钥**（只在内存里用；不落盘）。
    ///
    /// ⚠️ 参数校验在派生**之前**：宁可报"参数不支持"，也不要静默用另一套参数算出一把错钥匙
    /// （那会把"钥匙袋坏了"伪装成"口令输错了"）。
    pub fn derive_master(&self, passphrase: &str) -> Result<AppKeys, String> {
        self.ensure_supported()?;
        crypto::derive_app_keys(passphrase, &self.salt()?)
    }
}

/// 一个**盒子**：空间密钥被主密钥包裹之后的密文（hex）。可以公开。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrappedBox {
    pub box_hex: String,
}

/// **钥匙袋**：公开参数 ＋ 每个空间一个盒子。这一整个 JSON **可以同步/可以放服务端**
/// （它里面没有口令、也没有裸密钥）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Keyring {
    pub v: u16,
    pub kdf: KdfParams,
    pub spaces: BTreeMap<String, WrappedBox>,
}

/// 生一把新的**空间密钥**（随机 32 字节）。
///
/// ⚠️ 随机数**只从 `crypto` 那一层出**（`crypto::random_32` 与 `random_salt` 用同一个 `OsRng` 入口）——
/// 不在本模块另开一条随机数路径（那会变成两处 CSPRNG 配置，日后一处被换掉另一处没人知道）。
pub fn random_space_key() -> [u8; SPACE_KEY_LEN] {
    crypto::random_32()
}

/// 盒子里装的明文：`u32(be) 空间id长度 || 空间id || 32 字节密钥`
/// —— 长度前缀让"绑定空间"这件事**可判**（不许靠猜分隔符）。
fn seal_plaintext(space_id: &str, key: &[u8; SPACE_KEY_LEN]) -> Vec<u8> {
    let id = space_id.as_bytes();
    let mut out = Vec::with_capacity(4 + id.len() + SPACE_KEY_LEN);
    out.extend_from_slice(&(id.len() as u32).to_be_bytes());
    out.extend_from_slice(id);
    out.extend_from_slice(key);
    out
}

fn open_plaintext(plain: &[u8], space_id: &str) -> Result<[u8; SPACE_KEY_LEN], String> {
    if plain.len() < 4 {
        return Err("钥匙袋的盒子内容太短（不是本版写的）".to_string());
    }
    let n = u32::from_be_bytes([plain[0], plain[1], plain[2], plain[3]]) as usize;
    if plain.len() != 4 + n + SPACE_KEY_LEN {
        return Err("钥匙袋的盒子内容长度不对（不是本版写的，或已被破坏）".to_string());
    }
    let id = std::str::from_utf8(&plain[4..4 + n]).map_err(|_| "盒子里的空间 id 不是合法 UTF-8".to_string())?;
    if id != space_id {
        // ★ 承重：盒子与槽位绑死 —— 有人把别的空间的盒子搬过来，必须**当场报错**
        return Err(format!("这个盒子属于空间「{id}」，不是「{space_id}」（盒子被换过？）"));
    }
    let mut key = [0u8; SPACE_KEY_LEN];
    key.copy_from_slice(&plain[4 + n..]);
    Ok(key)
}

impl Keyring {
    /// 造一个空袋子（**新盐**；盐要跟着袋子一起走）。
    pub fn new() -> Self {
        Self {
            v: KEYRING_VERSION,
            kdf: KdfParams::fresh(),
            spaces: BTreeMap::new(),
        }
    }

    /// **公开材料**（＝可以同步、可以放服务端的那一份）。
    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self).map_err(|e| e.to_string())
    }

    /// 从公开材料读回来。**版本不认识 ⇒ 报错**（不猜）。
    pub fn from_json(text: &str) -> Result<Self, String> {
        let parsed: Self = serde_json::from_str(text).map_err(|e| format!("钥匙袋不是合法 JSON：{e}"))?;
        if parsed.v != KEYRING_VERSION {
            return Err(format!(
                "钥匙袋版本 {} 本版不认识（本版认到 {KEYRING_VERSION}）—— 请升级应用后再打开",
                parsed.v
            ));
        }
        Ok(parsed)
    }

    pub fn has(&self, space_id: &str) -> bool {
        self.spaces.contains_key(space_id)
    }

    /// 装一把空间密钥进袋子（已有 ⇒ **覆盖**：轮换走同一条路）。
    pub fn wrap(&mut self, master: &AppKeys, space_id: &str, key: &[u8; SPACE_KEY_LEN]) -> Result<(), String> {
        let box_bytes = crypto::encrypt(&seal_plaintext(space_id, key), master)?;
        self.spaces.insert(
            space_id.to_string(),
            WrappedBox {
                box_hex: hex::encode(box_bytes),
            },
        );
        Ok(())
    }

    /// 从袋子里取一把空间密钥。取不出 ⇒ **报错**（绝不回退成明文或空钥匙）。
    pub fn unwrap_key(&self, master: &AppKeys, space_id: &str) -> Result<[u8; SPACE_KEY_LEN], String> {
        let Some(b) = self.spaces.get(space_id) else {
            return Err(format!("钥匙袋里没有空间「{space_id}」的盒子"));
        };
        let raw = hex::decode(&b.box_hex).map_err(|e| format!("盒子不是合法 hex：{e}"))?;
        let plain = crypto::decrypt(&raw, master).map_err(|e| format!("盒子打不开（口令不对或盒子被改过）：{e}"))?;
        open_plaintext(&plain, space_id)
    }

    /// 轮换一个空间的密钥（**只换这一个空间**：主口令与其它空间都不动）—— 这正是"每空间随机密钥"换来的。
    pub fn rotate(&mut self, master: &AppKeys, space_id: &str) -> Result<[u8; SPACE_KEY_LEN], String> {
        let key = random_space_key();
        self.wrap(master, space_id, &key)?;
        Ok(key)
    }

    /// 扔掉一个空间的盒子（连同它那把密钥）。
    pub fn remove(&mut self, space_id: &str) -> bool {
        self.spaces.remove(space_id).is_some()
    }
}

impl Default for Keyring {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn master(passphrase: &str) -> AppKeys {
        KdfParams {
            salt_hex: hex::encode([7u8; 16]),
            ..KdfParams::fresh()
        }
        .derive_master(passphrase)
        .unwrap()
    }

    /// ★ 本构建记下的 Argon2id 参数必须**就是**库默认 —— 否则"存参数"这件事从第一天起就是错的
    /// （库里默认值哪天变了，这条会红，提醒我们：老袋子要按它自己记的参数解）。
    #[test]
    fn current_params_match_the_library_default() {
        use argon2::{Algorithm, Argon2, Params, Version};
        let salt = [3u8; 16];
        let mut with_params = [0u8; 32];
        Argon2::new(
            Algorithm::Argon2id,
            Version::V0x13,
            Params::new(ARGON2_M_KIB, ARGON2_T, ARGON2_P, Some(32)).unwrap(),
        )
        .hash_password_into(b"pw", &salt, &mut with_params)
        .unwrap();

        let mut default = [0u8; 32];
        Argon2::default().hash_password_into(b"pw", &salt, &mut default).unwrap();
        assert_eq!(with_params, default, "记下的参数与库默认漂开了：老袋子会解不开");
        assert_eq!(crypto::derive_key("pw", &salt).unwrap(), default, "`crypto::derive_key` 也要是同一条");
    }

    #[test]
    fn wrap_unwrap_roundtrip_and_the_public_half_leaks_no_key() {
        let m = master("我家猫叫mimi");
        let mut kr = Keyring::new();
        let key = random_space_key();
        kr.wrap(&m, "space-a", &key).unwrap();

        assert!(kr.has("space-a"));
        assert_eq!(kr.unwrap_key(&m, "space-a").unwrap(), key, "取回同一把钥匙");

        // ★ 公开材料里**不许**出现裸密钥：盒子是密文，且 JSON 本身不含口令
        let public = kr.to_json().unwrap();
        assert!(!public.contains(&hex::encode(key)), "公开材料里出现了裸密钥");
        assert!(!public.contains("mimi"), "公开材料里出现了口令");
        assert!(public.contains("salt_hex"), "盐必须在公开材料里（第二台设备要用）");
        // 同一份公开材料读回来，用同一句口令仍能取回
        let back = Keyring::from_json(&public).unwrap();
        assert_eq!(back.unwrap_key(&m, "space-a").unwrap(), key);
    }

    #[test]
    fn a_box_is_bound_to_its_space_and_a_wrong_master_or_tamper_is_loud() {
        let m = master("口令一");
        let other = master("口令二");
        let mut kr = Keyring::new();
        let key = random_space_key();
        kr.wrap(&m, "space-a", &key).unwrap();

        // ① 换个空间名去解 ⇒ 报错（不许给出一把错钥匙）
        let mut moved = Keyring::new();
        moved.spaces.insert("space-b".to_string(), kr.spaces["space-a"].clone());
        let err = moved.unwrap_key(&m, "space-b").unwrap_err();
        assert!(err.contains("不是") || err.contains("打不开"), "盒子被换过要说清：{err}");

        // ② 错主密钥 ⇒ 报错（**不静默**、不回退）
        assert!(kr.unwrap_key(&other, "space-a").is_err());

        // ③ 篡改盒子的密文 ⇒ 认证失败（AEAD 挡下）
        let mut tampered = kr.clone();
        let mut raw = hex::decode(&tampered.spaces["space-a"].box_hex).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        tampered.spaces.get_mut("space-a").unwrap().box_hex = hex::encode(raw);
        assert!(tampered.unwrap_key(&m, "space-a").is_err(), "改过的盒子必须解不开");

        // ④ 袋子里没有这个空间 ⇒ 报错（不猜、不新建）
        assert!(kr.unwrap_key(&m, "space-zzz").is_err());
    }

    #[test]
    fn unknown_version_and_mismatched_kdf_params_are_refused_not_guessed() {
        let mut kr = Keyring::new();
        kr.wrap(&master("pw"), "s1", &random_space_key()).unwrap();
        let json = kr.to_json().unwrap();

        // ① 版本不认识 ⇒ 报错（与 wire 的 `crdt_state` 同一纪律）
        let bumped = json.replace("\"v\": 1", "\"v\": 99");
        assert!(Keyring::from_json(&bumped).is_err());

        // ② 参数被改成另一套 ⇒ **在派生之前**就拒绝（否则会伪装成"口令错"）
        //    ⚠️ 这里**不用** `unwrap_err()`：它要求 `AppKeys: Debug`，而 `AppKeys` **故意**没有 Debug
        //    （密钥材料不该能被打印进日志）—— 判据要顺着这个约束写，而不是为了好写给密钥加 Debug。
        let mut changed = kr.clone();
        changed.kdf.m_kib = 8;
        let err = match changed.kdf.derive_master("pw") {
            Ok(_) => panic!("参数变了还敢派生"),
            Err(e) => e,
        };
        assert!(err.contains("参数"), "{err}");
        let mut sm = kr.clone();
        sm.kdf.sm_iterations = Some(1000);
        assert!(sm.kdf.derive_master("pw").is_err());
        let mut algo = kr.clone();
        algo.kdf.algo = "scrypt".to_string();
        assert!(algo.kdf.derive_master("pw").is_err());

        // ③ 坏盐 ⇒ 报错（不是 panic）
        let mut bad_salt = kr.clone();
        bad_salt.kdf.salt_hex = "不是hex".to_string();
        assert!(bad_salt.kdf.derive_master("pw").is_err());
    }

    #[test]
    fn rotation_touches_only_that_space() {
        let m = master("pw");
        let mut kr = Keyring::new();
        let salt_before = kr.kdf.salt_hex.clone();
        let a1 = random_space_key();
        let b1 = random_space_key();
        kr.wrap(&m, "a", &a1).unwrap();
        kr.wrap(&m, "b", &b1).unwrap();

        let a2 = kr.rotate(&m, "a").unwrap();
        assert_ne!(a2, a1, "轮换要真的换一把");
        assert_eq!(kr.unwrap_key(&m, "a").unwrap(), a2);
        assert_eq!(kr.unwrap_key(&m, "b").unwrap(), b1, "★ 别的空间一点没动");
        assert_eq!(kr.kdf.salt_hex, salt_before, "轮换一个空间不该动主口令/盐");

        assert!(kr.remove("a"), "扔盒子");
        assert!(!kr.has("a"));
        assert!(!kr.remove("a"), "扔第二次是 false，不是错误");
        assert_eq!(kr.unwrap_key(&m, "b").unwrap(), b1, "扔 a 不影响 b");
    }
}
