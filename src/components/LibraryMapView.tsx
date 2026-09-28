// 「库地图」只读视图（LLM wiki **第二块着陆点**）—— 把 `buildLibraryMap` 的输出画出来。
//
// ## 它不做什么（免得后人给它加错东西）
// · **不取材、不扫描**：地图由调用方（面板）算好传进来 —— 面板与"检查索引覆盖"**共用同一次扫描**，
//   不许多扫一遍（成本 O(页面数) 次命令调用）；
// · **不生成正文、不调用模型**：专题分区与结论那一层要模型 ⇒ 那是第三块，不在这里；
// · **不写任何东西**：没有 hooks、没有副作用、没有 store 订阅 ⇒ 它只是个纯展示组件。
//
// ## ⚠️ 界面这一半最要紧的一条：**未知 ≠ 0**
// `count === null` 必须画成「未知」，**绝不许**画成 0 —— 面板里已有同一条先例
// （「派生落后」那一栏把 `null` 显示成「未知」）。这条由渲染级判据钉住：
// `LibraryMapView.test.tsx` 里同时断言"`null` ⇒ 「未知」且不出现 0"与"`0` ⇒ 显示 0 且不出现「未知」"。

import type { LibraryMap } from "../lib/ai/libraryMap";

export function LibraryMapView({ map, title = "库地图（只读派生视图）" }: { map: LibraryMap; title?: string }) {
  return (
    <div className="ai-libmap" data-testid="library-map">
      <div className="ai-libmap-head">
        <span className="ai-libmap-title">{title}</span>
        <span className="ai-libmap-sub">由覆盖度报告重排：不生成正文、不写库；有格子没读数时显示为「未知」。</span>
      </div>
      {map.sections.map((s) => (
        <section key={s.key} className="ai-libmap-sec" data-section={s.key}>
          <div className="ai-libmap-sec-label">{s.label}</div>
          <div className="ai-libmap-sec-summary">{s.summary}</div>
          <ul className="ai-libmap-items">
            {s.items.map((it) => (
              <li key={it.key} className={`ai-libmap-item is-${it.tone}`} data-tone={it.tone} data-item={it.key}>
                <span className="ai-libmap-item-label">{it.label}</span>
                <span className="ai-libmap-item-count" data-count={it.count === null ? "unknown" : String(it.count)}>
                  {it.count === null ? "未知" : it.count}
                </span>
                {it.note ? <span className="ai-libmap-item-note">{it.note}</span> : null}
                {it.sources.length > 0 ? <span className="ai-libmap-item-src">{`来源：${it.sources.join("、")}`}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!map.coverageComplete ? (
        <div className="ai-libmap-warn">有格子这次没查（显示为「未知」）—— **未知不等于没有**，别把它读成 0。</div>
      ) : null}
    </div>
  );
}
