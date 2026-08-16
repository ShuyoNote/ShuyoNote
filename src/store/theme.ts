import { create } from "zustand";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "shuyonote-theme";

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false;
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const resolved = theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
  root.setAttribute("data-theme", resolved);
}

interface ThemeState {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

export const useTheme = create<ThemeState>((set) => ({
  theme: (localStorage.getItem(STORAGE_KEY) as Theme) || "system",
  setTheme: (t) => {
    localStorage.setItem(STORAGE_KEY, t);
    applyTheme(t);
    set({ theme: t });
  },
}));

// Apply on startup.
const initial = (localStorage.getItem(STORAGE_KEY) as Theme) || "system";
applyTheme(initial);

// React to system theme changes when in "system" mode.
window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
  const current = (localStorage.getItem(STORAGE_KEY) as Theme) || "system";
  if (current === "system") applyTheme("system");
});
