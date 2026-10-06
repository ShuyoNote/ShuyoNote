// `TopTools` —— 顶端工具栏。**2026-10-06 起这里只剩插件常驻入口** ✓。
//
// ⚠️ **2026-10-06（owner）：「关闭这个顶部工具栏」** ⇒ 原先那四颗（AI 助手／讨论／通知／目录）
//   **撤掉** ✓。它们的出口补在两处（⛔ 不是删掉能力 ✗）：
//     · **编辑器工具条「⋯ 更多」菜单**：可见入口（在页面上、点得到）✓ 见 `EditorToolbar.tsx`；
//     · **命令面板（Ctrl+K）**：键盘可及 ✓ 见 `plugins/builtinCommands.ts` 的 `panels.*` 两条。
//   ⚠️ 撤之前先数过入口：**AI** 命令面板本来就有（`ai.open`），**目录**编辑器工具条也有一颗
//   （`EditorToolbar` 的「目录」）—— 只有**讨论 / 通知**没有别的入口，所以那两条是**必须补**的 ✓。
//   ⚠️ 撤掉的直接原因是它**占一块常驻位置**（桌面在标题栏那一行、手机自己一行带下边框），
//   而这两端的位置都很贵（手机上那是一整行垂直空间）。
//   ⛔ **不要**把这四颗改成"悬停才出现"来省位置 ✗：触屏没有 hover ⇒ 藏起来就**点不到**
//   （见 `scripts/verify-mobile-layout.mjs` 里那条判据）✓。
//
// ⚠️ **这一段是 2026-10-01 的历史，别丢**（它解释了为什么今天还有这个组件）：
//   右侧那条竖向工具条（`RightRail`）撤掉，它的入口搬到顶端工具栏 —— 形态照 owner 纠正＝
//   **保持图标样式**（⛔ 不做文字胶囊）。单独成组件的原因是**手机上 `TitleBar` 根本不渲染**
//   （`!desktop` 时 return null ✓），而 owner 要求两端都有这条工具栏 ⇒ 同一个组件在两处渲染：
//     · 桌面：`TitleBar` 里（与最小化/最大化/关闭同一行 ✓）
//     · 手机：`App.tsx` 的 `.app` 顶部自己一行 ✓（`is-mobile` 变体 ✓）
//   ⛔ 两处各写一份会出现"两份真相源" ✗ —— 那正是本仓花最多代价消灭的形状 ✓。
//
// ⚠️ 插件声明的常驻面板（manifest `placement: "rail"`）仍渲染在这条工具栏上 ✓ ——
//   那是插件**唯一的可见入口**，跟着四颗一起删掉就等于丢能力 ✗。
//   ⇒ 没有插件入口时本组件**返回 null**（整条工具栏不渲染 ⇒ 桌面不占位、手机不占那一行 ✓）。
import { useMemo } from "react";
import { useRightPanel } from "../store/rightPanel";
import { usePlugins } from "../store/plugins";
import { usePluginViewStore } from "../store/pluginViews";
import { viewPlacement, viewPlacementKey } from "../lib/pluginViews";
import { PanelIcon } from "./icons";

export function TopTools({ className = "" }: { className?: string }) {
  const pluginKey = useRightPanel((s) => s.plugin);
  const allPlugins = usePlugins((s) => s.plugins);

  // 插件声明的**常驻面板**入口 ✓：只有**启用中**的插件算数 ✓（停用的插件入口不该还在 ✓）。
  const railViews = useMemo(
    () =>
      allPlugins
        .filter((p) => p.enabled)
        .flatMap((p) =>
          (p.views ?? [])
            .filter((v) => viewPlacement(v) === "rail")
            .map((v) => ({ pluginId: p.id, pluginName: p.name, view: v, key: viewPlacementKey(p.id, v) })),
        ),
    [allPlugins],
  );

  // ⚠️ 必须放在**所有 hooks 之后**（`check-hook-order` 会核 ✓）。
  if (railViews.length === 0) return null;

  return (
    <div className={`top-tools${className ? " " + className : ""}`}>
      {railViews.map((rv) => {
        const active = pluginKey === rv.key;
        return (
          <button
            key={rv.key}
            className={`top-tool${active ? " is-on" : ""}`}
            title={`${rv.view.title || rv.view.id}（插件「${rv.pluginName}」）`}
            aria-label={`插件面板：${rv.view.title || rv.view.id}`}
            aria-pressed={active}
            onClick={() => {
              // 再点一下收起（收起也走 store 的关闭路径 ✓，否则"当前占用"会留着一个已经看不见的键 ✗）。
              if (active) usePluginViewStore.getState().close();
              else usePluginViewStore.getState().open(rv.pluginId, rv.pluginName, rv.view);
            }}
          >
            <PanelIcon width={16} height={16} />
          </button>
        );
      })}
    </div>
  );
}
