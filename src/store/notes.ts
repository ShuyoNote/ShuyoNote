import { create } from "zustand";
import { emitHostEvent } from "../lib/pluginEvents";
import { api } from "../lib/api";
import type { PageDetail, PageMeta } from "../types";
import { useViewStore } from "./view";

import { useFileManagerStore } from "./fileManager";
import { useFilePreview } from "./filePreview";

// ── 「刷新之后还记得当前文档」──────────────────────────────────────────────────
// 2026-10-05 owner 实测报的：「页面刷新后，忘记了当前文档」。
//
// 存 **localStorage**（不是用户数据表）：它是**这台设备的界面状态**，与本仓其它界面记忆同一套做法
// （`AiAssistantPanel` 的面板宽、`EmojiPicker` 的最近用、`FileManagerView` 的视图/网格尺寸都在这儿）。
// 读写一律 `try/catch`：隐私模式/配额异常时**记不住也不该影响用**（退化成"不还原"）。
const LAST_PAGE_KEY = "shuyonote:lastPageId";

function readRememberedPageId(): string {
  try {
    return localStorage.getItem(LAST_PAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberPageId(id: string): void {
  try {
    if (id) localStorage.setItem(LAST_PAGE_KEY, id);
  } catch {
    /* 记不住不影响用 */
  }
}

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
  /**
   * 启动后是否**已经尝试过**还原"上次打开的文档"（只做一次）。
   *
   * 为什么放在 state 而不是模块变量：测试能显式重置它，行为也**看得见**（不必去猜模块级副作用）。
   */
  lastPageRestored: boolean;

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
  lastPageRestored: false,

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
      // ⭐ 2026-10-05（owner：「页面刷新后，忘记了当前文档」）：**本次启动的第一次**列表加载之后，
      //    如果什么都没选中、而"记住的那一页"还在列表里 ⇒ 打开它。
      //    · 只做一次（`lastPageRestored`）—— 之后清空选择（删掉当前页、换空间）不该被"拉回去"；
      //    · 列表 membership 检查同时挡掉两种失效：那一页被删了 / 记住的是**另一个空间**的页；
      //    · 不 await 到外面会早退：这里就 await（`openPage` 内部自己 try/catch，不会把 loadPages 打红）。
      if (!get().lastPageRestored) {
        set({ lastPageRestored: true });
        const remembered = readRememberedPageId();
        if (!get().currentId && remembered && pages.some((p) => p.id === remembered)) {
          await get().openPage(remembered);
        }
      }
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
      // ⭐ 2026-10-05：**当前文档**在这里被记住（`openPage` 是"换文档"的唯一收口）⇒
      //    刷新/重开之后由 `loadPages` 那条一次性还原把它接回来。
      rememberPageId(id);
      // Opening a page/database switches back to the editor view and closes any
      // overlay (template center).
      useViewStore.getState().setView("notes");
      // ⚠️ **2026-10-04 删掉一行**：这里原来跟着一句 `leaveTemplates()` ✗ —— 它的意图是「关掉模板中心」✓，
      //   但模板中心**并进 view 之后自己就是** `view === "templates"` ✓ ⇒ 上面那句已经离开它了 ✓。
      //   ⚠️ 而 `leaveTemplates()` 会把 view 设回 `prevView` ✗ ⇒ ⭐ 从看板进模板中心、再打开页面时，
      //   view 会被改成 **board** ✗（⭐ 症状＝点了页面却停在看板 ✓ —— 平时 prevView 常等于 notes ⇒ 不易发现 ✓）。
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
