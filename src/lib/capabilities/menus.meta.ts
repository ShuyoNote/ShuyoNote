// 本文件由 scripts/gen-capabilities.mjs 生成（源：capabilities/capabilities.json）——请勿手改。

/** 插件命令可以挂的宿主入口（`register({ menus: [...] })`）。 */
export interface PluginMenuMeta {
  id: string;
  title: string;
  desc: string;
  /** 宿主是否已经实现了这个入口（没实现的不会真的出现）。 */
  hosted: boolean;
}

export const PLUGIN_MENUS: PluginMenuMeta[] = [
  { id: "slash", title: "编辑器「/」菜单", desc: "在编辑器里输入 / 就能选到；适合「写到一半要跑一下」的命令", hosted: true },
  { id: "page.context", title: "页面右键菜单", desc: "页面列表里那一行的「⋯」菜单（在行上右键同样是它）：你的命令会拿到**被点的那一页**作为当前页", hosted: true },
  { id: "file.context", title: "附件右键菜单", desc: "在附件/文件上右键（宿主还没接这个入口）", hosted: false },
  { id: "editor.toolbar", title: "编辑器工具栏", desc: "编辑器顶部工具栏按钮（宿主还没接这个入口）", hosted: false },
];

const BY_ID = new Map(PLUGIN_MENUS.map((m) => [m.id, m]));

/** 入口的中文标题（不认识就退回 id——宁可显示得丑一点，也不要显示成空）。 */
export function pluginMenuTitle(id: string): string {
  return BY_ID.get(id)?.title ?? id;
}

/** 这个入口宿主是否已经实现。 */
export function pluginMenuHosted(id: string): boolean {
  return BY_ID.get(id)?.hosted ?? false;
}
