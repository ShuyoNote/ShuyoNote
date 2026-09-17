// 附件**派生文本**的读取逻辑（平台无关的那一半）。
//
// ## 为什么把它从 `web.ts` 里抽出来
// 逻辑原先直接写在 `web.ts`（3700+ 行）的 `if (cmd === "read_attachment_text")` 分支里，
// 而那条分支**测不到**：它读的是 `web.ts` 私有的那个 store，测试没法拿到句柄
// （这与我在 `files.search` 上如实报过的覆盖缺口是同一件事）。
//
// 抽成"**接受一个最小 SQL 句柄**"的函数之后：
//   · `web.ts` 只是把它接到自己的 store 上（一行）；
//   · 测试可以用**真的 `SqliteStore`（真 sql.js、真 SQL）**驱动它 —— 于是
//     "参数绑定对不对 / 缺表怎么办 / 分页与 total 算得对不对"这些**都进了判据**，
//     而不是留在"契约级覆盖"（`check-web-commands` 只保证分支存在、形状对）。
//
// ⚠️ 抽出来的是**数据库那半**，不是整个命令：`web.ts` 仍需自己做命令参数的归一（`a.args ?? a`）。

/** 只需要这一个能力 —— 与 `SqliteStore.query` 同形，别的实现（如测试里的桩）也能用。 */
export interface DerivedTextQuery {
  query<T>(sql: string, params?: readonly unknown[]): T[];
}

export interface AttachmentTextSegmentDto {
  extractor: string;
  kind: string;
  text: string;
  loc: string;
}

export interface AttachmentTextPageDto {
  segments: AttachmentTextSegmentDto[];
  total: number;
  truncated: boolean;
}

/** 一页最多取多少段（与注册表 `files.read` 的 `limit` desc 一致，也与 Rust 侧常量同值）。 */
export const MAX_ATT_TEXT_LIMIT = 1000;

/**
 * 读某个附件的派生文本（分页）。
 *
 * 返回值的三种语义（**必须分开**，否则调用方会把"还没抽过"读成"文件里没有内容"）：
 * - `null`：**附件不存在**（`attachments` 里没有它）；
 * - `{segments: [], total: 0}`：存在，但**还没有派生文本**（没抽过 / 没有抽取器认领 / 抽取失败）；
 * - 有段：正常返回，`total` 是**总段数**（不是本页条数），`truncated` 表示"还有没给你的"。
 *
 * 与桌面 `search.rs::read_attachment_text_in_conn` **同语义**（两边各写一份，
 * 所以这里逐字段对齐：缺表当空、`(extractor, seq)` 排序、`total` 用 COUNT、越界不报错）。
 */
export function readAttachmentTextVia(
  db: DerivedTextQuery,
  attId: string,
  offset = 0,
  limit = 200,
): AttachmentTextPageDto | null {
  const id = String(attId ?? "").trim();
  if (!id) return null;
  const off = Math.max(0, Math.floor(offset) || 0);
  const lim = Math.min(MAX_ATT_TEXT_LIMIT, Math.max(1, Math.floor(limit) || 1));

  const att = db.query<{ id: string }>("SELECT id FROM attachments WHERE id = ?", [id]);
  if (att.length === 0) return null;

  // 老库没迁移过这张表 ⇒ 与"还没抽过"同一种答复（不是错误）
  const hasTable =
    db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='attachment_text'")
      .length > 0;
  if (!hasTable) return { segments: [], total: 0, truncated: false };

  const total = Number(
    db.query<{ n: number }>("SELECT COUNT(*) AS n FROM attachment_text WHERE att_id = ?", [id])[0]?.n ?? 0,
  );
  const rows = db.query<AttachmentTextSegmentDto>(
    `SELECT extractor, kind, text, loc FROM attachment_text
     WHERE att_id = ? ORDER BY extractor ASC, seq ASC LIMIT ? OFFSET ?`,
    [id, lim, off],
  );
  return {
    segments: rows.map((r) => ({ extractor: r.extractor, kind: r.kind, text: r.text, loc: r.loc })),
    total,
    truncated: off + rows.length < total,
  };
}
