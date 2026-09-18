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

/** 合并判定用的本地读数（与 Rust 侧 `LocalState` 同形）。 */
export interface LocalContentState {
  syncSeq: number;
  dirty: number;
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
