import { useMemo, useState } from "react";
import { type PdfAnnotation } from "../lib/pdfAnnotation";
import type { PdfAnnotationRecord } from "../types";

// M24 — 思源式右侧「批注」侧栏。列出该 PDF 全部页的批注（分组按页），
// 每条显示类型图标 + 内容/坐标 + 页码；点击跳转到对应页并定位到该批注。
// 5 — 支持按类型筛选 + 每页显示条数。

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
  const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];

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
        <div className="pdf-sidebar-filter">
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
      <div className="pdf-sidebar-filter">
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
