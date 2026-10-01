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
  // ⚠️ **退出多选模式时必须同时清空已选** —— owner 2026-10-01 实测的残影就是这么来的：
  // 在**多选模式**下拖表格列宽 ⇒ 那一下被当成"点块" ⇒ 之后退出多选 ⇒ 工具条仍挂着「已选 1 块」。
  // 判据（截图逐字）：count 显示「已选 N 块」而按钮显示「多选模式」⇒ 正说明 selectMode 已关、
  // 但 keys 没清 ✗。进入多选时不预先清空（用户可能就是想接着选）✓。
  setSelectMode: (selectMode) =>
    set(selectMode ? { selectMode: true } : { selectMode: false, keys: [], anchor: null }),
  clear: () => set({ keys: [], anchor: null }),
}));
