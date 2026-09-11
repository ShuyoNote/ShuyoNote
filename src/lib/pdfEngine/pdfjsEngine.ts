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
/**
 * `canvas.toBlob` 的回退版本。
 *
 * 为什么需要回退：`toBlob` 在个别 WebView / 画布尺寸下会**静默给出 null**
 * （WKWebView 的画布内存限制是常见成因），于是页面图像永远出不来，而调用方只看到
 * "一片空白"。`toDataURL` 的路径更老也更普遍可用，所以这里在 `toBlob` 失败时改走它
 * ——多一步编码，换的是"能看见"。
 */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) return resolve(blob);
      try {
        const dataUrl = canvas.toDataURL("image/png");
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve(new Blob([bytes], { type: "image/png" }));
      } catch (e) {
        reject(new Error(`页面图像导出失败：${e instanceof Error ? e.message : String(e)}`));
      }
    }, "image/png");
  });
}

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
      // 倍率必须在碰画布之前校验：非有限值会让 vp.width/height 变成 NaN，而
      // `canvas.width = NaN` / `createImageData(NaN, NaN)` 在 WKWebView 上抛
      // "Value NaN is outside the range [-2147483648, 2147483647]"，
      // 在 Chrome 上则是静默的 0×0（用户看到的"一片空白"）。宁可在这一层报一句
      // 看得懂的话，也不要让 NaN 流到画布 API 上。
      if (!Number.isFinite(scale) || scale <= 0) {
        throw new Error(`页面缩放倍率无效（scale=${String(scale)}）`);
      }
      const d = expectDoc();
      const p = await d.getPage(pageIndex + 1);
      const vp = p.getViewport({ scale });
      const width = Math.ceil(vp.width);
      const height = Math.ceil(vp.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error(`页面尺寸无效（${vp.width}×${vp.height}，scale=${scale}）`);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("无法创建 2D 上下文");
      await p.render({ canvasContext: ctx, viewport: vp }).promise;
      return canvasToPngBlob(canvas);
    },
  };
}
