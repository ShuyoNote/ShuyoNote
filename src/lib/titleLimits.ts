// 「标题」这件事的**唯一阈值出处**（方案 `docs/plans/2026-10-30-note-metadata-and-title-polish.md` §3）。
//
// 为什么单独一个文件、且不带任何 import：它是**纯阈值 + 纯函数**。编辑器（`.title-input`）、
// 侧边栏、标签页、看板卡片、窗口标题都从这里取数 —— 阈值一旦分两处写，就一定会有一处过期
// （方案 §3 那张表就是"同一件事写了十行"的现场：字号三档、软提示、硬上限、四种省略方式）。
// ⇒ 组件只引用这里的常量/纯函数，不写字面数字。
//
// 口径（与 TS 侧其它长度判据一致）：**按 Unicode 码点计数**（`Array.from`），不是 UTF-16
// 码元、也不是字节 —— emoji / 生僻字（代理对）算 **1** 个字符，且截断时**不许**把一个代理对
// 切成两半：切开的那半个不是合法字符，渲染出来是 `�`（服务端还会把它当非法 UTF-8 拒收）。

/** 软提示①：超过这个字数就开始显示字数（灰）。 */
export const TITLE_SOFT_CHARS = 120;

/** 软提示②：超过这个字数提示"过长会影响列表与文件名"（**仍可保存**）。 */
export const TITLE_WARN_CHARS = 300;

/** 硬上限：超过它保存时要提示，但**不回滚**用户已输入的内容（方案：硬上限 1000 字）。 */
export const TITLE_HARD_LIMIT = 1000;

/** 编辑态字号三档的分界（方案：≤40 字 → 34px；41–80 字 → 28px；>80 字 → 24px）。 */
export const TITLE_FONT_BREAKS = [40, 80] as const;

/** 编辑态字号三档（与 `TITLE_FONT_BREAKS` 一一对应）。 */
export const TITLE_FONT_SIZES = [34, 28, 24] as const;

/** 编辑态最大高度 / 失焦展示 clamp：3 行（编辑态内部滚动，**不截断输入**）。 */
export const TITLE_CLAMP_LINES = 3;

/** 标签页的中间省略：首 10 + … + 尾 8。 */
export const TAB_TITLE_HEAD = 10;
export const TAB_TITLE_TAIL = 8;

/** 窗口标题上限（≤60 字）。 */
export const WINDOW_TITLE_MAX = 60;

/** 标题为空（或只有空白）时的兜底名。 */
export const EMPTY_TITLE_FALLBACK = "无标题";

/** 显示用省略号：**一个码点**（不用 `"..."` —— 三个点会让"最大长度"变得不可算）。 */
export const ELLIPSIS = "…";

/**
 * 按 Unicode 码点数字符数（emoji / 代理对算 1）。
 *
 * 为什么不写成 `text.length`：那是 UTF-16 码元数，`"📝".length === 2` ⇒ 所有"最大 N 字"
 * 在含 emoji 的标题上都会算错，且截断位置会落在代理对中间。
 */
export function titleLength(text: string): number {
  return Array.from(text).length;
}

/** 编辑态字号：按码点长度落到三档之一（34 / 28 / 24）。 */
export function titleFontSize(text: string): number {
  const len = titleLength(text);
  if (len <= TITLE_FONT_BREAKS[0]) return TITLE_FONT_SIZES[0];
  if (len <= TITLE_FONT_BREAKS[1]) return TITLE_FONT_SIZES[1];
  return TITLE_FONT_SIZES[2];
}

/** 是否超过硬上限（保存前判断用；超了**提示**，不擅自丢弃用户输入）。 */
export function isTitleTooLong(text: string, limit = TITLE_HARD_LIMIT): boolean {
  return titleLength(text) > limit;
}

/**
 * 硬上限裁切：超过 `limit` 个码点就切到 `limit`。
 *
 * **不加省略号** —— 这是给"存库 / 进包"用的，省略号不是正文（显示省略请用
 * [`truncateForDisplay`]）。不切断代理对；**不 trim**（空值兜底是 [`fallbackTitle`] 的职责，
 * 两件事分开才不会"存进去的标题被悄悄改短"）。
 */
export function clampTitle(text: string, limit = TITLE_HARD_LIMIT): string {
  const max = Math.max(0, Math.floor(limit));
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join("");
}

/**
 * 展示用截断：超过 `maxChars` 个码点 ⇒ 取 `maxChars - 1` 个 + [`ELLIPSIS`]。
 *
 * 总长**正好** `maxChars`（省略号占 1 格）—— 调用方（侧边栏单行、卡片 2 行）因此可以直接
 * 拿它当"最多 N 字"用，不用再算省略号。`maxChars <= 0` ⇒ 空串；`maxChars === 1` ⇒ 只有省略号。
 */
export function truncateForDisplay(text: string, maxChars: number): string {
  const max = Math.floor(maxChars);
  if (max <= 0) return "";
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max - 1).join("") + ELLIPSIS;
}

/**
 * 中间省略：首 `headChars` + [`ELLIPSIS`] + 尾 `tailChars`（方案 §3 的标签页口径）。
 *
 * 不超长时**原样返回**（正文一个字都不动）；"刚好 head+tail+1 个字符"也原样返回 ——
 * 因为省略后长度一样，省略只会丢掉中间信息而没有换来任何空间。
 */
export function ellipsizeMiddle(
  text: string,
  headChars: number = TAB_TITLE_HEAD,
  tailChars: number = TAB_TITLE_TAIL,
): string {
  const chars = Array.from(text);
  const headN = Math.max(0, Math.floor(headChars));
  const tailN = Math.max(0, Math.floor(tailChars));
  if (chars.length <= headN + tailN + 1) return text;
  const head = chars.slice(0, headN).join("");
  const tail = tailN > 0 ? chars.slice(chars.length - tailN).join("") : "";
  return head + ELLIPSIS + tail;
}

/**
 * 空标题兜底：`trim()` 后为空 ⇒ 兜底名；否则**原样**返回。
 *
 * 为什么不返回 `text.trim()`：标题首尾的空白是用户打的（有人用空格对齐），改它就是改内容；
 * 这里只回答"它算不算空"。
 */
export function fallbackTitle(text: string, fallback: string = EMPTY_TITLE_FALLBACK): string {
  return text.trim() === "" ? fallback : text;
}
