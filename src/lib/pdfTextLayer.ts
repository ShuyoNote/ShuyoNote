// M24 — 文本层精确划词. Snap a freehand highlight (drag box) to the actual
// text-item bounding boxes from pdf.js `getTextContent()`, so text-layer PDFs
// get accurate highlights. Pure + dependency-light (imports only normCoords) so
// the smoke harness can assert on it.
import { normCoords } from "./pdfAnnotation";

export interface TextItemLike {
  str?: string;
  transform?: number[] | null;
  width?: number;
  height?: number;
}

/** Approximate a pdf.js text item's page box (scale-1 page coords). */
export function textItemBox(item: TextItemLike): [number, number, number, number] | null {
  const t = item.transform;
  if (!t || t.length < 6) return null;
  const x = Number(t[4] ?? 0);
  const y = Number(t[5] ?? 0);
  const w = Number(item.width ?? 0);
  const h = Number(item.height ?? 0);
  return [x, y, x + w, y + h];
}

function intersects(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

/**
 * Snap a drag box (page coords) to the union of the text-item boxes it overlaps.
 * Returns a normalized [0,1] box, or null when nothing overlapped (caller falls
 * back to the raw drag box).
 */
export function snapHighlightToText(
  dragBox: [number, number, number, number],
  items: TextItemLike[],
  pageW: number,
  pageH: number,
): [number, number, number, number] | null {
  let union: [number, number, number, number] | null = null;
  for (const item of items) {
    const box = textItemBox(item);
    if (!box || !intersects(box, dragBox)) continue;
    if (!union) union = [box[0], box[1], box[2], box[3]];
    else union = [
      Math.min(union[0], box[0]),
      Math.min(union[1], box[1]),
      Math.max(union[2], box[2]),
      Math.max(union[3], box[3]),
    ];
  }
  if (!union) return null;
  return normCoords(union[0], union[1], union[2], union[3], pageW, pageH);
}
