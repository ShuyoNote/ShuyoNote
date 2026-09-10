import { useMemo } from "react";
import { useRightPanel } from "../store/rightPanel";
import { usePlugins } from "../store/plugins";
import { usePluginViewStore } from "../store/pluginViews";
import { viewPlacement, viewPlacementKey } from "../lib/pluginViews";
import { SparkleIcon, ListIcon, CommentIcon, PanelIcon } from "./icons";

// Right-edge vertical icon rail (Wolai-style launcher): a slim strip of buttons on
// the window's right edge that opens the right-side drawers (AI assistant / TOC /
// comments). The buttons are mutually exclusive via the shared rightPanel store.
export function RightRail() {
  const aiOpen = useRightPanel((s) => s.ai);
  const tocOpen = useRightPanel((s) => s.toc);
  const commentsOpen = useRightPanel((s) => s.comments);
  const openAi = useRightPanel((s) => s.openAi);
  const openToc = useRightPanel((s) => s.openToc);
  const openComments = useRightPanel((s) => s.openComments);
  const pluginKey = useRightPanel((s) => s.plugin);
  const plugins = usePlugins((s) => s.plugins);

  // 声明 `placement: "rail"` 的插件视图在这里各占一个按钮——这就是"常驻面板"的入口。
  // 只有**启用中**的插件算数：停用的插件的入口不该还在（与管理页的启用状态一致）。
  const railViews = useMemo(
    () =>
      plugins
        .filter((p) => p.enabled)
        .flatMap((p) =>
          (p.views ?? [])
            .filter((v) => viewPlacement(v) === "rail")
            .map((v) => ({ pluginId: p.id, pluginName: p.name, view: v, key: viewPlacementKey(p.id, v) })),
        ),
    [plugins],
  );

  return (
    <div className="right-rail">
      <button
        className={`rail-btn ${aiOpen ? "active" : ""}`}
        title="AI 助手"
        aria-label="AI 助手"
        onClick={() => openAi(!aiOpen)}
      >
        <SparkleIcon width={16} height={16} />
      </button>
      <button
        className={`rail-btn ${commentsOpen ? "active" : ""}`}
        title="评论 / 通知"
        aria-label="评论 / 通知"
        onClick={() => openComments(!commentsOpen)}
      >
        <CommentIcon width={16} height={16} />
      </button>
      <button
        className={`rail-btn ${tocOpen ? "active" : ""}`}
        title="目录"
        aria-label="目录"
        onClick={() => openToc(!tocOpen)}
      >
        <ListIcon width={16} height={16} />
      </button>
      {railViews.map((rv) => {
        const active = pluginKey === rv.key;
        return (
          <button
            key={rv.key}
            className={`rail-btn ${active ? "active" : ""}`}
            title={`${rv.view.title || rv.view.id}（插件「${rv.pluginName}」）`}
            aria-label={`插件面板：${rv.view.title || rv.view.id}`}
            aria-pressed={active}
            onClick={() => {
              // 再点一下收起（与上面三个抽屉同一个手感）；收起也走 store 的关闭路径，
              // 否则右栏的"当前占用"会留着一个已经看不见的键。
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
