import { create } from "zustand";

// 「从社区链接存一篇笔记」对话框的开关状态。
//
// 为什么单独一个 store 而不是组件内 state：命令面板（Ctrl+K）要能打开它，
// 而命令是注册在 `src/plugins/builtinCommands.ts` 里的**模块级**函数——它拿不到组件实例。
// 这跟 PDF 阅读器（`usePdfReader.openPdf`）是同一种做法。
interface CommunitySaveState {
  open: boolean;
  openDialog: () => void;
  close: () => void;
}

export const useCommunitySave = create<CommunitySaveState>((set) => ({
  open: false,
  openDialog: () => set({ open: true }),
  close: () => set({ open: false }),
}));
