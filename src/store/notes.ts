import { create } from "zustand";
import { api } from "../lib/api";
import type { PageDetail, PageMeta } from "../types";
import { useViewStore } from "./view";
import { useTemplateCenterStore } from "./templateCenter";
import { useFileManagerStore } from "./fileManager";
import { useFilePreview } from "./filePreview";

interface NoteState {
  pages: PageMeta[];
  currentId: string | null;
  current: PageDetail | null;
  loading: boolean;
  error: string | null;
  /** Non-empty query highlights & scrolls to matches in the editor. */
  searchQuery: string;
  /** Bumped on EXTERNAL (e.g. AI-confirmed) content changes so the editor reloads. */
  reloadTick: number;

  loadPages: () => Promise<void>;
  openPage: (id: string) => Promise<void>;
  createPage: (parentId: string | null, content?: { content_json: string; content_text: string; title?: string }) => Promise<string | null>;
  createFolder: (parentId: string | null) => Promise<void>;
  createDatabase: (parentId: string | null) => Promise<string | null>;
  deletePage: (id: string) => Promise<void>;
  renamePage: (id: string, title: string) => Promise<void>;
  movePage: (id: string, parentId: string | null, sortOrder: number) => Promise<void>;
  updateCurrent: (patch: Partial<PageDetail>) => void;
  bumpReload: () => void;
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
  reloadTick: 0,

  loadPages: async () => {
    set({ loading: true, error: null });
    try {
      const pages = await api.listPages();
      // If the current page is no longer reachable (e.g. we switched spaces or it
      // was deleted), clear the selection so the sidebar/auto-open resets.
      const { currentId } = get();
      if (currentId && !pages.some((p) => p.id === currentId)) {
        set({ currentId: null, current: null });
      }
      set({ pages, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  openPage: async (id) => {
    try {
      // Opening a page closes any open file (md) preview.
      useFilePreview.getState().close();
      const current = await api.getPage(id);
      set({ currentId: id, current, error: null });
      // Opening a page/database switches back to the editor view and closes any
      // overlay (template center).
      useViewStore.getState().setView("notes");
      useTemplateCenterStore.getState().setOpen(false);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  createPage: async (parentId, content?) => {
    try {
      const page = await api.createPage({
        parent_id: parentId,
        title: content?.title ?? "",
        content_json: content?.content_json,
        content_text: content?.content_text,
      });
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
      // If the file-manager view is focused on a folder that was just deleted
      // (directly or as an ancestor), reset it to the workspace root so it
      // doesn't linger on a stale, non-existent folder.
      const fmFolderId = useFileManagerStore.getState().folderId;
      if (fmFolderId && !get().pages.some((p) => p.id === fmFolderId)) {
        useFileManagerStore.getState().setFolderId(null);
      }
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

  bumpReload: () => set((s) => ({ reloadTick: s.reloadTick + 1 })),

  setSearchQuery: (q) => set({ searchQuery: q }),
  clearSearchQuery: () => set({ searchQuery: "" }),
}));
