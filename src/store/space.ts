import { create } from "zustand";
import { emitHostEvent } from "../lib/pluginEvents";
import { api } from "../lib/api";
import { useNotes } from "./notes";
import type { WorkspaceMeta } from "../types";

// Active workspace (space). The DB stores `active_workspace_id`; switching calls
// the backend then reloads pages. Built-in "默认空间" is created on first run.
interface SpaceState {
  spaces: WorkspaceMeta[];
  activeId: string | null;
  load: () => Promise<void>;
  /** ★ A1：`kind` ＝ 新建时的分类（`personal` / `team`）；不给 ⇒ 后端按 `personal`。 */
  create: (name?: string, kind?: "personal" | "team") => Promise<boolean>;
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
  create: async (name, kind) => {
    try {
      const ws = await api.createWorkspace(name, kind);
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
      emitHostEvent("space.switched", { spaceId: id });
      // ⭐ 2026-10-10：**切完必须重读页面列表** —— 否则侧栏/列表还停在旧空间的页上（`:110` 那段
      //   `loadPages` 的注释也这么说："we switched spaces" ✓）。
      //
      // ⭐⭐ **改动面前后**（commit 信息里也写了同一句）：
      //   原先 **四个调用点各自写了一遍** `if (ok) await loadPages()` ——
      //     `PageTree.tsx:1073-1075` ／ `NotificationCenter.tsx:81-82` ／ `SearchPanel.tsx:100-101`
      //     ／ 以及 `SettingsDialog` 里新加的那处 ✓；
      //   ⇒ 现在**收进这里一处** ✓。那三处的重复调用由各自的线删掉（本笔只收，⛔ 不改它们的文件 ✗）。
      //
      // ⚠️ **返回值语义没变** ✓：`true` / `false` 与失败时的行为都和以前一样 ✓
      //   （`loadPages` 自己 `catch` 掉异常 ⇒ 它**不会**把 switchTo 弄成失败 ✓）。
      // ⚠️ **量过的读数**（为什么"收一半"不行）：`store/notes.ts:106-109` 的 `loadPages`
      //   **没有**防重入 ✗／**没有**缓存 ✗／**没有**短路 ✗ ⇒ 每一次都是**真的** `await api.listPages()`
      //   ⇒ 过渡期里"调用点 ＋ 这里"都调 ＝ **白读一次** ✗（切空间低频 ⇒ 量级不大，但是确定的浪费 ✓）。
      //   ⛔ 本笔**刻意不给 `loadPages` 加防重入/去重** ✗ —— 那是**改行为**（两个并发调用者会共享一次读，
      //   而"第二个拿到的是不是它要的那一份"没人答得上来）⇒ 属于另一笔 ✓。
      await useNotes.getState().loadPages();
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
