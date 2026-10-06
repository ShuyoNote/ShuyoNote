// 把「外部 AI 的写请求」这条事件接到确认／落库那两条岔路上（挂一次，全应用生效 ✓）。
//
// 事件名 `mcp:external-drafts` 由 Rust 那侧发（`src-tauri/src/lib.rs` 里装的出口 ✓）；
// ⚠️ 走 `platform.event.listen`（而不是直接 import Tauri ✗）—— 平台门面里 `event` 这一档
// 两侧都有实现（Tauri ⇒ `tauriListen` ✓；Web ⇒ `window` 的 CustomEvent ✓）⇒ **同一份监听代码** ✓。
// ⚠️ 我第一次写成了 `platform.listen` ✗ —— 那**不是**门面上的成员（`tsc` 当场拦下 ✓）；
//    这类"门面漏一跳 ⇒ 运行期静默不可用"的形状，本仓在 `platform.derivedStores` 上真栽过一次 ✓
//    （`src/lib/platform/index.ts:100-108` 的注释逐字记着 ✓）。
import { useEffect } from "react";
import { platform } from "../lib/platform";
import { handleExternalDraftsEvent } from "../lib/externalDrafts";

export function useExternalDrafts(): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    void platform.event
      .listen<unknown>("mcp:external-drafts", (e) => {
        void handleExternalDraftsEvent(e?.payload).catch(() => {
          // 处理里已经各自出声了 ✓；这里只兜住"不该抛"的那一类 ✓
        });
      })
      .then((un) => {
        if (alive) unlisten = un;
        else un();
      })
      .catch(() => {
        // 没有事件总线的形态（Node 冒烟 / 极简 Web 壳）⇒ 这条事件本来也不会来 ✓
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);
}
