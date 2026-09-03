import { create } from "zustand";

// Signals so the page-actions row can trigger the property panel's "add property"
// input and the tag picker (which live in the PropertiesPanel / TagBar subtree).
interface PropertyUiState {
  addPropSeq: number;
  addTagSeq: number;
  // Revealed while the user is adding a tag on an otherwise empty page, so the
  // tag picker has its trigger; once a property/tag exists the panel shows anyway.
  tagVisible: boolean;
  // Anchor (viewport rect) of the "添加标签" action button, so the picker pops
  // next to it instead of floating centered.
  tagAnchor: { top: number; left: number; width: number } | null;
  requestAddProp: () => void;
  requestAddTag: () => void;
  // 消费 addTagSeq（标记已处理，置 0——避免一次加标签后 seq 永 >0，导致以后
  // 每次页面打开都自动弹标签面板）。
  ackAddTag: () => void;
  setTagAnchor: (a: { top: number; left: number; width: number }) => void;
}

export const usePropertyUiStore = create<PropertyUiState>((set) => ({
  addPropSeq: 0,
  addTagSeq: 0,
  tagVisible: false,
  tagAnchor: null,
  requestAddProp: () => set((s) => ({ addPropSeq: s.addPropSeq + 1 })),
  requestAddTag: () => set((s) => ({ addTagSeq: s.addTagSeq + 1, tagVisible: true })),
  ackAddTag: () => set({ addTagSeq: 0 }),
  setTagAnchor: (a) => set({ tagAnchor: a }),
}));
