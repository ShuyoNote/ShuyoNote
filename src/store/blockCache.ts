import { create } from "zustand";

interface BlockCacheState {
  /** Bumped whenever page content is saved, signaling block refs/embeds to re-fetch. */
  revision: number;
  bump: () => void;
}

// A lightweight invalidation signal for block-reference targets: when a page is
// saved, block references (`((id))`) and embeds (`{{id}}`) refresh their
// mirrored content.
export const useBlockCache = create<BlockCacheState>((set) => ({
  revision: 0,
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));
