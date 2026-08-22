import { create } from "zustand";

// Signals so the page-actions row can trigger the property panel's "add property"
// input and the tag picker (which live in the PropertiesPanel / TagBar subtree).
interface PropertyUiState {
  addPropSeq: number;
  addTagSeq: number;
  // Revealed while the user is adding a tag on an otherwise empty page, so the
  // tag picker has its trigger; once a property/tag exists the panel shows anyway.
  tagVisible: boolean;
  requestAddProp: () => void;
  requestAddTag: () => void;
}

export const usePropertyUiStore = create<PropertyUiState>((set) => ({
  addPropSeq: 0,
  addTagSeq: 0,
  tagVisible: false,
  requestAddProp: () => set((s) => ({ addPropSeq: s.addPropSeq + 1 })),
  requestAddTag: () => set((s) => ({ addTagSeq: s.addTagSeq + 1, tagVisible: true })),
}));
