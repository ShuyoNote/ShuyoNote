import { create } from "zustand";

export interface InputOptions {
  title?: string;
  placeholder?: string;
  defaultValue?: string;
  okLabel?: string;
  cancelLabel?: string;
  // The plain-text input. Returns the trimmed value, or null when cancelled.
  onSubmit?: (value: string) => void;
}

interface InputState {
  options: InputOptions | null;
  open: (options: InputOptions) => void;
  close: () => void;
}

export const useInputStore = create<InputState>((set) => ({
  options: null,
  open: (options) => set({ options }),
  close: () => set({ options: null }),
}));

// In-app text-input dialog, centered in the app window (not the OS screen).
export function inputDialog(options: InputOptions): void {
  useInputStore.getState().open(options);
}
