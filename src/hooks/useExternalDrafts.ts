// 把「外部 AI 的写请求」这条事件接到确认／落库那两条岔路上（挂一次，全应用生效 ✓）。
//
// 事件名 `mcp:external-drafts` 由 Rust 那侧发（`src-tauri/src/lib.rs` 里装的出口 ✓）；
// ⚠️ 走 `platform.event.listen`（而不是直接 import Tauri ✗）—— 平台门面里 `event` 这一档
// 两侧都有实现（Tauri ⇒ `tauriListen` ✓；Web ⇒ `window` 的 CustomEvent ✓）⇒ **同一份监听代码** ✓。
//
// ⭐ 2026-10-17（R155 配套）：**独立页窗口（`?page=<id>`）不再应用外部草稿** ✗。
//   原因：事件是 `emit` 给所有窗口的（`src-tauri/src/lib.rs:625`），而独立窗口里也挂着本 hook
//   ⇒ 同一个写入会被主窗口和各页窗口各应用一次（重复追加），且各窗口自己的编辑器状态会互相覆盖。
//   现在：只在主窗口落库；独立窗口只做一件事——**这次改动打到的是我这一页 ⇒ 整窗重载**，
//   免得它拿刷新前的旧状态把主窗口刚写进去的内容盖回去 ✓。
import { useEffect } from "react";
import { platform } from "../lib/platform";
import {
  draftsTouchPage,
  handleExternalDraftsEvent,
  parseExternalDraftsEvent,
  standalonePageIdOf,
} from "../lib/externalDrafts";
import { toast } from "../store/toast";

/** 同一个窗口只排一次重载（事件可能连着来几条）。 */
let reloadScheduled = false;

export function useExternalDrafts(): void {
  useEffect(() => {
    const standaloneId = standalonePageIdOf(window.location.search);
    let unlisten: (() => void) | undefined;
    let alive = true;
    void platform.event
      .listen<unknown>("mcp:external-drafts", (e) => {
        if (standaloneId) {
          // 独立页窗口：不应用（应用只在主窗口做一次），只在"改的是我这一页"时刷新自己。
          const msg = parseExternalDraftsEvent(e?.payload);
          if (!msg || !draftsTouchPage(msg.drafts, standaloneId)) return;
          if (reloadScheduled) return;
          reloadScheduled = true;
          toast("这一页刚被外部写入，正在刷新…", "info");
          // 给主窗口留出"落库 + 播种 CRDT 状态"的时间，再整窗重载；否则可能读到旧状态。
          window.setTimeout(() => window.location.reload(), 1500);
          return;
        }
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
