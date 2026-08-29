import { type PdfAnnotation } from "../lib/pdfAnnotation";
import type { PdfAnnotationRecord } from "../types";

// M24 — 思源式右侧「批注」侧栏。列出该 PDF 全部页的批注（分组按页），
// 每条显示类型图标 + 内容/坐标 + 页码；点击跳转到对应页并定位到该批注。

interface Props {
  records: PdfAnnotationRecord[];
  currentPage: number;
  onJump: (pageIndex: number, ann: PdfAnnotation) => void;
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

export function PdfSidebar({ records, currentPage, onJump }: Props) {
  // Flatten: [{pageIndex, ann}...] in insertion order, grouped by page for display.
  const items: { pageIndex: number; ann: PdfAnnotation }[] = [];
  for (const rec of records) {
    const anns = (rec.annotations ?? []) as PdfAnnotation[];
    for (const ann of anns) items.push({ pageIndex: rec.page_index, ann });
  }

  if (items.length === 0) {
    return (
      <div className="pdf-sidebar-empty">
        <div className="pdf-sidebar-empty-title">暂无批注</div>
        <div className="pdf-sidebar-empty-sub">用上方工具在页面上高亮 / 画画 / 加便签，标注会列在这里。</div>
      </div>
    );
  }

  // Group by page in ascending order.
  const byPage = new Map<number, { pageIndex: number; ann: PdfAnnotation }[]>();
  for (const it of items) {
    const arr = byPage.get(it.pageIndex) ?? [];
    arr.push(it);
    byPage.set(it.pageIndex, arr);
  }
  const pages = [...byPage.entries()].sort((a, b) => a[0] - b[0]);

  return (
    <div className="pdf-sidebar">
      <div className="pdf-sidebar-head">批注 {items.length}</div>
      <div className="pdf-sidebar-list">
        {pages.map(([pageIdx, arr]) => (
          <div key={pageIdx} className="pdf-sidebar-page">
            <div className={`pdf-sidebar-page-no${pageIdx === currentPage ? " active" : ""}`}>第 {pageIdx + 1} 页</div>
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
                <button
                  key={`${pageIdx}-${ann.id}-${i}`}
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
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
