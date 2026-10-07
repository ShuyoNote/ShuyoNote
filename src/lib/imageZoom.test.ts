// 判据：图片预览的缩放**从当前大小起步**（owner 2026-10-06：「不是从当前大小起步」✗）。
//
// 两条真会出错的事：
//   ① 适应窗口时实际显示的是"窗口尺寸 ÷ 原图尺寸"（可能是 0.22 ✓）⇒ 滚轮必须**接着它**乘 ✓，
//      ⛔ 不能从 1（= 原始尺寸）起步 ✗ —— 那正是"第一下跳一大截"的由来 ✓；
//   ② 旋转 90/270 之后，显示的宽对应原图的**高** ✓ ⇒ 量错边会让画面再跳一次 ✗。
import { describe, expect, it } from "vitest";
import { fitScaleOf, nextZoomFromWheel, ZOOM_MAX, ZOOM_MIN } from "./imageZoom";

describe("图片预览缩放（从当前大小起步）", () => {
  it("★ 适应窗口的比例按「窗口尺寸 ÷ 原图尺寸」算（4000px 的图在 900px 窗口里 = 0.225）", () => {
    const s = fitScaleOf({ naturalW: 4000, naturalH: 3000, renderedW: 900, renderedH: 675 });
    expect(s).toBeCloseTo(0.225, 3);
  });

  it("★ 从适应比例起步乘系数 ⇒ 连续（⛔ 不是从 1 起步 ✗）", () => {
    const fit = fitScaleOf({ naturalW: 4000, naturalH: 3000, renderedW: 900, renderedH: 675 });
    const next = nextZoomFromWheel(fit, -100); // 往上滚 = 放大
    expect(next).toBeCloseTo(0.225 * 1.15, 4);
    // 关键：它**明显小于** 1 ✓（旧写法 max(1*1.15) 会跳到 1.15 ⇒ 画面上是 5 倍的一跳 ✗）
    expect(next).toBeLessThan(0.5);
  });

  it("再滚一次仍是在**上一次的结果**上乘（相对缩放 ✓）", () => {
    const a = nextZoomFromWheel(0.5, -100);
    const b = nextZoomFromWheel(a, -100);
    expect(a).toBeCloseTo(0.575, 4);
    expect(b).toBeCloseTo(0.575 * 1.15, 4);
  });

  it("往下滚 = 缩小；上下对称（同一档系数）", () => {
    expect(nextZoomFromWheel(1, 100)).toBeCloseTo(1 / 1.15, 4);
    expect(nextZoomFromWheel(nextZoomFromWheel(1, -100), 100)).toBeCloseTo(1, 4);
  });

  it("旋转 90 / 270 时用另一条边（⛔ 量错边会让画面再跳 ✗）", () => {
    // 竖图 3000x4000 适应到 900x675 的窗口：未旋转 ⇒ 宽比 0.3、高比 0.169 ⇒ 取 0.169 ✓
    expect(fitScaleOf({ naturalW: 3000, naturalH: 4000, renderedW: 900, renderedH: 675, rot: 0 })).toBeCloseTo(0.169, 3);
    // 转 90° 后显示尺寸是 675x900（宽高互换）⇒ 期望 0.225 ✓（= min(675/3000=0.225, 900/4000=0.225)）
    const rotated = fitScaleOf({ naturalW: 3000, naturalH: 4000, renderedW: 675, renderedH: 900, rot: 90 });
    expect(rotated).toBeCloseTo(0.225, 3);
  });

  it("量不到原图尺寸（还没 load）⇒ 退化成 1（⛔ 不猜 ✗）；上下界仍然夹住", () => {
    expect(fitScaleOf({ naturalW: 0, naturalH: 0, renderedW: 900, renderedH: 600 })).toBe(1);
    expect(nextZoomFromWheel(1, -100, 100)).toBe(ZOOM_MAX);
    expect(nextZoomFromWheel(1, 100, 100)).toBe(ZOOM_MIN);
  });
});
