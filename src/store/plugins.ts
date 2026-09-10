import { create } from "zustand";
import { api } from "../lib/api";
import { toast } from "./toast";
import type { PluginMeta } from "../types";

// Disk-loaded plugins (scanned/manifest-validated by the backend, executed in a
// restricted boa runtime). Persisted enabled state lives in the DB.

/**
 * 用户触发操作的结果：`ok=false` 时 `error` 是后端返回的**原始错误文本**
 * （`store` 已同时把它弹成 error toast；命令面板等调用方可以就地再展示一次）。
 */
export interface PluginActionResult {
  ok: boolean;
  error?: string;
}

/**
 * 后端的错误就是 Rust 的 `Err(String)`（如 `manifest 解析失败: …`、`同名插件已存在`），
 * Tauri 原样抛出。取 `message` 只是为了不让 `Error` 包装多出一层 `Error: ` 前缀——
 * 无论哪种形态都保留原文，不要替换成通用文案。
 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface PluginsState {
  plugins: PluginMeta[];
  managerOpen: boolean;
  setManagerOpen: (open: boolean) => void;
  load: () => Promise<void>;
  toggle: (id: string) => Promise<PluginActionResult>;
  uninstall: (id: string) => Promise<PluginActionResult>;
  install: (sourcePath: string) => Promise<PluginActionResult>;
  openDir: () => Promise<PluginActionResult>;
  runCommand: (pluginId: string, commandId: string, currentId?: string | null) => Promise<{ message: string; insert?: string | null }>;
}

export const usePlugins = create<PluginsState>((set) => ({
  plugins: [],
  managerOpen: false,
  setManagerOpen: (managerOpen) => set({ managerOpen }),
  load: () =>
    api
      .listPlugins()
      .then((p) => set({ plugins: p }))
      .catch((e) => {
        console.error("list plugins failed", e);
        toast(`加载插件列表失败：${errText(e)}`, "error");
      }),
  toggle: async (id) => {
    const p = usePlugins.getState().plugins.find((x) => x.id === id);
    if (!p) {
      // 列表已过期（插件被外部删掉等）：以前是静默 return，用户点了等于没反应。
      const error = "插件不存在（列表可能已过期）";
      toast(`切换插件状态失败：${error}`, "error");
      return { ok: false, error };
    }
    const next = !p.enabled;
    try {
      await api.setPluginEnabled(id, next);
      await usePlugins.getState().load();
      toast(next ? `已启用插件「${p.name}」` : `已禁用插件「${p.name}」`, "success");
      return { ok: true };
    } catch (e) {
      console.error("toggle plugin failed", e);
      const error = errText(e);
      toast(`切换插件「${p.name}」失败：${error}`, "error");
      return { ok: false, error };
    }
  },
  uninstall: async (id) => {
    const name = usePlugins.getState().plugins.find((x) => x.id === id)?.name ?? id;
    try {
      await api.uninstallPlugin(id);
      await usePlugins.getState().load();
      toast(`已卸载插件「${name}」`, "success");
      return { ok: true };
    } catch (e) {
      console.error("uninstall plugin failed", e);
      const error = errText(e);
      toast(`卸载插件「${name}」失败：${error}`, "error");
      return { ok: false, error };
    }
  },
  install: async (sourcePath) => {
    try {
      // 后端装完就返回该插件的 meta（Web 版是 no-op，返回 undefined）。
      const meta = await api.installPlugin(sourcePath);
      await usePlugins.getState().load();
      toast(meta?.name ? `已安装插件「${meta.name}」` : "插件安装成功", "success");
      return { ok: true };
    } catch (e) {
      console.error("install plugin failed", e);
      const error = errText(e);
      toast(`安装插件失败：${error}`, "error");
      return { ok: false, error };
    }
  },
  openDir: async () => {
    try {
      await api.openPluginDir();
      // 成功不需要 toast：文件管理器会自己弹到前台，再说一遍是噪音。
      return { ok: true };
    } catch (e) {
      console.error("open plugin dir failed", e);
      const error = errText(e);
      toast(`打开插件目录失败：${error}`, "error");
      return { ok: false, error };
    }
  },
  runCommand: (pluginId, commandId, currentId) =>
    api.runPluginCommand(pluginId, commandId, currentId),
}));
