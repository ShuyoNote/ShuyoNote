import { create } from "zustand";

// Coordinates the two right-side drawers (AI assistant and doc TOC) so they are
// mutually exclusive — opening one closes the other (Wolai keeps a single right
// rail). This keeps the right side clean instead of stacking panels.
interface RightPanelState {
  ai: boolean;
  toc: boolean;
  openAi: (v: boolean) => void;
  openToc: (v: boolean) => void;
}

export const useRightPanel = create<RightPanelState>((set) => ({
  ai: false,
  toc: true,
  openAi: (v) => set((s) => ({ ai: v, toc: v ? false : s.toc })),
  openToc: (v) => set((s) => ({ toc: v, ai: v ? false : s.ai })),
}));
