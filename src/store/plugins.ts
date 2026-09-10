import { create } from "zustand";
import { api } from "../lib/api";
import { toast } from "./toast";
import type { PluginAuditEntry, PluginLogLine, PluginMeta } from "../types";

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
 * 一次插件命令执行的结果。
 *
 * `cancelled=true` 表示用户在等待期间点了「取消」——此时**结果被丢弃**：
 * 因为命令的副作用（`insert` 与 `toasts`）全都在返回值里，丢掉返回值就等于
 * 不产生任何半途写入（插件线程本身可能仍在后台跑完，Boa 没有中断 API）。
 */
export interface PluginRunOutcome {
  message: string;
  insert?: string | null;
  /** 插件通过 `__toast(...)` 发出的提示，由调用方弹给用户。 */
  toasts?: string[];
  cancelled?: boolean;
}

/** 正在执行的插件命令（用于「运行中 + 可取消」的可见状态）。 */
export interface RunningRun {
  seq: number;
  pluginId: string;
  commandId: string;
  title: string;
}

// 取消标记：按序号记录，避免把「用户点了取消」和「另一次执行」搞混。
let runSeq = 0;
const cancelledRuns = new Set<number>();

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
  runCommand: (pluginId: string, commandId: string, currentId?: string | null) => Promise<PluginRunOutcome>;
  /** 当前正在执行的插件命令（null = 空闲）。 */
  running: RunningRun | null;
  /** 放弃等待当前执行（结果会被丢弃）。 */
  cancelRun: () => void;
  /** 正在查看哪个插件的日志（null = 未打开）。 */
  logsFor: string | null;
  logs: PluginLogLine[];
  openLogs: (pluginId: string) => Promise<void>;
  closeLogs: () => void;
  clearLogs: () => Promise<void>;
  /** 正在查看哪个插件的能力调用审计（null = 未打开）。 */
  auditFor: string | null;
  audit: PluginAuditEntry[];
  openAudit: (pluginId: string) => Promise<void>;
  closeAudit: () => void;
  clearAudit: () => Promise<void>;
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
      // 新装的插件默认**未启用**：提示用户先看权限再启用（安装不等于授权）。
      toast(
        meta?.name ? `已安装插件「${meta.name}」（默认未启用，请确认权限后点「启用」）` : "插件安装成功",
        "success",
      );
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
  runCommand: async (pluginId, commandId, currentId) => {
    const seq = ++runSeq;
    const title =
      usePlugins.getState().plugins.find((p) => p.id === pluginId)?.commands.find((c) => c.id === commandId)?.title ??
      commandId;
    set({ running: { seq, pluginId, commandId, title } });
    try {
      const res = await api.runPluginCommand(pluginId, commandId, currentId);
      if (cancelledRuns.delete(seq)) {
        // 用户已取消：丢弃结果。副作用都在返回值里，丢掉即「无半途写入」。
        return { message: "", cancelled: true };
      }
      return res;
    } finally {
      if (usePlugins.getState().running?.seq === seq) set({ running: null });
    }
  },
  running: null,
  cancelRun: () => {
    const r = usePlugins.getState().running;
    if (!r) return;
    cancelledRuns.add(r.seq);
    set({ running: null });
    // 诚实提示：我们放弃的是「等待」，不是插件线程 —— Boa 没有中断 API，
    // 被遗弃的线程会自己跑完（彻底解决要等 M11.13 宿主子进程化）。
    toast("已取消等待；插件代码可能仍在后台跑完", "info");
  },
  logsFor: null,
  logs: [],
  openLogs: async (pluginId) => {
    try {
      const logs = await api.pluginLogs(pluginId);
      set({ logs, logsFor: pluginId });
    } catch (e) {
      console.error("load plugin logs failed", e);
      toast(`读取插件日志失败：${errText(e)}`, "error");
    }
  },
  closeLogs: () => set({ logsFor: null, logs: [] }),
  auditFor: null,
  audit: [],
  openAudit: async (pluginId) => {
    try {
      const audit = await api.pluginAudit(pluginId);
      set({ audit, auditFor: pluginId });
    } catch (e) {
      console.error("load plugin audit failed", e);
      toast(`读取插件活动失败：${errText(e)}`, "error");
    }
  },
  closeAudit: () => set({ auditFor: null, audit: [] }),
  clearAudit: async () => {
    try {
      await api.clearPluginAudit();
      set({ audit: [] });
    } catch (e) {
      console.error("clear plugin audit failed", e);
      toast(`清空插件活动失败：${errText(e)}`, "error");
    }
  },
  clearLogs: async () => {
    try {
      await api.clearPluginLogs();
      set({ logs: [] });
    } catch (e) {
      console.error("clear plugin logs failed", e);
      toast(`清空插件日志失败：${errText(e)}`, "error");
    }
  },
}));
