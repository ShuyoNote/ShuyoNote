import { create } from "zustand";
import type { PluginView } from "../types";
import { viewPlacement, viewPlacementKey } from "../lib/pluginViews";
import { useRightPanel } from "./rightPanel";

/**
 * 当前打开的声明式视图（宿主渲染）。
 *
 * 单独一个 store 而不是塞进插件 store：视图是**只读展示**，与插件的启用/权限/日志
 * 这些状态没有关系；而且它要能被命令面板（视图入口）、浮层与右侧面板同时读写。
 *
 * `open()` 是**唯一入口**：它按视图声明的落点（`overlay` / `rail`）顺手把右栏抽屉摆对
 * ——命令面板走浮层、右栏按钮走抽屉这种"两条路径各写一遍"的写法迟早会漂（一个入口忘了
 * 关别的抽屉，右栏就会出现两个面板并排）。
 */
interface PluginViewState {
  pluginId: string | null;
  pluginName: string;
  view: PluginView | null;
  open: (pluginId: string, pluginName: string, view: PluginView) => void;
  close: () => void;
}

export const usePluginViewStore = create<PluginViewState>((set) => ({
  pluginId: null,
  pluginName: "",
  view: null,
  open: (pluginId, pluginName, view) => {
    const rail = viewPlacement(view) === "rail";
    useRightPanel.getState().openPlugin(rail ? viewPlacementKey(pluginId, view) : null);
    set({ pluginId, pluginName, view });
  },
  close: () => {
    useRightPanel.getState().releasePlugin();
    set({ pluginId: null, pluginName: "", view: null });
  },
}));
