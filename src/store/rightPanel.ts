import { create } from "zustand";

// Coordinates the right-side drawers (AI assistant, doc TOC, comments, and plugin
// view panels) so they are mutually exclusive — opening one closes the others.
// Keeps the right side clean instead of stacking panels.
interface RightPanelState {
  ai: boolean;
  toc: boolean;
  comments: boolean;
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
  openComments: (v: boolean) => void;
  /** 打开某个插件视图面板（传 null 关闭）。 */
  openPlugin: (key: string | null) => void;
  /** 插件视图换到了浮层/关闭时调用：只清"右栏占用"，不动视图数据。 */
  releasePlugin: () => void;
}

export const useRightPanel = create<RightPanelState>((set) => ({
  ai: false,
  toc: false,
  comments: false,
  plugin: null,
  openAi: (v) => set((s) => ({ ai: v, toc: v ? false : s.toc, comments: v ? false : s.comments, plugin: v ? null : s.plugin })),
  openToc: (v) => set((s) => ({ toc: v, ai: v ? false : s.ai, comments: v ? false : s.comments, plugin: v ? null : s.plugin })),
  openComments: (v) => set((s) => ({ comments: v, ai: v ? false : s.ai, toc: v ? false : s.toc, plugin: v ? null : s.plugin })),
  openPlugin: (key) =>
    set((s) => ({
      plugin: key,
      ai: key ? false : s.ai,
      toc: key ? false : s.toc,
      comments: key ? false : s.comments,
    })),
  releasePlugin: () => set({ plugin: null }),
}));
