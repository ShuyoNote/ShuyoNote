// 外部 `.md` 文件的打开支持：路径判定、标题、相对资源解析。
//
// 背景（owner 2026-11-05）：「md 文档用 ShuyoNote 直接打开，默认只读展示」——
// 打开 **不等于** 导入：默认只在浮层里渲染，点「导入为笔记」才建页。
// 本文件只放**纯函数**，Tauri / DOM 留给组件。

/** 支持作为外部 Markdown 打开的扩展名。 */
export const MARKDOWN_FILE_RE = /\.(md|markdown)$/i;

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_FILE_RE.test(String(path ?? ""));
}

/** 取文件名（Windows / POSIX 路径都认）。 */
export function fileNameOf(path: string): string {
  const s = String(path ?? "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 取所在目录（Windows / POSIX 路径都认；没有目录时返回空串）。 */
export function dirNameOf(path: string): string {
  const s = String(path ?? "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(0, i) : "";
}

/** 标题：优先第一个 ATX H1，其次文件名（去掉 .md/.markdown）。 */
export function markdownTitleFromText(text: string, path: string): string {
  const m = String(text ?? "").match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m);
  if (m?.[1]?.trim()) return m[1].trim();
  return fileNameOf(path).replace(MARKDOWN_FILE_RE, "").trim() || "Markdown";
}

/**
 * 导入时把**被用作页面标题的那一行 H1** 从正文里去掉，避免“页面标题 + 正文标题”重复。
 * 只有标题确实来自 H1 时才删；否则原样返回。
 */
export function stripTitleHeading(text: string, path: string): string {
  const source = String(text ?? "");
  const m = source.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m);
  if (!m || markdownTitleFromText(source, path) !== m[1].trim()) return source;
  return source.replace(/^\s{0,3}#\s+.+?(?:\r?\n|$)/m, "");
}

export interface MarkdownTocItem {
  id: string;
  text: string;
  level: number;
}

function headingSlug(text: string, index: number): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `md-preview-${slug || "section"}-${index}`;
}

/**
 * 给预览 HTML 的 h1–h3 加稳定 id，并抽出一份目录。
 * id 用序号去重 ⇒ 同名标题不会互相抢锚点。
 */
export function assignPreviewHeadingIds(html: string): { html: string; toc: MarkdownTocItem[] } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const toc: MarkdownTocItem[] = [];
  const headings = Array.from(doc.querySelectorAll("h1, h2, h3"));
  headings.forEach((h, i) => {
    const text = (h.textContent ?? "").trim();
    if (!text) return;
    const id = headingSlug(text, i);
    h.setAttribute("id", id);
    toc.push({ id, text, level: Number(h.tagName.slice(1)) });
  });
  return { html: doc.body.innerHTML, toc };
}

function isExternalRef(ref: string): boolean {
  // `C:\…` / `C:/…` 是本地绝对路径，不是 scheme。
  if (/^[a-zA-Z]:[\\/]/.test(ref)) return false;
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref);
}

/**
 * 把 Markdown 里的相对图片地址解析成绝对本地路径。
 * 外链（http/data/attachment/blob…）、锚点、协议相对地址返回 null（保持原样）。
 */
export function resolveMarkdownAssetPath(baseDir: string, ref: string): string | null {
  let s = String(ref ?? "").trim();
  if (!s) return null;
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1).trim();
  // 去掉 query/hash（本地文件名里不会是 URL 语义）
  s = s.split(/[?#]/)[0];
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 非法转义就按原文处理 */
  }
  if (!s || isExternalRef(s)) return null;
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("/")) return s.replace(/\//g, "\\");
  if (!baseDir) return s;
  const sep = baseDir.includes("\\") ? "\\" : "/";
  const joined = `${baseDir.replace(/[\\/]+$/, "")}${sep}${s}`;
  const normalizedSep = joined.replace(/[\\/]/g, sep);
  const parts = normalizedSep.split(sep);
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  const prefix = sep === "\\" ? "" : "/";
  return `${prefix}${out.join(sep)}`;
}
