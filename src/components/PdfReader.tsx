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
  const engRef = useRef<ReturnType<typeof createPdfjsEngine> | null>(null);
  const closeRef = useRef<(() => void) | null>(null);
  const urlRef = useRef<string | null>(null);

  // Load the document once per (open, bytes).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      closeRef.current?.();
      closeRef.current = null;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
      const eng = createPdfjsEngine();
      engRef.current = eng;
      if (!bytes) return;
      try {
        const doc = await eng.loadPdf(bytes);
        if (alive) {
          closeRef.current = doc.close;
          setPageCount(doc.pageCount);
          setPageIndex(Math.min(Math.max(targetPage, 0), Math.max(doc.pageCount - 1, 0)));
          setMeta(null);
          setPageUrl(null);
        }
      } catch {
        if (alive) setPageCount(0);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, bytes]);

  // Render the current page + meta.
  useEffect(() => {
    if (!open) return;
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
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setPageUrl(url);
      } catch {
        if (alive) setPageUrl(null);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pageIndex, scale]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

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
