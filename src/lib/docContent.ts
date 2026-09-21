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
    json: String(row.content_json ?? ""),
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
    json: String(row.content_json ?? ""),
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
  db.run(
    `UPDATE pages SET title = ?, content_json = ?, content_text = ?, updated_at = ?, dirty = 1
     WHERE id = ?`,
    [content.title, content.json, content.text, now, pageId],
  );
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

    if (l && r && l.json === r.json) {
      // 先判"内容逐字节相同"——含"老客户端剥了 rev 但内容没变"那条
      choice = "identical";
      json = l.json;
    } else if (l && r) {
      const lr = l.rev ?? null;
      const rr = r.rev ?? null;
      if (lr !== null && rr !== null) {
        if (rr > lr) {
          choice = "remote";
          json = r.json;
        } else if (rr < lr) {
          choice = "local";
          json = l.json;
        } else {
          choice = "conflict";
          reason = "same-rev-different-content";
          json = l.json;
        }
      } else {
        // 任一侧缺 rev（老客户端产物）⇒ 判不了就不判
        choice = "conflict";
        reason = "missing-rev";
        json = l.json;
      }
    } else if (l) {
      choice = "only-local";
      json = l.json;
    } else if (r) {
      choice = "only-remote";
      json = r.json;
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
    blocks.push(reason ? { blockId: id, choice, reason, json } : { blockId: id, choice, json });
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
