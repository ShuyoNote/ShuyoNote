import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  fitScaleForWidth,
  resolveZoomScale,
  stepZoom,
  zoomContentWidth,
  zoomLabel,
  zoomPct,
  type ZoomMode,
} from "./pdfLayout";

describe("fitScaleForWidth", () => {
  it("computes the fit scale", () => {
    expect(fitScaleForWidth(100, 200)).toBe(2);
    expect(fitScaleForWidth(200, 100)).toBe(0.5);
  });

  it("clamps to [MIN, MAX]", () => {
    expect(fitScaleForWidth(100, 1000)).toBe(MAX_SCALE);
    expect(fitScaleForWidth(1000, 10)).toBe(MIN_SCALE);
  });

  it("guards zero/negative inputs", () => {
    expect(fitScaleForWidth(0, 200)).toBe(1);
    expect(fitScaleForWidth(100, 0)).toBe(1);
  });
});

describe("zoomContentWidth", () => {
  it("scales the reference width and floors at 40", () => {
    expect(zoomContentWidth(100, 1.5)).toBe(150);
    expect(zoomContentWidth(1, 1)).toBe(40);
  });
});

describe("resolveZoomScale", () => {
  it("fit-width uses available width", () => {
    const z: ZoomMode = { mode: "fit-width" };
    expect(resolveZoomScale(z, 100, 100, 200, 100)).toBe(2);
  });

  it("fit-page takes the smaller of width/height ratios", () => {
    const z: ZoomMode = { mode: "fit-page" };
    // avail 200x50, page 100x100 → min(2, 0.5) = 0.5
    expect(resolveZoomScale(z, 100, 100, 200, 50)).toBe(0.5);
  });

  it("fit-content zooms slightly larger than fit-page", () => {
    const z: ZoomMode = { mode: "fit-content" };
    const fitPage = resolveZoomScale({ mode: "fit-page" }, 100, 100, 200, 100);
    const fitContent = resolveZoomScale(z, 100, 100, 200, 100);
    expect(fitContent).toBeGreaterThan(fitPage);
  });

  it("actual is scale 1", () => {
    expect(resolveZoomScale({ mode: "actual" }, 100, 100, 200, 100)).toBe(1);
  });

  it("pct mode divides by 100 and clamps", () => {
    expect(resolveZoomScale({ mode: "pct", pct: 150 }, 100, 100, 200, 100)).toBe(1.5);
    expect(resolveZoomScale({ mode: "pct", pct: 1000 }, 100, 100, 200, 100)).toBe(MAX_SCALE);
  });
});

describe("zoomPct / zoomLabel / stepZoom", () => {
  it("zoomPct converts scale to percentage", () => {
    expect(zoomPct(1.5)).toBe(150);
    expect(zoomPct(1)).toBe(100);
  });

  it("zoomLabel maps modes", () => {
    expect(zoomLabel({ mode: "actual" })).toBe("实际大小");
    expect(zoomLabel({ mode: "fit-width" })).toBe("适合宽度");
    expect(zoomLabel({ mode: "pct", pct: 150 })).toBe("150%");
  });

  it("stepZoom walks the ladder (dir +1 zooms in, -1 out)", () => {
    expect(stepZoom(1, 1)).toEqual({ mode: "pct", pct: 125 });   // 100 → 125
    expect(stepZoom(1, -1)).toEqual({ mode: "pct", pct: 75 });   // 100 → 75
  });
});
