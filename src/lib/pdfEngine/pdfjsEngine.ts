// M24 — pdf.js render engine (browser). Implements the `PdfRenderEngineApi`
// contract from `../pdfRender` using PDF.js. The page rasterization uses a
// `<canvas>` (browser-only); PDF parsing + text-layer detection work anywhere
// pdf.js runs. The desktop/native engine lives behind a platform driver later.
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from "pdfjs-dist";
import type { PdfRenderEngineApi, PdfDocumentMeta, PdfPageMeta, OutlineItem } from "../pdfRender";

let workerReady = false;

function ensureWorker(): void {
  if (workerReady) return;
  workerReady = true;
  if (typeof document !== "undefined") {
    // Vite rewrites this to a bundled asset URL.
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).href;
  }
}

function toOutline(nodes: unknown[] | null | undefined): OutlineItem[] {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter((n): n is { title?: string; dest?: unknown; items?: unknown[] } => !!n)
    .map((n) => ({
      title: typeof n.title === "string" ? n.title : "",
      pageIndex: Array.isArray(n.dest) && typeof n.dest[0] === "number" ? n.dest[0] : 0,
      children: toOutline(n.items),
    }));
}

/** Create a PDF.js-backed render engine (browser). */
export function createPdfjsEngine(): PdfRenderEngineApi {
  let doc: PDFDocumentProxy | null = null;
  let task: PDFDocumentLoadingTask | null = null;

  const expectDoc = (): PDFDocumentProxy => {
    if (!doc) throw new Error("PDF 尚未加载");
    return doc;
  };

  return {
    async loadPdf(data: Uint8Array): Promise<PdfDocumentMeta> {
      ensureWorker();
      task = pdfjs.getDocument({
        data,
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdfjs/standard_fonts/",
      });
      doc = await task.promise;
      let outline: OutlineItem[] = [];
      try {
        outline = doc.getOutline ? toOutline(await doc.getOutline()) : [];
      } catch {
        outline = [];
      }
      return { pageCount: doc.numPages, outline, close: () => { void task?.destroy(); task = null; doc = null; } };
    },

    async getPageMeta(pageIndex: number): Promise<PdfPageMeta> {
      const d = expectDoc();
      const p = await d.getPage(pageIndex + 1);
      const vp = p.getViewport({ scale: 1 });
      let hasTextLayer = false;
      try {
        const tc = await p.getTextContent();
        hasTextLayer = (tc.items?.length ?? 0) > 0;
      } catch {
        hasTextLayer = false;
      }
      return { index: pageIndex, width: vp.width, height: vp.height, hasTextLayer };
    },

    async renderPageToBlob(pageIndex: number, scale: number): Promise<Blob> {
      const d = expectDoc();
      const p = await d.getPage(pageIndex + 1);
      const vp = p.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("无法创建 2D 上下文");
      await p.render({ canvasContext: ctx, viewport: vp }).promise;
      return new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("导出页面失败"))), "image/png"),
      );
    },
  };
}
