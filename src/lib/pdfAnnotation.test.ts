import { describe, expect, it } from "vitest";
import {
  addAnnotation,
  annotationMode,
  denormCoords,
  normCoords,
  parsePdfRef,
  pdfRef,
  removeAnnotation,
  updateAnnotation,
  validateAnnotation,
  type PdfAnnotation,
  type PdfAnnotationDoc,
} from "./pdfAnnotation";

describe("normCoords / denormCoords", () => {
  it("normalizes to [0,1] and clamps", () => {
    expect(normCoords(0, 0, 100, 200, 100, 200)).toEqual([0, 0, 1, 1]);
    expect(normCoords(50, 100, 100, 200, 100, 200)).toEqual([0.5, 0.5, 1, 1]);
    // out-of-range clamps to [0,1]
    expect(normCoords(-10, -10, 110, 210, 100, 200)).toEqual([0, 0, 1, 1]);
  });

  it("orders reversed coordinates", () => {
    // drag right-to-left / bottom-to-top still yields x0<x1, y0<y1
    expect(normCoords(100, 200, 0, 0, 100, 200)).toEqual([0, 0, 1, 1]);
  });

  it("round-trips through denorm", () => {
    const box = normCoords(10, 20, 80, 160, 100, 200);
    expect(denormCoords(box, 100, 200)).toEqual([10, 20, 80, 160]);
  });

  it("guards zero page size", () => {
    expect(normCoords(0, 0, 100, 200, 0, 0)).toEqual([0, 0, 1, 1]);
  });
});

describe("validateAnnotation", () => {
  it("rejects missing id or unknown type", () => {
    expect(validateAnnotation({ id: "", type: "rect" })).toBe(false);
    expect(validateAnnotation({ id: "a", type: "nope" } as unknown as PdfAnnotation)).toBe(false);
  });

  it("requires a box for highlight/underline/rect", () => {
    expect(validateAnnotation({ id: "a", type: "highlight" })).toBe(false);
    expect(validateAnnotation({ id: "a", type: "highlight", box: [0, 0, 1, 1] })).toBe(true);
  });

  it("ink needs points; sticky needs text or box", () => {
    expect(validateAnnotation({ id: "a", type: "ink", points: [[0, 0], [1, 1]] })).toBe(true);
    expect(validateAnnotation({ id: "a", type: "ink" })).toBe(false);
    expect(validateAnnotation({ id: "a", type: "sticky", text: "hi" })).toBe(true);
    expect(validateAnnotation({ id: "a", type: "sticky" })).toBe(false);
  });
});

describe("annotation CRUD", () => {
  const doc: PdfAnnotationDoc = { pageIndex: 0, annotations: [] };
  const a: PdfAnnotation = { id: "a", type: "rect", box: [0, 0, 1, 1] };

  it("adds and replaces by id", () => {
    const d1 = addAnnotation(doc, a);
    expect(d1.annotations).toHaveLength(1);
    const d2 = addAnnotation(d1, { ...a, box: [0.5, 0.5, 1, 1] });
    expect(d2.annotations).toHaveLength(1);
    expect(d2.annotations[0].box).toEqual([0.5, 0.5, 1, 1]);
  });

  it("update is a no-op for unknown id", () => {
    expect(updateAnnotation(doc, a)).toBe(doc);
  });

  it("removes by id", () => {
    const d = addAnnotation(doc, a);
    expect(removeAnnotation(d, "a").annotations).toHaveLength(0);
  });
});

describe("pdfRef / parsePdfRef", () => {
  it("round-trips", () => {
    const ref = pdfRef("att-123", 4);
    expect(ref).toBe("pdf://att-123#4");
    expect(parsePdfRef(ref)).toEqual({ attachmentId: "att-123", pageIndex: 4 });
  });

  it("rejects malformed refs", () => {
    expect(parsePdfRef("not-a-ref")).toBeNull();
    expect(parsePdfRef("pdf://x#")).toBeNull();
    expect(parsePdfRef("pdf://x#abc")).toBeNull();
  });
});

describe("annotationMode", () => {
  it("text layer enables text mode; otherwise rect", () => {
    expect(annotationMode(true)).toBe("text");
    expect(annotationMode(false)).toBe("rect");
  });
});
