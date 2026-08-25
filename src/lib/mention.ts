// Unlinked-mentions detection (M19.1). A page "mentions" another page when its
// title appears as plain text and is NOT already wrapped in [[ ]] (a page link).
// Pure + testable.

export interface UnlinkedMention {
  title: string;
  /** First index of the title in the content text (bare, not yet linked). */
  index: number;
}

/** Find titles that appear as bare text (not inside `[[ ]]`) in `contentText`.
 *  Excludes the current page's own title. Each title yields at most one mention
 *  (its first bare occurrence). */
export function findUnlinkedMentions(contentText: string, titles: string[], ownTitle?: string): UnlinkedMention[] {
  const text = String(contentText ?? "");
  const out: UnlinkedMention[] = [];
  if (!text) return out;
  const seen = new Set<string>();
  for (const raw of titles) {
    const title = String(raw ?? "").trim();
    if (!title || title.length < 2 || seen.has(title)) continue;
    if (ownTitle && title === ownTitle) continue;
    // already fully linked somewhere → skip
    if (text.includes(`[[${title}]]`)) continue;
    let idx = text.indexOf(title);
    while (idx >= 0) {
      const before = text.slice(Math.max(0, idx - 2), idx);
      const after = text.slice(idx + title.length, idx + title.length + 2);
      // not part of an existing [[ … ]] wrapper at this spot
      if (before !== "[[" && after !== "]]") {
        out.push({ title, index: idx });
        seen.add(title);
        break;
      }
      idx = text.indexOf(title, idx + 1);
    }
  }
  return out;
}

/** Pure convenience: is `title` currently linked in `contentText`? */
export function isTitleLinked(contentText: string, title: string): boolean {
  return String(contentText ?? "").includes(`[[${title}]]`);
}

/** M19.3 — rank page titles for the `[[` autocomplete. Exact match first, then
 *  prefix, then substring; recency (updated_at) as a small bonus. Pure/testable. */
export function suggestPageLinks(
  query: string,
  pages: Array<{ id: string; title: string; updated_at?: number }>,
  opts?: { recentIds?: string[] },
): string[] {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const recent = new Set(opts?.recentIds ?? []);
  return pages
    .map((p) => {
      const t = p.title || "";
      let score = 0;
      if (t === q) score = 100;
      else if (t.startsWith(q)) score = 60;
      else if (t.includes(q)) score = 30;
      if (score > 0) {
        if (recent.has(p.id)) score += 6;
        if (typeof p.updated_at === "number") score += Math.min(p.updated_at % 100, 4) / 100;
      }
      return { title: t, score };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((p) => p.title);
}
