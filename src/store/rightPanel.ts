import { create } from "zustand";

// Coordinates the right-side drawers (AI assistant, doc TOC, comments/notifications,
// and plugin view panels) so they are mutually exclusive — opening one closes the
// others. Keeps the right side clean instead of stacking panels.
//
// ⚠️ 2026-10-01（owner 界面方向之①）：**右侧那条竖向工具条撤掉了** ✓ —— 入口全部搬到标题栏
// （`TitleBar.tsx` 的 `.titlebar-tools` ✓），⛔ 但**这几个抽屉本身一个没少** ✗：互斥关系、
// `releasePlugin`、返回键那套都照旧 ✓。所以本文件只管"哪个抽屉开着"，与"入口画在哪"无关 ✓。
interface RightPanelState {
  ai: boolean;
  toc: boolean;
  comments: boolean;
  /**
   * 抽屉打开时先落在哪一页 ✓（`CommentsDrawer` 的两颗页签 ✓）。
   *
   * 为什么要放进 store：owner 把原来那颗「评论 / 通知」**拆成两颗** ✗⇒✓（顶栏「讨论」与「通知」✓），
   * 而"点哪颗进哪页"是**入口**的事 ✓ —— 抽屉自己 hold 一个 `useState` 就做不到 ✓（那是旧形状 ✗）。
   */
  commentsTab: "comments" | "notifications";
  /**
   * 当前在右栏里打开的**插件视图**（`插件id::视图id`，见 lib/pluginViews 的
   * `viewPlacementKey`）；null = 没开。
   *
   * 为什么记在这里而不是插件视图 store：互斥是"右栏"这件事的属性——四个抽屉共用一条
   * 右栏，谁开谁关必须是同一处判断。视图**数据**仍在 pluginViews store（浮层与面板共用），
   * 这里只记"它是不是当前那个抽屉"。
   */
  plugin: string | null;
  openAi: (v: boolean) => void;
  openToc: (v: boolean) => void;
  /** 开/关「讨论 / 通知」抽屉 ✓；`tab` 只在**打开**时有意义（默认保持上次那一页 ✓）。 */
  openComments: (v: boolean, tab?: "comments" | "notifications") => void;
  setCommentsTab: (t: "comments" | "notifications") => void;
  /** 打开某个插件视图面板（传 null 关闭）。 */
  openPlugin: (key: string | null) => void;
  /** 插件视图换到了浮层/关闭时调用：只清"右栏占用"，不动视图数据。 */
  releasePlugin: () => void;
}

export const useRightPanel = create<RightPanelState>((set) => ({
  ai: false,
  toc: false,
  comments: false,
  commentsTab: "comments",
  plugin: null,
  openAi: (v) => set((s) => ({ ai: v, toc: v ? false : s.toc, comments: v ? false : s.comments, plugin: v ? null : s.plugin })),
  openToc: (v) => set((s) => ({ toc: v, ai: v ? false : s.ai, comments: v ? false : s.comments, plugin: v ? null : s.plugin })),
  openComments: (v, tab) =>
    set((s) => ({
      comments: v,
      commentsTab: v && tab ? tab : s.commentsTab,
      ai: v ? false : s.ai,
      toc: v ? false : s.toc,
      plugin: v ? null : s.plugin,
    })),
  setCommentsTab: (t) => set({ commentsTab: t }),
  openPlugin: (key) =>
    set((s) => ({
      plugin: key,
      ai: key ? false : s.ai,
      toc: key ? false : s.toc,
      comments: key ? false : s.comments,
    })),
  releasePlugin: () => set({ plugin: null }),
}));
