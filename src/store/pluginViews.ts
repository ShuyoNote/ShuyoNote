import { create } from "zustand";
import type { PluginView } from "../types";

/**
 * 当前打开的声明式视图（宿主渲染）。
 *
 * 单独一个 store 而不是塞进插件 store：视图是**只读展示**，与插件的启用/权限/日志
 * 这些状态没有关系；而且它要能被命令面板（视图入口）与浮层组件同时读写。
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
  open: (pluginId, pluginName, view) => set({ pluginId, pluginName, view }),
  close: () => set({ pluginId: null, pluginName: "", view: null }),
}));
