//! **按空间的加密**（决策稿 [加密作用域](../docs/plans/2026-09-23-encryption-scope-decision.md) **第 1 步**的第一半）。
//!
//! ## 为什么需要它
//!
//! 原先的开关是**应用级**的（`security.rs` 的 `encryption_enabled` 读 meta.db 一个标志，
//! `encrypt_payload` 只看它）⇒ **一开全都加密、一关全都明文**，而口径要求
//! "个人空间密文 / 团队空间明文"**同时成立**。
//!
//! ## 现在的形状（★ owner 第三轮拍板 2026-09-24：**应用级那套整条删掉，不向后兼容**）
//!
//! · **空间 id 从库文件主干反推**（`…/spaces/<id>.db`）⇒ `key_space_conn` 不必改签名就能"按空间取钥匙"；
//! · **钥匙袋放 meta.db**（明文，和原先的盐/哨兵同一族；它是**公开材料**，见 `keyring.rs` 头注）；
//! · **会话里存主密钥**（`SESSION_MASTER`）：解锁时从口令 ＋ 袋子里记的 KDF 参数现派生，用完即散（不落盘）；
//! · **袋子是唯一的钥匙来源**：`space_key_for_path` 只在"袋子里真有这个空间的盒子"时才返回钥匙；
//!   没有袋子 / 这个空间不在袋里 ⇒ `None` ⇒ 调用方按**明文空间**处理（**不再有"应用级旧钥匙"那条兜底**）。
//!   ⚠️ 因此"密文库 ＋ 袋里没有它"＝ 应用级加密的存量库，本版**打不开** ⇒ 由调用方
//!   （`security::key_space_conn` / `wire_keys_for_conn`）**响亮报错**，绝不静默降级成明文。
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

/// 本进程**载入了**公开材料吗（袋子在 meta 里、但还没载进内存 ⇒ `false`）。
///
/// 为什么要单有一条：`space_key` 对"没有袋子"与"文件是旧的应用级密文"都给不出钥匙，
/// 而这两件事的**出路完全不同**（前者先解锁，后者本版根本打不开）—— 报错必须分得开。
pub fn keyring_loaded() -> bool {
    KEYRING.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// 用主密钥**试解袋子里的盒子**：解得开任何一个 ⇒ 口令对；**一个都解不开 ⇒ `Err`**。
///
/// 这是解锁时"口令对不对"的**唯一**判据（owner 第三轮拍板：哨兵已随应用级加密一起删，
/// 由解盒子的 AEAD 回答）。袋子里**一个盒子都没有** ⇒ `Ok(())`：
/// 那等价于"什么都还没加密"，没有可验证的东西，也不该因此报错。
pub fn verify_master_against_keyring(kr: &Keyring, master: &AppKeys) -> Result<(), String> {
    if kr.spaces.is_empty() {
        return Ok(());
    }
    let mut last = String::new();
    for id in kr.spaces.keys() {
        match kr.unwrap_key(master, id) {
            Ok(_) => return Ok(()),
            Err(e) => last = e,
        }
    }
    Err(format!("打不开（口令不对或盒子被改过）：{last}"))
}

/// 测试用：直接装/卸公开材料（**跨模块的集成判据**要用；生产路径走 `carry_keyring` / `store_keyring`）。
#[cfg(test)]
pub(crate) fn set_keyring_for_test(kr: Option<Keyring>) {
    *KEYRING.lock().unwrap() = kr;
}

/// 测试用：给**一个空间**装上盒子（钥匙由调用方给）＋ 装上会话主密钥。
///
/// 为什么要有它：owner 第三轮拍板之后"已解锁的加密空间"只有这一种造法
/// （袋子里的盒子 ＋ 会话里的主密钥），而 `backup` 这类**别的模块**的判据也要造它。
/// 返回主密钥（有些判据要拿它去解盒子）。
#[cfg(test)]
pub(crate) fn set_space_box_for_test(space_id: &str, key: &[u8; 32], passphrase: &str) -> AppKeys {
    let mut kr = Keyring::new();
    let master = kr.kdf.derive_master(passphrase).unwrap();
    kr.wrap(&master, space_id, key).unwrap();
    *KEYRING.lock().unwrap() = Some(kr);
    *SESSION_MASTER.lock().unwrap() = Some(master);
    master
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

/// **按空间的钥匙**（核心入口）：`Ok(Some(k))` ＝ 用这个空间自己的钥匙；`Ok(None)` ＝ 这个空间**不是**
/// 按钥匙袋加密的（明文空间）。
///
/// 三条出口（与文件头两条纪律一一对应）：
/// · 没有袋子 / 这个空间不在袋里 ⇒ `Ok(None)`（**明文空间**，不再是"旧路"——应用级那条已删）；
/// · 袋里有它、会话有主密钥 ⇒ `Ok(Some(解出来的钥匙))`；
/// · 袋里有它、会话锁着 ⇒ `Err`（**不许**静默退回旧钥匙）；盒子坏了/被换过也在这里报出来。
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
                    "{}是个人空间但还没有加密：先给它设一句口令（按空间加密），再绑定同步 —— \
                     否则它的内容会**明文**发到服务端，而且事后加密也撤不回已经落库的那份。\
                     （如果你要的是团队空间，请在空间设置里把它标成团队空间。）",
                    st.label()
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
    /// 这个空间的**显示名**（给用户看的那句话用它，而不是 id）。
    ///
    /// ⚠️ 它是**可选**的：`space_status` 是"不需要 conn 的纯读"，拿不到名字 ⇒ 空串。
    /// 有 conn 的调用方（`space_security_views` / `sync::sync_bind_gate` /
    /// `security::encryption_status`）**应当**把它填上 —— 否则界面上会出现
    /// `空间「119738aa-6bc1-…」…` 这种 uuid（owner 2026-09-24 当场指出："空间名称不对"）。
    pub name: String,
    /// 库文件本身是不是密的（**嗅文件头**，不需要钥匙 —— 启动闸门就靠它）。
    pub encrypted_on_disk: bool,
    /// 钥匙袋里有没有它的盒子。
    pub in_keyring: bool,
    /// 现在**拿得到**钥匙吗（袋里有它 ＋ 会话已解锁）。
    pub key_available: bool,
}

impl SpaceCryptoStatus {
    /// 给用户看的称谓：**有名字用名字，没有才退回 id**（id 只在排错时有意义）。
    pub fn label(&self) -> String {
        if self.name.trim().is_empty() {
            format!("空间「{}」", self.space_id)
        } else {
            format!("空间「{}」", self.name)
        }
    }
}

/// 读一个空间的三条读数（纯读：不写库、不解密、不需要 conn）。
///
/// ⚠️ **拿不到名字**（`name` 留空）⇒ 调用方若有 conn 应当自己填（见 [`SpaceCryptoStatus::name`]）。
pub fn space_status(app_data_dir: &Path, space_id: &str) -> SpaceCryptoStatus {
    let path = crate::db::space_db_path(app_data_dir, space_id);
    let in_keyring = keyring().map(|k| k.has(space_id)).unwrap_or(false);
    SpaceCryptoStatus {
        space_id: space_id.to_string(),
        name: String::new(),
        encrypted_on_disk: crate::security::space_db_is_encrypted(&path),
        in_keyring,
        key_available: in_keyring && session_master().is_some(),
    }
}

/// 给一个读数补上**显示名**（有 conn 的调用方用；空间已被删/查不到 ⇒ 原样返回）。
pub fn fill_space_name(c: &Connection, st: &mut SpaceCryptoStatus) {
    if !st.name.is_empty() || st.space_id.is_empty() {
        return;
    }
    if let Ok(name) = c.query_row(
        "SELECT COALESCE(name, '') FROM meta.workspaces WHERE id = ?1",
        [&st.space_id],
        |r| r.get::<_, String>(0),
    ) {
        st.name = name;
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
            let mut st = space_status(app_data_dir, &id);
            // ★ 名字一起读出来：闸门那句拦人的话要说**名字**（不是 uuid）。
            fill_space_name(conn, &mut st);
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

/// 转换失败时撤掉"**这一次刚造**"的盒子（本来就有的**不许动** —— 那是这个空间的真实状态）。
///
/// 为什么必须有它（owner 2026-09-24 现场）：`enable_space` 为了"紧随其后的重新打开能按空间拿到钥匙"，
/// 是**先把袋子落进 meta 再转换**的。转换一旦失败而盒子留下，`space_status` 的
/// `encrypted = 库是密的 OR 袋里有它` 就会判成"已加密" ⇒ 面板显示"已加密"、闸门**放行它的同步**，
/// 而库里其实一个字都没加密。宁可让它失败得干干净净。
fn discard_minted_box(conn: &Connection, kr: &mut Keyring, space_id: &str) {
    kr.remove(space_id);
    if let Err(re) = store_keyring(conn, kr) {
        eprintln!("[space] 撤掉刚造的盒子失败（内存里已撤，meta 里可能还在）：{re}");
    }
}

/// ★ **按空间启用**：只把这个空间**自己**的库换成密文（钥匙是**新随机**一把，装进钥匙袋）。
///
/// 与已删掉的 `set_encryption_impl`（应用级：把所有空间一起换成同一把钥匙）**不是一条路** ——
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
    // ② 盒子：已有 ⇒ **复用**（不换钥匙）；没有 ⇒ **只有在库还是明文时才**新随机一把
    let path = crate::db::space_db_path(app_data_dir, space_id);
    let mut kr = keyring().ok_or("钥匙袋缺失")?;
    // ★ 记住这个盒子是不是**这一次刚造的** —— 转换失败时要把它撤掉（见 ③ 后面那段）。
    let mut minted_here = false;
    let key = if kr.has(space_id) {
        kr.unwrap_key(&master, space_id)?
    } else {
        // ★★ 承重：库**已经是密文**而袋里没有它的盒子 ⇒ 那把钥匙**不是**我们刚随机出来的这把
        //（唯一的来源：早先「应用级一把钥匙」加密的存量空间）。
        // ⚠️ 这时**绝不能**凭空造盒子：`convert_space_db` 对"已经是目标状态"是 **no-op**（不会重加密）
        //    ⇒ 盒子里的新钥匙与库文件对不上，那个空间**打不开**，而且是**静默**的（盒子看着好好的）。
        // ⇒ 报错，并把**唯一还有救的那条路**说清（C=1「报错＋说清」在这里的落点）。
        //    ⚠️ owner 第三轮拍板（2026-09-24）之后不再有"把旧钥匙迁进钥匙袋"这条出路了
        //    （① 那套迁移/轮换连函数一起删了）—— 所以这里**只**剩"从别处取回公开材料"。
        if crate::security::space_db_is_encrypted(&path) {
            return Err(format!(
                "空间「{space_id}」的库已经是密文，但钥匙袋里没有它的盒子 —— 那是早先「应用级加密」\
                 （全局一把钥匙）留下的存量库，而那一套**已不再支持**。\
                 这时不能凭空造新盒子：库不会被重新加密，装上新盒子之后这个空间就**打不开**了。\
                 唯一还有救的一条路：在**还有那份旧材料**的设备上把公开材料推给同步服务，\
                 再在这台设备上取回（公开材料里带着这个空间的盒子）；否则这个空间打不开。"
            ));
        }
        let k = random_space_key();
        kr.wrap(&master, space_id, &k)?;
        minted_here = true;
        k
    };
    // ★ **先把袋子落下去（内存 ＋ meta）再转换**：这样紧接着的"重新打开这个空间"
    //   才会按空间拿到钥匙（`key_space_conn` 查的就是这份）。
    store_keyring(conn, &kr)?;

    // ③ ★ 只换**这一个**空间的库。⚠️ 若这个空间**正被本连接开着**，必须先让开：
    //   Windows 上文件被占用时"替换库文件"会 `os error 5`（`convert_space_db` 里同样的换法）。
    let holds = holds_space(conn, space_id);
    if holds {
        let _ = std::mem::replace(conn, Connection::open_in_memory().map_err(|e| e.to_string())?);
    }
    let converted = crate::security::convert_space_db(&path, true, Some(&key));
    if holds {
        // 无论成败都把空间**按当前真实状态**重新打开（失败时它还是明文库）
        let reopened = crate::db::reopen_space_at(conn, space_id, app_data_dir);
        if let Err(e) = converted {
            if minted_here {
                discard_minted_box(conn, &mut kr, space_id);
            }
            return Err(format!("{e}（已重新打开这个空间；转换未生效）"));
        }
        reopened?;
    }
    if let Err(e) = converted {
        if minted_here {
            discard_minted_box(conn, &mut kr, space_id);
        }
        return Err(format!("{e}（转换未生效）"));
    }

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
            name: "我的空间".into(),
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
        // ★ 说的是**名字**而不是 uuid（owner 2026-09-24："空间名称不对"）
        assert!(blocked.contains("我的空间"), "拦人的话要说空间名：{blocked}");
        assert!(!blocked.contains("\"s\""), "不该把内部 id 当名字：{blocked}");
        // ② 个人空间已加密（文件是密的 **或** 袋里有它）⇒ 放行
        assert_eq!(sync_gate(&enc, SpaceKind::Personal), SyncGate::Allowed);
        assert_eq!(sync_gate(&boxed, SpaceKind::Personal), SyncGate::Allowed);
        // ③ 团队空间**免检**（明文也不拦 —— 那正是它换来的东西）
        assert_eq!(sync_gate(&plain, SpaceKind::Team), SyncGate::Allowed);
        // ④ 未分类 ⇒ 放行，但把"没管到"这个事实报出来
        assert_eq!(sync_gate(&plain, SpaceKind::Unknown), SyncGate::AllowedUnclassified);
    }

    /// ★★ **老 meta.db 必须补上 `kind` 列**（owner 2026-09-24 现场抓到的真 bug）。
    ///
    /// 现场（截图）：改分类报 `no such column: kind`，而面板里**每个空间都显示"未分类"**。
    /// 根因不是这一片：那个列只写在 `meta_migrate` 的 `CREATE TABLE IF NOT EXISTS workspaces` 里，
    /// 而**老库已经有那张表** ⇒ 建表语句是 no-op ⇒ 列永远补不上（`encrypted`/`cipher_format` 当初都配了
    /// 幂等 ALTER，`kind` 漏了）。后果是**静默**的：`space_kind` 的 SQL 错误被 `unwrap_or(Unknown)`
    /// 吞掉 ⇒ "改不了分类"看起来像"还没分类"，闸门于是对所有空间放行。
    ///
    /// ⚠️ 为什么当时 11 条空间判据全绿：它们都在**全新的** meta.db 上跑（`CREATE TABLE` 一步到位）
    /// ⇒ 这一类"只有老库才会中"的迁移缺陷**天然抓不到**。这条判据**刻意造一张老表**。
    #[test]
    fn an_old_meta_db_gets_the_kind_column_so_classification_actually_sticks() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuyonote-oldmeta-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();

        // ① 造"老库"：meta.db 的 workspaces **没有 kind 列**（＝ 2026-09-23 之前建的库）。
        std::fs::create_dir_all(&dir).unwrap();
        {
            let m = Connection::open(crate::db::meta_path(&dir)).unwrap();
            m.execute_batch(
                "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, theme TEXT, \
                 icon TEXT NOT NULL DEFAULT '', sort_order REAL NOT NULL DEFAULT 0, \
                 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, \
                 encrypted INTEGER NOT NULL DEFAULT 0, cipher_format INTEGER NOT NULL DEFAULT 0);\
                 INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('old-a', '老库', 1, 1);",
            )
            .unwrap();
        }

        // ② 正常启动路径：meta 迁移（幂等补列）→ 再开一个空间连接（它会 ATTACH meta）。
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        let c = crate::db::open_space_conn_at("old-a", &dir).unwrap();

        // ③ 列真的补上了。⚠️ 直接**读那一列**，别用 `pragma_table_info('meta.workspaces')`：
        //    带 schema 的名字在 table-valued pragma 里要么报错要么返回空（我第一版就踩了这个，
        //    于是"探针"红得毫无意义）；而"能不能 SELECT 到 kind"与现场那句
        //    `no such column: kind` 本来就是同一件事。
        let probe: Result<String, _> = c.query_row(
            "SELECT COALESCE(kind, '') FROM meta.workspaces WHERE id = 'old-a'",
            [],
            |r| r.get(0),
        );
        assert_eq!(
            probe.unwrap(),
            "",
            "★ 老 meta.db 缺 kind 列 ⇒ 分类改不了、闸门永远放行（而且是静默的）"
        );

        // ④ 而且分类**真的改得动、读得回**（这才是用户在面板上做的那个动作）
        set_space_kind(&c, "old-a", SpaceKind::Personal).unwrap();
        assert_eq!(space_kind(&c, "old-a"), SpaceKind::Personal);
        // ⑤ 补列的默认值是空串＝未分类（老库行为一字不变：闸门对未分类一律放行）
        c.execute(
            "INSERT INTO meta.workspaces (id, name, created_at, updated_at) VALUES ('old-b', '另一个老空间', 1, 1)",
            [],
        )
        .unwrap();
        assert_eq!(space_kind(&c, "old-b"), SpaceKind::Unknown);

        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
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
            name: String::new(), // 视图判据不关心称谓：留空 ⇒ 退回 id（见 `label()`）
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
        // ★★ 拦人的那句话要说**空间名**，不是内部 id（owner 2026-09-24 截图当场指出：
        //    行头写着"新建工作区"，可理由里却是 `空间「119738aa-…」…`）。
        assert!(p.gate.reason.contains("个人甲"), "闸门理由要用空间名：{}", p.gate.reason);
        assert!(!p.gate.reason.contains("ov-p"), "闸门理由里不许出现内部 id：{}", p.gate.reason);
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

    /// ★ owner 2026-09-24 拍板（选项 ②）：**导入的空间也是「个人空间」**（分类由入口决定）。
    ///
    /// 于是"导入 ⇒ 还没加密 ⇒ 绑同步被闸门拦住并引导设口令"这条链与"本地新建"**完全一样** ——
    /// 口径只有一条，不靠用户事后自己去面板里分类（那正是"未分类＝闸门没管到它"的漏洞面）。
    #[test]
    fn an_imported_space_is_personal_so_the_gate_guides_encryption() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuyonote-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        let c = crate::db::open_space_conn_at("imp-z", &dir).unwrap();
        set_keyring_for_test(None);
        set_session_master(None).unwrap();

        // ① 导入时**没**加密（本机还没解锁/没袋子）⇒ personal ＋ 闸门拦
        crate::workspaces::insert_imported_space(&c, "imp-a", "导入的甲", "blue", "", 1.0, 1, false)
            .unwrap();
        assert_eq!(space_kind(&c, "imp-a"), SpaceKind::Personal, "★ 导入 ⇒ 个人空间");
        let st = space_status(&dir, "imp-a");
        assert!(!st.encrypted_on_disk && !st.in_keyring);
        match sync_gate(&st, space_kind(&c, "imp-a")) {
            SyncGate::Blocked(msg) => assert!(msg.contains("没有加密"), "{msg}"),
            other => panic!("导入的未加密空间必须被拦，实际 {other:?}"),
        }

        // ② 导入时**顺手加密了**（本机已解锁且有袋子）⇒ 同样是 personal，标记也落了
        crate::workspaces::insert_imported_space(&c, "imp-b", "导入的乙", "blue", "", 2.0, 2, true)
            .unwrap();
        assert_eq!(space_kind(&c, "imp-b"), SpaceKind::Personal);
        let marked: i64 = c
            .query_row(
                "SELECT COALESCE(encrypted, 0) FROM meta.workspaces WHERE id = 'imp-b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(marked, 1, "导入时就加密过 ⇒ 那一列也要落");

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

    /// 清理守卫：这条判据会动**进程级全局**（`KEYRING` / `SESSION_MASTER`），
    /// 所以**失败路径也必须清干净** —— 上一轮真踩过：判据在清理之前 panic，把后面 5 条空间判据
    /// 连坐弄红（`space_kind_round_trips…` / `the_security_overview…` 之类），根因只有一条。
    /// `Drop` 守卫是这里最省事的做法：不管从哪一行炸，都会清。
    struct CleanupGuard(std::path::PathBuf);
    impl Drop for CleanupGuard {
        fn drop(&mut self) {
            set_keyring_for_test(None);
            let _ = set_session_master(None);
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// ★★ **转换失败要失败得干净**（owner 2026-09-24 现场引出的两条）：
    ///
    /// ① **比本版新的库 ⇒ 拒绝转换**：源里有目标没有的列 ⇒ 硬拷会**静默丢数据**，
    ///    所以 `convert_space_db` 的逐表拷贝按列名求交集，并在这条上**响亮拒绝**；
    /// ② **这次刚造的盒子必须撤掉**：`enable_space` 是"先落袋子再转换"的
    ///    （为了让紧随其后的"重新打开"能按空间拿到钥匙），转换失败而盒子留下 ⇒
    ///    `space_status` 的 `encrypted = 库是密的 OR 袋里有它` 会判成"已加密" ⇒
    ///    面板说"已加密"、闸门**放行它的同步**，而库里一个字都没加密。
    ///
    /// ③ 还要能**再试一次**：第一次失败不该把这个空间锁进"以后都开不了"的状态。
    #[test]
    fn a_failed_conversion_refuses_newer_columns_and_throws_away_the_box_it_just_minted() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuyonote-futcol-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        // 连接开在**别的**空间上（＝现场的形状：用户待在「工作」里，去给「新建工作区」开加密）
        let mut c = crate::db::open_space_conn_at("fut-z", &dir).unwrap();
        set_keyring_for_test(None);
        set_session_master(None).unwrap();
        // 造一个"比本版新"的空间库：多一列本版不认识的
        let path = crate::db::space_db_path(&dir, "fut-a");
        {
            let a = crate::db::open_space_conn_at("fut-a", &dir).unwrap();
            a.close().unwrap();
        }
        {
            let x = Connection::open(&path).unwrap();
            x.execute_batch("ALTER TABLE pages ADD COLUMN zzz_future TEXT NOT NULL DEFAULT '';")
                .unwrap();
        }
        assert!(!crate::security::space_db_is_encrypted(&path), "前提：它还是明文");

        // ① 拒绝转换（而不是静默把那列丢掉）
        let err = enable_space(&mut c, &dir, "fut-a", Some("我家猫叫mimi")).unwrap_err();
        assert!(err.contains("本版不认识的列"), "要说清为什么拒绝：{err}");
        assert!(!crate::security::space_db_is_encrypted(&path), "拒绝之后文件必须原样（还是明文）");

        // ② ★ 这次刚造的盒子**不许留下**（否则界面说"已加密"、闸门放行，而库里是明文）
        assert!(
            !keyring().unwrap().has("fut-a"),
            "★ 转换失败却留下了盒子 ⇒ 面板会显示「已加密」、闸门会放行它的同步"
        );
        assert!(!space_status(&dir, "fut-a").in_keyring);
        assert!(!space_status(&dir, "fut-a").encrypted_on_disk);

        // ③ 升级到"认识那一列"的版本（模拟）⇒ 同一次会话里**还能再试**，这次应当成功
        {
            let x = Connection::open(&path).unwrap();
            x.execute_batch("ALTER TABLE pages DROP COLUMN zzz_future;").unwrap();
        }
        let key = enable_space(&mut c, &dir, "fut-a", None).expect("第一次失败不该锁死这个空间");
        assert!(crate::security::space_db_is_encrypted(&path));
        assert_eq!(keyring().unwrap().unwrap_key(&keyring().unwrap().kdf.derive_master("我家猫叫mimi").unwrap(), "fut-a").unwrap(), key);

        set_keyring_for_test(None);
        set_session_master(None).unwrap();
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ 承重判据：库**已经是密文**而袋里没有它的盒子时，`enable_space` **必须报错**，
    /// 而且**一个盒子都不许造** —— 造了就与库文件对不上（`convert_space_db` 对"已经是目标状态"
    /// 是 no-op，不会重加密），那个空间会**打不开**，还算**静默**（盒子看着好好的）。
    /// 这正是"应用级加密存量空间"唯一的形态，所以这条判据守的是数据可达性。
    ///
    /// ★ owner 第三轮拍板（2026-09-24）改写：① 那套"把旧钥匙迁进钥匙袋"已经删掉，
    /// 所以断言从「要给出第一条出路（迁）」改成「**应用级加密已不再支持** ＋ 说清唯一的出路」；
    /// 而且这条判据的连接**不再**开在 `enc-a` 上（存量库根本开不开 —— 那正是这一片要的事实）。
    #[test]
    fn enabling_a_space_whose_db_is_already_encrypted_refuses_to_mint_a_box() {
        let _g = crate::security::SEC_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("shuyonote-enable-enc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        let _guard = CleanupGuard(dir.clone());
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        let path = crate::db::space_db_path(&dir, "enc-a");

        // 造一个"应用级旧钥匙加密"的空间（这就是存量空间的形状）
        let legacy = crate::crypto::random_32();
        {
            let a = crate::db::open_space_conn_at("enc-a", &dir).unwrap();
            a.close().unwrap();
        }
        crate::security::convert_space_db(&path, true, Some(&legacy)).unwrap();

        // ★ 存量库**打不开**（本版不再退回旧钥匙）—— 这条本身就是 owner 拍板的后果，钉在下面
        {
            let probe = Connection::open(&path).unwrap();
            let err = crate::security::key_space_conn(&probe, &path).unwrap_err();
            assert!(err.contains("应用级加密"), "{err}");
        }

        // 连接开在一个**别的（明文）空间**上：正是"用户打开应用、去给那个存量空间点开启加密"那一刻
        let mut c = crate::db::open_space_conn_at("enc-b", &dir).unwrap();
        set_keyring_for_test(None);
        set_session_master(None).unwrap();

        // 有袋子（还是空的）＋ 会话已解锁 ⇒ 正是"要不要凭空造盒子"的那一刻
        let kr = Keyring::new();
        let master = kr.kdf.derive_master("我家猫叫mimi").unwrap();
        sync::set_meta_state(&c, META_KEYRING, &kr.to_json().unwrap()).unwrap();
        set_keyring_for_test(Some(kr));
        set_session_master(Some(master)).unwrap();

        let err = enable_space(&mut c, &dir, "enc-a", None).unwrap_err();
        assert!(err.contains("打不开"), "要说清后果：{err}");
        assert!(err.contains("应用级加密"), "要说清这是应用级加密留下的：{err}");
        assert!(err.contains("公开材料"), "要给出唯一还有救的那条路：{err}");
        // ★ 关键：**一个盒子都没造**
        assert!(!keyring().unwrap().has("enc-a"), "★ 不许凭空造盒子（造了就打不开）");
        assert!(crate::security::space_db_is_encrypted(&path), "库文件本身一个字节都不该被动");
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
        // 参数被改过 ⇒ 推出来的是**另一把**主密钥（盒子因此打不开）。
        // ⚠️ 这里**不再是**"拒绝"：守卫已放宽成"参数合理就放行"（owner 件1=B 的前置 —— 不放宽的话，
        //    默认值一抬，所有老袋子会被判"与本版不同"直接打不开）。真正的保护在下一步：
        //    钥匙算错了 ⇒ 盒子解不开（AEAD 会认出来）。
        let mut tampered = on_device_b.clone();
        tampered.kdf.t = 9;
        let wrong = tampered.kdf.derive_master("我家猫叫mimi").unwrap();
        assert_ne!(
            wrong.legacy, m.legacy,
            "★ 改过参数必须推出另一把（否则'按材料记的参数派生'就是假的）"
        );
        assert_eq!(KdfParams::fresh().algo, "argon2id");
    }
}
