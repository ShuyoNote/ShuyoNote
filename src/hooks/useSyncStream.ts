// P1.5 SSE change-stream subscription (optional near-realtime push).
// Uses fetch + ReadableStream to read the SSE stream so we can set the Bearer
// token header (native EventSource can't). On any push event we trigger a
// syncWorkspace so the UI refreshes near-realtime instead of waiting for the next
// poll. Desktop builds keep their auto-sync timer (reqwest); this is a no-op there.
//
// ⚠️ 第 45 轮修：订的是**当前工作空间**那条绑定，不是"第一个绑定过的档案"。
//    旧写法 `profiles.find(p => p.server_url && p.space_id && p.token)` 在多工作空间下会
//    **订到别的空间**（推来的变更触发的是别人的 syncWorkspace）—— 与 claim 那条
//    "把本地工作空间 id 当远端 space_id 发"是**同一类**错（挑错档案）。
//    解析复用 `crdt/claimScope.ts` 的**唯一一处** `resolveWorkspaceSyncScope`。
import { useEffect } from "react";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { isDesktopPlatform } from "../lib/platform";
import { resolveWorkspaceSyncScope, type ClaimScopeRow } from "../lib/crdt/claimScope";

export function useSyncStream() {
  const { loadPages } = useNotes();

  useEffect(() => {
    if (isDesktopPlatform()) return;

    let cancelled = false;
    let ctrl: AbortController | null = null;

    (async () => {
      try {
        const wsId = await api.getActiveWorkspaceId();
        const profiles = await api.listSyncProfiles();
        // ⚠️ 解析结果为空（没绑定／没选空间）⇒ **什么都不做**（退回轮询），不是错误。
        const scope = resolveWorkspaceSyncScope(profiles as ClaimScopeRow[], wsId);
        if (!scope) return;
        const url = `${scope.server}/spaces/${encodeURIComponent(scope.spaceId)}/changes-stream`;
        ctrl = new AbortController();
        // ⚠️ 令牌用**档案里那份**（与旧行为一致）：会话表里那份更"新"，但这一层拿不到它
        //    （`getAuthSession` 在平台层内部）—— 令牌过期时这段会 401，然后**安静退回轮询**。
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${scope.token}` }, signal: ctrl.signal });
        if (!resp.ok || !resp.body) return;
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        // Read SSE frames (data: <json>\n\n); on each, trigger a syncWorkspace.
        for (;;) {
          const { done, value } = await reader.read();
          if (cancelled || done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            if (!frame.includes("data:")) continue;
            // ★ 同步的是**当前工作空间**（解析出来那一个），不是"档案里第一个"。
            void api.syncWorkspace(wsId).catch(() => null).then(() => {
              if (!cancelled) void loadPages();
            });
          }
        }
      } catch {
        /* stream best-effort; falls back to poll */
      }
    })();

    return () => {
      cancelled = true;
      ctrl?.abort();
    };
  }, [loadPages]);
}
