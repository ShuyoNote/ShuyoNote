import { create } from "zustand";

// 邮箱（聚合收件箱）面板开关。用 store 以便：侧栏低调入口、全局快捷键 Ctrl+Shift+E、
// 命令面板等都能打开同一个面板，而不用各自维护 popover。
export interface EmailPanelState {
  open: boolean;
  openPanel: () => void;
  closePanel: () => void;
  toggle: () => void;
}

export const useEmailPanel = create<EmailPanelState>((set) => ({
  open: false,
  openPanel: () => set({ open: true }),
  closePanel: () => set({ open: false }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
