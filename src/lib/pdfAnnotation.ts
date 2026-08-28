// M24 阶段 1 — PDF 批注纯函数层. Pure + dependency-light so the smoke harness can
// bundle and assert on it directly (no pdf.js / Rust / canvas needed). The actual
// render engine (native vs pdf.js worker) and the UI overlay live elsewhere.
//
// Coordinate model: every annotation is stored normalized to [0,1] in the page's
// pixel space, so it stays anchored to the page regardless of zoom / viewport.

export type AnnotationType = "highlight" | "underline" | "ink" | "sticky" | "rect";

export interface PdfAnnotation {
  id: string;
  type: AnnotationType;
  /** Normalized [x0, y0, x1, y1] box (0..1) — used by highlight/underline/rect. */
  box?: [number, number, number, number] | null;
  /** Normalized polyline points — used by ink (drawing). */
  points?: [number, number][] | null;
  /** Sticky note body / excerpt text. */
  text?: string;
  color?: string;
  createdAt?: number;
}

export interface PdfAnnotationDoc {
  pageIndex: number;
  /** Per-page annotations, in insertion order. */
  annotations: PdfAnnotation[];
}

const validTypes: AnnotationType[] = ["highlight", "underline", "ink", "sticky", "rect"];

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

/** Normalize a pixel-space rect into a [0,1] box, clamped and ordered. */
export function normCoords(x0: number, y0: number, x1: number, y1: number, pageW: number, pageH: number): [number, number, number, number] {
  const pageWn = pageW > 0 ? pageW : 1;
  const pageHn = pageH > 0 ? pageH : 1;
  let a = clamp01(x0 / pageWn);
  let b = clamp01(y0 / pageHn);
  let c = clamp01(x1 / pageWn);
  let d = clamp01(y1 / pageHn);
  if (a > c) [a, c] = [c, a];
  if (b > d) [b, d] = [d, b];
  return [a, b, c, d];
}

/** Reverse a [0,1] box back to pixel coordinates (for the overlay canvas). */
export function denormCoords(box: [number, number, number, number], pageW: number, pageH: number): [number, number, number, number] {
  const [a, b, c, d] = box;
  return [a * pageW, b * pageH, c * pageW, d * pageH];
}

/** Schema-validate a single annotation (type-specific requirements). */
export function validateAnnotation(ann: PdfAnnotation): boolean {
  if (!ann || typeof ann.id !== "string" || ann.id.length === 0) return false;
  if (!validTypes.includes(ann.type)) return false;
  if (ann.type === "ink") {
    if (!Array.isArray(ann.points)) return false;
  } else if (ann.type === "sticky") {
    // sticky needs text (or a box); allow either so a blank note is not silently dropped.
    if (typeof ann.text !== "string" && !Array.isArray(ann.box)) return false;
  } else {
    // highlight / underline / rect need a box.
    if (!Array.isArray(ann.box) || ann.box.length !== 4) return false;
  }
  return true;
}

/** Append an annotation, or replace in place if id already exists. */
export function addAnnotation(doc: PdfAnnotationDoc, ann: PdfAnnotation): PdfAnnotationDoc {
  const idx = doc.annotations.findIndex((a) => a.id === ann.id);
  const annotations = idx >= 0 ? doc.annotations.map((a, i) => (i === idx ? ann : a)) : [...doc.annotations, ann];
  return { ...doc, annotations };
}

/** Remove an annotation by id. */
export function removeAnnotation(doc: PdfAnnotationDoc, id: string): PdfAnnotationDoc {
  return { ...doc, annotations: doc.annotations.filter((a) => a.id !== id) };
}

/** Replace an existing annotation by id; no-op if not found. */
export function updateAnnotation(doc: PdfAnnotationDoc, ann: PdfAnnotation): PdfAnnotationDoc {
  const idx = doc.annotations.findIndex((a) => a.id === ann.id);
  if (idx < 0) return doc;
  return { ...doc, annotations: doc.annotations.map((a, i) => (i === idx ? ann : a)) };
}

/**
 * Text-layer degrade strategy: when a page has a usable text layer we allow
 * text-level highlight/underline; otherwise we fall back to rect + ink + sticky
 * (rect doesn't depend on the text layer, so it's the stable baseline).
 */
export function annotationMode(hasTextLayer: boolean): "text" | "rect" {
  return hasTextLayer ? "text" : "rect";
}

/** Stable back-ref string for an excerpt turned into a block. */
export function pdfRef(attachmentId: string, pageIndex: number): string {
  return `pdf://${attachmentId}#${pageIndex}`;
}

/** Parse a `pdf://attachment#page` ref back into its parts (for reopening). */
export function parsePdfRef(ref: string): { attachmentId: string; pageIndex: number } | null {
  const m = /^pdf:\/\/(.+)#(\d+)$/.exec(ref);
  if (!m) return null;
  return { attachmentId: m[1], pageIndex: Number(m[2]) };
}

/** Turn a "摘录" annotation into an insertable block (with a pdf:// back-ref). */
export function pageToBlock(
  ann: Pick<PdfAnnotation, "text">,
  attachmentId: string,
  pageIndex: number,
): { ref: string; content_json: string; content_text: string } {
  const ref = pdfRef(attachmentId, pageIndex);
  const excerpt = (ann.text ?? "").trim();
  const label = ["摘录", excerpt].filter(Boolean).join(" ");
  const content_json = JSON.stringify({
    root: {
      type: "root",
      version: 1,
      direction: "ltr",
      format: "",
      indent: 0,
      children: [
        {
          type: "paragraph",
          version: 1,
          direction: "ltr",
          format: "",
          indent: 0,
          style: "",
          children: [
            { type: "text", text: label ? `${label} ` : "", version: 1 },
            { type: "pdfref", attachmentId, pageIndex, text: ref, version: 1 },
          ],
        },
      ],
    },
  });
  return { ref, content_json, content_text: [label, ref].filter(Boolean).join(" ") };
}
