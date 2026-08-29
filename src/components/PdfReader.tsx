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
import { buildLayout, computeViewport, fitScaleForWidth, zoomContentWidth, MAX_SCALE, MIN_SCALE } from "../lib/pdfLayout";
import { PdfAnnotationCanvas } from "./PdfAnnotationCanvas";
import { PdfSidebar } from "./PdfSidebar";
import { PdfOutline } from "./PdfOutline";
import { PdfAskBar } from "./PdfAskBar";

// 缩放预设（%）：下拉菜单可快速选择；「适配页宽」单独作为一项。
const ZOOM_PRESETS = [50, 75, 100, 125, 150, 175, 200, 250, 300];

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
  const [zoomOpen, setZoomOpen] = useState(false);
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
  const zoomWrapRef = useRef<HTMLDivElement | null>(null);
  const resyncedRef = useRef(false);
  const autoFitRef = useRef(false);

  const toggleMax = () => setMaximized((m) => !m);

  // 参考基准页宽（用首页 meta，作为所有页共享的显示宽度基准）。取不到时回退 612。
  const refW = useMemo(() => {
    const w0 = pageData[0]?.meta?.w;
    if (w0 && w0 > 0) return w0;
    for (const d of Object.values(pageData)) if (d.meta?.w) return d.meta.w;
    return 612;
  }, [pageData]);

  // 内容宽（页块显示宽，px）= 基准页宽 × 缩放。真正随 scale 变化 ⇒ 放大即真实放大。
  const contentWidth = zoomContentWidth(refW, scale);

  // 全部页的前缀和布局（占位高 = chrome 带 + 页面图像高）。用 memo 避免滚动时 O(n) 回算。
  const metas = useMemo(
    () => Array.from({ length: pageCount }, (_, i) => pageData[i]?.meta ?? null),
    [pageCount, pageData],
  );
  const layout = useMemo(() => buildLayout(metas, contentWidth), [metas, contentWidth]);

  // 适配页宽：让基准页在内容宽上报 1:1（= 视口内容宽 / 基准页宽）。
  const fitWidth = () => {
    if (!refW || stageWidth <= 0) return;
    const avail = Math.max(stageWidth - 24, 40);
    if (avail > 0 && refW > 0) {
      setScale(fitScaleForWidth(refW, avail));
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

  // 首次进入 / 舞台宽就绪且基准页宽到位后：自动适配页宽（填充内容宽）。
  // 连续模式默认按 fitWidth 铺满，避免缩放保持 1 时页面只有原始像素大。
  // 等 pageData[0].meta 拿到（真实基准页宽）才首度适配，避免用 612 回退值没对正。
  useEffect(() => {
    if (!ready || stageWidth <= 0) return;
    if (!pageData[0]?.meta) return;
    if (autoFitRef.current) return;
    autoFitRef.current = true;
    fitWidth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, stageWidth, pageData, refW]);

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
      setZoomOpen(false);
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
  useEffect(() => {
    if (!ready || stageWidth <= 0 || pageCount <= 0) return;
    if (resyncedRef.current) return;
    if (!pageData[0]?.meta) return;
    resyncedRef.current = true;
    focusPage(currentPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, stageWidth, pageData]);

  // 加载挂载范围内每页的数据（meta + 图像 + 文本层）。
  // - meta / 文本层：只在缺失时拉取（一次性）。
  // - 图像：以 `${i}@${scale}` 为缓存键，缩放变化后对每个可见页重新光栅化，
  //   否则页面图像停在旧分辨率、放大只会变糊。只对「当前缩放下的缓存 miss」发请求。
  useEffect(() => {
    if (!ready || viewRange.start < 0) return;
    const eng = engRef.current;
    if (!eng) return;
    let alive = true;
    const pages: number[] = [];
    for (let i = viewRange.start; i <= viewRange.end; i++) pages.push(i);

    // 每个可见页：确保有占位数据 + meta（缺失则拉一次）。
    const needMeta = pages.filter((i) => !pageData[i]?.meta);
    for (const i of needMeta) {
      if (!pageData[i]) {
        setPageData((d) => ({ ...d, [i]: { url: null, textItems: null, hasTextLayer: false, meta: null } }));
      }
    }

    (async () => {
      // 1) 并行拉取缺失 meta（尺寸，秒回）。
      if (needMeta.length) {
        const metas = await Promise.all(
          needMeta.map((i) =>
            eng.getPageMeta(i).then((m) => ({ i, w: m.width, h: m.height })).catch(() => ({ i, w: 600, h: 848 })),
          ),
        );
        if (!alive) return;
        setPageData((d) => {
          const next = { ...d };
          for (const { i, w, h } of metas) {
            next[i] = { ...(next[i] ?? { url: null, textItems: null, hasTextLayer: false }), meta: { w, h } };
          }
          return next;
        });
      }

      // 2) 并行拉取每个可见页在当前缩放下的图像（缓存 miss 才拉）。
      const needImg = pages.filter((i) => !pageCacheRef.current.has(`${i}@${scale}`));
      if (needImg.length) {
        await Promise.all(
          needImg.map(async (i) => {
            const key = `${i}@${scale}`;
            if (inflightRef.current.has(key)) return;
            inflightRef.current.add(key);
            let url: string | null = null;
            try {
              const blob = await renderPagePng(eng, attachmentId, i, scale);
              if (!alive) return;
              url = URL.createObjectURL(blob);
              const cache = pageCacheRef.current;
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
            if (alive) {
              setPageData((d) => ({
                ...d,
                [i]: { ...(d[i] ?? { meta: null, textItems: null, hasTextLayer: false }), url },
              }));
            }
          }),
        );
      }

      // 3) 并行拉取缺失文本层（划词用）。hasTextLayer 由 items 长度推断。
      const needText = pages.filter((i) => pageData[i]?.textItems === undefined || pageData[i]?.textItems === null);
      if (needText.length) {
        await Promise.all(
          needText.map(async (i) => {
            try {
              const items = await eng.getPageTextItems(i);
              if (!alive) return;
              setPageData((d) => ({
                ...d,
                [i]: { ...(d[i] ?? { meta: null, url: null }), textItems: items, hasTextLayer: items.length > 0 },
              }));
            } catch {
              if (!alive) return;
              setPageData((d) => ({ ...d, [i]: { ...(d[i] ?? { meta: null, url: null }), textItems: null } }));
            }
          }),
        );
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
      if (e.key === "Escape") {
        // 优先关闭缩放下拉；没有下拉时再关闭整篇阅读器。
        setZoomOpen((z) => {
          if (z) return false;
          close();
          return z;
        });
        return;
      }
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
        setScale((s) => Math.min(MAX_SCALE, +(s + 0.1).toFixed(2)));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setScale((s) => Math.max(MIN_SCALE, +(s - 0.1).toFixed(2)));
      } else if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        fitWidth();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pageCount, close, currentPage]);

  // 缩放下拉：点击下拉框外部时关闭。
  useEffect(() => {
    if (!zoomOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = zoomWrapRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) setZoomOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [zoomOpen]);

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
              <div className="pdf-zoom-wrap" ref={zoomWrapRef}>
                <button
                  className="pdf-reader-btn pdf-zoom-btn"
                  onClick={() => setZoomOpen((o) => !o)}
                  title="缩放"
                  aria-haspopup="listbox"
                  aria-expanded={zoomOpen}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/></svg>
                  <span className="pdf-reader-pct">{Math.round(scale * 100)}%</span>
                  <svg className="pdf-zoom-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                </button>
                {zoomOpen && (
                  <div className="pdf-zoom-menu" role="listbox">
                    <button className="pdf-zoom-item" role="option" onClick={() => { fitWidth(); setZoomOpen(false); }} title="让页面宽度刚好填满阅读器">
                      <span>适配页宽</span>
                    </button>
                    <div className="pdf-zoom-sep" />
                    {ZOOM_PRESETS.map((p) => (
                      <button
                        key={p}
                        className={`pdf-zoom-item${Math.round(scale * 100) === p ? " active" : ""}`}
                        role="option"
                        onClick={() => { setScale(p / 100); setZoomOpen(false); }}
                      >
                        <span>{p}%</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
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
