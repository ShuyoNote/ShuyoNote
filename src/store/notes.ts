import { create } from "zustand";
import { api } from "../lib/api";
import type { PageDetail, PageMeta } from "../types";
import { useViewStore } from "./view";

interface NoteState {
  pages: PageMeta[];
  currentId: string | null;
  current: PageDetail | null;
  loading: boolean;
  error: string | null;
  /** Non-empty query highlights & scrolls to matches in the editor. */
  searchQuery: string;

  loadPages: () => Promise<void>;
  openPage: (id: string) => Promise<void>;
  createPage: (parentId: string | null) => Promise<string | null>;
  createFolder: (parentId: string | null) => Promise<void>;
  createDatabase: (parentId: string | null) => Promise<string | null>;
  deletePage: (id: string) => Promise<void>;
  renamePage: (id: string, title: string) => Promise<void>;
  movePage: (id: string, parentId: string | null, sortOrder: number) => Promise<void>;
  updateCurrent: (patch: Partial<PageDetail>) => void;
  setSearchQuery: (q: string) => void;
  clearSearchQuery: () => void;
}

export const useNotes = create<NoteState>((set, get) => ({
  pages: [],
  currentId: null,
  current: null,
  loading: false,
  error: null,
  searchQuery: "",

  loadPages: async () => {
    set({ loading: true, error: null });
    try {
      const pages = await api.listPages();
      set({ pages, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  openPage: async (id) => {
    try {
      const current = await api.getPage(id);
      set({ currentId: id, current });
      // Opening a page/database switches back to the editor view.
      useViewStore.getState().setView("notes");
    } catch (e) {
      set({ error: String(e) });
    }
  },

  createPage: async (parentId) => {
    try {
      const page = await api.createPage({ parent_id: parentId, title: "" });
      await get().loadPages();
      set({ currentId: page.id, current: page });
      useViewStore.getState().setView("notes");
      return page.id;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  createFolder: async (parentId) => {
    try {
      await api.createFolder({ parent_id: parentId, title: "新建文件夹" });
      await get().loadPages();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  createDatabase: async (parentId) => {
    try {
      const db = await api.createDatabase({ parent_id: parentId, title: "新建数据库" });
      await get().loadPages();
      set({ currentId: db.id, current: db });
      useViewStore.getState().setView("notes");
      return db.id;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  deletePage: async (id) => {
    try {
      await api.deletePage(id);
      const { currentId } = get();
      if (currentId === id) {
        set({ currentId: null, current: null });
      }
      await get().loadPages();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  renamePage: async (id, title) => {
    try {
      await api.savePage({ id, title });
      await get().loadPages();
      if (get().currentId === id) {
        set({ current: { ...get().current!, title } });
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  movePage: async (id, parentId, sortOrder) => {
    try {
      await api.movePage({ id, new_parent_id: parentId, sort_order: sortOrder });
      await get().loadPages();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  updateCurrent: (patch) => {
    const { current } = get();
    if (current) set({ current: { ...current, ...patch } });
  },

  setSearchQuery: (q) => set({ searchQuery: q }),
  clearSearchQuery: () => set({ searchQuery: "" }),
}));
