// 图片预览的缩放**纯规则**（与组件分开 ⇒ 可单测 ✓）。
//
// ⚠️ 为什么值得抽出来（owner 2026-10-06）：
//   「图片预览视图，鼠标滚动放大缩小时，**不是从当前大小起步**，感觉不好」✗
//
//   真因：预览一开始是「**适应窗口**」模式 ✓ —— 图片被 CSS 缩到窗口里（一张 4000px 宽的图
//   在 900px 的窗口里实际只显示 0.22× ✓），而组件里的 `zoom` 初始值是 **1**（= 原始尺寸 ✓）。
//   于是**第一次滚轮**把 `zoom` 从 1 乘到 1.15 ✓ ⇒ 画面从"适应窗口的 22%"**跳到 115%** ✗✗
//   （而且顶栏在适应窗口模式下只显示"滚轮缩放 · 拖动平移"、**不显示百分比** ✗ ⇒ 用户更加
//     感觉不到自己"现在多大"✓）。
//
//   ⇒ 规矩：**滚轮永远是"在当前显示尺寸上乘一个系数"** ✓ —— 当前尺寸 = 适应窗口时按 CSS 量出来的
//     那个比例 ✓（`fitScaleOf`）、其它时候就是 `zoom` ✓。这样从适应窗口起步也**连续** ✓。
//
//   ⚠️ 旋转 90°/270° 时图片的宽高互换 ✓ ⇒ 量"适应比例"必须用**对应那条边**比 ✓，
//     否则转一下再滚轮又会跳 ✗。

export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 4;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z) || z <= 0) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/**
 * 「适应窗口」那一刻**实际**的显示比例（显示尺寸 ÷ 原图尺寸 ✓）。
 *
 * ⚠️ 传进来的 `renderedW/renderedH` 必须是 `getBoundingClientRect()` 量的（它是**变换之后**的框 ✓）
 * ⇒ 旋转 90°/270° 时宽高**已经**互换了 ✓ ⇒ 这里**不需要**再按 `rot` 换边 ✗
 * （我第一版多写了一次换边 ✓，判据当场拍到：4000×3000 显示 900×675 算出 0.169，而不是 0.225 ✗）。
 * 量不到（图片还没 load ⇒ 宽高为 0 ✓）⇒ 返回 1 ✓（退化成旧行为，⛔ 不猜 ✗）。
 */
export function fitScaleOf(m: {
  naturalW: number;
  naturalH: number;
  renderedW: number;
  renderedH: number;
  rot?: number;
}): number {
  const { naturalW, naturalH, renderedW, renderedH } = m;
  if (!(naturalW > 0) || !(naturalH > 0) || !(renderedW > 0) || !(renderedH > 0)) return 1;
  // 适应窗口 = "两条边都不超出" ⇒ 取两个方向比例里**更小的**那个 ✓
  const s = Math.min(renderedW / naturalW, renderedH / naturalH);
  return s > 0 && Number.isFinite(s) ? s : 1;
}

/** 滚轮 ⇒ 新比例：**在当前比例上乘一个系数** ✓（deltaY < 0 = 放大 ✓）。 */
export function nextZoomFromWheel(currentScale: number, deltaY: number, factor = 1.15): number {
  const cur = Number.isFinite(currentScale) && currentScale > 0 ? currentScale : 1;
  const dir = deltaY < 0 ? factor : 1 / factor;
  return clampZoom(cur * dir);
}
