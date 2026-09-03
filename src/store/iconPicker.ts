import { create } from "zustand";

// Global「更换图标」picker trigger: any consumer calls openIconPicker(onPick) to
// open the EmojiPicker overlay (currently the page icon buttons in App.tsx).
interface IconPickerState {
  open: boolean;
  onPick: ((emoji: string) => void) | null;
  openIconPicker: (onPick: (emoji: string) => void) => void;
  close: () => void;
}

export const useIconPicker = create<IconPickerState>((set) => ({
  open: false,
  onPick: null,
  openIconPicker: (onPick) => set({ open: true, onPick }),
  close: () => set({ open: false, onPick: null }),
}));
