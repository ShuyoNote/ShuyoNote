//! 融合账本（**按空间名**）—— 记「这一次融合融了什么」，并支持 ⭐ **只撤这一次** 与 ⭐ **永久不分离**。
//!
//! 图上那两格的落点：⭐ 图②「**撤销这次融合**」＋ ⭐ 图③「**想留在一起，永久不分离**」。
//!
//! ## 三条口径（owner 已拍 ✓）
//! 1. ⭐ **按空间名称融合**，⛔ **不按 `space_id`**（见 [`normalize_space_name`]：先归一再判等）。
//! 2. ⭐ **只限个人空间** ⇒ ⛔ 团队空间（以及"未分类"）**一个字节都不动**（连 `load` 都不做）。
//! 3. ⭐ **撤销只撤"这一次"** ⇒ ⛔ 不连带更早的；⭐「永久不分离」**必须可解除**（⛔ 不许单向不可逆）。
//!
//! ## 为什么做成"可注入时钟 ＋ 可注入存储"
//! - ⭐ **判据够得着**：本文件的 `#[cfg(test)] mod tests` **不需要** crate 里的任何东西
//!   ⇒ 可以拿 `rustc --test` 单独跑（接线前也能先红后绿）。
//! - ⭐ **能一行接上**：业务侧只需要一个 [`LedgerStore`] 实现 ＋ 一行 [`MergeLedger::new`]。
//!
//! ## 一行接上（接线示范：⛔ 本文件里**不写**这段，以免依赖 `crate::` 破坏独立可测）
//! ```ignore
//! // ① 账本存 **meta.db 的一个 KV**（值＝本文件的 `encode_state` 文本）
//! struct MetaKv<'a>(&'a rusqlite::Connection);
//! impl mesh_merge_ledger::LedgerStore for MetaKv<'_> {
//!     fn load(&self) -> Result<mesh_merge_ledger::LedgerState, mesh_merge_ledger::LedgerError> {
//!         let raw = crate::sync::get_meta_state(self.0, mesh_merge_ledger::LEDGER_KEY);
//!         mesh_merge_ledger::decode_state(&raw.unwrap_or_default())
//!             .map_err(|e| mesh_merge_ledger::LedgerError::Store(e))
//!     }
//!     fn save(&self, s: &mesh_merge_ledger::LedgerState) -> Result<(), mesh_merge_ledger::LedgerError> {
//!         crate::sync::set_meta_state(self.0, mesh_merge_ledger::LEDGER_KEY, &mesh_merge_ledger::encode_state(s))
//!             .map_err(mesh_merge_ledger::LedgerError::Store)
//!     }
//! }
//! // ② 业务侧就这一行：
//! let out = mesh_merge_ledger::MergeLedger::new(&MetaKv(&conn)).record(now_ms, &req)?;
//! ```
//!
//! ⚠️ **本文件不做的事（如实说）**：不碰数据库、不碰网络、不做真机两端验收；`normalize_space_name`
//! 只覆盖**可机械判定**的归一（简繁/异体**不做** —— 与语义规格 §3／§10-③一致，那一格仍是"待定"）。

use std::cell::RefCell;
use std::fmt;

/// 账本在 `meta.sync_state` 里的键（**一个** KV；值＝[`encode_state`] 的文本）。
pub const LEDGER_KEY: &str = "mesh_merge_ledger_v1";

/// 文本格式版本（读不懂 ⇒ 报错，⛔ 不猜）。
pub const FORMAT_VERSION: &str = "v1";

// ─────────────────────────── 空间类别 ───────────────────────────

/// 空间类别（对应 `meta.workspaces.kind` 的三档）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpaceKind {
    /// `'personal'` —— ⭐ **唯一**有资格融合的那一档。
    Personal,
    /// `'team'` —— ⛔ 团队空间：一个字节都不动。
    Team,
    /// `''`（**默认**）或任何别的值 —— 未分类：⚠️ 取**零风险默认**（也不动，见语义规格 §10-②）。
    Unclassified,
}

impl SpaceKind {
    /// 从 `meta.workspaces.kind` 的**原样值**判定（`''` = 未分类）。
    pub fn from_raw(raw: &str) -> Self {
        match raw.trim() {
            "personal" => SpaceKind::Personal,
            "team" => SpaceKind::Team,
            _ => SpaceKind::Unclassified,
        }
    }

    /// ⭐ 能不能进融合账本 —— **只有个人空间能**。
    pub fn merge_eligible(self) -> bool {
        matches!(self, SpaceKind::Personal)
    }

    /// 回写 `kind` 列时的原样串（个人/团队/空）。
    pub fn as_raw(self) -> &'static str {
        match self {
            SpaceKind::Personal => "personal",
            SpaceKind::Team => "team",
            SpaceKind::Unclassified => "",
        }
    }
}

// ─────────────────────────── 按名判等 ───────────────────────────

/// ⭐ **按空间名融合**：归一后同名 ⇒ 视为同一个空间（**依据是名，⛔ 不是 `space_id`**）。
///
/// 归一步骤（与语义规格 §3 同序；⚠️ 只做**可机械判定**的那部分）：
/// ① 去掉不可见字符（零宽 / 软连字符 / BOM）→ ② 去掉首尾空白（**含全角空格 U+3000**）
/// → ③ 全角 ASCII ⇒ 半角（`U+FF01..=U+FF5E` 平移 `0xFEE0`；⚠️ 不做完整 NFKC）
/// → ④ 大小写折叠（**只对 ASCII**，CJK 原样）→ ⑤ 内部连续空白折成**一个**半角空格。
///
/// ⚠️ **只用于判等**，⛔ 不拿它改写用户写的名字（原样名另存 `name_display`）。
///
/// ## ⭐ 这些是【形状】归一，⛔ 不是【语义】归一
/// 上面五步处理的是**同一种写法的不同写法**（全角/半角、大小写、多敲了个空格、混进零宽字符）
/// —— 归一之后**还是同一个词**，所以可以判等。
///
/// ## ⭐⭐ 简繁 / 异体：**明确不做**（**owner 2026-10-10 拍定**，⛔ 不是欠账）
/// 简体「读书笔记」与繁体「讀書筆記」⭐ **算不同名** ⇒ **不会自动融**。
///
/// 为什么（逐字口径）：**猜了就会把两个本来不同名的空间悄悄融在一起** —— 那正是 owner 最不要的
/// （他在这道题上选的是「**不算** ＝ 最安全 ✓」：**绝不会把两个你以为分开的空间合成一个**）。
///
/// ⚠️ 给下一个人：**这不叫"还没做"，这叫"拍定不做"** ✗。若哪天有人"顺手"在这里加一张简繁折叠表，
/// 判据 `i_simplified_and_traditional_are_not_the_same_name` **会当场红** —— 那是有意的。
pub fn normalize_space_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut pending_space = false;
    let mut started = false;
    for ch in raw.chars() {
        // ① 不可见字符：零宽族 / 词连接符 / BOM / 软连字符
        if matches!(
            ch,
            '\u{200b}'..='\u{200f}' | '\u{2060}' | '\u{feff}' | '\u{00ad}'
        ) {
            continue;
        }
        // ② 首尾 + ③ 折半角
        let c = match ch {
            '\u{3000}' => ' ',
            '\u{ff01}'..='\u{ff5e}' => {
                char::from_u32(ch as u32 - 0xfee0).unwrap_or(ch)
            }
            _ => ch,
        };
        if c.is_whitespace() {
            if started {
                pending_space = true;
            }
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        started = true;
        // ④ 大小写折叠（ASCII；CJK 不受影响）
        out.push(c.to_ascii_lowercase());
    }
    out
}

// ─────────────────────────── 数据形状 ───────────────────────────

/// 一条融合记录 —— ⭐ 回答「**撤销它要动哪几行**」（[`MergeRecord::moved`]）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeRecord {
    /// 账本内单调递增的编号（撤销时点名它 ✓）。
    pub id: u64,
    /// 融合时刻（**外面传进来**的毫秒 ⇒ 可注入时钟）。
    pub at_ms: i64,
    /// ⭐ 依据哪个名（**归一后**）—— 判等与"同一对"都看它。
    pub name_key: String,
    /// 用户原样写的名字（⛔ 归一不覆盖它）。
    pub name_display: String,
    /// 来自哪台（`device_id`；⛔ 不是密钥材料）。
    pub peer_device: String,
    /// ⭐ **撤销要动的那些行**（并进来的条目 id ⇒ 撤它就删这些）。
    pub moved: Vec<String>,
    /// ⭐ 融合前本机已有几条（撤完的读数要**对得上它**）。
    pub kept_before: usize,
    /// 撤销时刻；`None` = 还没撤（⇒ 那一行仍显示「可撤回」）。
    pub undone_at_ms: Option<i64>,
    /// 幂等键（同一次接入重复调用 ⇒ 只记一笔）。
    pub idem_key: Option<String>,
}

/// 「永久不分离」标记 —— ⭐ 这一对（名 ＋ 设备）今后**不再每次融合**。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairMark {
    pub name_key: String,
    pub peer_device: String,
    pub marked_at_ms: i64,
}

/// 一本账的全部内容（＝ [`LEDGER_KEY`] 那个 KV 的值）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LedgerState {
    pub next_id: u64,
    pub merges: Vec<MergeRecord>,
    pub marks: Vec<PairMark>,
}

// ─────────────────────────── 请求／结果 ───────────────────────────

/// 记一次融合要交的东西。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeRequest {
    /// 服务端 `space_id`（个人空间是空串）—— ⚠️ **只作审计留痕**，判等⛔ 不看它。
    pub space_id: String,
    /// 空间名的**原样**写法（归一在里面做）。
    pub name: String,
    pub kind: SpaceKind,
    pub peer_device: String,
    /// 并进来的条目 id（⛔ 不许由本模块去猜）。
    pub moved: Vec<String>,
    /// 融合前本机已有几条。
    pub kept_before: usize,
    /// 幂等键（同一次接入给同一个键 ⇒ 重复调用不记第二笔）。
    pub idem_key: Option<String>,
}

impl MergeRequest {
    /// 个人空间的最小请求（`moved` / `kept_before` 用链式调用补）。
    pub fn personal(name: &str, peer_device: &str) -> Self {
        MergeRequest {
            space_id: String::new(),
            name: name.to_string(),
            kind: SpaceKind::Personal,
            peer_device: peer_device.to_string(),
            moved: Vec::new(),
            kept_before: 0,
            idem_key: None,
        }
    }

    /// 指定类别（团队/未分类只用于**反向判据**：要被拒 ✓）。
    pub fn with_kind(name: &str, kind: SpaceKind, peer_device: &str) -> Self {
        MergeRequest {
            kind,
            ..MergeRequest::personal(name, peer_device)
        }
    }

    pub fn space_id(mut self, id: &str) -> Self {
        self.space_id = id.to_string();
        self
    }
    pub fn moved<I, S>(mut self, ids: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.moved = ids.into_iter().map(Into::into).collect();
        self
    }
    pub fn kept(mut self, n: usize) -> Self {
        self.kept_before = n;
        self
    }
    pub fn idem(mut self, key: &str) -> Self {
        self.idem_key = Some(key.to_string());
        self
    }
}

/// [`MergeLedger::record`] 的三种结果（⭐ "没事发生"也是**结果**，⛔ 不伪装成错误）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeOutcome {
    /// 记下了新的一笔。
    Recorded(MergeRecord),
    /// ⭐ 这一对已「永久不分离」⇒ 今后不再每次融合（⛔ 没写库）。
    SkippedPermanent(PairMark),
    /// 同一次接入重复调用（幂等键相同）⇒ ⛔ 不记第二笔。
    SkippedDuplicate(MergeRecord),
}

/// 撤销一次融合要交的东西 —— ⭐ **必须点名哪一次**（图②说的就是"这次"）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UndoRequest {
    pub name: String,
    pub kind: SpaceKind,
    pub peer_device: String,
    pub merge_id: u64,
}

impl UndoRequest {
    pub fn personal(name: &str, peer_device: &str, merge_id: u64) -> Self {
        UndoRequest {
            name: name.to_string(),
            kind: SpaceKind::Personal,
            peer_device: peer_device.to_string(),
            merge_id,
        }
    }
    pub fn with_kind(name: &str, kind: SpaceKind, peer_device: &str, merge_id: u64) -> Self {
        UndoRequest {
            kind,
            ..UndoRequest::personal(name, peer_device, merge_id)
        }
    }
}

/// 撤销的结果 —— ⭐ 调用方拿它去**动行**并**报读数**。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UndoResult {
    pub merge_id: u64,
    /// ⭐ **要删的那几行**（＝当初并进来的条目）。
    pub removed: Vec<String>,
    /// ⭐ 撤完本机该剩几条（＝融合前那个读数）。
    pub kept: usize,
    /// 撤完**这一格**还有几笔可撤（⚠️ 按名判等 ⇒ **含别的设备那几笔**；它们一笔都不许被牵连）。
    pub other_undoable: usize,
}

/// 「永久不分离」标记／解除要交的东西。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermanentRequest {
    pub name: String,
    pub kind: SpaceKind,
    pub peer_device: String,
}

impl PermanentRequest {
    pub fn personal(name: &str, peer_device: &str) -> Self {
        PermanentRequest {
            name: name.to_string(),
            kind: SpaceKind::Personal,
            peer_device: peer_device.to_string(),
        }
    }
    pub fn with_kind(name: &str, kind: SpaceKind, peer_device: &str) -> Self {
        PermanentRequest {
            kind,
            ..PermanentRequest::personal(name, peer_device)
        }
    }
}

/// 标记的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarkOutcome {
    Marked(PairMark),
    /// 本来就标过（幂等 ⇒ ⛔ 不写第二笔）。
    AlreadyMarked(PairMark),
}

/// 解除的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReleaseOutcome {
    Released(PairMark),
    /// ⛔ 本来就没这条标记（如实报，⛔ 不当成功）。
    NotMarked,
}

/// 面板读数：⭐「N 条已融合（可撤销）」就取自这里。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SpaceView {
    pub name_key: String,
    /// 还没撤的那些融合（**只有这些**才显示可撤回）。
    pub undoable: Vec<MergeRecord>,
    /// 已永久标记的对方设备。
    pub permanent_peers: Vec<String>,
    /// 已撤的那些（留痕，⛔ 不删）。
    pub undone: Vec<MergeRecord>,
}

impl SpaceView {
    pub fn undoable_count(&self) -> usize {
        self.undoable.len()
    }
}

/// 失败（⭐ 一切"该拒"的都走这里，且**保证没写库**）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LedgerError {
    /// ⛔ 团队空间 / 未分类 —— 一个字节都不动。
    NotPersonal(SpaceKind),
    /// 账本里没有这个编号（或它不属于这一对 ⇒ 也按"没有"处理，⛔ 不越界撤）。
    NoSuchMerge(u64),
    /// 这一笔已经撤过了。
    AlreadyUndone(u64),
    /// 解除时没有那条标记。
    NotMarked,
    /// 存储层报错（读写失败的原话）。
    Store(String),
}

impl fmt::Display for LedgerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LedgerError::NotPersonal(k) => write!(
                f,
                "只限个人空间（这一档是 {}）⇒ 一个字节都不动",
                match k {
                    SpaceKind::Personal => "个人空间",
                    SpaceKind::Team => "团队空间",
                    SpaceKind::Unclassified => "未分类",
                }
            ),
            LedgerError::NoSuchMerge(id) => write!(f, "账本里没有这一次融合（#{id}）"),
            LedgerError::AlreadyUndone(id) => write!(f, "这一次已经撤过了（#{id}）"),
            LedgerError::NotMarked => write!(f, "没有「永久不分离」这条标记"),
            LedgerError::Store(e) => write!(f, "账本读写失败：{e}"),
        }
    }
}

impl std::error::Error for LedgerError {}

// ─────────────────────────── 可注入存储 ───────────────────────────

/// ⭐ 存储面**就这两个方法**（真接线＝在 `sync.rs` 里实现一次，存 [`LEDGER_KEY`] 那个 KV）。
pub trait LedgerStore {
    fn load(&self) -> Result<LedgerState, LedgerError>;
    fn save(&self, state: &LedgerState) -> Result<(), LedgerError>;
}

/// 内存实现（判据用；也可当接线前的预览）。
///
/// ⚠️ 它**额外记** `load_count` / `save_count` —— 反向判据靠这两个数证明
/// 「团队空间**连读都没读**、一个字节都没动」。
#[derive(Debug, Default)]
pub struct MemStore {
    state: RefCell<LedgerState>,
    loads: RefCell<usize>,
    saves: RefCell<usize>,
}

impl MemStore {
    pub fn new() -> Self {
        MemStore::default()
    }
    /// 用一份**现成**的账本起（判据里造"融合前"的样子）。
    pub fn with_state(state: LedgerState) -> Self {
        MemStore {
            state: RefCell::new(state),
            loads: RefCell::new(0),
            saves: RefCell::new(0),
        }
    }
    pub fn load_count(&self) -> usize {
        *self.loads.borrow()
    }
    pub fn save_count(&self) -> usize {
        *self.saves.borrow()
    }
    /// 账本的**逐字节**视图（判据用它证明"没动"）。
    pub fn state_text(&self) -> String {
        encode_state(&self.state.borrow())
    }
    pub fn peek(&self) -> LedgerState {
        self.state.borrow().clone()
    }
}

impl LedgerStore for MemStore {
    fn load(&self) -> Result<LedgerState, LedgerError> {
        *self.loads.borrow_mut() += 1;
        Ok(self.state.borrow().clone())
    }
    fn save(&self, state: &LedgerState) -> Result<(), LedgerError> {
        *self.saves.borrow_mut() += 1;
        *self.state.borrow_mut() = state.clone();
        Ok(())
    }
}

// ─────────────────────────── 纯逻辑（增／撤／标记／解除） ───────────────────────────

/// ⭐ 记一次融合（**先查类别** ⇒ 团队/未分类连 `load` 都不做）。
pub fn record_merge_at(
    store: &dyn LedgerStore,
    now_ms: i64,
    req: &MergeRequest,
) -> Result<MergeOutcome, LedgerError> {
    if !req.kind.merge_eligible() {
        return Err(LedgerError::NotPersonal(req.kind));
    }
    let mut st = store.load()?;
    let name_key = normalize_space_name(&req.name);
    let peer = req.peer_device.trim();

    // ⭐「永久不分离」⇒ 今后不再每次融合（⛔ 没写库）。
    if let Some(m) = st
        .marks
        .iter()
        .find(|m| m.name_key == name_key && m.peer_device == peer)
    {
        return Ok(MergeOutcome::SkippedPermanent(m.clone()));
    }

    // ⭐ 幂等：同一次接入重复调用 ⇒ 只记一笔。
    if let Some(key) = req.idem_key.as_deref() {
        if let Some(rec) = st.merges.iter().find(|r| {
            r.name_key == name_key
                && r.peer_device == peer
                && r.undone_at_ms.is_none()
                && r.idem_key.as_deref() == Some(key)
        }) {
            return Ok(MergeOutcome::SkippedDuplicate(rec.clone()));
        }
    }

    let rec = MergeRecord {
        id: st.next_id,
        at_ms: now_ms,
        name_key,
        name_display: req.name.clone(),
        peer_device: peer.to_string(),
        moved: req.moved.clone(),
        kept_before: req.kept_before,
        undone_at_ms: None,
        idem_key: req.idem_key.clone(),
    };
    st.next_id += 1;
    st.merges.push(rec.clone());
    store.save(&st)?;
    Ok(MergeOutcome::Recorded(rec))
}

/// ⭐ 撤销**这一次**融合 —— 只翻这一笔的标记，⛔ 不牵连任何别的融合。
pub fn undo_merge_at(
    store: &dyn LedgerStore,
    now_ms: i64,
    req: &UndoRequest,
) -> Result<UndoResult, LedgerError> {
    if !req.kind.merge_eligible() {
        return Err(LedgerError::NotPersonal(req.kind));
    }
    let mut st = store.load()?;
    let name_key = normalize_space_name(&req.name);
    let peer = req.peer_device.trim();

    // ⚠️ 编号 ＋ 这一对**都要对上**：⛔ 不许拿别台/别名的编号撤到这一格。
    let idx = st
        .merges
        .iter()
        .position(|r| {
            r.id == req.merge_id && r.name_key == name_key && r.peer_device == peer
        })
        .ok_or(LedgerError::NoSuchMerge(req.merge_id))?;

    if st.merges[idx].undone_at_ms.is_some() {
        return Err(LedgerError::AlreadyUndone(req.merge_id));
    }
    st.merges[idx].undone_at_ms = Some(now_ms);
    let removed = st.merges[idx].moved.clone();
    let kept = st.merges[idx].kept_before;
    // ⚠️ 别的融合**一笔都不动** —— 这里只数一数、不改它们。
    // ⚠️ 按**名**数（⛔ 不按"同一台"）：面板那句「N 条已融合（可撤销）」是**按空间**读的。
    let other_undoable = st
        .merges
        .iter()
        .filter(|r| r.id != req.merge_id && r.name_key == name_key && r.undone_at_ms.is_none())
        .count();
    store.save(&st)?;
    Ok(UndoResult {
        merge_id: req.merge_id,
        removed,
        kept,
        other_undoable,
    })
}

/// ⭐ 标记「永久不分离」（这一对今后不再每次融合）。
pub fn mark_permanent_at(
    store: &dyn LedgerStore,
    now_ms: i64,
    req: &PermanentRequest,
) -> Result<MarkOutcome, LedgerError> {
    if !req.kind.merge_eligible() {
        return Err(LedgerError::NotPersonal(req.kind));
    }
    let mut st = store.load()?;
    let name_key = normalize_space_name(&req.name);
    let peer = req.peer_device.trim().to_string();
    if let Some(m) = st
        .marks
        .iter()
        .find(|m| m.name_key == name_key && m.peer_device == peer)
    {
        return Ok(MarkOutcome::AlreadyMarked(m.clone())); // 幂等：⛔ 不写第二笔
    }
    let mark = PairMark {
        name_key,
        peer_device: peer,
        marked_at_ms: now_ms,
    };
    st.marks.push(mark.clone());
    store.save(&st)?;
    Ok(MarkOutcome::Marked(mark))
}

/// ⭐ **解除**「永久不分离」—— ⛔ 不许单向不可逆（解除后又能融）。
pub fn release_permanent_at(
    store: &dyn LedgerStore,
    _now_ms: i64,
    req: &PermanentRequest,
) -> Result<ReleaseOutcome, LedgerError> {
    if !req.kind.merge_eligible() {
        return Err(LedgerError::NotPersonal(req.kind));
    }
    let mut st = store.load()?;
    let name_key = normalize_space_name(&req.name);
    let peer = req.peer_device.trim();
    let before = st.marks.len();
    let mut removed: Option<PairMark> = None;
    st.marks.retain(|m| {
        let hit = m.name_key == name_key && m.peer_device == peer;
        if hit && removed.is_none() {
            removed = Some(m.clone());
        }
        !hit
    });
    if st.marks.len() == before {
        return Ok(ReleaseOutcome::NotMarked); // ⛔ 本来就没标 ⇒ 不当成功
    }
    store.save(&st)?;
    Ok(ReleaseOutcome::Released(removed.expect("retain 命中过")))
}

/// 某一格空间的读数（面板那句「N 条已融合（可撤销）」）。
pub fn view_at(store: &dyn LedgerStore, raw_name: &str) -> Result<SpaceView, LedgerError> {
    let st = store.load()?;
    let name_key = normalize_space_name(raw_name);
    let mut v = SpaceView {
        name_key: name_key.clone(),
        ..SpaceView::default()
    };
    for r in st.merges.iter().filter(|r| r.name_key == name_key) {
        if r.undone_at_ms.is_none() {
            v.undoable.push(r.clone());
        } else {
            v.undone.push(r.clone());
        }
    }
    v.permanent_peers = st
        .marks
        .iter()
        .filter(|m| m.name_key == name_key)
        .map(|m| m.peer_device.clone())
        .collect();
    Ok(v)
}

// ─────────────────────────── 一行接上的门面 ───────────────────────────

/// ⭐ 门面：`MergeLedger::new(&store).record(now, &req)?` —— 接线的**那一行**。
pub struct MergeLedger<'a> {
    store: &'a dyn LedgerStore,
}

impl<'a> MergeLedger<'a> {
    pub fn new(store: &'a dyn LedgerStore) -> Self {
        MergeLedger { store }
    }
    pub fn record(&self, now_ms: i64, req: &MergeRequest) -> Result<MergeOutcome, LedgerError> {
        record_merge_at(self.store, now_ms, req)
    }
    pub fn undo(&self, now_ms: i64, req: &UndoRequest) -> Result<UndoResult, LedgerError> {
        undo_merge_at(self.store, now_ms, req)
    }
    pub fn mark_permanent(
        &self,
        now_ms: i64,
        req: &PermanentRequest,
    ) -> Result<MarkOutcome, LedgerError> {
        mark_permanent_at(self.store, now_ms, req)
    }
    pub fn release_permanent(
        &self,
        now_ms: i64,
        req: &PermanentRequest,
    ) -> Result<ReleaseOutcome, LedgerError> {
        release_permanent_at(self.store, now_ms, req)
    }
    pub fn view(&self, raw_name: &str) -> Result<SpaceView, LedgerError> {
        view_at(self.store, raw_name)
    }
    /// 这一格里**还没撤**的那些（按融合时刻排序 ⇒ 面板从上到下就是融合顺序）。
    pub fn undoable(&self, raw_name: &str) -> Result<Vec<MergeRecord>, LedgerError> {
        let mut v = view_at(self.store, raw_name)?.undoable;
        v.sort_by_key(|r| (r.at_ms, r.id));
        Ok(v)
    }
}

// ─────────────────────────── ⭐ 身份闸（Q1–Q4；**第一档**） ───────────────────────────
//
// ⚠️ 这一节**只有形状与纯逻辑**：⛔ 今天**不接线**（判据主体在还没写的接线里 ⇒ 它天然属于接线那一轮）。
// 口径：owner 2026-10-10「现在修」＝ **让这道闸立起来**（⛔ 不是"今天就把账号身份打通"）。
//
// ⭐ **顺序**：**先取身份、再判名**（反过来会先花力气归一名字、最后才否决 ⇒ 白做，而且容易漏）。

/// ⭐ 「是不是**同一个人**」—— ⭐ **三态**，⛔ **不是 `bool`**。
///
/// ⚠️ 尺子（与"读不到 ≠ 读到 0"同一条）：`Unknown` 是**独立状态** ⇒ ⛔ 不许折叠成 `No`
/// （两条拒绝理由必须分得开：`RefuseUnknownIdentity` ／ `RefuseDifferentPerson`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SamePerson {
    /// 判得出来：**是**（带上凭什么 ⇒ 将来记进账本）。
    Yes(IdentityBasis),
    /// 判得出来：**不是**。
    No(IdentityBasis),
    /// ⭐ **判不出来**（今天最常见：没配对过／没有账号／读不到许可证）。
    Unknown(WhyUnknown),
}

/// ⭐ **凭什么**判成／判不成（⭐ 审计要能回答"为什么判成同一人"）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityBasis {
    /// ⭐ **第一档（今天就有）**：本机**显式信任过**那台（`mesh_paired_devices`）。
    /// ⚠️ 它是**设备级**、⛔ **不是"人"** ⇒ ⭐ **起步档，⛔ 不是终态**。
    PairedDevice,
    /// ⭐ 第二档（留位）：**账号** `user_id` —— ⚠️ 客户端**今天连自己的都没存**
    /// （`sync.rs:148`／`:1257` 写的是**空串**）⇒ 要先做"本机把 `user_id` 真存下来"那一步。
    Account(String),
    /// ⭐ 第三档（留位）：**许可证** —— ⚠️ 客户端**今天读不到**（代码面零命中）。
    License(String),
}

/// 判不出来的**原因**（⭐ 如实说，⛔ 不糊成一句"未知" —— 排障要看得出是哪一种）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WhyUnknown {
    /// ⛔ 没配对过（本机从没显式信任过那台）。
    NotPaired,
    /// ⛔ 没有账号（那条服务器会话不存在／没登录过）。
    NoAccount,
    /// ⛔ 读不到许可证。
    NoLicense,
    /// 查身份这一步本身**失败**了（⚠️ 与"查到了但是否"分得开）。
    LookupFailed(String),
}

/// ⭐ 融合的**唯一**闸门（**先身份、后名字**）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeGate {
    /// ⭐ Q3：同一人 ＋ 同名 ⇒ **才允许融**。
    Allow,
    /// ⭐ Q1：**判不出** ⇒ 不融（今天最常见的那一支）。
    RefuseUnknownIdentity,
    /// ⭐ Q2：判得出、但**不是同一人** ⇒ 不融。
    RefuseDifferentPerson,
    /// 同一人、但**名字不同** ⇒ 不融（按名融合的既有口径）。
    RefuseDifferentName,
}

/// ⭐⭐ **Q1–Q4 的唯一实现**（纯函数 ⇒ 判据够得着）。
///
/// ⚠️ **签名本身是 Q4 的第一道防线**：`identity` **必填** ⇒ ⛔ 调用方**没法**"只拿名字来问"
/// （想拿名字兜底就得先**编**一个身份出来 ⇒ 那是显式的、看得见的 ✗）。
pub fn merge_gate(identity: &SamePerson, same_name: bool) -> MergeGate {
    match identity {
        // ⭐ Q1：判不出 ⇒ 不融（⛔ 宁可更保守，也不猜）。
        SamePerson::Unknown(_) => MergeGate::RefuseUnknownIdentity,
        // ⭐ Q2：判得出但不是同一人 ⇒ 不融。
        SamePerson::No(_) => MergeGate::RefuseDifferentPerson,
        // ⭐ Q3：同一人才轮到"名字对不对"。
        SamePerson::Yes(_) => {
            if same_name {
                MergeGate::Allow
            } else {
                MergeGate::RefuseDifferentName
            }
        }
    }
}

/// ⭐ 身份**从哪来** —— **可注入**（接线时由 `mesh` 那条路实现：查 `mesh_paired_devices`）。
/// ⚠️ 返回**三态**（⛔ 不是 `Option<bool>`）：⭐ "查不到"与"查到且为否"**必须分得开**。
pub trait IdentityOracle {
    fn same_person(&self, peer_device: &str, space_name: &str) -> SamePerson;
}

/// ⭐ **第一档**实现（今天就能用）：**本机显式信任过那台 ⇒ 视为同一人**。
///
/// ⚠️ ⭐ **它有代价，⛔ 别只写"保守" —— 两种判错情形都写在这儿**：
/// 1. 那台**换了主人** ⇒ 仍被判成"同一人" ⇒ ⭐ **可能融错**；
/// 2. **同一个人**的两台设备**没配对过** ⇒ 判 `NotPaired` ⇒ ⭐ **不融**
///    （用户会觉得"我自己的两台怎么没合"）—— ⚠️ 而这是**对的默认值**：
///    ⭐ **少合 ＋ 可撤 ✓ ／ 多合 ＝ 不可逆** ✗。
///
/// ⚠️ 它**只是起步档**：账号／许可证那两档能覆盖它覆盖不了的情形（见 [`IdentityBasis`]）。
pub struct PairedDeviceOracle<'a> {
    /// 本机**认过**的设备（接线时＝`mesh_paired_devices.device_id` 那一列；⛔ 秘密那一列只存哈希，这里用不到）。
    pub paired_devices: &'a [String],
}

impl IdentityOracle for PairedDeviceOracle<'_> {
    fn same_person(&self, peer_device: &str, _space_name: &str) -> SamePerson {
        if self.paired_devices.iter().any(|d| d == peer_device) {
            SamePerson::Yes(IdentityBasis::PairedDevice)
        } else {
            // ⚠️ 是 `Unknown`，⛔ **不是** `No`：我们**判不出**"不同人"，只能判"无法认定"。
            SamePerson::Unknown(WhyUnknown::NotPaired)
        }
    }
}

// ─────────────────────────── 文本编解码（存那个 KV） ───────────────────────────

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => o.push_str("\\\\"),
            '\t' => o.push_str("\\t"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            ',' => o.push_str("\\c"),
            _ => o.push(c),
        }
    }
    o
}

fn unesc(s: &str) -> Result<String, String> {
    let mut o = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            o.push(c);
            continue;
        }
        match it.next() {
            Some('\\') => o.push('\\'),
            Some('t') => o.push('\t'),
            Some('n') => o.push('\n'),
            Some('r') => o.push('\r'),
            Some('c') => o.push(','),
            other => return Err(format!("转义不认识：\\{}", other.unwrap_or(' '))),
        }
    }
    Ok(o)
}

fn esc_list(items: &[String]) -> String {
    items
        .iter()
        .map(|s| esc(s))
        .collect::<Vec<_>>()
        .join(",")
}

fn unesc_list(s: &str) -> Result<Vec<String>, String> {
    if s.is_empty() {
        return Ok(Vec::new());
    }
    s.split(',').map(unesc).collect()
}

/// 账本 ⇒ 一个 KV 的文本（⚠️ 只有 `\n` 分行，⛔ 不依赖 serde）。
pub fn encode_state(st: &LedgerState) -> String {
    let mut out = String::new();
    out.push_str(FORMAT_VERSION);
    out.push('\n');
    out.push_str(&format!("next_id\t{}\n", st.next_id));
    for m in &st.merges {
        out.push_str(&format!(
            "M\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            m.id,
            m.at_ms,
            esc(&m.name_key),
            esc(&m.name_display),
            esc(&m.peer_device),
            m.kept_before,
            m.undone_at_ms.map(|v| v.to_string()).unwrap_or_default(),
            esc(m.idem_key.as_deref().unwrap_or("")),
            esc_list(&m.moved),
        ));
    }
    for p in &st.marks {
        out.push_str(&format!(
            "P\t{}\t{}\t{}\n",
            esc(&p.name_key),
            esc(&p.peer_device),
            p.marked_at_ms
        ));
    }
    out
}

/// KV 文本 ⇒ 账本（⚠️ 空串 = 还没有账本 ⇒ 空账 ✓；版本不认识 ⇒ 报错，⛔ 不猜）。
pub fn decode_state(raw: &str) -> Result<LedgerState, String> {
    let trimmed = raw.trim_end_matches(['\n', '\r']);
    if trimmed.is_empty() {
        return Ok(LedgerState::default());
    }
    let mut lines = trimmed.split('\n');
    let head = lines.next().unwrap_or_default().trim_end_matches('\r');
    if head != FORMAT_VERSION {
        return Err(format!("账本版本不认识：{head:?}（要 {FORMAT_VERSION}）"));
    }
    let mut st = LedgerState::default();
    for line in lines {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        match f.first().copied() {
            Some("next_id") => {
                let v = f.get(1).ok_or("next_id 缺值")?;
                st.next_id = v.parse().map_err(|e| format!("next_id 读不动：{e}"))?;
            }
            Some("M") => {
                if f.len() != 10 {
                    return Err(format!("M 行字段数不对：{}", f.len()));
                }
                st.merges.push(MergeRecord {
                    id: f[1].parse().map_err(|e| format!("M.id：{e}"))?,
                    at_ms: f[2].parse().map_err(|e| format!("M.at_ms：{e}"))?,
                    name_key: unesc(f[3])?,
                    name_display: unesc(f[4])?,
                    peer_device: unesc(f[5])?,
                    moved: unesc_list(f[9])?,
                    kept_before: f[6].parse().map_err(|e| format!("M.kept_before：{e}"))?,
                    undone_at_ms: if f[7].is_empty() {
                        None
                    } else {
                        Some(f[7].parse().map_err(|e| format!("M.undone：{e}"))?)
                    },
                    idem_key: {
                        let k = unesc(f[8])?;
                        if k.is_empty() {
                            None
                        } else {
                            Some(k)
                        }
                    },
                });
            }
            Some("P") => {
                if f.len() != 4 {
                    return Err(format!("P 行字段数不对：{}", f.len()));
                }
                st.marks.push(PairMark {
                    name_key: unesc(f[1])?,
                    peer_device: unesc(f[2])?,
                    marked_at_ms: f[3].parse().map_err(|e| format!("P.marked_at：{e}"))?,
                });
            }
            other => return Err(format!("账本里有不认识的行：{other:?}")),
        }
    }
    Ok(st)
}

// ─────────────────────────── 判据 ───────────────────────────
//
// ⚠️ 这个 `mod tests` **不依赖 crate 里任何东西** ⇒ 用 `rustc --test` 就能单独跑
//    （接线前也能先红后绿；接线后 `cargo test --lib mesh_merge_ledger::` 同样跑它）。

#[cfg(test)]
mod tests {
    use super::*;

    fn personal(name: &str, peer: &str) -> PermanentRequest {
        PermanentRequest::personal(name, peer)
    }

    /// ⭐ a) 融合 ⇒ 撤销 ⇒ **回到融合前**（本机原有那些**不许被动**）。
    #[test]
    fn a_merge_then_undo_returns_to_the_pre_merge_reading() {
        let store = MemStore::new();
        let l = MergeLedger::new(&store);

        // 融合前：本机已有 2 条（p1/p2），从平板并进来 t1/t2。
        let req = MergeRequest::personal("工作", "平板")
            .moved(["t1", "t2"])
            .kept(2);
        let id = match l.record(1_000, &req).expect("个人空间应当记下") {
            MergeOutcome::Recorded(r) => r.id,
            other => panic!("第一次融合应当 Recorded，实际 {other:?}"),
        };
        assert_eq!(l.view("工作").unwrap().undoable_count(), 1, "这时应显示「1 条已融合（可撤销）」");

        let out = l.undo(2_000, &UndoRequest::personal("工作", "平板", id)).expect("应当撤得动");
        assert_eq!(out.removed, vec!["t1", "t2"], "⭐ 撤销要动的就是当初并进来的那几行");
        assert_eq!(out.kept, 2, "⭐ 撤完的读数要对上「融合前」＝本机原有 2 条");
        assert_eq!(out.other_undoable, 0, "撤完这一格不该再有可撤的");
        assert!(
            l.view("工作").unwrap().undoable.is_empty(),
            "撤过的那些⛔ 不许再显示可撤回"
        );
        // ⭐ 撤完还能再融（⛔ 不是单向门）。
        assert!(
            matches!(l.record(3_000, &req).expect("撤完应当还能融"), MergeOutcome::Recorded(_)),
            "撤销之后必须还能再融一次"
        );
    }

    /// ⭐ b) **反向**：撤销**不许**动到另一次融合的结果。
    #[test]
    fn b_undo_never_touches_another_merge() {
        let store = MemStore::new();
        let l = MergeLedger::new(&store);
        let first = match l
            .record(1_000, &MergeRequest::personal("工作", "平板").moved(["t1"]).kept(2))
            .unwrap()
        {
            MergeOutcome::Recorded(r) => r.id,
            other => panic!("{other:?}"),
        };
        let second = match l
            .record(2_000, &MergeRequest::personal("工作", "手机").moved(["u1"]).kept(3))
            .unwrap()
        {
            MergeOutcome::Recorded(r) => r.id,
            other => panic!("{other:?}"),
        };
        assert_ne!(first, second);

        // 撤**只撤第二次**。
        let out = l
            .undo(3_000, &UndoRequest::personal("工作", "手机", second))
            .unwrap();
        assert_eq!(out.removed, vec!["u1"], "只许动这一次的行");
        assert!(
            !out.removed.contains(&"t1".to_string()),
            "⛔ 不许把另一次（平板那次）的行也撤掉"
        );
        assert_eq!(out.other_undoable, 1, "平板那一笔必须**原样留着**（它还该可撤）");

        // 反着再来一遍：撤第一次 ⇒ 只动 t1。
        let out1 = l
            .undo(4_000, &UndoRequest::personal("工作", "平板", first))
            .unwrap();
        assert_eq!(out1.removed, vec!["t1"]);
        assert_eq!(out1.other_undoable, 0);
        // ⚠️ 同一笔⛔ 不许撤两次。
        assert_eq!(
            l.undo(5_000, &UndoRequest::personal("工作", "平板", first)),
            Err(LedgerError::AlreadyUndone(first))
        );
    }

    /// ⭐ c) **反向**：团队空间（以及未分类）⛔ 不许被撤销／永久化 —— **一个字节都不动**。
    #[test]
    fn c_team_and_unclassified_are_never_touched() {
        let store = MemStore::new();
        let l = MergeLedger::new(&store);
        let before_text = store.state_text();
        let before_loads = store.load_count();
        let before_saves = store.save_count();

        for kind in [SpaceKind::Team, SpaceKind::Unclassified] {
            assert_eq!(
                l.record(1_000, &MergeRequest::with_kind("工作", kind, "平板")),
                Err(LedgerError::NotPersonal(kind)),
                "⛔ {kind:?} 不许被记进融合账本"
            );
            assert_eq!(
                l.undo(1_000, &UndoRequest::with_kind("工作", kind, "平板", 0)),
                Err(LedgerError::NotPersonal(kind))
            );
            assert_eq!(
                l.mark_permanent(1_000, &PermanentRequest::with_kind("工作", kind, "平板")),
                Err(LedgerError::NotPersonal(kind)),
                "⛔ {kind:?} 不许被永久化"
            );
            assert_eq!(
                l.release_permanent(1_000, &PermanentRequest::with_kind("工作", kind, "平板")),
                Err(LedgerError::NotPersonal(kind))
            );
        }

        assert_eq!(store.load_count(), before_loads, "⛔ 团队/未分类**连读都不该读**");
        assert_eq!(store.save_count(), before_saves, "⛔ 一次都不许写");
        assert_eq!(store.state_text(), before_text, "⛔ 逐字节都不许变");
        assert_eq!(
            SpaceKind::from_raw("team"),
            SpaceKind::Team,
            "kind 列的判定"
        );
        assert_eq!(SpaceKind::from_raw(""), SpaceKind::Unclassified);
        assert_eq!(SpaceKind::from_raw("personal"), SpaceKind::Personal);
    }

    /// ⭐ d) 「永久不分离」后**下一次同名不再重复融合** ＋ **解除后又能融**。
    #[test]
    fn d_permanent_stops_remerging_and_can_be_released() {
        let store = MemStore::new();
        let l = MergeLedger::new(&store);
        let req = MergeRequest::personal("工作", "平板").moved(["t1"]).kept(2);
        assert!(matches!(l.record(1_000, &req).unwrap(), MergeOutcome::Recorded(_)));
        let merges_before = store.peek().merges.len();

        // ⭐ 标记 ⇒ 今后不再每次融合。
        match l.mark_permanent(2_000, &personal("工作", "平板")).unwrap() {
            MarkOutcome::Marked(m) => {
                assert_eq!(m.name_key, normalize_space_name("工作"));
                assert_eq!(m.peer_device, "平板");
            }
            other => panic!("第一次标记应当 Marked，实际 {other:?}"),
        }
        let saves_after_mark = store.save_count();
        match l.record(3_000, &req).unwrap() {
            MergeOutcome::SkippedPermanent(m) => assert_eq!(m.peer_device, "平板"),
            other => panic!("⭐ 永久之后不该再融，实际 {other:?}"),
        }
        assert_eq!(store.peek().merges.len(), merges_before, "⛔ 不该多记一笔");
        assert_eq!(store.save_count(), saves_after_mark, "⛔ 跳过时不该写库");
        assert_eq!(
            l.view("工作").unwrap().permanent_peers,
            vec!["平板".to_string()],
            "读数要能看出「永久不分离」的是哪台"
        );
        // 幂等：重复标记⛔ 不写第二笔。
        assert!(matches!(
            l.mark_permanent(3_500, &personal("工作", "平板")).unwrap(),
            MarkOutcome::AlreadyMarked(_)
        ));

        // ⭐ 必须可解除（⛔ 不许单向不可逆）。
        assert!(matches!(
            l.release_permanent(4_000, &personal("工作", "平板")).unwrap(),
            ReleaseOutcome::Released(_)
        ));
        assert!(l.view("工作").unwrap().permanent_peers.is_empty());
        assert!(matches!(
            l.record(5_000, &req).expect("解除后应当又能融"),
            MergeOutcome::Recorded(_)
        ));
        assert_eq!(store.peek().merges.len(), merges_before + 1, "解除后融的是**新的一笔**");
        // ⛔ 没标过的解除如实报"没有"，⛔ 不当成功。
        assert_eq!(
            l.release_permanent(6_000, &personal("工作", "平板")).unwrap(),
            ReleaseOutcome::NotMarked
        );
    }

    /// ⭐ e)（额外）同一次接入重复调用 ⇒ 只记一笔（幂等）。
    #[test]
    fn e_same_reconnect_is_idempotent() {
        let store = MemStore::new();
        let l = MergeLedger::new(&store);
        let req = MergeRequest::personal("读书笔记", "平板")
            .moved(["t1"])
            .kept(1)
            .idem("reconnect-2026-10-10T09:00");
        assert!(matches!(l.record(1_000, &req).unwrap(), MergeOutcome::Recorded(_)));
        assert!(matches!(
            l.record(1_500, &req).unwrap(),
            MergeOutcome::SkippedDuplicate(_)
        ));
        assert_eq!(store.peek().merges.len(), 1, "⭐ 重复接入⛔ 不许记第二笔");
        assert_eq!(store.save_count(), 1, "⭐ 跳过时⛔ 不该写库");
        // 换一次接入（新的键）⇒ 这才是"又融了一次"。
        let again = req.clone().idem("reconnect-2026-10-10T10:00");
        assert!(matches!(l.record(2_000, &again).unwrap(), MergeOutcome::Recorded(_)));
        assert_eq!(store.peek().merges.len(), 2);
    }

    /// ⭐ f)（额外）**按名判等**：归一后同名才算同名；⛔ 归一不改用户写的名字。
    #[test]
    fn f_name_normalization_is_what_makes_by_name_real() {
        let a = normalize_space_name("工作");
        for variant in ["工作", "工作 ", " 工作", "工 作", "　工作　", "工作\u{200b}"] {
            assert_eq!(
                normalize_space_name(variant),
                if variant == "工 作" { "工 作".to_string() } else { a.clone() },
                "归一后应当同名：{variant:?}"
            );
        }
        assert_eq!(normalize_space_name("ＡＢＣ"), "abc", "全角＋大小写都归掉");
        assert_eq!(normalize_space_name("  A\t\tB  "), "a b", "内部空白折成一个半角空格");
        assert_eq!(normalize_space_name("工作"), "工作", "CJK 原样（不做简繁/异体）");

        // ⭐ 归一**只用于判等**：库里存的名字仍是用户写的那串。
        let store = MemStore::new();
        let l = MergeLedger::new(&store);
        match l
            .record(1_000, &MergeRequest::personal("　工作 ", "平板").moved(["t1"]).kept(0))
            .unwrap()
        {
            MergeOutcome::Recorded(r) => {
                assert_eq!(r.name_key, "工作");
                assert_eq!(r.name_display, "　工作 ", "⛔ 归一不许改写用户的名字");
            }
            other => panic!("{other:?}"),
        }
        // 名字写法不同、归一后同名 ⇒ 读数落在同一格。
        assert_eq!(l.undoable("工作").unwrap().len(), 1);
        assert_eq!(l.undoable("ＡＢＣ").unwrap().len(), 0, "不同名⛔ 不许串到同一格");
    }

    /// ⭐ i) **简繁不算同名**（owner 2026-10-10 拍定）—— ⛔ 不许自动融。
    ///
    /// ⚠️ 夹具必须挑**真的不一样**的那对字：
    /// 「工作」的繁体**就是**「工作」（这两个字简繁同形 ✗）⇒ ⚠️ **拿它当夹具是假判据**
    /// （谁加了简繁折叠它照样绿 ✗）⇒ 所以这里用「读书笔记」/「讀書筆記」。
    #[test]
    fn i_simplified_and_traditional_are_not_the_same_name() {
        let simp = normalize_space_name("读书笔记");
        let trad = normalize_space_name("讀書筆記");
        assert_ne!(simp, trad, "⭐ 简繁**不许**归到同一个 key（owner 拍：不算同名）");
        // ⚠️ 顺带钉住"那对同形字"的事实，免得下一个人又拿它当夹具：
        assert_eq!(
            normalize_space_name("工作"),
            normalize_space_name("工作"),
            "「工作」简繁同形 ⇒ 它**当不了**这条判据的夹具"
        );

        let store = MemStore::new();
        let l = MergeLedger::new(&store);
        // 简体那一格融了一次 …
        assert!(matches!(
            l.record(1_000, &MergeRequest::personal("读书笔记", "平板").moved(["t1"]).kept(1))
                .unwrap(),
            MergeOutcome::Recorded(_)
        ));
        // … ⛔ 繁体那一格**看不到**它（不融）。
        assert_eq!(
            l.undoable("讀書筆記").unwrap().len(),
            0,
            "⭐ 繁体名必须**看不到**简体名那一次融合（不许悄悄融在一起）"
        );
        assert_eq!(l.undoable("读书笔记").unwrap().len(), 1, "简体那一格自己记得住");
        // 繁体名下**另记一笔** ⇒ 两条各自独立（这正是"最安全"的样子）。
        let out = l
            .record(2_000, &MergeRequest::personal("讀書筆記", "平板").moved(["t2"]).kept(1))
            .unwrap();
        match out {
            MergeOutcome::Recorded(r) => assert_eq!(r.name_key, trad, "繁体那笔用繁体自己的 key"),
            other => panic!("繁体名下应当**另**记一笔，实际 {other:?}"),
        }
        assert_eq!(store.peek().merges.len(), 2, "⭐ 两个名字 ⇒ **两笔**（⛔ 不是一笔）");
        assert_eq!(l.undoable("读书笔记").unwrap().len(), 1);
        assert_eq!(l.undoable("讀書筆記").unwrap().len(), 1);
    }

    /// ⭐ g)（额外）账本**逐字节**存得下、读得回（KV 就一个值）。
    #[test]
    fn g_ledger_round_trips_through_the_text_codec() {
        let store = MemStore::new();
        let l = MergeLedger::new(&store);
        l.record(
            1_000,
            &MergeRequest::personal("工作\t带制表符,和逗号", "平板\n带换行")
                .moved(["t1,逗号", "t2\\反斜杠"])
                .kept(2)
                .idem("k,1"),
        )
        .unwrap();
        l.mark_permanent(1_500, &personal("工作\t带制表符,和逗号", "平板\n带换行"))
            .unwrap();
        let text = store.state_text();
        let back = decode_state(&text).expect("自己的编码必须读得回来");
        assert_eq!(back, store.peek(), "⭐ 编解码必须无损（含制表符/逗号/换行/反斜杠）");
        assert_eq!(encode_state(&back), text, "再编码一次应当逐字节相同");
        // 空串＝还没有账本；版本不认识⇒报错（⛔ 不猜）。
        assert_eq!(decode_state("").unwrap(), LedgerState::default());
        assert!(decode_state("v9\nnext_id\t0\n").is_err());
    }

    /// ⭐ h)（额外）**编号＋这一对都要对上**才许撤（⛔ 拿别台的编号撤不动）。
    #[test]
    fn h_undo_must_match_the_very_pair() {
        let store = MemStore::new();
        let l = MergeLedger::new(&store);
        let id = match l
            .record(1_000, &MergeRequest::personal("工作", "平板").moved(["t1"]).kept(2))
            .unwrap()
        {
            MergeOutcome::Recorded(r) => r.id,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            l.undo(2_000, &UndoRequest::personal("工作", "手机", id)),
            Err(LedgerError::NoSuchMerge(id)),
            "⛔ 别台的编号撤不动这一格"
        );
        assert_eq!(
            l.undo(2_000, &UndoRequest::personal("读书笔记", "平板", id)),
            Err(LedgerError::NoSuchMerge(id)),
            "⛔ 别名的编号也撤不动"
        );
        assert_eq!(store.save_count(), 1, "被拒的撤销⛔ 一次都不许写库");
    }

    // ── ⭐ 身份闸（Q1–Q4）的真值表 ─────────────────────────────────────────────

    /// ⭐ j) **Q1–Q4：6 组全跑** —— ⛔ **名字从来不是充分条件**（Q4 的机器形态）。
    #[test]
    fn j_identity_gate_truth_table_never_lets_the_name_decide() {
        let pairs = [
            (SamePerson::Yes(IdentityBasis::PairedDevice), true, MergeGate::Allow), // Q3
            (SamePerson::Yes(IdentityBasis::PairedDevice), false, MergeGate::RefuseDifferentName),
            (SamePerson::No(IdentityBasis::Account("bob".into())), true, MergeGate::RefuseDifferentPerson), // Q2
            (SamePerson::No(IdentityBasis::Account("bob".into())), false, MergeGate::RefuseDifferentPerson),
            (SamePerson::Unknown(WhyUnknown::NotPaired), true, MergeGate::RefuseUnknownIdentity), // Q1
            (SamePerson::Unknown(WhyUnknown::NotPaired), false, MergeGate::RefuseUnknownIdentity),
        ];
        for (id, same_name, want) in pairs {
            assert_eq!(merge_gate(&id, same_name), want, "身份 {id:?} ＋ 同名={same_name}");
        }
        // ⭐⭐ **反向断言（Q4）**：把"名字相同"当同一人 ⇒ 上面那张表就红。
        //    这里把它写成一条**只依赖身份**的断言：允许融 ⟺ 身份是 `Yes`（⛔ 与名字无关）。
        for id in [
            SamePerson::Yes(IdentityBasis::PairedDevice),
            SamePerson::No(IdentityBasis::Account("x".into())),
            SamePerson::Unknown(WhyUnknown::NotPaired),
        ] {
            assert_eq!(
                merge_gate(&id, true) == MergeGate::Allow,
                matches!(id, SamePerson::Yes(_)),
                "⭐ 允许融**只能**由身份决定：⛔ 名字相同不许兜底当同一人（Q4）"
            );
        }
    }

    /// ⭐ k) **"读不到" ≠ "读到否"** —— 两条拒绝理由**必须分得开**（谁把三态折成 bool ⇒ 红）。
    #[test]
    fn k_unknown_and_no_are_two_different_refusals() {
        let unknown = merge_gate(&SamePerson::Unknown(WhyUnknown::NotPaired), true);
        let no = merge_gate(&SamePerson::No(IdentityBasis::Account("bob".into())), true);
        assert_ne!(unknown, no, "⭐ 「判不出」与「判得出、但不是同一人」**不是一回事** ⇒ 理由不许合并");
        assert_eq!(unknown, MergeGate::RefuseUnknownIdentity);
        assert_eq!(no, MergeGate::RefuseDifferentPerson);
        // ⚠️ 三态也不是 Option<bool>：`Unknown` 带着**为什么**（如实说，⛔ 不糊成一句"未知"）。
        assert_ne!(
            SamePerson::Unknown(WhyUnknown::NotPaired),
            SamePerson::Unknown(WhyUnknown::LookupFailed("库读不了".into())),
            "⭐ 判不出的**原因**要能分开（排障要看得出是哪一种）"
        );
    }

    /// ⭐ l) **第一档**（今天就有）：本机显式信任过 ⇒ `Yes(PairedDevice)`；没配对过 ⇒ ⭐ **`Unknown(NotPaired)`**
    /// （⛔ 不是 `No` —— 我们**判不出**"不同人"，只能判"无法认定"）。
    #[test]
    fn l_paired_oracle_is_conservative_and_says_unknown_when_unpaired() {
        let paired = vec!["平板".to_string()];
        let oracle = PairedDeviceOracle { paired_devices: &paired };
        assert_eq!(
            oracle.same_person("平板", "工作"),
            SamePerson::Yes(IdentityBasis::PairedDevice)
        );
        assert_eq!(
            oracle.same_person("陌生设备", "工作"),
            SamePerson::Unknown(WhyUnknown::NotPaired),
            "⭐ 没配对过 ⇒ 判**不出**（⛔ 不是判「否」）⇒ Q1 不融 ✓"
        );
        // ⭐ 第一档非终态：即使**同名**，只要身份不是 Yes，闸门也不放行（Q1/Q2）。
        assert_ne!(
            merge_gate(&oracle.same_person("陌生设备", "工作"), true),
            MergeGate::Allow
        );
    }
}
