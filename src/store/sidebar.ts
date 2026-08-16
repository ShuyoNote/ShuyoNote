import { create } from "zustand";

const STORAGE_KEY = "shuyonote-sidebar-collapsed";

interface SidebarState {
  collapsed: boolean;
  toggle: () => void;
  setCollapsed: (v: boolean) => void;
}

export const useSidebar = create<SidebarState>((set, get) => ({
  collapsed: localStorage.getItem(STORAGE_KEY) === "1",
  toggle: () => {
    const next = !get().collapsed;
    localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    set({ collapsed: next });
  },
  setCollapsed: (v) => {
    localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    set({ collapsed: v });
  },
}));
