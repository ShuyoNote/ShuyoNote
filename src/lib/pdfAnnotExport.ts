// M24 落地 —「导出带批注副本」：把 PDF 的每一页绘制为「原页面图像 + 该页批注
// overlay」的单张位图，再用 pdf-lib 合成一个新 PDF（不动源文件）。副本保留高亮 / 画笔 /
// 便签 / 矩形 / 下划线的视觉，但文本层退化为图像。
//
// 只在浏览器使用（依赖 canvas + pdf-lib）。PDFDocument 在该模块内静态导入，但调用方
// （PdfReader）通过 `await import(...)` 懒加载本模块，所以 pdf-lib 不进入主 chunk。
// 核心坐标转换 `annPxBox` 在 ./pdfAnnotation.ts（纯函数，可被 smoke/vitest 断言）；
// 本模块的 `drawAnnotation` 不使用 pdf-lib，便于将来用 stub context 做单测。

import type { PdfAnnotation } from "./pdfAnnotation";
import { annPxBox } from "./pdfAnnotation";
import { PDFDocument } from "pdf-lib";

const INK_COLOR = "rgba(51,112,255,0.85)";
const HIGHLIGHT_COLOR = "rgba(255, 214, 0, 0.35)";
const STICKY_FILL = "#ffd873";
const STICKY_STROKE = "#e3b94a";
const STICKY_FOLD = "#ecc253";
const STICKY_BUBBLE_FILL = "#fffbe6";
const STICKY_TEXT = "#333333";

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
    // Sticky body text (the on-screen sticky shows it in an HTML bubble; here we
    // rasterize it next to the marker so the exported copy keeps the note).
    const text = (ann.text ?? "").trim();
    if (text) drawStickyBubble(ctx, text, x + w + 6, y, W, H);
  }
}

/** Rasterize a sticky note's body next to its marker as a rounded text bubble. */
function drawStickyBubble(ctx: CanvasRenderingContext2D, text: string, bx: number, by: number, W: number, H: number): void {
  const bw = Math.min(220, Math.max(120, W * 0.2));
  ctx.font = "12px sans-serif";
  const lines = wrapText(ctx, text, bw - 16);
  const bh = lines.length * 16 + 12;
  // Clamp the bubble inside the page, flipping to the left if it would overflow.
  const pad = 4;
  let px = bx;
  let py = by;
  if (px + bw > W - pad) px = bx - bw - 12; // flip to the left of the marker
  py = Math.max(pad, Math.min(py, H - bh - pad));
  if (px < pad) px = pad;
  if (px + bw > W - pad) px = W - bw - pad;
  ctx.fillStyle = STICKY_BUBBLE_FILL;
  ctx.strokeStyle = STICKY_STROKE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  roundRectPath(ctx, px, py, bw, bh, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = STICKY_TEXT;
  ctx.textBaseline = "top";
  lines.forEach((line, i) => ctx.fillText(line, px + 8, py + 6 + i * 16));
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const wd of words) {
    const probe = cur ? `${cur} ${wd}` : wd;
    if (ctx.measureText(probe).width <= maxW || !cur) {
      cur = probe;
    } else {
      lines.push(cur);
      cur = wd;
    }
  }
  if (cur) lines.push(cur);
  // Hard-break very long tokens (e.g. a long URL) so nothing overflows.
  return lines.flatMap((line) => {
    const out: string[] = [];
    let remaining = line;
    while (ctx.measureText(remaining).width > maxW && remaining.length > 1) {
      let cut = remaining.length;
      while (cut > 1 && ctx.measureText(remaining.slice(0, cut)).width > maxW) cut--;
      out.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
    if (remaining) out.push(remaining);
    return out;
  });
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
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
 * page's annotations on top. Rasterizes to JPEG (pdf-lib passes the DCT stream
 * through without re-encoding, so scans stay small). Returns only the Blob and
 * its pixel size, and frees the canvas.
 */
export async function composePageWithAnnotations(
  pageBlob: Blob,
  annotations: PdfAnnotation[],
): Promise<{ blob: Blob; width: number; height: number }> {
  const url = URL.createObjectURL(pageBlob);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth || 1;
    const h = img.naturalHeight || 1;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("failed to create 2D context");
    ctx.drawImage(img, 0, 0, w, h);
    for (const a of annotations) drawAnnotation(ctx, a, w, h);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob failed"))), "image/jpeg", 0.95),
    );
    // Release the backing store so large scanned pages don't accumulate.
    canvas.width = 0;
    canvas.height = 0;
    return { blob, width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Options for a full-PDF export. */
export interface ExportPdfOptions {
  pageCount: number;
  /** Per-page PDF-point size (from the engine's getPageMeta). */
  getPageBox: (pageIndex: number) => Promise<{ w: number; h: number }>;
  /** Rasterize a page at the given scale (any engine). */
  renderPage: (pageIndex: number, scale: number) => Promise<Blob>;
  /** This page's annotations (synchronously from a pre-fetched map). */
  getAnnotations: (pageIndex: number) => PdfAnnotation[];
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

const EXPORT_SCALE = 3;
const MAX_PAGE_PX = 12_000_000;

/**
 * Export a "copy with annotations". The PDF page box is the engine's PDF-point
 * size (so printed/on-screen dimensions match the source), while each page is
 * rasterized at a scale clamped so the bitmap doesn't blow up memory. Yields to
 * the event loop between pages (so a 60-page scan doesn't freeze the UI) and
 * supports cancellation. Source PDF is never modified.
 */
export async function exportPdfWithAnnotations(opts: ExportPdfOptions): Promise<Blob> {
  const doc = await PDFDocument.create();
  doc.setTitle("ShuyoNote — annotated copy");
  for (let i = 0; i < opts.pageCount; i++) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const box = await opts.getPageBox(i);
    const pw = Math.max(1, box.w || 1);
    const ph = Math.max(1, box.h || 1);
    const scale = Math.min(EXPORT_SCALE, Math.sqrt(MAX_PAGE_PX / (pw * ph)));
    const pageBlob = await opts.renderPage(i, scale);
    const { blob } = await composePageWithAnnotations(pageBlob, opts.getAnnotations(i));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const img = await doc.embedJpg(bytes);
    const page = doc.addPage([pw, ph]);
    page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
    opts.onProgress?.(i + 1, opts.pageCount);
    if (i < opts.pageCount - 1) await new Promise((r) => setTimeout(r, 0));
  }
  const bytes = (await doc.save()) as Uint8Array<ArrayBuffer>;
  return new Blob([bytes], { type: "application/pdf" });
}
