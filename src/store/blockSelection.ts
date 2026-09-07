import { create } from "zustand";

// Multi-select of top-level blocks (by Lexical node key) for batch operations.
// `selectMode`: explicit "多选模式" — when on, clicking a top-level block toggles
// it in the selection instead of placing a caret / starting text selection. This
// separates the two gesture semantics so normal text selection is never hijacked.
interface BlockSelectionState {
  keys: string[];
  anchor: string | null;
  selectMode: boolean;
  setAnchor: (k: string | null) => void;
  setKeys: (keys: string[]) => void;
  toggleKey: (k: string) => void;
  setSelectMode: (v: boolean) => void;
  clear: () => void;
}

export const useBlockSelection = create<BlockSelectionState>((set) => ({
  keys: [],
  anchor: null,
  selectMode: false,
  setAnchor: (anchor) => set({ anchor }),
  setKeys: (keys) => set({ keys }),
  toggleKey: (k) =>
    set((s) => ({
      keys: s.keys.includes(k) ? s.keys.filter((x) => x !== k) : [...s.keys, k],
    })),
  setSelectMode: (selectMode) => set({ selectMode }),
  clear: () => set({ keys: [], anchor: null }),
}));
