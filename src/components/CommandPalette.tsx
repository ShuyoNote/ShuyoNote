import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection } from "lexical";
import { useNotes } from "../store/notes";
import { usePlugins } from "../store/plugins";
import { useEditorStore } from "../store/editor";
import { useAiStore } from "../store/ai";
import { getAllCommands, usePluginRevision, type CommandContext } from "../plugins/registry";

type Item =
  | { kind: "page"; id: string; title: string }
  | { kind: "command"; id: string; title: string; description?: string }
  | { kind: "plugin"; pluginId: string; id: string; title: string; description?: string }
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
  const pluginRevision = usePluginRevision();
  // Subscribe so the gated "AI 助手" command appears/disappears when AI toggles.
  const aiEnabled = useAiStore((s) => s.config.enabled);
  const cmdItems = useMemo<Item[]>(
    () =>
      getAllCommands()
        .filter((c) => c.title.toLowerCase().includes(q))
        .map((c) => ({ kind: "command", id: c.id, title: c.title, description: c.description })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, pluginRevision, aiEnabled],
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

  const run = async (item: Item) => {
    if (item.kind === "page") {
      openPage(item.id);
      setOpen(false);
      return;
    }
    if (item.kind === "plugin") {
      try {
        const res = await usePlugins.getState().runCommand(item.pluginId, item.id, currentId);
        setResult(res.message);
        if (res.insert) insertText(res.insert);
      } catch (e) {
        setResult(String(e));
      }
      return;
    }
    if (item.kind === "plugin-toggle") {
      await usePlugins.getState().toggle(item.pluginId);
      setResult("已切换插件状态");
      return;
    }
    const cmd = getAllCommands().find((c) => c.id === item.id);
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flat[sel]) run(flat[sel]);
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
