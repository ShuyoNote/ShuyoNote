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
use crate::keyring::{random_space_key, Keyring};
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

/// 只更新**进程内存**里那份公开材料（**不写 meta**）。
///
/// 为什么要单独有它：轮换时走的是"让开连接 → 转换 → **重新打开**"，而重新打开那一步要按
/// **新盒子**取钥匙 —— 可此刻 `conn` 已经是内存库，用 `store_keyring` 会去写 `meta.sync_state`
/// 而当场 `no such table`。所以顺序只能是：**先只换内存那份 → 重新打开 → 再用真正的连接写 meta**。
/// （教训出处：`enable_space` 里那句"先把袋子落下去再转换"，以及交接文档 §7.0.2。）
pub fn set_keyring_memory(kr: Keyring) -> Result<(), String> {
    *KEYRING.lock().map_err(|_| "钥匙袋锁失效".to_string())? = Some(kr);
    Ok(())
}

/// ③ 0b：本机现在那一份**公开材料**的原文（没有 ⇒ `None`）。
///
/// ⚠️ 从 **meta** 读（不是从进程内存读）：没解锁时内存里可能没有，而 meta 里有 ——
/// 「推给服务端」这件事**不需要会话解锁**（材料本来就是可以公开的那一半）。
/// ⚠️ 读出来**先验一遍能不能解析**：坏的/半截的材料**不许推上去**
/// （推上去等于把服务端上那份好副本也弄坏，而且没有第二个人能替你发现）。
pub fn stored_material(c: &Connection) -> Result<Option<String>, String> {
    match sync::get_meta_state(c, META_KEYRING) {
        Some(text) => {
            Keyring::from_json(&text)?; // 坏了 ⇒ Err（不静默推一份垃圾）
            Ok(Some(text))
        }
        None => Ok(None),
    }
}

/// 采纳一份公开材料的读数（给命令面拼人话用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdoptReport {
    /// 真的写进本机了吗。
    pub adopted: bool,
    /// 本机**本来就有**一份，所以这次没动它（不是错误）。
    pub already_local: bool,
    /// 采纳之后袋子里有几个盒子。
    pub spaces: usize,
}

/// ③ 0b：**采纳从服务端取回的公开材料**（第二台设备那一步）。
///
/// ⚠️ `overwrite=false` 时，本机**已经有袋子就拒绝**（返回 `already_local`，一个字节都不改）。
/// 为什么不是"新的覆盖旧的"：别的设备**轮换**过之后，服务端那一份可能是新的、而本机这一份
/// 才是能开当前库的那一把 —— 闷头覆盖会让本机**打不开自己的空间**。要覆盖得显式说。
/// ⚠️ 坏材料 ⇒ `Err`（**本机一个字节都不改**），并且那句话要说清这一点。
pub fn adopt_material(c: &Connection, json: &str, overwrite: bool) -> Result<AdoptReport, String> {
    if stored_material(c)?.is_some() && !overwrite {
        return Ok(AdoptReport {
            adopted: false,
            already_local: true,
            spaces: 0,
        });
    }
    let kr = Keyring::from_json(json)
        .map_err(|e| format!("这份公开材料读不懂（**没有采纳，本机一个字节都没改**）：{e}"))?;
    let spaces = kr.spaces.len();
    store_keyring(c, &kr)?; // 落 meta ＋ 装进本进程
    Ok(AdoptReport {
        adopted: true,
        already_local: false,
        spaces,
    })
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

/// 空间类型（**闸门唯一的输入**）。今天是**本地标记**，默认 `Unknown`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpaceKind {
    /// 个人空间：**必须**按空间加密之后才允许绑定同步（口径里"服务端只落密文"那一半）。
    Personal,
    /// 团队空间：**免检**（服务端明文是它刻意换来的：协同 / 检索 / AI）。
    Team,
    /// 未分类：**放行**（老库/未标记的空间都走这条 —— 绝不因为"没分类"就掐断同步）。
    Unknown,
}

impl SpaceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SpaceKind::Personal => "personal",
            SpaceKind::Team => "team",
            SpaceKind::Unknown => "",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "personal" => SpaceKind::Personal,
            "team" => SpaceKind::Team,
            _ => SpaceKind::Unknown, // 认不出来 ⇒ 未分类（**不猜**）
        }
    }
}

/// 同步闸门的裁决。**三种出口必须能区分**：拦 / 放行 / 放行但"这个空间还没分类"。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncGate {
    Allowed,
    /// 放行 —— 但这个空间**没分类**（上层该如实告诉用户"闸门没管到它"，不静默）。
    AllowedUnclassified,
    /// 拦住（带一句**可操作**的话）。
    Blocked(String),
}

/// ★★ **同步闸门（第 2 步）**：只有"**明确是个人空间**且**没有按空间加密**"才拦。
///
/// 三条口径（与 [数据可见边界](../docs/sync-server-data-boundary.md) §0.5 一一对应）：
/// · **团队空间免检** —— 服务端明文正是它换来的东西，拦它等于把那份取舍白扔；
/// · **个人空间**：库文件是密的 **或** 袋里有它的盒子 ⇒ 放行；否则拦（否则就是明文上云，
///   而且**不可回溯**：服务端历史/备份/WAL 都会留底）；
/// · **未分类**：放行（老库、还没标记的空间），但把"没管到"这个事实**报出去**。
pub fn sync_gate(st: &SpaceCryptoStatus, kind: SpaceKind) -> SyncGate {
    match kind {
        SpaceKind::Team => SyncGate::Allowed,
        SpaceKind::Unknown => SyncGate::AllowedUnclassified,
        SpaceKind::Personal => {
            if st.encrypted_on_disk || st.in_keyring {
                SyncGate::Allowed
            } else {
                SyncGate::Blocked(format!(
                    "空间「{}」是个人空间但还没有加密：先给它设一句口令（按空间加密），再绑定同步 —— \
                     否则它的内容会**明文**发到服务端，而且事后加密也撤不回已经落库的那份。\
                     （如果你要的是团队空间，请在空间设置里把它标成团队空间。）",
                    st.space_id
                ))
            }
        }
    }
}

/// 闸门裁决的**可序列化视图**（给状态命令/界面读；`SyncGate` 本身不带 `Serialize`，
/// 因为它是给内部调用方 match 的）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SyncGateView {
    pub allow: bool,
    /// 放行的同时"这个空间还没分类"（＝闸门**没管到它**，界面该如实说）。
    pub unclassified: bool,
    /// 拦住的原因 / 放行时的空串。
    pub reason: String,
}

/// 把裁决投影成视图。**三种出口一个都不许丢**（拦 / 放行 / 放行但未分类）。
pub fn sync_gate_view(st: &SpaceCryptoStatus, kind: SpaceKind) -> SyncGateView {
    match sync_gate(st, kind) {
        SyncGate::Allowed => SyncGateView {
            allow: true,
            unclassified: false,
            reason: String::new(),
        },
        SyncGate::AllowedUnclassified => SyncGateView {
            allow: true,
            unclassified: true,
            reason: "这个空间还没分类（个人/团队）：同步闸门这次没有管到它".to_string(),
        },
        SyncGate::Blocked(reason) => SyncGateView {
            allow: false,
            unclassified: false,
            reason,
        },
    }
}

/// ★★ **C（owner 拍板 1）：存量迁移的第一半 —— 把"旧的应用级钥匙"装进袋子。**
///
/// **为什么不重加密**：今天已加密空间的库是用**旧的应用级钥匙**（`security::session_key()` 那 32 字节）写的。
/// 最省的迁法是"**把旧钥匙原样包成这个空间的盒子**"⇒ 空间钥匙 == 旧钥匙 ⇒ **库文件一个字节都不用动**，
/// 风险面最小（不重写数据，所以也不需要"先备份再重写"）。
/// 以后要换成真随机的空间钥匙，走 `rotate` ＋ 一次重加密（那是第二步）。
///
/// 四个出口**都要响亮**（对应 owner 的 C=1「报错＋说清怎么办」）：
/// · 库文件**不是密的** ⇒ `Err`（没什么可迁的 —— 明文空间不该有盒子）；
/// · 会话**没解锁** ⇒ `Err`（先输口令再迁移）；袋子也还没有 ⇒ `Err`（先用口令建袋子）；
/// · 袋子**已经有它** ⇒ `Ok(false)`（**幂等**，不重复做）；
/// · 成功 ⇒ `Ok(true)`。
pub fn migrate_legacy_space_into_keyring(
    conn: &Connection,
    app_data_dir: &Path,
    space_id: &str,
) -> Result<bool, String> {
    let path = crate::db::space_db_path(app_data_dir, space_id);
    if !crate::security::space_db_is_encrypted(&path) {
        return Err(format!(
            "空间「{space_id}」的库文件不是密文 ⇒ 没有可迁移的旧钥匙（明文空间本来就不该有盒子）"
        ));
    }
    let master = session_master().ok_or("会话未解锁：先输口令，再迁移")?;
    let mut kr = keyring().ok_or("钥匙袋还不存在：先用口令建它（点一次「开启加密」即可）")?;
    if kr.has(space_id) {
        return Ok(false); // 幂等
    }
    // ★ 旧钥匙就是"空间钥匙"：库文件因此**一个字节都不用动**
    let legacy = crate::security::session_key()
        .ok_or("会话里没有旧钥匙（未解锁？）—— 先输口令再迁移")?;
    kr.wrap(&master, space_id, &legacy)?;
    store_keyring(conn, &kr)?;
    crate::security::set_space_encrypted_marked(conn, space_id, true)?;
    Ok(true)
}

/// ★★ **C 第二半：把"旧钥匙"换成真随机的空间钥匙**（owner 拍板 C=1：先备份、失败报错、不做双读）。
///
/// 与第一半的区别：第一半只是"把旧钥匙装进袋子"（不动数据）；这一步要**真的重加密那个库**，
/// 所以：① **先留一份备份**（`<space>.db.pre-rotate.bak`，覆盖式）；② 两次转换
/// （旧钥匙解 ⇒ 新随机钥匙写）任何一步失败 ⇒ **停住报错**并把备份路径说给用户；
/// ③ 成功后**才**换盒子（顺序：先备份 → 转换 → 换盒子，失败时旧盒子仍指向旧钥匙、库也回到旧钥匙那一版）。
///
/// ⚠️ 转换前必须让开这个空间的连接（Windows 文件占用 ⇒ `os error 5`）。**函数自己负责这件事**：
/// 正开着就换成内存库 → 转换 → **无论成败**按当前真实状态重新打开（失败时它还是旧钥匙那一版）。
/// ⚠️ 顺序上有个坑（这里是第二遍才做对的，见交接文档 §7.0.2）：**重新打开那一步是按盒子取钥匙的**
/// ⇒ 成功时必须**先**把新盒子放进内存（**只放内存**：此刻 `conn` 是内存库，写 meta 会 `no such table`），
/// 再重新打开；失败时**什么都别换**（盒子里还是旧钥匙 ⇒ 与"库还在旧钥匙那一版"对得上）。
/// ⇒ 与 `enable_space` 的差别正在这里：那条是**复用**盒子（先落袋子再转换没问题），
/// 这条是**换一把新钥匙**，先换盒子而转换失败的话，那个空间就**打不开**了（旧库配新盒子）。
/// 幂等性说明：**轮换本身不是幂等的**（每调一次就是换一把新钥匙）；幂等的是"失败后状态不变"——
/// 失败时库与盒子都还在旧钥匙那一版（判据钉的就是这个）。
pub fn rotate_legacy_space_to_random_key(
    conn: &mut Connection,
    app_data_dir: &Path,
    space_id: &str,
) -> Result<[u8; 32], String> {
    let path = crate::db::space_db_path(app_data_dir, space_id);
    if !crate::security::space_db_is_encrypted(&path) {
        return Err(format!("空间「{space_id}」的库不是密文 ⇒ 没什么可轮换的"));
    }
    let master = session_master().ok_or("会话未解锁：先输口令再轮换")?;
    let mut kr = keyring().ok_or("钥匙袋不存在：先把旧钥匙迁进来（第一半）")?;
    let old = kr
        .unwrap_key(&master, space_id)
        .map_err(|e| format!("取不出旧的空间钥匙（不能在没有旧钥匙的情况下重加密）：{e}"))?;

    // ① 先备份（**失败也要留下它**；覆盖式，避免备份文件无限堆积）
    let backup = path.with_extension("db.pre-rotate.bak");
    std::fs::copy(&path, &backup)
        .map_err(|e| format!("轮换前备份失败（未做任何改动）：{e}"))?;

    // ② 让开这个空间（如果正开着它）—— Windows 上文件被占用时"替换库文件"会 `os error 5`
    let holds = holds_space(conn, space_id);
    if holds {
        let _ = std::mem::replace(conn, Connection::open_in_memory().map_err(|e| e.to_string())?);
    }

    // ③ 两次转换：旧钥匙 ⇒ 明文（中间态只短暂存在）⇒ 新随机钥匙
    let converted: Result<[u8; 32], String> = (|| {
        let new_key = random_space_key();
        if let Err(e) = crate::security::convert_space_db(&path, false, Some(&old)) {
            return Err(format!(
                "轮换失败在「解密到明文」这一步：{e}（备份在 {}，库未被破坏）",
                backup.display()
            ));
        }
        if let Err(e) = crate::security::convert_space_db(&path, true, Some(&new_key)) {
            // 尽量把它开回旧钥匙那一版（明文中间态不能留着）
            let _ = crate::security::convert_space_db(&path, true, Some(&old));
            return Err(format!(
                "轮换失败在「用新钥匙加密」这一步：{e}（已尽力回退到旧钥匙；备份在 {}）",
                backup.display()
            ));
        }
        Ok(new_key)
    })();

    // ④ 按成败分别处理：都要把连接**开回来**，但"成功"那一支必须先让盒子跟上
    let new_key = match converted {
        Ok(new_key) => {
            kr.wrap(&master, space_id, &new_key)?;
            if holds {
                // 重新打开那一步查的就是这份内存袋子 ⇒ 先换内存，meta 留到开回来之后再写
                set_keyring_memory(kr.clone())?;
                crate::db::reopen_space_at(conn, space_id, app_data_dir)?;
            }
            new_key
        }
        Err(e) => {
            if holds {
                // 库里还是旧钥匙那一版，盒子里也还是旧钥匙 ⇒ 直接开回来
                if let Err(re) = crate::db::reopen_space_at(conn, space_id, app_data_dir) {
                    return Err(format!("{e}（而且重新打开也失败了：{re}）"));
                }
                return Err(format!("{e}（已重新打开这个空间）"));
            }
            return Err(e);
        }
    };

    // ⑤ 落 meta（held 那一支内存已经换过 ⇒ 这里幂等）＋ 打标记
    store_keyring(conn, &kr)?;
    crate::security::set_space_encrypted_marked(conn, space_id, true)?;
    Ok(new_key)
}

/// 读这个空间的**本地分类标记**（读不到/没那条 ⇒ `Unknown`）。
pub fn space_kind(c: &Connection, space_id: &str) -> SpaceKind {
    c.query_row(
        "SELECT COALESCE(kind, '') FROM meta.workspaces WHERE id = ?1",
        [space_id],
        |r| r.get::<_, String>(0),
    )
    .map(|s| SpaceKind::parse(&s))
    .unwrap_or(SpaceKind::Unknown)
}

/// 写这个空间的本地分类标记（`Unknown` ⇒ 写回空串＝取消分类）。
pub fn set_space_kind(c: &Connection, space_id: &str, kind: SpaceKind) -> Result<(), String> {
    let n = c
        .execute(
            "UPDATE meta.workspaces SET kind = ?1 WHERE id = ?2",
            rusqlite::params![kind.as_str(), space_id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("空间「{space_id}」不存在"));
    }
    Ok(())
}

/// **这个空间现在的加密状态**（给第 2 步的同步闸门与界面读的三条读数）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SpaceCryptoStatus {
    pub space_id: String,
    /// 库文件本身是不是密的（**嗅文件头**，不需要钥匙 —— 启动闸门就靠它）。
    pub encrypted_on_disk: bool,
    /// 钥匙袋里有没有它的盒子。
    pub in_keyring: bool,
    /// 现在**拿得到**钥匙吗（袋里有它 ＋ 会话已解锁）。
    pub key_available: bool,
}

/// 读一个空间的三条读数（纯读：不写库、不解密、不需要 conn）。
pub fn space_status(app_data_dir: &Path, space_id: &str) -> SpaceCryptoStatus {
    let path = crate::db::space_db_path(app_data_dir, space_id);
    let in_keyring = keyring().map(|k| k.has(space_id)).unwrap_or(false);
    SpaceCryptoStatus {
        space_id: space_id.to_string(),
        encrypted_on_disk: crate::security::space_db_is_encrypted(&path),
        in_keyring,
        key_available: in_keyring && session_master().is_some(),
    }
}

/// ★ **一个空间的完整隐私读数**（②b 的界面就靠这一个列表）：分类 ＋ 加密状态 ＋ 闸门裁决。
///
/// 为什么合成一条：界面要同时说清"这是个人还是团队空间、加没加密、现在能不能绑同步"，
/// 而这三条答案今天分散在 `meta.workspaces.kind`、库文件头、钥匙袋里。让界面自己拼 ⇒
/// 界面就得知道"钥匙袋"这个东西存在 ⇒ **口径漏到界面层**。这里一次读全，界面只做显示。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SpaceSecurityView {
    pub space_id: String,
    /// `"personal"` / `"team"` / `""`（未分类 —— 界面要**如实**显示"没分类"，不许默认成个人）。
    pub kind: String,
    pub encrypted_on_disk: bool,
    pub in_keyring: bool,
    pub key_available: bool,
    /// 闸门裁决（含"放行但这个空间没分类"那一种）。
    pub gate: SyncGateView,
}

/// 列出**当前所有空间**的隐私读数。
///
/// ⚠️ 未分类的空间**照样列出来**（不许为了列表好看把它们藏掉）：它们正是"闸门没管到"的那批，
/// 藏起来就等于把"这道闸门今天还没真正生效"这件事从界面上抹掉。
/// 范围与 `workspaces::list_workspaces` 同口径（未删除；排序也一致）。
/// 读不到空间列表 ⇒ `Err`（不静默给空列表：空列表看起来像"这台机器上没有空间"）。
pub fn space_security_views(
    conn: &Connection,
    app_data_dir: &Path,
) -> Result<Vec<SpaceSecurityView>, String> {
    let ids: Vec<String> = conn
        .prepare(
            "SELECT id FROM meta.workspaces WHERE deleted_at IS NULL \
             ORDER BY sort_order ASC, created_at ASC, id ASC",
        )
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(ids
        .into_iter()
        .map(|id| {
            let st = space_status(app_data_dir, &id);
            let kind = space_kind(conn, &id);
            SpaceSecurityView {
                space_id: id,
                kind: kind.as_str().to_string(),
                encrypted_on_disk: st.encrypted_on_disk,
                in_keyring: st.in_keyring,
                key_available: st.key_available,
                gate: sync_gate_view(&st, kind),
            }
        })
        .collect())
}

/// 这个连接**是不是正开着**这个空间的库（决定转换前要不要先让开 —— Windows 文件占用）。
fn holds_space(conn: &Connection, space_id: &str) -> bool {
    conn.path()
        .and_then(|p| space_id_from_path(Path::new(p)))
        .as_deref()
        == Some(space_id)
}

/// ★ **按空间启用**：只把这个空间**自己**的库换成密文（钥匙是**新随机**一把，装进钥匙袋）。
///
/// 与旧的 `set_encryption_impl`（应用级：把所有空间一起换成同一把钥匙）**不是一条路** ——
/// 那一条给团队空间会连坐（服务端从此读不懂，合并/检索/AI 全废）。
///
/// `passphrase` 只在"**钥匙袋还不存在**"时用到（用它建袋子）；袋子已在 ⇒ 传 `None` 即可。
/// 返回这把空间钥匙（判据与调用方用）。
pub fn enable_space(
    conn: &mut Connection,
    app_data_dir: &Path,
    space_id: &str,
    passphrase: Option<&str>,
) -> Result<[u8; 32], String> {
    // ① 主密钥：袋子已有 ⇒ 会话里那把；没有 ⇒ 用口令建一个袋子（并把它装上）
    let master = match session_master() {
        Some(m) => m,
        None => {
            let pw = passphrase.ok_or("钥匙袋还不存在：需要一句口令来建它")?;
            if pw.trim().len() < 8 {
                return Err("口令至少 8 位".to_string());
            }
            let kr = Keyring::new();
            let m = kr.kdf.derive_master(pw)?;
            sync::set_meta_state(conn, META_KEYRING, &kr.to_json()?)?;
            *KEYRING.lock().map_err(|_| "钥匙袋锁失效".to_string())? = Some(kr);
            set_session_master(Some(m))?;
            m
        }
    };
    // ② 盒子：已有 ⇒ **复用**（不换钥匙）；没有 ⇒ 新随机一把
    let mut kr = keyring().ok_or("钥匙袋缺失")?;
    let key = if kr.has(space_id) {
        kr.unwrap_key(&master, space_id)?
    } else {
        let k = random_space_key();
        kr.wrap(&master, space_id, &k)?;
        k
    };
    // ★ **先把袋子落下去（内存 ＋ meta）再转换**：这样紧接着的"重新打开这个空间"
    //   才会按空间拿到钥匙（`key_space_conn` 查的就是这份）。
    store_keyring(conn, &kr)?;

    // ③ ★ 只换**这一个**空间的库。⚠️ 若这个空间**正被本连接开着**，必须先让开：
    //   Windows 上文件被占用时"替换库文件"会 `os error 5`（`set_encryption_impl` 里同样的换法）。
    let path = crate::db::space_db_path(app_data_dir, space_id);
    let holds = holds_space(conn, space_id);
    if holds {
        let _ = std::mem::replace(conn, Connection::open_in_memory().map_err(|e| e.to_string())?);
    }
    let converted = crate::security::convert_space_db(&path, true, Some(&key));
    if holds {
        // 无论成败都把空间**按当前真实状态**重新打开（失败时它还是明文库）
        let reopened = crate::db::reopen_space_at(conn, space_id, app_data_dir);
        if let Err(e) = converted {
            return Err(format!("{e}（已重新打开这个空间；转换未生效）"));
        }
        reopened?;
    }
    converted?;

    // ④ 记下"这个空间的数据是哪一版密文"（§0-C 的 per-space 标记）
    crate::security::set_space_encrypted_marked(conn, space_id, true)?;
    Ok(key)
}

/// ★ **按空间禁用**：解开这个空间自己的钥匙 ⇒ 把库换回明文 ⇒ 扔掉盒子 ⇒ 清标记。
/// ⚠️ 只动这一个空间；别的空间（含团队空间）不受影响。
pub fn disable_space(
    conn: &mut Connection,
    app_data_dir: &Path,
    space_id: &str,
) -> Result<(), String> {
    let Some(mut kr) = keyring() else {
        return Err("钥匙袋不存在（这个空间不是按空间加密的）".to_string());
    };
    if !kr.has(space_id) {
        return Err(format!("钥匙袋里没有空间「{space_id}」的盒子"));
    }
    let master = session_master().ok_or("会话未解锁：先输口令再关".to_string())?;
    let key = kr.unwrap_key(&master, space_id)?;

    let path = crate::db::space_db_path(app_data_dir, space_id);
    let holds = holds_space(conn, space_id);
    if holds {
        let _ = std::mem::replace(conn, Connection::open_in_memory().map_err(|e| e.to_string())?);
    }
    let converted = crate::security::convert_space_db(&path, false, Some(&key));
    if holds {
        // 换回明文之后重新打开**不需要钥匙**（文件不再是密的）
        let reopened = crate::db::reopen_space_at(conn, space_id, app_data_dir);
        if let Err(e) = converted {
            return Err(format!("{e}（已重新打开这个空间；转换未生效）"));
        }
        reopened?;
    }
    converted?;

    kr.remove(space_id);
    store_keyring(conn, &kr)?;
    crate::security::set_space_encrypted_marked(conn, space_id, false)?;
    Ok(())
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

    /// ★ 第 1 步（1b-2a）：**按空间启用/禁用** —— 只动那一个空间；旁边那个（明文）**不受影响**，
    /// 而且**连接正开着的那个空间**也要能启用（Windows 上文件被占用 ⇒ 必须先让开连接）。
    #[test]
    fn enabling_one_space_leaves_its_neighbour_alone_and_disable_rolls_it_back() {
        let _g = crate::security::SEC_LOCK.lock().unwrap(); // 与 security 的会话态测试串行
        let dir = std::env::temp_dir().join(format!("shuyonote-spacecrypto-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        // 连接开的是 **sc-c**（既不是被测的 sc-a，也不是邻座 sc-b）—— 前两段判据不必让开连接
        let mut c = crate::db::open_space_conn_at("sc-c", &dir).unwrap();
        set_keyring_for_test(None);
        set_session_master(None).unwrap();

        // 邻座：另一个空间（明文），用来证明"只动一个"
        let neighbour = crate::db::space_db_path(&dir, "sc-b");
        {
            let n = Connection::open(&neighbour).unwrap();
            n.execute_batch("CREATE TABLE t(x)").unwrap();
        }

        // sc-a 先得**有一份明文库**（转换不是"创建"；真 schema ＋ 一行数据，
        // 后面还要用它证明"内容在加密往返里没丢"）＋ meta 里那一行（per-space 标记写的就是它）
        {
            let a = crate::db::open_space_conn_at("sc-a", &dir).unwrap();
            a.execute(
                "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at) \
                 VALUES ('p1', 'sc-a', NULL, '机密', '{\"root\":{}}', '机密', 'page', 0, 1, 1, NULL)",
                [],
            )
            .unwrap();
            a.execute(
                "INSERT INTO meta.workspaces (id, name, created_at, updated_at) VALUES ('sc-a', '甲', 1, 1), ('sc-b', '乙', 1, 1)",
                [],
            )
            .unwrap();
            a.close().unwrap();
        }

        // ① 启用 sc-a：袋子没有 ⇒ 用口令建；只有 sc-a 变密文
        let key = enable_space(&mut c, &dir, "sc-a", Some("我家猫叫mimi")).unwrap();
        assert!(keyring().unwrap().has("sc-a"));
        let st = space_status(&dir, "sc-a");
        assert!(st.encrypted_on_disk, "sc-a 的库应当变成密文");
        assert!(st.in_keyring && st.key_available, "袋里有它且会话解锁 ⇒ 拿得到钥匙");
        let nb = space_status(&dir, "sc-b");
        assert!(!nb.encrypted_on_disk, "★ 邻座必须**原样**（这正是「按空间」）");
        assert!(!nb.in_keyring);
        // 标记也要按空间：sc-a = 1，sc-b ≠ 1
        // ⚠️ 写成**函数**而不是闭包：闭包会一直持有 `&c`，后面 `&mut c`（让开连接那条路）就借不动了。
        fn marked(c: &Connection, sid: &str) -> i64 {
            c.query_row("SELECT COALESCE(encrypted, 0) FROM meta.workspaces WHERE id = ?1", [sid], |r| r.get(0))
                .unwrap_or(0)
        }
        assert_eq!(marked(&c, "sc-a"), 1);
        assert_ne!(marked(&c, "sc-b"), 1);

        // ② 同一个空间再来一次 ⇒ **复用**同一把钥匙（不换钥）
        let again = enable_space(&mut c, &dir, "sc-a", None).unwrap();
        assert_eq!(again, key, "已经有盒子 ⇒ 复用，不换钥匙");

        // ②b ★ **连接正开着的那个空间**也要能启用（Windows 上文件被占用会 `os error 5`
        //     ⇒ 实现必须先把连接让开、转换后再按钥匙重开）
        let mut own = crate::db::open_space_conn_at("sc-a", &dir).unwrap();
        let own_key = enable_space(&mut own, &dir, "sc-a", None).unwrap();
        assert_eq!(own_key, key, "同一条路复用同一把");
        assert!(
            crate::security::space_db_is_encrypted(&crate::db::space_db_path(&dir, "sc-a")),
            "连接让开之后真的换成了密文"
        );
        // 让开后重开的连接**是可用的**（真按空间钥匙打开了，不是留个坏连接）
        let n: i64 = own.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "★ 那一行数据在「明文 ⇒ 密文 ⇒ 用空间钥匙打开」的往返里没丢");
        let title: String = own.query_row("SELECT title FROM pages WHERE id='p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(title, "机密");
        drop(own);

        // ③ 锁着 ⇒ 状态说"拿不到钥匙"，且禁用**报错**（不静默）
        set_session_master(None).unwrap();
        assert!(!space_status(&dir, "sc-a").key_available);
        let err = disable_space(&mut c, &dir, "sc-a").unwrap_err();
        assert!(err.contains("未解锁"), "{err}");

        // ④ 解锁后禁用 ⇒ 只回退这一个：sc-a 回明文、盒子扔掉、邻座仍明文
        let master = keyring().unwrap().kdf.derive_master("我家猫叫mimi").unwrap();
        set_session_master(Some(master)).unwrap();
        disable_space(&mut c, &dir, "sc-a").unwrap();
        let st = space_status(&dir, "sc-a");
        assert!(!st.encrypted_on_disk, "禁用后回明文");
        assert!(!st.in_keyring, "盒子要扔掉");
        assert!(!space_status(&dir, "sc-b").encrypted_on_disk);
        assert_eq!(marked(&c, "sc-a"), 0);
        // 明文库读得开（真回退了，不是只剩个头）
        {
            let n = Connection::open(crate::db::space_db_path(&dir, "sc-a")).unwrap();
            n.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0)).unwrap();
        }

        // 收尾
        set_keyring_for_test(None);
        set_session_master(None).unwrap();
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ 第 2 步（同步闸门）：**只有"明确是个人空间且没加密"才拦**；团队空间免检；
    /// 未分类放行但**要报出来**（不静默）。
    #[test]
    fn the_sync_gate_only_blocks_personal_spaces_that_are_not_encrypted() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let plain = SpaceCryptoStatus {
            space_id: "s".into(),
            encrypted_on_disk: false,
            in_keyring: false,
            key_available: false,
        };
        let enc = SpaceCryptoStatus {
            encrypted_on_disk: true,
            ..plain.clone()
        };
        let boxed = SpaceCryptoStatus {
            in_keyring: true,
            key_available: true,
            ..plain.clone()
        };

        // ① 个人空间没加密 ⇒ **拦**，且那句话要可操作（说清后果与两条出路）
        let blocked = match sync_gate(&plain, SpaceKind::Personal) {
            SyncGate::Blocked(m) => m,
            other => panic!("个人空间没加密必须拦，实际 {other:?}"),
        };
        assert!(blocked.contains("明文"), "{blocked}");
        assert!(blocked.contains("团队空间"), "要给出另一条出路：{blocked}");
        // ② 个人空间已加密（文件是密的 **或** 袋里有它）⇒ 放行
        assert_eq!(sync_gate(&enc, SpaceKind::Personal), SyncGate::Allowed);
        assert_eq!(sync_gate(&boxed, SpaceKind::Personal), SyncGate::Allowed);
        // ③ 团队空间**免检**（明文也不拦 —— 那正是它换来的东西）
        assert_eq!(sync_gate(&plain, SpaceKind::Team), SyncGate::Allowed);
        // ④ 未分类 ⇒ 放行，但把"没管到"这个事实报出来
        assert_eq!(sync_gate(&plain, SpaceKind::Unknown), SyncGate::AllowedUnclassified);
    }

    /// 分类标记的读写：认不出来 ⇒ `Unknown`（**不猜**）；写不存在的空间 ⇒ 报错。
    #[test]
    fn space_kind_round_trips_and_unknown_values_are_not_guessed() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuyonote-spacekind-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        let c = crate::db::open_space_conn_at("sk-a", &dir).unwrap();
        c.execute(
            "INSERT INTO meta.workspaces (id, name, created_at, updated_at) VALUES ('sk-a', '甲', 1, 1)",
            [],
        )
        .unwrap();

        assert_eq!(space_kind(&c, "sk-a"), SpaceKind::Unknown, "默认就是未分类");
        set_space_kind(&c, "sk-a", SpaceKind::Personal).unwrap();
        assert_eq!(space_kind(&c, "sk-a"), SpaceKind::Personal);
        c.execute("UPDATE meta.workspaces SET kind = 'PERSONAL' WHERE id = 'sk-a'", []).unwrap();
        assert_eq!(space_kind(&c, "sk-a"), SpaceKind::Personal, "大小写不敏感");
        c.execute("UPDATE meta.workspaces SET kind = '别的' WHERE id = 'sk-a'", []).unwrap();
        assert_eq!(space_kind(&c, "sk-a"), SpaceKind::Unknown, "★ 认不出来 ⇒ 未分类，**不猜**");
        assert_eq!(space_kind(&c, "不存在"), SpaceKind::Unknown, "没那条 ⇒ 未分类");
        assert!(set_space_kind(&c, "不存在", SpaceKind::Team).is_err(), "写不存在的空间要报错");
        // 取消分类 ⇒ 写回空串
        set_space_kind(&c, "sk-a", SpaceKind::Unknown).unwrap();
        assert_eq!(space_kind(&c, "sk-a"), SpaceKind::Unknown);

        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 闸门视图：三种出口都投影出来（拦 / 放行 / 放行但未分类），**一个都不许丢**。
    #[test]
    fn the_gate_view_keeps_all_three_outcomes() {
        let plain = SpaceCryptoStatus {
            space_id: "s".into(),
            encrypted_on_disk: false,
            in_keyring: false,
            key_available: false,
        };
        let enc = SpaceCryptoStatus {
            encrypted_on_disk: true,
            ..plain.clone()
        };

        let v = sync_gate_view(&plain, SpaceKind::Personal);
        assert!(!v.allow && !v.unclassified && !v.reason.is_empty(), "拦：要有原因");
        let v = sync_gate_view(&enc, SpaceKind::Personal);
        assert!(v.allow && !v.unclassified && v.reason.is_empty(), "放行：没有原因");
        let v = sync_gate_view(&plain, SpaceKind::Team);
        assert!(v.allow && !v.unclassified, "团队：放行且**不算未分类**");
        let v = sync_gate_view(&plain, SpaceKind::Unknown);
        assert!(v.allow && v.unclassified && !v.reason.is_empty(), "未分类：放行但**要说出来**");
    }

    /// ★★ ③ 0b：**采纳从服务端取回的公开材料** —— 本地已经有袋子时**默认拒绝**
    /// （不许闷头覆盖：别的设备轮换过之后，覆盖本机那一份可能让本机**打不开自己的空间**）；
    /// 显式 `overwrite=true` 才采纳，采纳之后**只凭那个口令**就能解出盒子里的钥匙。
    #[test]
    fn adopting_remote_material_refuses_to_overwrite_a_local_bag_unless_told_to() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuyonote-adopt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        let c = crate::db::open_space_conn_at("adopt-a", &dir).unwrap();
        set_keyring_for_test(None);
        set_session_master(None).unwrap();

        // 本机这一份（本地口令）
        let mut local = Keyring::new();
        let m_local = local.kdf.derive_master("本机口令八个字").unwrap();
        local.wrap(&m_local, "adopt-a", &random_space_key()).unwrap();
        store_keyring(&c, &local).unwrap();
        let before = stored_material(&c).unwrap().unwrap();

        // 服务端那一份：**另一个**袋子（新盐 ⇒ 另一份 JSON），里面是我们想要的那把钥匙
        let k_remote = random_space_key();
        let mut remote = Keyring::new();
        let m_remote = remote.kdf.derive_master("对端口令八个字").unwrap();
        remote.wrap(&m_remote, "adopt-a", &k_remote).unwrap();
        let remote_json = remote.to_json().unwrap();

        // ① 默认**拒绝**覆盖，且一个字节都没改
        let r = adopt_material(&c, &remote_json, false).unwrap();
        assert!(!r.adopted && r.already_local, "本地已有袋子 ⇒ 默认不许覆盖");
        assert_eq!(stored_material(&c).unwrap().unwrap(), before, "★ 一个字节都没改");

        // ② 显式 overwrite ⇒ 采纳
        let r = adopt_material(&c, &remote_json, true).unwrap();
        assert!(r.adopted && !r.already_local && r.spaces == 1);

        // ③ ★ 采纳之后：**只凭那个口令**就能解出盒子里的钥匙
        let m = master_from_passphrase(&c, "对端口令八个字").unwrap().unwrap();
        assert_eq!(
            keyring().unwrap().unwrap_key(&m, "adopt-a").unwrap(),
            k_remote,
            "★ 第二台设备只凭口令就把空间钥匙拿回来了"
        );

        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★ 坏材料**两头都不许过**：不许被推给服务端（读出来先验）、不许被写进本机。
    #[test]
    fn garbage_material_is_refused_on_both_ends() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuyonote-garbage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        let c = crate::db::open_space_conn_at("gb-a", &dir).unwrap();
        set_keyring_for_test(None);
        set_session_master(None).unwrap();

        sync::set_meta_state(&c, META_KEYRING, "这不是材料").unwrap();
        assert!(stored_material(&c).is_err(), "★ 读出来先验：坏材料不许推给服务端");
        assert!(adopt_material(&c, "也不是材料", true).is_err(), "★ 坏材料不许写进本机");

        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ ②b 的读数面：一个列表里同时给出**分类 ＋ 加密状态 ＋ 闸门裁决**，而且
    /// **未分类的空间不许被藏掉**（它们正是"闸门没管到"的那批），已删除的空间不许出现。
    #[test]
    fn the_security_overview_lists_every_space_including_the_unclassified_ones() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuyonote-overview-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        let c = crate::db::open_space_conn_at("ov-a", &dir).unwrap();
        set_keyring_for_test(None);
        set_session_master(None).unwrap();

        // ① 个人 ＋ 没加密（走新建那条路）⇒ 该**拦**
        crate::workspaces::insert_new_local_space(&c, "ov-p", "个人甲", "blue", 5.0, 1).unwrap();
        // ② 团队 ⇒ **免检**
        c.execute(
            "INSERT INTO meta.workspaces (id, name, created_at, updated_at, kind, sort_order) \
             VALUES ('ov-t', '团队乙', 2, 2, 'team', 6.0)",
            [],
        )
        .unwrap();
        // ③ 未分类（存量库的形状：kind 是空串）
        c.execute(
            "INSERT INTO meta.workspaces (id, name, created_at, updated_at, sort_order) \
             VALUES ('ov-u', '老库丙', 3, 3, 7.0)",
            [],
        )
        .unwrap();
        // ④ 已删除的**不许**出现在读数里（与 `list_workspaces` 同口径）
        c.execute(
            "INSERT INTO meta.workspaces (id, name, created_at, updated_at, sort_order, deleted_at) \
             VALUES ('ov-d', '删掉的', 4, 4, 8.0, 9)",
            [],
        )
        .unwrap();

        let views = space_security_views(&c, &dir).unwrap();
        let ids: Vec<&str> = views.iter().map(|v| v.space_id.as_str()).collect();
        assert_eq!(ids, vec!["ov-p", "ov-t", "ov-u"], "三个都在、删掉的不在（按 sort_order）");

        let p = &views[0];
        assert_eq!(p.kind, "personal");
        assert_eq!(p.kind.as_str(), SpaceKind::Personal.as_str(), "视图里的串与内部口径是同一个");
        assert!(!p.gate.allow && !p.gate.reason.is_empty(), "个人＋没加密 ⇒ 拦且有理由");
        let t = &views[1];
        assert_eq!(t.kind, "team");
        assert!(t.gate.allow && !t.gate.unclassified, "团队 ⇒ 免检放行");
        let u = &views[2];
        assert_eq!(u.kind, "", "★ 未分类**照样列出来**，而不是被默认成个人");
        assert!(u.gate.allow && u.gate.unclassified, "★ 放行，但要把「没管到」说出来");
        assert!(u.gate.reason.contains("没分类"), "{}", u.gate.reason);

        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ A=3（2026-09-24，owner 拍板）：**分类由入口决定** —— 本地新建的空间是**个人空间**，
    /// 于是"新建 ⇒ 没加密 ⇒ 绑同步被闸门拦住并引导设口令"这条链自动成立。
    #[test]
    fn a_locally_created_space_is_personal_so_the_gate_guides_the_user_to_encrypt() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuyonote-entrykind-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        let c = crate::db::open_space_conn_at("entry-a", &dir).unwrap();
        set_keyring_for_test(None);
        set_session_master(None).unwrap();

        // 走"新建空间"那条路（入口 = 本仓 = 个人版）
        crate::workspaces::insert_new_local_space(&c, "entry-new", "新空间", "blue", 1.0, 1).unwrap();

        // ① 分类落成 **personal**
        assert_eq!(space_kind(&c, "entry-new"), SpaceKind::Personal, "本地新建 ⇒ 个人空间");
        // ② 它还没加密 ⇒ **闸门拦**（且理由是"没加密"，不是"没分类"）
        let st = space_status(&dir, "entry-new");
        assert!(!st.encrypted_on_disk && !st.in_keyring);
        match sync_gate(&st, space_kind(&c, "entry-new")) {
            SyncGate::Blocked(msg) => assert!(msg.contains("没有加密"), "{msg}"),
            other => panic!("新建的未加密空间必须被拦，实际 {other:?}"),
        }
        // ③ 按空间加密之后 ⇒ 放行
        let mut c2 = c;
        let _ = crate::space_crypto::enable_space(&mut c2, &dir, "entry-new", Some("我家猫叫mimi"));
        // （`enable_space` 对"库文件还不存在"是 no-op，但盒子已进袋子 ⇒ 闸门按"袋里有它"放行）
        assert!(keyring().unwrap().has("entry-new"));
        assert_eq!(
            sync_gate(&space_status(&dir, "entry-new"), SpaceKind::Personal),
            SyncGate::Allowed
        );
        // ④ 认不出/没标记的（存量库）⇒ 仍然是"未分类放行"（不掐断老用户）
        assert_eq!(space_kind(&c2, "entry-a"), SpaceKind::Unknown);

        set_keyring_for_test(None);
        set_session_master(None).unwrap();
        drop(c2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ C（owner 拍板 1）：**存量迁移 = 把旧钥匙装进袋子**（库文件不动）＋ 四条响亮出口。
    #[test]
    fn migrating_a_legacy_space_wraps_the_old_key_without_touching_the_file() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuyonote-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        let c = crate::db::open_space_conn_at("mig-a", &dir).unwrap();
        set_keyring_for_test(None);
        set_session_master(None).unwrap();
        crate::security::tests_set_session_key(None);

        // ① 明文空间 ⇒ Err（说清"没什么可迁的"）
        let err = migrate_legacy_space_into_keyring(&c, &dir, "mig-a").unwrap_err();
        assert!(err.contains("不是密文"), "{err}");

        // 做一份**用旧应用级钥匙加密**的库（＝今天所有已加密空间的样子）
        let legacy = crate::keyring::random_space_key();
        let path = crate::db::space_db_path(&dir, "mig-a");
        drop(c); // Windows：转换前必须让开这个空间的连接
        crate::security::convert_space_db(&path, true, Some(&legacy)).unwrap();
        assert!(crate::security::space_db_is_encrypted(&path));
        let c = crate::db::open_space_conn_at("mig-b", &dir).unwrap(); // 换一个别的空间当连接

        // ② 没解锁 / 没袋子 ⇒ Err（两条各说各的）
        let err = migrate_legacy_space_into_keyring(&c, &dir, "mig-a").unwrap_err();
        assert!(err.contains("未解锁") || err.contains("钥匙袋"), "{err}");

        // 装上袋子（口令）＋ 会话旧钥匙 ⇒ ③ 迁移成功
        let mut kr = Keyring::new();
        let master = kr.kdf.derive_master("我家猫叫mimi").unwrap();
        sync::set_meta_state(&c, META_KEYRING, &kr.to_json().unwrap()).unwrap();
        set_keyring_for_test(Some(kr));
        set_session_master(Some(master)).unwrap();
        crate::security::tests_set_session_key(Some(legacy));
        assert!(migrate_legacy_space_into_keyring(&c, &dir, "mig-a").unwrap(), "第一次要真的迁");

        // ★ 盒子里装的**就是旧钥匙** ⇒ 库文件不必动，开库那条路照样开得开
        let boxed = keyring().unwrap().unwrap_key(&master, "mig-a").unwrap();
        assert_eq!(boxed, legacy, "★ 空间钥匙 == 旧钥匙（所以一个字节都不用重写）");
        {
            let probe = Connection::open(&path).unwrap();
            crate::security::key_space_conn(&probe, &path).unwrap();
            probe.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0)).unwrap();
        }
        // 迁移之后：闸门把它当**加密空间**（袋里有它）
        assert!(space_status(&dir, "mig-a").in_keyring);

        // ④ 幂等：再来一次 ⇒ Ok(false)，不重复做
        assert!(!migrate_legacy_space_into_keyring(&c, &dir, "mig-a").unwrap());

        crate::security::tests_set_session_key(None);
        set_keyring_for_test(None);
        set_session_master(None).unwrap();
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ C 第二半：**轮换成真随机的空间钥匙**（先备份、失败不动、之后仍打得开）。
    #[test]
    fn rotating_to_a_random_key_backs_up_first_and_keeps_the_space_readable() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuyonote-rotate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        // 造"今天那种"已加密空间：旧应用级钥匙加密 ＋ 一份数据
        let legacy = crate::keyring::random_space_key();
        let path = crate::db::space_db_path(&dir, "rot-a");
        {
            let a = crate::db::open_space_conn_at("rot-a", &dir).unwrap();
            a.execute(
                "INSERT INTO pages (id, workspace_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at) \
                 VALUES ('p1', 'rot-a', '机密', '{\"root\":{}}', '', 'page', 0, 1, 1, NULL)",
                [],
            )
            .unwrap();
            a.close().unwrap();
        }
        crate::security::convert_space_db(&path, true, Some(&legacy)).unwrap();
        let mut c = crate::db::open_space_conn_at("rot-b", &dir).unwrap();
        set_keyring_for_test(None);
        set_session_master(None).unwrap();
        crate::security::tests_set_session_key(None);

        // 前置：用第一半把旧钥匙迁进袋子
        let mut kr = Keyring::new();
        let master = kr.kdf.derive_master("我家猫叫mimi").unwrap();
        sync::set_meta_state(&c, META_KEYRING, &kr.to_json().unwrap()).unwrap();
        set_keyring_for_test(Some(kr));
        set_session_master(Some(master)).unwrap();
        crate::security::tests_set_session_key(Some(legacy));
        assert!(migrate_legacy_space_into_keyring(&c, &dir, "rot-a").unwrap());

        // ① 明文空间 ⇒ Err（没什么可轮换）
        let err = rotate_legacy_space_to_random_key(&mut c, &dir, "rot-b").unwrap_err();
        assert!(err.contains("不是密文"), "{err}");

        // ② 轮换：钥匙真的换了 ＋ 留了备份
        let new_key = rotate_legacy_space_to_random_key(&mut c, &dir, "rot-a").unwrap();
        assert_ne!(new_key, legacy, "轮换要真的换一把");
        assert_eq!(keyring().unwrap().unwrap_key(&master, "rot-a").unwrap(), new_key, "盒子里是新钥匙");
        let backup = path.with_extension("db.pre-rotate.bak");
        assert!(backup.exists(), "先备份：备份文件要在");
        // ③ 新钥匙打得开（库真被重加密了），且数据还在
        {
            let probe = Connection::open(&path).unwrap();
            crate::security::key_space_conn(&probe, &path).unwrap();
            let n: i64 = probe.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 1, "★ 重加密往返之后数据没丢");
        }
        // ④ 旧钥匙**打不开**了（证明真的换了钥匙，而不是只换了个盒子）
        {
            let probe = Connection::open(&path).unwrap();
            let _ = probe.execute_batch(&format!(
                "PRAGMA key = \"x'{}';\";",
                crate::crypto::key_hex(&legacy)
            ));
            assert!(
                probe.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get::<_, i64>(0)).is_err(),
                "旧钥匙不该还能开"
            );
        }

        crate::security::tests_set_session_key(None);
        set_keyring_for_test(None);
        set_session_master(None).unwrap();
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 清理守卫：这条判据会动**进程级全局**（`KEYRING` / `SESSION_MASTER` / `SESSION_KEY`），
    /// 所以**失败路径也必须清干净** —— 上一轮真踩过：判据在清理之前 panic，把后面 5 条空间判据
    /// 连坐弄红（`space_kind_round_trips…` / `the_security_overview…` 之类），根因只有一条。
    /// `Drop` 守卫是这里最省事的做法：不管从哪一行炸，都会清。
    struct CleanupGuard(std::path::PathBuf);
    impl Drop for CleanupGuard {
        fn drop(&mut self) {
            crate::security::tests_set_session_key(None);
            set_keyring_for_test(None);
            let _ = set_session_master(None);
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// ★★ "轮换**正开着**的那个空间"才是最常见的用法（用户就待在这个空间里点它）——
    /// 实现必须在转换前**自己**让开连接（Windows 文件占用 ⇒ `os error 5`），转完再把连接
    /// **按真实状态**开回来，而且**成功时要先让内存里的盒子跟上**（重新打开是按盒子取钥匙的）。
    /// ⚠️ 这条路径原来没人守：已有的判据拿的是**别的空间**的连接（`open_space_conn_at("rot-b")`）。
    #[test]
    fn rotating_the_space_the_connection_currently_holds_works_and_reopens_it() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuyonote-rot-held-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        let _guard = CleanupGuard(dir.clone());
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        let path = crate::db::space_db_path(&dir, "held-a");

        // 造一个**旧的（应用级钥匙加密的）**空间，里面有一页数据
        let legacy = crate::crypto::random_32();
        {
            let a = crate::db::open_space_conn_at("held-a", &dir).unwrap();
            a.execute(
                "INSERT INTO pages (id, workspace_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at) \
                 VALUES ('p1', 'held-a', '机密', '{\"root\":{}}', '', 'page', 0, 1, 1, NULL)",
                [],
            )
            .unwrap();
            a.close().unwrap();
        }
        crate::security::convert_space_db(&path, true, Some(&legacy)).unwrap();

        // ⚠️ 顺序要紧：**先**把旧钥匙放进会话，**再**开这个加密空间（开的时候就要用钥匙）
        crate::security::tests_set_session_key(Some(legacy));
        // ★ 这次的连接**就开着** held-a（＝用户正待在这个空间里）
        let mut c = crate::db::open_space_conn_at("held-a", &dir).unwrap();
        set_keyring_for_test(None);
        set_session_master(None).unwrap();

        let mut kr = Keyring::new();
        let master = kr.kdf.derive_master("我家猫叫mimi").unwrap();
        sync::set_meta_state(&c, META_KEYRING, &kr.to_json().unwrap()).unwrap();
        set_keyring_for_test(Some(kr));
        set_session_master(Some(master)).unwrap();
        assert!(migrate_legacy_space_into_keyring(&c, &dir, "held-a").unwrap());

        // ① ★ 轮换**正开着**的这个空间：不许因为文件占用而失败
        let new_key = rotate_legacy_space_to_random_key(&mut c, &dir, "held-a")
            .expect("★ 轮换正开着的空间必须能成（函数自己负责让开连接、并让盒子跟上）");
        assert_ne!(new_key, legacy, "轮换要真的换一把");

        // ② ★ 连接被**按真实状态**开了回来：还能查、数据还在
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0))
            .expect("★ 转完必须把连接开回来（不然用户眼前那个空间就废了）");
        assert_eq!(n, 1, "★ 重加密往返之后数据没丢");
        // ③ 盒子里是新钥匙，磁盘上那份确实是密的，元数据里的标记也在
        assert_eq!(keyring().unwrap().unwrap_key(&master, "held-a").unwrap(), new_key);
        assert!(crate::security::space_db_is_encrypted(&path));
        // ④ meta 里那一份也换过了（"只放内存"那一步的后续：真连接写 meta）
        assert_eq!(
            keyring().unwrap().unwrap_key(&master, "held-a").unwrap(),
            sync::get_meta_state(&c, META_KEYRING)
                .and_then(|t| Keyring::from_json(&t).ok())
                .and_then(|k| k.unwrap_key(&master, "held-a").ok())
                .expect("meta 里的袋子也应当能解出新钥匙"),
            "★ 内存与 meta 里那份必须是同一把钥匙（别只换了一半）"
        );
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
        let _g = crate::security::SEC_LOCK.lock().unwrap(); // 会话态是进程级全局 ⇒ 与 security 的测试串行
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
        let _g = crate::security::SEC_LOCK.lock().unwrap();
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
        let _g = crate::security::SEC_LOCK.lock().unwrap();
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
