import { useEffect, useMemo, useState } from "react";
import { useNotes } from "../store/notes";
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
  type PluginView,
} from "../lib/pluginViews";

/**
 * 声明式视图的**表格本体**（M11.9）。
 *
 * 它是零代码插件的显示方式本身：插件交一份声明（查询 + 列），查询、排序、格式化全在这里做。
 * 插件拿不到任何 DOM、也注入不了脚本——它没有代码。
 *
 * 为什么单独抽一个组件（M11.9 收尾）：同一个视图现在有**两种落点**——浮层（`placement:
 * "overlay"`）与右侧常驻面板（`placement: "rail"`）。两种形态的**表格必须一模一样**，
 * 否则同一个插件会因为落点不同而看到不同的表（列的处理、汇总、点行行为都是契约）。
 * 所以宿主外壳（谁开、多大、怎么关）留在各自的组件里，表格本体只有这一份。
 *
 * 渲染逻辑（过滤/排序/列/汇总）在 lib/pluginViews，纯函数且有单测；这里只负责取数与画。
 *
 * 查询字段可以写成 `{ "fromSetting": "key" }`（M11.9 收口）：此时要先把用户设的值读出来
 * 再渲染。设置**没到之前不画表**——否则用户会先看到一张没按他的设置过滤的表（比如
 * "最近 30 天"的设置还没生效、先列出全部页面），那比慢半拍更让人困惑。
 */
export function PluginViewTable({
  pluginId,
  view,
  onOpenPage,
}: {
  pluginId: string;
  view: PluginView;
  /** 点某一行时做什么。两个宿主的差别只在这里：浮层会顺手关掉自己，常驻面板则留着。 */
  onOpenPage: (pageId: string) => void;
}) {
  const pages = useNotes((s) => s.pages);
  const [reloadTick, setReloadTick] = useState(0);
  // null = 还没读到设置（仅在视图真的用到设置时才会是 null）
  const [settings, setSettings] = useState<PluginSetting[] | null>(null);

  // 视图一挂上就刷新一次页面列表：视图的数据来自页面，别人刚改的内容不该等到下次开关才看见。
  // （常驻面板尤其需要：它可能一直开着，而数据源在别处被改。）
  useEffect(() => {
    void useNotes.getState().loadPages();
    setReloadTick((n) => n + 1);
  }, [pluginId, view.id]);

  // 用到设置才去读（一次 IPC，本地很快）：没用到就不打扰后端，行为与从前完全一样。
  const needsSettings = viewNeedsSettings(view);
  useEffect(() => {
    if (!pluginId || !viewNeedsSettings(view)) {
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
  }, [pluginId, view]);

  const resolved = useMemo(
    () => (!needsSettings || settings ? resolveView(view, settings ?? []) : null),
    [view, settings, needsSettings],
  );

  const { rows, total } = useMemo(
    () => (resolved ? selectViewRows(pages as PageMeta[], resolved, Date.now()) : { rows: [], total: 0 }),
    // reloadTick 参与依赖：加载完成后重算（pages 引用变化也会触发）
    [resolved, pages, reloadTick],
  );
  const columns = useMemo(() => (resolved ? effectiveColumns(resolved) : []), [resolved]);

  if (!resolved) return <div className="plugin-view-empty">正在读取你的设置…</div>;

  const headers = columns.map((c) => VIEW_COLUMNS.find((k) => k.key === c)?.title ?? c);
  const days = resolved.query.updatedWithinDays ?? null;

  return (
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
              <tr key={p.id} onClick={() => onOpenPage(p.id)}>
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
  );
}
