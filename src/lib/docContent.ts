// 「文档内容」那一层（**前端 / Web 平台侧**）：read / write / merge。
//
// 桌面侧的同名一层是 `src-tauri/src/doc_content.rs`。上位文档与四条边界规则：
// `docs/plans/2026-09-18-doc-content-layer-inventory.md`（API 草案 §3、边界 §4）。
//
// ## 为什么要有它
// `content_json` / `content_text` 在**前端与 Rust 两侧共 728 处**被直接访问（门禁口径，逐文件基线
// 在 `scripts/doc-content-access-baseline.json`）。要换 CRDT（或做块级 LWW）时，替换面就是这些点；
// 收口成**一层**之后，替换面变成"这一层里的几个函数"，调用方一行不改。
//
// ## 与桌面侧的**分工**（两份实现，语义必须一致）
// 前端这份跑在**浏览器/Web 平台**（`platform/web.ts` 的 sql.js store），桌面那份跑在 Rust 里；
// 两边**不能共享代码**，只能共享**语义**：
//   · `readContent`   ↔ `doc_content::read`
//   · `writeContent`  ↔ `doc_content::write`（都写 `dirty = 1` —— 它是同步契约的一部分）
//   · `shouldTakeRemote` ↔ `doc_content::merge`（★ **唯一的合并点**）
// 两边的单测是**成对的**：这里测 ts，那边测 rs，用例逐条对应（见本文件 `*.test.ts` 与
// `doc_content.rs` 的 `mod tests`）。**改一边必须同时看另一边** —— 这正是盘点文档 §6 里
// "前后端两套壳语义漂移"那条风险的缓解手段。
//
// ⚠️ **只搬不改**：本文件建立时只做抽取（`web.ts` 里原来的分支与 SQL 逐字保留）。
// 任何**行为**改动必须另开一次提交并在提交信息里写明 —— 见 `doc_content.rs` 文件头同款纪律。

import { assignBlockRevs, blockRevOf, canonicalContent } from "./blockRev";
import { throughCrdtPlane } from "./crdt/plane";
import { newBlockId } from "./blockIdentity";
import { repairPageTextIfStale } from "./pageTextRepair";

/** 一页的**内容** —— 那一层的单位（与 Rust 侧 `DocContent` 字段一一对应）。 */
export interface DocContent {
  title: string;
  json: string;
  text: string;
}

/** 批量读出来的行：多一个 `id`（读单页时 id 是入参，不必回传）。 */
export interface ContentRow extends DocContent {
  id: string;
}

/** 那一层只需要这两个能力 —— 与 `SqliteStore.query/run` 同形，测试可传桩。 */
export interface ContentSql {
  query<T>(sql: string, params?: readonly unknown[]): T[];
  run(sql: string, params?: readonly unknown[]): void;
}

/** **唯一读出口**。页面不存在或已软删 ⇒ `null`（"没有"与"出错"由调用方分开处理）。 */
export function readContent(db: ContentSql, pageId: string): DocContent | null {
  const rows = db.query<{ title: string; content_json: string; content_text: string }>(
    "SELECT title, content_json, content_text FROM pages WHERE id = ? AND deleted_at IS NULL",
    [pageId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    title: String(row.title ?? ""),
    // CRDT 平面（Slice B）：开关**默认关** ⇒ 这一句是恒等的原样返回（逐字节等价，见 `crdt/plane.ts`）。
    json: throughCrdtPlane(String(row.content_json ?? "")),
    text: String(row.content_text ?? ""),
  };
}

/**
 * **批量读出口**：所有**未软删**页面的内容（`resolve_block` / `list_block_backlinks` 这类
 * "扫全库找块"的派生读都走它）。
 *
 * 为什么一次给三列而不是"按需给一列"：与 `readContent` 带 `title` 同一条理由 —— 它们**在同一行**，
 * 拆成两个批量函数等于把全表扫两遍。代价是"只用 json 的调用方也多读了一列 text"，
 * 这条代价是**明写**的：若将来它在真实库上成为瓶颈，就在这里加一个只读 json 的重载，
 * 而**不是**让调用方回去自己写 `SELECT content_json`（那就把收口又破了）。
 *
 * ⚠️ **没有 `ORDER BY`**（与搬运前逐字一致）：`resolve_block` 依赖"第一个命中的页面"，
 * 加排序会改变它返回哪一页 —— 那是行为改动，不属于"只搬不改"。
 */
export function readAllContents(db: ContentSql): ContentRow[] {
  const rows = db.query<{ id: string; title: string; content_json: string; content_text: string }>(
    "SELECT id, title, content_json, content_text FROM pages WHERE deleted_at IS NULL",
  );
  return rows.map((row) => ({
    id: String(row.id ?? ""),
    title: String(row.title ?? ""),
    // 批量读出口同样过平面（与 `readContent` 同口径；默认关 ⇒ 原样）。
    json: throughCrdtPlane(String(row.content_json ?? "")),
    text: String(row.content_text ?? ""),
  }));
}

/**
 * **唯一写入口**（本地保存那条路）。
 *
 * `dirty = 1` 是**同步契约**的一部分，不是随手写的：`sync.rs::apply_upsert`（桌面）与
 * `platform/web.ts::applyChange`（Web）的"dirty 优先本地"都靠它保护"本地改了还没推"的内容。
 *
 * ⚠️ **版本快照不在这里**（`snapshotBeforeSave` / `versions::snapshot_before_save`）：
 * 它是"版本历史策略"，不是"内容形态"；换 CRDT 后它的输入会变，但调用时机仍由保存路径决定。
 */
export function writeContent(db: ContentSql, pageId: string, content: DocContent, now: number): void {
  // CRDT 平面（Slice B）：写入前过一遍开关。**默认关 ⇒ 原样**（同一引用，逐字节等价）。
  // ⚠️ 只在这一条写出口上包，别撒到调用方 —— "只经一层"的门禁 `check-doc-content-access` 看着这里。
  const json = throughCrdtPlane(content.json);
  db.run(
    `UPDATE pages SET title = ?, content_json = ?, content_text = ?, updated_at = ?, dirty = 1
     WHERE id = ?`,
    [content.title, json, content.text, now, pageId],
  );
}

// =====================================================================================
// **CRDT 状态**（冲刺切片 S2b，2026-09-23）—— 每页一份「同一血统」的 CRDT 状态
//
// 为什么要有它：S1 判据实测「**从 JSON 新建**的状态**不可合**」（一块变两块、`blockId` 还重复，
// `crdt/mergeability.test.ts` ①）⇒ 保存形态只能是"**载入既有状态 → 在它上面演进 → 存回**"。
// 那个状态就得有个地方放 —— 就是这张 `page_crdt`。
//
// 三条边界（写清楚，免得这一层被塞进它不该管的事）：
//   ① `state` 在这一层是**不透明的 BLOB**：这一层不认识它的格式，也不许认识
//      （认识 = 把编辑器节点表拖进依赖图，见 `crdt/plane.ts` 文件头那条初始化环）；
//      生产/消费它的是 `crdt/yDocBridge.ts` 的会话，由"有编辑器的那一侧"调用。
//   ② 与 `content_json` 的关系（**S6 之前**）：`content_json` 仍然是**投影**（FTS/反链/插件/AI 继续读它），
//      `page_crdt` 是**权威**那一份。本切片不删 `content_json`、不改它的任何读者。
//   ③ 它**不是**"本地状态"（与 `page_conflicts`/`text_stale` 不同族）：已拍板的**服务端合并**要求
//      它最终能上服务端 ⇒ 同步字段（rev/dirty/seq）在 S4 加，本切片只做本地落盘。
//
// ⚠️ **桌面侧本切片只建表**（`src-tauri/src/db.rs` 同一张），读写这三条函数的 Rust 镜像归切片 S7。
// =====================================================================================

/**
 * 读这一页的 CRDT 状态字节。
 *
 * **没有**（这一页还没建过血统）⇒ `null` —— 不是空 `Uint8Array`：两者含义不同
 * （"从零开始建血统" vs "有一份空状态"），调用方要能分开。
 */
export function readPageCrdtState(db: ContentSql, pageId: string): Uint8Array | null {
  const row = db.query<{ state: unknown }>("SELECT state FROM page_crdt WHERE page_id = ?", [pageId])[0];
  if (!row) return null;
  const s = row.state;
  if (s instanceof Uint8Array) return s;
  // 兜底：驱动若按**二进制字符串**回来（sql.js 的 BLOB 是 Uint8Array，正常走不到这里），
  // 用逐字节 charCode 还原。⚠️ **别用 `Buffer`**：Web 构建里没有它。
  if (typeof s === "string") {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }
  return null;
}

/** 写这一页的 CRDT 状态（同一页只留**最新一份**：主键 upsert，不产生第二行）。 */
export function writePageCrdtState(db: ContentSql, pageId: string, state: Uint8Array, now: number): void {
  db.run(
    `INSERT INTO page_crdt (page_id, state, updated_at) VALUES (?,?,?)
     ON CONFLICT(page_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
    [pageId, state, now],
  );
}

/** 清掉这一页的 CRDT 状态（页面被删除/彻底重建时用）⇒ 之后 `readPageCrdtState` 回 `null`。 */
export function clearPageCrdtState(db: ContentSql, pageId: string): void {
  db.run("DELETE FROM page_crdt WHERE page_id = ?", [pageId]);
}

/**
 * 保存时"用新值还是**保留旧值**"的解析 —— **与桌面 `commands::save_page` 的
 * `args.X.unwrap_or(cur.X)` 同语义**：只覆盖调用方**真的带了**的字段。
 *
 * ⚠️ 这条语义是**数据安全**的一部分：改名（`savePage({ id, title })`）**必须**保留正文。
 * 桌面侧一直是这样（`unwrap_or(cur_json)`）；**Web 侧原先不是**——它用
 * `str(args.content_json ?? "")` ⇒ 只传标题就会把 `content_json`/`content_text` **清成空串**，
 * 且 `dirty = 1` 会把这份空内容**推到服务端**（改名 ⇒ 别处内容也没了）。
 * 2026-09-18 修：把这条语义收进这一层，两侧都走它。
 *
 * 判据是 **`typeof === "string"`**（不是 `!= null`）：与桌面 `Option<String>` 的反序列化一致 ——
 * `null`/缺省/数字/对象一律按"没带"处理，**不**把 `{}` 或 `123` 当内容写进去。
 */
export function resolveSaveContent(
  cur: DocContent,
  args: { title?: unknown; content_json?: unknown; content_text?: unknown },
): DocContent {
  return {
    title: typeof args.title === "string" ? args.title : cur.title,
    json: typeof args.content_json === "string" ? args.content_json : cur.json,
    text: typeof args.content_text === "string" ? args.content_text : cur.text,
  };
}

/** 合并判定用的本地读数（与 Rust 侧 `LocalState` 同形）。 */
export interface LocalContentState {
  syncSeq: number;
  dirty: number;
}

/**
 * 读本地状态（合并判定的输入）—— 与 Rust 侧 `doc_content::local_state` 同一条 SQL、同一形状。
 * 页面不存在 ⇒ `undefined`（判定把它当成"本地没有这一页 ⇒ 用远端"）。
 */
export function localState(db: ContentSql, pageId: string): LocalContentState | undefined {
  const row = db.query<{ sync_seq: number; dirty: number }>(
    "SELECT sync_seq, dirty FROM pages WHERE id = ?",
    [pageId],
  )[0];
  if (!row) return undefined;
  return { syncSeq: Number(row.sync_seq ?? 0), dirty: Number(row.dirty ?? 0) };
}

/**
 * **远端写入口** —— 合并判定说"用远端"之后，把远端那一行落库。
 *
 * 与 Rust 侧 `sync::apply_upsert` 里那段 `INSERT … ON CONFLICT` 是**同一条 SQL 的两份实现**
 * （那边还没搬进 `doc_content`，所以这里先把前端这份搬进来，两边都搬完再谈"只有一处 SQL"）。
 *
 * ⚠️ **逐字搬运**，包括那些"看起来可以省"的默认值（`?? "active"` / `?? {}` / `?? 300` …）：
 * 它们决定"远端行缺字段时本地落成什么"，不是风格问题。
 * ⚠️ **`dirty` 硬写 0**：这是把远端内容认定为"已同步"的那一笔 —— 它是**同步契约**，
 * 与 `writeContent` 硬写 1 是一对（本地改动 vs 远端应用）。
 */
export interface RemotePageRow {
  id: string;
  workspace_id?: unknown;
  parent_id?: unknown;
  title?: unknown;
  kind?: unknown;
  sort_order?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  deleted_at?: unknown;
  content_json?: unknown;
  content_text?: unknown;
  db_rule?: unknown;
  icon?: unknown;
  cover?: unknown;
  cover_height?: unknown;
  cover_pos?: unknown;
}

export function upsertRemoteContent(db: ContentSql, row: RemotePageRow, remoteSeq: number): void {
  db.run(
    `INSERT INTO pages (id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at, content_json, content_text, db_rule, icon, cover, cover_height, cover_pos, sync_seq, dirty)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, kind=excluded.kind, parent_id=excluded.parent_id, sort_order=excluded.sort_order, updated_at=excluded.updated_at, deleted_at=excluded.deleted_at, content_json=excluded.content_json, content_text=excluded.content_text, db_rule=excluded.db_rule, icon=excluded.icon, cover=excluded.cover, cover_height=excluded.cover_height, cover_pos=excluded.cover_pos, workspace_id=excluded.workspace_id, sync_seq=excluded.sync_seq, dirty=0`,
    [
      row.id,
      row.workspace_id ?? "active",
      row.parent_id ?? null,
      row.title ?? "",
      row.kind ?? "page",
      row.sort_order ?? 0,
      row.created_at ?? Date.now(),
      row.updated_at ?? Date.now(),
      row.deleted_at ?? null,
      row.content_json ?? "{}",
      row.content_text ?? "",
      row.db_rule ?? "{}",
      row.icon ?? "",
      row.cover ?? "",
      row.cover_height ?? 300,
      row.cover_pos ?? 50,
      remoteSeq,
    ],
  );
}

/**
 * ★ **合并点** —— 只有这里知道"怎么合"。
 *
 * 今天 = **页级 LWW + dirty 优先本地 + `seq` 权威**（逐字搬运自 `web.ts::applyChange`）：
 *
 * 1. 本地没有这一页 ⇒ **用远端**（新建）；
 * 2. 本地有**未推送**改动（`dirty !== 0`）⇒ **留本地**（保护用户刚改的内容）；
 * 3. 本地已同步到**更靠后**的 `seq`（`local.syncSeq > remoteSeq`）⇒ **留本地**
 *    （`seq` 是服务端单调序号，比设备时钟可靠）；
 * 4. 其余 ⇒ **用远端**。
 *
 * ⚠️ 阶段 1 把它换成块级 LWW、阶段 2/3 换成 CRDT 合并 —— **只改这个函数**（以及 Rust 侧那份）。
 * 两份实现的用例**逐条对应**，改一边必须同时看另一边。
 */
export function shouldTakeRemote(local: LocalContentState | undefined, remoteSeq: number): boolean {
  if (!local) return true; // 本地没有 → 插入（新建）
  if (local.dirty !== 0) return false; // 本地有未同步改动 → 留本地
  if (local.syncSeq > remoteSeq) return false; // 已同步到更晚的变更 → 留本地
  return true; // 远端更新（seq 更大且本地无未同步改动）→ 用远端
}

// =====================================================================================
// 阶段 1 · **块级 LWW**（第一切片：纯函数）—— 与 Rust 侧 `doc_content.rs` 的那一段**逐条对应**
//
// 裁定（2026-09-20，所有者）与逐块判定表：`docs/plans/2026-09-19-stage1-block-lww-readiness.md`
// §6/§7。三条定死的：**(a)** `blockRev` 是声明的节点属性（Lamport 计数器、随 `content_json` 走）；
// **(iii)** 缺 `blockRev` 或 rev 相等而内容不同 ⇒ **冲突、不静默选边**；rev **不参与同步**。
//
// 本切片只做纯函数：不碰 SQL、不碰协议、不碰 UI。
//
// ## 与 Rust 那份的形状对应（改一边必须同时看另一边）
//
//   · `BlockSnapshot`  ↔ `doc_content::BlockSnapshot`（`rev` 用 `undefined`/`null` 表示"缺"）
//   · `BlockChoice`    ↔ `doc_content::BlockChoice`（Rust 的 `Conflict(reason)` 在这里拆成
//                        `choice: "conflict"` ＋ `reason` 两个字段 —— 字符串联合更贴 TS 的习惯，
//                        但**判定与取值必须逐条相同**）
//   · `mergeBlocks`    ↔ `doc_content::merge_blocks`
//   · `mergePageBlocks`↔ `doc_content::merge_page_and_blocks`
//
// ## 调用顺序（④ 页级语义不许被块级推翻）
// 先 `shouldTakeRemote`（页级：`dirty` 优先本地）——它说"留本地"时**不许**用块级结果覆盖；
// 说"用远端"时才逐块比对。合成规则只写在 `mergePageBlocks` 里（唯一入口）。
//
// ## 已知边界（与 Rust 那份同一份清单）
// 1. **没有块级删除 / 墓碑**：只在一侧的块按"保留"处理（`only-local` / `only-remote`）；
// 2. **顺序 / 移动不参与合并**：顺序取页级胜方那一侧，另一侧多出来的块按自己的顺序追加在表尾；
// 3. **`rev` 是过渡量**：不许进 FTS / 反链 / 导出 / 版本历史，也不许当"最后修改时间"用。
// =====================================================================================

/** 一份「块表」里的一行：块的 id、它的 `blockRev`、该块的 JSON 片段。 */
export interface BlockSnapshot {
  blockId: string;
  /** Lamport 计数器；`undefined` / `null` = **老客户端产物**（字段被剥掉）⇒ 不静默判。 */
  rev?: number | null;
  /**
   * 该块的 JSON 片段，**不含 `blockRev` 字段**（rev 单独放在上面那个字段里）。
   *
   * ⚠️ 这不是洁癖：判定表第一行是"两侧内容**逐字节相同** ⇒ 不提示"，而老客户端"打开—原样保存"
   * **恰恰会剥掉 `blockRev`**。若把 rev 算进被比较的片段，那一行就**永远不成立** ⇒ 每次同步都提示
   * ⇒ 噪声 ⇒ 用户学会忽略 ⇒ 等于静默（反判据第二条要拦的正是这个）。去 rev 的动作由**调用方**
   * 在提取块表时做（见 `scripts/verify-two-device-sync.mjs` 的 `blocksOf`）。
   */
  json: string;
}

/** 为什么不自动选边（判定表里那两行"冲突"）。 */
export type ConflictReason = "same-rev-different-content" | "missing-rev";

/** 这一块**是怎么定的**。 */
export type BlockChoice =
  | "local" // remote.rev < local.rev ⇒ 留本地
  | "remote" // remote.rev > local.rev ⇒ 用远端
  | "identical" // 两侧内容逐字节相同 ⇒ 无事（**不许提示**）
  | "only-local" // 只有本地有（本片不做块级删除 ⇒ 保留）
  | "only-remote" // 只有远端有
  | "conflict"; // 判不了 ⇒ 不自动选边（裁定 (iii)）

/** 合并结果里的一块。 */
export interface MergedBlock {
  blockId: string;
  choice: BlockChoice;
  /** 仅 `choice === "conflict"` 时有值。 */
  reason?: ConflictReason;
  /** ⚠️ `choice === "conflict"` 时它是**本地现状占位**（本地没有则远端那一版），**不是**裁决。 */
  json: string;
  /**
   * 选中那一版的 `blockRev`（`null` = 两侧都没有这个字段）。
   *
   * ⚠️ 物化回落盘 JSON 时**必须写回去**：漏了它，合并产物就把 rev 丢了 ⇒ 下一次合并会把这一页
   * 误判成"老客户端产物"（每次同步都提示）。
   */
  rev: number | null;
}

/** 一块冲突：两侧各自的版本都带出来，UI 才有得"取回"。 */
export interface BlockConflict {
  blockId: string;
  reason: ConflictReason;
  localJson?: string;
  remoteJson?: string;
}

/** 逐块合并的结果（`conflicts` 非空 = 这次合并没有完全自动完成）。 */
export interface BlockMergeOutcome {
  blocks: MergedBlock[];
  conflicts: BlockConflict[];
}

/**
 * 两侧 rev 取**较大**那个（都缺 ⇒ `null`）。
 *
 * ⚠️ 这不是"顺手取个大值"：`identical`（内容逐字相同）那一支也用它。留下更**旧**的那个 rev
 * 会让本地下一次编辑从更低的基线加一 ⇒ 编号追不上远端已有的编号 ⇒ 远端更旧的编辑静默赢。
 * 判据：`identical_content_with_divergent_revs_converges_to_max`（Rust 侧同名）。
 */
function maxRev(a: number | null | undefined, b: number | null | undefined): number | null {
  const av = a ?? null;
  const bv = b ?? null;
  if (av === null) return bv;
  if (bv === null) return av;
  return Math.max(av, bv);
}

/**
 * ★ **块级合并点**（纯函数）：两份块表 + 页级判定 ⇒ 逐块选边。
 *
 * 判定（与 §7 那张表逐行对应，**顺序有意义**）：
 * 内容逐字节相同 ⇒ `identical`（**先判它**：老客户端"打开—原样保存"会剥掉 `rev` 而内容未变，
 * 那次**不许**提示）／`remote.rev > local.rev` ⇒ `remote`／`remote.rev < local.rev` ⇒ `local`／
 * rev 相等而内容不同 ⇒ `conflict: same-rev-different-content`／任一侧缺 rev ⇒
 * `conflict: missing-rev`／只有一侧有 ⇒ `only-local` / `only-remote`。
 */
export function mergeBlocks(
  local: readonly BlockSnapshot[],
  remote: readonly BlockSnapshot[],
  pageLevel: "local" | "remote",
): BlockMergeOutcome {
  const lmap = new Map(local.map((b) => [b.blockId, b]));
  const rmap = new Map(remote.map((b) => [b.blockId, b]));

  // 顺序：页级胜方那一侧的顺序，另一侧多出来的块按自己的顺序**追加在表尾**（已知边界 2）。
  // 同一 id 在一侧出现两次时**取第一次**（Map 的后写覆盖要绕开：这里用显式去重）。
  const [first, rest] = pageLevel === "local" ? [local, remote] : [remote, local];
  const order: string[] = [];
  for (const b of [...first, ...rest]) {
    if (!order.includes(b.blockId)) order.push(b.blockId);
  }

  const blocks: MergedBlock[] = [];
  const conflicts: BlockConflict[] = [];

  for (const id of order) {
    const l = lmap.get(id);
    const r = rmap.get(id);

    let choice: BlockChoice;
    let reason: ConflictReason | undefined;
    let json: string;
    let rev: number | null;

    if (l && r && l.json === r.json) {
      // 先判"内容逐字节相同"——含"老客户端剥了 rev 但内容没变"那条。
      // ★ rev 取**两侧较大的那个**（不是"本地优先"）：内容逐字相同 ≠ 两边一样新。
      //   老写法 `l.rev ?? r.rev` 会把本地那个更旧的 rev 留下 ⇒ 本地下一次编辑从更低的基线加一 ⇒
      //   编号追不上远端已经见过的编号 ⇒ 远端那笔更新的编辑会在随后一次合并里**静默赢过**本地这笔。
      //   ⚠️ 不为此标脏：内容逐字相同 ⇒ 没有可推的信息（rev 不参与同步）；标脏会凭空多出一笔"本地改动"。
      choice = "identical";
      json = l.json;
      rev = maxRev(l.rev, r.rev);
    } else if (l && r) {
      const lr = l.rev ?? null;
      const rr = r.rev ?? null;
      if (lr !== null && rr !== null) {
        if (rr > lr) {
          choice = "remote";
          json = r.json;
          rev = rr;
        } else if (rr < lr) {
          choice = "local";
          json = l.json;
          rev = lr;
        } else {
          choice = "conflict";
          reason = "same-rev-different-content";
          json = l.json;
          rev = lr;
        }
      } else {
        // 任一侧缺 rev（老客户端产物）⇒ 判不了就不判
        choice = "conflict";
        reason = "missing-rev";
        json = l.json;
        rev = lr ?? rr;
      }
    } else if (l) {
      choice = "only-local";
      json = l.json;
      rev = l.rev ?? null;
    } else if (r) {
      choice = "only-remote";
      json = r.json;
      rev = r.rev ?? null;
    } else {
      continue; // order 从两侧 id 的并集来 ⇒ 不可达
    }

    if (choice === "conflict") {
      conflicts.push({
        blockId: id,
        reason: reason!,
        localJson: l?.json,
        remoteJson: r?.json,
      });
    }
    blocks.push(reason ? { blockId: id, choice, reason, json, rev } : { blockId: id, choice, json, rev });
  }

  return { blocks, conflicts };
}

/** 阶段 1 的**合成入口**：先页级（`dirty` 优先本地），再逐块。 */
export type PageBlockMerge =
  | { action: "keep-local" }
  | { action: "merge"; blocks: MergedBlock[]; conflicts: BlockConflict[] };

/**
 * ★ 阶段 1 合并的**唯一调用顺序**（免得调用方各写一遍、写岔）。
 * 页级说留本地（`dirty` 或本地 `syncSeq` 更靠后）⇒ **整页都不动**，这一支**不许**再走块级合并（④）。
 */
export function mergePageBlocks(
  local: LocalContentState | undefined,
  remoteSeq: number,
  localBlocks: readonly BlockSnapshot[],
  remoteBlocks: readonly BlockSnapshot[],
): PageBlockMerge {
  if (!shouldTakeRemote(local, remoteSeq)) return { action: "keep-local" };
  const { blocks, conflicts } = mergeBlocks(localBlocks, remoteBlocks, "remote");
  return { action: "merge", blocks, conflicts };
}

// =====================================================================================
// 阶段 1 **接线用的适配器**：落盘 JSON ⇄ 块表（纯函数，不碰编辑器、不碰 SQL）
//
// 判定（`mergeBlocks`）只认"块表"，而线上两份东西都是**整页 JSON** ⇒ 中间要一层拆/装。
// 这一层刻意**保守**：宁可回落今天的行为（页级 LWW），也不猜。三条规则：
//   ① 解析不出来 / 没有 root / children 不是数组 ⇒ 不合并；
//   ② **只要有任何一个顶层块没有非空 `blockId`** ⇒ 不合并（老内容还没补种身份，别按空 id 乱配）；
//   ③ 拆出来的片段**去掉 `blockRev`**（与 `mergeBlocks` 的契约一致，见 `blockRev.ts`）。
// =====================================================================================

/**
 * 把一份文档拆成**块表**（顶层块的 `(blockId, rev, 内容片段)`）。
 *
 * 任一保守规则不满足 ⇒ `undefined`（调用方据此**回落**页级 LWW）。
 */
export function blockSnapshotsOf(docJson: string): BlockSnapshot[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(docJson);
  } catch {
    return undefined;
  }
  const root = (parsed as Record<string, unknown> | null)?.root;
  if (!root || typeof root !== "object" || Array.isArray(root)) return undefined;
  const children = (root as Record<string, unknown>).children;
  if (!Array.isArray(children)) return undefined;

  const out: BlockSnapshot[] = [];
  for (const child of children) {
    if (!child || typeof child !== "object" || Array.isArray(child)) return undefined;
    const node = child as Record<string, unknown>;
    const blockId = typeof node.blockId === "string" ? node.blockId : "";
    if (!blockId) return undefined; // 规则 ②
    const { blockRev: _dropped, ...content } = node; // 规则 ③
    // ★ 用**规范化**形态存片段（键排序、再保险地去掉任何层级的 `blockRev`）：
    //   `mergeBlocks` 比的是"逐字节相同"，而**键序不是内容** —— 两边各写自己的 `JSON.stringify`
    //   会让同一份内容因键序不同被判成"改了"（那就变成静默丢更新）。Rust 侧同一份口径。
    out.push({ blockId, rev: blockRevOf(node), json: canonicalContent(content) });
  }
  return out;
}

/**
 * 把块表（合并结果）装回一份落盘 JSON：children 换掉，根上其它字段照旧。
 *
 * ⚠️ 每一块都把 `rev` **写回去**（`blockRev` 字段）—— 漏了它，下一次合并会把这页误判成"老客户端产物"。
 */
export function applyBlockSnapshots(docJson: string, blocks: readonly MergedBlock[]): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(docJson);
  } catch {
    return undefined;
  }
  const doc = parsed as Record<string, unknown> | null;
  const root = doc?.root;
  if (!doc || !root || typeof root !== "object" || Array.isArray(root)) return undefined;

  const children = blocks.map((b) => {
    const node = JSON.parse(b.json) as Record<string, unknown>;
    if (typeof b.rev === "number") node.blockRev = b.rev;
    return node;
  });
  (root as Record<string, unknown>).children = children;
  return JSON.stringify(doc);
}

/**
 * 远端合并的三种结果。
 *
 * **别再用 `undefined` 一个值表示两件事**：调用方要区分"没什么可合"（老内容 / 脏 JSON）与
 * "**有冲突要留痕**"—— 后者必须落表（裁定 (iii)：不静默选边），否则就是"静默"。
 * **以前用一个 `undefined` 表示两件事 —— 那正是『静默』的来源**（AMD 要求把这句话写在这里）。
 */
export type RemoteMerge =
  | { kind: "not-applicable" } // 不合并（老内容 / 脏 JSON）⇒ 用远端原样（与接线前逐字相同）
  | { kind: "conflicted"; conflicts: BlockConflict[] } // 有冲突 ⇒ 用远端原样，但**要落表**
  | { kind: "merged"; json: string; keptLocal: boolean }; // 合并成功；`keptLocal` = 产物里**留下了远端没有的本地块**

/**
 * ★ **阶段 1 的远端合并**（页级说"用远端"之后调它）：把远端那一版与**本地现状**逐块比一遍。
 *
 * ⚠️ **已知边界（如实写）**：那一行的正文**仍是页级胜方那一份**，可能与合并后的 JSON 不一致
 * （合并进来的块，其正文要等下一次保存/编辑才进 FTS）。派生文本要**编辑器语义**
 * （`deriveContentText` 会拖进整张节点表 —— `docs/development.md` 记过的那条坑：node 侧 esbuild 打包
 * `smoke-web` 会炸），不能在同步路径里现算。⇒ 这是本片**故意**的取舍：**派生索引可重建**
 * （冲刺计划 §5 不变量 2），下一次保存会重建它。
 */
export function mergeRemoteContent(localJson: string, remoteJson: string): RemoteMerge {
  const localBlocks = blockSnapshotsOf(localJson);
  const remoteBlocks = blockSnapshotsOf(remoteJson);
  if (!localBlocks || !remoteBlocks) return { kind: "not-applicable" };

  const { blocks, conflicts } = mergeBlocks(localBlocks, remoteBlocks, "remote");
  if (conflicts.length > 0) return { kind: "conflicted", conflicts };

  const json = applyBlockSnapshots(remoteJson, blocks);
  if (json === undefined) return { kind: "not-applicable" };
  // ★ 产物里有没有**远端那一版没有的本地块** ⇒ 决定"正文列是否与内容不一致"（B1 的打标记条件）。
  //   ⚠️ **不能**拿"产物字符串 != 远端字符串"来判断：物化会重排键序、剥掉嵌层同名键、写回 `blockRev`
  //   ⇒ 内容逐字相同的两端也会得到**不同的字符串**（第一版就是这么误判的，被脚本场景 N 当场抓住）。
  const keptLocal = blocks.some((b) => b.choice === "local" || b.choice === "only-local");
  return { kind: "merged", json, keptLocal };
}

/** 把一份文档里某个**顶层块**的内容换成另一个（裁决入口用）。块不在这份文档里 ⇒ `undefined`。 */
export function replaceBlockContent(docJson: string, blockId: string, blockJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(docJson);
  } catch {
    return undefined;
  }
  const doc = parsed as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") return undefined;
  const root = doc.root as Record<string, unknown> | undefined;
  const children = root?.children;
  if (!Array.isArray(children)) return undefined;

  let replacement: unknown;
  try {
    replacement = JSON.parse(blockJson);
  } catch {
    return undefined;
  }

  let hit = false;
  const next = children.map((child) => {
    const node = child as Record<string, unknown>;
    if (!hit && node?.blockId === blockId) {
      hit = true;
      return replacement;
    }
    return child;
  });
  if (!hit) return undefined;
  root!.children = next;
  return JSON.stringify(doc);
}

/** 一处冲突（表 `page_conflicts` 的一行；`resolvedAt` 为空 = **未裁决**）。 */
export interface PageConflictRow {
  id: string;
  pageId: string;
  blockId: string;
  reason: ConflictReason;
  localJson: string;
  remoteJson: string;
  detectedAt: number;
  resolvedAt?: number | null;
  resolvedChoice?: string | null;
}

/** 裁决时选哪一侧。 */
export type ConflictChoice = "local" | "remote";

/**
 * 把这次合并报出的冲突**落表**（同一页同一块已有未决记录 ⇒ 先删旧的那条，避免堆积）。
 *
 * ⚠️ 表 `page_conflicts` 由平台 schema 建（桌面 `db.rs::migrate` / Web `sqliteStore.ts`），
 * 两边列名逐字一致。
 */
export function recordPageConflicts(db: ContentSql, pageId: string, conflicts: readonly BlockConflict[]): void {
  const now = Date.now();
  for (const cf of conflicts) {
    db.run("DELETE FROM page_conflicts WHERE page_id = ? AND block_id = ? AND resolved_at IS NULL", [
      pageId,
      cf.blockId,
    ]);
    db.run(
      `INSERT INTO page_conflicts
         (id, page_id, block_id, reason, local_json, remote_json, detected_at, resolved_at, resolved_choice)
       VALUES (?,?,?,?,?,?,?,NULL,NULL)`,
      [
        newBlockId(), // 与块身份共用**同一个** id 生成器（别在这一层再写第二份）
        pageId,
        cf.blockId,
        cf.reason,
        cf.localJson ?? "",
        cf.remoteJson ?? "",
        now,
      ],
    );
  }
}

/** 这一页**未裁决**的冲突（按发现时间；提示 UI 就用它）。 */
export function pageConflictsOf(db: ContentSql, pageId: string): PageConflictRow[] {
  const rows = db.query<{
    id: string;
    page_id: string;
    block_id: string;
    reason: string;
    local_json: string;
    remote_json: string;
    detected_at: number;
    resolved_at: number | null;
    resolved_choice: string | null;
  }>(
    `SELECT id, page_id, block_id, reason, local_json, remote_json, detected_at, resolved_at, resolved_choice
     FROM page_conflicts WHERE page_id = ? AND resolved_at IS NULL ORDER BY detected_at, block_id`,
    [pageId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    pageId: String(row.page_id),
    blockId: String(row.block_id),
    reason: String(row.reason) as ConflictReason,
    localJson: String(row.local_json ?? ""),
    remoteJson: String(row.remote_json ?? ""),
    detectedAt: Number(row.detected_at ?? 0),
    resolvedAt: row.resolved_at === null || row.resolved_at === undefined ? null : Number(row.resolved_at),
    resolvedChoice: row.resolved_choice ?? null,
  }));
}

/**
 * ★ **裁决一处冲突**：把选中的那一版写回该块、**盖新 rev**（baseline = 当前页）、落库并标记已决。
 *
 * `writeContent` 会置 `dirty = 1` ⇒ 这次裁决本身是**一笔本地编辑**，会被推上去（"留本地"就是这么生效的）。
 *
 * ⚠️ 与合并路径同一条已知边界：正文文本这一次**不重算** —— 下一次保存/编辑会重建。
 */
export function resolvePageConflict(db: ContentSql, conflictId: string, choice: ConflictChoice): void {
  const row = db.query<{ page_id: string; block_id: string; local_json: string; remote_json: string }>(
    "SELECT page_id, block_id, local_json, remote_json FROM page_conflicts WHERE id = ? AND resolved_at IS NULL",
    [conflictId],
  )[0];
  if (!row) throw new Error("冲突不存在或已裁决");

  const pageId = String(row.page_id);
  const page = readContent(db, pageId);
  if (!page) throw new Error("页面不存在");

  const chosen = choice === "local" ? String(row.local_json ?? "") : String(row.remote_json ?? "");
  const next = replaceBlockContent(page.json, String(row.block_id), chosen);
  if (next === undefined) throw new Error("这一块已不在页面里（页面在裁决前又变过）");

  const stamped = assignBlockRevs(page.json, next);
  writeContent(db, pageId, { title: page.title, json: stamped, text: page.text }, Date.now());
  // ★ B1：裁决也是"内容拼出来的"（换成选中那一块）⇒ 正文列仍是写回前那一份 ⇒ 打"待重建"。
  markTextStale(db, pageId);
  db.run("UPDATE page_conflicts SET resolved_at = ?, resolved_choice = ? WHERE id = ?", [
    Date.now(),
    choice,
    conflictId,
  ]);
}

/**
 * **正文文本的本地修复**（阶段 1 · "正文待重建"那条边界的收口）—— 与 Rust 侧 `write_text` 同一语义。
 *
 * 什么时候需要它：合并 / 裁决产物是**拼出来**的，正文文本仍是页级胜方那一份 ⇒ 那一页的 FTS 会有一段时间
 * "搜不到刚合并进来的字"，要等下一次保存才重建。修法（**不引第二份派生实现**）：有编辑器的那一侧在打开
 * 页面时按编辑器语义算一遍，与库里那份不同就写回来 —— **只动正文文本**：① 不动内容 JSON、② **不动 `dirty`**
 * （它不是用户编辑，标脏会把它当成本地改动推上去）。
 */
export function writeContentText(db: ContentSql, pageId: string, text: string): void {
  db.run("UPDATE pages SET content_text = ? WHERE id = ?", [text, pageId]);
}

/**
 * **正文文本的本地修复（带判据的那一个）**：拿库里那一份与算出来的比，**不同才写回**
 * （相同 ⇒ 正文列一次写库都没有）。返回**是否修了**。
 *
 * ⚠️ 比较放在**这一层**而不是调用方：调用方（编辑器插件 / 补算器）只负责"按编辑器语义算一遍"，
 * 让它顺手读那一列会把收口门禁顶红（`App.tsx` 那类界面文件的计数只许减不许增）。
 * ⚠️ 两条出口都要**清掉"待重建"标记**（B1）：① 真的修了；② 算出来与库里那份**相同**
 * （合并可能并没有改动这一页的正文 ⇒ 它本来就不该留在队列里）。
 */
export function refreshPageTextIfStale(db: ContentSql, pageId: string, derived: string): boolean {
  const cur = readContent(db, pageId);
  const repaired = repairPageTextIfStale(
    { refresh: (id, text) => writeContentText(db, id, text) },
    pageId,
    cur?.text,
    derived,
  );
  if (cur) clearTextStale(db, pageId);
  return repaired;
}

// =====================================================================================
// 「正文待重建」标记（B1，2026-09-22）—— 与 Rust 侧 `doc_content.rs` 的同名一节**逐条对应**
//
// 合并产物（`merged`）与冲突裁决都是"内容拼出来的"，而正文列仍是页级胜方那一份 ⇒ 那一页
// **搜不到刚合并进来的字**。这一列就是"补算器"的工作队列。三条纪律（与 Rust 侧同一份）：
//   ① **本地状态**：不同步、不进导出（与 `page_conflicts` 同族）；
//   ② **不许在读路径上惰性重建**（macOS）：读的时候只读标记；
//   ③ 只打在"内容变了、正文列没跟着变"的两条路上（合并产物 / 裁决写回）。
// =====================================================================================

/** 这一页的正文列是不是"待重建"；页面不存在 ⇒ `undefined`。 */
export function textStale(db: ContentSql, pageId: string): boolean | undefined {
  const row = db.query<{ text_stale: number }>(
    "SELECT COALESCE(text_stale, 0) AS text_stale FROM pages WHERE id = ?",
    [pageId],
  )[0];
  return row ? Number(row.text_stale ?? 0) !== 0 : undefined;
}

/**
 * 打上"待重建"（合并产物 / 裁决写回之后调它）。
 *
 * ★ **数据库页不打**（2026-09-23，P3-② 接线之后才成立的事实）。理由是**结构**的，不是"算出来恰好是空"：
 * 数据库页的正文 ＝ **列名 ＋ 行 ＋ 规则** —— 列/行在**数据库表**里、筛选/排序规则在**视图侧**手上，
 * 而补算器（`TextRepairRunner` → `deriveContentText`）的输入**只有 `content_json`**
 * ⇒ 它**无论**从那份 JSON 里读出什么，算出来的都**不可能是**这一页该有的正文 ⇒ 任何写回都是**有损**的
 * （把视图侧写好的行文本抹掉：搜索里整页行内容消失，直到那页被重新打开）。
 *
 * ⚠️ **别把理由写成"数据库页的 JSON 是 `{}` ⇒ 算出来是空串"**：那是当前的数据形态，不是结构事实。
 * 哪天有人往那份 JSON 里放个文本镜像（导出/预览用），那个版本的保护会**静默失效** ——
 * 补算器写回的不再是空串，但**依然是**抹掉列/行。
 */
export function markTextStale(db: ContentSql, pageId: string): void {
  db.run("UPDATE pages SET text_stale = 1 WHERE id = ? AND kind <> 'database'", [pageId]);
}

/** 清掉"待重建"（正文列刚被重建过一次）。**没置着就一次写库都不做**。 */
export function clearTextStale(db: ContentSql, pageId: string): void {
  db.run("UPDATE pages SET text_stale = 0 WHERE id = ? AND text_stale = 1", [pageId]);
}

/** 队列里的一页。字段叫 `docJson`（不是存储列名）—— 界面侧不必去碰"文档内容层的那两列"。 */
export interface StaleTextPage {
  pageId: string;
  title: string;
  docJson: string;
}

/** 队列 ＋ 总数（`total` 单独给：界面要能说"**还有 N 页**"，而 `pages` 只是这一批）。 */
export interface StaleTextQueue {
  total: number;
  pages: StaleTextPage[];
}

/**
 * ★ **待重建正文的队列**：按"最近改过的优先"给补算器一批页面（`limit` 夹到 1..=50）。
 *
 * ⚠️ **双保险：数据库页不入队**（结构与理由见 `markTextStale` 的注释）。标记侧已经不打数据库页了，
 * 这里再排一次是为了**存量库** —— 在接线（`1e68f680`）之前被标过的数据库页 `text_stale` 还是 1，
 * 而它们一旦被补算就会把行文本抹掉。两处口径必须一致（Rust 侧同名函数同步改）。
 *
 * ★★ **COUNT 与 SELECT 必须带同一个 `WHERE`**（macOS 2026-09-23 指出）：补算器是用
 * `remaining = total - pages.length` 判断"还要不要继续"的（`TextRepairRunner.tsx:56`）⇒
 * 只给其中一条加过滤，`total` 就会永远 ≥ 1 ⇒ 每轮空转到预算耗尽、界面长期显示"还有 N 页"而 N 不降。
 */
export function staleTextQueue(db: ContentSql, limit = 10): StaleTextQueue {
  const total =
    Number(
      db.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM pages WHERE text_stale = 1 AND deleted_at IS NULL AND kind <> 'database'",
      )[0]?.n ?? 0,
    ) || 0;
  const lim = Math.max(1, Math.min(50, Math.trunc(limit) || 10));
  const rows = db.query<{ id: string; title: string; doc_json: string }>(
    `SELECT id, title, content_json AS doc_json FROM pages
     WHERE text_stale = 1 AND deleted_at IS NULL AND kind <> 'database'
     ORDER BY updated_at DESC, id ASC LIMIT ?`,
    [lim],
  );
  return {
    total,
    pages: rows.map((r) => ({ pageId: String(r.id), title: String(r.title ?? ""), docJson: String(r.doc_json ?? "") })),
  };
}

/**
 * 一次远端应用的**结果**（"留痕 ≠ 已裁决" ⇒ 调用方必须能看见"有未裁决冲突"，哪怕只是个计数）。
 *
 * ⚠️ `unresolved` 是**这一轮新落表的条数**，不是"这一页未裁决总数" —— 总数查 `pageConflictsOf`
 *（上一轮留下的未裁决记录不会因为这一轮合得上而消失，那是两件事）。
 */
export interface AppliedRemoteContent {
  /** 这次是不是走了"逐块合并"那一支（`false` = 用远端原样，与接线前逐字相同）。 */
  merged: boolean;
  /** 这次落表了几处未裁决的冲突（0 = 没有）。 */
  unresolved: number;
}

/**
 * ★ **阶段 1 的远端落库入口**（唯一）：页级说"用远端"之后，调用方只调这一个。
 *
 * 内部按顺序做（顺序就是裁定 ④ 要求的那条：**页级优先，块级只在其后**）：
 *   1. 读**本地现状**（读出口 `readContent`）；
 *   2. 试一次逐块合并（`mergeRemoteContent`）；
 *   3. 按结果落库：`merged` ⇒ 用合并产物；`conflicted` ⇒ **先落冲突表**、再用远端原样
 *      （页级 LWW，与接线前**逐字相同** —— 这一片只是把"静默"变成"有痕"，**不改覆盖语义**）；
 *      `not-applicable` ⇒ 用远端原样。
 *
 * 返回值见 `AppliedRemoteContent`（不合并**不是错误**，是"没什么可合"）。
 *
 * ⚠️ 为什么把这几步收在一层里（而不是让 `web.ts` 自己拼）：`web.ts` 是**受收口门禁约束**的文件
 * （`content_json` 计数只许减不许增），把"读远端那一版 / 写回合并产物"留在那一层之外做，
 * 门禁会当场红（本片第一次落地就是被它拦下的）。
 */
export function applyRemoteContent(
  db: ContentSql,
  pageId: string,
  row: RemotePageRow,
  remoteSeq: number,
): AppliedRemoteContent {
  const local = readContent(db, pageId);
  const remoteJson = typeof row.content_json === "string" ? row.content_json : "";
  const outcome: RemoteMerge = local
    ? mergeRemoteContent(local.json, remoteJson)
    : { kind: "not-applicable" };

  if (outcome.kind === "merged") {
    upsertRemoteContent(db, { ...row, content_json: outcome.json }, remoteSeq);
    // ★ B1：**只有产物里留下了远端那一版没有的本地块**才打"待重建"。
    //   否则产物就是远端那份内容（正文列正是它）⇒ 打了就是**假账**（补算器白解析一次再清掉）。
    if (outcome.keptLocal) markTextStale(db, pageId);
    return { merged: true, unresolved: 0 };
  }
  if (outcome.kind === "conflicted") {
    // ★ 裁定 (iii)：**不静默选边** ⇒ 先把冲突落表（提示 UI 的数据），覆盖语义不变。
    recordPageConflicts(db, pageId, outcome.conflicts);
    upsertRemoteContent(db, row, remoteSeq);
    return { merged: false, unresolved: outcome.conflicts.length };
  }
  upsertRemoteContent(db, row, remoteSeq);
  return { merged: false, unresolved: 0 };
}

// =====================================================================================
// 「未取回的远端版本」（B 方案，2026-09-22）：页级保留本地时，**那一版远端内容留在这里**
//
// 与 Rust 侧 `doc_content.rs` 的同名一节**一一对应**（判据也成对：`docContent.test.ts` ↔
// `doc_content.rs` 的 `pending_remote_*` 那几条）。要修的东西见取证文件
// `docs/plans/2026-09-22-merge-push-and-cursor-forensics.md` §6 方案 B：
// 页级 `KeepLocal` **语义正确**，但那一版远端内容会被**游标吃掉** ⇒ 这台设备再也取不回对端那笔编辑，
// 而且层里一条痕都没有。游标不能为它停住（朴素方案 A 会 livelock），所以：**照旧推进，但存下来**。
//
// ⚠️ 三条纪律（与 `page_conflicts` / `text_stale` 同族）：本地状态（不同步、不进导出）；
//    每页只留最新一条；存的是**远端那一版整页 JSON**（明文，与 `content_json` 同形态）。
// =====================================================================================

/** 一页「未取回的远端版本」的读数（界面列表用；**不含 payload 本体**）。 */
export interface PendingRemotePage {
  page_id: string;
  title: string;
  /** 远端那一版的 `seq`（服务端单调序号）。 */
  seq: number;
  remote_updated_at: number;
  stashed_at: number;
}

/** 列表 ＋ 总数（与 `StaleTextQueue` 同形：界面要能说"还有 N 页"）。 */
export interface PendingRemoteQueue {
  total: number;
  pages: PendingRemotePage[];
}

/** 把**这一版远端内容**存下来（页级保留本地那一条分支调用）。每页只留最新一条。 */
export function stashPendingRemote(db: ContentSql, row: RemotePageRow, seq: number, now: number): void {
  db.run(
    `INSERT INTO pending_remote_pages (page_id, seq, title, payload, remote_updated_at, stashed_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(page_id) DO UPDATE SET
       seq = excluded.seq, title = excluded.title, payload = excluded.payload,
       remote_updated_at = excluded.remote_updated_at, stashed_at = excluded.stashed_at`,
    [String(row.id), seq, String(row.title ?? ""), JSON.stringify(row), Number(row.updated_at ?? 0), now],
  );
}

/** 待取回的远端版本队列（`limit` 由调用方给 —— 这是界面列表，不是批量作业）。 */
export function pendingRemoteQueue(db: ContentSql, limit = 20): PendingRemoteQueue {
  const total = Number(
    db.query<{ n: number }>("SELECT COUNT(*) AS n FROM pending_remote_pages")[0]?.n ?? 0,
  );
  const rows = db.query<Record<string, unknown>>(
    `SELECT page_id, title, seq, remote_updated_at, stashed_at FROM pending_remote_pages
     ORDER BY stashed_at DESC, page_id LIMIT ?`,
    [limit],
  );
  return {
    total,
    pages: rows.map((r) => ({
      page_id: String(r.page_id),
      title: String(r.title ?? ""),
      seq: Number(r.seq),
      remote_updated_at: Number(r.remote_updated_at),
      stashed_at: Number(r.stashed_at),
    })),
  };
}

/** 这一页待取回那一版的 `seq`（`undefined` = 没有）。给 `applyChange` 判断"新应用的这版是否已经比它新"。 */
export function pendingRemoteSeq(db: ContentSql, pageId: string): number | undefined {
  const row = db.query<{ seq: number }>(
    "SELECT seq FROM pending_remote_pages WHERE page_id = ?",
    [pageId],
  )[0];
  return row ? Number(row.seq) : undefined;
}

/** 这一页**待取回**的那一版（`seq` ＋ 整页 wire 行）。没有 ⇒ `undefined`。 */
export function pendingRemotePayload(
  db: ContentSql,
  pageId: string,
): { seq: number; row: RemotePageRow } | undefined {
  const row = db.query<{ seq: number; payload: string }>(
    "SELECT seq, payload FROM pending_remote_pages WHERE page_id = ?",
    [pageId],
  )[0];
  if (!row) return undefined;
  try {
    return { seq: Number(row.seq), row: JSON.parse(String(row.payload)) as RemotePageRow };
  } catch {
    return undefined; // 存档坏了就当没有（界面会提示"没有待取回的版本"）
  }
}

/** 清掉这一页待取回的那一版（裁决完 / 更新的远端版本已经应用过 ⇒ 旧的这条是陈的）。 */
export function clearPendingRemote(db: ContentSql, pageId: string): void {
  db.run("DELETE FROM pending_remote_pages WHERE page_id = ?", [pageId]);
}

/** 标记这一页"有未推送改动"（对应 Rust `mark_page_dirty`；`dirty` 是同步契约的一部分）。 */
export function markPageDirty(db: ContentSql, pageId: string): void {
  db.run("UPDATE pages SET dirty = 1 WHERE id = ?", [pageId]);
}

/**
 * **采用远端**（整页、不走块级合并）：与 `upsertRemoteContent` 的区别就是不试逐块合并
 * （用户明确选择"就要远端这份"）。
 *
 * ⚠️ 两件事一起做：① 覆盖内容（`dirty` 硬写 0）；② 把这一页**未裁决的块级冲突一次性标掉** ——
 * 那些痕记的是"旧本地版 vs 旧远端版"，整页换掉之后它们已经没有可裁决的对象了。
 * ⚠️ 变更日志那一半（把这一页还没推上去的本地改动丢掉）在 `web.ts` 的同名路径里 —— 那一层不属于本文件。
 */
export function takeRemoteWholePage(db: ContentSql, row: RemotePageRow, remoteSeq: number): void {
  upsertRemoteContent(db, row, remoteSeq);
  db.run(
    "UPDATE page_conflicts SET resolved_at = ?, resolved_choice = ? WHERE page_id = ? AND resolved_at IS NULL",
    [Date.now(), "remote", String(row.id)],
  );
}
