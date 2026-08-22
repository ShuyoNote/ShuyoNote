import { create } from "zustand";

interface TemplateCenterState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

// Shared flag so the sidebar "模板中心" button opens the template gallery view.
export const useTemplateCenterStore = create<TemplateCenterState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
