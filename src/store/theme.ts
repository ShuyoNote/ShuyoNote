import { create } from "zustand";

export type Theme = "light" | "dark" | "system";
export type AccentId = "blue" | "green" | "purple" | "orange" | "red" | "teal";

const STORAGE_KEY = "shuyonote-theme";
const ACCENT_KEY = "shuyonote-accent";

export interface AccentDef {
  id: AccentId;
  name: string;
  light: string;
  softLight: string;
  /** darker shade of `light`, used for hover/pressed accent (`--accent-strong`). */
  strongLight: string;
  dark: string;
  softDark: string;
  strongDark: string;
}

export const ACCENTS: AccentDef[] = [
  { id: "blue", name: "品牌蓝", light: "#3370ff", softLight: "#ebf1ff", strongLight: "#2952cc", dark: "#4d8dff", softDark: "#22304a", strongDark: "#6ba0ff" },
  { id: "green", name: "绿", light: "#16a34a", softLight: "#e8f8ee", strongLight: "#15803d", dark: "#22c55e", softDark: "#1b3226", strongDark: "#4ade80" },
  { id: "purple", name: "紫", light: "#7c3aed", softLight: "#f0e9ff", strongLight: "#6d28d9", dark: "#a78bfa", softDark: "#2e2540", strongDark: "#c4b5fd" },
  { id: "orange", name: "橙", light: "#ea580c", softLight: "#fdeedd", strongLight: "#c2410c", dark: "#fb923c", softDark: "#3a2a1a", strongDark: "#fdba74" },
  { id: "red", name: "红", light: "#dc2626", softLight: "#fdeaea", strongLight: "#b91c1c", dark: "#f87171", softDark: "#3b1d1d", strongDark: "#fca5a5" },
  { id: "teal", name: "青", light: "#0d9488", softLight: "#e6f6f5", strongLight: "#0f766e", dark: "#2dd4bf", softDark: "#1c3432", strongDark: "#5eead4" },
];

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false;
}

function accentDef(id: AccentId): AccentDef {
  return ACCENTS.find((a) => a.id === id) ?? ACCENTS[0];
}

function applyAccent(id: AccentId, resolved: "light" | "dark") {
  const def = accentDef(id);
  const root = document.documentElement;
  const dark = resolved === "dark";
  root.style.setProperty("--accent", dark ? def.dark : def.light);
  root.style.setProperty("--accent-soft", dark ? def.softDark : def.softLight);
  // Hover/pressed accent shade, so buttons match the chosen accent tone.
  root.style.setProperty("--accent-strong", dark ? def.strongDark : def.strongLight);
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const resolved = theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
  root.setAttribute("data-theme", resolved);
  const accent = (localStorage.getItem(ACCENT_KEY) as AccentId) || "blue";
  applyAccent(accent, resolved);
}

interface ThemeState {
  theme: Theme;
  accent: AccentId;
  setTheme: (t: Theme) => void;
  setAccent: (id: AccentId) => void;
}

export const useTheme = create<ThemeState>((set) => ({
  theme: (localStorage.getItem(STORAGE_KEY) as Theme) || "system",
  accent: (localStorage.getItem(ACCENT_KEY) as AccentId) || "blue",
  setTheme: (t) => {
    localStorage.setItem(STORAGE_KEY, t);
    applyTheme(t);
    set({ theme: t });
  },
  setAccent: (id) => {
    localStorage.setItem(ACCENT_KEY, id);
    const resolved = (localStorage.getItem(STORAGE_KEY) as Theme) || "system";
    applyAccent(id, resolved === "system" ? (systemPrefersDark() ? "dark" : "light") : resolved);
    set({ accent: id });
  },
}));

// Apply on startup.
applyTheme((localStorage.getItem(STORAGE_KEY) as Theme) || "system");

// React to system theme changes when in "system" mode.
window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
  const current = (localStorage.getItem(STORAGE_KEY) as Theme) || "system";
  if (current === "system") applyTheme("system");
});
