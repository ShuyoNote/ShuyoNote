/** ⭐ **R150**：外部写入之后，那条**陈旧的**待保存该被丢掉 ✗ —— 判定就这一处 ✓（纯函数 ⇒ 判据测得了 ✓）。
 *
 * ## 现场（owner 2026-10-08，逐字读数 ✓）
 *
 * 外部（MCP）往一页追加内容 ⇒ 能力层 `ok=True` ✓、Rust 那侧**确实收到**新内容 ✓（临时探针：json/text 长度都变大 ✓）、
 * 版本历史里也**出现了一条含新内容的快照** ✓ —— 而 **约 0.4 秒后**又出现一条**旧内容**的快照 ✗，
 * 页最终停在旧内容上 ✗（三次重复：+414ms／+420ms／+418ms ✓）。
 * ⇒ 真因：`App.tsx` 里那个 **600ms 去抖的待保存槽**（`pendingSaveRef`）里排着**外部写入之前**的旧补丁 ✗，
 *   到点落库就把外部那份盖回去 ✓。
 *
 * ⇒ 口径：**外部写入之后、同一个页的那条待保存必须丢掉** ✓（它的内容已经旧了 ✗）；
 *   ⚠️ 但**别丢别的页** ✗（用户可能正在别处打字 ✓），也**别永远丢** ✗（窗口过了就恢复正常 ✓ ——
 *   否则用户在这页上的后续编辑会被静默吞掉 ✗，那是比原 bug 更坏的事 ✓）。
 */
export const EXTERNAL_WRITE_WINDOW_MS = 3000;

export function shouldDropPendingSave(
  pending: { pageId: string } | null,
  marker: { pageId: string; atMs: number } | null,
  nowMs: number,
  windowMs: number = EXTERNAL_WRITE_WINDOW_MS,
): boolean {
  if (!pending || !marker) return false;
  if (pending.pageId !== marker.pageId) return false; // 别的页：照常保存 ✓
  return nowMs - marker.atMs <= windowMs; // 窗口内：那条内容已旧 ⇒ 丢 ✓
}
