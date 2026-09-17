// 把 pdf.js 的一页渲染成**紧凑 RGBA8**（Web 平台层 `renderPdfPage` 的核）。
//
// 为什么单独成一个模块（而不是留在 `platform/web.ts` 里）：
//   · 留在那个工厂函数里 ⇒ **只有端到端跑整个 Web 应用才能验它**（要 DB、要附件、要 sql.js）；
//   · 抽出来之后，`scripts/check-pdf-raster-web.mjs` 可以在**真 Chromium** 里直接 import 这个模块跑，
//     验的是**真正发货的那段代码**，而不是"操作序列相同的一份复制品"。
//
// 形状与桌面端**完全一致**（`PdfRenderedPage`）：`bytes` 是 RGBA8、长度必须等于 `width*height*4` ——
// 阅读器会再挡这道（`renderPageNative` 里那句），所以这里不能制造"看起来对"的返回值。
//
// 三个坑写在这里，都是实测的：
//   ① pdf.js 会 **transfer** 传进去的 buffer ⇒ 必须给副本（同一份字节第二次用会报 clone 错误）；
//   ② `workerSrc` 必须配（见 `pdfjsWorker.ts`），否则非浏览器环境直接 `Setting up fake worker failed`；
//   ③ 画布尺寸先 `Math.max(1, Math.ceil(...))`：scale 很小时 viewport 可能小于 1，
//      而 `getImageData(0,0,0,0)` 会抛 IndexSizeError。

import { ensurePdfjsWorkerSrc, type PdfjsLike } from "./pdfjsWorker";

/** pdf.js 里我们用得到的那一块（参数化：web.ts 走动态 import，检查脚本也自己 import）。 */
export interface PdfjsRenderLike extends PdfjsLike {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDocumentLike> };
}

interface PdfPageLike {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
}
interface PdfDocumentLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
  destroy(): Promise<void>;
}

/**
 * 渲染 `pageIndex`（**0 基**，与桌面端 `render_pdf_page` 同口径）为 RGBA8。
 *
 * @param opts.canvasFactory 仅用于测试/检查注入（默认 `document.createElement("canvas")`）
 */
export async function renderPdfjsPageToRgba(
  pdfjs: PdfjsRenderLike,
  bytes: Uint8Array,
  pageIndex: number,
  scale: number,
  opts: { canvasFactory?: () => HTMLCanvasElement } = {},
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  // 与桌面端同口径的先校验：NaN/Infinity 会让画布尺寸变 NaN ——
  // WKWebView 抛 "Value NaN is outside the range …"，Chrome 则静默画成 0×0。
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`PDF 渲染的缩放倍率无效（scale=${String(scale)}）`);
  }
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new Error(`PDF 页码无效（page_index=${String(pageIndex)}）`);
  }

  ensurePdfjsWorkerSrc(pdfjs);

  const doc = await pdfjs.getDocument({
    // 坑①：pdf.js 会接管这份 buffer ⇒ 给副本
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    isEvalSupported: false,
    cMapUrl: "pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "pdfjs/standard_fonts/",
  }).promise;

  try {
    const page = await doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale });
    // 坑③：至少 1 像素
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));

    const canvas = (opts.canvasFactory ?? (() => document.createElement("canvas")))();
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Web 的 2D 画布不可用，无法把 PDF 页渲染成像素");

    await page.render({ canvasContext: ctx, viewport }).promise;
    const img = ctx.getImageData(0, 0, width, height);
    const rgba = new Uint8Array(img.data.buffer.slice(0));
    if (rgba.length !== width * height * 4) {
      throw new Error(`渲染出的字节数对不上（${width}×${height} 应为 ${width * height * 4}，实际 ${rgba.length}）`);
    }
    return { bytes: rgba, width, height };
  } finally {
    await doc.destroy().catch(() => {});
  }
}
