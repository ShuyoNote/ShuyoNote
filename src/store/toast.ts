import { create } from "zustand";

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

/** 一条 toast 的展示选项。 */
export interface ToastOptions {
  /**
   * 自动消失的毫秒数；`<= 0` ⇒ **不自动消失**（持久 toast，由 `update` / `dismiss` 收尾 ✓）。
   *
   * ⭐ 2026-10-18（owner 报"导出没有任何进度反馈"✗）：长任务需要一条**留在屏幕上**的 toast
   * 跟着进度改文案 —— 3 秒就消失的那条做不到（用户还没看到结果，它先没了 ✗）。
   * 缺省仍是 3 秒（与以前逐字相同 ✓）。
   */
  duration?: number;
}

const DEFAULT_TOAST_MS = 3000;

interface ToastState {
  toasts: ToastItem[];
  /** 弹一条 toast，回它的 id（持久 toast 靠这个 id `update` 收尾 ✓）。 */
  show: (message: string, kind?: ToastKind, opts?: ToastOptions) => number;
  /** 就地把一条 toast 换成新文案/类型（进度 ⇒ 结果 ✓）。id 已经不在了 ⇒ 什么都不做。 */
  update: (id: number, message: string, kind?: ToastKind, opts?: ToastOptions) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

/** 到点移除；`duration <= 0` ⇒ 不移除（持久 toast ✓）。 */
function dismissLater(id: number, duration: number) {
  if (duration <= 0) return;
  window.setTimeout(() => {
    useToast.getState().dismiss(id);
  }, duration);
}

export const useToast = create<ToastState>((set) => ({
  toasts: [],
  show: (message, kind = "info", opts = {}) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    dismissLater(id, opts.duration ?? DEFAULT_TOAST_MS);
    return id;
  },
  update: (id, message, kind = "info", opts = {}) => {
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, message, kind } : t)) }));
    dismissLater(id, opts.duration ?? DEFAULT_TOAST_MS);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// Imperative helper for use outside React components.
// （要拿 id 去 `update` 的场合用 `useToast.getState().show(...)` ✓；这里保持 void 以免影响既有调用方）
export function toast(message: string, kind?: ToastKind, opts?: ToastOptions): void {
  useToast.getState().show(message, kind, opts);
}
