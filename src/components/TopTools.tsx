// `TopTools` —— 顶端工具栏那四颗入口（＋ 插件常驻入口）✓。
//
// ⚠️ 2026-10-01（owner 界面方向之①）：**右侧那条竖向工具条撤掉** ✓，它的入口全部搬到**顶端工具栏** ✓；
//    形态照 owner 后来的纠正＝**保持现有的图标样式** ✓（⛔ 不做文字胶囊 ✗）。
//
// ⚠️ 为什么单独成一个组件（而不是写在 `TitleBar` 里）✗⇒✓：
//   **手机上 `TitleBar` 根本不渲染**（它在 `!desktop` 时 return null ✓ —— 见 `App.tsx` 里那条注释 ✓），
//   而 owner 2026-10-01 明确要求**两端都要有这条工具栏** ✓ ⇒ 同一个组件在两处渲染 ✓：
//     · 桌面：`TitleBar` 里（与最小化/最大化/关闭同一行 ✓）
//     · 手机：`App.tsx` 的 `.app` 顶部自己一行 ✓（`is-mobile` 变体 ✓）
//   ⛔ 两处各写一份会出现"两份真相源" ✗ —— 那正是本仓花最多代价消灭的形状 ✓。
//
// ⚠️ 入口顺序（owner 2026-10-01 拍板 ✓）：**AI 助手／讨论／通知／目录** 四颗 ✓，
//    插件声明的常驻面板（manifest `placement: "rail"` ✓）**排在这四颗之后** ✓（⛔ 不是丢掉那个能力 ✗）。
import { useMemo } from "react";
import { useRightPanel } from "../store/rightPanel";
import { usePlugins } from "../store/plugins";
import { usePluginViewStore } from "../store/pluginViews";
import { viewPlacement, viewPlacementKey } from "../lib/pluginViews";
import { SparkleIcon, CommentIcon, BellIcon, ListIcon, PanelIcon } from "./icons";

export function TopTools({ className = "" }: { className?: string }) {
  const aiOpen = useRightPanel((s) => s.ai);
  const tocOpen = useRightPanel((s) => s.toc);
  const commentsOpen = useRightPanel((s) => s.comments);
  const commentsTab = useRightPanel((s) => s.commentsTab);
  const openAi = useRightPanel((s) => s.openAi);
  const openToc = useRightPanel((s) => s.openToc);
  const openComments = useRightPanel((s) => s.openComments);
  const pluginKey = useRightPanel((s) => s.plugin);
  const allPlugins = usePlugins((s) => s.plugins);

  /**
   * 「通知」那颗的未读数 ✓。
   *
   * ⚠️ **现在恒为 0** ✗ —— 通知中心（`NotificationCenter` ✓）读的是"按频道未读"，
   * 而那条规格（`INV-IM-unread-is-per-channel` ✓）**还没落地** ⇒ **登记为已知缺口** ✓：
   * 落地那天把这里换成那个 store 的读数即可 ✓（⛔ 现在**不假造一个数** ✗，
   * 也不把"角标没数"糊成"通知功能好了" ✗）。
   */
  const unreadCount = 0;

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

  const discussOn = commentsOpen && commentsTab === "comments";
  const notifOn = commentsOpen && commentsTab === "notifications";

  return (
    <div className={`top-tools${className ? " " + className : ""}`}>
      <button
        className={`top-tool${aiOpen ? " is-on" : ""}`}
        title="AI 助手"
        aria-label="AI 助手"
        aria-pressed={aiOpen}
        onClick={() => openAi(!aiOpen)}
      >
        <SparkleIcon width={16} height={16} />
      </button>
      <button
        className={`top-tool${discussOn ? " is-on" : ""}`}
        title="讨论"
        aria-label="讨论"
        aria-pressed={discussOn}
        onClick={() => openComments(!discussOn, "comments")}
      >
        <CommentIcon width={16} height={16} />
      </button>
      <button
        className={`top-tool${notifOn ? " is-on" : ""}`}
        title="通知"
        aria-label="通知"
        aria-pressed={notifOn}
        onClick={() => openComments(!notifOn, "notifications")}
      >
        <BellIcon width={16} height={16} />
        {unreadCount > 0 && <span className="top-tool-badge">{unreadCount}</span>}
      </button>
      <button
        className={`top-tool${tocOpen ? " is-on" : ""}`}
        title="目录"
        aria-label="目录"
        aria-pressed={tocOpen}
        onClick={() => openToc(!tocOpen)}
      >
        <ListIcon width={16} height={16} />
      </button>
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
              // 再点一下收起（与上面四颗同一个手感 ✓）；收起也走 store 的关闭路径 ✓，
              // 否则"当前占用"会留着一个已经看不见的键 ✗。
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
