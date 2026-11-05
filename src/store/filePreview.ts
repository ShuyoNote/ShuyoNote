import { create } from "zustand";
import type { AttachmentMeta } from "../types";
import { api } from "../lib/api";
import { mdToHtml } from "../editor/mdToHtml";
import { sanitizePreviewHtml } from "../lib/sanitizeHtml";
import { markdownToPageContent } from "../lib/mdPreview";
import { ensureAttachmentBytes } from "../lib/attachmentBytes";
import { dirNameOf, fileNameOf, resolveMarkdownAssetPath } from "../lib/markdownFile";
import { isDesktopPlatform } from "../lib/platform";
import { toast } from "./toast";

function mimeOfPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "avif") return "image/avif";
  return "image/png";
}

/**
 * 外部 `.md` 的只读渲染：与内置阅读器同一套 `mdToHtml + sanitizePreviewHtml`，
 * 只额外把**相对图片**读成 blob URL（文件不在附件库里，不能走 asset 协议）。
 */
async function renderExternalMarkdown(path: string): Promise<{ html: string; urls: string[] }> {
  const content = (await api.readTextFile(path)).replace(/^\uFEFF/, "");
  if (content.includes("\u0000")) throw new Error("看起来是二进制文件，不是 Markdown");
  const doc = new DOMParser().parseFromString(sanitizePreviewHtml(mdToHtml(content)), "text/html");
  const urls: string[] = [];
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    const abs = resolveMarkdownAssetPath(dirNameOf(path), src);
    if (!abs) continue;
    try {
      const bytes = await api.readBinaryFile(abs);
      const url = URL.createObjectURL(new Blob([bytes], { type: mimeOfPath(abs) }));
      urls.push(url);
      img.setAttribute("src", url);
    } catch {
      /* 单张图读不到就保持原样；不因此拒开整篇文档 */
    }
  }
  return { html: doc.body.innerHTML, urls };
}

interface FilePreviewState {
  /** The attachment being previewed (image/video/audio/pdf/md). Null = closed. */
  target: AttachmentMeta | null;
  /** Rendered HTML for a markdown file (read-only preview). */
  mdHtml: string | null;
  mdLoading: boolean;
  mdImporting: boolean;
  /** 外部 md 相对图片的 blob URL（关闭/切换时回收）。 */
  mdUrls: string[];
  open: (a: AttachmentMeta) => void;
  /** 用**内置文件预览器**打开一个磁盘上的 .md（不建页、不入库）。 */
  openPath: (path: string) => void;
  close: () => void;
  /** Convert the previewed .md into a new page under the current folder. */
  importAsPage: (parentId: string | null) => Promise<void>;
}

export const useFilePreview = create<FilePreviewState>((set, get) => ({
  target: null,
  mdHtml: null,
  mdLoading: false,
  mdImporting: false,
  mdUrls: [],

  open: (a) => {
    const old = get().mdUrls;
    for (const u of old) URL.revokeObjectURL(u);
    set({ target: a, mdHtml: null, mdLoading: false, mdUrls: [] });
    if (a.mime === "text/markdown") {
      set({ mdLoading: true });
      (async () => {
        try {
          // Read by hash → the Rust command decrypts at-rest-encrypted bytes.
          // (read_text_file on the raw disk path would return ciphertext garbling
          // the preview when E1 encryption is on.)
          let bytes: ArrayBuffer;
          try {
            bytes = await api.readAttachmentBytes(a.hash);
          } catch (first) {
            // P6.3 续：字节不在本机时先按需取回来再读一次（取不回就报最初那个错）。
            if (!(await ensureAttachmentBytes(a.hash))) throw first;
            bytes = await api.readAttachmentBytes(a.hash);
          }
          const content = new TextDecoder("utf-8").decode(new Uint8Array(bytes));
          // Sanitize before `dangerouslySetInnerHTML`: the preview renders raw
          // HTML blocks verbatim (unlike the safe Lexical import path), so a
          // malicious .md could otherwise run <script>/event-handler payloads.
          set({ mdHtml: sanitizePreviewHtml(mdToHtml(content)), mdLoading: false });
        } catch (e) {
          set({ mdLoading: false });
          toast(`无法打开「${a.name}」：文件内容缺失（可能未同步到本机，或已被删除）`, "error");
        }
      })();
    }
  },

  openPath: (path) => {
    const p = String(path ?? "").trim();
    if (!p) return;
    if (!isDesktopPlatform()) {
      toast("只读预览需要桌面版（Web 版不能读本地路径）", "error");
      return;
    }
    const old = get().mdUrls;
    for (const u of old) URL.revokeObjectURL(u);
    const id = `external:${p}`;
    const target: AttachmentMeta = {
      id,
      name: fileNameOf(p),
      hash: "",
      mime: "text/markdown",
      size: 0,
      path: p,
    };
    set({ target, mdHtml: null, mdLoading: true, mdImporting: false, mdUrls: [] });
    void (async () => {
      try {
        const { html, urls } = await renderExternalMarkdown(p);
        if (get().target?.id !== id) {
          for (const u of urls) URL.revokeObjectURL(u);
          return;
        }
        set({ mdHtml: html, mdLoading: false, mdUrls: urls });
      } catch (e) {
        if (get().target?.id === id) {
          set({ mdLoading: false, target: null, mdUrls: [] });
          toast(`无法打开「${fileNameOf(p)}」：${e instanceof Error ? e.message : String(e)}`, "error");
        }
      }
    })();
  },

  close: () => {
    const old = get().mdUrls;
    for (const u of old) URL.revokeObjectURL(u);
    set({ target: null, mdHtml: null, mdLoading: false, mdImporting: false, mdUrls: [] });
  },

  importAsPage: async (parentId) => {
    const { target, mdImporting } = get();
    if (!target || mdImporting) return;
    set({ mdImporting: true });
    try {
      const bytes = target.path && !target.hash
        ? null
        : await api.readAttachmentBytes(target.hash);
      const content = target.path && !target.hash
        ? await api.readTextFile(target.path)
        : new TextDecoder("utf-8").decode(new Uint8Array(bytes!));
      const payload = markdownToPageContent(content);
      if (!payload) {
        toast("Markdown 内容为空或无法解析", "info");
        return;
      }
      const title = target.name.replace(/\.(md|markdown|txt)$/i, "") || "Markdown 导入";
      // createPage lives on the notes store; import lazily to avoid a cycle.
      const { useNotes } = await import("./notes");
      const id = await useNotes.getState().createPage(parentId, {
        title,
        content_json: payload.content_json,
        content_text: payload.content_text,
      });
      if (id) {
        set({ target: null, mdHtml: null, mdImporting: false });
        toast("已转为笔记", "success");
      } else {
        toast("创建页面失败", "error");
      }
    } catch (e) {
      toast(`无法转为笔记：文件内容缺失（可能未同步到本机，或已被删除）`, "error");
    } finally {
      set({ mdImporting: false });
    }
  },
}));
