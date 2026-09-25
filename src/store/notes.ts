import { create } from "zustand";
import { emitHostEvent } from "../lib/pluginEvents";
import { api } from "../lib/api";
import type { PageDetail, PageMeta } from "../types";
import { useViewStore } from "./view";
import { useTemplateCenterStore } from "./templateCenter";
import { useFileManagerStore } from "./fileManager";
import { useFilePreview } from "./filePreview";

export interface NoteState {
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
  createPage: (parentId: string | null, content?: { content_json: string; content_text: string; title?: string }, opts?: { select?: boolean }) => Promise<string | null>;
  createFolder: (parentId: string | null) => Promise<void>;
  createDatabase: (parentId: string | null, title?: string) => Promise<string | null>;
  deletePage: (id: string) => Promise<void>;
  renamePage: (id: string, title: string) => Promise<void>;
  movePage: (id: string, parentId: string | null, sortOrder: number) => Promise<void>;
  updateCurrent: (patch: Partial<PageDetail>) => void;
  /**
   * 用一次保存的结果**就地**更新 `pages` 里那一条，替代"保存后 `loadPages()` 全量重拉"。
   *
   * 保存只可能改动 `PageMeta` 里的少数几个字段（标题 / `updated_at`）⇒ 没必要为它重查
   * 整张 page 表，也没必要付 `set(loading)` + `set(pages)` 两次全量广播（自动保存每
   * 600ms 就可能来一次，而 `pages` 的消费者里既有每个树节点一个的 TreeItem，也有
   * DatabaseView / FileManagerView 这种千行组件）。
   *
   * 返回 `false` 表示**列表里没有这一条**（例如刚在别处新建、本地 `pages` 还没刷新），
   * 调用方应回退到 `loadPages()`。返回 `true` 且没有任何字段真的变化时**不写 state**
   * （`pages` 引用保持不变）⇒ 订阅者一次都不会重渲染。
   *
   * ⚠️ 只合并 `PageMeta` 真的有的字段：调用方通常传的是整个 `PageDetail`（**还带正文**），
   * 整包塞进列表条目会把正文泄进侧栏数据里。
   */
  patchPageMeta: (page: Partial<PageMeta> & { id: string }) => boolean;
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
      // 播报事实即可，谁听由插件层决定（见 lib/pluginEvents）。
      emitHostEvent("page.opened", { pageId: id });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  createPage: async (parentId, content?, opts?) => {
    try {
      const page = await api.createPage({
        parent_id: parentId,
        title: content?.title ?? "",
        content_json: content?.content_json,
        content_text: content?.content_text,
      });
      await get().loadPages();
      // ⚠️ `select: false` 是给**后台批量建页**用的（首次进入空间时预置「使用指南」
      // 那 20 多页）。默认要选中并把视图切回笔记——那是"用户点了新建"的语义；
      // 但后台预置如果也这么干，就会**一页一页地把用户当前打开的页面顶掉**：
      // 预置是异步跑的，用户在这几秒里点开/新建的任何页面都会被下一句
      // `set({ currentId })` 抢走，表现就是"点了没反应"（实测：从模板中心建一个
      // 数据库页，几秒后当前页变成了「使用指南」里某一页）。
      if (opts?.select === false) return page.id;
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

  createDatabase: async (parentId, title) => {
    try {
      const db = await api.createDatabase({ parent_id: parentId, title: title ?? "新建数据库" });
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
      emitHostEvent("page.deleted", { pageId: id });
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

  // 见接口上的长注释：保存路径用这个**就地**更新，别为一次标题改动重拉整表。
  patchPageMeta: (page) => {
    const { pages } = get();
    const i = pages.findIndex((p) => p.id === page.id);
    // 列表里没有这一条 ⇒ 让调用方回退到 loadPages()，不要在这里悄悄吞掉。
    if (i < 0) return false;

    const cur = pages[i];
    const merged: PageMeta = { ...cur };
    let changed = false;
    const assign = <K extends keyof PageMeta>(k: K, v: PageMeta[K] | undefined) => {
      if (v !== undefined && v !== cur[k]) {
        merged[k] = v;
        changed = true;
      }
    };
    // 只列可变的元数据字段：id / workspace_id / created_at 是身份，不该由一次保存改写。
    // 逐个列（而不是遍历 keys）是为了让"哪些字段允许被保存路径改写"在代码里看得见，
    // 也避免 `any`。
    assign("title", page.title);
    assign("icon", page.icon);
    assign("kind", page.kind);
    assign("parent_id", page.parent_id);
    assign("sort_order", page.sort_order);
    assign("updated_at", page.updated_at);
    assign("deleted_at", page.deleted_at);

    // 一个字段都没变 ⇒ **不写 state**：pages 引用不变，所有订阅者一次都不重渲染。
    if (!changed) return true;

    const next = pages.slice();
    next[i] = merged;
    set({ pages: next });
    return true;
  },

  bumpReload: () => set((s) => ({ reloadTick: s.reloadTick + 1 })),

  setSearchQuery: (q) => set({ searchQuery: q }),
  clearSearchQuery: () => set({ searchQuery: "" }),
}));
