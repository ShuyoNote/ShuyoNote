// M24/自动升级 — desktop in-app updater wiring (stage 2). Uses the real
// `@tauri-apps/plugin-updater` on desktop; degrades to "unavailable" on web or
// when the updater isn't configured yet (pubkey/endpoints), so the About dialog
// falls back to the releases-page fetch (stage 1). Not bundled into the smoke
// harness (kept separate from updates.ts for that reason).
import { check as checkUpdater } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UpdateManifest } from "./updates";

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

/** Desktop-only: native fetch of the gitcode `latest.json`.
 *
 * The WebView's browser `fetch` to gitcode is blocked by CORS: gitcode 302s to a
 * `file-cdn.gitcode.com` signature URL whose response carries no
 * `Access-Control-Allow-Origin` for the app origin, so the redirect is denied
 * (`[Error] Cross-origin redirection ...`). This goes through reqwest on the
 * Rust side, which is not subject to CORS and follows the redirect, returning
 * the manifest. Degrades to `null` on failure (offline/not reachable). */
export async function fetchUpdateManifestNative(url?: string): Promise<UpdateManifest | null> {
  try {
    return await invoke<UpdateManifest | null>("fetch_update_manifest", { url });
  } catch (e) {
    console.warn("[updater] native manifest fetch failed:", e);
    return null;
  }
}

/**
 * **Android 应用内更新**：下载 APK（带进度）+ sha256 校验 + 交给系统安装器。
 *
 * 两次 `invoke` 都在 Rust 侧完成（`updates.rs`）：下载走 reqwest 流式落盘、边下边算 hash，
 * 校验不通过就删掉并报错；第二步经 FileProvider + `ACTION_VIEW` 拉起**系统安装器**
 * ——**不是**静默安装，用户在系统界面里确认（Android 8+ 首次还要允许本应用安装应用）。
 *
 * 进度来自 Rust 的 `android-update-progress` 事件；事件订阅失败**不影响**更新本身
 * （只是进度条不动），与桌面那条路同一个取舍。
 */
export async function installAndroidUpdate(
  url: string,
  sha256: string,
  onProgress?: (p: UpdateProgress) => void,
): Promise<string> {
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<{ done: number; total: number; percent: number }>(
      "android-update-progress",
      (e) => {
        try {
          const pct = Math.max(0, Math.min(100, Math.round(e.payload?.percent ?? 0)));
          onProgress?.({ phase: "downloading", percent: pct });
        } catch {
          // 进度是装饰，回调出问题不能打断真正的下载。
        }
      },
    );
  } catch (e) {
    console.warn("[updater] android progress subscribe failed:", e);
  }
  try {
    const path = await invoke<string>("download_android_update", { url, sha256 });
    onProgress?.({ phase: "installing", percent: null });
    await invoke("install_android_update", { path });
    return path;
  } finally {
    unlisten?.();
  }
}

/** Check for an update via the in-app updater (desktop only). */
export async function checkDesktopUpdate(): Promise<DesktopUpdateResult> {  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return { state: "unavailable" };
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
