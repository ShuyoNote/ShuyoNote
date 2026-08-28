import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePdfReader } from "../store/pdfReader";
import { createPdfjsEngine } from "../lib/pdfEngine/pdfjsEngine";
import { platform } from "../lib/platform";
import { PdfAnnotationCanvas } from "./PdfAnnotationCanvas";

// Blob → data URL (self-contained; no object-URL revocation, so no ERR_FILE_NOT_FOUND).
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("转换页面图像失败"));
    fr.readAsDataURL(blob);
  });
}

// M24 — desktop native PDF render engine. Prefer the Rust/mupdf rasterizer when
// available (works in the Tauri webview too); otherwise fall back to pdf.js.
async function renderPagePng(
  eng: ReturnType<typeof createPdfjsEngine>,
  attachmentId: string | null,
  pageIndex: number,
  scale: number,
): Promise<Blob> {
  if (attachmentId && platform.pdfRender.nativeAvailable()) {
    const bytes = await platform.pdfRender.renderPdfPage(attachmentId, pageIndex, scale);
    return new Blob([bytes as unknown as ArrayBuffer], { type: "image/png" });
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
  const engRef = useRef<ReturnType<typeof createPdfjsEngine> | null>(null);
  const closeRef = useRef<(() => void) | null>(null);

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
      const eng = createPdfjsEngine();
      engRef.current = eng;
      if (!bytes) return;
      try {
        const doc = await eng.loadPdf(bytes);
        if (alive) {
          closeRef.current = doc.close;
          setPageCount(doc.pageCount);
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
  useEffect(() => {
    if (!open || !ready) return;
    let alive = true;
    (async () => {
      const eng = engRef.current;
      if (!eng) return;
      try {
        const m = await eng.getPageMeta(pageIndex);
        if (!alive) return;
        setMeta({ w: m.width, h: m.height, hasTextLayer: m.hasTextLayer });
      } catch {
        if (alive) setMeta(null);
      }
      try {
        const items = await eng.getPageTextItems(pageIndex);
        if (alive) setTextItems(items);
      } catch {
        if (alive) setTextItems(null);
      }
      try {
        const blob = await renderPagePng(eng, attachmentId, pageIndex, scale);
        if (!alive) return;
        const dataUrl = await blobToDataUrl(blob);
        if (!alive) return;
        setPageUrl(dataUrl);
      } catch {
        if (alive) setPageUrl(null);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready, pageIndex, scale]);

  if (!open) return null;

  return createPortal(
    <div className="pdf-reader-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="pdf-reader">
        <div className="pdf-reader-head">
          <span className="pdf-reader-name">{name || "PDF"}</span>
          <div className="pdf-reader-nav">
            <button className="pdf-reader-btn" onClick={() => setPageIndex((p) => Math.max(0, p - 1))} disabled={pageIndex <= 0}>‹</button>
            <span className="pdf-reader-page">第 {pageIndex + 1} / {pageCount || 1} 页</span>
            <button className="pdf-reader-btn" onClick={() => setPageIndex((p) => Math.min(Math.max(pageCount - 1, 0), p + 1))} disabled={pageIndex >= pageCount - 1}>›</button>
          </div>
          <div className="pdf-reader-zoom">
            <button className="pdf-reader-btn" onClick={() => setScale((s) => Math.max(0.5, +(s - 0.2).toFixed(2)))}>−</button>
            <span className="pdf-reader-pct">{Math.round(scale * 100)}%</span>
            <button className="pdf-reader-btn" onClick={() => setScale((s) => Math.min(3, +(s + 0.2).toFixed(2)))}>＋</button>
          </div>
          <button className="pdf-reader-close" onClick={close} title="关闭">×</button>
        </div>
        <div className="pdf-reader-body">
          {meta ? (
            <PdfAnnotationCanvas
              attachmentId={attachmentId ?? ""}
              pageIndex={pageIndex}
              pageW={meta.w}
              pageH={meta.h}
              pageImageUrl={pageUrl}
              hasTextLayer={meta.hasTextLayer}
              textItems={textItems}
            />
          ) : (
            <div className="pdf-reader-loading">加载中…</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
