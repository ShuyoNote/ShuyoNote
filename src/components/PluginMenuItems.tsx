import { useMemo } from "react";
import { usePlugins } from "../store/plugins";
import { usePalette } from "../store/palette";
import { pluginMenuItems } from "../lib/pluginMenus";
import { runPluginCommandWithUi } from "../lib/pluginRun";
import { toast } from "../store/toast";

/**
 * 宿主菜单里的**插件命令**分组（`register({ menus: [...] })`）。
 *
 * 抽成一个组件是因为入口会越来越多（编辑器 `/` 菜单、页面列表的行菜单、将来到附件与工具栏），
 * 而每个入口都要遵守同一套规矩：
 *
 * - **只列启用中的插件**（`pluginMenuItems` 里判，纯函数有单测）；
 * - **带参数的命令不在这里渲染表单**，转交命令面板（参数表单只实现一份）；
 * - 跑完把结果如实说给用户（草稿确认、导出对话框、toast 都在 `runPluginCommandWithUi` 里）；
 * - **"当前页"= 用户点的那一页**（页面行菜单靠 `pageId` 传进来），而不是"现在打开的那一页"——
 *   「导出这一页」如果导出的是别人，那比没有这个入口更糟。
 *
 * 没有插件命令时整块不渲染（入口里不留一个空标题）。
 */
export function PluginMenuItems({
  menuId,
  pageId,
  onDone,
}: {
  menuId: string;
  /** 这次调用作用在哪个页面（行菜单传被点的那一行；没有页面语义的入口传 null）。 */
  pageId: string | null;
  /** 跑完/转交后调用（行菜单用它收起自己）。 */
  onDone?: () => void;
}) {
  const plugins = usePlugins((s) => s.plugins);
  const items = useMemo(() => pluginMenuItems(plugins, menuId), [plugins, menuId]);

  if (items.length === 0) return null;

  const run = async (it: (typeof items)[number]) => {
    onDone?.();
    if (it.hasParams) {
      // 参数表单只在命令面板里有——用标题预填查询，用户在那儿填参数。
      usePalette.getState().seedQuery(it.title);
      return;
    }
    const r = await runPluginCommandWithUi(`「${it.title}」`, it.pluginId, it.commandId, pageId);
    if (r.message) toast(r.message, r.cancelled ? "info" : "success");
  };

  return (
    <>
      <div className="menu-section-title">插件命令</div>
      {items.map((it) => (
        <button
          key={it.key}
          className="tree-menu-plugin"
          data-plugin={it.pluginId}
          data-command={it.commandId}
          title={`来自插件「${it.pluginName}」${it.hasParams ? "（需要填参数，会打开命令面板）" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            void run(it);
          }}
        >
          <span className="menu-icon">🔌</span>
          <span className="menu-text">
            {it.title}
            {it.hasParams && <span className="menu-badge">需填参数</span>}
          </span>
        </button>
      ))}
    </>
  );
}
