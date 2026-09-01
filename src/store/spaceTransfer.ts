import { create } from "zustand";

/** 空间导出/导入的进度（全局单例）。 */
export interface SpaceTransferProgress {
  done: number;
  total: number;
  message: string;
}

interface SpaceTransferState {
  progress: SpaceTransferProgress | null;
  setProgress: (p: SpaceTransferProgress | null) => void;
}

// 进度放全局 store 而不是组件局部 state：导出一个大空间可能要几十秒，
// 用户关掉设置对话框后仍应看到进度条（App 级 overlay 订阅这里）。
export const useSpaceTransfer = create<SpaceTransferState>((set) => ({
  progress: null,
  setProgress: (progress) => set({ progress }),
}));
