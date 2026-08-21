import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { useViewStore } from "../store/view";
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
  run: (ctx: CommandContext) => Promise<string> | string;
}

export interface Plugin {
  id: string;
  name: string;
  commands: PluginCommand[];
}

const registry: Plugin[] = [];

export function registerPlugin(plugin: Plugin) {
  registry.push(plugin);
}

export function getPlugins(): Plugin[] {
  return registry;
}

export function getAllCommands(): PluginCommand[] {
  return registry.flatMap((p) => p.commands);
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
