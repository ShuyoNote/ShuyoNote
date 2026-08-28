// M24/自动升级 — desktop in-app updater wiring (stage 2). Uses the real
// `@tauri-apps/plugin-updater` on desktop; degrades to "unavailable" on web or
// when the updater isn't configured yet (pubkey/endpoints), so the About dialog
// falls back to the releases-page fetch (stage 1). Not bundled into the smoke
// harness (kept separate from updates.ts for that reason).
import { check as checkUpdater } from "@tauri-apps/plugin-updater";

export type DesktopUpdateResult =
  | { state: "up-to-date"; latest?: undefined; download?: undefined }
  | { state: "update-available"; latest: string; download: () => Promise<void> }
  | { state: "unavailable" };

/** Check for an update via the in-app updater (desktop only). */
export async function checkDesktopUpdate(): Promise<DesktopUpdateResult> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return { state: "unavailable" };
  try {
    const update = await checkUpdater();
    if (!update) return { state: "up-to-date" };
    return {
      state: "update-available",
      latest: update.version,
      download: async () => {
        await update.downloadAndInstall();
      },
    };
  } catch {
    return { state: "unavailable" };
  }
}
