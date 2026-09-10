import { useEffect, useMemo, useState } from "react";
import { useNotes } from "../store/notes";
import { usePluginViewStore } from "../store/pluginViews";
import { api } from "../lib/api";
import type { PageMeta, PluginSetting } from "../types";
import {
  VIEW_COLUMNS,
  cellText,
  effectiveColumns,
  resolveView,
  selectViewRows,
  summaryText,
  viewNeedsSettings,
} from "../lib/pluginViews";

/**
 * 声明式视图的宿主渲染器（M11.9）。
 *
 * 这个组件是**零代码插件唯一的显示方式**：插件交一份声明（查询 + 列），查询、排序、
 * 格式化全在这里做。插件拿不到任何 DOM、也注入不了脚本——它没有代码。
 *
 * 渲染逻辑（过滤/排序/列/汇总）在 lib/pluginViews，纯函数且有单测；这里只负责画。
 *
 * 查询字段可以写成 `{ "fromSetting": "key" }`（M11.9 收口）：此时要先把用户设的值读出来
 * 再渲染。设置**没到之前不画表**——否则用户会先看到一张没按他的设置过滤的表（比如
 * "最近 30 天"的设置还没生效、先列出全部页面），那比慢半拍更让人困惑。
 */
export function PluginViewOverlay() {
  const { open, close, pluginId, pluginName, view } = usePluginViewStore();
  const pages = useNotes((s) => s.pages);
  const openPage = useNotes((s) => s.openPage);
  const [reloadTick, setReloadTick] = useState(0);
  // null = 还没读到设置（仅在视图真的用到设置时才会是 null）
  const [settings, setSettings] = useState<PluginSetting[] | null>(null);

  // 打开时刷新一次页面列表：视图的数据来自页面，别人刚改的内容不该等到下次开关才看见。
  useEffect(() => {
    if (!open) return;
    void useNotes.getState().loadPages();
    setReloadTick((n) => n + 1);
  }, [open]);

  // 用到设置才去读（一次 IPC，本地很快）：没用到就不打扰后端，行为与从前完全一样。
  const needsSettings = view ? viewNeedsSettings(view) : false;
  useEffect(() => {
    if (!open || !pluginId || !view) {
      setSettings(null);
      return;
    }
    if (!viewNeedsSettings(view)) {
      setSettings(null);
      return;
    }
    let alive = true;
    setSettings(null);
    api
      .pluginSettings(pluginId)
      .then((s) => {
        if (alive) setSettings(s);
      })
      .catch(() => {
        // 读不到设置就按"都没设过"渲染（即宿主的默认行为）——插件声明的数据不该让面板打不开。
        if (alive) setSettings([]);
      });
    return () => {
      alive = false;
    };
  }, [open, pluginId, view]);

  const resolved = useMemo(
    () => (view && (!needsSettings || settings) ? resolveView(view, settings ?? []) : null),
    [view, settings, needsSettings],
  );

  const { rows, total } = useMemo(
    () => (resolved ? selectViewRows(pages as PageMeta[], resolved, Date.now()) : { rows: [], total: 0 }),
    // reloadTick 参与依赖：加载完成后重算（pages 引用变化也会触发）
    [resolved, pages, reloadTick],
  );
  const columns = useMemo(() => (resolved ? effectiveColumns(resolved) : []), [resolved]);

  if (!open || !view) return null;

  const headers = columns.map((c) => VIEW_COLUMNS.find((k) => k.key === c)?.title ?? c);
  const days = resolved?.query.updatedWithinDays ?? null;

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
        {!resolved ? (
          <div className="plugin-view-empty">正在读取你的设置…</div>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
