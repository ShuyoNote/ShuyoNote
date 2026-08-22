import { create } from "zustand";

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
  setView: (view) => set({ view }),
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
