// M20.2 — embedding-free semantic similarity using char-bigram overlap (Jaccard).
// Works offline, tolerates near-repeats/partial matches, and is unit-testable.
// A real vector-embedding endpoint can layer on top later without changing this API.

/** Split text into latin words and CJK runs, then emit character bigrams (and
 *  single-char parts) for overlap scoring. */
export function charBigrams(s: string): Set<string> {
  const out = new Set<string>();
  const lower = String(s ?? "").toLowerCase();
  const parts = lower.match(/[\u4e00-\u9fff\u3040-\u30ff]+|[a-z0-9]+/g) ?? [];
  for (const part of parts) {
    if (part.length === 1) {
      out.add(part);
      continue;
    }
    for (let i = 0; i + 1 < part.length; i++) out.add(part.slice(i, i + 2));
  }
  return out;
}

/** Jaccard overlap of the query's bigrams with a target's. 0 → no similarity. */
export function semanticScore(query: string, target: string): number {
  const a = charBigrams(query);
  const b = charBigrams(target);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

/** Rank docs by semantic similarity to `query` (title + content_text). */
export function semanticRank<T extends { id: string; title: string; content_text: string }>(query: string, docs: T[]): T[] {
  const q = String(query ?? "").trim();
  if (!q) return [];
  return docs
    .map((d) => ({ doc: d, score: Math.max(semanticScore(q, d.title), semanticScore(q, d.content_text)) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.doc);
}

/** A page candidate for `rankRelevantPages` — the page's extracted plain text. */
export interface PdfPageText {
  pageIndex: number;
  text: string;
}

/**
 * M24 阶段 3 延伸「对整篇 PDF 提问」：把问题与各页文本用 char-bigram Jaccard
 * 比对，挑出最相关的 `topN` 页（按 score 降序），只把这些页喂给模型，省 token
 * 且更准。离线可用（无向量端点依赖），返回空数组时表示没有相关页。纯函数，
 * smoke 可断言。
 */
export function rankRelevantPages(question: string, pages: PdfPageText[], topN = 5): PdfPageText[] {
  const q = String(question ?? "").trim();
  if (!q) return [];
  return pages
    .map((p) => ({ page: p, score: semanticScore(q, p.text) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((r) => r.page);
}
