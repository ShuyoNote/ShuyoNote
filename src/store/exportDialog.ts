// 「导出对话框」（C 弹窗，2026-10-18）的**开关状态**。
//
// 为什么用 store 而不是组件内 state：两个入口都在**命令面板**里（`builtinCommands.ts`），
// 命令只能 `return` 一句话、没法直接渲染浮层 ⇒ 由命令打开 store、`App.tsx` 里那个
// 常驻的 `<MarkdownExportDialog />` 负责渲染 ✓（与 `confirm` / `input` 两个 store 同一手法 ✓）。
import { create } from "zustand";

export type ExportDialogTarget = "page" | "space";

interface ExportDialogState {
  open: boolean;
  target: ExportDialogTarget;
  /** `target === "page"` 时是哪一页（入口那一下的当前页 ✓）；`space` 时为 null。 */
  pageId: string | null;
  /** 打开对话框（`target` 定"当前页 / 本空间" ✓）。 */
  openFor: (target: ExportDialogTarget, pageId?: string | null) => void;
  close: () => void;
}

export const useExportDialog = create<ExportDialogState>((set) => ({
  open: false,
  target: "page",
  pageId: null,
  openFor: (target, pageId = null) => set({ open: true, target, pageId }),
  close: () => set({ open: false }),
}));
