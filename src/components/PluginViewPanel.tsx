import { useEffect } from "react";
import { useNotes } from "../store/notes";
import { usePluginViewStore } from "../store/pluginViews";
import { useRightPanel } from "../store/rightPanel";
import { viewPlacement, viewPlacementKey } from "../lib/pluginViews";
import { PluginViewTable } from "./PluginViewTable";

/**
 * 声明式视图的**右侧常驻面板**宿主（`placement: "rail"`，M11.9 收尾）。
 *
 * 与浮层的差别不是外观，而是**用法**：浮层是"看完了就关"，面板是"一边看正文一边看着它"。
 * 所以这里有两条行为契约：
 *
 * 1. **点行不关面板**——常驻面板的用途就是连续查看（点开一页、看不完再点下一行），
 *    点一下就被关掉的话，它和浮层没有区别；
 * 2. **数据跟着页面走**——页面列表变了（在别处编辑完一篇）表格会跟着更新，不必关掉再开。
 *
 * 互斥（一次只开一个右侧抽屉）由 rightPanel store 负责；这里只负责"当前这个视图是不是
 * 那个抽屉"。表格本体与浮层共用 `PluginViewTable`。
 */
export function PluginViewPanel() {
  const { pluginId, pluginName, view } = usePluginViewStore();
  const activeKey = useRightPanel((s) => s.plugin);
  const closePanel = useRightPanel((s) => s.openPlugin);
  const openPage = useNotes((s) => s.openPage);

  // 这个视图是不是"该由面板渲染的那个"（落点 rail + 右栏当前占用的就是它）
  const railView =
    pluginId && view && viewPlacement(view) === "rail" ? { pluginId, pluginName, view } : null;
  const shown = railView !== null && activeKey === viewPlacementKey(railView.pluginId, railView.view);

  // 桌面让位 / 窄屏不让位（与 AI 面板、目录同一条规则，样式在 App.css 里配对）。
  // 这个 effect 必须在**早退之前**，否则面板一关就再也没机会摘掉那个 class。
  useEffect(() => {
    document.body.classList.toggle("is-plugin-panel-open", shown);
    return () => document.body.classList.remove("is-plugin-panel-open");
  }, [shown]);

  if (!shown || railView === null) return null;
  const v = railView.view;

  return (
    <aside className="plugin-panel" aria-label={`插件面板：${v.title || v.id}`}>
      <div className="plugin-view-head">
        <div className="plugin-view-title">
          {v.title || v.id}
          <span className="plugin-view-from">来自插件「{railView.pluginName}」</span>
        </div>
        <button className="plugin-view-close" onClick={() => closePanel(null)} title="关闭面板">
          ×
        </button>
      </div>
      <PluginViewTable pluginId={railView.pluginId} view={v} onOpenPage={(id) => void openPage(id)} />
    </aside>
  );
}
