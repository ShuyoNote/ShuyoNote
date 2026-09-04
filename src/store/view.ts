import { create } from "zustand";
import { useTemplateCenterStore } from "./templateCenter";
import { useFilePreview } from "./filePreview";
import { usePdfReader } from "./pdfReader";

export type AppView = "notes" | "board" | "graph" | "files";
export type ContentWidth = "centered" | "full";

interface ViewState {
  view: AppView;
  setView: (view: AppView) => void;
  // Page content width: centered (capped at --doc-width) or adaptive full width.
  contentWidth: ContentWidth;
  setContentWidth: (width: ContentWidth) => void;
}

const WIDTH_KEY = "shuyonote:contentWidth";

// Active top-level view (notes / board / relationship graph). Lifted to a
// store so the command palette and keyboard shortcuts can switch views.
export const useViewStore = create<ViewState>((set) => ({
  view: "notes",
  setView: (view) => {
    // 切换视图（笔记/看板/关系图/文件）时自动关闭模板中心，避免覆盖层残留。
    useTemplateCenterStore.getState().setOpen(false);
    // 切到主区视图（尤其「文件/文件夹」视图）时，关掉残留的 MD/图片预览与 PDF 阅读器，
    // 避免这些覆盖层叠在切换后的视图上（活动栏之外经由目录树/面包屑/命令面板切换也会走到这里）。
    useFilePreview.getState().close();
    usePdfReader.getState().close();
    set({ view });
  },
  contentWidth: (localStorage.getItem(WIDTH_KEY) as ContentWidth) || "centered",
  setContentWidth: (width) => {
    try {
      localStorage.setItem(WIDTH_KEY, width);
    } catch {
      /* ignore */
    }
    set({ contentWidth: width });
  },
}));
