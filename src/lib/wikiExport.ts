// M21.1 — static wiki export. Pure + testable: turns a set of pages into a set
// of static HTML files (one per page + index.html) that any static host (or
// file://) can serve. Kept free of platform/api imports so the smoke harness
// can bundle it.
//
// Rendering is intentionally content-markup-light: `content_text` is emitted as
// paragraphs with `[[标题]]`/`[[标题|别名]]`/`[[标题#块]]` double-links turned
// into real <a href> links. A faithful node-level renderer can layer on later
// without changing this API.

/** Wiki-page input: title + plain text + metadata, all resolvable by the exporter. */
export interface WikiPageInput {
  id: string;
  title: string;
  content_text: string;
  kind?: string;
  parent_id?: string | null;
  sort_order?: number;
  updated_at?: number;
  /** Human-readable space name (optional). */
  space?: string;
}

/** A full wiki render output: filename -> HTML/asset content. */
export interface WikiExportResult {
  files: { name: string; content: string }[];
  pageCount: number;
}

// ---- Filename-safe slug -----------------------------------------------------
function sanitizePart(name: string): string {
  let s = String(name ?? "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  s = s.replace(/[.\s]+$/g, "");
  return s.slice(0, 120) || "未命名";
}

/** Build a stable, collision-free slug for a page title. */
export function wikiSlug(title: string, used: Set<string>, id: string): string {
  const base = sanitizePart(title);
  let slug = `${base}.html`;
  if (!used.has(slug)) {
    used.add(slug);
    return slug;
  }
  // Collision: append a short id suffix, then a numeric counter if still taken.
  const withId = `${base}-${id.slice(0, 6)}.html`;
  slug = withId;
  if (!used.has(slug)) {
    used.add(slug);
    return slug;
  }
  let i = 2;
  while (used.has(slug)) {
    slug = `${base}-${id.slice(0, 6)}-${i}.html`;
    i++;
  }
  used.add(slug);
  return slug;
}

// ---- [[标题]] linkification -------------------------------------------------
const LINK_RE = /\[\[([^\]|#]+)(?:\|([^\]#]*))?(?:#([^\]]*))?\]\]/g;

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Resolve a `[[title]]` reference to a slug (case-insensitive best-effort). */
function resolveSlug(title: string, titleToSlug: Map<string, string>): string | null {
  const key = String(title ?? "").toLowerCase();
  if (titleToSlug.has(key)) return titleToSlug.get(key)!;
  for (const [t, slug] of titleToSlug) if (t.toLowerCase() === key) return slug;
  return null;
}

/** Turn `content_text` into HTML: paragraphs + clickable wiki double-links. */
export function renderWikiBody(content_text: string, titleToSlug: Map<string, string>): string {
  const text = String(content_text ?? "").replace(/\r\n/g, "\n");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "<p><em>（空白页面）</em></p>";
  const paras = lines.map((line) => {
    let html = escapeHtml(line);
    // Rewrite [[...]] occurrences into <a href="slug.html"></a>.
    html = html.replace(LINK_RE, (_m, title, alias, block) => {
      const rawTitle = String(title).trim();
      const slug = resolveSlug(rawTitle, titleToSlug);
      const label = escapeHtml(String(alias ?? "").trim() || rawTitle);
      if (!slug) return `${label}<span class="dead-link" title="未找到页面「${escapeHtml(rawTitle)}」"></span>`;
      const href = block ? `${slug}#` : slug;
      return `<a class="wiki-link" href="${href}">${label}</a>`;
    });
    return `<p>${html}</p>`;
  });
  return paras.join("\n");
}

// ---- Page HTML --------------------------------------------------------------
const PAGE_CSS = `
:root { color-scheme: light; }
body { font-family: system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; max-width: 860px; margin: 0 auto; padding: 2.5rem 1.5rem; line-height: 1.7; color: #1b1f24; background: #fff; }
h1 { font-size: 1.7rem; border-bottom: 2px solid #eee; padding-bottom: .4rem; }
a { color: #2f6feb; text-decoration: none; }
a:hover { text-decoration: underline; }
.backnav a { color: #888; font-size: .9rem; }
.tags { margin: .35rem 0 .8rem; }
.tag { display: inline-block; background: #eef2ff; color: #3b5bdb; border-radius: 999px; padding: .15rem .6rem; font-size: .8rem; margin-right: .35rem; }
.backlinks { margin-top: 2rem; border-top: 1px solid #eee; padding-top: .8rem; }
.backlinks h2 { font-size: 1.05rem; }
.backlinks ul { margin: .3rem 0; padding-left: 1.2rem; }
.dead-link { color: #b91c1c; }
`;

function pageDoc(opts: {
  title: string;
  slug: string;
  bodyHtml: string;
  space?: string;
  tags: string[];
  backlinks: { title: string; slug: string }[];
  siblings?: { title: string; slug: string }[];
}): string {
  const tagHtml = opts.tags.length
    ? `<div class="tags">${opts.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>`
    : "";
  const backHtml = opts.backlinks.length
    ? `<section class="backlinks"><h2>反向链接</h2><ul>${opts.backlinks.map((b) => `<li><a href="${b.slug}">${escapeHtml(b.title)}</a></li>`).join("")}</ul></section>`
    : `<section class="backlinks"><h2>反向链接</h2><p>暂无页面引用。</p></section>`;
  const space = opts.space ? `<p class="backnav"><a href="index.html">← 返回首页</a> · ${escapeHtml(opts.space)}</p>` : `<p class="backnav"><a href="index.html">← 返回首页</a></p>`;
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
${space}
<h1>${escapeHtml(opts.title)}</h1>
${tagHtml}
${opts.bodyHtml}
${backHtml}
</body>
</html>`;
}

// ---- Index / page tree ------------------------------------------------------
function findChildren(parentId: string | null, pages: WikiPageInput[]): WikiPageInput[] {
  return pages
    .filter((p) => (p.parent_id ?? null) === parentId)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.title || "").localeCompare(b.title || "", "zh"));
}

function renderTree(indent: number, parentId: string | null, pages: WikiPageInput[], idToSlug: Map<string, string>): string {
  const kids = findChildren(parentId, pages);
  if (kids.length === 0) return "";
  const pad = "  ".repeat(indent);
  return kids
    .map((k) => {
      const slug = idToSlug.get(k.id);
      const label = escapeHtml(k.title || k.id);
      const href = slug ? `href="${slug}"` : "";
      const child = renderTree(indent + 1, k.id, pages, idToSlug);
      return `${pad}<li><a ${href}>${label}</a>${child ? `\n${child}${pad}` : ""}</li>`;
    })
    .join("\n");
}

function indexDoc(opts: {
  space?: string;
  treeHtml: string;
  pageCount: number;
}): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.space ?? "Wiki")} · 页面树</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<h1>${escapeHtml(opts.space ?? "我的 Wiki")}</h1>
<p>共 ${opts.pageCount} 个页面。</p>
<ul class="wiki-tree">
${opts.treeHtml}
</ul>
</body>
</html>`;
}

// ---- Public entry -----------------------------------------------------------
/**
 * Build a static wiki from a list of pages. Returns named files:
 * `<slug>.html` for each page, plus `index.html`. Backlinks are derived from
 * the wiki's own `[[…]]` references (so the export is self-consistent).
 */
export function buildWikiExport(pages: WikiPageInput[], opts: { space?: string } = {}): WikiExportResult {
  const byId = new Map<string, WikiPageInput>();
  for (const p of pages) byId.set(p.id, p);

  // 1) assign slugs and a title→slug lookup (root pages first, so a top-level
  //    page keeps the clean slug and deeper duplicates get suffixed).
  const used = new Set<string>();
  const idToSlug = new Map<string, string>();
  const titleToSlug = new Map<string, string>();
  const ordered = [...pages].sort((a, b) => ((a.parent_id ?? null) === null ? 0 : 1) - ((b.parent_id ?? null) === null ? 0 : 1));
  for (const p of ordered) {
    const slug = wikiSlug(p.title, used, p.id);
    idToSlug.set(p.id, slug);
    titleToSlug.set(p.title.toLowerCase(), slug);
  }

  // 2) derive backlinks: scan every page's text for [[X]] and record who links to whom.
  const backlinksOf = new Map<string, { title: string; slug: string }[]>();
  for (const p of pages) {
    const text = String(p.content_text ?? "");
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(text))) {
      const titleRef = String(m[1] ?? "").trim();
      const slug = resolveSlug(titleRef, titleToSlug);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      // Find the page owning that slug to get its real title.
      let owner: WikiPageInput | undefined;
      for (const [id, s] of idToSlug) if (s === slug) { owner = byId.get(id); break; }
      if (!owner) continue;
      const arr = backlinksOf.get(owner.id) ?? [];
      arr.push({ title: owner.title, slug });
      backlinksOf.set(owner.id, arr);
    }
  }

  // 3) render each page.
  const files: { name: string; content: string }[] = [];
  for (const p of pages) {
    const slug = idToSlug.get(p.id)!;
    const bodyHtml = renderWikiBody(p.content_text, titleToSlug);
    const bl = (backlinksOf.get(p.id) ?? [])
      .filter((b) => b.slug !== slug)
      .sort((a, b) => a.title.localeCompare(b.title, "zh"));
    const tags: string[] = [];
    files.push({
      name: slug,
      content: pageDoc({
        title: p.title || p.id,
        slug,
        bodyHtml,
        space: opts.space,
        tags,
        backlinks: bl,
      }),
    });
  }

  // 4) index.html with the page tree (roots only).
  const treeHtml = renderTree(0, null, pages, idToSlug);
  files.push({ name: "index.html", content: indexDoc({ space: opts.space, treeHtml, pageCount: pages.length }) });

  return { files, pageCount: pages.length };
}
