//! **按空间的加密**（决策稿 [加密作用域](../docs/plans/2026-09-23-encryption-scope-decision.md) **第 1 步**的第一半）。
//!
//! ## 为什么需要它
//!
//! 今天的开关是**应用级**的（`security.rs` 的 `encryption_enabled` 读 meta.db 一个标志，
//! `encrypt_payload` 只看它）⇒ **一开全都加密、一关全都明文**，而口径要求
//! "个人空间密文 / 团队空间明文"**同时成立**。
//!
//! ## 本片的形状（**加性**：袋子没有 ⇒ 一字不改）
//!
//! · **空间 id 从库文件主干反推**（`…/spaces/<id>.db`）⇒ `key_space_conn` 不必改签名就能"按空间取钥匙"；
//! · **钥匙袋放 meta.db**（明文，和今天的盐/哨兵同一族；它是**公开材料**，见 `keyring.rs` 头注）；
//! · **会话里存主密钥**（`SESSION_MASTER`）：解锁时从口令 ＋ 袋子里记的 KDF 参数现派生，用完即散（不落盘）；
//! · **袋子优先，旧路兜底**：`space_key_for_path` 只有"袋子里真有这个空间的盒子"时才返回钥匙；
//!   没有袋子 / 这个空间不在袋里 ⇒ `None` ⇒ 调用方走**今天那条路**（应用级 session key）⇒ **零回归**。
//!   ⚠️ 这条兜底是**过渡**用的（`不考虑向后兼容` ⇒ 第 3 步的存量迁移把大家都搬进袋子之后删掉它）。
//!
//! ## 两条纪律
//!
//! 1. **袋子有这个空间、但会话锁着 ⇒ 报错**（绝不静默退回旧钥匙 —— 那会拿错钥匙去开库，
//!    报出来的是"库打不开"，把真因藏了）；
//! 2. **袋子坏了（JSON 坏 / 版本不认识）⇒ 报错**（不静默当成"没有袋子"—— 那等于悄悄降级成明文路径）。

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::crypto::AppKeys;
use crate::keyring::Keyring;
use crate::sync;

/// meta.db 里存**公开材料**（钥匙袋 JSON）的 key。
pub const META_KEYRING: &str = "keyring";

/// 会话里的**主密钥**（＝钥匙袋的 KDF 派生物）。与 `security::SESSION_KEY` 并列：
/// 那一把是**旧的**应用级钥匙（过渡期还要用），这一把只用来解盒子。
static SESSION_MASTER: Mutex<Option<AppKeys>> = Mutex::new(None);

/// 本进程当前知道的**公开材料**（解锁/启用时从 meta 载入；锁定时清掉）。
static KEYRING: Mutex<Option<Keyring>> = Mutex::new(None);

/// 从库文件路径反推空间 id：`…/spaces/<id>.db` ⇒ `Some("<id>")`。
///
/// ⚠️ **只认我们自己那种文件**：扩展名必须是 `db`、主干非空且不以点开头
/// （`.db` / 无扩展名 / `.sqlite` 一律 `None`）⇒ 拿不出 id 就走旧路，**不猜**。
pub fn space_id_from_path(path: &Path) -> Option<String> {
    if path.extension()?.to_str()? != "db" {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    if stem.is_empty() || stem.starts_with('.') {
        return None;
    }
    Some(stem.to_string())
}

/// 把公开材料**载入**本进程（解锁/启用时调）。`None` ＝ meta 里没有 ⇒ 保持为空（旧路）。
pub fn carry_keyring(c: &Connection) -> Result<(), String> {
    let loaded = match sync::get_meta_state(c, META_KEYRING) {
        Some(text) => Some(Keyring::from_json(&text)?), // 坏了 ⇒ 报错，不静默当"没有"
        None => None,
    };
    *KEYRING.lock().map_err(|_| "钥匙袋锁失效".to_string())? = loaded;
    Ok(())
}

/// 把公开材料**写回** meta（启用/轮换/迁移时调）。
pub fn store_keyring(c: &Connection, kr: &Keyring) -> Result<(), String> {
    sync::set_meta_state(c, META_KEYRING, &kr.to_json()?)?;
    *KEYRING.lock().map_err(|_| "钥匙袋锁失效".to_string())? = Some(kr.clone());
    Ok(())
}

/// 本进程当前的公开材料（没有 ⇒ `None`）。
pub fn keyring() -> Option<Keyring> {
    KEYRING.lock().ok().and_then(|g| g.clone())
}

/// 测试用：直接装/卸公开材料（**跨模块的集成判据**要用；生产路径走 `carry_keyring` / `store_keyring`）。
#[cfg(test)]
pub(crate) fn set_keyring_for_test(kr: Option<Keyring>) {
    *KEYRING.lock().unwrap() = kr;
}

/// 会话主密钥（没解锁 ⇒ `None`）。
pub fn session_master() -> Option<AppKeys> {
    SESSION_MASTER.lock().ok().and_then(|g| *g)
}

/// 装上 / 卸下会话主密钥（解锁 → 装；锁定 → 卸）。
pub fn set_session_master(keys: Option<AppKeys>) -> Result<(), String> {
    *SESSION_MASTER.lock().map_err(|_| "会话锁失效".to_string())? = keys;
    Ok(())
}

/// 拿一句口令去**推出钥匙袋的主密钥**：meta 里没有袋子 ⇒ `Ok(None)`（不报错，旧路）。
///
/// ⚠️ 参数来自**袋子自己记的** `kdf`（不是本构建默认）—— 这正是"存参数"的用处。
pub fn master_from_passphrase(c: &Connection, passphrase: &str) -> Result<Option<AppKeys>, String> {
    match sync::get_meta_state(c, META_KEYRING) {
        Some(text) => {
            let kr = Keyring::from_json(&text)?;
            Ok(Some(kr.kdf.derive_master(passphrase)?))
        }
        None => Ok(None),
    }
}

/// **按空间的钥匙**（核心入口）：`Ok(Some(k))` ＝ 用这个空间自己的钥匙；`Ok(None)` ＝ 走旧路。
///
/// 三条出口（与文件头两条纪律一一对应）：
/// · 没有袋子 / 这个空间不在袋里 ⇒ `Ok(None)`（**旧路，一字不改**）；
/// · 袋里有它、会话有主密钥 ⇒ `Ok(Some(解出来的钥匙))`；
/// · 袋里有它、会话锁着 ⇒ `Err`（**不许**静默退回旧钥匙）；盒子里程坏/被换过也在这里报出来。
pub fn space_key(space_id: &str) -> Result<Option<[u8; 32]>, String> {
    let Some(kr) = keyring() else {
        return Ok(None); // 没有袋子 ⇒ 旧路
    };
    if !kr.has(space_id) {
        return Ok(None); // 这个空间不在袋里 ⇒ 旧路（**别的空间的盒子不影响它**）
    }
    let master = session_master().ok_or_else(|| {
        format!("空间「{space_id}」按钥匙袋是加密的，但会话未解锁（请先输口令）")
    })?;
    Ok(Some(kr.unwrap_key(&master, space_id)?))
}

/// 从**库文件路径**取这个空间的钥匙（开库路径用；拿不出空间 id ⇒ `Ok(None)`）。
pub fn space_key_for_path(path: &Path) -> Result<Option<[u8; 32]>, String> {
    match space_id_from_path(path) {
        Some(id) => space_key(&id),
        None => Ok(None),
    }
}

/// **wire 载荷**用的钥匙材料：把按空间取到的 32 字节包成 `AppKeys`（`legacy` 那一把）。
///
/// ⚠️ 为什么是 `legacy_only`：空间钥匙是**随机 32 字节**，没有"口令 ⇒ SM 那一对"的派生链
/// ⇒ 这个空间的载荷一律写 **v1（XChaCha20-Poly1305）**。国密构建下的空间级 SM 派生是**后续**的事，
/// 不在这里假装支持（假支持会让"本构建解不开"变成"能读但读出错"）。
pub fn space_app_keys_for_path(path: &Path) -> Result<Option<AppKeys>, String> {
    match space_key_for_path(path)? {
        Some(k) => Ok(Some(AppKeys::legacy_only(k))),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keyring::{random_space_key, KdfParams};

    fn master(passphrase: &str) -> (Keyring, AppKeys) {
        let kr = Keyring::new();
        let m = kr.kdf.derive_master(passphrase).unwrap();
        (kr, m)
    }

    /// ★ 空间 id 只从 `spaces/<id>.db` 反推；不是那种文件就 `None`（**不猜**）。
    #[test]
    fn space_id_comes_from_the_file_stem_only() {
        assert_eq!(space_id_from_path(Path::new(r"C:\x\spaces\s1.db")), Some("s1".into()));
        assert_eq!(space_id_from_path(Path::new("/x/spaces/活跃空间.db")), Some("活跃空间".into()));
        assert_eq!(space_id_from_path(Path::new("/x/spaces/")), None, "目录不是库文件");
        assert_eq!(space_id_from_path(Path::new("/x/spaces/.db")), None, "隐藏名不是空间 id");
        assert_eq!(space_id_from_path(Path::new("/x/spaces/s1")), None, "没扩展名 ⇒ 不认");
        assert_eq!(space_id_from_path(Path::new("/x/spaces/s1.sqlite")), None, "不是 .db ⇒ 不认");
    }

    /// ★ 没有袋子 ⇒ 一律 `None`（＝旧路，零回归）—— 这是本片最重要的一条。
    #[test]
    fn with_no_keyring_every_space_falls_back_to_the_legacy_path() {
        set_session_master(None).unwrap();
        *KEYRING.lock().unwrap() = None;
        assert!(space_key("s1").unwrap().is_none());
        assert!(space_key_for_path(Path::new("/x/spaces/s1.db")).unwrap().is_none());
        set_session_master(Some(master("pw").1)).unwrap();
        assert!(space_key("s1").unwrap().is_none(), "有主密钥但没袋子 ⇒ 仍是旧路");
        set_session_master(None).unwrap();
    }

    /// ★ 袋子里有它 ⇒ 用**它自己**那把；袋子里没有 ⇒ 旧路（**别的空间不受影响**）。
    #[test]
    fn only_the_spaces_in_the_keyring_get_their_own_key() {
        let (mut kr, m) = master("pw");
        let k1 = random_space_key();
        kr.wrap(&m, "s1", &k1).unwrap();
        *KEYRING.lock().unwrap() = Some(kr);
        set_session_master(Some(m)).unwrap();

        assert_eq!(space_key("s1").unwrap(), Some(k1), "袋子里的空间用它自己的钥匙");
        assert_eq!(space_key_for_path(Path::new("/x/spaces/s1.db")).unwrap(), Some(k1));
        assert!(space_key("s2").unwrap().is_none(), "★ 不在袋子里的空间走旧路，不受牵连");
        set_session_master(None).unwrap();
        *KEYRING.lock().unwrap() = None;
    }

    /// ★ 袋子有这个空间、但会话锁着 ⇒ **报错**（不静默退回旧钥匙：那会拿错钥匙开库、
    /// 把真因伪装成"库打不开"）。
    #[test]
    fn a_known_space_with_a_locked_session_is_a_loud_error() {
        let (mut kr, m) = master("pw");
        kr.wrap(&m, "s1", &random_space_key()).unwrap();
        *KEYRING.lock().unwrap() = Some(kr);
        set_session_master(None).unwrap();

        let err = match space_key("s1") {
            Ok(_) => panic!("锁着还敢给钥匙"),
            Err(e) => e,
        };
        assert!(err.contains("未解锁"), "{err}");
        // 别的空间不受影响：它本来就走旧路
        assert!(space_key("s2").unwrap().is_none());
        *KEYRING.lock().unwrap() = None;
    }

    /// ★ 公开材料坏了（版本不认识）必须**报错**，不许静默当成"没有袋子"（那等于悄悄降级成明文路径）。
    #[test]
    fn a_corrupt_public_half_is_refused_not_silently_ignored() {
        let (kr, _m) = master("pw");
        let good = kr.to_json().unwrap();
        assert!(Keyring::from_json(&good).is_ok());
        let bumped = good.replace("\"v\": 1", "\"v\": 99");
        assert!(Keyring::from_json(&bumped).is_err(), "版本不认识要报错");
        assert!(Keyring::from_json("{ not json").is_err());
    }

    /// 口令推主密钥：没有袋子 ⇒ `None`（不报错）；有袋子 ⇒ 与袋子的参数一致
    /// ⇒ **同一句口令 ＋ 同一份公开材料**在另一台设备上也推得出同一把（这是 0b 的前提）。
    #[test]
    fn the_master_comes_from_the_stored_kdf_params_so_another_device_can_reproduce_it() {
        let (kr, m) = master("我家猫叫mimi");
        let public = kr.to_json().unwrap();
        // 模拟第二台设备：只有公开材料 ＋ 口令
        let on_device_b = Keyring::from_json(&public).unwrap();
        let m2 = on_device_b.kdf.derive_master("我家猫叫mimi").unwrap();
        assert_eq!(m.legacy, m2.legacy, "★ 换设备靠公开材料 ＋ 口令就能推出同一把主密钥");
        assert_ne!(m.legacy, on_device_b.kdf.derive_master("别的口令").unwrap().legacy);
        // 参数不一致 ⇒ 拒绝（不静默算出另一把）
        let mut tampered = on_device_b.clone();
        tampered.kdf.t = 9;
        assert!(tampered.kdf.derive_master("我家猫叫mimi").is_err());
        assert_eq!(KdfParams::fresh().algo, "argon2id");
    }
}
