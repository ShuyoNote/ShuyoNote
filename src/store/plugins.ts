import { create } from "zustand";
import { api } from "../lib/api";
import type { PluginMeta } from "../types";

// Disk-loaded plugins (scanned/manifest-validated by the backend, executed in a
// restricted boa runtime). Persisted enabled state lives in the DB.
interface PluginsState {
  plugins: PluginMeta[];
  managerOpen: boolean;
  setManagerOpen: (open: boolean) => void;
  load: () => Promise<void>;
  toggle: (id: string) => Promise<void>;
  uninstall: (id: string) => Promise<void>;
  install: (sourcePath: string) => Promise<void>;
  openDir: () => Promise<void>;
  runCommand: (pluginId: string, commandId: string, currentId?: string | null) => Promise<{ message: string; insert?: string | null }>;
}

export const usePlugins = create<PluginsState>((set) => ({
  plugins: [],
  managerOpen: false,
  setManagerOpen: (managerOpen) => set({ managerOpen }),
  load: () =>
    api
      .listPlugins()
      .then((p) => set({ plugins: p }))
      .catch((e) => console.error("list plugins failed", e)),
  toggle: async (id) => {
    const p = usePlugins.getState().plugins.find((x) => x.id === id);
    if (!p) return;
    try {
      await api.setPluginEnabled(id, !p.enabled);
      await usePlugins.getState().load();
    } catch (e) {
      console.error("toggle plugin failed", e);
    }
  },
  uninstall: async (id) => {
    try {
      await api.uninstallPlugin(id);
      await usePlugins.getState().load();
    } catch (e) {
      console.error("uninstall plugin failed", e);
    }
  },
  install: async (sourcePath) => {
    try {
      await api.installPlugin(sourcePath);
      await usePlugins.getState().load();
    } catch (e) {
      console.error("install plugin failed", e);
    }
  },
  openDir: async () => {
    try {
      await api.openPluginDir();
    } catch (e) {
      console.error("open plugin dir failed", e);
    }
  },
  runCommand: (pluginId, commandId, currentId) =>
    api.runPluginCommand(pluginId, commandId, currentId),
}));
