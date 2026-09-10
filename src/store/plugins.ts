import { create } from "zustand";
import { api } from "../lib/api";
import { toast } from "./toast";
import { confirmAndApplyDrafts } from "../lib/pluginDrafts";
import { registerHostEventEmitter } from "../lib/pluginEvents";
import type {
  PluginAuditEntry,
  PluginEventOutcome,
  PluginDraft,
  PluginExport,
  PluginLogLine,
  PluginMeta,
  PluginSetting,
  PluginValidation,
} from "../types";

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
 * 不产生任何半途写入。
 *
 * M11.13 起「取消」是**真的终止**：前端把 `runId` 随调用带过去，取消时调
 * `cancel_plugin_run` 杀掉那次运行的宿主子进程（此前只是不再等它，插件代码还在后台跑完）。
 */
export interface PluginRunOutcome {
  message: string;
  insert?: string | null;
  /** 插件通过 `__toast(...)` 发出的提示，由调用方弹给用户。 */
  toasts?: string[];
  /** 写能力产出的草稿：**还没落库**，需调用方先让用户确认。 */
  drafts?: PluginDraft[];
  /** `api.files.export` 的产物：**还没写盘**，需调用方弹保存对话框（见 lib/pluginExports）。 */
  exports?: PluginExport[];
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
  /**
   * M11.11a：从一份索引安装一个插件（URL + 索引里那条的 id）。
   *
   * `pubkey` 是用户信任的 minisign 公钥；给了就必须验签通过才继续。
   */
  installFromIndex: (url: string, id: string, pubkey?: string | null) => Promise<PluginActionResult>;
  openDir: () => Promise<PluginActionResult>;
  runCommand: (
    pluginId: string,
    commandId: string,
    currentId?: string | null,
    /** 参数表单交回的值（JSON 字符串）；命令没有参数时不传。 */
    argsJson?: string,
  ) => Promise<PluginRunOutcome>;
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
  /**
   * 正在查看哪个插件的设置（null = 未打开）。
   *
   * 设置是**用户在宿主界面填、插件只读**的配置（`api.settings.get`）。写权限只在
   * 这里——插件侧对 `setting:` 命名空间是只读的（后端会拒），这样"用户看到的配置"
   * 始终等于"他亲手设的那个"。
   */
  settingsFor: string | null;
  settings: PluginSetting[];
  openSettings: (pluginId: string) => Promise<void>;
  closeSettings: () => void;
  saveSetting: (pluginId: string, key: string, value: string) => Promise<void>;
  /** 正在查看哪个插件的能力调用审计（null = 未打开）。 */
  auditFor: string | null;
  audit: PluginAuditEntry[];
  openAudit: (pluginId: string) => Promise<void>;
  closeAudit: () => void;
  clearAudit: () => Promise<void>;
  /**
   * 作者工具链：按插件 id 的校验结果（后端 `validate_plugin`，与加载器同源）。
   * 只在用户点了「验证」的插件上有值。
   */
  /**
   * 重新确认插件声明：插件新增权限/事件后，宿主会暂停它，这是唯一的放行方式。
   *
   * 刻意**不是**"再点一次启用"：用户要做的是"看了新增的那几项再确认"，
   * 而不是去点一个与权限无关的开关（那样他根本不会意识到自己同意了新东西）。
   */
  approve: (id: string) => Promise<PluginActionResult>;
  validations: Record<string, PluginValidation>;
  verify: (id: string) => Promise<void>;
  closeVerify: (id: string) => void;
  /**
   * 热重载：插件目录的指纹。打开插件面板时低频轮询，指纹变了就重新扫描列表
   * （命令面板同步刷新）并重跑已展开的校验——作者改完文件不必手动重启。
   */
  dirStamp: string | null;
  autoReloadedAt: number | null;
  watchPluginDir: () => Promise<void>;
  /**
   * 派发一个宿主事件给声明订阅了它的启用插件。
   *
   * 调用方**不 await**（保存路径不该等插件），失败也不影响主流程。结果处理见实现：
   * 提示直接弹；**草稿汇总成一次确认**（事件触发时用户没在看确认框，但插件也绝不能
   * 静默写入笔记）；失败只汇总提示一句，明细在插件日志里。
   */
  emitEvent: (event: string, payload?: Record<string, unknown>) => Promise<void>;
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
  installFromIndex: async (url, id, pubkey) => {
    try {
      const meta = await api.installPluginFromIndex(url, id, pubkey ?? null);
      await usePlugins.getState().load();
      // 与本地安装同一条规矩：装完默认禁用，先看权限再启用。
      toast(
        meta?.name
          ? `已从索引安装插件「${meta.name}」（默认未启用，请确认权限后点「启用」）`
          : "已从索引安装插件",
        "success",
      );
      return { ok: true };
    } catch (e) {
      console.error("install plugin from index failed", e);
      const error = errText(e);
      toast(`从索引安装失败：${error}`, "error");
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
  runCommand: async (pluginId, commandId, currentId, argsJson) => {
    const seq = ++runSeq;
    const title =
      usePlugins.getState().plugins.find((p) => p.id === pluginId)?.commands.find((c) => c.id === commandId)?.title ??
      commandId;
    set({ running: { seq, pluginId, commandId, title } });
    try {
      const res = await api.runPluginCommand(pluginId, commandId, currentId, argsJson, seq);
      if (cancelledRuns.delete(seq)) {
        // 用户已取消：丢弃结果。副作用都在返回值里，丢掉即「无半途写入」。
        return { message: "", cancelled: true };
      }
      return res;
    } catch (e) {
      // 取消会让后端以 cancelled 结束（子进程被杀 → 通道断开 → 我们**翻译**成"用户取消"）。
      // 这是用户自己的动作，不该再弹一个错误给他。
      if (cancelledRuns.delete(seq)) return { message: "", cancelled: true };
      throw e;
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
    // **真的终止**：让后端杀掉这次运行的宿主子进程（M11.13 / D4）。失败不报错——
    // 取消是"尽力而为"，用户手慢一点（那次运行刚好结束）不该换来一个错误提示。
    void api.cancelPluginRun(r.seq).catch((e) => console.error("cancel plugin run failed", e));
    toast("已终止插件", "info");
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
  settingsFor: null,
  settings: [],
  openSettings: async (pluginId) => {
    try {
      const settings = await api.pluginSettings(pluginId);
      set({ settings, settingsFor: pluginId });
    } catch (e) {
      console.error("load plugin settings failed", e);
      toast(`读取插件设置失败：${errText(e)}`, "error");
    }
  },
  closeSettings: () => set({ settingsFor: null, settings: [] }),
  saveSetting: async (pluginId, key, value) => {
    try {
      await api.setPluginSetting(pluginId, key, value);
      // 回读：让界面显示的是**真正落库的值**（后端可能规范化过，例如数字去空格），
      // 而不是我们以为写进去的值。
      const settings = await api.pluginSettings(pluginId);
      set({ settings, settingsFor: pluginId });
      toast("设置已保存", "success");
    } catch (e) {
      console.error("save plugin setting failed", e);
      toast(`保存设置失败：${errText(e)}`, "error");
    }
  },
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
  approve: async (id) => {
    const name = usePlugins.getState().plugins.find((x) => x.id === id)?.name ?? id;
    try {
      await api.approvePlugin(id);
      await usePlugins.getState().load();
      toast(`已重新确认插件「${name}」的声明`, "success");
      return { ok: true };
    } catch (e) {
      console.error("approve plugin failed", e);
      const error = errText(e);
      toast(`重新确认插件「${name}」失败：${error}`, "error");
      return { ok: false, error };
    }
  },
  validations: {},
  verify: async (id) => {
    try {
      const r = await api.validatePlugin(id);
      set((s) => ({ validations: { ...s.validations, [id]: r } }));
    } catch (e) {
      console.error("validate plugin failed", e);
      toast(`校验插件失败：${errText(e)}`, "error");
    }
  },
  // 收起校验面板：连同结果一起清掉，下次点是重新跑（插件文件可能已经改了）。
  closeVerify: (id) =>
    set((s) => {
      const next = { ...s.validations };
      delete next[id];
      return { validations: next };
    }),
  dirStamp: null,
  autoReloadedAt: null,
  emitEvent: async (event, payload) => {
    let outcomes: PluginEventOutcome[] = [];
    try {
      outcomes = await api.emitPluginEvent(event, payload ? JSON.stringify(payload) : undefined);
    } catch (e) {
      // 事件派发失败不该影响保存本身（例如插件目录读不到）：记 console，不打扰用户。
      console.error("emit plugin event failed", e);
      return;
    }
    if (outcomes.length === 0) return;
    for (const o of outcomes) for (const t of o.toasts) toast(t, "info");

    const withDrafts = outcomes.filter((o) => o.drafts.length > 0);
    if (withDrafts.length > 0) {
      const all = withDrafts.flatMap((o) => o.drafts);
      const who = withDrafts.map((o) => `「${o.plugin_name}」`).join("、");
      await confirmAndApplyDrafts(`${who}（${event}）`, all);
    }
    const failed = outcomes.filter((o) => o.error);
    if (failed.length > 0) {
      toast(
        `${failed.length} 个插件的「${event}」处理失败：${failed.map((o) => o.plugin_name).join("、")}（详见插件日志）`,
        "error",
      );
    }
  },
  watchPluginDir: async () => {
    let stamp: string;
    try {
      stamp = await api.pluginDirStamp();
    } catch {
      return; // Web 版没有磁盘插件（返回空串），静默跳过
    }
    const prev = usePlugins.getState().dirStamp;
    if (prev === null) {
      // 首次只记基线：否则一打开面板就"检测到变化"，等于每次都在自欺。
      set({ dirStamp: stamp });
      return;
    }
    if (stamp === prev) return;
    set({ dirStamp: stamp });
    await usePlugins.getState().load();
    // 已展开的校验结果基于旧文件，重跑一遍（作者的循环：改文件 → 自动重扫 → 看结果）
    const open = Object.keys(usePlugins.getState().validations);
    for (const id of open) await usePlugins.getState().verify(id);
    set({ autoReloadedAt: Date.now() });
  },
}));

/**
 * 宿主事实 → 插件事件的桥（见 lib/pluginEvents 为什么要有这一层）。
 *
 * 这里有一道**快速路径**：没有「启用中且订阅了该事件」的插件时，连 IPC 都不发。
 * 理由是 `page.opened` 这类事件每次切页都会播报，而为它每次都跨进程问一圈
 * （读一遍各插件 manifest）是不必要的开销；插件列表本来就在内存里，判断是免费的。
 * 代价：列表过期时可能漏发——但列表在启动时就加载，且插件增删都会刷新它。
 */
registerHostEventEmitter((event, payload) => {
  const st = usePlugins.getState();
  const hasSubscriber = st.plugins.some(
    (pl) => pl.enabled && (pl.events ?? []).some((e) => e.id === event),
  );
  if (!hasSubscriber) return;
  void st.emitEvent(event, payload);
});
