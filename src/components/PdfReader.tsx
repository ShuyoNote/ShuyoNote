import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePdfReader } from "../store/pdfReader";
import { createPdfjsEngine } from "../lib/pdfEngine/pdfjsEngine";
import { platform } from "../lib/platform";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import type { PdfAnnotation } from "../lib/pdfAnnotation";
import type { OutlineItem } from "../lib/pdfRender";
import type { TextItemLike } from "../lib/pdfTextLayer";
import type { PdfAnnotationRecord } from "../types";
import { buildLayout, computeViewport } from "../lib/pdfLayout";
import { PdfAnnotationCanvas } from "./PdfAnnotationCanvas";
import { PdfSidebar } from "./PdfSidebar";
import { PdfOutline } from "./PdfOutline";
import { PdfAskBar } from "./PdfAskBar";

// M24 — desktop native PDF render engine. Prefer the Rust/mupdf rasterizer when
// available (works in the Tauri webview too); otherwise fall back to pdf.js.
// Native returns raw RGBA8; we draw it into a <canvas> and emit a PNG Blob so the
// rest of the reader (which renders an <img src>) stays engine-agnostic.
async function renderPagePng(
  eng: ReturnType<typeof createPdfjsEngine>,
  attachmentId: string | null,
  pageIndex: number,
  scale: number,
): Promise<Blob> {
  if (attachmentId && platform.pdfRender.nativeAvailable()) {
    const { bytes, width, height } = await platform.pdfRender.renderPdfPage(attachmentId, pageIndex, scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建 2D 上下文");
    const img = ctx.createImageData(width, height);
    img.data.set(bytes);
    ctx.putImageData(img, 0, 0);
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("导出页面失败"))), "image/png"),
    );
  }
  return eng.renderPageToBlob(pageIndex, scale);
}

// 单页块数据（懒加载，视口内才拉取）。
interface PageBlockData {
  url: string | null;
  textItems: TextItemLike[] | null;
  hasTextLayer: boolean;
  meta: { w: number; h: number } | null;
}

// 方案 B — 连续滚动中的单个页块。每页一个自包含 PdfAnnotationCanvas，
// 工具条/撤销/选中/批注都随页块走。宽 = 内容宽，高位略宽于内容以留间隙。
function PdfContinuousPage({
  pageIndex,
  attachmentId,
  data,
  width,
  focusTarget,
  onFocusConsumed,
}: {
  pageIndex: number;
  attachmentId: string;
  data: PageBlockData;
  width: number;
  focusTarget: { pageIndex: number; ann: PdfAnnotation } | null;
  onFocusConsumed: () => void;
}) {
  const { url, textItems, hasTextLayer, meta } = data;
  if (!meta) {
    return <div className="pdf-annot-placeholder" style={{ width }}>第 {pageIndex + 1} 页…</div>;
  }
  return (
    <PdfAnnotationCanvas
      attachmentId={attachmentId}
      pageIndex={pageIndex}
      pageW={meta.w}
      pageH={meta.h}
      pageImageUrl={url}
      hasTextLayer={hasTextLayer}
      textItems={textItems}
      focusTarget={focusTarget}
      onFocusConsumed={onFocusConsumed}
    />
  );
}

// M24 — PDF reader modal. 方案 B：虚拟化连续滚动。文档以「页块栈」纵向排布：
// 每个页块绝对定位在累计偏移处（占位高 = 固定 chrome 带 + 页面图像高，宽统一为内容宽），
// 舞台只挂载视口 ± 缓冲的页块，其余页只占位（不渲染），保持整段可滚且不叠盖。
export function PdfReader() {
  const { open, attachmentId, name, bytes, targetPage, close } = usePdfReader();
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1);
  const [maximized, setMaximized] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [annRecords, setAnnRecords] = useState<PdfAnnotationRecord[]>([]);
  const [focusTarget, setFocusTarget] = useState<{ pageIndex: number; ann: PdfAnnotation } | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [viewRange, setViewRange] = useState<{ start: number; end: number }>({ start: -1, end: -1 });
  const [pageData, setPageData] = useState<Record<number, PageBlockData>>({});
  const [stageWidth, setStageWidth] = useState(0);

  const engRef = useRef<ReturnType<typeof createPdfjsEngine> | null>(null);
  const closeRef = useRef<(() => void) | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const pageCacheRef = useRef<Map<string, string>>(new Map());
  const mountedPagesRef = useRef<Set<number>>(new Set());
  const inflightRef = useRef<Set<string>>(new Set());
  const scrollRafRef = useRef<number | null>(null);

  const toggleMax = () => setMaximized((m) => !m);

  // 内容宽（舞台内容区宽度 - 内边距）。用 ResizeObserver 监听，随最大化/侧栏变化。
  const contentWidth = Math.max(stageWidth - 24, 200);

  // 全部页的前缀和布局（占位高 = chrome 带 + 页面图像高）。用 memo 避免滚动时 O(n) 回算。
  const metas = useMemo(
    () => Array.from({ length: pageCount }, (_, i) => pageData[i]?.meta ?? null),
    [pageCount, pageData],
  );
  const layout = useMemo(() => buildLayout(metas, contentWidth), [metas, contentWidth]);

  // 适配页宽：把缩放设成让页面图像在内容宽上报 1:1（= 内容宽 / 首页宽）。
  const fitWidth = () => {
    const meta0 = pageData[0]?.meta;
    if (!meta0 || stageWidth <= 0) return;
    const avail = stageWidth - 24;
    if (avail > 0 && meta0.w > 0) {
      const s = Math.max(0.5, Math.min(3, +(avail / meta0.w).toFixed(2)));
      setScale(s);
    }
  };

  // 舞台宽监听（最大化 / 侧栏开关改变布局）。
  useEffect(() => {
    if (!ready) return;
    const st = stageRef.current;
    if (!st) return;
    const ro = new ResizeObserver(() => setStageWidth(st.clientWidth));
    ro.observe(st);
    setStageWidth(st.clientWidth);
    return () => ro.disconnect();
  }, [ready]);

  // 首次进入 / 舞台宽就绪且首页 meta 到位后：自动适配页宽（填充内容宽）。
  // 连续模式默认按 fitWidth 铺满，避免缩放保持 1 时页面只有原始像素大。
  const autoFitRef = useRef(false);
  useEffect(() => {
    if (!ready || stageWidth <= 0) return;
    if (!pageData[0]?.meta) return;
    if (autoFitRef.current) return;
    autoFitRef.current = true;
    fitWidth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, stageWidth, pageData]);

  // 目录/书签跳页。
  const onOutlineJump = (pageIndex: number) => {
    if (pageIndex < 0 || pageIndex >= (pageCount || 1)) return;
    gotoPage(pageIndex);
  };

  // Load all annotation records for this attachment once (for the sidebar).
  useEffect(() => {
    if (!open || !attachmentId) return;
    let alive = true;
    api
      .listPdfAnnotations(attachmentId)
      .then((recs) => { if (alive) setAnnRecords(recs ?? []); })
      .catch(() => { if (alive) setAnnRecords([]); });
    return () => { alive = false; };
  }, [open, attachmentId]);

  // Sidebar click: jump to page + ask the canvas to focus that annotation.
  const onSidebarJump = (pageIndex: number, ann: PdfAnnotation) => {
    if (pageIndex < 0 || pageIndex >= (pageCount || 1)) return;
    gotoPage(pageIndex);
    setFocusTarget({ pageIndex, ann });
  };

  // B6 — 从侧栏删除一条批注（更新 records + 持久化该页）。
  const onSidebarDelete = (pageIndex: number, annId: string) => {
    const rec = annRecords.find((r) => r.page_index === pageIndex);
    if (!rec) return;
    const next = (rec.annotations as PdfAnnotation[]).filter((a) => a.id !== annId);
    if (next.length === rec.annotations.length) return;
    const updated = annRecords.map((r) =>
      r.page_index === pageIndex ? { ...r, annotations: next } : r,
    );
    setAnnRecords(updated);
    void api.savePdfAnnotations(attachmentId ?? "", pageIndex, next).catch(() => {});
    toast("已删除批注", "success");
  };

  // Load the document once per (open, bytes).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      closeRef.current?.();
      closeRef.current = null;
      setReady(false);
      setPageData({});
      setPageCount(0);
      setMaximized(true);
      setFocusTarget(null);
      setSidebarOpen(true);
      setOutlineOpen(true);
      setOutline([]);
      setCurrentPage(0);
      setViewRange({ start: -1, end: -1 });
      setStageWidth(0);
      mountedPagesRef.current.clear();
      resyncedRef.current = false;
      autoFitRef.current = false;
      const cache = pageCacheRef.current;
      for (const u of cache.values()) URL.revokeObjectURL(u);
      cache.clear();
      inflightRef.current.clear();
      const eng = createPdfjsEngine();
      engRef.current = eng;
      if (!bytes) return;
      try {
        const doc = await eng.loadPdf(bytes);
        if (alive) {
          closeRef.current = doc.close;
          setPageCount(doc.pageCount);
          setOutline(doc.outline ?? []);
          const target = Math.min(Math.max(targetPage, 0), Math.max(doc.pageCount - 1, 0));
          setCurrentPage(target);
          setReady(true);
        }
      } catch {
        if (alive) setPageCount(0);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, bytes]);

  // 首次渲染后 / 舞台宽度就绪：把舞台滚到当前页。
  // 依赖 stageWidth —— 初始 stageWidth=0 时页高还是占位值，等 ResizeObserver 报出真实宽再聚焦。
  useEffect(() => {
    if (!ready || stageWidth <= 0) return;
    gotoPage(currentPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, stageWidth]);

  // 舞台滚动 → 重算当前页与挂载范围（rAF 节流）。
  const updateViewport = useCallback(() => {
    const st = stageRef.current;
    if (!st) return;
    const vr = computeViewport(st.scrollTop, st.clientHeight, layout);
    setViewRange((prev) =>
      prev.start === vr.start && prev.end === vr.end ? prev : { start: vr.start, end: vr.end },
    );
    setCurrentPage((prev) => (prev === vr.current ? prev : vr.current));
  }, [layout]);

  const onStageScroll = useCallback(() => {
    if (scrollRafRef.current) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      updateViewport();
    });
  }, [updateViewport]);

  // 滚到某页：把该页顶部对齐到滚动容器顶部。
  const focusPage = useCallback(
    (pageIndex: number) => {
      const st = stageRef.current;
      if (!st) return;
      const clamped = Math.min(Math.max(pageIndex, 0), Math.max(pageCount - 1, 0));
      st.scrollTop = Math.max(0, layout.tops[clamped] ?? 0);
      updateViewport();
    },
    [layout, updateViewport, pageCount],
  );

  const gotoPage = useCallback(
    (pageIndex: number) => {
      const clamped = Math.min(Math.max(pageIndex, 0), Math.max(pageCount - 1, 0));
      setCurrentPage(clamped);
      focusPage(clamped);
    },
    [pageCount, focusPage],
  );

  // 挂载范围变化 → 更新已挂载页集合 + 触发数据加载。
  useEffect(() => {
    if (!ready || viewRange.start < 0) return;
    const mounted = new Set<number>();
    for (let i = viewRange.start; i <= viewRange.end; i++) mounted.add(i);
    mountedPagesRef.current = mounted;
  }, [viewRange, ready]);

  // 首屏：预取全部页的 meta（只是尺寸，秒回、不光栅化）。这样 slotH/pageTop 从第一帧起
  // 就用真实页面高宽比，滚动轴高度稳定，不会在逐页加载时发生布局跳变。
  useEffect(() => {
    if (!ready || pageCount <= 0) return;
    const eng = engRef.current;
    if (!eng) return;
    let alive = true;
    (async () => {
      // 并行拉取，数量大时也很快（仅 getPage + getViewport）。
      const metas = await Promise.all(
        Array.from({ length: pageCount }, (_, i) =>
          eng.getPageMeta(i).then((m) => ({ w: m.width, h: m.height })).catch(() => null),
        ),
      );
      if (!alive) return;
      setPageData((d) => {
        const next = { ...d };
        for (let i = 0; i < metas.length; i++) {
          const m = metas[i];
          if (m) next[i] = { ...(next[i] ?? { url: null, textItems: null, hasTextLayer: false }), meta: m };
        }
        return next;
      });
    })();
    return () => { alive = false; };
  }, [ready, pageCount]);

  // 真实页高就绪后，滚动轴上的页位置会重算一次；此时把当前页重新对齐一次（仅一次），
  // 避免首屏按占位比例定位、meta 到达后页面微移。用 ref 标记避免与用户滚动打架。
  const resyncedRef = useRef(false);
  useEffect(() => {
    if (!ready || stageWidth <= 0 || pageCount <= 0) return;
    if (resyncedRef.current) return;
    if (!pageData[0]?.meta) return;
    resyncedRef.current = true;
    focusPage(currentPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, stageWidth, pageData]);

  // 加载挂载范围内每页的数据（meta + 图像 + 文本层），只对缺失页发起请求。
  useEffect(() => {
    if (!ready || viewRange.start < 0) return;
    const eng = engRef.current;
    if (!eng) return;
    let alive = true;
    const pending: number[] = [];
    for (let i = viewRange.start; i <= viewRange.end; i++) {
      if (!pageData[i]?.meta) {
        pending.push(i);
        if (!pageData[i]) {
          setPageData((d) => ({ ...d, [i]: { url: null, textItems: null, hasTextLayer: false, meta: null } }));
        }
      }
    }
    if (!pending.length) return;

    (async () => {
      for (const i of pending) {
        if (!alive) return;
        try {
          const m = await eng.getPageMeta(i);
          if (!alive) return;
          setPageData((d) => ({
            ...d,
            [i]: { ...(d[i] ?? { url: null, textItems: null, hasTextLayer: false }), meta: { w: m.width, h: m.height } },
          }));
        } catch {
          if (!alive) return;
          setPageData((d) => ({
            ...d,
            [i]: { ...(d[i] ?? { url: null, textItems: null, hasTextLayer: false }), meta: { w: 600, h: 848 } },
          }));
        }

        const key = `${i}@${scale}`;
        const cache = pageCacheRef.current;
        let url = cache.get(key) ?? null;
        if (!url && !inflightRef.current.has(key)) {
          inflightRef.current.add(key);
          try {
            const blob = await renderPagePng(eng, attachmentId, i, scale);
            if (!alive) return;
            url = URL.createObjectURL(blob);
            if (cache.size >= 12) {
              const keys = [...cache.keys()];
              for (const k of keys) {
                const idx = Number(k.split("@")[0]);
                if (mountedPagesRef.current.has(idx)) continue;
                const old = cache.get(k);
                if (old) URL.revokeObjectURL(old);
                cache.delete(k);
                if (cache.size < 12) break;
              }
            }
            cache.set(key, url);
          } catch {
            if (alive) url = null;
          } finally {
            inflightRef.current.delete(key);
          }
        }
        if (!alive) return;
        setPageData((d) => ({
          ...d,
          [i]: { ...(d[i] ?? { meta: null, textItems: null, hasTextLayer: false }), url },
        }));

        try {
          const items = await eng.getPageTextItems(i);
          if (!alive) return;
          setPageData((d) => ({
            ...d,
            [i]: {
              ...(d[i] ?? { meta: null, url: null }),
              textItems: items,
              hasTextLayer: items.length > 0,
            },
          }));
        } catch {
          if (!alive) return;
          setPageData((d) => ({ ...d, [i]: { ...(d[i] ?? { meta: null, url: null }), textItems: null } }));
        }
      }
    })();

    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, viewRange, scale, attachmentId]);

  // 缩放变化后：页高随之变化，重新校准滚动位置。
  useEffect(() => {
    if (!ready || stageWidth <= 0) return;
    focusPage(currentPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  // 键盘导航：←/→/↑/↓ 跳上一页/下一页，+/- 缩放，Esc 关闭，F 适配页宽。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { close(); return; }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        gotoPage(currentPage + 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        gotoPage(currentPage - 1);
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setScale((s) => Math.min(3, +(s + 0.2).toFixed(2)));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setScale((s) => Math.max(0.5, +(s - 0.2).toFixed(2)));
      } else if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        fitWidth();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pageCount, close, currentPage]);

  if (!open) return null;

  // 构建挂载页块（绝对定位在累计偏移，宽 = 内容宽）。
  const pageBlocks: React.ReactNode[] = [];
  if (viewRange.start >= 0) {
    for (let i = viewRange.start; i <= viewRange.end; i++) {
      const d = pageData[i];
      pageBlocks.push(
        <div
          className="pdf-continuous-page"
          key={i}
          style={{ position: "absolute", top: layout.tops[i], left: 0, width: contentWidth, minHeight: layout.heights[i] }}
        >
          <PdfContinuousPage
            pageIndex={i}
            attachmentId={attachmentId ?? ""}
            width={contentWidth}
            data={d ?? { url: null, textItems: null, hasTextLayer: false, meta: null }}
            focusTarget={focusTarget}
            onFocusConsumed={() => setFocusTarget(null)}
          />
        </div>,
      );
    }
  }

  return createPortal(
    <div className="pdf-reader-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={`pdf-reader${maximized ? " maximized" : ""}`}>
        <div className="pdf-reader-head">
          <button className="pdf-reader-btn pdf-reader-outline-toggle" onClick={() => setOutlineOpen((s) => !s)} title={outlineOpen ? "隐藏目录" : "显示目录"} aria-pressed={outlineOpen} style={{ marginRight: 6 }}>
            {outlineOpen ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
            )}
          </button>
          <span className="pdf-reader-name" title={name || "PDF"}>{name || "PDF"}</span>
          <div className="pdf-reader-controls">
            <div className="pdf-reader-nav">
              <button className="pdf-reader-btn" onClick={() => gotoPage(currentPage - 1)} disabled={currentPage <= 0} title="上一页">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
              </button>
              <span className="pdf-reader-page">第 {Math.min(currentPage + 1, pageCount || 1)} / {pageCount || 1} 页</span>
              <button className="pdf-reader-btn" onClick={() => gotoPage(currentPage + 1)} disabled={currentPage >= pageCount - 1} title="下一页">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6"/></svg>
              </button>
            </div>
            <div className="pdf-reader-zoom">
              <button className="pdf-reader-btn" onClick={() => setScale((s) => Math.max(0.5, +(s - 0.2).toFixed(2)))} title="缩小">−</button>
              <span className="pdf-reader-pct">{Math.round(scale * 100)}%</span>
              <button className="pdf-reader-btn" onClick={() => setScale((s) => Math.min(3, +(s + 0.2).toFixed(2)))} title="放大">＋</button>
            </div>
            <button className="pdf-reader-btn" onClick={fitWidth} title="适配页宽">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18M8 8l-4 4 4 4M16 8l4 4-4 4"/></svg>
            </button>
            <button className="pdf-reader-btn" onClick={toggleMax} title={maximized ? "还原窗口" : "最大化窗口"}>
              {maximized ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 4h12v12M4 8l16-4"/></svg>
              )}
            </button>
            <button className="pdf-reader-btn" onClick={() => setSidebarOpen((s) => !s)} title={sidebarOpen ? "隐藏批注侧栏" : "显示批注侧栏"} aria-pressed={sidebarOpen}>
              {sidebarOpen ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>
              )}
            </button>
            <button className="pdf-reader-btn" onClick={() => setAskOpen((s) => !s)} title={askOpen ? "隐藏提问栏" : "对这篇 PDF 提问"} aria-pressed={askOpen}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>
            </button>
          </div>
          <button className="pdf-reader-close" onClick={close} title="关闭">×</button>
        </div>
        <div className="pdf-reader-body">
          {ready && pageCount > 0 ? (
            <div className={`pdf-reader-layout${sidebarOpen ? " has-sidebar" : ""}${outlineOpen ? " has-outline" : ""}`}>
              {outlineOpen && (
                <PdfOutline outline={outline} currentPage={currentPage} onJump={onOutlineJump} />
              )}
              <div className="pdf-reader-stage" ref={stageRef} onScroll={onStageScroll}>
                <div className="pdf-continuous" style={{ height: layout.total, position: "relative" }}>
                  {pageBlocks.length ? (
                    pageBlocks
                  ) : (
                    <div className="pdf-reader-loading">加载中…</div>
                  )}
                </div>
              </div>
              {sidebarOpen && (
                <PdfSidebar
                  records={annRecords}
                  currentPage={currentPage}
                  onJump={onSidebarJump}
                  onDelete={onSidebarDelete}
                />
              )}
            </div>
          ) : (
            <div className="pdf-reader-loading">加载中…</div>
          )}
        </div>
        {askOpen && (
          <div className="pdf-reader-askbar">
            <PdfAskBar
              attachmentId={attachmentId ?? ""}
              pageCount={pageCount || 1}
              getEngine={() => engRef.current}
              onDone={close}
            />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
