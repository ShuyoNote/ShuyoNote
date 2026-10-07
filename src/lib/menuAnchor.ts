// 「⋯ 更多」菜单的**锚点计算**（纯规则 ⇒ 可单测 ✓）。
//
// 来由（owner 2026-10-07：「**更多弹窗弹出位置不对**」✗，附图里菜单飘在窗口右上、
//   盖在「目录」面板上 ✓）：那条菜单是 `position: fixed` ＋ **写死的 `top: 34px; right: 8px`** ✗
//   ⇒ 它锚的是**视口右上角**，而不是那颗 `⋯` 按钮 ✓ ⇒ 按钮在哪都一样飘 ✓。
//
// ⚠️ 为什么**不**改成 `position: absolute`（那是最直觉的修法 ✗）：工具栏自己有 `overflow`
//   收口，`absolute` 会被**裁掉** ✓ —— 当初写 `fixed` 多半就是撞过这个 ✗。
//   ⇒ 保留 `fixed` ✓，但把位置**按按钮的实际矩形算出来** ✓（并夹在视口内 ✓，别跑到屏幕外 ✗）。
export interface MenuAnchor {
  top: number;
  right: number;
}

/**
 * 菜单锚点：右边缘与按钮**右对齐** ✓、上边缘落在按钮下方 6px ✓；并且**夹在视口内** ✓。
 * `menuW` 传 0 表示"还不知道菜单多宽"⇒ 只做右/上两边的夹取 ✓（菜单自带 `min-width` ✓）。
 */
export function menuAnchor(btn: { top: number; bottom: number; right: number }, winW: number, winH: number, menuW = 0, gap = 6): MenuAnchor {
  const right = Math.max(4, Math.min(winW - btn.right, Math.max(0, winW - Math.max(menuW, 0) - 4)));
  const top = Math.max(4, Math.min(btn.bottom + gap, Math.max(4, winH - 8)));
  return { top: Math.round(top), right: Math.round(right) };
}
