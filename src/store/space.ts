import { create } from "zustand";
import { emitHostEvent } from "../lib/pluginEvents";
import { api } from "../lib/api";
import { refreshVault } from "../lib/vault";
import { useNotes } from "./notes";
import { toast } from "./toast";
import type { WorkspaceMeta } from "../types";

/**
 * ⭐ 拒绝的**两档**要从**明确信号**判 —— 用 `space_security_overview` 的每空间读数 ✓，
 * ⛔ **不再嗅错误字符串** ✗（内核换一句文案，那种判法就**静默失准** ✓ —— 那正是"判据要有牙"的反面 ✗）。
 *
 * ⚠️ 与内核那条闸门**同一算法**（`security.rs:703` `active_space_needs_passphrase`
 *    ＝ `encrypted_on_disk && !key_available` ✓）⇒ 两侧口径**不许分家** ✓。
 * ⚠️ 读数拿不到（命令失败／这个空间不在列表里）⇒ **保守当"别的失败"** ✓：
 *    宁可少说一句"要口令"，也⛔ 不许凭空让用户去输口令 ✗。
 */
export async function refusalNeedsPassphrase(spaceId: string): Promise<boolean> {
  try {
    const rows = await api.spaceSecurityOverview();
    const st = rows.find((r) => r.space_id === spaceId);
    return Boolean(st && st.encrypted_on_disk && !st.key_available);
  } catch (e) {
    console.error("read space security overview failed", e);
    return false;
  }
}

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

export const useSpaceStore = create<SpaceState>((set, get) => ({
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
      // ⭐ 2026-10-10（本笔）：**切完还要重读一次口令锁读数** ✗ —— 否则界面**不知道活动空间换类型了** ✓。
      //
      // ⭐ 为什么必须有（owner 亲口问的「用户从明文空间，切换到加密空间怎么办？」✓）：
      //   `vaultState().locked` 原先只在**三处**被刷新 —— 挂载 ✓／开·关加密后 ✓／解锁后 ✓
      //   ⇒ ⭐ **切空间不刷新** ✗ ⇒ 启动时是明文空间（`LOCKED=false` ✓）⇒ 之后切到**加密**空间
      //     界面那边仍是 `locked=false` ⇒ 闸门 `activeSpaceEncrypted && locked` **判为 false** ✗
      //     ⇒ **不弹锁屏**，而那个空间其实读不出来 ✗（owner 报的正是这个 ✓）。
      //   ⇒ 读一次真读数，闸门就自己判对了 ✓（⛔ 判定**不在前端**做 ✗ —— 那是 owner 没选的 B ✓）。
      // ⚠️ `refreshVault()` 自己 `catch` 掉异常 ⇒ 它**不会**把切换弄成失败 ✓
      //   （返回值语义仍与以前一致 ✓）。
      await refreshVault();
      return true;
    } catch (e) {
      // ⚠️ **原始报错照旧进日志** ✓（排查全靠它 ✓）—— 只是**不进用户面** ✓（判据 d ✓）。
      console.error("switch workspace failed", e);
      // ⭐ 2026-10-10（owner 报「点了，没有弹窗」）：**拒绝不许只剩 `console.error`** ✗ ——
      //   用户那边读成「什么都没发生」✓ ⇒ 这里给一条**看得见**的反馈 ✓（Lead 拍的改法 ① ✓）。
      // ⚠️ Lead 的两条要求：a) 理由分两档、能分辨 ✓（判据＝`refusalNeedsPassphrase` 那个**明确信号** ✓
      //   ⛔ 不是这句话里有没有"口令" ✗）；b) ⛔ **只报一条**，不许把「拒绝」做成「什么都点不了」✗。
      // ⚠️ ⭐ **刻意不在这里 `refreshVault()`** ✗ —— 活动空间**没变** ⇒ 那句读数仍是原来那个空间的 ✓
      //   （刷了它就可能把闸门写成 true ⇒ 弹出一个**不该弹**的锁屏 ✗，那正是 owner 上次那条 ✓）。
      // ⚠️ 判据 d：这句话里 ⛔ **不许有空间 id** ✗（故回落用"那个空间"，⛔ 不是回落成 id ✗）、
      //   ⛔ **不许有「钥匙袋」**✗、⛔ **不许有英文原文** ✗ —— 原文只走上面那行 `console.error` ✓。
      const name = get().spaces.find((s) => s.id === id)?.name ?? "那个空间";
      const why = (await refusalNeedsPassphrase(id))
        ? "那个空间是加密的，要先输入口令才能进去。"
        : "内核拒绝了这次切换，请稍后再试。";
      toast(`切到「${name}」失败：${why}`, "error");
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
