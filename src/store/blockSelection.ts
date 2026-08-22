import { create } from "zustand";

// Multi-select of top-level blocks (by Lexical node key) for batch operations.
interface BlockSelectionState {
  keys: string[];
  anchor: string | null;
  setAnchor: (k: string | null) => void;
  setKeys: (keys: string[]) => void;
  clear: () => void;
}

export const useBlockSelection = create<BlockSelectionState>((set) => ({
  keys: [],
  anchor: null,
  setAnchor: (anchor) => set({ anchor }),
  setKeys: (keys) => set({ keys }),
  clear: () => set({ keys: [], anchor: null }),
}));
