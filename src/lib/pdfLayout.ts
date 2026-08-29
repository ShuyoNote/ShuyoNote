// 方案 B — 虚拟化连续滚动的纯布局数学。与 React 解耦，便于单测。
// 连续模式：所有页块共享同一内容宽 `contentW`，每页占位高 = 顶部 chrome 带 + 页面图像高。

/** 每页顶部 chrome 带（工具栏+状态条滚动条固定占位，略大于实际，防止叠盖）。 */
export const CHROME = 96;
/** 页间间距 px。 */
export const GAP = 18;

/** 最小/最大缩放倍率。最小 = 8.33%（参考阅读器缩放下拉的底值）；最大限制在 4x，避免页面光栅化过大/无穷宽。 */
export const MIN_SCALE = 0.0833;
export const MAX_SCALE = 4;

/** 缩放模式：具名适配模式，或一个固定百分比（pct）。 */
export type ZoomMode =
  | { mode: "fit-width" | "fit-page" | "fit-content" | "actual" }
  | { mode: "pct"; pct: number };

/** 由「可用视口内容宽 + 基准页宽」算出适配页宽的缩放倍率。 */
export function fitScaleForWidth(refW: number, avail: number): number {
  if (!refW || refW <= 0 || avail <= 0) return 1;
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, +(avail / refW).toFixed(3)));
}

/** 页块显示宽（px）：随缩放真实放大。缩放 1 = 基准页原始像素宽。 */
export function zoomContentWidth(refW: number, scale: number): number {
  return Math.max(refW * scale, 40);
}

/** 由缩放模式 + 视口尺寸解出实际缩放倍率。适配模式随视口变化自动重算（连续滚动）。 */
export function resolveZoomScale(
  zoom: ZoomMode,
  refW: number,
  refH: number,
  availW: number,
  availH: number,
): number {
  const W = Math.max(availW, 1);
  const H = Math.max(availH, 1);
  let s: number;
  switch (zoom.mode) {
    case "fit-width":
      s = W / refW;
      break;
    case "fit-page":
      // 同时放下整页宽和高 ⇒ 取两个方向的较小值。
      s = Math.min(W / refW, H / refH);
      break;
    case "fit-content":
      // 忽略页面四周留白（估内容占 ~90% 宽 / 85% 高），比 fit-page 略放大。
      s = Math.min(W / (refW * 0.9), H / (refH * 0.85));
      break;
    case "actual":
      s = 1;
      break;
    default:
      s = zoom.pct / 100;
      break;
  }
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, +(s).toFixed(3)));
}

/** 参考阅读器缩放下拉的百分比阶梯（从大到小）。 */
export const ZOOM_LADDER = [6400, 3200, 1600, 800, 400, 200, 150, 125, 100, 50, 25, 12.5, 8.33];

/** 把缩放模式映射成展示标签（下拉触发器/当前项）。 */
export function zoomLabel(zoom: ZoomMode): string {
  switch (zoom.mode) {
    case "actual":
      return "实际大小";
    case "fit-page":
      return "适合页面";
    case "fit-width":
      return "适合宽度";
    case "fit-content":
      return "适合内容";
    default:
      // 自定义百分比：整数不显示小数，非整数保留必要小数。
      const pct = zoom.pct;
      return `${Number.isInteger(pct) ? pct : +pct.toFixed(2)}%`;
  }
}

/** 当前缩放对应的百分比（四舍五入到 2 位）。 */
export function zoomPct(scale: number): number {
  return +((scale / 1) * 100).toFixed(2);
}

/** ± 步进：在当前缩放基础上沿阶梯进/退一步（fit 模式先落入当前缩放对应的百分比，再从该值步进）。 */
export function stepZoom(scale: number, dir: 1 | -1): ZoomMode {
  const cur = zoomPct(scale);
  // 目标是阶梯中比当前更靠「放大（dir=1，取最接近的更大档）」或「缩小（dir=-1，取最接近的更小档）」。
  let target: number;
  if (dir === 1) {
    const larger = ZOOM_LADDER.filter((p) => p > cur + 0.01);
    target = larger.length ? Math.min(...larger) : ZOOM_LADDER[0];
  } else {
    const smaller = ZOOM_LADDER.filter((p) => p < cur - 0.01);
    target = smaller.length ? Math.max(...smaller) : ZOOM_LADDER[ZOOM_LADDER.length - 1];
  }
  return { mode: "pct", pct: target };
}

/** 页面图像显示高（px）：元数据缺失时按典型 A4 比例（√2）估算。 */
export function pageImageHeight(
  meta: { w: number; h: number } | undefined,
  contentW: number,
): number {
  return meta ? (meta.h / meta.w) * contentW : 1.414 * contentW;
}

/** 单页占位总高。 */
export function slotHeight(
  meta: { w: number; h: number } | undefined,
  contentW: number,
): number {
  return CHROME + pageImageHeight(meta, contentW);
}

export interface PdfLayout {
  /** 每页顶部在滚动轴上的 y（前缀和）。*/
  tops: number[];
  /** 每页占位高。 */
  heights: number[];
  /** 整段内容总高（滚动轴高度）。 */
  total: number;
}

/** 由每页元数据 + 内容宽算出全部页的前缀和布局。 */
export function buildLayout(
  metas: (Partial<{ w: number; h: number }> | null | undefined)[],
  contentW: number,
): PdfLayout {
  const heights: number[] = [];
  const tops: number[] = [];
  let y = 0;
  for (let i = 0; i < metas.length; i++) {
    const m = metas[i];
    const h = slotHeight(m && m.w ? { w: m.w, h: m.h || 0 } : undefined, contentW);
    heights.push(h);
    tops.push(y);
    y += h + GAP;
  }
  return { heights, tops, total: Math.max(0, y - GAP) };
}

export interface ViewportRange {
  start: number;
  end: number;
  current: number;
}

/** 由滚动位置 + 视口高计算「挂载页范围（含 buffer）+ 当前页（视口中心页）」。 */
export function computeViewport(
  scrollTop: number,
  clientHeight: number,
  layout: PdfLayout,
  buffer = 1,
): ViewportRange {
  const { heights, tops } = layout;
  const n = tops.length;
  if (!n) return { start: -1, end: -1, current: 0 };
  const vTop = scrollTop;
  const vBottom = scrollTop + clientHeight;

  let start = 0;
  for (let i = 0; i < n; i++) {
    if (tops[i] + heights[i] > vTop) { start = i; break; }
    start = i + 1;
  }
  let end = n - 1;
  for (let i = start; i < n; i++) {
    if (tops[i] <= vBottom) end = i;
    else break;
  }

  const rStart = Math.max(0, start - buffer);
  const rEnd = Math.min(n - 1, end + buffer);

  const center = vTop + clientHeight / 2;
  let current = start;
  for (let i = start; i < n; i++) {
    if (tops[i] <= center) current = i;
    else break;
  }
  return { start: rStart, end: rEnd, current };
}
