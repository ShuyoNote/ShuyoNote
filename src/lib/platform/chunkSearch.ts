// 块级检索（Web 侧）的**平台无关那一半** —— 与 `derivedText.ts` 同一个理由：
// 逻辑原先写在 `web.ts` 的 `if (cmd === "search_chunks")` 分支里，读的是该文件私有的 store，
// 于是**一条 SQL 都测不到**（只有 `check-web-commands` 的契约级覆盖）。
//
// 抽出来之后，测试可以用**真 `SqliteStore`（真 sql.js、真平台 schema）**驱动它，
// 把"缺表 ‖ 两类 owner ‖ 排序 ‖ 回链三件套"这些**跑起来才知道**的事情变成判据。
//
// ⚠️ **抽出来的只是"DB + 排序"**：向量加分由调用方算好、以 `bonusById` 注入 ——
// 因为算它要读用户的嵌入配置、调模型（`web.ts` 那层的职责），而这一步不该混进"读块、排序"里。
// 这样也顺手让"向量那半"变成了可单独验的纯输入（一个 Map）。

import { truncateByCodePoints } from "../textSnippet";
import type { DerivedTextQuery } from "./derivedText";

export interface ChunkHitDto {
  chunkId: string;
  pageId: string | null;
  attId: string | null;
  ord: number;
  loc: string;
  snippet: string;
  score: number;
}

/** 与桌面 `CHUNK_VECTOR_BONUS` 同一个思路：向量加分**有界**，不主导关键词。 */
export const CHUNK_VECTOR_BONUS = 6;

/** 片段长度（与页面级 `truncateChars(..., 120)` 同一口径）。 */
const SNIPPET_LEN = 120;

/** 一页最多多少条命中（与注册表 `search_chunks` 的 `limit` 口径一致）。 */
export const MAX_CHUNK_HITS = 100;

export interface ChunkRowDto {
  id: string;
  page_id: string | null;
  att_id: string | null;
  ord: number;
  loc: string;
  text: string;
  hash: string;
}

/** 关键词排序用：与页面检索**同一套打分**（`rankPagesForSearch`）—— 块没有标题，标题传空串。 */
export type RankFn = (
  query: string,
  rows: { id: string; title: string; content_text: string; updated_at: number }[],
) => { id: string; score: number }[];

// ⚠️ 按**码点**截断（`truncateByCodePoints`）：`slice` 会把 emoji 的代理对切成一半，
///  用户看到 "a�…"。这条口径集中在 `textSnippet.ts`（有判据）。

/**
 * 块级检索：读 `chunks`（两类 owner 都在同一张表里）→ 关键词排序 → 叠加调用方给的向量加分 → 截断。
 *
 * `null` 不在这里出现：`chunks` 表不在（老库没迁移）与"一条都没命中"都返回**空数组**，
 * 与桌面侧的口径一致（"没查"与"没有"在这一层不区分，调用方看的是"有没有命中"）。
 *
 * `bonusById` 只对**已经命中关键词**的块生效（与桌面 `rank_chunks` 一致）：
 * 否则纯向量相似会把关键词完全不相关的块顶上来，那与"检索"的语义不符。
 */
export function searchChunksVia(
  db: DerivedTextQuery,
  query: string,
  limit: number,
  rank: RankFn,
  bonusById?: ReadonlyMap<string, number>,
): ChunkHitDto[] {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const lim = Math.min(MAX_CHUNK_HITS, Math.max(1, Math.floor(limit) || 1));

  const hasChunks =
    db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'").length > 0;
  if (!hasChunks) return [];

  const rows = db.query<ChunkRowDto>("SELECT id, page_id, att_id, ord, loc, text, hash FROM chunks");
  if (rows.length === 0) return [];

  const byId = new Map(rows.map((r) => [r.id, r]));
  const ranked = rank(
    q,
    rows.map((r) => ({ id: r.id, title: "", content_text: r.text, updated_at: 0 })),
  );

  return ranked
    .map((r) => ({ r, score: r.score + (bonusById?.get(r.id) ?? 0) }))
    .sort((x, y) => y.score - x.score || String(x.r.id).localeCompare(String(y.r.id)))
    .slice(0, lim)
    .map(({ r, score }) => {
      const row = byId.get(r.id)!;
      return {
        chunkId: row.id,
        pageId: row.page_id,
        attId: row.att_id,
        ord: row.ord,
        loc: row.loc,
        snippet: truncateByCodePoints((row.text ?? "").trim(), SNIPPET_LEN),
        score,
      };
    });
}
