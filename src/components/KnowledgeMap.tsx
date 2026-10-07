// KB-S4-MAP —— S4「知识地图」的视图层（**只读** ✓）。
//
// 关系数据只来自**既有那一条**出处：`api.getGraph()`（与 `GraphView` 同一份 ✓ —— 这一层不算关系 ✗）；
// 上限与「只画了一部分」由 `src/lib/kbMap.ts` 一处定 ✓ —— 界面**必须**把截断说出来 ✓
// （不许让用户以为"我的图就这么大" ✗ —— 本仓逐字罚过「悄悄截断」）。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../lib/api";
import { GRAPH_NODE_CAP, GRAPH_TRUNCATED, UNTAGGED, buildKbMap } from "../lib/kbMap";
import { useEditorStore } from "../store/editor";
import { useNotes } from "../store/notes";
import type { GraphData } from "../types";

/**
 * 「LLM Wiki（库地图）」入口 —— 放在知识地图**下面**（owner 2026-10-08：
 * 「在知识地图下面添加 LLM Wiki 入口按钮」✓）。
 *
 * ⛔ 它必须与命令面板那条 `ai.libraryMap` 是**同一个动作**（`openSettings("ai")`）——
 *   各写一条"打开库地图"的路 ＝ 第二份真相源 ✗；判据就钉在这一点上
 *   （`KnowledgeMap.test.tsx`：点它调的就是 `openSettings("ai")`，且 `openPage` 一次都不调 ✓）。
 * ⚠️ 只**打开面板**、不自动跑扫描：全库扫描是 O(页面数) 的调用（需求 §4 明确不要定时/自动重跑 ✓）。
 */
function LlmWikiEntry() {
  const { t } = useTranslation();
  return (
    <div className="kb-map-foot">
      <button type="button" className="kb-map-wiki" onClick={() => useEditorStore.getState().openSettings("ai")}>
        {t("kbMap.wikiEntry")}
      </button>
      <span className="kb-map-wiki-hint">{t("kbMap.wikiHint")}</span>
    </div>
  );
}

export function KnowledgeMap() {
  const { t } = useTranslation();
  const openPage = useNotes((s) => s.openPage);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getGraph()
      .then((g) => {
        if (!alive) return;
        setGraph(g);
        setErr(null);
      })
      .catch((e: unknown) => {
        // 照实：读不到就说读不到 ✓（不许画一张空图冒充"没有关系" ✗）
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const map = useMemo(() => buildKbMap(graph), [graph]);

  if (err) {
    return (
      <div className="kb-map kb-map-error" role="status">
        {t("kbMap.unavailable", { why: err })}
      </div>
    );
  }
  if (!graph) {
    return (
      <div className="kb-map kb-map-loading" role="status">
        {t("kbMap.loading")}
      </div>
    );
  }
  if (map.pages.length === 0) {
    return (
      <div className="kb-map kb-map-empty" role="status">
        <h2 className="kb-map-title">{t("kbMap.title")}</h2>
        <p className="kb-map-note">{t("kbMap.empty")}</p>
        {/* ⚠️ 空库也留着入口：一个**还没索引过**的空间里，"去 LLM Wiki 看看"恰恰是最该做的事 ✓
            （只在有聚类的分支上放入口 ⇒ 新空间里它反而消失 ✗） */}
        <LlmWikiEntry />
      </div>
    );
  }

  return (
    <div className="kb-map">
      <h2 className="kb-map-title">{t("kbMap.title")}</h2>
      <p className="kb-map-note">
        {t("kbMap.summary", { pages: map.pages.length, clusters: map.clusters.length, cap: GRAPH_NODE_CAP })}
      </p>
      {map[GRAPH_TRUNCATED] && (
        // ⚠️ 这条**不能省**：大库上少画了就说少画了 ✓
        <p className="kb-map-warn" role="status">
          {t("kbMap.truncated", { hidden: map.hidden, cap: GRAPH_NODE_CAP })}
        </p>
      )}
      <ul className="kb-map-clusters">
        {map.clusters.map((c) => (
          <li key={c.key} className="kb-map-cluster">
            <div className="kb-map-cluster-head">
              {/* ⚠️ 名字**单行截断**（`App.css` 的 `.kb-map-cluster-name`）⇒ 必须给 `title`：
                  截断而不给全名＝把信息真的删掉 ✗（owner 2026-10-08：「卡片名称不回绕」） */}
              <span className="kb-map-cluster-name" title={c.key === UNTAGGED ? t("kbMap.untagged") : c.label}>
                {c.key === UNTAGGED ? t("kbMap.untagged") : c.label}
              </span>
              <span className="kb-map-cluster-count">{c.pages.length}</span>
            </div>
            <ul className="kb-map-pages">
              {c.pages.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="kb-map-page"
                    title={p.title || t("kbMap.untitled")}
                    onClick={() => void openPage(p.id)}
                  >
                    {p.title || t("kbMap.untitled")}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {/* ⭐ 入口在**聚类列表之后** ——「在知识地图下面」（判据量的是 DOM 顺序，不是印象 ✓） */}
      <LlmWikiEntry />
    </div>
  );
}
