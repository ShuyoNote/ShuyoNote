import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNotes } from "../store/notes";
import { usePlugins } from "../store/plugins";
import { runPluginCommandWithUi } from "../lib/pluginRun";
import { usePalette } from "../store/palette";
import { usePluginViewStore } from "../store/pluginViews";
import { viewPlacement } from "../lib/pluginViews";
import { useAiStore } from "../store/ai";
import { getBuiltinCommands, type CommandContext } from "../plugins/builtinCommands";
import { buildCommandArgs, initialParamValues } from "../lib/pluginParams";
import {
  baseName,
  dialogExtensions,
  filterLabel,
  importArgsJson,
  pluginTriggerItems,
} from "../lib/pluginImports";
import type { PluginCommandParam } from "../types";
import { api } from "../lib/api";
import { platform } from "../lib/platform";
import { PluginFieldInput } from "./PluginFieldInput";
import { approvalLabel, needsApproval } from "../lib/pluginApproval";

type Item =
  | { kind: "page"; id: string; title: string }
  | { kind: "command"; id: string; title: string; description?: string }
  | {
      kind: "plugin";
      pluginId: string;
      id: string;
      title: string;
      description?: string;
      closeOnRun?: boolean;
      /** 命令参数声明：非空时先渲染宿主生成的参数表单，再执行。 */
      params?: PluginCommandParam[];
    }
  | { kind: "plugin-toggle"; pluginId: string; title: string }
  | {
      kind: "plugin-view";
      pluginId: string;
      pluginName: string;
      view: import("../types").PluginView;
      title: string;
    }
  | {
      /** 宿主读用户的文件、交给插件的命令（manifest `triggers` 的 `kind: "import"`）。 */
      kind: "plugin-import";
      pluginId: string;
      pluginName: string;
      id: string;
      commandId: string;
      extensions: string[];
      title: string;
    }
  | {
      /** 跑的是一条导出命令：插件产出内容、用户在保存对话框里选存到哪里。 */
      kind: "plugin-export";
      pluginId: string;
      pluginName: string;
      id: string;
      commandId: string;
      extensions: string[];
      title: string;
    };

export function CommandPalette() {
  const { t } = useTranslation();
  const { pages, currentId, openPage } = useNotes();
  // 开关与查询词在 store 里：编辑器 `/` 菜单要把「带参数的命令」转交到这里的参数表单。
  const { open, setOpen, query, setQuery } = usePalette();
  const [result, setResult] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // 参数表单的状态（选中带参数的命令后，面板就地切成表单，而不是弹第二个对话框）。
  //
  // 这三个 useState 必须待在这里、而不是 `if (!open) return null` 之后：**hooks 不能
  // 有条件地调用**——面板关闭时少调 3 个、打开时又多调 3 个，React 会直接抛
  // 「Rendered more hooks than during the previous render」（生产构建是 Minified React
  // error #310），也就是**按 Ctrl+K 就白屏**（M11.8 加参数表单时把它们放在了早退之后，
  // 1.85.0 起线上如此；回归测试见 `commandPaletteHooks.test.ts`）。
  const [paramItem, setParamItem] = useState<
    Extract<Item, { kind: "plugin" }> | null
  >(null);
  const [paramValues, setParamValues] = useState<Record<string, string | boolean>>({});
  const [paramError, setParamError] = useState("");

  const plugins = usePlugins((s) => s.plugins);
  const running = usePlugins((s) => s.running);

  // Ctrl/Cmd+K toggles; focus and reset on open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setOpen(!usePalette.getState().open);
        setQuery("");
        setResult(null);
        setSel(0);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // 查询词变化（含被 seedQuery 预填）时重置选中项与上一次结果，避免"看着是新的、
  // 选中却还停在旧位置"。
  useEffect(() => {
    setSel(0);
    setResult(null);
  }, [query]);

  useEffect(() => {
    usePlugins.getState().load();
  }, []);

  const q = query.trim().toLowerCase();
  const pageItems = useMemo<Item[]>(
    () =>
      pages
        .filter((p) => !q || (p.title || "").toLowerCase().includes(q))
        .slice(0, 5)
        .map((p) => ({ kind: "page", id: p.id, title: p.title || "未命名" })),
    [pages, q],
  );
  // Subscribe so the gated "AI 助手" command appears/disappears when AI toggles.
  const aiEnabled = useAiStore((s) => s.config.enabled);
  const cmdItems = useMemo<Item[]>(
    () =>
      getBuiltinCommands()
        .filter((c) => c.title.toLowerCase().includes(q))
        .map((c) => ({ kind: "command", id: c.id, title: c.title, description: c.description })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, aiEnabled],
  );
  const pluginItems = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const p of plugins) {
      // 声明扩张过、还没重新确认的插件：宿主会拒绝执行（后端强制），入口上先说出来，
      // 别让用户以为是插件坏了。
      const paused = needsApproval(p) ? `（${approvalLabel()}）` : "";
      if (p.enabled) {
        out.push({ kind: "plugin-toggle", pluginId: p.id, title: `禁用插件「${p.name}」` });
        for (const c of p.commands) {
          if (!q || c.title.toLowerCase().includes(q)) {
            out.push({
              kind: "plugin", pluginId: p.id, id: c.id, title: c.title + paused,
              description: p.approval?.required ? "插件声明新增了权限/事件，需在插件管理里重新确认" : c.description,
              closeOnRun: c.close_on_run, params: c.params,
            });
          }
        }
      } else if (!q || p.name.toLowerCase().includes(q)) {
        out.push({ kind: "plugin-toggle", pluginId: p.id, title: `启用插件「${p.name}」` });
      }
    }
    return out;
  }, [plugins, q]);

  // 声明式视图（零代码插件的产出）：宿主渲染，所以这里只是"打开哪个视图"的入口。
  const viewItems = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const p of plugins) {
      if (!p.enabled) continue;
      for (const v of p.views ?? []) {
        // 入口文案说清**会开在哪里**：常驻面板与浮层是两种用法（一个是"一直看着"、
        // 一个是"看完了关"），用户点之前就该知道。文案来自 lib/pluginViews 的
        // `viewPlacement`——与真正决定落点的是同一个函数，不会各写一份。
        const title = `${viewPlacement(v) === "rail" ? "插件面板" : "插件视图"}：${v.title || v.id}`;
        if (!q || title.toLowerCase().includes(q)) {
          out.push({ kind: "plugin-view", pluginId: p.id, pluginName: p.name, view: v, title });
        }
      }
    }
    return out;
  }, [plugins, q]);

  // 文件进出（manifest `triggers`）：
  //   import——点一下 → 选文件 → **宿主**读内容 → 交给插件的命令；
  //   export——跑命令 → 插件用 api.files.export 登记内容 → 宿主逐个弹保存对话框。
  // 筛选规则在 lib/pluginImports（纯函数、有单测），这里只做入口与文案。
  const triggerItems = useMemo<Item[]>(() => {
    return pluginTriggerItems(plugins)
      .filter((i) => !q || i.title.toLowerCase().includes(q) || i.extensions.join(" ").includes(q))
      .map((i): Item => {
        const common = {
          pluginId: i.pluginId,
          pluginName: i.pluginName,
          id: i.key,
          commandId: i.commandId,
          extensions: i.extensions,
          title: i.title,
        };
        return i.kind === "export"
          ? { kind: "plugin-export", ...common }
          : { kind: "plugin-import", ...common };
      });
  }, [plugins, q]);
  const importItems = useMemo(() => triggerItems.filter((i) => i.kind === "plugin-import"), [triggerItems]);
  const exportItems = useMemo(() => triggerItems.filter((i) => i.kind === "plugin-export"), [triggerItems]);

  const flat = useMemo(
    () => [...pageItems, ...cmdItems, ...pluginItems, ...viewItems, ...importItems, ...exportItems],
    [pageItems, cmdItems, pluginItems, viewItems, importItems, exportItems],
  );
  useEffect(() => setSel(0), [query]);

  // Keep the highlighted item in view as the user arrows up/down, so a long list
  // scrolls instead of the highlight disappearing off-screen.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector(".palette-item-active");
    active?.scrollIntoView({ block: "nearest" });
  }, [sel, flat.length]);

  if (!open) return null;

  const openParams = (item: Extract<Item, { kind: "plugin" }>) => {
    setParamValues(initialParamValues(item.params ?? []));
    setParamError("");
    setParamItem(item);
  };

  /** 表单提交：转换规则在 lib/pluginParams（纯函数、有单测），组件只负责渲染。 */
  const submitParams = async () => {
    const item = paramItem;
    if (!item) return;
    const built = buildCommandArgs(item.params ?? [], paramValues);
    if (!built.ok) {
      setParamError(built.error);
      return;
    }
    setParamItem(null);
    setParamError("");
    await runPlugin(item, built.json);
  };

  const run = async (item: Item) => {
    if (item.kind === "page") {
      openPage(item.id);
      setOpen(false);
      return;
    }
    if (item.kind === "plugin") {
      if ((item.params?.length ?? 0) > 0) {
        openParams(item);
        return;
      }
      await runPlugin(item);
      return;
    }
    if (item.kind === "plugin-view") {
      usePluginViewStore.getState().open(item.pluginId, item.pluginName, item.view);
      setOpen(false);
      return;
    }
    if (item.kind === "plugin-import") {
      await runImport(item);
      return;
    }
    if (item.kind === "plugin-export") {
      await runExport(item);
      return;
    }
    if (item.kind === "plugin-toggle") {
      // toggle 会把后端的原始错误文本带回来：失败时**不能**报成功。
      const r = await usePlugins.getState().toggle(item.pluginId);
      setResult(r.ok ? "已切换插件状态" : `切换插件失败：${r.error ?? "未知错误"}`);
      return;
    }
    const cmd = getBuiltinCommands().find((c) => c.id === item.id);
    if (!cmd) return;
    const ctx: CommandContext = { pages, currentId };
    try {
      const msg = await cmd.run(ctx);
      setResult(msg);
      if (cmd.closeOnRun) setOpen(false);
    } catch (e) {
      setResult(String(e));
    }
  };

  /** 插件命令执行：链路在 lib/pluginRun（命令面板与 `/` 菜单共用同一份）。 */
  const runPlugin = async (item: Extract<Item, { kind: "plugin" }>, argsJson?: string) => {
    try {
      const r = await runPluginCommandWithUi(`「${item.title}」`, item.pluginId, item.id, currentId, argsJson);
      setResult(r.message);
      if (!r.cancelled && item.closeOnRun) setOpen(false);
    } catch (e) {
      setResult(String(e));
    }
  };

  /**
   * 导入触发：选文件 → **宿主**读内容 → 当成命令参数交给插件。
   *
   * 三件事值得写下来：
   * - **读文件的是宿主**（`readTextFile`），插件手里仍然没有任何文件能力；内容只是这一次
   *   调用的入参，插件要产出笔记依旧只能走 `api.*`（写能力照样出草稿、要用户确认）。
   * - **用户取消选择就什么都不做**（不弹错、也不拿空内容跑一次命令）；
   * - **插件没有被启用时后端会拒**（这里只是不显示入口，真正的闸门在 `run_plugin_command`）。
   */
  const runImport = async (item: Extract<Item, { kind: "plugin-import" }>) => {
    try {
      const selected = await platform.dialog.open({
        title: `选择要导入的文件（${item.extensions.join(" / ")}）`,
        filters: [{ name: filterLabel(item.extensions), extensions: dialogExtensions(item.extensions) }],
        multiple: false,
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;
      const content = await api.readTextFile(path);
      const argsJson = importArgsJson(baseName(path), content);
      const r = await runPluginCommandWithUi(`「${item.title}」`, item.pluginId, item.commandId, currentId, argsJson);
      setResult(r.message);
    } catch (e) {
      setResult(`导入失败：${String(e)}`);
    }
  };

  /**
   * 导出触发：跑命令 → 插件用 `api.files.export` 登记内容 → 宿主弹保存对话框。
   *
   * 与导入相反：**这次是插件产出、用户挑存到哪里**。命令行上什么都没有额外传给它
   * （插件自己决定导什么），所以这里只负责把结果交给统一的执行链路——保存对话框、
   * 「取消＝没写任何东西」的回报都发生在 `runPluginCommandWithUi` 里（只此一份）。
   */
  const runExport = async (item: Extract<Item, { kind: "plugin-export" }>) => {
    try {
      const r = await runPluginCommandWithUi(`「${item.title}」`, item.pluginId, item.commandId, currentId);
      setResult(r.message);
    } catch (e) {
      setResult(`导出失败：${String(e)}`);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // 表单模式下 Enter 是「提交」，不是「再选一次同一条命令」（否则会原地打转）
      if (paramItem) submitParams();
      else if (flat[sel]) run(flat[sel]);
    }
  };

  const renderItem = (it: Item, idx: number) => (
    <button
      key={`${it.kind}-${"id" in it ? it.id : it.kind === "plugin-view" ? `view:${it.view.id}` : it.pluginId}`}
      className={`palette-item ${idx === sel ? "palette-item-active" : ""}`}
      onClick={() => run(it)}
      onMouseEnter={() => setSel(idx)}
    >
      <span className="palette-title">
        {it.kind === "page" ? "📄 " : it.kind === "plugin-toggle" ? "◉ " : it.kind === "plugin-view" ? "▦ " : it.kind === "plugin-import" ? "📥 " : it.kind === "plugin-export" ? "📤 " : ""}
        {it.title}
        {it.kind === "plugin" && (it.params?.length ?? 0) > 0 && <span className="palette-params-badge">需填参数</span>}
      </span>
      <span className="palette-desc">
        {it.kind === "page"
          ? "打开页面"
          : it.kind === "plugin-toggle"
            ? "切换插件"
            : it.kind === "plugin-view"
              ? `来自插件「${it.pluginName}」`
              : it.kind === "plugin-import"
                ? `来自插件「${it.pluginName}」· 选中文件后由宿主读取内容`
                : it.kind === "plugin-export"
                  ? `来自插件「${it.pluginName}」· 保存位置由你在系统对话框里选`
                  : (it.description ?? "")}
      </span>
    </button>
  );

  return (
    <div className="palette-overlay" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={t("common.palettePlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {paramItem ? (
          <div className="palette-form">
            <div className="palette-form-title">{paramItem.title}</div>
            {(paramItem.params ?? []).map((p) => (
              <label key={p.name} className="palette-field">
                <span className="palette-field-label">
                  {p.label || p.name}
                  {p.required && <span className="palette-field-req">*</span>}
                </span>
                <PluginFieldInput
                  field={p}
                  value={paramValues[p.name] ?? (p.type === "boolean" ? false : "")}
                  onChange={(v) => setParamValues((prev) => ({ ...prev, [p.name]: v }))}
                  onSubmit={submitParams}
                />
              </label>
            ))}
            {paramError && <div className="palette-form-error">{paramError}</div>}
            <div className="palette-form-actions">
              <button className="set-btn" onClick={submitParams}>
                执行
              </button>
              <button
                className="set-btn"
                onClick={() => {
                  setParamItem(null);
                  setParamError("");
                }}
              >
                返回
              </button>
            </div>
          </div>
        ) : (
        <div className="palette-list" ref={listRef}>
          {pageItems.length > 0 && <div className="palette-group">{t("common.palettePages")}</div>}
          {pageItems.map((it, i) => renderItem(it, i))}
          {cmdItems.length > 0 && <div className="palette-group">{t("common.paletteCommands")}</div>}
          {cmdItems.map((it, i) => renderItem(it, pageItems.length + i))}
          {pluginItems.length > 0 && (
            <div className="palette-group">{t("common.palettePlugins")}</div>
          )}
          {pluginItems.map((it, i) => renderItem(it, pageItems.length + cmdItems.length + i))}
          {viewItems.length > 0 && <div className="palette-group">插件视图</div>}
          {viewItems.map((it, i) =>
            renderItem(it, pageItems.length + cmdItems.length + pluginItems.length + i),
          )}
          {importItems.length > 0 && <div className="palette-group">导入</div>}
          {importItems.map((it, i) =>
            renderItem(
              it,
              pageItems.length + cmdItems.length + pluginItems.length + viewItems.length + i,
            ),
          )}
          {exportItems.length > 0 && <div className="palette-group">导出</div>}
          {exportItems.map((it, i) =>
            renderItem(
              it,
              pageItems.length + cmdItems.length + pluginItems.length + viewItems.length + importItems.length + i,
            ),
          )}
          {flat.length === 0 && <div className="palette-empty">无匹配结果</div>}
        </div>
        )}
        {running && (
          // 「运行态可见 + 可取消」：此前插件命令跑起来后界面只有长时间无反应。
          // 取消放弃的是**等待**（结果被丢弃 → 无半途写入），不是插件线程本身。
          <div className="palette-result">
            <span>⏳ 正在执行「{running.title}」…</span>
            <button className="set-btn" onClick={() => usePlugins.getState().cancelRun()}>
              取消
            </button>
          </div>
        )}
        {result && <div className="palette-result">{result}</div>}
        <div className="palette-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> 导航</span>
          <span><kbd>Enter</kbd> 确认</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  );
}
