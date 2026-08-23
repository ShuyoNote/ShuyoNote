import { create } from "zustand";
import { api } from "../lib/api";
import type { WorkspaceMeta } from "../types";

// Active workspace (space). The DB stores `active_workspace_id`; switching calls
// the backend then reloads pages. Built-in "默认空间" is created on first run.
interface SpaceState {
  spaces: WorkspaceMeta[];
  activeId: string | null;
  load: () => Promise<void>;
  create: (name?: string) => Promise<boolean>;
  switchTo: (id: string) => Promise<boolean>;
  rename: (id: string, name: string) => Promise<boolean>;
  setSettings: (id: string, theme?: string | null, icon?: string | null, sortOrder?: number) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
}

export const useSpaceStore = create<SpaceState>((set) => ({
  spaces: [],
  activeId: null,
  load: async () => {
    try {
      const [spaces, activeId] = await Promise.all([
        api.listWorkspaces(),
        api.getActiveWorkspaceId(),
      ]);
      set({ spaces, activeId });
    } catch (e) {
      console.error("load spaces failed", e);
    }
  },
  create: async (name) => {
    try {
      const ws = await api.createWorkspace(name);
      const spaces = await api.listWorkspaces();
      set({ spaces, activeId: ws.id });
      return true;
    } catch (e) {
      console.error("create workspace failed", e);
      return false;
    }
  },
  switchTo: async (id) => {
    try {
      await api.setActiveWorkspaceId(id);
      set({ activeId: id });
      return true;
    } catch (e) {
      console.error("switch workspace failed", e);
      return false;
    }
  },
  rename: async (id, name) => {
    try {
      await api.renameWorkspace(id, name);
      await useSpaceStore.getState().load();
      return true;
    } catch (e) {
      console.error("rename workspace failed", e);
      return false;
    }
  },
  setSettings: async (id, theme, icon, sortOrder) => {
    try {
      await api.setWorkspaceSettings(id, theme, icon, sortOrder);
      await useSpaceStore.getState().load();
      return true;
    } catch (e) {
      console.error("set workspace settings failed", e);
      return false;
    }
  },
  remove: async (id) => {
    try {
      await api.deleteWorkspace(id);
      const [spaces, activeId] = await Promise.all([
        api.listWorkspaces(),
        api.getActiveWorkspaceId(),
      ]);
      set({ spaces, activeId });
      return true;
    } catch (e) {
      console.error("delete workspace failed", e);
      return false;
    }
  },
}));
