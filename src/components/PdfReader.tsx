import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePdfReader } from "../store/pdfReader";
import { createPdfjsEngine } from "../lib/pdfEngine/pdfjsEngine";
import { PdfAnnotationCanvas } from "./PdfAnnotationCanvas";

// M24 — PDF reader modal. Loads the PDF bytes via the pdf.js engine, renders the
// current page to a blob (object URL), and hosts the annotation canvas. Page nav
// + zoom re-render the page; annotations are persisted per (attachment, page).
export function PdfReader() {
  const { open, attachmentId, name, bytes, targetPage, close } = usePdfReader();
  const [pageCount, setPageCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [scale, setScale] = useState(1);
  const [meta, setMeta] = useState<{ w: number; h: number; hasTextLayer: boolean } | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const engRef = useRef<ReturnType<typeof createPdfjsEngine> | null>(null);
  const closeRef = useRef<(() => void) | null>(null);
  // Keep every created page blob URL until the reader closes — revoking a URL
  // while its <img> is still loading causes ERR_FILE_NOT_FOUND.
  const urlsRef = useRef<string[]>([]);

  const freeUrls = () => {
    for (const u of urlsRef.current) URL.revokeObjectURL(u);
    urlsRef.current = [];
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
        const blob = await eng.renderPageToBlob(pageIndex, scale);
        if (!alive) return;
        const url = URL.createObjectURL(blob);
        urlsRef.current.push(url);
        setPageUrl(url);
      } catch {
        if (alive) setPageUrl(null);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready, pageIndex, scale]);

  // Free page blob URLs when the reader closes or unmounts.
  useEffect(() => {
    if (!open) freeUrls();
  }, [open]);

  useEffect(() => () => freeUrls(), []);

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
