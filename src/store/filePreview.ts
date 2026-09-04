import { create } from "zustand";
import type { AttachmentMeta } from "../types";
import { api } from "../lib/api";
import { mdToHtml } from "../editor/mdToHtml";
import { sanitizePreviewHtml } from "../lib/sanitizeHtml";
import { markdownToPageContent } from "../lib/mdPreview";
import { toast } from "./toast";

interface FilePreviewState {
  /** The attachment being previewed (image/video/audio/pdf/md). Null = closed. */
  target: AttachmentMeta | null;
  /** Rendered HTML for a markdown file (read-only preview). */
  mdHtml: string | null;
  mdLoading: boolean;
  mdImporting: boolean;
  open: (a: AttachmentMeta) => void;
  close: () => void;
  /** Convert the previewed .md into a new page under the current folder. */
  importAsPage: (parentId: string | null) => Promise<void>;
}

export const useFilePreview = create<FilePreviewState>((set, get) => ({
  target: null,
  mdHtml: null,
  mdLoading: false,
  mdImporting: false,

  open: (a) => {
    set({ target: a, mdHtml: null, mdLoading: false });
    if (a.mime === "text/markdown") {
      set({ mdLoading: true });
      (async () => {
        try {
          // Read by hash → the Rust command decrypts at-rest-encrypted bytes.
          // (read_text_file on the raw disk path would return ciphertext garbling
          // the preview when E1 encryption is on.)
          const bytes = await api.readAttachmentBytes(a.hash);
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

  close: () => set({ target: null, mdHtml: null, mdLoading: false, mdImporting: false }),

  importAsPage: async (parentId) => {
    const { target, mdImporting } = get();
    if (!target || mdImporting) return;
    set({ mdImporting: true });
    try {
      const bytes = await api.readAttachmentBytes(target.hash);
      const content = new TextDecoder("utf-8").decode(new Uint8Array(bytes));
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
