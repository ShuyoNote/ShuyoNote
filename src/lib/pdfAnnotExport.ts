// M24 落地 —「导出带批注副本」：把 PDF 的每一页绘制为「原页面图像 + 该页批注
// overlay」的单张位图，再用 pdf-lib 合成一个新 PDF（不动源文件）。这样导出的
// 副本保留了高亮 / 画笔 / 便签 / 矩形 / 下划线的视觉，但文本层会退化为图像。
//
// 只在浏览器使用（依赖 canvas + pdf-lib），Node smoke 不测此文件；核心的坐标
// 转换 `annPxBox` 在 ./pdfAnnotation.ts（纯函数，可被 smoke 断言）。

import type { PdfAnnotation } from "./pdfAnnotation";
import { annPxBox } from "./pdfAnnotation";
import { PDFDocument } from "pdf-lib";

const INK_COLOR = "rgba(51,112,255,0.85)";
const HIGHLIGHT_COLOR = "rgba(255, 214, 0, 0.35)";
const STICKY_FILL = "#ffd873";
const STICKY_STROKE = "#e3b94a";
const STICKY_FOLD = "#ecc253";

/** Paint a single annotation onto a 2D canvas ctx at page pixel size (W×H). */
export function drawAnnotation(ctx: CanvasRenderingContext2D, ann: PdfAnnotation, W: number, H: number): void {
  const box = annPxBox(ann, W, H);
  if (!box) return;
  const [x, y, w, h] = box;

  if (ann.type === "ink" && ann.points && ann.points.length >= 2) {
    ctx.strokeStyle = INK_COLOR;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ann.points.forEach(([nx, ny], i) => {
      const px = nx * W;
      const py = ny * H;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  } else if (ann.type === "highlight") {
    ctx.fillStyle = HIGHLIGHT_COLOR;
    ctx.fillRect(x, y, w, h);
  } else if (ann.type === "rect") {
    ctx.strokeStyle = INK_COLOR;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);
  } else if (ann.type === "underline") {
    ctx.strokeStyle = INK_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.stroke();
  } else if (ann.type === "sticky") {
    ctx.fillStyle = STICKY_FILL;
    ctx.strokeStyle = STICKY_STROKE;
    ctx.lineWidth = 1;
    const fold = Math.min(6, w / 4);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    // Folded corner (top-right), matching the on-screen sticky glyph.
    ctx.fillStyle = STICKY_FOLD;
    ctx.beginPath();
    ctx.moveTo(x + w - fold, y);
    ctx.lineTo(x + w, y + fold);
    ctx.lineTo(x + w - fold, y + fold);
    ctx.closePath();
    ctx.fill();
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load page image"));
    img.src = url;
  });
}

/**
 * Composite a page: draw the source page image onto a canvas, then paint this
 * page's annotations on top. Returns the canvas, its pixel size and a PNG Blob
 * (the page is rasterized, so text later becomes an image).
 */
export async function renderPageWithAnnotations(
  pageBlob: Blob,
  fallbackW: number,
  fallbackH: number,
  annotations: PdfAnnotation[],
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number; blob: Blob }> {
  const url = URL.createObjectURL(pageBlob);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth || fallbackW || 1;
    const h = img.naturalHeight || fallbackH || 1;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("failed to create 2D context");
    ctx.drawImage(img, 0, 0, w, h);
    for (const a of annotations) drawAnnotation(ctx, a, w, h);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob failed"))), "image/png"),
    );
    return { canvas, width: w, height: h, blob };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Options for a full-PDF export. */
export interface ExportPdfOptions {
  pageCount: number;
  /** Render the source page to a Blob (any engine). */
  renderPage: (pageIndex: number) => Promise<{ blob: Blob; width: number; height: number }>;
  /** Return this page's annotations (from the persisted store). */
  getAnnotations: (pageIndex: number) => Promise<PdfAnnotation[]>;
}

/**
 * Export a "copy with annotations": for every page, compose the source image +
 * annotations into a bitmap, then assemble a new PDF via pdf-lib. The source PDF
 * is never modified. Returns the generated PDF as a Blob.
 */
export async function exportPdfWithAnnotations(opts: ExportPdfOptions): Promise<Blob> {
  const doc = await PDFDocument.create();
  doc.setTitle("ShuyoNote — annotated copy");
  for (let i = 0; i < opts.pageCount; i++) {
    const { blob, width, height } = await opts.renderPage(i);
    const annotations = await opts.getAnnotations(i);
    const { blob: composite, width: cw, height: ch } = await renderPageWithAnnotations(blob, width, height, annotations);
    const bytes = new Uint8Array(await composite.arrayBuffer());
    const img = await doc.embedPng(bytes);
    const page = doc.addPage([cw, ch]);
    page.drawImage(img, { x: 0, y: 0, width: cw, height: ch });
  }
  const bytes = (await doc.save()) as Uint8Array<ArrayBuffer>;
  return new Blob([bytes], { type: "application/pdf" });
}
