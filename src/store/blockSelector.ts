import { create } from "zustand";

interface BlockSelectorState {
  open: boolean;
  mode: "ref" | "embed";
  openSelector: (mode: "ref" | "embed") => void;
  closeSelector: () => void;
}

// Controls the block picker opened from the slash menu (/引用块, /嵌入块).
export const useBlockSelector = create<BlockSelectorState>((set) => ({
  open: false,
  mode: "ref",
  openSelector: (mode) => set({ open: true, mode }),
  closeSelector: () => set({ open: false }),
}));
