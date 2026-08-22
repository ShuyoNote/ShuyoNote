import { create } from "zustand";

export interface ConfirmOptions {
  title?: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ConfirmState {
  options: ConfirmOptions | null;
  resolver: ((v: boolean) => void) | null;
  open: (options: ConfirmOptions) => Promise<boolean>;
  close: (result: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  options: null,
  resolver: null,
  open: (options) =>
    new Promise<boolean>((resolve) => {
      set({ options, resolver: resolve });
    }),
  close: (result) => {
    get().resolver?.(result);
    set({ options: null, resolver: null });
  },
}));

// In-app confirmation dialog, centered in the app window (not the OS screen).
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().open(options);
}
