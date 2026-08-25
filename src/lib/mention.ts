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
