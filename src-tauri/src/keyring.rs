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

/// 本构建**新建袋子时**记下的 Argon2id 参数（**这是我们选的**，不再"跟着库默认走"）。
///
/// ⚠️ 这三个数字是"要写进公开材料"的东西：写下来、跟着袋子走 ⇒ 默认值哪天变了，
/// 老袋子仍按**它自己记的**参数解（`KdfParams::derive_master` 走 `crypto::derive_app_keys_with`）。
/// 判据 `our_params_are_chosen_while_the_sqlcipher_path_stays_on_the_library_default` 钉着这个数字；
/// 判据 `an_old_bag_recorded_with_the_previous_params_still_derives_its_old_key` 钉着"老袋子照样能解"。
/// ⚠️ 与 `crypto::derive_key`（SQLCipher 那条库级口径）**不是一回事**，改这里**不许**动那条。
pub const ARGON2_M_KIB: u32 = 65536; // 64 MiB（owner 件1=B：抬内存硬化；真机实测见交接文档 §6）
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

    /// 这份材料记的参数**本版能不能用**。**不能用 ⇒ 报错**（不许静默换一套参数推出另一把钥匙）。
    ///
    /// ⚠️ 这里**刻意不再要求"与本版常量完全相等"**（2026-09-24，owner 件1=B 的前置）：
    /// 派生已经是**按材料自己记的参数**走的（`derive_app_keys_with`），所以"和本版默认不同"根本
    /// 不是错误 —— 那是**老袋子**，它就该按它自己那套解。留下来的守卫只管两件真会出错的事：
    /// ① 算法不认识；② 参数落在明显不合理的区间（会被 argon2 拒绝、或让派生慢到不可用）。
    /// 为什么必须放宽：不放宽的话，把默认值往上一抬，**所有老袋子会被判"参数与本版不同"直接打不开**。
    pub fn ensure_supported(&self) -> Result<(), String> {
        if self.algo != "argon2id" {
            return Err(format!("钥匙袋用的 KDF 是 {}，本版只认 argon2id", self.algo));
        }
        // 合理区间（**宽进严出**：只要 argon2 真的算得出来、且不至于把机器拖死，就放行）。
        // 下界 8 MiB / 上界 1 GiB；t 1..=16；p 1..=8。越界 ⇒ 报错（而不是静默当成默认值）。
        let ok = (8 * 1024..=1024 * 1024).contains(&self.m_kib)
            && (1..=16).contains(&self.t)
            && (1..=8).contains(&self.p);
        if !ok {
            return Err(format!(
                "钥匙袋的 KDF 参数（m={} KiB t={} p={}）不在本版支持的区间里（m 8 MiB..1 GiB / t 1..16 / p 1..8）—— \
                 参数驱动派生是按它自己记的那套算，但这一套本版不敢用",
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
    /// ★ 派生用的是**这份材料自己记的**参数（不是本构建的默认值）—— 这就是"参数随袋子走"：
    /// 本版默认抬到 64 MiB 之后，19 MiB 的老袋子照样解得出原来那把主密钥（判据钉着这件事）。
    pub fn derive_master(&self, passphrase: &str) -> Result<AppKeys, String> {
        self.ensure_supported()?;
        crypto::derive_app_keys_with(passphrase, &self.salt()?, self.m_kib, self.t, self.p)
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

    /// ★★ **D：解锁耗时的实测读数**（owner 2026-09-24：「实测后决定」）。
    ///
    /// 测的是**真解锁路径**（`KdfParams::derive_master` ⇒ `crypto::derive_app_keys`，含国密那一步），
    /// 外加两档"更抗爆破"的参数作为对照（那两档要靠 0a-2 的**参数驱动派生**才用得上，
    /// 这里只用 `argon2` 直接量成本）。读数靠 `--nocapture` 打印；判据只钉"跑得出来且是正数"，
    /// **不做时限断言**（`graphLayout` 那条计时判据的教训：墙钟不该当门禁）。
    #[test]
    fn unlock_time_reading() {
        use argon2::{Algorithm, Argon2, Params, Version};
        let salt = [7u8; 16];
        let kr = Keyring::new();
        fn time(f: &mut dyn FnMut()) -> u128 {
            let t0 = std::time::Instant::now();
            f();
            t0.elapsed().as_millis()
        }
        let mut cur = || {
            kr.kdf.derive_master("我家猫叫mimi").unwrap();
        };
        let cur_ms: Vec<u128> = (0..3).map(|_| time(&mut cur)).collect();
        let params_ms = |m_kib: u32, t: u32, p: u32| -> Vec<u128> {
            (0..3)
                .map(|_| {
                    let mut out = [0u8; 32];
                    time(&mut || {
                        Argon2::new(
                            Algorithm::Argon2id,
                            Version::V0x13,
                            Params::new(m_kib, t, p, Some(32)).unwrap(),
                        )
                        .hash_password_into(b"pw", &salt, &mut out)
                        .unwrap();
                    })
                })
                .collect()
        };
        let mid = params_ms(65536, 3, 1); // 64 MiB / 3 轮
        let hard = params_ms(262144, 4, 1); // 256 MiB / 4 轮
        println!(
            "【实测·解锁耗时】当前参数（m={ARGON2_M_KIB}KiB t={ARGON2_T} p={ARGON2_P}）: {cur_ms:?}ms ｜ \
             64MiB/t=3: {mid:?}ms ｜ 256MiB/t=4: {hard:?}ms"
        );
        assert!(cur_ms.iter().all(|&v| v > 0), "读数要跑得出来");
    }

    /// ★ 参数是我们**选的**（不再是"跟着库默认走"）—— 把这个数字写死钉住，别让它悄悄漂。
    /// ⚠️ 同时钉住**不许动的那条**：`crypto::derive_key` 仍是库默认 —— 它同时是既有加密库的
    /// SQLCipher 原始密钥（`crypto.rs` 那条警告），改了 = 既有加密库全部打不开。
    /// 这两件事**必须分开钉**：以前那条判据要求"两者相等"，一旦默认值要抬就成了打架的枷锁。
    #[test]
    fn our_params_are_chosen_while_the_sqlcipher_path_stays_on_the_library_default() {
        use argon2::{Algorithm, Argon2, Params, Version};
        let salt = [3u8; 16];
        let mut default = [0u8; 32];
        Argon2::default()
            .hash_password_into(b"pw", &salt, &mut default)
            .unwrap();
        // ① 库级那条路**不许动**
        assert_eq!(
            crypto::derive_key("pw", &salt).unwrap(),
            default,
            "SQLCipher 那条口径被动过了（既有加密库会全打不开）"
        );
        // ② 我们选的数字写死在这里；改它必须是有意识的（owner 拍板 ＋ 真机实测），并连带改这条判据与文档
        assert_eq!(ARGON2_M_KIB, 65536, "★ 默认参数若要变，这条判据与文档要同批改");
        // ③ 我们自己那套**故意不等于**库默认（owner 件1=B：抬内存硬化）——
        //    这条从 `assert_eq` 翻成 `assert_ne` 正是"默认值抬上去了"的那个记号。
        //    ⚠️ 无论如何 ① 那行（SQLCipher 那条不许动）永远不动。
        let mut ours = [0u8; 32];
        Argon2::new(
            Algorithm::Argon2id,
            Version::V0x13,
            Params::new(ARGON2_M_KIB, ARGON2_T, ARGON2_P, Some(32)).unwrap(),
        )
        .hash_password_into(b"pw", &salt, &mut ours)
        .unwrap();
        assert_ne!(ours, default, "★ 我们选的参数必须比库默认更硬（改了这条要连带改文档）");
    }

    /// ★★ **"老袋子不许被锁在外面"**（owner 件1=B 的前置）：一份**用 19 MiB 记的**老袋子，
    /// 在本版下**照样**解得出**原来那把**主密钥（19 MiB 正是库默认 ⇒ 等于旧的 `crypto::derive_key`）。
    /// 没有这条判据，"把默认值往上抬"就等于把所有老袋子作废。
    #[test]
    fn an_old_bag_recorded_with_the_previous_params_still_derives_its_old_key() {
        let mut kp = KdfParams::fresh();
        kp.m_kib = 19456;
        kp.t = 2;
        kp.p = 1;
        assert!(kp.ensure_supported().is_ok(), "老参数必须被认（宽进）");
        let old_key = crypto::derive_key("我家猫叫mimi", &kp.salt().unwrap()).unwrap();
        assert_eq!(
            kp.derive_master("我家猫叫mimi").unwrap().legacy,
            old_key,
            "★ 老袋子解的必须还是原来那把（不然抬默认值 = 把老用户锁在外面）"
        );
        // 参数**真的**在起作用：换一套参数就该推出**另一把**（否则"按材料记的参数派生"是假的）
        let mut other = kp.clone();
        other.m_kib = 32768;
        assert_ne!(
            other.derive_master("我家猫叫mimi").unwrap().legacy,
            old_key,
            "换参数必须换钥匙"
        );
    }

    /// 守卫只管两件真会出错的事：**算法不认识** / **参数明显不合理**；**宽进**不该把老参数挡在外面。
    #[test]
    fn the_guard_rejects_unknown_algorithms_and_absurd_params_only() {
        let mut bad_algo = KdfParams::fresh();
        bad_algo.algo = "pbkdf2".to_string();
        assert!(bad_algo.ensure_supported().is_err(), "不认识的算法要挡");
        let mut too_small = KdfParams::fresh();
        too_small.m_kib = 4;
        assert!(too_small.ensure_supported().is_err(), "小到没意义的参数要挡");
        let mut too_big = KdfParams::fresh();
        too_big.m_kib = 4 * 1024 * 1024;
        assert!(too_big.ensure_supported().is_err(), "大到会把机器拖死的参数要挡");
        let mut fine = KdfParams::fresh();
        fine.m_kib = 32768;
        fine.t = 3;
        assert!(fine.ensure_supported().is_ok(), "合理区间内的非默认参数要放行（宽进）");
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
