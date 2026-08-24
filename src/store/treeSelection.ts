import { create } from "zustand";

interface TreeSelectionState {
  ids: Set<string>;
  toggle: (id: string) => void;
  clear: () => void;
  set: (ids: Set<string>) => void;
}

// Multi-select state for the sidebar page tree. `TreeItem` recurses deeply, so a
// small shared store avoids prop-drilling selection through every level. Ctrl/⌘+
// click toggles a node; a plain click clears the selection and opens the node.
export const useTreeSelection = create<TreeSelectionState>((set) => ({
  ids: new Set(),
  toggle: (id) =>
    set((s) => {
      const next = new Set(s.ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ids: next };
    }),
  clear: () => set({ ids: new Set() }),
  set: (ids) => set({ ids }),
}));
