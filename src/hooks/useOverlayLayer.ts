// 把一个"可关闭的覆盖层"登记进全局浮层栈（`src/lib/overlayStack.ts`），
// 让 Android 返回键能"优先关掉最上层浮层"。
//
// 用法（挂在浮层组件里，就在 `useOverlayScrollLock` 旁边）：
//
//   const close = useCallback(() => setOpen(false), []);
//   useOverlayScrollLock(open);
//   useOverlayLayer("myDialog", open, close);
//
// 为什么要有 `id`：返回键的验收要靠 `window.__SHUYONOTE_BACK__.ids()` 报出
// "现在栈里是哪几层"，没有名字就只能靠数数，出了问题查不动。
import { useEffect, useRef } from "react";
import { pushOverlay } from "../lib/overlayStack";

export function useOverlayLayer(id: string, open: boolean, close: () => void): void {
  // `close` 通常是内联箭头函数（每次渲染都是新的引用）。把它放进 effect 的依赖里
  // 会让"每次重渲染都注销再登记一次"——栈的顺序会被打乱（那一层会被挪到栈顶）。
  // 所以用 ref 拿最新的闭包，effect 只依赖 `open`。
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    // 登记的一定是"当前最新"的 close：用 ref 间接调用，而不是把 close 本身登记进去。
    return pushOverlay(id, () => closeRef.current());
  }, [id, open]);
}
