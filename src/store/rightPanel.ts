import { create } from "zustand";

// Coordinates the right-side drawers (AI assistant, doc TOC, and plugin view panels)
// so they are mutually exclusive — opening one closes the
// others. Keeps the right side clean instead of stacking panels.
//
// ⚠️ 2026-10-01（owner 界面方向之①）：**右侧那条竖向工具条撤掉了** ✓ —— 入口全部搬到标题栏
// （`TopTools.tsx` ✓，桌面在 `TitleBar` 里、手机在 `App.tsx` 顶部 ✓），⛔ 但**这几个抽屉本身一个没少** ✗：互斥关系、
// `releasePlugin`、返回键那套都照旧 ✓。所以本文件只管"哪个抽屉开着"，与"入口画在哪"无关 ✓。
interface RightPanelState {
  ai: boolean;
  toc: boolean;
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
  /** 打开某个插件视图面板（传 null 关闭）。 */
  openPlugin: (key: string | null) => void;
  /** 插件视图换到了浮层/关闭时调用：只清"右栏占用"，不动视图数据。 */
  releasePlugin: () => void;
}

export const useRightPanel = create<RightPanelState>((set) => ({
  ai: false,
  toc: false,
  plugin: null,
  openAi: (v) => set((s) => ({ ai: v, toc: v ? false : s.toc, plugin: v ? null : s.plugin })),
  openToc: (v) => set((s) => ({ toc: v, ai: v ? false : s.ai, plugin: v ? null : s.plugin })),
  openPlugin: (key) =>
    set((s) => ({
      plugin: key,
      ai: key ? false : s.ai,
      toc: key ? false : s.toc,
    })),
  releasePlugin: () => set({ plugin: null }),
}));
