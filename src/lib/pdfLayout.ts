// 方案 B — 虚拟化连续滚动的纯布局数学。与 React 解耦，便于单测。
// 连续模式：所有页块共享同一内容宽 `contentW`，每页占位高 = 顶部 chrome 带 + 页面图像高。

/** 每页顶部 chrome 带（工具栏+状态条滚动条固定占位，略大于实际，防止叠盖）。 */
export const CHROME = 96;
/** 页间间距 px。 */
export const GAP = 18;

/** 最小/最大缩放倍率（用户可放大到 3x）。 */
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 3;

/** 由「可用视口内容宽 + 基准页宽」算出适配页宽的缩放倍率。 */
export function fitScaleForWidth(refW: number, avail: number): number {
  if (!refW || refW <= 0 || avail <= 0) return 1;
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, +(avail / refW).toFixed(2)));
}

/** 页块显示宽（px）：随缩放真实放大。缩放 1 = 基准页原始像素宽。 */
export function zoomContentWidth(refW: number, scale: number): number {
  return Math.max(refW * scale, 40);
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
