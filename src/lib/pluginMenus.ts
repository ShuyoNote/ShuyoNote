import type { PluginMeta } from "../types";

/**
 * 从插件清单里算出「该出现在某个宿主入口里」的命令（`register({ menus: [...] })`）。
 *
 * 抽成纯函数是为了可测：这里的三条判断（只取启用插件、只取声明了这个入口的命令、
 * 带参数的要转交命令面板）都容易写错，而错了不会报错——只会在菜单里多出一堆点不动的项，
 * 或者少掉本该有的项。
 *
 * **一个函数服务所有入口**（`slash` / `page.context` / …）：各写一份必然漂——某个入口
 * 忘了过滤"只取启用插件"，停用的插件就会在那一处继续露脸。
 */
export interface PluginSlashItem {
  /** 唯一 key（避免与内置项的 key 撞车）。 */
  key: string;
  title: string;
  pluginId: string;
  commandId: string;
  pluginName: string;
  /** 有参数：`/` 菜单不渲染表单，转交到命令面板（表单只实现一份）。 */
  hasParams: boolean;
}

export function pluginMenuItems(plugins: PluginMeta[], menuId: string): PluginSlashItem[] {
  const out: PluginSlashItem[] = [];
  for (const p of plugins) {
    if (!p.enabled) continue; // 没启用的插件不该在任何入口里露脸
    for (const c of p.commands) {
      if (!(c.menus ?? []).includes(menuId)) continue;
      out.push({
        key: `plugin:${p.id}:${c.id}`,
        title: c.title || c.id,
        pluginId: p.id,
        commandId: c.id,
        pluginName: p.name,
        hasParams: (c.params?.length ?? 0) > 0,
      });
    }
  }
  return out;
}

/** 编辑器 `/` 菜单那一份（保留这个名字：调用点读起来更明确）。 */
export function pluginSlashItems(plugins: PluginMeta[]): PluginSlashItem[] {
  return pluginMenuItems(plugins, "slash");
}

/**
 * 文件右键菜单（`file.context`）交给插件的入参。
 *
 * 与导入触发同一套通道（`argsJson`）：**入参不是能力**——插件拿到的只是这一次调用的数据，
 * 它要碰笔记仍然只能走 `api.*`（写能力照样出草稿、要用户确认）。
 *
 * **不给绝对路径**：插件本来就没有读文件的能力（能力表里只有 `files.list` 与
 * `files.export`，没有"读文件"），把 `path` 递过去只会让人以为能读——那是最容易写出
 * "在我机器上能跑"的插件的地方。所以给的是身份与展示所需的三样：名字、大小、类型。
 */
export function fileContextArgs(file: { name: string; size: number; mime: string }): string {
  return JSON.stringify({ fileName: file.name, size: file.size, mime: file.mime });
}
