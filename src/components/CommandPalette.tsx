import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection } from "lexical";
import { useNotes } from "../store/notes";
import { usePlugins } from "../store/plugins";
import { toast } from "../store/toast";
import { confirmAndApplyDrafts } from "../lib/pluginDrafts";
import { useEditorStore } from "../store/editor";
import { useAiStore } from "../store/ai";
import { getBuiltinCommands, type CommandContext } from "../plugins/builtinCommands";
import { buildCommandArgs, initialParamValues } from "../lib/pluginParams";
import type { PluginCommandParam } from "../types";

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
  | { kind: "plugin-toggle"; pluginId: string; title: string };

// Insert a text paragraph into the active editor (at cursor if possible, else
// append to the end of the page).
function insertText(text: string) {
  const editor = useEditorStore.getState().editor;
  if (!editor) return;
  editor.update(() => {
    const para = $createParagraphNode();
    para.append($createTextNode(text));
    const sel = $getSelection();
    if ($isRangeSelection(sel) && !sel.isCollapsed()) {
      const top = sel.anchor.getNode().getTopLevelElement();
      if (top) {
        top.insertAfter(para);
        para.selectStart();
        return;
      }
    }
    $getRoot().append(para);
    para.selectStart();
  });
}

export function CommandPalette() {
  const { t } = useTranslation();
  const { pages, currentId, openPage } = useNotes();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const plugins = usePlugins((s) => s.plugins);
  const running = usePlugins((s) => s.running);

  // Ctrl/Cmd+K toggles; focus and reset on open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
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
      if (p.enabled) {
        out.push({ kind: "plugin-toggle", pluginId: p.id, title: `禁用插件「${p.name}」` });
        for (const c of p.commands) {
          if (!q || c.title.toLowerCase().includes(q)) {
            out.push({
              kind: "plugin", pluginId: p.id, id: c.id, title: c.title, description: c.description,
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

  const flat = useMemo(
    () => [...pageItems, ...cmdItems, ...pluginItems],
    [pageItems, cmdItems, pluginItems],
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

  // 参数表单：选中带参数的命令后，面板就地切成表单（而不是弹第二个对话框）。
  const [paramItem, setParamItem] = useState<
    Extract<Item, { kind: "plugin" }> | null
  >(null);
  const [paramValues, setParamValues] = useState<Record<string, string | boolean>>({});
  const [paramError, setParamError] = useState("");

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

  /** 插件命令的实际执行 + 结果处理（直接执行与表单提交共用同一条路径）。 */
  const runPlugin = async (item: Extract<Item, { kind: "plugin" }>, argsJson?: string) => {
    {
      try {
        const res = await usePlugins.getState().runCommand(item.pluginId, item.id, currentId, argsJson);
        if (res.cancelled) {
          setResult("已取消执行（结果已丢弃）");
          return;
        }
        setResult(res.message);
        // 插件用 __toast(...) 发的提示：此前只写 stderr，用户完全看不到。
        for (const t of res.toasts ?? []) toast(t, "info");
        if (res.insert) insertText(res.insert);

        // 写能力不直接落库：先把草稿摊给用户确认（规则见 lib/pluginDrafts，
        // 与事件钩子共用同一条链路——两处各写一遍迟早会有一处忘了确认）。
        const drafts = res.drafts ?? [];
        if (drafts.length > 0) {
          setResult(await confirmAndApplyDrafts(`「${item.title}」`, drafts));
          return;
        }

        // closeOnRun 现在能正确解析了（此前是死字段），所以照它关闭面板。
        if (item.closeOnRun) setOpen(false);
      } catch (e) {
        setResult(String(e));
      }
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
      key={`${it.kind}-${"id" in it ? it.id : it.pluginId}`}
      className={`palette-item ${idx === sel ? "palette-item-active" : ""}`}
      onClick={() => run(it)}
      onMouseEnter={() => setSel(idx)}
    >
      <span className="palette-title">
        {it.kind === "page" ? "📄 " : it.kind === "plugin-toggle" ? "◉ " : ""}
        {it.title}
        {it.kind === "plugin" && (it.params?.length ?? 0) > 0 && <span className="palette-params-badge">需填参数</span>}
      </span>
      <span className="palette-desc">
        {it.kind === "page" ? "打开页面" : it.kind === "plugin-toggle" ? "切换插件" : it.description ?? ""}
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
                {p.type === "boolean" ? (
                  <input
                    type="checkbox"
                    checked={paramValues[p.name] === true}
                    onChange={(e) => setParamValues((v) => ({ ...v, [p.name]: e.target.checked }))}
                  />
                ) : p.type === "select" ? (
                  <select
                    value={String(paramValues[p.name] ?? "")}
                    onChange={(e) => setParamValues((v) => ({ ...v, [p.name]: e.target.value }))}
                  >
                    <option value="">（不指定）</option>
                    {p.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label || o.value}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={p.type === "number" ? "number" : "text"}
                    placeholder={p.placeholder}
                    value={String(paramValues[p.name] ?? "")}
                    onChange={(e) => setParamValues((v) => ({ ...v, [p.name]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        submitParams();
                      }
                    }}
                  />
                )}
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
