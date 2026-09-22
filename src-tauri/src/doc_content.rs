//! 「文档内容」那一层：**read / write / merge / derive**（阶段 0「接口收口」）。
//!
//! 上位文档：`docs/plans/2026-09-18-doc-content-layer-inventory.md`（API 草案在它 §3、边界规则在 §4）。
//!
//! **要做的事**：让 `content_json` / `content_text` 的直接访问**只经这一层**，
//! 将来换 CRDT（或做块级 LWW）时**只改这个文件**，调用方一行不改。
//!
//! ## v1 的纪律：**纯搬运，行为完全不变**
//!
//! 本文件里的 SQL 与分支顺序是从原处**逐字搬过来**的（`commands::save_page`、
//! `blocks::resolve_block` / `blocks::get_page_blocks`、`sync::apply_upsert`），
//! 只把"散落的直接访问"换成"一次调用"。
//! ⇒ **任何行为改动都必须另开一次提交**，并在提交信息里写清它是"顺手修的 bug"还是"收口的一部分"；
//! 混在一起之后，一旦回归就再也分不出是谁带来的。
//!
//! ## 门禁
//!
//! `scripts/check-doc-content-access.mjs` 把本文件列在豁免名单（`LAYER_FILES`）里：
//! 它是**允许**直接访问那两个字段的地方，其它文件的计数**只许减不许增**。
//! ⇒ 每搬进来一处，别处的白名单就**单调下降**一格。
//!
//! ## 还没搬的（诚实清单，别以为收口做完了）
//!
//! - **远端写路径**：`sync::apply_upsert` 的 `INSERT … ON CONFLICT` 仍写在 `sync.rs`
//!   （它要 `PageDetail` 的 11 个字段，值得单独一次提交；本轮只把它的**判定**搬了进来）；
//! - **`fetch_page` 的整行 SELECT**：它要 `cover/icon/kind/…`，属于"页面元数据"而不是"内容"，
//!   等元数据那一层有着落再说；
//! - **SQL 层的内联子查询**（如 `blocks::list_block_backlinks` 的 `(SELECT content_json …)`）：
//!   要在 SQL 里改，不是加一层函数能收的。

use rusqlite::{params, Connection, OptionalExtension};

/// 一页的**内容** —— 那一层的单位。
///
/// 为什么带 `title`：现有三个读调用方（`resolve_block` / `get_page_blocks` / `save_page` 的现状回读）
/// 都需要它，而它和内容在**同一行**；拆成两次查询会多一次 I/O，也多一个"读到两代数据"的窗口。
pub struct DocContent {
    pub title: String,
    pub json: String,
    pub text: String,
}

/// **唯一读出口**。页面不存在或已软删 ⇒ `Ok(None)`（**不**在这里报错：是"没有"还是"出错"由调用方决定）。
pub fn read(c: &Connection, page_id: &str) -> Result<Option<DocContent>, String> {
    c.query_row(
        "SELECT title, content_json, content_text FROM pages WHERE id = ?1 AND deleted_at IS NULL",
        params![page_id],
        |row| {
            Ok(DocContent {
                title: row.get(0)?,
                json: row.get(1)?,
                text: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// **唯一写入口**（本地保存那条路）。
///
/// `dirty = 1` 是**同步契约**的一部分，不是随手写的：`sync::apply_upsert` 的
/// "dirty 优先本地"就靠它保护"本地改了还没推"的内容。搬动时**必须**连它一起搬。
///
/// ⚠️ **版本快照**（`versions::snapshot_before_save`）**不在这里**：它是"版本历史策略"，
/// 不是"内容形态"。换 CRDT 后它的输入会变成 CRDT 快照，但**调用时机仍由 `save_page` 决定**。
///
/// ⚠️ 影响 0 行时**不在这里报错**（与搬运前逐字一致）：那意味着页面在读与写之间被删了，
/// 调用方随后的 `fetch_page` 会报"页面不存在"——同一个结果，不同的报错点，不为它改行为。
pub fn write(c: &Connection, page_id: &str, content: &DocContent, now: i64) -> Result<(), String> {
    c.execute(
        "UPDATE pages SET title = ?1, content_json = ?2, content_text = ?3, updated_at = ?4, dirty = 1 WHERE id = ?5",
        params![content.title, content.json, content.text, now, page_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// **正文文本的本地修复**（阶段 1 · "正文待重建"那条边界的收口）。
///
/// 什么时候需要它：合并 / 裁决产物是**服务端或本地拼出来**的，正文文本仍是页级胜方那一份
/// ⇒ 那一页的 FTS 会有一段时间"搜不到刚合并进来的字"，要等下一次保存才重建。
/// 修法（不用第二份派生实现）：**有编辑器的那一侧**（前端）在打开页面时按编辑器语义算一遍，
/// 与库里那份不同就用这个函数写回去 —— **只动正文文本**，① 不动 `content_json`、② **不动 `dirty`**。
///
/// ⚠️ 为什么 `dirty` 必须不动：这次修复不是"用户改了内容"，标脏会把它当成一笔本地编辑推上去
/// （正文文本确实会因此同步给别的设备，但那不是这一层的职责 —— 这里只修本地索引的输入）。
pub fn write_text(c: &Connection, page_id: &str, text: &str) -> Result<(), String> {
    c.execute(
        "UPDATE pages SET content_text = ?1 WHERE id = ?2",
        params![text, page_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// **正文文本的本地修复（带判据的那一个）**：拿库里那一份与算出来的比，**不同才写回**
/// （相同 ⇒ 一次写库都没有）。返回**是否修了**。
///
/// ⚠️ 比较放在**这一层**而不是调用方（前端编辑器插件）：那类界面文件读这一列会把收口门禁顶红。
/// ⚠️ **正文文本与 FTS 索引必须一起动**（macOS 2026-09-22）：只改列不改索引 ⇒ 那一页在搜索结果里
/// 仍是旧正文 —— 正是这次修复要消灭的东西，而且更隐蔽（列看着对、搜索不对）。
pub fn refresh_page_text_if_stale(c: &Connection, page_id: &str, derived: &str) -> Result<bool, String> {
    let Some(cur) = read(c, page_id)? else {
        return Ok(false);
    };
    if cur.text == derived {
        return Ok(false);
    }
    write_text(c, page_id, derived)?;
    derive_fts(c, page_id, &cur.title, derived)?;
    // ★ AMD 2026-09-22：自动修复**不是用户操作** ⇒ 不许完全静默（"我的库什么时候被改过"要查得到）。
    //   但也不许做成第二个冲突 UI：**不写 `page_conflicts`**（那是"要人裁决"的表，塞进去会让
    //   "未决数量"失去意义），只留一行日志（与 `[sync]` 那几条同一形态）。
    eprintln!("[doc-content] 正文修复：page={page_id}（打开页面时按编辑器语义重算，索引同步刷新）");
    Ok(true)
}

/// **派生**：内容变了之后，所有"从内容重建"的东西都从这里刷。
///
/// 今天是两块：FTS 索引（`search`）＋ 块图/反向链接（`blocks`）。
/// 纪律（文档 §4 规则 1）：**派生只能从这里出**，不许别处自己扫 `content_json` 建索引。
pub fn derive(c: &Connection, page_id: &str, content: &DocContent) -> Result<(), String> {
    derive_fts(c, page_id, &content.title, &content.text)?;
    crate::blocks::rebuild_block_graph(c, page_id, &content.json, &content.text)
}

/// 只刷 FTS —— **远端应用（`sync::apply_upsert`）今天只做这一步**，逐字搬运、不多做。
///
/// 收的是**三个借用参数**而不是 `&DocContent`：远端那条路径手上的字段本来就在
/// `PageDetail` 里，为调一次函数去 `clone` 一份可能很大的 `content_json` 不值当。
pub fn derive_fts(c: &Connection, page_id: &str, title: &str, text: &str) -> Result<(), String> {
    crate::search::sync_fts(c, page_id, title, text)
}

/// 本地侧用于**合并判定**的读数（`sync_seq` 与 `dirty`）。
pub struct LocalState {
    pub seq: i64,
    pub dirty: i64,
}

/// 读本地状态；页面不存在 ⇒ `Ok(None)`。
pub fn local_state(c: &Connection, page_id: &str) -> Result<Option<LocalState>, String> {
    c.query_row(
        "SELECT sync_seq, dirty FROM pages WHERE id = ?1",
        params![page_id],
        |row| {
            Ok(LocalState {
                seq: row.get(0)?,
                dirty: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// **远端写入口** —— 合并判定说 `TakeRemote` 之后，把远端那一行落库。
///
/// 与前端侧 `docContent.upsertRemoteContent` 是**同一条 SQL 的两份实现**
/// （列集不同：前端那份还带 `db_rule/icon/cover/...`，桌面这份只落内容与结构列 ——
/// 两侧 schema 本来就不同，**语义**必须一致：`sync_seq` 记远端的、`dirty` 硬写 0）。
///
/// ⚠️ **逐字搬运**自 `sync::apply_upsert`（2026-09-18 收口第三/四切片）：
/// 连 `deleted_at = NULL`（"远端 upsert 会把墓碑掀掉"）与"不写 `created_at`"这两条都照搬 ——
/// 它们不是风格，是同步语义。
/// ⚠️ **`dirty` 硬写 0** 与 `write` 硬写 1 是一对（远端应用 vs 本地改动）。
/// ⚠️ **派生不在本函数里**：调用方接着自己调 `derive_fts`（搬运前就是这样，不多做）。
///
/// 收的是 `&PageDetail`：远端那条路径手上的字段本来就在它里面，
/// 为调一次函数去拆散/克隆一份可能很大的 `content_json` 不值当。
pub fn upsert_remote(c: &Connection, page: &crate::models::PageDetail, sync_seq: i64) -> Result<(), String> {
    c.execute(
        "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at, sync_seq, dirty)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, 0)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           parent_id = excluded.parent_id,
           title = excluded.title,
           content_json = excluded.content_json,
           content_text = excluded.content_text,
           kind = excluded.kind,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at,
           deleted_at = NULL,
           sync_seq = excluded.sync_seq,
           dirty = 0",
        params![
            page.id,
            page.workspace_id,
            page.parent_id,
            page.title,
            page.content_json,
            page.content_text,
            page.kind,
            page.sort_order,
            page.created_at,
            page.updated_at,
            sync_seq,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 合并判定：**本地留还是远端覆盖**。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeDecision {
    KeepLocal,
    TakeRemote,
}

/// ★ **合并点** —— 整个收口的意义所在：只有这里知道"怎么合"。
///
/// 今天 = **页级 LWW + dirty 优先本地 + `seq` 权威**（逐字搬运自 `sync::apply_upsert` 的注释与分支）：
///
/// 1. 本地有**未推送**改动（`dirty != 0`）⇒ **留本地**（保护用户刚改的东西）；
/// 2. 本地已同步过**更靠后**的 `seq` ⇒ **留本地**（`seq` 是服务端单调序号，比设备时钟可靠）；
/// 3. 其余 ⇒ **远端覆盖本地**，并记下远端的 `seq`。
///
/// ⚠️ 阶段 1 把它换成**块级 LWW**、阶段 2/3 换成 **CRDT 合并** —— **只改这个函数**，调用方一行不改。
pub fn merge(local: Option<LocalState>, remote_seq: i64) -> MergeDecision {
    match local {
        Some(l) if l.dirty != 0 => MergeDecision::KeepLocal,
        Some(l) if l.seq > remote_seq => MergeDecision::KeepLocal,
        _ => MergeDecision::TakeRemote,
    }
}

// =====================================================================================
// 阶段 1 · **块级 LWW**（第一切片：纯函数）
//
// 裁定（2026-09-20，所有者）与逐块判定表：`docs/plans/2026-09-19-stage1-block-lww-readiness.md`
// §6「裁定」/§7「实现口径」。三条定死的：**(a)** `blockRev` 是**声明的节点属性**（Lamport 计数器、
// 随 `content_json` 走）；**(iii)** 缺 `blockRev` 或 rev 相等而内容不同 ⇒ **冲突、不静默选边**；
// rev **不参与同步**（不新开协议字段、不加数据库列、不做全局定序）。
//
// 本切片**只做纯函数**：不碰 SQL、不碰协议、不碰 UI（见 §7 最后一段）。
//
// ## 调用顺序（④ 页级语义不许被块级推翻）
//
// 先 `merge`（页级：`dirty` 优先本地）——它说 `KeepLocal` 时**不许**用块级结果覆盖本地；
// 说 `TakeRemote` 时才逐块比对，把"本地那一块其实更新"的块留下来。这条合成规则就写在
// `merge_page_and_blocks` 里（**唯一入口**，免得两处各写一遍顺序）。
//
// ## 已知边界（**写下来，别当成漏了**）
//
// 1. **没有块级删除 / 墓碑**：某块只在一侧存在时按"保留"处理（`OnlyLocal` / `OnlyRemote`）。
//    今天页级 LWW 会让它整页消失，块级合并下它**会留下** —— 这是本片**故意的**选择（内容不许
//    静默丢），块级删除语义留到有墓碑（或 CRDT）那一刀；判据把它钉住，见
//    `block_only_on_one_side_is_kept`。
// 2. **顺序 / 移动不参与合并**：顺序取页级胜方那一侧，另一侧多出来的块**按它自己的顺序追加在表尾**。
//    这是回复信（`2026-09-19-stage1-block-lww-readiness.reply-1` §二）明确要求钉住的那条边界，
//    判据见 `order_comes_from_the_page_level_winner_and_extras_are_appended`。
// 3. **`rev` 只是本机视角的过渡量**：不许进 FTS / 反链 / 导出 / 版本历史，也不许当"最后修改时间"用
//    （§7 最后一段）。到了 C 由 Yjs 的 clock 取代。
// =====================================================================================

/// 一份「块表」里的一行：块的 id、它的 `blockRev`（Lamport 计数器）、该块的 JSON 片段。
///
/// `rev: None` = **老客户端产物**（它不认识这个字段，保存时会被剥掉）⇒ 裁定 (iii)：**不静默判**。
///
/// ⚠️ **`json` 里不含 `blockRev` 字段**（rev 单独放在上面那个字段里）—— 这不是洁癖：
/// 判定表的第一行是"两侧内容**逐字节相同** ⇒ 不提示"，而老客户端"打开—原样保存"**恰恰会剥掉
/// `blockRev`**。若把 rev 算进被比较的片段，那一行就**永远不成立** ⇒ 每次同步都提示 ⇒ 噪声 ⇒
/// 用户学会忽略 ⇒ 等于静默（反判据第二条要拦的正是这个）。去 rev 的动作由**调用方**在提取块表时做。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockSnapshot {
    pub block_id: String,
    pub rev: Option<i64>,
    pub json: String,
}

impl BlockSnapshot {
    pub fn new(block_id: &str, rev: Option<i64>, json: &str) -> Self {
        BlockSnapshot {
            block_id: block_id.to_string(),
            rev,
            json: json.to_string(),
        }
    }
}

/// 这一块**是怎么定的** —— 输出里的每一项都带它，调用方不需要自己再推一遍。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockChoice {
    /// `remote.rev < local.rev` ⇒ 留本地那一块（本地有远端没见过的编辑）
    Local,
    /// `remote.rev > local.rev` ⇒ 用远端那一块
    Remote,
    /// 两侧内容**逐字节相同** ⇒ 无事（写哪一版都一样，**不许提示**）
    Identical,
    /// 只有本地有这一块（本片不做块级删除 ⇒ 保留）
    OnlyLocal,
    /// 只有远端有这一块
    OnlyRemote,
    /// **判不了** ⇒ 不自动选边（裁定 (iii)）
    Conflict(ConflictReason),
}

impl BlockChoice {
    /// 这一项是不是"要用户裁决" —— 调用方用它决定要不要提示。
    pub fn is_conflict(&self) -> bool {
        matches!(self, BlockChoice::Conflict(_))
    }
}

/// 为什么不自动选边（判定表里那两行"冲突"）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictReason {
    /// `rev` 相等但内容不同 —— 并发同改同一块（两侧都从同一 base 加一 ⇒ 编号必然相等）
    SameRevDifferentContent,
    /// 任一侧缺 `blockRev` —— 老客户端产物（字段被 `exportJSON` 剥掉）
    MissingRev,
}

/// 合并结果里的一块。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergedBlock {
    pub block_id: String,
    pub choice: BlockChoice,
    /// 该块的 JSON 片段。⚠️ `choice` 是 `Conflict` 时它是**本地现状占位**（本地没有则远端那一版），
    /// **不是**裁决结果 —— 见 `BlockMergeOutcome` 的注释。
    pub json: String,
    /// 选中那一版的 `blockRev`（`None` = 两侧都没有这个字段）。
    ///
    /// ⚠️ 物化回落盘 JSON 时**必须写回去**：漏了它，合并产物就把 rev 丢了 ⇒ 下一次合并会把这一页
    /// 误判成"老客户端产物"（每次同步都提示）。
    pub rev: Option<i64>,
}

/// 一块冲突：两侧各自的版本都带出来，调用方/UI 才有得"取回"。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockConflict {
    pub block_id: String,
    pub reason: ConflictReason,
    pub local_json: Option<String>,
    pub remote_json: Option<String>,
}

/// 逐块合并的结果。
///
/// ⚠️ **`conflicts` 非空 = 这次合并没有完全自动完成**：`blocks` 里对应的那一项 `choice` 是
/// `Conflict(...)`、`json` 只是**现状占位**。调用方**不许**在没有提示、也没拿到用户裁决的情况下
/// 把它直接当结果写回（"冲突不许静默丢"那条不变量）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockMergeOutcome {
    pub blocks: Vec<MergedBlock>,
    pub conflicts: Vec<BlockConflict>,
}

impl BlockMergeOutcome {
    /// 这一页有没有需要用户裁决的块。
    pub fn has_conflicts(&self) -> bool {
        !self.conflicts.is_empty()
    }
}

/// ★ **块级合并点**（纯函数）：两份块表 + 页级判定 ⇒ 逐块选边。
///
/// 判定（与 §7 那张表逐行对应，**顺序有意义**）：
///
/// | 情形 | 判定 |
/// |---|---|
/// | 两侧内容**逐字节相同** | `Identical`（**先判它**：老客户端"打开—原样保存"会剥掉 `rev` 而内容未变，那次**不许**提示） |
/// | `remote.rev > local.rev` | `Remote` |
/// | `remote.rev < local.rev` | `Local` |
/// | `rev` 相等、内容不同 | `Conflict(SameRevDifferentContent)` |
/// | 任一侧缺 `rev` | `Conflict(MissingRev)` |
/// | 只有一侧有这一块 | `OnlyLocal` / `OnlyRemote`（本片不做块级删除） |
///
/// ⚠️ `Identical` 那一行**也要带 rev**，且取两侧**较大**的那个：判据
/// `identical_content_with_divergent_revs_converges_to_max` 钉的就是这条（取较小的那个会让本地基线
/// 落后于远端已见过的编号 ⇒ 本地随后的编辑静默输给远端更旧的编辑）。
pub fn merge_blocks(
    local: &[BlockSnapshot],
    remote: &[BlockSnapshot],
    page_level: MergeDecision,
) -> BlockMergeOutcome {
    use std::collections::HashMap;

    let lmap: HashMap<&str, &BlockSnapshot> =
        local.iter().map(|b| (b.block_id.as_str(), b)).collect();
    let rmap: HashMap<&str, &BlockSnapshot> =
        remote.iter().map(|b| (b.block_id.as_str(), b)).collect();

    // 顺序：页级胜方那一侧的顺序，另一侧多出来的块按它自己的顺序**追加在表尾**（已知边界 2）。
    // 同一 id 在一侧出现两次时**取第一次**（原顺序里先出现的那一份）。
    let (first, rest) = match page_level {
        MergeDecision::KeepLocal => (local, remote),
        MergeDecision::TakeRemote => (remote, local),
    };
    let mut order: Vec<&str> = Vec::with_capacity(first.len() + rest.len());
    for b in first.iter().chain(rest.iter()) {
        if !order.contains(&b.block_id.as_str()) {
            order.push(b.block_id.as_str());
        }
    }

    let mut blocks = Vec::with_capacity(order.len());
    let mut conflicts = Vec::new();

    for id in order {
        let l = lmap.get(id).copied();
        let r = rmap.get(id).copied();

        let (choice, json, rev) = match (l, r) {
            // 两侧都有：先看内容是不是**逐字节相同**（含"老客户端剥了 rev 但内容没变"那条）
            (Some(l), Some(r)) if l.json == r.json => {
                // ★ rev 取**两侧较大的那个**（不是"本地优先"）：内容逐字相同 ≠ 两边一样新。
                //   老写法 `l.rev.or(r.rev)` 会把本地那个更旧的 rev 留下 ⇒ 本地下一次编辑从这个更低的
                //   基线加一 ⇒ 编号**追不上**远端已经有的那笔编辑 ⇒ 远端那笔更新的编辑会在随后一次合并里
                //   **静默赢过**本地这笔（丢更新）。取 max：本地基线跟着抬上去 ⇒ 真并发时落进
                //   "同 rev 不同内容" ⇒ 提示，而不是静默。
                //   ⚠️ 不为此把行标脏：内容逐字相同 ⇒ 没有可推的信息（rev 不参与同步，见 §6）；
                //   标脏反而凭空多出一笔"本地改动"，把 `dirty`-优先本地那条推开。
                (BlockChoice::Identical, l.json.clone(), l.rev.max(r.rev))
            }
            (Some(l), Some(r)) => match (l.rev, r.rev) {
                (Some(lr), Some(rr)) if rr > lr => (BlockChoice::Remote, r.json.clone(), Some(rr)),
                (Some(lr), Some(rr)) if rr < lr => (BlockChoice::Local, l.json.clone(), Some(lr)),
                (Some(lr), Some(_)) => (
                    BlockChoice::Conflict(ConflictReason::SameRevDifferentContent),
                    l.json.clone(),
                    Some(lr),
                ),
                // 任一侧缺 rev（老客户端产物）⇒ 判不了就不判
                _ => (
                    BlockChoice::Conflict(ConflictReason::MissingRev),
                    l.json.clone(),
                    l.rev.or(r.rev),
                ),
            },
            (Some(l), None) => (BlockChoice::OnlyLocal, l.json.clone(), l.rev),
            (None, Some(r)) => (BlockChoice::OnlyRemote, r.json.clone(), r.rev),
            // order 是从两侧 id 的并集来的 ⇒ 这一支不可达
            (None, None) => continue,
        };

        if let BlockChoice::Conflict(reason) = choice {
            conflicts.push(BlockConflict {
                block_id: id.to_string(),
                reason,
                local_json: l.map(|b| b.json.clone()),
                remote_json: r.map(|b| b.json.clone()),
            });
        }

        blocks.push(MergedBlock { block_id: id.to_string(), choice, json, rev });
    }

    BlockMergeOutcome { blocks, conflicts }
}

/// 阶段 1 的**合成入口**：先页级（`dirty` 优先本地），再逐块。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageMerge {
    /// 页级判定说留本地（`dirty != 0` 或本地 `seq` 更靠后）⇒ **整页都不动**。
    /// ⚠️ 这一支**不许**再走块级合并：④ 页级语义不被块级推翻。
    KeepLocal,
    /// 页级说用远端 ⇒ 逐块比对后的结果（可能仍有 `conflicts` 要提示）。
    Merged(BlockMergeOutcome),
}

/// ★ 阶段 1 合并的**唯一调用顺序**（免得调用方各写一遍、写岔）。
pub fn merge_page_and_blocks(
    local_state: Option<LocalState>,
    remote_seq: i64,
    local_blocks: &[BlockSnapshot],
    remote_blocks: &[BlockSnapshot],
) -> PageMerge {
    let page_level = merge(local_state, remote_seq);
    if page_level == MergeDecision::KeepLocal {
        return PageMerge::KeepLocal;
    }
    PageMerge::Merged(merge_blocks(local_blocks, remote_blocks, page_level))
}

// =====================================================================================
// 阶段 1 **接线用的适配器**：落盘 JSON ⇄ 块表（纯函数，不碰编辑器、不碰 SQL）
//
// 与前端 `src/lib/docContent.ts` 的同名三个函数**逐条对应**（改一边必须看另一边）。
// 判定（`merge_blocks`）只认"块表"，而线上两份东西都是**整页 JSON** ⇒ 中间要一层拆/装。
// 三条保守规则（宁可回落今天的行为，也不猜）：
//   ① 解析不出来 / 没有 root / children 不是数组 ⇒ 不合并；
//   ② **只要有任何一个顶层块没有非空 `blockId`** ⇒ 不合并（老内容还没补种身份）；
//   ③ 拆出来的片段走 `block_rev::canonical_content`（**去 `blockRev` ＋ 键排序**）——
//      判定比的是"逐字节相同"，而**键序不是内容**（见 block_rev 文件头口径 3）。
// =====================================================================================

/// 解析成文档对象（要有 `root` 且是对象）；否则 `None`（适配器据此回落，不合并）。
fn parse_doc(doc_json: &str) -> Option<serde_json::Value> {
    let parsed: serde_json::Value = serde_json::from_str(doc_json).ok()?;
    if !parsed.is_object() {
        return None;
    }
    match parsed.get("root") {
        Some(root) if root.is_object() => Some(parsed),
        _ => None,
    }
}

/// 把一份文档拆成**块表**（顶层块的 `(blockId, rev, 内容片段)`）。任一保守规则不满足 ⇒ `None`。
pub fn block_snapshots(doc_json: &str) -> Option<Vec<BlockSnapshot>> {
    let doc = parse_doc(doc_json)?;
    let children = doc.get("root")?.get("children")?.as_array()?;
    let mut out = Vec::with_capacity(children.len());
    for child in children {
        if !child.is_object() {
            return None;
        }
        let block_id = child.get("blockId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        if block_id.is_empty() {
            return None; // 规则 ②
        }
        out.push(BlockSnapshot {
            block_id,
            rev: crate::block_rev::block_rev_of(child),
            json: crate::block_rev::canonical_content(child), // 规则 ③
        });
    }
    Some(out)
}

/// 把块表（合并结果）装回一份落盘 JSON：`children` 换掉，根上其它字段照旧。
///
/// ⚠️ 每一块都把 `rev` **写回** `blockRev` 字段 —— 漏了它，下一次合并会把这页误判成"老客户端产物"。
pub fn apply_block_snapshots(doc_json: &str, blocks: &[MergedBlock]) -> Option<String> {
    let mut doc: serde_json::Value = serde_json::from_str(doc_json).ok()?;
    if !doc.is_object() || !doc.get("root").map(|r| r.is_object()).unwrap_or(false) {
        return None;
    }
    let mut children: Vec<serde_json::Value> = Vec::with_capacity(blocks.len());
    for b in blocks {
        let mut node: serde_json::Value = serde_json::from_str(&b.json).ok()?;
        if let (Some(rev), Some(obj)) = (b.rev, node.as_object_mut()) {
            obj.insert("blockRev".to_string(), serde_json::json!(rev));
        }
        children.push(node);
    }
    doc.get_mut("root")?.as_object_mut()?.insert("children".to_string(), serde_json::Value::Array(children));
    Some(doc.to_string())
}

/// 远端合并的三种结果。
///
/// **别再用 `Option`**：调用方要区分"没什么可合"（老内容 / 脏 JSON）与"**有冲突要留痕**"
/// —— 后者必须落表（裁定 (iii)：不静默选边），否则就是"静默"。
/// **以前用 `Option` / `undefined` 一个值表示两件事 —— 那正是『静默』的来源**（AMD 要求把这句话写在这里）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteMerge {
    /// 不合并（老内容 / 脏 JSON）⇒ 用远端原样（与接线前**逐字相同**）
    NotApplicable,
    /// **有冲突** ⇒ 不自动选边：用远端原样（页级 LWW），但冲突**要落表**
    Conflicted(Vec<BlockConflict>),
    /// 合并成功（两端各改不同块 ⇒ 两边的编辑都在）
    Merged(String),
}

/// ★ **阶段 1 的远端合并**（页级说"用远端"之后调它）：与本地现状逐块比一遍。
///
/// ⚠️ **已知边界**：`content_text` 仍是页级胜方那一份，可能与合并后的 JSON 不一致
/// （派生文本要编辑器语义，不能在同步路径里现算）—— 见前端同名函数的注释。
pub fn merge_remote_content(local_json: &str, remote_json: &str) -> RemoteMerge {
    let (Some(local_blocks), Some(remote_blocks)) = (block_snapshots(local_json), block_snapshots(remote_json))
    else {
        return RemoteMerge::NotApplicable;
    };

    let outcome = merge_blocks(&local_blocks, &remote_blocks, MergeDecision::TakeRemote);
    if outcome.has_conflicts() {
        // 裁定 (iii)：不静默选边 ⇒ 这一版**回落页级 LWW**（与接线前逐字相同），
        // 但把冲突**交回去**让调用方留痕（提示 UI 的数据）。
        return RemoteMerge::Conflicted(outcome.conflicts);
    }

    match apply_block_snapshots(remote_json, &outcome.blocks) {
        Some(json) => RemoteMerge::Merged(json),
        None => RemoteMerge::NotApplicable,
    }
}

/// 把一份文档里某个**顶层块**的内容换成另一个（裁决入口用）。块不在这份文档里 ⇒ `None`。
pub fn replace_block_content(doc_json: &str, block_id: &str, block_json: &str) -> Option<String> {
    let mut doc: serde_json::Value = serde_json::from_str(doc_json).ok()?;
    if !doc.is_object() {
        return None;
    }
    let replacement: serde_json::Value = serde_json::from_str(block_json).ok()?;
    let children = doc.pointer_mut("/root/children")?.as_array_mut()?;
    let mut hit = false;
    for child in children.iter_mut() {
        if child.get("blockId").and_then(|v| v.as_str()) == Some(block_id) {
            *child = replacement.clone();
            hit = true;
            break;
        }
    }
    if !hit {
        return None;
    }
    Some(doc.to_string())
}

/// 一处冲突（表 `page_conflicts` 的一行；`resolved_at` 为空 = **未裁决**）。
///
/// `Serialize` 是给命令面用的（`list_page_conflicts` 直接把它交给前端；字段名按 snake_case 出去，
/// Web 侧的同名命令**对齐同一套字段名**）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PageConflict {
    pub id: String,
    pub page_id: String,
    pub block_id: String,
    pub reason: String,
    pub local_json: String,
    pub remote_json: String,
    pub detected_at: i64,
    pub resolved_at: Option<i64>,
    pub resolved_choice: Option<String>,
}

/// 裁决时选哪一侧。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictChoice {
    Local,
    Remote,
}

fn conflict_reason_str(reason: ConflictReason) -> &'static str {
    match reason {
        ConflictReason::SameRevDifferentContent => "same-rev-different-content",
        ConflictReason::MissingRev => "missing-rev",
    }
}

fn conflict_choice_str(choice: ConflictChoice) -> &'static str {
    match choice {
        ConflictChoice::Local => "local",
        ConflictChoice::Remote => "remote",
    }
}

/// 把这次合并报出的冲突**落表**（同一页同一块已有未决记录 ⇒ 先删旧的那条，避免堆积）。
///
/// ⚠️ **这张表是"本机证据"，不能用来解释跨机器的差异**（AMD 2026-09-22 要求写进注释）：它记的是
/// "这一轮远端应用时**本机**看到的两版" —— 别的设备上可能根本没有这一行，服务端也没有这张表。
/// ⚠️ **"留痕 ≠ 已裁决"**：`resolved_at` 为空的那些行是**未决**，调用方/界面**不许**把它读成"已处理"。
/// 今天"只有 `resolved_at` 被写上才会从'未决'里消失"这条由判据
/// `only_a_real_resolution_changes_the_unresolved_count` 守着。
pub fn record_page_conflicts(
    c: &Connection,
    page_id: &str,
    conflicts: &[BlockConflict],
) -> Result<(), String> {
    let now = crate::db::now_ms();
    for cf in conflicts {
        c.execute(
            "DELETE FROM page_conflicts WHERE page_id = ?1 AND block_id = ?2 AND resolved_at IS NULL",
            params![page_id, cf.block_id],
        )
        .map_err(|e| e.to_string())?;
        c.execute(
            "INSERT INTO page_conflicts
               (id, page_id, block_id, reason, local_json, remote_json, detected_at, resolved_at, resolved_choice)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL)",
            params![
                uuid::Uuid::new_v4().to_string(),
                page_id,
                cf.block_id,
                conflict_reason_str(cf.reason),
                cf.local_json.clone().unwrap_or_default(),
                cf.remote_json.clone().unwrap_or_default(),
                now,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 这一页**未裁决**的冲突（按发现时间；提示 UI 就用它）。
pub fn unresolved_page_conflicts(c: &Connection, page_id: &str) -> Result<Vec<PageConflict>, String> {
    let mut stmt = c
        .prepare(
            "SELECT id, page_id, block_id, reason, local_json, remote_json, detected_at, resolved_at, resolved_choice
             FROM page_conflicts WHERE page_id = ?1 AND resolved_at IS NULL ORDER BY detected_at, block_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![page_id], |row| {
            Ok(PageConflict {
                id: row.get(0)?,
                page_id: row.get(1)?,
                block_id: row.get(2)?,
                reason: row.get(3)?,
                local_json: row.get(4)?,
                remote_json: row.get(5)?,
                detected_at: row.get(6)?,
                resolved_at: row.get(7)?,
                resolved_choice: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// ★ **裁决一处冲突**：把选中的那一版写回该块、**盖新 rev**（baseline = 当前页）、落库并标记已决。
///
/// `write` 会置 `dirty = 1` ⇒ 这次裁决本身是**一笔本地编辑**，会被推上去（"留本地"就是这么生效的）。
///
/// ⚠️ 与合并路径同一条已知边界：正文文本这一次**不重算**（派生文本要编辑器语义）——
/// 下一次保存/编辑会重建。
pub fn resolve_page_conflict(
    c: &Connection,
    conflict_id: &str,
    choice: ConflictChoice,
) -> Result<(), String> {
    let (page_id, block_id, local_json, remote_json): (String, String, String, String) = c
        .query_row(
            "SELECT page_id, block_id, local_json, remote_json FROM page_conflicts
             WHERE id = ?1 AND resolved_at IS NULL",
            params![conflict_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "冲突不存在或已裁决".to_string())?;

    let page = read(c, &page_id)?.ok_or_else(|| "页面不存在".to_string())?;
    let chosen = match choice {
        ConflictChoice::Local => local_json,
        ConflictChoice::Remote => remote_json,
    };
    let next = replace_block_content(&page.json, &block_id, &chosen)
        .ok_or_else(|| "这一块已不在页面里（页面在裁决前又变过）".to_string())?;
    let stamped = crate::block_rev::assign_block_revs(&page.json, &next);
    let content = DocContent { title: page.title, json: stamped, text: page.text };
    let now = crate::db::now_ms();
    write(c, &page_id, &content, now)?;
    derive(c, &page_id, &content)?;
    c.execute(
        "UPDATE page_conflicts SET resolved_at = ?1, resolved_choice = ?2 WHERE id = ?3",
        params![now, conflict_choice_str(choice), conflict_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// ★ **保存路径的 rev 盖章**（阶段 1 接线的入口之一）：拿"上一版"（库里这一页）与这一版比一遍，
/// 返回**要落库**的 JSON。
///
/// 桌面保存（`commands::save_page`）调它；Web 侧同一份语义在 `platform/web.ts::save_page`
/// （那侧直接调 `assignBlockRevs`，因为它手上已经有同一行的读出口）。
///
/// ⚠️ 顺序：**先盖章，再落库/进版本历史** —— 版本历史里存的应当是"用户真正保存的那一版"（含 rev）。
/// ⚠️ 不盖章的后果：块级判定（`sync::apply_upsert` 里那次 `merge_remote_content`）会因为没有 rev
/// 而**每一页都回落**到页级 LWW —— 接线就等于白接。
pub fn stamp_block_revs(c: &Connection, page_id: &str, next_json: &str) -> Result<String, String> {
    let prev = read(c, page_id)?.map(|d| d.json).unwrap_or_default();
    Ok(crate::block_rev::assign_block_revs(&prev, next_json))
}

/// ★★ **阶段 1 的远端落库入口**（唯一）：页级说"用远端"之后，调用方只调这一个。
///
/// 内部按顺序做（顺序就是裁定 ④ 要求的那条：**页级优先，块级只在其后**）：
///   1. 读**本地现状**（读出口 `read`）；
///   2. 试一次逐块合并（`merge_remote_content`）；
///   3. 按结果落库：`Merged` ⇒ 用合并产物；`Conflicted` ⇒ **先落冲突表**、再用远端原样
///      （页级 LWW，与接线前**逐字相同** —— 这一片只是把"静默"变成"有痕"，**不改覆盖语义**）；
///      `NotApplicable` ⇒ 用远端原样。
///
/// ⚠️ 为什么把这几步收在一层里（而不是让 `sync.rs` 自己拼）：`sync.rs` 是**受收口门禁约束**的文件
/// （那两个字段的计数只许减不许增），把"读远端那一版 / 写回合并产物"留在那一层之外做，
/// `check-doc-content-access` 会当场红。
///
/// ★ **返回值就是"这次到底发生了什么"**（AMD 2026-09-22 的要求："留痕 ≠ 已裁决" ⇒ 调用方必须能看见
/// "有未裁决冲突"这件事，**哪怕只是个计数**）：`sync.rs` 拿 `Conflicted(..)` 的条数去推一个页面级计数，
/// 与页级 dirty 提示分开报（两者含义不同，别合成一个值 —— 那正是"静默"的另一种长相）。
///
/// ⚠️ **正文那一列的已知边界**（如实写）：`Merged` 那一支把**合并产物**写进内容列，而正文列仍是
/// **远端那一份**（合并进来的块，其正文要等下一次"打开页面"由编辑器语义补算 —— `refresh_page_text_if_stale`）。
/// 窗口期的两件事：① 那一页 **FTS 搜不到刚合并进来的字**；② 直到页面被打开（不是"直到下一次保存"）。
/// 为什么不在这一层现算：派生正文要**编辑器语义**（节点表），在同步路径里现算等于在这里长出第二份派生实现
/// —— 那正是 §4 规则 1 禁止的。
pub fn apply_remote_page(
    c: &Connection,
    page: &crate::models::PageDetail,
    sync_seq: i64,
) -> Result<RemoteMerge, String> {
    let local = read(c, &page.id)?;
    let Some(local) = local else {
        upsert_remote(c, page, sync_seq)?;
        derive_fts(c, &page.id, &page.title, &page.content_text)?;
        return Ok(RemoteMerge::NotApplicable);
    };

    let outcome = merge_remote_content(&local.json, &page.content_json);
    match &outcome {
        RemoteMerge::Merged(json) => {
            let mut merged_page = page.clone();
            merged_page.content_json = json.clone();
            upsert_remote(c, &merged_page, sync_seq)?;
        }
        RemoteMerge::Conflicted(conflicts) => {
            // ★ 裁定 (iii)：**不静默选边** ⇒ 先把冲突落表（提示 UI 的数据），覆盖语义不变。
            record_page_conflicts(c, &page.id, conflicts)?;
            upsert_remote(c, page, sync_seq)?;
        }
        RemoteMerge::NotApplicable => upsert_remote(c, page, sync_seq)?,
    }
    // 派生也只经那一层（今天远端应用只刷 FTS —— 与接线前逐字相同；合并成功时那条正文可能滞后一拍，
    // 见本函数的"已知边界"与 `merge_remote_content`）。
    derive_fts(c, &page.id, &page.title, &page.content_text)?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(seq: i64, dirty: i64) -> Option<LocalState> {
        Some(LocalState { seq, dirty })
    }

    #[test]
    fn local_page_absent_takes_remote() {
        assert_eq!(merge(None, 7), MergeDecision::TakeRemote);
    }

    #[test]
    fn dirty_local_wins_even_against_a_newer_seq() {
        // 「本地有未推送改动」优先于「远端 seq 更大」——这是保护用户刚改的内容那条。
        assert_eq!(merge(st(3, 1), 99), MergeDecision::KeepLocal);
    }

    #[test]
    fn already_synced_past_this_change_keeps_local() {
        assert_eq!(merge(st(10, 0), 9), MergeDecision::KeepLocal);
    }

    #[test]
    fn equal_seq_is_not_newer_so_remote_wins() {
        // 边界：`local_seq > remote_seq` 是**严格**大于 ⇒ 相等时远端覆盖（与搬运前一致）。
        assert_eq!(merge(st(9, 0), 9), MergeDecision::TakeRemote);
    }

    #[test]
    fn clean_and_behind_takes_remote() {
        assert_eq!(merge(st(4, 0), 5), MergeDecision::TakeRemote);
    }

    // ===== 阶段 1 · 块级合并（纯函数）=====================================================
    // 与前端 `src/lib/docContent.test.ts` 的 `docContent.mergeBlocks` 那组用例**逐条对应**：
    //   · 两端各改不同块 ⇒ 都保留        ↔ blocks_edited_on_different_sides_are_both_kept
    //   · 远端 rev 更大                   ↔ newer_remote_rev_takes_remote
    //   · 本地 rev 更大                   ↔ newer_local_rev_keeps_local
    //   · 内容逐字节相同（缺 rev）        ↔ identical_content_is_not_a_conflict…
    //   · rev 相等而内容不同              ↔ equal_rev_different_content_is_a_conflict
    //   · 缺 rev 且内容变了（反判据）     ↔ missing_rev_with_changed_content_must_be_a_conflict
    //   · 只在一侧的块                    ↔ block_only_on_one_side_is_kept
    //   · 顺序边界                        ↔ order_comes_from_the_page_level_winner…
    //   · 页级 KeepLocal 不许被块级推翻   ↔ page_level_keep_local_never_consults_blocks
    //   · 冲突带两侧原文                  ↔ conflict_carries_both_sides_so_the_ui_can_offer_recovery

    fn blk(id: &str, rev: Option<i64>, body: &str) -> BlockSnapshot {
        BlockSnapshot::new(id, rev, body)
    }

    /// 按 id 取结果里那一项（顺序无关的断言用它）。
    fn pick(o: &BlockMergeOutcome, id: &str) -> MergedBlock {
        o.blocks
            .iter()
            .find(|b| b.block_id == id)
            .expect("块不在结果里")
            .clone()
    }

    /// 结果的 id 顺序。
    fn ids(o: &BlockMergeOutcome) -> Vec<&str> {
        o.blocks.iter().map(|b| b.block_id.as_str()).collect()
    }

    #[test]
    fn blocks_edited_on_different_sides_are_both_kept() {
        // ★ 阶段 1 的**核心承诺**：两端各改不同的顶层块 ⇒ 两边的**内容**都必须保留。
        let local = vec![
            blk("b1", Some(2), "本地改过的 b1"),
            blk("b2", Some(1), "b2 原样"),
        ];
        let remote = vec![
            blk("b1", Some(1), "b1 原样"),
            blk("b2", Some(2), "远端改过的 b2"),
        ];

        let out = merge_blocks(&local, &remote, MergeDecision::TakeRemote);

        assert_eq!(pick(&out, "b1").choice, BlockChoice::Local);
        assert_eq!(pick(&out, "b1").json, "本地改过的 b1");
        assert_eq!(pick(&out, "b2").choice, BlockChoice::Remote);
        assert_eq!(pick(&out, "b2").json, "远端改过的 b2");
        assert!(
            !out.has_conflicts(),
            "各改不同块不该产生冲突：{:?}",
            out.conflicts
        );
    }

    #[test]
    fn newer_remote_rev_takes_remote() {
        let local = vec![blk("b1", Some(3), "旧")];
        let remote = vec![blk("b1", Some(4), "新")];
        assert_eq!(
            merge_blocks(&local, &remote, MergeDecision::TakeRemote).blocks[0].json,
            "新"
        );
    }

    #[test]
    fn newer_local_rev_keeps_local() {
        let local = vec![blk("b1", Some(5), "本地更新")];
        let remote = vec![blk("b1", Some(4), "远端更旧")];
        let out = merge_blocks(&local, &remote, MergeDecision::TakeRemote);
        assert_eq!(out.blocks[0].choice, BlockChoice::Local);
        assert_eq!(out.blocks[0].json, "本地更新");
        assert!(!out.has_conflicts());
    }

    #[test]
    fn identical_content_is_not_a_conflict_even_when_revs_are_missing() {
        // ★ 反判据第二条（回复信 §三）：老客户端"打开—原样保存"会剥掉 `blockRev` 而**内容未变** ——
        // 那次**不许**提示，否则提示会在每次同步冒出来 ⇒ 变成噪声 ⇒ 用户学会忽略 ⇒ 等于静默。
        let local = vec![blk("b1", Some(7), "一模一样")];
        let remote = vec![blk("b1", None, "一模一样")];

        let out = merge_blocks(&local, &remote, MergeDecision::TakeRemote);

        assert_eq!(pick(&out, "b1").choice, BlockChoice::Identical);
        assert!(
            !out.has_conflicts(),
            "内容逐字节相同却提示了：{:?}",
            out.conflicts
        );
    }

    #[test]
    fn equal_rev_different_content_is_a_conflict() {
        // 并发同改同一块：两侧都从同一 base 加一 ⇒ 编号**必然相等**。
        let local = vec![blk("b1", Some(2), "我改的")];
        let remote = vec![blk("b1", Some(2), "他改的")];

        let out = merge_blocks(&local, &remote, MergeDecision::TakeRemote);

        assert_eq!(
            pick(&out, "b1").choice,
            BlockChoice::Conflict(ConflictReason::SameRevDifferentContent)
        );
        assert_eq!(out.conflicts.len(), 1);
        assert_eq!(out.conflicts[0].local_json.as_deref(), Some("我改的"));
        assert_eq!(out.conflicts[0].remote_json.as_deref(), Some("他改的"));
    }

    #[test]
    fn missing_rev_with_changed_content_must_be_a_conflict() {
        // ★ 反判据第一条（§4 第 3 条）：造一份"老客户端产物"（`blockRev` 被剥掉）而内容**变了**
        // ⇒ **必须**走到裁定 (iii)（提示）。**若它静默按"最旧"处理（Local/Remote）⇒ 这条红。**
        for (l, r) in [
            (
                blk("b1", None, "老客户端改的"),
                blk("b1", Some(9), "新客户端的"),
            ),
            (
                blk("b1", Some(9), "新客户端的"),
                blk("b1", None, "老客户端改的"),
            ),
            (blk("b1", None, "甲"), blk("b1", None, "乙")),
        ] {
            let out = merge_blocks(&[l], &[r], MergeDecision::TakeRemote);
            let got = out.blocks[0].choice;
            assert_eq!(
                got,
                BlockChoice::Conflict(ConflictReason::MissingRev),
                "缺 rev 且内容变了却静默选边了：{got:?}"
            );
            assert!(got.is_conflict());
        }
    }

    #[test]
    fn block_only_on_one_side_is_kept() {
        // 已知边界 1：本片**不做块级删除 / 墓碑** ⇒ 只在一侧的块保留（判据把它钉住，
        // 免得将来有人顺手把它改成"消失"而没人发现）。
        let local = vec![
            blk("b1", Some(1), "共有"),
            blk("b-new", Some(1), "本地新块"),
        ];
        let remote = vec![
            blk("b1", Some(2), "远端改过"),
            blk("b-remote", Some(1), "远端新块"),
        ];

        let out = merge_blocks(&local, &remote, MergeDecision::TakeRemote);

        assert_eq!(pick(&out, "b-new").choice, BlockChoice::OnlyLocal);
        assert_eq!(pick(&out, "b-remote").choice, BlockChoice::OnlyRemote);
        assert!(
            !out.has_conflicts(),
            "只在一侧的块不是冲突：{:?}",
            out.conflicts
        );
    }

    #[test]
    fn order_comes_from_the_page_level_winner_and_extras_are_appended() {
        // 已知边界 2（回复信 §二明确要求钉住）：**顺序 / 移动不参与合并** ——
        // 顺序取页级胜方那一侧，另一侧多出来的块按它自己的顺序**追加在表尾**。
        let local = vec![
            blk("l1", Some(1), "l1"),
            blk("l2", Some(1), "l2"),
            blk("l3", Some(1), "l3"),
        ];
        let remote = vec![blk("r1", Some(1), "r1"), blk("r2", Some(1), "r2")];

        // 页级胜方 = 本地 ⇒ 本地顺序在前，远端那两个追加在后。
        let keep_local_order = merge_blocks(&local, &remote, MergeDecision::KeepLocal);
        assert_eq!(ids(&keep_local_order), vec!["l1", "l2", "l3", "r1", "r2"]);

        // 页级胜方 = 远端 ⇒ 反过来。
        let take_remote_order = merge_blocks(&local, &remote, MergeDecision::TakeRemote);
        assert_eq!(ids(&take_remote_order), vec!["r1", "r2", "l1", "l2", "l3"]);
    }

    #[test]
    fn page_level_keep_local_never_consults_blocks() {
        // ④ 本地 `dirty` 仍优先 ⇒ 页级判定说"留本地"时，**整页都不动**，
        // 不许拿块级合并的结果去覆盖它（否则"本地刚改还没推"的东西会被拆开）。
        let local_blocks = vec![blk("b1", Some(1), "本地现状")];
        let remote_blocks = vec![blk("b1", Some(99), "远端更新")];

        // dirty=1 ⇒ 页级留本地
        assert_eq!(
            merge_page_and_blocks(st(3, 1), 99, &local_blocks, &remote_blocks),
            PageMerge::KeepLocal
        );

        // 干净且落后 ⇒ 页级用远端，这一支才做逐块比对
        match merge_page_and_blocks(st(3, 0), 99, &local_blocks, &remote_blocks) {
            PageMerge::Merged(out) => assert_eq!(out.blocks[0].json, "远端更新"),
            PageMerge::KeepLocal => panic!("干净且落后时不该留本地"),
        }
    }

    #[test]
    fn conflict_carries_both_sides_so_the_ui_can_offer_recovery() {
        // "冲突不许静默丢"：结果里必须**两侧原文都在**，UI 才有得"取回"。
        let local = vec![blk("b1", Some(2), "{\"v\":\"local\"}")];
        let remote = vec![blk("b1", Some(2), "{\"v\":\"remote\"}")];

        let out = merge_blocks(&local, &remote, MergeDecision::TakeRemote);

        assert_eq!(out.conflicts.len(), 1);
        let c = &out.conflicts[0];
        assert_eq!(c.block_id, "b1");
        assert_eq!(c.local_json.as_deref(), Some("{\"v\":\"local\"}"));
        assert_eq!(c.remote_json.as_deref(), Some("{\"v\":\"remote\"}"));
        // 冲突那一项在 blocks 里的 json 是**本地现状占位**，不是裁决 —— 注释里写死了这条。
        assert_eq!(pick(&out, "b1").json, "{\"v\":\"local\"}");
    }

    #[test]
    fn empty_side_takes_the_other_side_whole() {
        let local: Vec<BlockSnapshot> = vec![];
        let remote = vec![blk("b1", Some(1), "甲的"), blk("b2", None, "乙的")];

        let out = merge_blocks(&local, &remote, MergeDecision::TakeRemote);
        assert_eq!(ids(&out), vec!["b1", "b2"]);
        assert!(out
            .blocks
            .iter()
            .all(|b| b.choice == BlockChoice::OnlyRemote));
        // ⚠️ 本页一侧整页为空时**不报冲突**：那不是"判不了"，是"另一侧全都有"。
        assert!(!out.has_conflicts());
    }

    // ===== 阶段 1 接线适配器（与前端 docContent.test.ts 的同名用例逐条对应）=================

    /// 一个**落盘 JSON 形态**的段落块（`blockId` 可选，`rev` 可选）。
    fn jblk(block_id: Option<&str>, rev: Option<i64>, body: &str) -> serde_json::Value {
        let mut node = serde_json::json!({
            "type": "paragraph",
            "children": [{ "type": "text", "text": body }],
        });
        if let Some(id) = block_id {
            node["blockId"] = serde_json::json!(id);
        }
        if let Some(rev) = rev {
            node["blockRev"] = serde_json::json!(rev);
        }
        node
    }

    fn jdoc(blocks: Vec<serde_json::Value>) -> String {
        serde_json::json!({ "root": { "children": blocks } }).to_string()
    }

    /// 合并产物里每块的正文（断言用）。
    fn bodies_of(doc_json: &str) -> Vec<String> {
        let doc: serde_json::Value = serde_json::from_str(doc_json).unwrap();
        doc.pointer("/root/children")
            .and_then(|c| c.as_array())
            .map(|items| {
                items
                    .iter()
                    .map(|n| {
                        n.pointer("/children/0/text").and_then(|t| t.as_str()).unwrap_or_default().to_string()
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 合并产物里每块的 rev（`None` = 字段不在）。
    fn revs_of(doc_json: &str) -> Vec<Option<i64>> {
        let doc: serde_json::Value = serde_json::from_str(doc_json).unwrap();
        doc.pointer("/root/children")
            .and_then(|c| c.as_array())
            .map(|items| items.iter().map(crate::block_rev::block_rev_of).collect())
            .unwrap_or_default()
    }

    #[test]
    fn block_snapshots_splits_and_drops_rev() {
        let blocks = block_snapshots(&jdoc(vec![jblk(Some("b1"), Some(3), "甲"), jblk(Some("b2"), None, "乙")]))
            .expect("应当能拆出块表");
        assert_eq!(blocks.iter().map(|b| b.block_id.as_str()).collect::<Vec<_>>(), vec!["b1", "b2"]);
        assert_eq!(blocks.iter().map(|b| b.rev).collect::<Vec<_>>(), vec![Some(3), None]);
        assert!(!blocks[0].json.contains("blockRev"), "片段里不许带 rev");
    }

    #[test]
    fn block_snapshots_bails_when_a_block_has_no_identity() {
        // 老内容（还没补种身份）⇒ 不合并，回落今天的行为。
        assert!(block_snapshots(&jdoc(vec![jblk(Some("b1"), Some(1), "甲"), jblk(None, None, "乙")])).is_none());
        assert!(block_snapshots(&jdoc(vec![jblk(Some(""), Some(1), "甲")])).is_none());
    }

    #[test]
    fn block_snapshots_bails_on_dirty_json() {
        for bad in ["not json", "{}", "{\"root\":null}", "{\"root\":{\"children\":\"nope\"}}"] {
            assert!(block_snapshots(bad).is_none(), "{bad} 应当拆不出来");
        }
    }

    #[test]
    fn apply_block_snapshots_writes_rev_back() {
        let merged = apply_block_snapshots(
            &jdoc(vec![jblk(Some("b1"), Some(1), "旧")]),
            &[
                MergedBlock {
                    block_id: "b1".into(),
                    choice: BlockChoice::Local,
                    json: crate::block_rev::canonical_content(&jblk(Some("b1"), None, "新")),
                    rev: Some(7),
                },
                MergedBlock {
                    block_id: "b9".into(),
                    choice: BlockChoice::OnlyRemote,
                    json: crate::block_rev::canonical_content(&jblk(Some("b9"), None, "新块")),
                    rev: None,
                },
            ],
        )
        .expect("应当能装回去");

        assert_eq!(bodies_of(&merged), vec!["新", "新块"]);
        assert_eq!(revs_of(&merged), vec![Some(7), None]);
    }

    #[test]
    fn merge_remote_content_keeps_both_sides_edits() {
        let local = jdoc(vec![jblk(Some("b1"), Some(2), "A 改的"), jblk(Some("b2"), Some(1), "b2 原始")]);
        let remote = jdoc(vec![jblk(Some("b1"), Some(1), "b1 原始"), jblk(Some("b2"), Some(2), "B 改的")]);

        let RemoteMerge::Merged(merged) = merge_remote_content(&local, &remote) else {
            panic!("两端各改不同块 ⇒ 必须能合");
        };

        assert_eq!(bodies_of(&merged), vec!["A 改的", "B 改的"]);
        assert_eq!(revs_of(&merged), vec![Some(2), Some(2)]);
    }

    #[test]
    fn merge_remote_content_reports_conflicts_separately_from_not_applicable() {
        // ★ 三种结果必须分得开：**有冲突**（要留痕）≠**没什么可合**（老内容 / 脏 JSON）。
        //   用 `Option` 的时候这两者是一回事 —— 那正是"静默"的来源。
        match merge_remote_content(
            &jdoc(vec![jblk(Some("b1"), Some(2), "我改的")]),
            &jdoc(vec![jblk(Some("b1"), Some(2), "他改的")]),
        ) {
            RemoteMerge::Conflicted(conflicts) => {
                assert_eq!(conflicts.len(), 1);
                assert_eq!(conflicts[0].reason, ConflictReason::SameRevDifferentContent);
                assert_eq!(conflicts[0].local_json.as_deref().map(|j| j.contains("我改的")), Some(true));
                assert_eq!(conflicts[0].remote_json.as_deref().map(|j| j.contains("他改的")), Some(true));
            }
            other => panic!("同 rev 不同内容应当是冲突，实际 {other:?}"),
        }
        // 任一侧缺 rev ⇒ 也是冲突（判不了就不判）
        assert!(matches!(
            merge_remote_content(
                &jdoc(vec![jblk(Some("b1"), None, "我改的")]),
                &jdoc(vec![jblk(Some("b1"), Some(5), "他的")]),
            ),
            RemoteMerge::Conflicted(_)
        ));
        // 老内容缺身份 ⇒ **不是冲突**，是"没什么可合"
        assert_eq!(
            merge_remote_content(
                &jdoc(vec![jblk(None, None, "老")]),
                &jdoc(vec![jblk(Some("b1"), Some(1), "新")]),
            ),
            RemoteMerge::NotApplicable
        );
    }

    #[test]
    fn merge_remote_content_output_survives_assign_block_revs() {
        // 承重：合并产物是"下一次保存的 baseline"。物化时丢了 rev ⇒ assign_block_revs 会把每块
        // 当成"老客户端产物"重新盖 0/1 ⇒ rev 倒退 ⇒ 下一次合并的胜负判断就错了。
        let local = jdoc(vec![jblk(Some("b1"), Some(4), "A 改的"), jblk(Some("b2"), Some(1), "b2 原始")]);
        let remote = jdoc(vec![jblk(Some("b1"), Some(1), "b1 原始"), jblk(Some("b2"), Some(5), "B 改的")]);
        let RemoteMerge::Merged(merged) = merge_remote_content(&local, &remote) else {
            panic!("应当能合");
        };

        let stamped = crate::block_rev::assign_block_revs(&merged, &merged);
        assert_eq!(revs_of(&stamped), vec![Some(4), Some(5)]);
        assert_eq!(bodies_of(&stamped), vec!["A 改的", "B 改的"]);
    }

    /// 冲突留痕那几个入口用的连接：**走仓库自己的建库路径**（真 schema）。
    ///
    /// ⚠️ 别图省事手抄两张最小表：`resolve_page_conflict` 里有 `derive`（FTS ＋ 块图），
    /// 手抄的 schema 少了那几张表就会在 `derive` 上炸 —— 那测的就是"另一套 schema"了
    /// （`versions.rs` 的 `test_conn` 记过同一条教训）。
    fn conflict_conn(tag: &str) -> (Connection, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("shuyonote-conflicts-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        let c = crate::db::open_space_conn_at("s1", &dir).unwrap();
        crate::sync::set_meta_state(&c, "device_id", "test-device").unwrap();
        (c, dir)
    }

    fn insert_conflict_page(c: &Connection, id: &str, json: &str) {
        c.execute(
            "INSERT INTO pages (id, workspace_id, title, content_json, content_text, kind, created_at, updated_at, deleted_at, dirty)
             VALUES (?1, 's1', '页', ?2, '', 'page', 0, 0, NULL, 0)",
            rusqlite::params![id, json],
        )
        .unwrap();
    }

    #[test]
    fn replace_block_content_swaps_one_block_only() {
        let doc = jdoc(vec![jblk(Some("b1"), Some(1), "旧"), jblk(Some("b2"), Some(1), "别动")]);
        let out = replace_block_content(&doc, "b1", &jblk(Some("b1"), None, "新").to_string()).unwrap();
        assert_eq!(bodies_of(&out), vec!["新", "别动"]);
        // 块不在这一版里 ⇒ None（裁决时据此拒绝，而不是悄悄什么都不做）
        assert!(replace_block_content(&doc, "nope", "{}").is_none());
        assert!(replace_block_content("not json", "b1", "{}").is_none());
    }

    #[test]
    fn conflicts_are_recorded_listed_and_deduped() {
        let (c, dir) = conflict_conn("list");
        insert_conflict_page(&c, "p1", &jdoc(vec![jblk(Some("b1"), Some(2), "我改的")]));

        let conflict = BlockConflict {
            block_id: "b1".into(),
            reason: ConflictReason::SameRevDifferentContent,
            local_json: Some(jblk(Some("b1"), None, "我改的").to_string()),
            remote_json: Some(jblk(Some("b1"), None, "他改的").to_string()),
        };
        record_page_conflicts(&c, "p1", &[conflict.clone()]).unwrap();
        // 同一页同一块再来一次 ⇒ **覆盖**（不堆积）
        record_page_conflicts(&c, "p1", &[conflict]).unwrap();

        let rows = unresolved_page_conflicts(&c, "p1").unwrap();
        assert_eq!(rows.len(), 1, "同一 (page, block) 的未决记录只该有一条");
        assert_eq!(rows[0].block_id, "b1");
        assert_eq!(rows[0].reason, "same-rev-different-content");
        assert!(rows[0].local_json.contains("我改的"));
        assert!(rows[0].remote_json.contains("他改的"));
        assert_eq!(rows[0].resolved_at, None);
        // 别的页不受影响
        assert!(unresolved_page_conflicts(&c, "p2").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolving_a_conflict_writes_the_chosen_side_with_a_new_rev() {
        let (c, dir) = conflict_conn("resolve");
        let current = jdoc(vec![jblk(Some("b1"), Some(3), "远端赢了的那版"), jblk(Some("b2"), Some(0), "别动")]);
        insert_conflict_page(&c, "p1", &current);
        record_page_conflicts(
            &c,
            "p1",
            &[BlockConflict {
                block_id: "b1".into(),
                reason: ConflictReason::SameRevDifferentContent,
                local_json: Some(jblk(Some("b1"), None, "我原来改的").to_string()),
                remote_json: Some(jblk(Some("b1"), None, "远端赢了的那版").to_string()),
            }],
        )
        .unwrap();
        let id = unresolved_page_conflicts(&c, "p1").unwrap()[0].id.clone();

        // 裁决"留本地" ⇒ 该块换回本地那一版，并且**盖了新 rev**（maxSeen(3)+1 = 4）
        resolve_page_conflict(&c, &id, ConflictChoice::Local).unwrap();

        let json: String =
            c.query_row("SELECT content_json FROM pages WHERE id = 'p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(bodies_of(&json), vec!["我原来改的", "别动"]);
        assert_eq!(revs_of(&json), vec![Some(4), Some(0)]);
        // 裁决 = 一笔本地编辑（要被推上去）
        let dirty: i64 = c.query_row("SELECT dirty FROM pages WHERE id = 'p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(dirty, 1);
        // 标成已决，不再出现在未决列表里
        assert!(unresolved_page_conflicts(&c, "p1").unwrap().is_empty());
        // 已决的再裁决 ⇒ 报错（不静默成功）
        assert!(resolve_page_conflict(&c, &id, ConflictChoice::Remote).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stamp_block_revs_stamps_on_a_real_page_row() {
        // 保存路径的盖章入口：**真表**（只建 `read` 用到的那几列；`read` 的谓词另有判据覆盖）。
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE pages (
               id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
               content_json TEXT NOT NULL DEFAULT '', content_text TEXT NOT NULL DEFAULT '',
               deleted_at INTEGER
             );",
        )
        .unwrap();
        let old = jdoc(vec![jblk(Some("b1"), None, "原始一"), jblk(Some("b2"), None, "原始二")]);
        c.execute(
            "INSERT INTO pages (id, title, content_json, content_text) VALUES ('p1','标题',?1,'')",
            rusqlite::params![old],
        )
        .unwrap();

        // 改一块再保存 ⇒ 改过的那块 `max+1 (=1)`，没改的那块盖 `0`（"有身份 ⇒ 一定有 rev"）
        let next = jdoc(vec![jblk(Some("b1"), None, "改过"), jblk(Some("b2"), None, "原始二")]);
        let stamped = stamp_block_revs(&c, "p1", &next).unwrap();

        assert_eq!(revs_of(&stamped), vec![Some(1), Some(0)]);
        assert_eq!(bodies_of(&stamped), vec!["改过", "原始二"]);
    }

    #[test]
    fn stamp_block_revs_on_a_missing_page_returns_input_unchanged() {
        // 页面不存在 ⇒ `read` 给 `None` ⇒ baseline 空 ⇒ 所有块按"新块"盖 1（**不抛**）。
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE pages (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', content_json TEXT NOT NULL DEFAULT '', content_text TEXT NOT NULL DEFAULT '', deleted_at INTEGER);").unwrap();
        let next = jdoc(vec![jblk(Some("b1"), None, "新")]);
        assert_eq!(revs_of(&stamp_block_revs(&c, "nope", &next).unwrap()), vec![Some(1)]);
    }

    #[test]
    fn write_text_touches_only_the_text() {
        // 阶段 1 · 正文文本的本地修复：**只动 content_text** —— `content_json` 与 `dirty` 都不许动
        //（它不是用户编辑；标脏会把它当成一笔本地改动推上去）。
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE pages (
               id TEXT PRIMARY KEY, content_json TEXT NOT NULL DEFAULT '',
               content_text TEXT NOT NULL DEFAULT '', dirty INTEGER NOT NULL DEFAULT 0,
               updated_at INTEGER NOT NULL DEFAULT 0
             );",
        )
        .unwrap();
        c.execute(
            "INSERT INTO pages (id, content_json, content_text, dirty, updated_at) VALUES ('p1', '{\"root\":{\"children\":[]}}', '旧文本', 0, 7)",
            [],
        )
        .unwrap();

        write_text(&c, "p1", "新文本").unwrap();

        let (json, text, dirty, updated): (String, String, i64, i64) = c
            .query_row(
                "SELECT content_json, content_text, dirty, updated_at FROM pages WHERE id = 'p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(text, "新文本");
        assert_eq!(json, "{\"root\":{\"children\":[]}}", "正文修复不许动内容");
        assert_eq!(dirty, 0, "正文修复不是本地编辑（标脏会被推上去）");
        assert_eq!(updated, 7, "正文修复不许改 updated_at（那是内容的时间戳）");
    }

    // ===== 2026-09-22 回信（macOS / AMD 抓到的两条）=======================================

    /// ★ **同内容、不同 rev ⇒ 收敛到两者较大的那个**（macOS 给的名字，逐字）。
    ///
    /// 老写法 `l.rev.or(r.rev)` 是"本地优先"：本地那个更旧的 rev 被留下 ⇒ 本地下一次编辑从更低的
    /// 基线加一 ⇒ 编号追不上远端已经见过的编号 ⇒ **远端更旧的编辑会在随后一次合并里静默赢过本地的新编辑**。
    #[test]
    fn identical_content_with_divergent_revs_converges_to_max() {
        for (l, r, want) in [(Some(2), Some(4), Some(4)), (Some(4), Some(2), Some(4)), (Some(7), None, Some(7)), (None, None, None)] {
            let out = merge_blocks(&[blk("b1", l, "逐字一样")], &[blk("b1", r, "逐字一样")], MergeDecision::TakeRemote);
            assert_eq!(pick(&out, "b1").choice, BlockChoice::Identical, "l={l:?} r={r:?}");
            assert_eq!(pick(&out, "b1").rev, want, "l={l:?} r={r:?} 必须取较大的 rev（不许本地优先）");
            assert!(!out.has_conflicts(), "内容逐字相同不该提示：{:?}", out.conflicts);
        }
    }

    /// ★ 承重（macOS 给的 trace，端到端）：那条 max 不是"顺手取个大值"，它决定下一次合并**是提示还是静默**。
    ///
    /// A 的 b1 已到 4，B 只有 2（内容一样）；B 收到远端后必须把 4 记下来。
    /// 之后 A、B 各改这一块 ⇒ 两边都盖 5 ⇒ 下一次合并落进"同 rev 不同内容"⇒ **提示**。
    /// 若 B 停在 2（老写法），B 改出来的是 3 < A 的 5 ⇒ A 静默赢、B 的编辑没了。
    #[test]
    fn max_rev_keeps_the_next_local_edit_visible_instead_of_losing_it() {
        let b_local = jdoc(vec![jblk(Some("b1"), Some(2), "一样")]);
        let a_remote = jdoc(vec![jblk(Some("b1"), Some(4), "一样")]);

        let RemoteMerge::Merged(merged) = merge_remote_content(&b_local, &a_remote) else {
            panic!("同内容应当算 identical（合得上）");
        };
        assert_eq!(revs_of(&merged), vec![Some(4)], "B 这边必须把 4 记下来（不是 2）");

        // 之后各自改这一块：A 从 4 加一到 5；B 从**合并产物的 4** 加一到 5（两份实现是同一个纯函数）。
        let a_next = crate::block_rev::assign_block_revs(&a_remote, &jdoc(vec![jblk(Some("b1"), None, "A 改的")]));
        let b_next = crate::block_rev::assign_block_revs(&merged, &jdoc(vec![jblk(Some("b1"), None, "B 改的")]));
        assert_eq!(revs_of(&a_next), vec![Some(5)]);
        assert_eq!(revs_of(&b_next), vec![Some(5)]);

        // ⇒ 下一次合并：同 rev、不同内容 ⇒ **冲突（看得见）**，不是"远端静默赢"。
        match merge_remote_content(&b_next, &a_next) {
            RemoteMerge::Conflicted(c) => assert_eq!(c[0].reason, ConflictReason::SameRevDifferentContent),
            other => panic!("应当提示冲突，实际 {other:?}"),
        }
    }

    /// ★ **`rev == 0` 的语义**（macOS §二 要求把三条钉在一起）：0 = **"老到不能再老"**，
    /// 不是"判不了"，也不是"新版本"。⇒ 明确的远端 rev 3 赢它，且**不弹提示**（老块没被谁改过）。
    #[test]
    fn legacy_zero_rev_block_loses_to_explicit_remote_rev() {
        let out = merge_blocks(
            &[blk("b1", Some(0), "老内容")],
            &[blk("b1", Some(3), "远端改过的")],
            MergeDecision::TakeRemote,
        );
        assert_eq!(pick(&out, "b1").choice, BlockChoice::Remote);
        assert_eq!(pick(&out, "b1").json, "远端改过的");
        assert_eq!(pick(&out, "b1").rev, Some(3), "合并后这一块的 rev 变成远端那个（≥1）");
        assert!(!out.has_conflicts(), "0 是『最旧』不是『判不了』⇒ 不许提示");

        // ③ 0 绝不是"新版本"：改过的块一定拿到 **≥1**（`maxSeen + 1`），本层不会写出新的 0。
        let stamped = crate::block_rev::assign_block_revs(
            &jdoc(vec![jblk(Some("b1"), Some(0), "老")]),
            &jdoc(vec![jblk(Some("b1"), None, "改了")]),
        );
        assert_eq!(revs_of(&stamped), vec![Some(1)]);
    }

    /// ★ **嵌套层的 `blockRev`**（macOS §四 (d)）：本层的口径是"`blockRev` 是管道、哪一层都不是内容"
    /// ⇒ 比较时任意层级都剥掉；**物化产物里嵌层的同名字段也会消失**（今天的已知边界，钉在这里，
    /// 免得将来有人以为它是"内容"而被静默改掉）。内容本身一个字节都不许动。
    #[test]
    fn materialization_drops_nested_block_rev_and_keeps_content() {
        let nested = serde_json::json!({
            "type": "quote", "blockId": "b1",
            "children": [{ "type": "paragraph", "blockId": "nested-1", "blockRev": 9,
                           "children": [{ "type": "text", "text": "引用里的字" }] }],
        });
        let merged = apply_block_snapshots(
            &jdoc(vec![nested.clone()]),
            &[MergedBlock {
                block_id: "b1".into(),
                choice: BlockChoice::Identical,
                json: crate::block_rev::canonical_content(&nested),
                rev: Some(4),
            }],
        )
        .expect("应当能装回去");

        let doc: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(doc.pointer("/root/children/0/blockRev").and_then(|v| v.as_i64()), Some(4));
        assert!(doc.pointer("/root/children/0/children/0/blockRev").is_none(), "嵌层同名键会被剥掉（今天的边界）");
        assert_eq!(
            doc.pointer("/root/children/0/children/0/blockId").and_then(|v| v.as_str()),
            Some("nested-1"),
            "嵌层的**内容**（身份、文字）一个都不许动"
        );
        assert_eq!(
            doc.pointer("/root/children/0/children/0/children/0/text").and_then(|v| v.as_str()),
            Some("引用里的字")
        );
    }

    // ===== 2026-09-22：apply 的返回值 / 正文与 FTS / 已知边界 ==============================

    fn remote_page(id: &str, json: &str, text: &str) -> crate::models::PageDetail {
        crate::models::PageDetail {
            id: id.into(),
            workspace_id: "s1".into(),
            parent_id: None,
            title: "页".into(),
            content_json: json.into(),
            content_text: text.into(),
            cover: String::new(),
            icon: String::new(),
            cover_height: 300,
            cover_pos: 50.0,
            kind: "page".into(),
            sort_order: 0.0,
            created_at: 0,
            updated_at: 0,
        }
    }

    /// ★ **"关掉提示" ≠ "已裁决"**（AMD 2026-09-22，`conflict-banner.reply-1` §二②）：今天的提示条**没有关闭动作**
    /// （没有未决记录时它自己消失）⇒ 等价的可测形态是：**只有 `resolved_at` 被写上，才会让这一行从"未决"里消失**。
    /// 别的一切都不许动这个计数：再落一次同样的冲突（重连 / 重放那一格）、页面被写、重复读 —— 都不许涨也不许掉。
    #[test]
    fn only_a_real_resolution_changes_the_unresolved_count() {
        let (c, dir) = conflict_conn("unresolved-count");
        insert_conflict_page(&c, "p1", &jdoc(vec![jblk(Some("b1"), Some(2), "我改的")]));
        let conflict = BlockConflict {
            block_id: "b1".into(),
            reason: ConflictReason::SameRevDifferentContent,
            local_json: Some(jblk(Some("b1"), None, "我改的").to_string()),
            remote_json: Some(jblk(Some("b1"), None, "他改的").to_string()),
        };

        let unresolved = |c: &Connection| unresolved_page_conflicts(c, "p1").unwrap().len();
        // ① 第一次应用 ⇒ 1 条未决
        apply_remote_page(&c, &remote_page("p1", &jdoc(vec![jblk(Some("b1"), Some(2), "他改的")]), "远端正文"), 9)
            .unwrap();
        assert_eq!(unresolved(&c), 1);

        // ② 重连 / 重放同一格 ⇒ **不增长**（"同一 (页, 块) 覆盖不堆积"）
        record_page_conflicts(&c, "p1", &[conflict.clone()]).unwrap();
        record_page_conflicts(&c, "p1", &[conflict.clone()]).unwrap();
        assert_eq!(unresolved(&c), 1, "重放同一冲突不许把未决记录堆起来");

        // ③ 这一页被写（保存 / 合并 / 正文修复都不是"裁决"）⇒ 计数不动
        let cur = read(&c, "p1").unwrap().unwrap();
        write(&c, "p1", &cur, crate::db::now_ms()).unwrap();
        assert_eq!(unresolved(&c), 1, "写页面不是裁决");

        // ④ 重复读 ⇒ 计数不动（"未决计数永远查得到"）
        assert_eq!(unresolved(&c), 1);
        assert_eq!(unresolved(&c), 1);

        // ⑤ **只有**真裁决会变（0）—— 这一条就是"关闭动作不许写 resolved_at"的等价形态
        let id = unresolved_page_conflicts(&c, "p1").unwrap()[0].id.clone();
        resolve_page_conflict(&c, &id, ConflictChoice::Remote).unwrap();
        assert_eq!(unresolved(&c), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★ **"留痕 ≠ 已裁决"**（AMD 要求）：远端应用这一步必须**把"有未裁决冲突"交回来**
    /// —— 调用方（同步那一层）不许只能靠"再去查一次表"才知道。
    #[test]
    fn apply_remote_page_reports_unresolved_conflicts() {
        let (c, dir) = conflict_conn("apply-report");
        insert_conflict_page(&c, "p1", &jdoc(vec![jblk(Some("b1"), Some(2), "我改的")]));

        let conflicted = apply_remote_page(
            &c,
            &remote_page("p1", &jdoc(vec![jblk(Some("b1"), Some(2), "他改的")]), "远端正文"),
            9,
        )
        .unwrap();
        match conflicted {
            RemoteMerge::Conflicted(cf) => assert_eq!(cf.len(), 1),
            other => panic!("同 rev 不同内容 ⇒ 必须回报冲突，实际 {other:?}"),
        }
        assert_eq!(unresolved_page_conflicts(&c, "p1").unwrap().len(), 1, "而且必须留痕");

        // 另一个页面：两端各改不同块 ⇒ 回报 `Merged`（没有冲突要裁决）
        insert_conflict_page(
            &c,
            "p2",
            &jdoc(vec![jblk(Some("b1"), Some(2), "A 改的"), jblk(Some("b2"), Some(1), "b2 原始")]),
        );
        let merged = apply_remote_page(
            &c,
            &remote_page(
                "p2",
                &jdoc(vec![jblk(Some("b1"), Some(1), "b1 原始"), jblk(Some("b2"), Some(2), "B 改的")]),
                "远端正文",
            ),
            9,
        )
        .unwrap();
        assert!(matches!(merged, RemoteMerge::Merged(_)));
        assert!(unresolved_page_conflicts(&c, "p2").unwrap().is_empty(), "合得上就不该留一条要裁决的痕");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★ **已知边界钉在这里**（不是"以后再说"）：合并成功那一支写的是**合并产物**，
    /// 而正文列仍是**远端那一份**（派生正文要编辑器语义，不能在这一层现算）。
    /// 窗口 = **直到那一页被打开**（`refresh_page_text_if_stale`），期间 FTS 搜不到刚合并进来的字。
    #[test]
    fn merged_write_leaves_the_text_column_on_the_remote_side() {
        let (c, dir) = conflict_conn("merged-text");
        insert_conflict_page(
            &c,
            "p1",
            &jdoc(vec![jblk(Some("b1"), Some(2), "本地改的"), jblk(Some("b2"), Some(1), "b2 原始")]),
        );
        apply_remote_page(
            &c,
            &remote_page(
                "p1",
                &jdoc(vec![jblk(Some("b1"), Some(1), "b1 原始"), jblk(Some("b2"), Some(2), "远端改的")]),
                "远端那一份正文",
            ),
            9,
        )
        .unwrap();

        let json: String = c.query_row("SELECT content_json FROM pages WHERE id='p1'", [], |r| r.get(0)).unwrap();
        let text: String = c.query_row("SELECT content_text FROM pages WHERE id='p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(bodies_of(&json), vec!["本地改的", "远端改的"], "合并产物：两边的编辑都在");
        assert_eq!(text, "远端那一份正文", "正文列这一刻仍是远端那一份（已知边界，如实钉住）");
        assert_ne!(text, "本地改的远端改的", "它不是合并产物的派生文本 —— 别把它当成一致");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★ **正文文本与 FTS 索引必须一起动**（macOS 2026-09-22 实测抓到的缺口；判据名用它给的
    /// `refreshing_the_text_also_refreshes_the_search_index`）：只改列不改索引 ⇒ 桌面搜索**按查词形态分流**
    /// （单词 ≥3 字走 `page_fts`、多词/<3 字走 `content_text`）⇒ 症状是"**有时候搜得到、有时候搜不到**"，
    /// 比全搜不到更难报上来。同时按 AMD 的判据形状：修完之后 `content_text` 必须与**层里读出来的**那一份逐字节一致。
    #[test]
    fn refreshing_the_text_also_refreshes_the_search_index() {
        let (c, dir) = conflict_conn("text-repair");
        insert_conflict_page(&c, "p1", &jdoc(vec![jblk(Some("b1"), Some(1), "正文")]));
        derive_fts(&c, "p1", "页", "旧的正文").unwrap();
        let fts_hits = |c: &Connection, q: &str| -> i64 {
            c.query_row(
                "SELECT count(*) FROM page_fts WHERE page_fts MATCH ?1",
                rusqlite::params![format!("\"{q}\"")],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(fts_hits(&c, "旧的正文"), 1);
        assert_eq!(fts_hits(&c, "刚合并进来的字"), 0, "先证伪：修复之前那条路（单词 ≥3 字）确实搜不到");

        assert!(refresh_page_text_if_stale(&c, "p1", "刚合并进来的字").unwrap(), "不同 ⇒ 要修");

        // ① 层里的读出口与算出来的那一份**逐字节一致**（AMD 的判据形状）
        assert_eq!(read(&c, "p1").unwrap().unwrap().text, "刚合并进来的字");
        // ② 索引跟着动 ⇒ "单词 ≥3 字"那条路也搜得到（macOS 的判据形状）
        assert_eq!(fts_hits(&c, "刚合并进来的字"), 1);
        assert_eq!(fts_hits(&c, "旧的正文"), 0);
        // ③ 相同 ⇒ 一次写库都不做（绝大多数页面走这条）
        assert!(!refresh_page_text_if_stale(&c, "p1", "刚合并进来的字").unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
