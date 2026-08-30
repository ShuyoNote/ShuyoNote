import { useEffect } from "react";
import { useEditorStore } from "../store/editor";
import { checkDesktopUpdate } from "./updater";
import { APP_VERSION } from "./links";
import { debugUpdateVersion } from "./updates";

// The stable "latest" release channel that always carries the newest metadata.
const LATEST_ENDPOINT = "https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/latest/latest.json";

/** Try the in-app updater; fall back to pinging the stable latest.json endpoint. */
async function detectUpdate(): Promise<{ available: boolean; latest: string | null }> {
  // Dev-only debug hook: append ?updateDebug=<version> (e.g. ?updateDebug=9.9.9)
  // to force "an update is available" so the red dot + upgrade panel can be
  // previewed without publishing a real newer release. Never affects prod.
  const dbg = debugUpdateVersion();
  if (dbg) return { available: true, latest: dbg };
  // 1) Desktop in-app updater is authoritative.
  const up = await checkDesktopUpdate();
  if (up.state === "update-available") {
    return { available: true, latest: up.latest };
  }
  if (up.state === "up-to-date") {
    return { available: false, latest: null };
  }
  // 2) Degrade to the stable release channel (works on web too).
  try {
    const resp = await fetch(LATEST_ENDPOINT, { method: "GET" });
    if (!resp.ok) return { available: false, latest: null };
    const j = await resp.json();
    const latest: string | null = j?.version ?? null;
    if (!latest) return { available: false, latest: null };
    const cur = (APP_VERSION || "").match(/\d+\.\d+\.\d+/)?.[0] ?? APP_VERSION;
    const lv = (latest || "").match(/\d+\.\d+\.\d+/)?.[0] ?? latest;
    const cmp = (a: string, b: string) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
        if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
      }
      return 0;
    };
    return { available: cmp(lv, cur) > 0, latest: lv };
  } catch {
    return { available: false, latest: null };
  }
}

/**
 * Check for an update on app start and reflect "a newer version is available" in
 * the editor store, so the UI can show a red dot (badge) without blocking.
 */
export function useUpdateChecker() {
  useEffect(() => {
    let cancelled = false;
    void detectUpdate().then((r) => {
      if (cancelled) return;
      useEditorStore.getState().setUpdateAvailable(r.available, r.latest);
    });
    return () => {
      cancelled = true;
    };
  }, []);
}
