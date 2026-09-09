import { create } from "zustand";

// Coordinates the right-side drawers (AI assistant, doc TOC, comments) so they
// are mutually exclusive — opening one closes the others. Keeps the right side
// clean instead of stacking panels.
interface RightPanelState {
  ai: boolean;
  toc: boolean;
  comments: boolean;
  openAi: (v: boolean) => void;
  openToc: (v: boolean) => void;
  openComments: (v: boolean) => void;
}

export const useRightPanel = create<RightPanelState>((set) => ({
  ai: false,
  toc: false,
  comments: false,
  openAi: (v) => set((s) => ({ ai: v, toc: v ? false : s.toc, comments: v ? false : s.comments })),
  openToc: (v) => set((s) => ({ toc: v, ai: v ? false : s.ai, comments: v ? false : s.comments })),
  openComments: (v) => set((s) => ({ comments: v, ai: v ? false : s.ai, toc: v ? false : s.toc })),
}));
