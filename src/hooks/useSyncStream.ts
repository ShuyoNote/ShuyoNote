// P1.5 SSE change-stream subscription (optional near-realtime push).
// Uses fetch + ReadableStream to read the SSE stream so we can set the Bearer
// token header (native EventSource can't). On any push event we trigger a
// syncWorkspace so the UI refreshes near-realtime instead of waiting for the next
// poll. Desktop builds keep their auto-sync timer (reqwest); this is a no-op there.
import { useEffect } from "react";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { isDesktopPlatform } from "../lib/platform";

export function useSyncStream() {
  const { loadPages } = useNotes();

  useEffect(() => {
    if (isDesktopPlatform()) return;

    let cancelled = false;
    let ctrl: AbortController | null = null;

    (async () => {
      try {
        const profiles = await api.listSyncProfiles();
        const bound = profiles.find((p) => p.server_url && p.space_id && p.token);
        if (!bound) return;
        const url = `${bound.server_url.replace(/\/+$/, "")}/spaces/${encodeURIComponent(bound.space_id)}/changes-stream`;
        ctrl = new AbortController();
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${bound.token}` }, signal: ctrl.signal });
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
            void api.syncWorkspace(bound.ws_id).catch(() => null).then(() => {
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
