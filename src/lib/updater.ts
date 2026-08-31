// M24/自动升级 — desktop in-app updater wiring (stage 2). Uses the real
// `@tauri-apps/plugin-updater` on desktop; degrades to "unavailable" on web or
// when the updater isn't configured yet (pubkey/endpoints), so the About dialog
// falls back to the releases-page fetch (stage 1). Not bundled into the smoke
// harness (kept separate from updates.ts for that reason).
import { check as checkUpdater } from "@tauri-apps/plugin-updater";

/** Phases of the in-app update flow, surfaced to the UI for feedback. */
export type UpdatePhase = "downloading" | "installing" | "restarting";

/** Progress snapshot pushed to the caller during a download/install. */
export interface UpdateProgress {
  phase: UpdatePhase;
  /** 0–100 while downloading (null when the total size is unknown or during
   * installing/restarting, where the UI falls back to an indeterminate bar). */
  percent: number | null;
}

export type DesktopUpdateResult =
  | { state: "up-to-date"; latest?: undefined; download?: undefined }
  | {
      state: "update-available";
      latest: string;
      download: (onProgress?: (p: UpdateProgress) => void) => Promise<void>;
    }
  | { state: "unavailable"; error?: string };

/** Check for an update via the in-app updater (desktop only). */
export async function checkDesktopUpdate(): Promise<DesktopUpdateResult> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return { state: "unavailable" };
  try {
    const update = await checkUpdater();
    if (!update) return { state: "up-to-date" };
    return {
      state: "update-available",
      latest: update.version,
      download: async (onProgress) => {
        // `emit` and `onEvent` are UI-only views: the actual download + install
        // runs on the Rust side and completes on its own. Any error in the
        // progress channel (Channel / transformCallback path) must NOT be
        // surfaced as "更新失败" — it only affects the progress bar.
        const emit = (phase: UpdatePhase, percent: number | null) => {
          try { onProgress?.({ phase, percent }); } catch { /* progress is cosmetic */ }
        };
        // Download with real byte progress so the UI can show a determinate bar.
        emit("downloading", 0);
        let total = 0;
        let bytes = 0;
        const onEvent = (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => {
          try {
            if (e.event === "Started") {
              total = e.data?.contentLength ?? 0;
              bytes = 0;
              emit("downloading", 0);
            } else if (e.event === "Progress") {
              bytes += e.data?.chunkLength ?? 0;
              emit("downloading", total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : null);
            } else {
              emit("downloading", 100);
            }
          } catch (err) {
            // Never let a progress-callback hiccup interrupt the real update.
            console.warn("[updater] 忽略进度回调异常:", err);
          }
        };
        // Prefer the single-step `downloadAndInstall` (official recommended form).
        try {
          if (typeof (update as any).downloadAndInstall === "function") {
            await update.downloadAndInstall(onEvent as any);
          } else {
            await update.download(onEvent as any);
            await update.install();
          }
        } catch (err) {
          // The installer runs on the Rust side and typically relaunches the app.
          // A JS channel/teardown error (e.g. "f is not a function") appears AFTER
          // the update already succeeded, so treat it as "in progress" rather than
          // a failure — otherwise the UI reports a false negative.
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[updater] downloadAndInstall 报错(更新可能已完成):", err);
          if (/is not a function|cannot read propert|channel|channel/i.test(msg)) {
            emit("restarting", null);
            return;
          }
          throw err;
        }
        emit("restarting", null);
      },
    };
  } catch (e) {
    // Surface the real error for diagnosis instead of silently degrading.
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[updater] checkUpdater failed:", e);
    return { state: "unavailable", error: msg };
  }
}
