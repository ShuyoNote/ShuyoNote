import { useNotes } from "../store/notes";
import { usePluginViewStore } from "../store/pluginViews";
import { viewPlacement } from "../lib/pluginViews";
import { useOverlayLayer } from "../hooks/useOverlayLayer";
import { PluginViewTable } from "./PluginViewTable";

/**
 * 声明式视图的**浮层**宿主（M11.9 的默认形态：`placement` 缺省或 `"overlay"`）。
 *
 * 它是"看完了就关"的形态：占满屏幕、点空白或 × 关掉。表格本体在 `PluginViewTable`
 * （与右侧常驻面板共用一份，见那里的注释）。
 */
export function PluginViewOverlay() {
  const { close, pluginId, pluginName, view } = usePluginViewStore();
  const openPage = useNotes((s) => s.openPage);

  // 落点是 rail 的视图由 PluginViewPanel 渲染——两个宿主互斥，不能同时开。
  // ⚠️ store 里的 `open` 是**动作**（`open(pluginId, …)`），不是布尔开关；
  // 真正的"开着"判据是 `view` + `pluginId` 都在（原代码那个 `!open` 判断一直是空转）。
  const isOverlay = !!view && !!pluginId && viewPlacement(view) === "overlay";
  // Android 返回键：只有**真的以覆盖层身份**渲染时才登记（rail 形态不是浮层，
  // 登记进去会让返回键先吃掉一次按键）。见 lib/overlayStack.ts 与 §4.1.4。
  useOverlayLayer("pluginView", isOverlay, close);

  if (!isOverlay || !view || !pluginId) return null;

  return (
    <div className="plugin-view-overlay" onClick={close}>
      <div className="plugin-view" onClick={(e) => e.stopPropagation()}>
        <div className="plugin-view-head">
          <div className="plugin-view-title">
            {view.title || view.id}
            <span className="plugin-view-from">来自插件「{pluginName}」</span>
          </div>
          <button className="plugin-view-close" onClick={close} title="关闭">
            ×
          </button>
        </div>
        <PluginViewTable
          pluginId={pluginId}
          view={view}
          onOpenPage={(id) => {
            void openPage(id);
            close();
          }}
        />
      </div>
    </div>
  );
}
