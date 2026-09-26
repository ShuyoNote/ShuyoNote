// P1（2026-09-15）：把 **Rust 侧**的附件同步进度接进 `useSyncStatus`。
//
// ## 为什么需要它（这条是"计划里被当成已完成、其实只做了一半"的那一半）
//
// 同步面板里那段 `N/M` 计数与附件进度条**一直在**（`SyncPanel.tsx`），但它只对
// **Web 引擎**有效：`web.ts` 自己会调 `useSyncStatus.setProgress`。
// 而**桌面 / 安卓走 Rust 命令**，那条链上原先**一处进度都没有**
// （全仓 `attCurrent`/`attTotal` 只出现在 `web.ts`）⇒ 面板永远收不到数据，
// 用户看不到"同步在干什么"，只看得到开始与结果。
//
// 现在 Rust 在每传一件附件前 emit 一条 `attachment-sync-progress`
// （见 `src-tauri/src/sync.rs` 的 `AttachmentSyncProgress`），这里把它落进 store。
//
// ⚠️ **挂在 App 级**（和自动同步那一段并列），不挂在 `SyncPanel` 里：
// 自动同步在面板关着的时候也会跑，进度必须照样被记录。
import { useEffect } from "react";
import { platform } from "../lib/platform";
import { useSyncStatus } from "../store/syncStatus";

/** 事件负载。**字段名与 Rust 侧的 `AttachmentSyncProgress` 必须一致**（camelCase）。 */
interface AttachmentSyncProgressEvent {
  phase?: string;
  message?: string;
  attCurrent?: number;
  attTotal?: number;
  attName?: string;
}

export function useSyncProgress() {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    platform.event
      .listen<AttachmentSyncProgressEvent>("attachment-sync-progress", (event) => {
        const p = event.payload ?? {};
        useSyncStatus.getState().setProgress({
          // `setProgress` 会把 `syncing` 置真——这正是我们要的：有一条进度进来，
          // 面板就该进入"正在同步"的形态（并在 B2 补的 `end()` 上正确收尾）。
          phase: "attachments",
          message: p.message || "正在同步附件…",
          attCurrent: p.attCurrent ?? 0,
          attTotal: p.attTotal ?? 0,
          attName: p.attName ?? "",
        });
      })
      .then((fn) => {
        // 注册还没回来组件就卸载了 ⇒ 立刻退订，别留悬挂监听。
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* Web 平台没有 Tauri 事件；`web.ts` 自己会 setProgress，这里静默即可 */
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
