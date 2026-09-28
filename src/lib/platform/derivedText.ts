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

/**
 * 某个抽取器上一次报的**覆盖度**（§15.10：成功 ≠ 抽全了）。
 *
 * `coverage` 是**原始 JSON 字符串**，`''` ＝ 没有这一格（旧数据 / 那个抽取器没报）。
 * ⚠️ 这里**不解析** —— 解析口径（空串或坏 JSON ⇒ 未知，而未知**不是**完整）只在
 * `extract/store.ts::storedCoverageFrom` 一处；读页面只是把它**原样带给调用方**。
 */
export interface AttachmentTextCoverageDto {
  extractor: string;
  coverage: string;
}

export interface AttachmentTextPageDto {
  segments: AttachmentTextSegmentDto[];
  total: number;
  truncated: boolean;
  /** 每个抽取器上次报的覆盖度；**空数组 ＝ 没有读数**（未知，不是"抽全了"）。 */
  coverage: AttachmentTextCoverageDto[];
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
 * 所以这里逐字段对齐：缺表当空、`(extractor, seq)` 排序、`total` 用 COUNT、越界不报错、
 * **覆盖度去重且缺列当空**）。
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
  if (!hasTable) return { segments: [], total: 0, truncated: false, coverage: [] };

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
    coverage: readCoverageVia(db, id),
  };
}

/**
 * 覆盖度读数（`DISTINCT` + 按 `extractor` 排序）。
 *
 * 两条口径与桌面 `search.rs::read_attachment_text_coverage_in_conn` **逐条对齐**
 * （两边各写一份，所以这里写得跟那边一模一样：排序、**只吞缺列**）：
 *
 * 1. **`DISTINCT` 去的是整行相同的重复**（同一份读数逐段重复在所有段行上）；
 *    同一 extractor 若有**两份不同**读数 ⇒ 两行都回（**不替调用方挑** —— 挑就是静默丢一条）。
 * 2. **老库（迁移没跑过）没有 `coverage` 列 ⇒ 没有读数**（未知），不让整条读失败。
 *
 * ⚠️ **口径收窄（2026-09-23，Windows 侧审出来的）**：原来这里是 `catch { return [] }`，
 * 把**数据库锁住／表损坏／将来 SQL 打错一个字**全都翻译成"没有覆盖度读数" ——
 * 而"未知"在这条链上是**承重**的答复，不该当所有失败的垃圾桶（同一笔提交里
 * `db.rs::migrate` 那条 ALTER 就只吞 `duplicate column name`，口径应当一致）。
 * ⇒ 现在**只认缺列**（`no such column`），其余照原样抛；调用方要降级得**写明**降级。
 *
 * ⚠️ **与桌面那半的"故意不对称"**（读的时候别当成漂了）：`search.rs` 那半多吞一种
 * `no such table` —— 因为运输层的查询**没有**前置守卫（派生层没初始化时照样会被调用）。
 * 而本函数的唯一调用点在 `readAttachmentTextVia` 的 `hasTable` 检查**之后** ⇒ 表不在这条路走不到，
 * 所以这里**不写**那个分支（写它就是加一条不可达的代码，比一处写明的不对称更坏）。
 */
function readCoverageVia(db: DerivedTextQuery, attId: string): AttachmentTextCoverageDto[] {
  try {
    return db
      .query<AttachmentTextCoverageDto>(
        "SELECT DISTINCT extractor, coverage FROM attachment_text WHERE att_id = ? ORDER BY extractor ASC",
        [attId],
      )
      .map((r) => ({ extractor: r.extractor, coverage: String(r.coverage ?? "") }));
  } catch (e) {
    const msg = String((e as { message?: unknown } | null)?.message ?? e ?? "");
    if (/no such column/i.test(msg)) return []; // 老库没有 coverage 列 ⇒ 没有读数（未知）
    throw e; // 锁住/损坏/SQL 打错 ⇒ **照原样抛**，不许静默变成"没有读数"
  }
}
