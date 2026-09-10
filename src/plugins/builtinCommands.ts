import { api } from "../lib/api";
import { isDesktopPlatform } from "../lib/platform";
import { useNotes } from "../store/notes";
import { useViewStore } from "../store/view";
import { usePlugins } from "../store/plugins";
import { useTemplates } from "../store/templates";
import { useAiStore } from "../store/ai";
import { useRightPanel } from "../store/rightPanel";
import { useActivity } from "../store/activity";
import { useEditorStore } from "../store/editor";
import { openGuide, guideText } from "../lib/guide";
import { buildHelpSite } from "../lib/helpSite";
import { usePdfReader } from "../store/pdfReader";
import { exportWorkspaceToMarkdown } from "../lib/exportMarkdown";
import type { PageMeta } from "../types";

// **内置命令组**——不是插件。
//
// 这里注册的是应用自身的功能在命令面板（Ctrl+K）里的分组入口（统计/导出/数据库/
// 模板/插件/AI/设置/帮助/PDF/视图）。它们与「磁盘插件」是两套东西：
//   · 内置命令组：编译进应用、跑在渲染进程、与应用同权限、装不了也卸不掉；
//   · 磁盘插件：manifest + main.js、跑在受限沙箱里、有权限模型、可装可卸。
// 二者共用命令面板与「命令」这个词，但生命周期/信任级别/持久化都不同——历史上
// 正是这个命名混淆导致插件面板误把内置分组当成可开关插件展示（见 CHANGELOG）。
// 所以：本文件与相关类型一律叫 Builtin*，「插件」一词专指磁盘插件。

export interface CommandContext {
  pages: PageMeta[];
  currentId: string | null;
}

export interface BuiltinCommand {
  id: string;
  title: string;
  description?: string;
  /** Close the command palette after running (e.g. view switches). */
  closeOnRun?: boolean;
  /** Optional gate: return false to hide this command (e.g. AI disabled). */
  when?: () => boolean;
  run: (ctx: CommandContext) => Promise<string> | string;
}

export interface BuiltinCommandGroup {
  id: string;
  name: string;
  commands: BuiltinCommand[];
}

const registry: BuiltinCommandGroup[] = [];

export function registerCommandGroup(group: BuiltinCommandGroup) {
  registry.push(group);
}

/**
 * 命令面板要展示的全部内置命令（按 `when` 过滤）。
 *
 * 说明：这里曾经有一套「内置插件启停」机制（`usePluginState` / `togglePlugin` /
 * `getEnabledPlugins` / `usePluginRevision`）。面板改成管理真正的磁盘插件后它就没有
 * 调用方了，属于死代码，已删除——留着只会让人以为内置分组可以像插件一样装/卸。
 */
export function getBuiltinCommands(): BuiltinCommand[] {
  return registry.flatMap((g) => g.commands).filter((c) => c.when?.() ?? true);
}

// ---- 内置命令组 ----

registerCommandGroup({
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

registerCommandGroup({
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
      // **只在 web 平台出现**：静态 HTML wiki 导出目前只有 web 平台实现（Rust 侧没有
      // 这条命令），桌面端点下去只会得到 "command export_wiki not found"。宁可不显示，
      // 也不给一条必然失败的入口。桌面端要这个功能的话，是在 Rust 侧补一条 `export_wiki`。
      when: () => !isDesktopPlatform(),
      closeOnRun: true,
      run: async () => {
        const result = await api.exportWiki("wiki-export.zip");
        return `已导出 ${result.pages} 个页面（${result.files} 个文件）为 wiki：${result.path}`;
      },
    },
  ],
});

registerCommandGroup({
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

registerCommandGroup({
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
            cover: page.cover,
            icon: page.icon,
            kind: page.kind === "database" ? "database" : "page",
            // 数据库模板：列定义(database_json)。此处若无可先存 {}；EditorToolbar 会补全。
            database_json: page.kind === "database" ? await (async () => {
              try {
                const q = await api.queryDatabase(page.id);
                return JSON.stringify({ columns: (q?.columns ?? []).map((c) => ({ name: c.name, type: c.attr_type, options: c.options ?? [] })) });
              } catch { return "{}"; }
            })() : "{}",
          });
        return ok ? `已保存为模板「${page.title || "未命名"}」` : "保存失败";
      },
    },
  ],
});

registerCommandGroup({
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

registerCommandGroup({
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

registerCommandGroup({
  id: "settings",
  name: "设置",
  commands: [
    {
      id: "settings.open",
      title: "打开设置",
      description: "外观 / 插件 / 安全（加密）/ AI / 关于",
      closeOnRun: true,
      run: () => {
        useEditorStore.getState().openSettings();
        return "已打开设置";
      },
    },
    {
      id: "settings.security",
      title: "加密与安全设置",
      description: "开启/关闭端到端加密、锁定与解锁",
      closeOnRun: true,
      run: () => {
        useEditorStore.getState().openSettings("security");
        return "已打开安全设置";
      },
    },
    {
      // 锁定是高频动作（等同锁屏），值得一个不用翻面板的入口。
      id: "settings.lock",
      title: "锁定笔记（加密）",
      description: "立即锁定会话；下次打开或同步前需输入口令",
      closeOnRun: true,
      run: async () => {
        try {
          const st = await api.encryptionStatus();
          if (!st.enabled) {
            useEditorStore.getState().openSettings("security");
            return "尚未开启加密，已打开安全设置";
          }
          if (st.locked) return "已经处于锁定状态";
          await api.lockEncryption();
          return "已锁定（下次同步前需解锁）";
        } catch (e) {
          return `锁定失败：${e}`;
        }
      },
    },
  ],
});

registerCommandGroup({
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

registerCommandGroup({
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

registerCommandGroup({
  id: "view",
  name: "视图",
  commands: [
    {
      // 侧栏收起后只剩左侧竖条可以点开，触屏上尤其不好发现；命令面板给一条
      // 明路，也顺带让 Ctrl+B 这个组合在面板里可查。
      id: "view.toggle-sidebar",
      title: "切换侧栏",
      description: "展开 / 收起左侧侧栏（Ctrl+B / ⌘B）",
      closeOnRun: true,
      run: () => {
        useActivity.getState().toggleSidebar();
        return useActivity.getState().sidebarOpen ? "已展开侧栏" : "已收起侧栏";
      },
    },
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
