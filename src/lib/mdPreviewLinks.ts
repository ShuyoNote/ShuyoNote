// 只读 Markdown 预览里的**链接分类**（纯函数；判据 `mdPreviewLinks.test.ts`）。
//
// 来由（owner 2026-11-09）：只读打开 `.md` 后，正文里的链接点了没反应 —— 预览是
// `dangerouslySetInnerHTML` 渲染的纯 HTML，`<a href>` 没有人接管：点外链等于让 WebView
// 自己跳走（或什么都不发生），点相对路径更完全没去处。
// 这里只做**判类**（不碰 DOM/不碰平台），由 `FilePreviewDialog` 决定怎么打开：
//   · `https:` / `mailto:` ⇒ 走 `openExternalUrl`（全应用唯一外链总闸）；
//   · `#标题` ⇒ 在本文档内滚动到同名标题（渲染器不给标题加 id，所以按文字匹配）；
//   · 其它相对/绝对路径 ⇒ 解析成磁盘路径后：`.md/.markdown/.txt` 用本预览器打开，其余用系统程序打开；
//   · `javascript:` / `data:` / 其它协议 ⇒ 一律不执行（⛔ 不在正文里开任意协议）。

export type MdLinkAction =
  | { kind: "external"; href: string }
  | { kind: "anchor"; anchor: string }
  | { kind: "file"; path: string; anchor: string | null }
  | { kind: "none" };

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 标题文字归一化（大小写不敏感、空白折叠）—— 与 `#标题` 的匹配口径。 */
export function normalizeHeadingText(s: string): string {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function classifyHref(raw: string | null | undefined): MdLinkAction {
  const href = String(raw ?? "").trim();
  if (!href) return { kind: "none" };
  const lower = href.toLowerCase();
  if (lower.startsWith("javascript:") || lower.startsWith("data:")) return { kind: "none" };
  if (href.startsWith("#")) return { kind: "anchor", anchor: safeDecode(href.slice(1)) };
  if (/^(https?:|mailto:)/i.test(href)) return { kind: "external", href };
  // ⚠️ Windows 盘符（`D:/x.md`）长得像协议（`D:`）⇒ 必须先判文件，再判“其它协议”。
  if (/^[a-zA-Z]:[\\/]/.test(href)) return { kind: "file", path: href, anchor: null };
  // 其它协议（`ms-settings:` / `file:` / `tel:` …）不在正文里代开：认不出来就交给用户自己复制。
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: "none" };

  const hashAt = href.indexOf("#");
  const anchor = hashAt >= 0 ? safeDecode(href.slice(hashAt + 1)) : null;
  const beforeHash = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const path = safeDecode(beforeHash.split("?")[0]).trim();
  if (!path) return anchor ? { kind: "anchor", anchor } : { kind: "none" };
  return { kind: "file", path, anchor: anchor && anchor.trim() ? anchor : null };
}

/**
 * 在渲染后的文档里找 `#anchor` 指向的标题。
 * 我们的 Markdown 渲染器**不给标题加 id**（`mdToHtml` 输出 `<h1>…</h1>`），所以：
 *   ① 先按标题文字全等（归一化后）；
 *   ② 再按 GitHub 风格 slug（空白换 `-`）近似匹配。
 * ⛔ 找不到就返回 `null`（调用方说清"没这个小标题"，不要滚到顶上假装成功）。
 */
export function findAnchorTarget(root: ParentNode | null | undefined, anchor: string): Element | null {
  if (!root) return null;
  const want = normalizeHeadingText(safeDecode(anchor));
  if (!want) return null;
  const heads = Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6"));
  const direct = heads.find((h) => normalizeHeadingText(h.textContent ?? "") === want);
  if (direct) return direct;
  const wantSlug = want.replace(/\s+/g, "-");
  return heads.find((h) => normalizeHeadingText(h.textContent ?? "").replace(/\s+/g, "-") === wantSlug) ?? null;
}
