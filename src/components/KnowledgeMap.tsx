// KB-S4-MAP —— S4「知识地图」的视图层（**只读** ✓）。
//
// 关系数据只来自**既有那一条**出处：`api.getGraph()`（与 `GraphView` 同一份 ✓ —— 这一层不算关系 ✗）；
// 上限与「只画了一部分」由 `src/lib/kbMap.ts` 一处定 ✓ —— 界面**必须**把截断说出来 ✓
// （不许让用户以为"我的图就这么大" ✗ —— 本仓逐字罚过「悄悄截断」）。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../lib/api";
import { GRAPH_NODE_CAP, GRAPH_TRUNCATED, UNTAGGED, buildKbMap } from "../lib/kbMap";
import { useNotes } from "../store/notes";
import type { GraphData } from "../types";

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
    </div>
  );
}
