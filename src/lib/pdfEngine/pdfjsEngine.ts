// M24 — pdf.js render engine (browser). Implements the `PdfRenderEngineApi`
// contract from `../pdfRender` using PDF.js. The page rasterization uses a
// `<canvas>` (browser-only); PDF parsing + text-layer detection work anywhere
// pdf.js runs. The desktop/native engine lives behind a platform driver later.
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from "pdfjs-dist";
import type { PdfRenderEngineApi, PdfDocumentMeta, PdfPageMeta, OutlineItem } from "../pdfRender";
import { APP_VERSION } from "../links";

let workerReady = false;

function ensureWorker(): void {
  if (workerReady) return;
  workerReady = true;
  if (typeof document !== "undefined") {
    // Vite rewrites this to a bundled asset URL. Append the app version as a
    // cache-buster: the file name is content-hashed + served `immutable`, so a
    // worker that had a stale MIME/response cached would otherwise be reused
    // forever. Bumping the version changes the URL → browsers re-fetch it.
    const worker = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;
    pdfjs.GlobalWorkerOptions.workerSrc = `${worker}?v=${encodeURIComponent(APP_VERSION)}`;
  }
}

/** Resolve an outline destination (array / named-string) to a 0-based page index.
 *  pdf.js `dest[0]` is often a `Ref` object (not a bare number), so we must pass
 *  it to `doc.getPageIndex(ref)` to get the real page number. */
async function destPageIndex(doc: PDFDocumentProxy, dest: unknown): Promise<number> {
  if (!dest) return 0;
  // Named destination (string) → resolve to an array first.
  let d = dest;
  if (typeof dest === "string") {
    try {
      const resolved = await doc.getDestination(dest);
      if (Array.isArray(resolved)) d = resolved;
    } catch {
      return 0;
    }
  }
  if (!Array.isArray(d) || d.length === 0) return 0;
  const first = d[0];
  if (typeof first === "number") return first;
  // `first` is a Ref ({num, gen}) — convert to page index.
  if (first && typeof first === "object" && "num" in first) {
    try {
      const idx = await doc.getPageIndex(first as any);
      return typeof idx === "number" ? idx : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

async function toOutline(doc: PDFDocumentProxy, nodes: unknown[] | null | undefined): Promise<OutlineItem[]> {
  if (!Array.isArray(nodes)) return [];
  const out: OutlineItem[] = [];
  for (const n of nodes) {
    if (!n) continue;
    const item = n as { title?: string; dest?: unknown; items?: unknown[] };
    const pageIndex = await destPageIndex(doc, item.dest);
    const children = await toOutline(doc, item.items);
    out.push({ title: typeof item.title === "string" ? item.title : "", pageIndex, children });
  }
  return out;
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
        // Relative (not "/pdfjs/..."): the web app is served under a sub-path
        // (e.g. /app/), so an absolute URL would resolve to the domain root and
        // 404, and pdf.js would parse the returned HTML as a cmap → "Cannot
        // convert object to primitive value". Relative paths resolve under the
        // app root (document.baseURI), matching the other bundled assets.
        cMapUrl: "pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "pdfjs/standard_fonts/",
      });
      doc = await task.promise;
      let outline: OutlineItem[] = [];
      try {
        outline = doc.getOutline ? await toOutline(doc, await doc.getOutline()) : [];
      } catch {
        outline = [];
      }
      return { pageCount: doc.numPages, outline, close: () => { void task?.destroy(); task = null; doc = null; } };
    },

    async getPageMeta(pageIndex: number): Promise<PdfPageMeta> {
      const d = expectDoc();
      const p = await d.getPage(pageIndex + 1);
      const vp = p.getViewport({ scale: 1 });
      // 不在此做 getTextContent()（慢）：hasTextLayer 由 getPageTextItems 推导，
      // 让页面图像/宽高秒出，不阻塞首屏。
      return { index: pageIndex, width: vp.width, height: vp.height, hasTextLayer: false };
    },

    async getPageTextItems(pageIndex: number): Promise<{ str: string; transform: number[] | null; width: number; height: number }[]> {
      const d = expectDoc();
      const p = await d.getPage(pageIndex + 1);
      try {
        const tc = await p.getTextContent();
        return (tc.items ?? []).map((it: any) => ({
          str: String(it.str ?? ""),
          transform: Array.isArray(it.transform) ? Array.from(it.transform as number[]) : null,
          width: Number(it.width ?? 0),
          height: Number(it.height ?? 0),
        }));
      } catch {
        return [];
      }
    },

    async getPageText(pageIndex: number): Promise<string> {
      const d = expectDoc();
      const p = await d.getPage(pageIndex + 1);
      try {
        const tc = await p.getTextContent();
        return (tc.items ?? [])
          .map((it: any) => String(it.str ?? ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      } catch {
        return "";
      }
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
