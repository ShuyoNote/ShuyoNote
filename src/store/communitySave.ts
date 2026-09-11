import { create } from "zustand";

// 「从社区链接存一篇笔记」对话框的开关状态。
//
// 为什么单独一个 store 而不是组件内 state：命令面板（Ctrl+K）与**操作系统递交的深链**
// 都要能打开它，而它们都拿不到组件实例——深链那一路来自 Tauri 的事件回调
// （Windows 侧正在接 OS 层）。这跟 PDF 阅读器（`usePdfReader.openPdf`）是同一种做法。
interface CommunitySaveState {
  open: boolean;
  /**
   * 被唤起时要**预填**的链接（深链那一侧用）。
   *
   * 语义上很重要：预填 ≠ 自动保存。对话框拿到它之后照样走"抓取 → 预览 → 人确认"，
   * 取消一样零痕迹——"网页发出的链接"不该比"用户自己粘贴"多出任何权限。
   */
  pendingLink: string | null;
  openDialog: () => void;
  /** 应用外来的深链/网址：打开对话框并预填（解析与确认仍在对话框里做）。 */
  openWithLink: (link: string) => void;
  close: () => void;
}

export const useCommunitySave = create<CommunitySaveState>((set) => ({
  open: false,
  pendingLink: null,
  openDialog: () => set({ open: true, pendingLink: null }),
  openWithLink: (link) => set({ open: true, pendingLink: link }),
  close: () => set({ open: false, pendingLink: null }),
}));
