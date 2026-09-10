import type { PluginMeta } from "../types";

/**
 * 从插件清单里算出「该出现在编辑器 `/` 菜单里」的命令。
 *
 * 抽成纯函数是为了可测：这里的三条判断（只取启用插件、只取声明了 `slash` 的命令、
 * 带参数的要转交命令面板）都容易写错，而错了不会报错——只会在 `/` 菜单里多出一堆
 * 点不动的项，或者少掉本该有的项。
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

export function pluginSlashItems(plugins: PluginMeta[]): PluginSlashItem[] {
  const out: PluginSlashItem[] = [];
  for (const p of plugins) {
    if (!p.enabled) continue; // 没启用的插件不该在编辑器里露脸
    for (const c of p.commands) {
      if (!(c.menus ?? []).includes("slash")) continue;
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
