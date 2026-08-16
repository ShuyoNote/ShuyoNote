import { create } from "zustand";
import { api } from "../lib/api";
import type { PageDetail, PageMeta } from "../types";

interface NoteState {
  pages: PageMeta[];
  currentId: string | null;
  current: PageDetail | null;
  loading: boolean;
  error: string | null;

  loadPages: () => Promise<void>;
  openPage: (id: string) => Promise<void>;
  createPage: (parentId: string | null) => Promise<string | null>;
  deletePage: (id: string) => Promise<void>;
  renamePage: (id: string, title: string) => Promise<void>;
  movePage: (id: string, parentId: string | null, sortOrder: number) => Promise<void>;
  updateCurrent: (patch: Partial<PageDetail>) => void;
}

export const useNotes = create<NoteState>((set, get) => ({
  pages: [],
  currentId: null,
  current: null,
  loading: false,
  error: null,

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
    } catch (e) {
      set({ error: String(e) });
    }
  },

  createPage: async (parentId) => {
    try {
      const page = await api.createPage({ parent_id: parentId, title: "" });
      await get().loadPages();
      set({ currentId: page.id, current: page });
      return page.id;
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
}));
