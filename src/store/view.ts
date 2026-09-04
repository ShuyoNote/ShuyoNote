import { create } from "zustand";
import { useTemplateCenterStore } from "./templateCenter";

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
