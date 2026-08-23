import { create } from "zustand";
import { api } from "../lib/api";
import type { PluginMeta } from "../types";

// Disk-loaded plugins (scanned/manifest-validated by the backend, executed in a
// restricted boa runtime). Persisted enabled state lives in the DB.
interface PluginsState {
  plugins: PluginMeta[];
  load: () => Promise<void>;
  toggle: (id: string) => Promise<void>;
  runCommand: (pluginId: string, commandId: string, currentId?: string | null) => Promise<string>;
}

export const usePlugins = create<PluginsState>((set) => ({
  plugins: [],
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
  runCommand: (pluginId, commandId, currentId) =>
    api.runPluginCommand(pluginId, commandId, currentId),
}));
