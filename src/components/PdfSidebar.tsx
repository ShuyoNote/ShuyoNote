import { useMemo, useState } from "react";
import { type PdfAnnotation } from "../lib/pdfAnnotation";
import type { PdfAnnotationRecord } from "../types";

// M24 — 思源式右侧「批注」侧栏。列出该 PDF 全部页的批注（分组按页），
// 每条显示类型图标 + 内容/坐标 + 页码；点击跳转到对应页并定位到该批注。
// 5 — 支持按类型筛选 + 每页显示条数。
//
// 2026-09-22（owner："右边侧栏顶部的四个按钮平时收起来"）：那四枚筛选胶囊（全部/高亮/便签/画笔）
// **默认收成一枚漏斗图标** —— 它们只在"标注很多、真要按类型筛"时才用得上，常驻却占满整个栏宽
// （≈236px）。展开状态记在 localStorage 里（点开过就一直开着）；筛选**不是**"全部"时，
// 收起状态也会把当前类型写在图标旁，免得"列表变短了却不知道为什么"。
const FILTER_OPEN_KEY = "shuyonote:pdf-sidebar-filters-open";

interface Props {
  records: PdfAnnotationRecord[];
  currentPage: number;
  onJump: (pageIndex: number, ann: PdfAnnotation) => void;
  /** B6 — 从侧栏删除一条批注（按 页码+id），调用方负责更新 records 并持久化。 */
  onDelete: (pageIndex: number, annId: string) => void;
}

function typeIcon(type: string): string {
  switch (type) {
    case "highlight": return "🖍";
    case "underline": return "＿";
    case "ink": return "✏️";
    case "sticky": return "🗒";
    case "rect": return "▭";
    default: return "•";
  }
}

function typeLabel(type: string): string {
  switch (type) {
    case "highlight": return "高亮";
    case "underline": return "下划线";
    case "ink": return "画笔";
    case "sticky": return "便签";
    case "rect": return "区域";
    default: return "批注";
  }
}

// 可筛选的类型集合（全部 + 常见类型）。
const FILTERS: { id: string; label: string; match: (a: PdfAnnotation) => boolean }[] = [
  { id: "all", label: "全部", match: () => true },
  { id: "highlight", label: "高亮", match: (a) => a.type === "highlight" },
  { id: "sticky", label: "便签", match: (a) => a.type === "sticky" },
  { id: "ink", label: "画笔", match: (a) => a.type === "ink" },
];

export function PdfSidebar({ records, currentPage, onJump, onDelete }: Props) {
  const [filter, setFilter] = useState("all");
  // 默认**收起**（"平时收起来"）；点开过就记下来，免得每次都要再点。
  const [filtersOpen, setFiltersOpen] = useState(() => {
    try {
      return localStorage.getItem(FILTER_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleFilters = () => {
    setFiltersOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(FILTER_OPEN_KEY, next ? "1" : "0");
      } catch {
        /* 隐私模式等：不影响功能 */
      }
      return next;
    });
  };
  const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];

  /** 筛选条：一枚漏斗开关（常驻）＋ 展开后的四枚胶囊。两个分支（空/有批注）共用同一份。 */
  const filterBar = (
    <div className="pdf-sidebar-filters">
      <button
        type="button"
        className={`pdf-sidebar-filter-toggle${filter !== "all" ? " is-active" : ""}`}
        onClick={toggleFilters}
        title={filtersOpen ? "收起筛选" : `筛选批注（当前：${active.label}）`}
        aria-label={`筛选批注（当前：${active.label}）`}
        aria-expanded={filtersOpen}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          {/* 漏斗 */}
          <path d="M3 5h18l-7 8v6l-4 2v-8z" />
        </svg>
        {/* 收起时若筛选不是"全部"，把当前类型写在旁边 —— 否则"列表变短了"没有解释 */}
        {filter !== "all" && <span className="pdf-sidebar-filter-current">{active.label}</span>}
      </button>
      {filtersOpen && (
        <div className="pdf-sidebar-filter" role="group" aria-label="批注筛选">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={`pdf-sidebar-filter-btn ${filter === f.id ? "active" : ""}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  // Flatten + filter annotations.
  const items = useMemo(() => {
    const out: { pageIndex: number; ann: PdfAnnotation }[] = [];
    for (const rec of records) {
      const anns = (rec.annotations ?? []) as PdfAnnotation[];
      for (const ann of anns) {
        if (active.match(ann)) out.push({ pageIndex: rec.page_index, ann });
      }
    }
    return out;
  }, [records, active]);

  if (items.length === 0) {
    return (
      <div className="pdf-sidebar">
        {filterBar}
        <div className="pdf-sidebar-empty">
          <div className="pdf-sidebar-empty-title">暂无批注</div>
          <div className="pdf-sidebar-empty-sub">用上方工具在页面上高亮 / 画画 / 加便签，标注会列在这里。</div>
        </div>
      </div>
    );
  }

  // Group filtered items by page in ascending order.
  const byPage = new Map<number, { pageIndex: number; ann: PdfAnnotation }[]>();
  for (const it of items) {
    const arr = byPage.get(it.pageIndex) ?? [];
    arr.push(it);
    byPage.set(it.pageIndex, arr);
  }
  const pages = [...byPage.entries()].sort((a, b) => a[0] - b[0]);

  return (
    <div className="pdf-sidebar">
      {filterBar}
      <div className="pdf-sidebar-head">批注 {items.length}</div>
      <div className="pdf-sidebar-list">
        {pages.map(([pageIdx, arr]) => (
          <div key={pageIdx} className="pdf-sidebar-page">
            <div className={`pdf-sidebar-page-no${pageIdx === currentPage ? " active" : ""}`}>
              第 {pageIdx + 1} 页 · {arr.length} 条
            </div>
            {arr.map(({ ann }, i) => {
              const text = ann.text?.trim();
              const desc =
                text ||
                (ann.type === "ink"
                  ? `${(ann.points?.length ?? 0)} 个点`
                  : ann.type === "sticky" || ann.type === "highlight" || ann.type === "underline" || ann.type === "rect"
                    ? "（区域标注）"
                    : "");
              return (
                <div key={`${pageIdx}-${ann.id}-${i}`} className="pdf-sidebar-item-row">
                  <button
                    className="pdf-sidebar-item"
                    onClick={() => onJump(pageIdx, ann)}
                    title={`${typeLabel(ann.type)} · 第 ${pageIdx + 1} 页`}
                  >
                    <span className="pdf-sidebar-item-icon">{typeIcon(ann.type)}</span>
                    <span className="pdf-sidebar-item-body">
                      <span className="pdf-sidebar-item-type">{typeLabel(ann.type)}</span>
                      <span className="pdf-sidebar-item-text">{desc}</span>
                    </span>
                    <span className="pdf-sidebar-item-page">{pageIdx + 1}</span>
                  </button>
                  <button
                    className="pdf-sidebar-del"
                    title="删除这条批注"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(pageIdx, ann.id);
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
