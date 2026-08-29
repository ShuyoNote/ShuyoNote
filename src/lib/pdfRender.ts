// M24 阶段 1 — PDF 渲染双引擎接口. `pdfRender.ts` exposes the contract + the
// pure engine-selection logic only; the concrete native (Rust) / pdf.js (Worker)
// engines are wired behind a `platform` driver later. Pure + dependency-light so
// the smoke harness can assert on it directly.

export type PdfRenderEngine = "native" | "pdfjs";

export interface PdfRenderCapabilities {
  /** Rust native render available (desktop driver). */
  native: boolean;
  /** pdf.js available (browser / fallback). */
  pdfjs: boolean;
}

export const PDF_RENDER_ENGINES: PdfRenderEngine[] = ["native", "pdfjs"];

/** Pick the render engine: desktop native when available, else pdf.js fallback. */
export function pickEngine(caps: PdfRenderCapabilities): PdfRenderEngine {
  return caps.native ? "native" : "pdfjs";
}

/** pdf.js should run in a worker + virtualize pages (the JS interpreter is slow). */
export function wantsWorker(engine: PdfRenderEngine, pageBytes: number): boolean {
  return engine === "pdfjs" && pageBytes > 0;
}

export interface PdfPageMeta {
  index: number;
  width: number;
  height: number;
  hasTextLayer: boolean;
}

export interface OutlineItem {
  title: string;
  pageIndex: number;
  children: OutlineItem[];
}

export interface PdfDocumentMeta {
  pageCount: number;
  outline: OutlineItem[];
  close: () => void;
}

/** The contract both engines satisfy — frontend never sees the engine difference. */
export interface PdfRenderEngineApi {
  loadPdf: (data: Uint8Array) => Promise<PdfDocumentMeta>;
  getPageMeta: (pageIndex: number) => Promise<PdfPageMeta>;
  getPageTextItems: (pageIndex: number) => Promise<{ str: string; transform: number[] | null; width: number; height: number }[]>;
  /** Extra: extract a page's plain text (strings only, no coords) — used by
   *  「对整篇 PDF 提问」 to rank relevant pages cheaply. Optional: not all engines
   *  provide it; callers guard with `?.` and fall back to getPageTextItems. */
  getPageText?: (pageIndex: number) => Promise<string>;
  renderPageToBlob: (pageIndex: number, scale: number) => Promise<Blob>;
}
