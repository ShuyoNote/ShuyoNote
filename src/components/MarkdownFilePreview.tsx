import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { api } from "../lib/api";
import { isDesktopPlatform } from "../lib/platform";
import { markdownPreviewHtml } from "../lib/mdPreviewHtml";
import { markdownToPageContent } from "../lib/mdPreview";
import {
  dirNameOf,
  fileNameOf,
  markdownTitleFromText,
  resolveMarkdownAssetPath,
  stripTitleHeading,
} from "../lib/markdownFile";
import { useMarkdownFilePreview } from "../store/markdownFilePreview";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
import { useOverlayLayer } from "../hooks/useOverlayLayer";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { XIcon } from "./icons";

const MAX_PREVIEW_CHARS = 2 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_TOTAL_BYTES = 8 * 1024 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function mimeOfPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    default:
      return "image/png";
  }
}

/** 把预览 HTML 里的本地相对图片换成可显示的 blob URL（外链/data URL 不动）。 */
async function attachPreviewAssets(
  html: string,
  baseDir: string,
  urls: string[],
): Promise<{ html: string; missing: string[] }> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const missing: string[] = [];
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    const abs = resolveMarkdownAssetPath(baseDir, src);
    if (!abs) continue;
    try {
      const bytes = await api.readBinaryFile(abs);
      const url = URL.createObjectURL(new Blob([bytes], { type: mimeOfPath(abs) }));
      urls.push(url);
      img.setAttribute("src", url);
    } catch {
      missing.push(fileNameOf(abs));
    }
  }
  return { html: doc.body.innerHTML, missing };
}


/**
 * 把 md 里的本地图片转成 data URL（导入时用）—— 这样新页面自包含，
 * ⛔ 不需要在组件里直接碰正文列，也⛔ 不把本地绝对路径带进库里。
 * 单张 >2 MB 或总量 >8 MB 的不内联，留原引用并给警告。
 */
async function inlineMarkdownAssets(
  markdown: string,
  baseDir: string,
): Promise<{ markdown: string; warnings: string[] }> {
  const warnings: string[] = [];
  const refs = new Set<string>();
  const mdImg = /!\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)/g;
  for (const m of markdown.matchAll(mdImg)) refs.add(m[1].replace(/^<|>$/g, "").trim());
  const htmlImg = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  for (const m of markdown.matchAll(htmlImg)) refs.add(m[1].trim());

  const replacements = new Map<string, string>();
  const byAbs = new Map<string, string | null>();
  let total = 0;
  for (const ref of refs) {
    const abs = resolveMarkdownAssetPath(baseDir, ref);
    if (!abs) continue;
    if (!byAbs.has(abs)) {
      try {
        const bytes = await api.readBinaryFile(abs);
        if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES || total + bytes.byteLength > MAX_INLINE_TOTAL_BYTES) {
          byAbs.set(abs, null);
          warnings.push(`${fileNameOf(abs)} 太大，未内联`);
        } else {
          total += bytes.byteLength;
          byAbs.set(abs, `data:${mimeOfPath(abs)};base64,${bytesToBase64(bytes)}`);
        }
      } catch {
        byAbs.set(abs, null);
        warnings.push(fileNameOf(abs));
      }
    }
    const replacement = byAbs.get(abs);
    if (replacement) replacements.set(ref, replacement);
  }

  let out = markdown;
  for (const [from, to] of replacements) out = out.split(from).join(to);
  return { markdown: out, warnings };
}

/**
 * 外部 `.md` 的**只读预览**浮层（双击 / “打开方式” 唤起）。
 *
 * - 打开只读：不建页、不写库、不把图片悄悄入库；
 * - 顶部「导入为笔记」才复制成新页面（本地相对图片入库为附件）；
 * - Esc / 点遮罩 / × 关闭；Android 返回键登记进浮层栈。
 */
export function MarkdownFilePreview() {
  const path = useMarkdownFilePreview((s) => s.path);
  const close = useMarkdownFilePreview((s) => s.close);
  const [html, setHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [text, setText] = useState("");
  const urlsRef = useRef<string[]>([]);

  useOverlayLayer("markdownFilePreview", !!path, close);
  useOverlayScrollLock(!!path);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setHtml("");
    setError(null);
    setLoading(true);
    setWarnings([]);
    setText("");
    for (const u of urlsRef.current) URL.revokeObjectURL(u);
    urlsRef.current = [];

    void (async () => {
      try {
        if (!isDesktopPlatform()) throw new Error("只读预览需要桌面版（Web 版不能读本地路径）");
        const raw = await api.readTextFile(path);
        if (cancelled) return;
        const content = raw.replace(/^\uFEFF/, "");
        if (content.length > MAX_PREVIEW_CHARS) {
          throw new Error(`文件太大（${Math.round(content.length / 1024)} KB），超过只读预览上限`);
        }
        if (content.includes("\u0000")) throw new Error("看起来是二进制文件，不是 Markdown");
        const base = markdownPreviewHtml(content);
        const enriched = await attachPreviewAssets(base, dirNameOf(path), urlsRef.current);
        if (cancelled) return;
        setText(content);
        setHtml(enriched.html);
        setWarnings(enriched.missing.map((n) => `图片未找到：${n}`));
      } catch (e) {
        if (!cancelled) setError(String(e instanceof Error ? e.message : e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      for (const u of urlsRef.current) URL.revokeObjectURL(u);
      urlsRef.current = [];
    };
  }, [path]);

  useEffect(() => {
    return () => {
      for (const u of urlsRef.current) URL.revokeObjectURL(u);
      urlsRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!path) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path, close]);

  if (!path) return null;

  const doImport = async () => {
    if (importing || !text.trim()) return;
    setImporting(true);
    try {
      const prepared = await inlineMarkdownAssets(text, dirNameOf(path));
      const body = stripTitleHeading(prepared.markdown, path);
      const payload = markdownToPageContent(body);
      if (!payload) {
        toast("Markdown 内容为空或无法解析", "info");
        return;
      }
      const title = markdownTitleFromText(text, path);
      const id = await useNotes.getState().createPage(null, { title, ...payload });
      if (!id) {
        toast("创建页面失败", "error");
        return;
      }
      const lost = prepared.warnings.length;
      toast(lost ? `已导入为笔记；${lost} 张本地图片未导入` : "已导入为笔记", lost ? "info" : "success");
      close();
    } catch (e) {
      toast(`导入失败：${String(e)}`, "error");
    } finally {
      setImporting(false);
    }
  };

  const fileName = fileNameOf(path);
  return createPortal(
    <div
      className="markdown-file-preview-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="markdown-file-preview" onMouseDown={(e) => e.stopPropagation()}>
        <div className="markdown-file-preview-head">
          <div className="markdown-file-preview-title">
            <span className="markdown-file-preview-name" title={path}>
              {fileName}
            </span>
            <span className="markdown-file-preview-badge">只读预览</span>
          </div>
          <div className="markdown-file-preview-actions">
            <button
              type="button"
              className="markdown-file-preview-import"
              disabled={loading || !!error || importing || !text.trim()}
              onClick={() => void doImport()}
            >
              {importing ? "导入中…" : "导入为笔记"}
            </button>
            <button
              type="button"
              className="markdown-file-preview-close"
              aria-label="关闭预览"
              title="关闭"
              onClick={close}
            >
              <XIcon />
            </button>
          </div>
        </div>
        <div className="markdown-file-preview-path">{path}</div>
        <div className="markdown-file-preview-body">
          {loading ? (
            <div className="markdown-file-preview-hint">正在读取…</div>
          ) : error ? (
            <div className="markdown-file-preview-error">{error}</div>
          ) : (
            <>
              {warnings.length > 0 ? (
                <div className="markdown-file-preview-warn">{warnings.join("；")}</div>
              ) : null}
              <div className="fm-md-preview" dangerouslySetInnerHTML={{ __html: html }} />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
