import { create } from "zustand";

export type AppView = "notes" | "board" | "graph" | "files";

interface ViewState {
  view: AppView;
  setView: (view: AppView) => void;
}

// Active top-level view (notes / board / relationship graph). Lifted to a
// store so the command palette and keyboard shortcuts can switch views.
export const useViewStore = create<ViewState>((set) => ({
  view: "notes",
  setView: (view) => set({ view }),
}));
