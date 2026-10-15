import { describe, expect, it } from "vitest";
import {
  A4_WIDTH_FALLBACK,
  MAX_SCALE,
  DISPLAY_PIXEL_BUDGET,
  displayRasterScale,
  decideTile,
  tileRasterScale,
  visibleRectPt,
  rectCssFromPt,
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

describe("2026-10-15 D2/D3：底图走「封顶＋预算」；瓦片只在真更清楚更省时出（owner：「pdf 放大很卡」）", () => {
  it("⭐ D3：底图政策＝**既有的封顶（2×）＋ 像素预算**；>100% 时**饱和**（不再随倍率长）✓", () => {
    // ≤100%：与改动前逐值相同（缩小档、适配模式一个数不变 ✓）
    for (const s of [0.25, 0.33, 0.5, 0.75, 1]) {
      expect(displayRasterScale(s, 612, 792, 2)).toBeCloseTo(s, 6);
    }
    // >100%：**封顶 2× 就饱和** ⇒ 继续放大不会重出更大的整页（这正是"每按一下重出整页"的病根 ✓）
    expect(displayRasterScale(2, 612, 792, 2)).toBe(2);
    expect(displayRasterScale(4, 612, 792, 2)).toBe(2);
    // 巨幅页（山西焦煤那篇：3152×5752 pt）：倍率被**像素预算**兜住 ⇒ 不超 12 Mpx
    // （⛔ 主路原先吃 `scale`：400% 要 290 Mpx、200% 要 145 Mpx ⇒ 都会被 Rust 的 40 Mpx 闸门拒 ✗）
    const big = displayRasterScale(4, 3152, 5752, 2);
    expect(big).toBeLessThan(1);
    expect(3152 * 5752 * big * big).toBeLessThanOrEqual(DISPLAY_PIXEL_BUDGET + 1);
    expect(3152 * 5752 * 2 * 2).toBeGreaterThan(40_000_000); // 整页按 2× ⇒ 会被拒（这就是必须封的原因）
  });

  it("⭐ D2：可见块按**真倍率**出（上限 MAX_SCALE）⇒ 可以比底图清楚 ✓", () => {
    // 400% 下一块 250×175 pt 的可见块：预算 sqrt(12M/43750) ≈ 16.6 ⇒ 取 min(4, 4) = 4 ✓
    expect(tileRasterScale(4, 250, 175)).toBe(4);
    expect(tileRasterScale(4, 250, 175)).toBeGreaterThan(displayRasterScale(4, 1891, 3300, 2));
    // ⛔ 不超过布局倍率（100% 时不需要比屏幕更清楚）
    expect(tileRasterScale(1, 250, 175)).toBe(1);
    // ⛔ 不超过 MAX_SCALE
    expect(tileRasterScale(4, 8, 8)).toBeLessThanOrEqual(MAX_SCALE);
    // 块大到接近整页时，仍被**像素预算**削（预算按这块自己的面积算 ✓）
    const s = tileRasterScale(4, 3152, 5752);
    expect(3152 * 5752 * s * s).toBeLessThanOrEqual(DISPLAY_PIXEL_BUDGET + 1);
  });

  it("⭐ 承重：可见**矩形**（两轴都裁）；去程/回程同一套换算 ⇒ **贴不歪**", () => {
    // A4 页在 200%：图片 1224×1584 CSS，左上角在视口外 (-300, -1000)，视口 800×600
    const pageW = 612;
    const pageH = 792;
    const imgWidth = 1224;
    const imgHeight = 1584;
    const rect = visibleRectPt({
      imgLeft: -300,
      imgTop: -1000,
      imgWidth,
      imgHeight,
      pageW,
      pageH,
      viewWidth: 800,
      viewHeight: 600,
    });
    expect(rect).not.toBeNull();
    expect(rect!.xPt).toBeCloseTo(150, 6); // 300 CSS / 2
    expect(rect!.wPt).toBeCloseTo(400, 6); // 800 CSS / 2
    expect(rect!.yPt).toBeCloseTo(500, 6); // 1000 CSS / 2
    expect(rect!.hPt).toBeCloseTo(292, 6); // 页面底 584 CSS ⇒ (584+1000)/2 − 500

    // 回程：同一个 pt 矩形换算回 CSS ⇒ 必须**正好**是那段可见区间（这就是"贴不歪"的判据）
    const back = rectCssFromPt(rect!, pageW, imgWidth);
    expect(back.leftCss).toBeCloseTo(300, 6);
    expect(back.widthCss).toBeCloseTo(800, 6);
    expect(back.topCss).toBeCloseTo(1000, 6);
    expect(back.heightCss).toBeCloseTo(584, 6);

    // ⛔ 绝不越界（越界＝请求页面外的一块，那会拿到空白或报错）
    expect(rect!.xPt).toBeGreaterThanOrEqual(0);
    expect(rect!.yPt).toBeGreaterThanOrEqual(0);
    expect(rect!.xPt + rect!.wPt).toBeLessThanOrEqual(pageW);
    expect(rect!.yPt + rect!.hPt).toBeLessThanOrEqual(pageH);
  });

  it("⭐ 整页都在视口里 ⇒ 整页（余量也被夹在页面内）", () => {
    const rect = visibleRectPt({
      imgLeft: 50,
      imgTop: 100,
      imgWidth: 612,
      imgHeight: 792,
      pageW: 612,
      pageH: 792,
      viewWidth: 1000,
      viewHeight: 1000,
      marginCss: 500,
    });
    expect(rect).toEqual({ xPt: 0, yPt: 0, wPt: 612, hPt: 792 });
  });

  it("⭐ 页在视口外（任一轴）/ 参数退化 ⇒ null（⛔ 不请求一个退化矩形）", () => {
    const base = {
      imgLeft: 0,
      imgTop: 0,
      imgWidth: 612,
      imgHeight: 792,
      pageW: 612,
      pageH: 792,
      viewWidth: 800,
      viewHeight: 800,
    };
    expect(visibleRectPt({ ...base, imgTop: 900 })).toBeNull(); // 整页在视口下方
    expect(visibleRectPt({ ...base, imgTop: -900 })).toBeNull(); // 整页在视口上方
    expect(visibleRectPt({ ...base, imgLeft: -700 })).toBeNull(); // 整页在视口左侧（横向不裁会漏掉这一路 ✗）
    expect(visibleRectPt({ ...base, imgLeft: 900 })).toBeNull(); // 整页在视口右侧
    expect(visibleRectPt({ ...base, imgWidth: 0 })).toBeNull();
    expect(visibleRectPt({ ...base, imgHeight: 0 })).toBeNull();
    expect(visibleRectPt({ ...base, pageW: 0 })).toBeNull();
    expect(visibleRectPt({ ...base, pageH: 0 })).toBeNull();
    expect(visibleRectPt({ ...base, imgLeft: NaN })).toBeNull();
    expect(visibleRectPt({ ...base, viewWidth: 0 })).toBeNull();
    expect(visibleRectPt({ ...base, viewHeight: -5 })).toBeNull();
  });

  it("⭐ 余量：滚一点不必重出可复用；但四个边都被夹住，绝不出页面", () => {    const common = { pageW: 1000, pageH: 1000, imgWidth: 2000, imgHeight: 2000, viewWidth: 800, viewHeight: 400 };
    const noMargin = visibleRectPt({ ...common, imgLeft: -1600, imgTop: -800 })!;
    expect(noMargin.xPt).toBeCloseTo(800, 6);
    expect(noMargin.wPt).toBeCloseTo(200, 6);
    expect(noMargin.yPt).toBeCloseTo(400, 6);
    expect(noMargin.hPt).toBeCloseTo(200, 6);

    const withMargin = visibleRectPt({ ...common, imgLeft: -1600, imgTop: -800, marginCss: 200 })!;
    expect(withMargin.xPt).toBeCloseTo(700, 6); // 左边留 100 pt
    expect(withMargin.wPt).toBeCloseTo(300, 6); // 200 pt ＋ 左右各 100 pt
    expect(withMargin.yPt).toBeCloseTo(300, 6);
    expect(withMargin.hPt).toBeCloseTo(400, 6);
    expect(withMargin.xPt).toBeGreaterThanOrEqual(0);
    expect(withMargin.yPt).toBeGreaterThanOrEqual(0);
    expect(withMargin.xPt + withMargin.wPt).toBeLessThanOrEqual(common.pageW);
    expect(withMargin.yPt + withMargin.hPt).toBeLessThanOrEqual(common.pageH);

    // 贴到左上角时，两边都夹在 0（不是负数）
    const atEdge = visibleRectPt({ ...common, imgLeft: 0, imgTop: 0, marginCss: 200 })!;
    expect(atEdge.xPt).toBe(0);
    expect(atEdge.yPt).toBe(0);
    expect(atEdge.wPt).toBeCloseTo((common.viewWidth + 200) * (common.pageW / common.imgWidth), 6);
    expect(atEdge.hPt).toBeCloseTo((common.viewHeight + 200) * (common.pageW / common.imgWidth), 6);
  });
});

// ⭐⭐ D2 的**值不值得**：这一层决定"到底值不值得出那块瓦片"。
// 三个用例的几何都是**真机量出来的**（2026-10-15 活体 CDP，视口 1450×1101 CSS）✓
describe("2026-10-15 D2：decideTile —— 要不要出可见块瓦片", () => {
  const CAP = 2;

  it("⭐ 普通 A4（595×842）@200%：整页 2× 又清楚又便宜（2 Mpx）⇒ **不出瓦片**（不回退 ✓）", () => {
    // 量到的可见块：整宽 595 pt × 542.5 pt（视口 1085 CSS ÷ 2）
    const d = decideTile({ scale: 2, pageW: 595, pageH: 842, rectW: 595, rectH: 542.5, displayCap: CAP });
    expect(d.take).toBe(false);
    expect(d.baseScale).toBe(2); // ＝ displayRasterScale(2, …, 2) ⇒ 与改动前**逐值相同** ✓
    expect(d.why).toContain("不比底图清楚");
  });

  it("⭐ 巨幅页（3152×5752）@400%：底图被预算压到 0.81× ⇒ 出**一块高清**（4×，这才是「放大看得清」的兑现）", () => {
    const d = decideTile({ scale: 4, pageW: 3152, pageH: 5752, rectW: 1782, rectH: 1353, displayCap: CAP });
    expect(d.take).toBe(true);
    expect(d.tileScale).toBeCloseTo(2.227, 2); // 真倍率（这块的面积决定预算上限）
    expect(d.baseScale).toBeCloseTo(Math.sqrt(DISPLAY_PIXEL_BUDGET / (3152 * 5752)), 3); // 预算兜底
    expect(d.tileScale).toBeGreaterThan(d.baseScale * 2); // 比底图清楚一倍以上 ✓
  });

  it("⭐ 混排文档里的巨页（2358×1980）@400%：**也出瓦片**（底图被封顶 1.6×，瓦片给 2.76×）", () => {
    const d = decideTile({ scale: 4, pageW: 2358, pageH: 1980, rectW: 1450, rectH: 1085, displayCap: CAP });
    expect(d.take).toBe(true);
    expect(d.baseScale).toBeCloseTo(displayRasterScale(4, 2358, 1980, 2), 6); // 底图**没有**被封到 1× ✓
    expect(d.baseScale).toBeGreaterThan(1);
    expect(d.tileScale).toBeGreaterThan(d.baseScale * 1.25);
  });

  it("⭐ 瓦片**贵得离谱**时必须拒绝：小页（595×842）@400%、可见块≈整页 ⇒ 位图 4× 于整页 ⇒ 不出", () => {
    const d = decideTile({ scale: 4, pageW: 595, pageH: 842, rectW: 595, rectH: 842, displayCap: CAP });
    expect(d.take).toBe(false);
    expect(d.why).toContain("省不下来");
    expect(d.baseScale).toBe(2); // 底图照旧（封顶 2× ＝ 又清楚又便宜 ✓）
  });

  it("⭐ ≤100%：一律走整页（缩放档位行为与改动前逐值相同）", () => {
    for (const s of [0.25, 0.5, 1]) {
      const d = decideTile({ scale: s, pageW: 3152, pageH: 5752, rectW: 362.5, rectH: 271.25, displayCap: CAP });
      expect(d.take).toBe(false);
      expect(d.baseScale).toBeCloseTo(displayRasterScale(s, 3152, 5752, 2), 6);
      expect(d.why).toContain("≤100%");
    }
  });

  it("⭐ 可见块退化（0 宽/高）⇒ 不出（⛔ 不请求退化矩形）", () => {
    expect(decideTile({ scale: 4, pageW: 595, pageH: 842, rectW: 0, rectH: 100, displayCap: CAP }).take).toBe(false);
    expect(decideTile({ scale: 4, pageW: 595, pageH: 842, rectW: 100, rectH: 0, displayCap: CAP }).take).toBe(false);
  });
});
