import { describe, expect, it } from "vitest";
import {
  A4_WIDTH_FALLBACK,
  MAX_SCALE,
  DISPLAY_PIXEL_BUDGET,
  displayRasterScale,
  MIN_SCALE,
  fitScaleForWidth,
  resolveZoomScale,
  stepZoom,
  zoomContentWidth,
  zoomLabel,
  zoomPct,
  ZOOM_LADDER,
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

  // 回归：NaN 宽度曾经变成 canvas 的 NaN 尺寸 ⇒ WKWebView 抛 RangeError、
  // Chrome 静默画成 0×0（用户看到的"一片空白"）。
  it("退化输入退回基准页宽，绝不返回 NaN", () => {
    expect(zoomContentWidth(NaN, 1)).toBe(A4_WIDTH_FALLBACK);
    expect(zoomContentWidth(600, NaN)).toBe(600);
    expect(zoomContentWidth(0, 2)).toBe(A4_WIDTH_FALLBACK);
    expect(zoomContentWidth(600, Infinity)).toBe(600);
    for (const w of [zoomContentWidth(NaN, NaN), zoomContentWidth(Infinity, 2), zoomContentWidth(-5, 1)]) {
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(40);
    }
  });
});

describe("resolveZoomScale", () => {
  it("fit-width uses available width", () => {
    const z: ZoomMode = { mode: "fit-width" };
    expect(resolveZoomScale(z, 100, 100, 200, 100)).toBe(2);
  });

  it("退化输入永远给有限倍率，绝不返回 NaN/Infinity", () => {
    const cases: [ZoomMode, number, number, number, number][] = [
      [{ mode: "fit-width" }, NaN, 100, 300, 400],
      [{ mode: "fit-width" }, 0, 100, 300, 400],
      [{ mode: "fit-page" }, 100, NaN, 300, 400],
      [{ mode: "fit-content" }, 100, 0, 300, 400],
      [{ mode: "pct", pct: NaN }, 100, 100, 300, 400],
      [{ mode: "pct", pct: 100 }, 100, 100, NaN, NaN],
      [{ mode: "fit-width" }, 100, 100, NaN, 400],
    ];
    for (const [z, w, h, aw, ah] of cases) {
      const s = resolveZoomScale(z, w, h, aw, ah);
      expect(Number.isFinite(s), `${JSON.stringify(z)} ref=${w}x${h} avail=${aw}x${ah} → ${s}`).toBe(true);
      expect(s).toBeGreaterThan(0);
    }
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

describe("2026-10-15：适配模式不许被下界夹住（owner：「为何不能缩小」）", () => {
  it("⭐ 宽图（2000×800）在 900×600 里 fit-page **必须真的放得下**（0.45，⛔ 不是 0.5）", () => {
    // 现场：一张超宽横向流程图，fit-page 算出来 0.45，却被 MIN_SCALE=0.5 夹住 ⇒ 屏幕上**看不全** ✓。
    const s = resolveZoomScale({ mode: "fit-page" }, 2000, 800, 900, 600);
    expect(s).toBeCloseTo(0.45, 3);
    // ⚠️ 判据要表达的是"**没被夹子动过**" ✓ —— 而不是"小于 MIN_SCALE" ✗：
    //   这一档 0.45 本来就**大于** MIN_SCALE(0.25) ✓，拿它去比下界是**我第一版写错了** ✓。
    expect(s, "⭐ 必须等于**原始比值** min(W/refW, H/refH) ⇒ 说明没被下界夹 ✓").toBeCloseTo(
      Math.min(900 / 2000, 600 / 800),
      3,
    );
  });

  it("⭐ 极端宽图（10000 宽）fit-page 可以**低于**手动下界（给多少就是多少）", () => {
    // ⚠️ 这一条才是"不夹下界"的**决定性**断言 ✓：结果 0.09 **低于** MIN_SCALE(0.25) ✓
    //   —— 旧口径下它会被夹成 0.5 ⇒ 屏幕上一张超宽图永远看不全 ✓。
    const s = resolveZoomScale({ mode: "fit-page" }, 10000, 800, 900, 600);
    expect(s).toBeCloseTo(0.09, 3);
    expect(s, "⭐ 适配模式允许低于手动百分比的下界 ✓（它的语义是\"放得下\" ✓）").toBeLessThan(MIN_SCALE);
  });

  it("⭐ fit-width / fit-content 同样不被下界夹（一张超宽页）", () => {
    const w = resolveZoomScale({ mode: "fit-width" }, 4000, 800, 900, 600);
    const c = resolveZoomScale({ mode: "fit-content" }, 4000, 800, 900, 600);
    expect(w).toBeCloseTo(0.225, 3);
    expect(c, "fit-content 忽略四周留白 ⇒ 应比 fit-width 略大 ✓").toBeGreaterThan(w);
  });

  it("⭐ 适配模式**仍然**夹上界（⛔ 不是把夹子整个删了 ✗）", () => {
    expect(resolveZoomScale({ mode: "fit-page" }, 100, 100, 4000, 4000)).toBe(MAX_SCALE);
  });

  it("⭐ 手动百分比：25% 现在**生效** ✓；10% 仍被夹到 MIN_SCALE ✓", () => {
    expect(resolveZoomScale({ mode: "pct", pct: 25 }, 612, 792, 900, 600)).toBe(0.25);
    expect(resolveZoomScale({ mode: "pct", pct: 10 }, 612, 792, 900, 600)).toBe(MIN_SCALE);
  });

  it("⭐ 阶梯到底后按「−」＝原地（边界如实，⛔ 不假装还能缩 ✗）", () => {
    expect(ZOOM_LADDER).toContain(33);
    expect(ZOOM_LADDER).toContain(25);
    expect(Math.min(...ZOOM_LADDER)).toBe(25);
    expect(stepZoom(0.25, -1)).toEqual({ mode: "pct", pct: 25 });
    expect(stepZoom(0.5, -1)).toEqual({ mode: "pct", pct: 33 });
  });
});

describe("2026-10-15：显示位图按像素预算削（owner 选「先 F 再 D」）", () => {
  it("⭐ 普通 A4（612×792）永远不被削 ✓（预算 3.2× > 上界 2×）", () => {
    expect(displayRasterScale(4, 612, 792, 2)).toBe(2);
    expect(displayRasterScale(1.5, 612, 792, 2)).toBeCloseTo(1.5, 3);
  });

  it("⭐ 巨幅页（3152×5752 ＝ 那篇 PDF）削到 ≈0.53× ⇒ 像素 72 Mpx → ~5 Mpx ✓", () => {
    const s = displayRasterScale(2.5, 3152, 5752, 2);
    expect(s).toBeCloseTo(Math.sqrt(DISPLAY_PIXEL_BUDGET / (3152 * 5752)), 3);
    expect(s).toBeLessThan(1);
    expect(3152 * 5752 * s * s).toBeLessThanOrEqual(DISPLAY_PIXEL_BUDGET + 1);
  });

  it("⭐ 边界：不超过布局倍率 ✓／不低于 MIN_SCALE ✓／尺寸读不到时退回旧行为 ✓", () => {
    expect(displayRasterScale(0.3, 3152, 5752, 2)).toBeCloseTo(0.3, 3);
    expect(displayRasterScale(2.5, 100000, 100000, 2)).toBe(MIN_SCALE);
    expect(displayRasterScale(1.7, 0, 0, 2)).toBeCloseTo(1.7, 3);
    expect(displayRasterScale(1.7, NaN, 100, 2)).toBeCloseTo(1.7, 3);
  });
  it("⭐ 2026-10-15 调过预算：5 Mpx ⇒ 12 Mpx（削像素换不来速度 ✗，只当荒谬尺寸兜底 ✓）", () => {
    expect(DISPLAY_PIXEL_BUDGET).toBe(12_000_000);
    // ⭐ 普通 A4 仍然**永远不会被削** ✓（预算 4.97× 、上界 2× ⇒ 取 2×）
    expect(displayRasterScale(4, 612, 792, 2)).toBe(2);
    // ⭐ 巨幅页仍然被兜住 ✓（不吃满 600 MB）
    const s = displayRasterScale(2.5, 3152, 5752, 2);
    expect(3152 * 5752 * s * s).toBeLessThanOrEqual(DISPLAY_PIXEL_BUDGET + 1);
  });

});
