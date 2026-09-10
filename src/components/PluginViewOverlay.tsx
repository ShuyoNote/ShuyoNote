import { useEffect, useMemo, useState } from "react";
import { useNotes } from "../store/notes";
import { usePluginViewStore } from "../store/pluginViews";
import type { PageMeta } from "../types";
import { VIEW_COLUMNS, cellText, effectiveColumns, selectViewRows, summaryText } from "../lib/pluginViews";

/**
 * 声明式视图的宿主渲染器（M11.9）。
 *
 * 这个组件是**零代码插件唯一的显示方式**：插件交一份声明（查询 + 列），查询、排序、
 * 格式化全在这里做。插件拿不到任何 DOM、也注入不了脚本——它没有代码。
 *
 * 渲染逻辑（过滤/排序/列/汇总）在 lib/pluginViews，纯函数且有单测；这里只负责画。
 */
export function PluginViewOverlay() {
  const { open, close, pluginName, view } = usePluginViewStore();
  const pages = useNotes((s) => s.pages);
  const openPage = useNotes((s) => s.openPage);
  const [reloadTick, setReloadTick] = useState(0);

  // 打开时刷新一次页面列表：视图的数据来自页面，别人刚改的内容不该等到下次开关才看见。
  useEffect(() => {
    if (!open) return;
    void useNotes.getState().loadPages();
    setReloadTick((n) => n + 1);
  }, [open]);

  const { rows, total } = useMemo(
    () => (view ? selectViewRows(pages as PageMeta[], view, Date.now()) : { rows: [], total: 0 }),
    // reloadTick 参与依赖：加载完成后重算（pages 引用变化也会触发）
    [view, pages, reloadTick],
  );
  const columns = useMemo(() => (view ? effectiveColumns(view) : []), [view]);

  if (!open || !view) return null;

  const headers = columns.map((c) => VIEW_COLUMNS.find((k) => k.key === c)?.title ?? c);
  const days = view.query.updated_within_days ?? null;

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
        {view.summary && (
          <div className="plugin-view-summary">{summaryText(total, rows.length, days !== null, days)}</div>
        )}
        {rows.length === 0 ? (
          <div className="plugin-view-empty">没有符合条件的页面</div>
        ) : (
          <table className="plugin-view-table">
            <thead>
              <tr>
                {headers.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} onClick={() => { void openPage(p.id); close(); }}>
                  {columns.map((c) => (
                    <td key={c} className={c === "title" ? "plugin-view-cell-title" : ""}>
                      {cellText(p, c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
