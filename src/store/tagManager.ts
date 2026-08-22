import { create } from "zustand";

// Bumped whenever tags are created/renamed/deleted so the sidebar tag filter
// refreshes alongside the tag manager.
interface TagManagerState {
  revision: number;
  bump: () => void;
}

export const useTagManagerStore = create<TagManagerState>((set) => ({
  revision: 0,
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));
