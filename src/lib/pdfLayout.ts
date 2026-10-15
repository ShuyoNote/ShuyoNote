// 方案 B — 虚拟化连续滚动的纯布局数学。与 React 解耦，便于单测。
// 连续模式：所有页块共享同一内容宽 `contentW`，每页占位高 = 顶部 chrome 带 + 页面图像高。

/** 页内顶部少量留白。之前用于给每页自带的工具栏/状态条占位（96px），
 *  后工具栏已提升为顶部唯一一份，页块内不再有工具栏，这里只保留很薄的顶部留白。 */
export const CHROME = 12;
/** 页间间距 px（相邻两页之间的视觉空隙）。 */
export const GAP = 16;

/**
 * 最大 4×（400%，页面已明显放大，避免光栅化过大/无穷宽）；最小 **0.25**（手动百分比的下界）。
 *
 * ⛔⭐ **2026-10-15（owner：「看看这个 pdf 文件为何不能缩小？」）** ✗：最小原来是 **0.5** ✓，
 *   而它挡住的不只是"手动再缩一档" ✗ —— ⭐ **连"适合页面／适合内容"也一起被夹了** ✗：
 *   一张**超宽横向流程图**（如 2000×800）在 900×600 里本该是 **0.45** ✓，被夹成 0.5 ⇒ 屏幕上
 *   **看不全** ✓（实测读数：`fit-page 原始 0.45 ⇒ 夹成 0.5` ✓）。
 *   ⇒ 现在两件事分开：⭐ **适配模式（fit-*）不夹下界** ✓（语义就是"放得下" ✓ —— 见 `resolveZoomScale` ✓）；
 *   ⭐ 手动百分比的下界降到 **0.25** ✓（仍然有个底 ✓，⛔ 不是无限制 ✗）。
 */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;

/** 缩放模式：具名适配模式，或一个固定百分比（pct）。 */
export type ZoomMode =
  | { mode: "fit-width" | "fit-page" | "fit-content" | "actual" }
  | { mode: "pct"; pct: number };

/**
 * A4 宽（pt）—— 取不到页尺寸时的回退基准，和 PdfReader 里 refW 的回退保持一致。
 */
export const A4_WIDTH_FALLBACK = 612;

/** 由「可用视口内容宽 + 基准页宽」算出适配页宽的缩放倍率。 */
export function fitScaleForWidth(refW: number, avail: number): number {
  if (!refW || refW <= 0 || avail <= 0) return 1;
  const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, +(avail / refW).toFixed(3)));
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/**
 * 页块显示宽（px）：随缩放真实放大。缩放 1 = 基准页原始像素宽。
 *
 * 非有限值是必须挡住的：它最终会变成 canvas 的宽高，
 * WKWebView 会直接抛 `Value NaN is outside the range [-2147483648, 2147483647]`，
 * Chrome/WKWebView 的另一些路径则静默画成 0×0 —— 用户看到的就是"一片空白"。
 * 退回「基准页宽 ×1」至少还是一页正常宽度。
 */
export function zoomContentWidth(refW: number, scale: number): number {
  const w = refW * scale;
  if (Number.isFinite(w) && w > 0) return Math.max(w, 40);
  const base = Number.isFinite(refW) && refW > 0 ? refW : A4_WIDTH_FALLBACK;
  return Math.max(base, 40);
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
  // ⭐ 适配模式（fit-*）：⭐ 它们的语义是"**放得下**" ⇒ ⛔ 只夹上界、**不夹下界** ✗
  //   （一张超宽图本该 45% 却被夹成 50% ⇒ 用户看到的正是"缩不下去、看不全" ✓ —— 2026-10-15 实测 ✓）。
  const isFit = zoom.mode === "fit-width" || zoom.mode === "fit-page" || zoom.mode === "fit-content";
  // 退化输入（refW/refH 为 0 或 NaN、pct 为 NaN）会让 s 变成 NaN/Infinity。
  // 倍率是"往画布上传"的第一个数：绝不允许非有限值出门。返回 1（实际大小）是安全的默认。
  if (!Number.isFinite(s) || s <= 0) return 1;
  const capped = Math.min(MAX_SCALE, +(s).toFixed(3));
  // ⭐ 手动百分比（`pct`）与「实际大小」照旧夹下界 ✓ —— 那是用户直接指定的倍率 ✓。
  return isFit ? capped : Math.max(MIN_SCALE, capped);
}

/**
 * ⭐⭐ **2026-10-15（owner 选「先 F 再 D」）** ✗：**显示位图的像素预算** ✓。
 *
 * 来由（真机读数 ✓）：本机那篇 PDF 的**单页就有 3152×5752 pt**（≈111×203 cm ✓，18.1 Mpx 基准）
 * ⇒ 就算按倍数封到 2×，位图仍是 **72 Mpx** ✗ ⇒ 每按一下放大要等 ~1.5 s ✓（实测位图换过来 1542 ms ✓）。
 * ⇒ ⭐ 改成**按像素**封：位图总像素不超过这个预算 ✓。
 *
 * ⚠️ **2026-10-15 调过一次：5 Mpx ⇒ 12 Mpx** ✓ —— 因为真机复测证明**真正的瓶颈不是像素数** ✗
 *   （是 pdfium 每次渲染都要过整页矢量 ✓：25% 那档只有 1.1 Mpx 也要 528 ms ✗）
 *   ⇒ ⭐ 削像素换不来速度 ✗、却会换来糊 ✗ ⇒ 预算退回去只当"荒谬尺寸"的兜底 ✓。
 * ⚠️ 这条**不会**削普通页 ✗：A4（612×792 pt）算出 ≈3.2× ⇒ 永远够 ✓；
 * 只有超大版面才会被削 ✓（那就是 F 的代价：放大后略糊 ✓）。⛔ 清楚留给后面的 D ✗。
 * ⛔ 只管**显示** ✗：OCR 与导出照旧真实倍率 ✓。
 */
export const DISPLAY_PIXEL_BUDGET = 12_000_000;

/**
 * 显示位图该用多大倍率 ✓（纯函数 ⇒ 好判 ✓）。
 *
 * 规则：`min(scale, cap, max(MIN_SCALE, sqrt(预算 / (pageW*pageH))))` ✓
 *  · ⛔ 不会超过 `scale` ✗（放大时不需要比屏幕更清楚 ✓）；
 *  · ⛔ 不会低于 `MIN_SCALE` ✗（那会小到连缩小档都不够 ✓）；
 *  · 尺寸拿不到（0/NaN）⇒ 退回 `min(scale, cap)` ✓（不猜 ✓）。
 *
 * @param scale 布局倍率（用户看到的缩放 ✓）
 * @param pageW/pageH 该页的 **pt** 尺寸（`getPageMeta` ✓）
 * @param cap 绝对上界（当前 2× ✓）
 */
export function displayRasterScale(scale: number, pageW: number, pageH: number, cap: number): number {
  const need = Math.min(scale, cap);
  const px = pageW * pageH;
  if (!Number.isFinite(px) || px <= 0) return need;
  const budget = Math.sqrt(DISPLAY_PIXEL_BUDGET / px);
  return Math.min(need, Math.max(MIN_SCALE, budget));
}

/** 缩放下拉的百分比阶梯（从大到小）。只保留实用档位：**25%–400%**，全都在 MIN/MAX 范围内、真实生效。
 *  ⭐ **2026-10-15**：补 **33／25** 两档 ✓ —— 原来最低只到 50 ✓，遇到**超宽图**就再也缩不下去 ✗
 *  （连同「适合页面」一起被 `MIN_SCALE` 夹住 ✓ —— 见上面那段注释 ✓）。 */
export const ZOOM_LADDER = [400, 300, 250, 200, 150, 125, 100, 75, 50, 33, 25];

// ── D2 / D3（2026-10-15，owner：「pdf 放大很卡」的 D 一步）────────────────────────
//
// 读数（真机分段埋点 ＋ D1 的对照实验）：`renderPdfPage` 的「命令往返」821 ms 里纯光栅化只占
// ≈106 ms ⇒ **约 715 ms 花在把载荷送过去**，而且**与字节数成正比**（≈0.55 ms/KB）。
// ⇒ 只把**看得见的那一条**送过去，载荷就按"可见带占整页的比例"缩小 ✓（这是 D 的全部要点）。
//
// 分工：
//   · **D3**：整页（底图）的倍率封到 **1×**（[`baseRasterScale`]）⇒ >100% 不再出整页高清；
//   · **D2**：可见带按**真倍率**出（[`tileRasterScale`]）⇒ 那块位图小，像素预算管得住，
//     所以它可以比旧的 2× 封顶**更清楚**（上限 `MAX_SCALE`）✓。
//
// ⚠️ 三条口径必须一致，⛔ 别混：
//   ① [`visibleBandPt`] 返回的是**页面 pt、左上角为原点**（＝ Rust `render_page_rect` 吃的口径 ✓）；
//   ② 它只吃**已经量好的 CSS 数字**（DOM 里量出来的 ✓）⇒ 能单测，且不掺任何 DOM 假设 ✓；
//   ③ 贴回页面时用**百分比**（`topPct = topPt / pageH × 100`，见 PdfReader 的 `tileStyle`）——
//      这样"请求哪一块"和"贴在哪一块"用的是**同一个 pt 区间**，不会各算一套而贴歪 ✓。

/**
 * ⭐ **D3**：**底图**（整页）的显示倍率上限 —— 放大到 >100% 时底图**不再跟着放大** ✓。
 *
 * 它取代了原来的 `DISPLAY_RASTER_CAP = 2`（整页位图封顶 2×）：
 *   · 旧口径：>200% 看到的是"放大的位图"（略糊 ✓），而且**每次缩放都要重出一整页** ✗；
 *   · 新口径：整页只到 1×（一次，之后缩放**不必重出** ✓），高清由可见带负责 ✓。
 * ⚠️ ≤100% 时两者**完全一致**（`min(scale, 1) === scale`）⇒ 缩小档位的行为一个字节都没变 ✓。
 */
export const BASE_RASTER_CAP = 1;

/** D3：底图该用多大倍率（纯函数 ⇒ 好判）。`scale ≤ 1` 时与 [`displayRasterScale`] 逐值相同。 */
export function baseRasterScale(
  scale: number,
  pageW: number,
  pageH: number,
  cap: number = BASE_RASTER_CAP,
): number {
  return displayRasterScale(Math.min(scale, cap), pageW, pageH, cap);
}

/**
 * D2：**可见带**该用多大倍率（纯函数）。
 *
 * 与底图的关键差别：位图只覆盖一条带子 ⇒ 预算按**这条带自己的 pt 面积**算 ✓
 * （`displayRasterScale` 里的 `sqrt(预算 / px)` 就是这么用的 ✓）⇒ 小带子能拿到 `MAX_SCALE` ✓。
 * ⚠️ 上限仍是 `MAX_SCALE`（4×）—— 与 `resolveZoomScale` 的上界同一个数，不发明第三个上限 ✓。
 */
export function tileRasterScale(scale: number, bandW: number, bandH: number): number {
  return displayRasterScale(scale, bandW, bandH, MAX_SCALE);
}

/**
 * ⭐ **D2 的承重几何**：算出"这一页**真正看得见**的那块矩形"（页面 pt、左上角为原点）。
 *
 * 为什么是**两个轴**都要裁（活体实测 2026-10-15 才发现 ✗）：只裁纵向（一条"横带"）在**放大**时
 * 白送掉大头 —— 200% 下一张 1427 pt 宽的横向流程图有 **一半宽度在视口外**，那条"带子"仍是
 * **23% 的页面**；而按矩形裁是 **6%**（400% 时）⇒ 载荷与过桥成本直接差 4 倍 ✓。
 * ⛔ 而 D 的全部要点就是"载荷按面积缩" ✓（读数：过桥 ≈ 0.55 ms/KB ✓）。
 *
 * 为什么只吃**量好的数字**、单独抽出来单测：**贴歪比糊更糟** ✗ —— 这块矩形的 pt 区间同时决定
 * "请求哪一块"和"贴回哪里"（见文件头那段 ③ ✓），错一格就是画面上一块错位的 patch。
 * 所以它不碰 DOM，并且**去程/回程用同一个 `ptPerCss`** ✓。
 *
 * @param imgLeft/imgTop 页图像左上角相对滚动视口左上角的 CSS 坐标（可负：已经滚出视口 ✓）
 * @param imgWidth/imgHeight 页图像在屏上的 CSS 尺寸（> 0）
 * @param pageW/pageH 该页的 **pt** 尺寸（> 0）
 * @param viewWidth/viewHeight 视口的 CSS 尺寸（> 0）
 * @param marginCss 四周各留多少 CSS 余量（滚一点不必重出 ✓）；⛔ 会被夹在页面内
 * @returns `null` ⇒ 这块与视口**不相交**，或参数退化（⇒ **不请求**，⛔ 而不是请求一个退化矩形）
 */
export function visibleRectPt({
  imgLeft,
  imgTop,
  imgWidth,
  imgHeight,
  pageW,
  pageH,
  viewWidth,
  viewHeight,
  marginCss = 0,
}: {
  imgLeft: number;
  imgTop: number;
  imgWidth: number;
  imgHeight: number;
  pageW: number;
  pageH: number;
  viewWidth: number;
  viewHeight: number;
  marginCss?: number;
}): { xPt: number; yPt: number; wPt: number; hPt: number } | null {
  if (
    ![imgLeft, imgTop, imgWidth, imgHeight, pageW, pageH, viewWidth, viewHeight].every((v) => Number.isFinite(v)) ||
    imgWidth <= 0 ||
    imgHeight <= 0 ||
    pageW <= 0 ||
    pageH <= 0 ||
    viewWidth <= 0 ||
    viewHeight <= 0
  ) {
    return null;
  }
  // 视口在"图片坐标系"里的两条区间：视口左上 = (0, 0)，右下 = (viewWidth, viewHeight)。
  const overlapLeft = Math.max(imgLeft, 0);
  const overlapRight = Math.min(imgLeft + imgWidth, viewWidth);
  const overlapTop = Math.max(imgTop, 0);
  const overlapBottom = Math.min(imgTop + imgHeight, viewHeight);
  if (!(overlapRight > overlapLeft) || !(overlapBottom > overlapTop)) return null;

  // 两个轴**共用一个换算比**（图片是等比铺开的 ✓：`imgWidth/pageW === imgHeight/pageH`）。
  const ptPerCss = pageW / imgWidth;
  const margin = Number.isFinite(marginCss) && marginCss > 0 ? marginCss : 0;
  const xPt = Math.max(0, (overlapLeft - imgLeft - margin) * ptPerCss);
  const yPt = Math.max(0, (overlapTop - imgTop - margin) * ptPerCss);
  const xEnd = Math.min(pageW, (overlapRight - imgLeft + margin) * ptPerCss);
  const yEnd = Math.min(pageH, (overlapBottom - imgTop + margin) * ptPerCss);
  if (!(xEnd > xPt) || !(yEnd > yPt)) return null;
  return { xPt, yPt, wPt: xEnd - xPt, hPt: yEnd - yPt };
}

/** 把 [`visibleRectPt`] 的 pt 矩形换算回"相对页图像左上角的 CSS 矩形"（贴回去用它 ✓ 同一套换算）。 */
export function rectCssFromPt(
  rect: { xPt: number; yPt: number; wPt: number; hPt: number },
  pageW: number,
  imgWidth: number,
): { leftCss: number; topCss: number; widthCss: number; heightCss: number } {
  const ptPerCss = pageW / imgWidth;
  return {
    leftCss: rect.xPt / ptPerCss,
    topCss: rect.yPt / ptPerCss,
    widthCss: rect.wPt / ptPerCss,
    heightCss: rect.hPt / ptPerCss,
  };
}

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

/** 批注的几何（归一化坐标）。仅取计算「垂直中心」所需字段，做纯函数、可单测。 */
export interface AnnGeometry {
  box?: [number, number, number, number] | null;
  points?: [number, number][] | null;
}

/** 一条批注在页面内「垂直中心」的归一化 y（[0,1]）。用于侧栏点击后把标注精确滚到视口中央：
 *  墨迹取 points 包围盒中心；便签/高亮/矩形取 box 中心；无几何信息时回退页面中心。 */
export function annCenterY(ann: AnnGeometry): number {
  if (!ann) return 0.5;
  if (ann.points && ann.points.length) {
    const ys = ann.points.map((p) => p[1]);
    return (Math.min(...ys) + Math.max(...ys)) / 2;
  }
  if (ann.box) return (ann.box[1] + ann.box[3]) / 2;
  return 0.5;
}

/** 便签「双击命中区」的归一化矩形 [x0,y0,x1,y1]。覆盖便签钉 + 其内容气泡（固定 ~220×132px、偏移量），
 *  stageW/stageH 为舞台（页图像）的渲染像素尺寸，用于把气泡的 CSS 像素尺寸折算成归一化。 */
export function stickyEditRegion(
  box: [number, number, number, number],
  stageW: number,
  stageH: number,
): [number, number, number, number] {
  const w = Math.max(stageW, 1);
  const h = Math.max(stageH, 1);
  const bx = box[0];
  const by = box[1];
  // 气泡相对便签钉左上角的偏移：右移 14px、上移 6px；气泡宽高上限 ~220×132px。再各加 5px 容差。
  const pad = 5 / w;
  return [
    Math.max(0, bx - pad),
    Math.max(0, by - 10 / h),
    bx + (14 + 220) / w + pad,
    by + (132 - 6) / h + pad,
  ];
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
