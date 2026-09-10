/**
 * 侧栏拖拽/宽度的**纯规则**（与组件分开，便于单测）。
 *
 * 为什么值得单独一层：这套交互里三个数字（最小宽、最大宽、收起阈值）与一个判断
 * （这次拖动是"改宽"还是"收起"）很容易在改动中被写歪，而写歪的表现都是"手感不对"——
 * 不会报错、只会让人觉得难用。抽出来钉住，改动时至少这三个数字不会悄悄漂。
 */

/** 侧栏宽度范围（拖拽与读取持久化值共用同一对边界）。 */
export const SIDEBAR_MIN_W = 240;
export const SIDEBAR_MAX_W = 460;

/**
 * 拖到这个宽度以下，就当作**"你想收起侧栏"**——而不是卡在最小宽上拽不动。
 *
 * 为什么要有这一段（VS Code 同款手感）：只把最小宽当硬墙时，用户想把侧栏让出来，
 * 只能去点图标或按快捷键；而"往左拖到底"是最自然的那个动作。阈值取在最小宽之下
 * 60px：留出一点余量，避免手抖（想拖到 250 却滑到 238）就把侧栏收掉。
 */
export const SIDEBAR_COLLAPSE_AT = 180;

/** 拖拽/取值时的宽度夹取。 */
export function clampSidebarWidth(w: number): number {
  if (!Number.isFinite(w)) return SIDEBAR_MIN_W;
  return Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, Math.round(w)));
}

/** 一次拖动里，按指针位置算出的原始宽度 → 该"收起"还是该"改宽"。 */
export function dragOutcome(rawWidth: number): "collapse" | "resize" {
  return rawWidth < SIDEBAR_COLLAPSE_AT ? "collapse" : "resize";
}

/**
 * 从 localStorage 读出来的字符串 → 可用宽度。
 *
 * 过窄的值（历史残留、手改过、或别人写坏）**不当成"要收起"**：收起是 `sidebarOpen`
 * 的事，宽度只负责宽度——把它当收起会让"打开着但宽度非法"的存档变成打不开的侧栏。
 */
export function normalizeStoredWidth(raw: string | null | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < SIDEBAR_MIN_W) return SIDEBAR_MIN_W;
  return clampSidebarWidth(n);
}
