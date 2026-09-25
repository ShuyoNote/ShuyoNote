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
  /**
   * 「**别人**替这一页写了属性」的信号（属性区据此重拉）。
   *
   * 为什么需要它（2026-09-23 用户实测）：社区帖存成笔记时，页面是**先建**、属性是**后写**的
   * （`communitySaveNote.savePostAsNote` 走的是 `set_page_prop` 这类命令，不经过属性区自己那条
   * 写路径）⇒ 属性区挂载时拉的还是"没属性"的那一份，于是**要重新打开这一页**才看得到。
   * 标签没有这个问题，因为标签那边本来就有 `useTagManagerStore.bump()`；属性这边缺一个同款信号。
   * 约定：**任何绕过属性区写属性的地方**（社区存笔记、将来的插件 API…）写完都要 `bumpProps()`。
   */
  propsRev: number;
  requestAddProp: () => void;
  requestAddTag: () => void;
  // 消费 addTagSeq（标记已处理，置 0——避免一次加标签后 seq 永 >0，导致以后
  // 每次页面打开都自动弹标签面板）。
  ackAddTag: () => void;
  setTagAnchor: (a: { top: number; left: number; width: number }) => void;
  /** 通知属性区"这一页的属性在别处被改过了，重拉一次"。 */
  bumpProps: () => void;
}

export const usePropertyUiStore = create<PropertyUiState>((set) => ({
  addPropSeq: 0,
  addTagSeq: 0,
  tagVisible: false,
  tagAnchor: null,
  propsRev: 0,
  requestAddProp: () => set((s) => ({ addPropSeq: s.addPropSeq + 1 })),
  requestAddTag: () => set((s) => ({ addTagSeq: s.addTagSeq + 1, tagVisible: true })),
  ackAddTag: () => set({ addTagSeq: 0 }),
  setTagAnchor: (a) => set({ tagAnchor: a }),
  bumpProps: () => set((s) => ({ propsRev: s.propsRev + 1 })),
}));
