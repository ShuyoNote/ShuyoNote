import { create } from "zustand";
import type { AttachmentMeta } from "../types";
import { api } from "../lib/api";
import { mdToHtml } from "../editor/mdToHtml";
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
          const content = await api.readTextFile(a.path);
          set({ mdHtml: mdToHtml(content), mdLoading: false });
        } catch (e) {
          set({ mdLoading: false });
          toast(`读取 Markdown 失败：${e}`, "error");
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
      const content = await api.readTextFile(target.path);
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
      toast(`转为笔记失败：${e}`, "error");
    } finally {
      set({ mdImporting: false });
    }
  },
}));
