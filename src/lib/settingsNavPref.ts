// 第 5 招（裁定 A ✓）：**「隐藏高级项」个人偏好**的纯规则 —— 与 DOM 分开 ⇒ 可单测 ✓。
//
// owner 2026-10-08 裁定 **A**（原话只有一个字母：`A` ✓）：
//   **默认全显** ✓ ＋ 一个「隐藏高级项」的**个人偏好**开关 ✓；
//   ⛔ **不做**"默认只给 20%"的模式开关 ✗（默认藏 ＝ 默认找不到 ✗）。
//
// ⇒ 所以这里只有两条规矩：
//   ① **没设过（或设成 false）⇒ 一个组都不藏** ✓（⛔ 不许"默认藏" ✗）；
//   ② 设成 true ⇒ **只留基础组** ✓（其余组整体不渲染 ✓）。
//
// ⚠️ 刻意**不 import 组件里的 `SettingsGroup`** ✗（那会把一个 1500 行的组件拖进判据 ✓）：
//   这里对"组 id"是**泛型**的 ✓，组件那边传自己的联合类型进来即可 ✓。

/** 偏好存哪一步（`localStorage` 与本仓其它界面偏好同一处 ✓，键名带命名空间 ✓）。 */
export const HIDE_ADVANCED_KEY = "shuyonote:settings:hideAdvanced";

/** 只留基础组时，被视为"高级"的那些组（组件侧传入，保持单一出处 ✓）。 */
export function visibleGroups<T extends string>(all: readonly T[], hideAdvanced: boolean, advanced: readonly T[]): T[] {
  if (!hideAdvanced) return [...all]; // ① 默认全显 ✓
  return all.filter((g) => !advanced.includes(g)); // ② 只留基础 ✓
}

/** 读偏好：**读不到 / 抛错 / 没设过 ⇒ false** ✓（⛔ 绝不在读失败时变成"藏起来" ✗）。 */
export function readHideAdvanced(storage?: Pick<Storage, "getItem">): boolean {
  try {
    const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
    return s?.getItem(HIDE_ADVANCED_KEY) === "1";
  } catch {
    return false;
  }
}

/** 写偏好（读失败也不炸 ✓；写不进去只是下次不记得 ✓，⛔ 不影响本次界面 ✓）。
 *  ⚠️ `removeItem` 做成**可选**：判据里只喂 `setItem` 的替身也能过 ✓。 */
export function writeHideAdvanced(
  hide: boolean,
  storage?: Pick<Storage, "setItem"> & Partial<Pick<Storage, "removeItem">>,
): void {
  try {
    const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
    if (hide) s?.setItem(HIDE_ADVANCED_KEY, "1");
    else s?.removeItem?.(HIDE_ADVANCED_KEY);
  } catch {
    /* 存不下就算了 —— 界面照本次选择生效 ✓ */
  }
}
