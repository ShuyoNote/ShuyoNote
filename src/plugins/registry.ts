import { create } from "zustand";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { useViewStore } from "../store/view";
import { usePlugins } from "../store/plugins";
import { useTemplates } from "../store/templates";
import { useAiStore } from "../store/ai";
import { useRightPanel } from "../store/rightPanel";
import { useEditorStore } from "../store/editor";
import { openGuide, guideText } from "../lib/guide";
import { buildHelpSite } from "../lib/helpSite";
import { usePdfReader } from "../store/pdfReader";
import { exportWorkspaceToMarkdown } from "../lib/exportMarkdown";
import type { PageMeta } from "../types";

// A lightweight plugin system: plugins register commands that are
// surfaced in the command palette (Ctrl+K). Each command is a pure
// function of the current context (selected page) and returns a result
// message. This is the extension point for third-party plugins.

export interface CommandContext {
  pages: PageMeta[];
  currentId: string | null;
}

export interface PluginCommand {
  id: string;
  title: string;
  description?: string;
  /** Close the command palette after running (e.g. view switches). */
  closeOnRun?: boolean;
  /** Optional gate: return false to hide this command (e.g. AI disabled). */
  when?: () => boolean;
  run: (ctx: CommandContext) => Promise<string> | string;
}

export interface Plugin {
  id: string;
  name: string;
  commands: PluginCommand[];
}

const registry: Plugin[] = [];

// Plugin enable/disable state (persisted in-memory; default enabled).
const usePluginState = create<{
  enabled: Record<string, boolean>;
  toggle: (id: string) => void;
}>((set) => ({
  enabled: {},
  toggle: (id) =>
    set((s) => ({ enabled: { ...s.enabled, [id]: !(s.enabled[id] ?? true) } })),
}));

export function registerPlugin(plugin: Plugin) {
  registry.push(plugin);
}

export function getPlugins(): Plugin[] {
  return registry;
}

export function getEnabledPlugins(): Plugin[] {
  return registry.filter((p) => usePluginState.getState().enabled[p.id] !== false);
}

export function getAllCommands(): PluginCommand[] {
  return getEnabledPlugins().flatMap((p) => p.commands).filter((c) => c.when?.() ?? true);
}

// Re-render hook for consumers that list plugins/commands (e.g. command palette).
export function usePluginRevision() {
  return usePluginState((s) => s.enabled);
}

export function togglePlugin(id: string) {
  usePluginState.getState().toggle(id);
}

export function isPluginEnabled(id: string): boolean {
  return usePluginState.getState().enabled[id] !== false;
}

// ---- built-in plugins ----

registerPlugin({
  id: "stats",
  name: "统计",
  commands: [
    {
      id: "stats.word-count",
      title: "统计当前页字数",
      description: "统计当前打开页面的字符数",
      run: async (ctx) => {
        if (!ctx.currentId) return "未打开页面";
        const page = await api.getPage(ctx.currentId);
        return `「${page.title || "未命名"}」共 ${page.content_text.length} 个字符`;
      },
    },
    {
      id: "stats.page-count",
      title: "统计页面总数",
      description: "统计全部页面数量",
      run: (ctx) => `共 ${ctx.pages.length} 个页面`,
    },
  ],
});

registerPlugin({
  id: "export",
  name: "导出",
  commands: [
    {
      id: "export.current-json",
      title: "导出当前页 JSON",
      description: "复制当前页面的完整 JSON 到剪贴板",
      run: async (ctx) => {
        if (!ctx.currentId) return "未打开页面";
        const page = await api.getPage(ctx.currentId);
        await navigator.clipboard.writeText(JSON.stringify(page, null, 2));
        return "已复制当前页 JSON 到剪贴板";
      },
    },
    {
      id: "export.workspace-markdown",
      title: "导出工作空间为 Markdown",
      description: "把本工作空间所有页面导出为 .md 文件到所选目录",
      closeOnRun: true,
      run: () => exportWorkspaceToMarkdown(),
    },
    {
      id: "export.workspace-wiki",
      title: "导出当前空间为 wiki",
      description: "把当前空间导出为可独立浏览的静态 HTML wiki（双链/反链/索引页）",
      closeOnRun: true,
      run: async () => {
        const result = await api.exportWiki("wiki-export.zip");
        return `已导出 ${result.pages} 个页面（${result.files} 个文件）为 wiki：${result.path}`;
      },
    },
  ],
});

registerPlugin({
  id: "database",
  name: "数据库",
  commands: [
    {
      id: "database.create",
      title: "新建数据库",
      description: "创建一个数据库表格视图页面",
      closeOnRun: true,
      run: async () => {
        await useNotes.getState().createDatabase(null);
        return "已创建数据库";
      },
    },
  ],
});

registerPlugin({
  id: "template",
  name: "模板",
  commands: [
    {
      id: "template.save-current",
      title: "保存当前页为模板",
      description: "把当前页面结构保存到「我的模板」",
      run: async (ctx) => {
        if (!ctx.currentId) return "未打开页面";
        const page = await api.getPage(ctx.currentId);
        if (!page || (page.kind !== "page" && page.kind !== "database")) {
          return "当前不是可保存为模板的页面";
        }
        const ok = await useTemplates
          .getState()
          .saveAs({
            name: page.title || "未命名",
            content_json: page.content_json,
            content_text: page.content_text,
          });
        return ok ? `已保存为模板「${page.title || "未命名"}」` : "保存失败";
      },
    },
  ],
});

registerPlugin({
  id: "plugin",
  name: "插件",
  commands: [
    {
      id: "plugin.manage",
      title: "管理插件",
      description: "打开插件管理面板（安装/启停/卸载）",
      closeOnRun: true,
      run: () => {
        usePlugins.getState().setManagerOpen(true);
        return "已打开插件管理";
      },
    },
  ],
});

registerPlugin({
  id: "ai",
  name: "AI 助手",
  commands: [
    {
      id: "ai.open",
      title: "AI 助手",
      description: "打开 AI 助手面板",
      closeOnRun: true,
      when: () => useAiStore.getState().config.enabled,
      run: () => {
        useRightPanel.getState().openAi(true);
        return "已打开 AI 助手";
      },
    },
  ],
});

registerPlugin({
  id: "help",
  name: "帮助",
  commands: [
    {
      id: "help.shortcuts",
      title: "快捷键",
      description: "查看全部键盘快捷键（Ctrl+/ 或 ?）",
      closeOnRun: true,
      run: () => {
        useEditorStore.getState().openShortcuts();
        return "已打开快捷键";
      },
    },
    {
      id: "help.open-guide",
      title: "打开使用指南",
      description: "打开/新建「使用指南」帮助页",
      closeOnRun: true,
      run: () => {
        void openGuide();
        return "正在打开使用指南";
      },
    },
    {
      id: "help.about",
      title: "关于",
      description: "版本、许可与项目网站（开源与反馈）",
      closeOnRun: true,
      run: () => {
        useEditorStore.getState().openAbout();
        return "已打开关于";
      },
    },
    {
      id: "help.export-site",
      title: "导出帮助站点",
      description: "把「使用指南」导出为可托管的静态 HTML 帮助站（zip）",
      closeOnRun: true,
      run: async () => {
        const { files } = buildHelpSite(guideText());
        const { zipSync, strToU8 } = await import("fflate");
        const zi: Record<string, Uint8Array> = {};
        for (const f of files) zi[f.name] = strToU8(f.content);
        const blob = new Blob([zipSync(zi)], { type: "application/zip" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "shuyonote-help-site.zip";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        return `已导出帮助站点（${files.length} 个文件：index.html + 指南页）`;
      },
    },
  ],
});

registerPlugin({
  id: "pdf",
  name: "PDF 批注",
  commands: [
    {
      id: "pdf.open-annotations",
      title: "打开最近批注的 PDF",
      description: "打开最近做过批注的 PDF（回到对应页）",
      closeOnRun: true,
      run: async () => {
        const rows = await api.listAllPdfAnnotations();
        if (!rows || rows.length === 0) return "暂无批注";
        const r = rows[0];
        usePdfReader.getState().openPdf(r.attachment_id, "", r.page_index);
        return "已打开最近批注的 PDF";
      },
    },
    {
      id: "pdf.open-files",
      title: "打开 PDF 文件",
      description: "打开最近添加/导入的一个 PDF 附件",
      closeOnRun: true,
      run: async () => {
        const files = await api.listAllPdfAttachments().catch(() => []);
        if (!files || files.length === 0) return "暂无 PDF 附件";
        const f = files[0];
        usePdfReader.getState().openPdf(f.id, f.name || "");
        return `已打开「${f.name || "PDF"}」`;
      },
    },
  ],
});

registerPlugin({
  id: "view",
  name: "视图",
  commands: [
    {
      id: "view.graph",
      title: "打开关系图",
      description: "切换到关系图视图",
      closeOnRun: true,
      run: () => {
        useViewStore.getState().setView("graph");
        return "已切换到关系图";
      },
    },
    {
      id: "view.board",
      title: "打开看板",
      description: "切换到看板视图",
      closeOnRun: true,
      run: () => {
        useViewStore.getState().setView("board");
        return "已切换到看板";
      },
    },
  ],
});
