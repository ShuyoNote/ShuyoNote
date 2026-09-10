import type { PluginMeta } from "../types";

/**
 * 导入触发的**宿主侧规则**（M11.9）。
 *
 * 与 `pluginMenus` / `pluginViews` 同样的理由抽成纯函数：这里每一条都容易写错，而写错了
 * 不会报错——只会多出一条点不动的入口、或者选文件时筛掉了本该筛出来的格式。作者没法
 * 用代码绕过这些规则（他只能写 manifest 声明），所以"可预期"必须由这里保证。
 *
 * 后端已经在 `sanitized_triggers` 里筛过一遍（kind 认识、命令非空、扩展名合法）；
 * 这里再筛一遍是**纵深防御**：即使某天后端漏了一条，界面上也不会出现一个必然失败的入口。
 */

export interface PluginImportItem {
  /** 唯一 key（面板里做 React key 与去重）。 */
  key: string;
  /** 入口标题（作者写了 title 就用它，否则用默认文案）。 */
  title: string;
  pluginId: string;
  pluginName: string;
  commandId: string;
  /** 规范化后的扩展名，已去重。 */
  extensions: string[];
}

/** 默认入口标题的模板（作者不写 `title` 时用它）。 */
export function defaultImportTitle(pluginName: string, extensions: string[]): string {
  return `导入：用「${pluginName}」打开 ${extensions.join(" / ")}`;
}

/** 系统文件选择器的过滤器需要**不带点**的扩展名（`dialog.open` 的约定）。 */
export function dialogExtensions(extensions: string[]): string[] {
  return extensions.map((e) => e.replace(/^\.+/, "")).filter(Boolean);
}

/**
 * 文件选择器的过滤器名字（`"Markdown / CSV 文件"` 这类）。
 * 没有可用扩展名时返回 `"文件"`——过滤器名只是给人看的，空名字会让对话框看起来坏了。
 */
export function filterLabel(extensions: string[]): string {
  const names = dialogExtensions(extensions);
  return names.length > 0 ? `${names.map((e) => e.toUpperCase()).join(" / ")} 文件` : "文件";
}

/**
 * 交给插件命令的参数字符串（`run_plugin_command` 的 `argsJson`）。
 *
 * **`fileName` 只给文件名，不给路径**：插件没有任何文件能力，完整路径对它无用，却会
 * 把用户的目录结构（用户名、项目名）白送出去。它要的只是"这是哪个文件"。
 */
export function importArgsJson(fileName: string, content: string): string {
  return JSON.stringify({ fileName, content });
}

/** 从平台返回的路径里取出文件名（`/a/b/c.md` 与 `C:\a\b.md` 都要能取对）。 */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/**
 * 启用中的插件 → 命令面板里的导入入口（一条触发一个入口）。
 *
 * 三条规则，每条都对应一种"静默失效"：
 * - **没启用的插件不出现**（与命令、`/` 菜单一致：禁用就不该在界面上露脸）；
 * - **命令为空不出现**（后端已经筛过，这里是第二道）；
 * - **扩展名为空不出现**（没有扩展名 = 不知道该在什么文件上出现 = 点不到）。
 */
export function pluginImportItems(plugins: PluginMeta[]): PluginImportItem[] {
  const out: PluginImportItem[] = [];
  for (const p of plugins) {
    if (!p.enabled) continue;
    for (const t of p.triggers ?? []) {
      if (!t.command) continue;
      const extensions = [...new Set(t.extensions ?? [])].filter(Boolean);
      if (extensions.length === 0) continue;
      out.push({
        key: `plugin-import:${p.id}:${t.kind}:${extensions.join(",")}:${t.command}`,
        title: t.title || defaultImportTitle(p.name, extensions),
        pluginId: p.id,
        pluginName: p.name,
        commandId: t.command,
        extensions,
      });
    }
  }
  return out;
}
