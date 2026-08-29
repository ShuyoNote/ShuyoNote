import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePdfReader } from "../store/pdfReader";
import { createPdfjsEngine } from "../lib/pdfEngine/pdfjsEngine";
import { platform } from "../lib/platform";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import type { PdfAnnotation } from "../lib/pdfAnnotation";
import type { OutlineItem } from "../lib/pdfRender";
import type { PdfAnnotationRecord } from "../types";
import { PdfAnnotationCanvas } from "./PdfAnnotationCanvas";
import { PdfSidebar } from "./PdfSidebar";
import { PdfOutline } from "./PdfOutline";
import { PdfAskBar } from "./PdfAskBar";

// M24 — desktop native PDF render engine. Prefer the Rust/mupdf rasterizer when
// available (works in the Tauri webview too); otherwise fall back to pdf.js.
// Native returns raw RGBA8; we draw it into a <canvas> and emit a PNG Blob so the
// rest of the reader (which renders an <img src>) stays engine-agnostic. The
// browser's canvas→PNG encode is far faster than the native PNG encoder that we
// previously ran in Rust (which measured >1s for large pages — the lag culprit).
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

// M24 — PDF reader modal. Loads the PDF bytes via the pdf.js engine, renders the
// current page to a data URL, and hosts the annotation canvas. Page nav + zoom
// re-render the page; annotations are persisted per (attachment, page).
export function PdfReader() {
  const { open, attachmentId, name, bytes, targetPage, close } = usePdfReader();
  const [pageCount, setPageCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [scale, setScale] = useState(1);
  const [meta, setMeta] = useState<{ w: number; h: number; hasTextLayer: boolean } | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [textItems, setTextItems] = useState<{ str: string; transform: number[] | null; width: number; height: number }[] | null>(null);
  const [ready, setReady] = useState(false);
  const [maximized, setMaximized] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [annRecords, setAnnRecords] = useState<PdfAnnotationRecord[]>([]);
  const [focusTarget, setFocusTarget] = useState<{ pageIndex: number; ann: PdfAnnotation } | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const engRef = useRef<ReturnType<typeof createPdfjsEngine> | null>(null);
  const closeRef = useRef<(() => void) | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // 滚动到顶/底自动翻页：限定时间内只触发一次，避免快速滚动连续翻页。
  const scrollFlipRef = useRef<{ at: number; dir: "prev" | "next" | null }>({ at: 0, dir: null });
  // 页面渲染缓存：key = `${pageIndex}@${scale}` → object URL。翻回已渲染页/缩放立即可用，
  // 减少重复光栅化 + base64 克隆（慢的主因之一）。跳页时对旧 URL 做引用清理。
  const pageCacheRef = useRef<Map<string, string>>(new Map());

  const toggleMax = () => setMaximized((m) => !m);

  // 适配页宽：按舞台实际宽度算出每页恰好铺满的缩放。
  const fitWidth = () => {
    const stage = stageRef.current;
    if (!stage || !meta) return;
    const avail = stage.clientWidth - 40; // 减去舞台内边距
    if (avail > 0 && meta.w > 0) {
      const s = Math.max(0.5, Math.min(3, +(avail / meta.w).toFixed(2)));
      setScale(s);
    }
  };

  // 目录/书签跳页。
  const onOutlineJump = (pageIndex: number) => {
    if (pageIndex >= 0 && pageIndex < (pageCount || 1)) setPageIndex(pageIndex);
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
    if (pageIndex >= 0 && pageIndex < (pageCount || 1)) setPageIndex(pageIndex);
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
      setMeta(null);
      setPageUrl(null);
      setTextItems(null);
      setMaximized(true);
      setFocusTarget(null);
      setSidebarOpen(true);
      setOutlineOpen(true);
      setOutline([]);
      // 释放旧文档的页面渲染缓存。
      const cache = pageCacheRef.current;
      for (const u of cache.values()) URL.revokeObjectURL(u);
      cache.clear();
      const eng = createPdfjsEngine();
      engRef.current = eng;
      if (!bytes) return;
      try {
        const doc = await eng.loadPdf(bytes);
        if (alive) {
          closeRef.current = doc.close;
          setPageCount(doc.pageCount);
          setOutline(doc.outline ?? []);
          setPageIndex(Math.min(Math.max(targetPage, 0), Math.max(doc.pageCount - 1, 0)));
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

  // Render the current page + meta (re-runs when the doc becomes ready).
  // 图像 / 元数据 / 文本层三者并行，图像优先显示（文本层 pdf.js 解析最慢，不阻塞出图）。
  useEffect(() => {
    if (!open || !ready) return;
    let alive = true;
    const eng = engRef.current;
    if (!eng) return;

    // 1) 页面图像：优先缓存，miss 才光栅化。独立于文本层/元数据。
    (async () => {
      const key = `${pageIndex}@${scale}`;
      const cache = pageCacheRef.current;
      let url = cache.get(key) ?? null;
      if (!url) {
        try {
          const blob = await renderPagePng(eng, attachmentId, pageIndex, scale);
          if (!alive) return;
          url = URL.createObjectURL(blob);
          if (cache.size >= 12) {
            const oldestKey = cache.keys().next().value;
            if (typeof oldestKey === "string") {
              const oldUrl = cache.get(oldestKey);
              if (oldUrl) URL.revokeObjectURL(oldUrl);
              cache.delete(oldestKey);
            }
          }
          cache.set(key, url);
        } catch {
          if (alive) setPageUrl(null);
          return;
        }
      }
      if (alive) setPageUrl(url);
    })();

    // 2) 页面元数据（不阻塞出图）。
    (async () => {
      try {
        const m = await eng.getPageMeta(pageIndex);
        if (alive) setMeta({ w: m.width, h: m.height, hasTextLayer: m.hasTextLayer });
      } catch {
        if (alive) setMeta(null);
      }
    })();

    // 3) 文本层（划词用，后台算）。到达后据其推断 hasTextLayer，更新 meta。
    (async () => {
      try {
        const items = await eng.getPageTextItems(pageIndex);
        if (!alive) return;
        setTextItems(items);
        setMeta((m) => (m ? { ...m, hasTextLayer: items.length > 0 } : m));
      } catch {
        if (alive) setTextItems(null);
      }
    })();

    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready, pageIndex, scale, attachmentId]);

  // 翻页后：复位滚动到顶部，并清空滚动翻页方向锁（允许新页再触发）。
  useEffect(() => {
    if (!open) return;
    scrollFlipRef.current = { at: 0, dir: null };
    const st = stageRef.current;
    if (st) st.scrollTop = 0;
  }, [open, pageIndex]);

  // 键盘导航：←/→/↑/↓ 翻页，+/- 缩放，Esc 关闭，F 适配页宽（在输入框外）。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { close(); return; }
      // 输入框 / 内容可编辑时不动。
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        setPageIndex((p) => Math.min(Math.max(pageCount - 1, 0), p + 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setPageIndex((p) => Math.max(0, p - 1));
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
  }, [open, pageCount, close, meta]);

  // 滚动到顶/底自动翻页（A）：接近顶部 → 上一页；接近底部 → 下一页。
  // 用时间窗口 + 方向去抖，避免一次滚动触发多次翻页。
  const onStageScroll = () => {
    const st = stageRef.current;
    if (!st) return;
    const THRESHOLD = 24; // px 距边缘
    const now = Date.now();
    const flip = (dir: "prev" | "next") => {
      if (now - scrollFlipRef.current.at < 350) return;
      if (scrollFlipRef.current.dir === dir) return;
      scrollFlipRef.current = { at: now, dir };
      if (dir === "next") {
        setPageIndex((p) => Math.min(Math.max(pageCount - 1, 0), p + 1));
      } else {
        setPageIndex((p) => Math.max(0, p - 1));
      }
    };
    if (st.scrollTop <= THRESHOLD) {
      flip("prev");
    } else if (st.scrollTop + st.clientHeight >= st.scrollHeight - THRESHOLD) {
      flip("next");
    }
  };

  if (!open) return null;

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
              <button className="pdf-reader-btn" onClick={() => setPageIndex((p) => Math.max(0, p - 1))} disabled={pageIndex <= 0} title="上一页">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
              </button>
              <span className="pdf-reader-page">第 {pageIndex + 1} / {pageCount || 1} 页</span>
              <button className="pdf-reader-btn" onClick={() => setPageIndex((p) => Math.min(Math.max(pageCount - 1, 0), p + 1))} disabled={pageIndex >= pageCount - 1} title="下一页">
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
          {meta ? (
            <div className={`pdf-reader-layout${sidebarOpen ? " has-sidebar" : ""}${outlineOpen ? " has-outline" : ""}`}>
              {outlineOpen && (
                <PdfOutline
                  outline={outline}
                  currentPage={pageIndex}
                  onJump={onOutlineJump}
                />
              )}
              <div className="pdf-reader-stage" ref={stageRef} onScroll={onStageScroll}>
                <PdfAnnotationCanvas
                  attachmentId={attachmentId ?? ""}
                  pageIndex={pageIndex}
                  pageW={meta.w}
                  pageH={meta.h}
                  pageImageUrl={pageUrl}
                  hasTextLayer={meta.hasTextLayer}
                  textItems={textItems}
                  focusTarget={focusTarget}
                  onFocusConsumed={() => setFocusTarget(null)}
                />
              </div>
              {sidebarOpen && (
                <PdfSidebar
                  records={annRecords}
                  currentPage={pageIndex}
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
