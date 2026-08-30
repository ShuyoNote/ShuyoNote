// Auto-update stage 1 — pure update-check logic (smoke-testable). The runtime
// fetch (`fetchLatestVersion`) pulls the latest version from the project's
// release channel and degrades gracefully (returns null) on any network/parse
// failure, so the About dialog can show "检查失败" instead of erroring.
import { APP_VERSION } from "./links";

/** Compare two semver strings (parse x.y.z). Returns -1/0/1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.trim().match(/\d+\.\d+\.\d+/);
  const pb = b.trim().match(/\d+\.\d+\.\d+/);
  if (!pa || !pb) return 0;
  const [a1, a2, a3] = pa[0].split(".").map(Number);
  const [b1, b2, b3] = pb[0].split(".").map(Number);
  if (a1 !== b1) return a1 > b1 ? 1 : -1;
  if (a2 !== b2) return a2 > b2 ? 1 : -1;
  if (a3 !== b3) return a3 > b3 ? 1 : -1;
  return 0;
}

export type UpdateState = "update-available" | "up-to-date" | "invalid";

/** Decide the update state from the latest + current version. */
export function updateStatus(latest: string | null, current: string): UpdateState {
  if (!latest) return "invalid";
  const c = compareVersions(latest, current);
  if (c > 0) return "update-available";
  return "up-to-date";
}

export const RELEASES_URL = "https://gitcode.com/shuyo-cn/ShuyoNote/releases";

/** The stable "latest" release channel that always carries the newest metadata. */
export const LATEST_MANIFEST_URL = "https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/latest/latest.json";

/**
 * Dev-only debug hook: appending `?updateDebug=<version>` to the URL forces an
 * "update available" state so the red dot and release-notes panel can be
 * previewed without publishing a real newer release. Returns null in prod (no
 * query param) and when `window` is unavailable (Node/smoke).
 */
export function debugUpdateVersion(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("updateDebug");
}

/** Best-effort fetch of the latest published version; null on failure (offline/parse). */
export async function fetchLatestVersion(url: string = RELEASES_URL): Promise<string | null> {
  try {
    const resp = await fetch(url, { method: "GET" });
    if (!resp.ok) return null;
    const text = await resp.text();
    const found = text.match(/\d+\.\d+\.\d+/g);
    if (!found || found.length === 0) return null;
    found.sort(compareVersions);
    return found[found.length - 1];
  } catch {
    return null;
  }
}

export interface UpdateManifest {
  version: string | null;
  notes: string | null;
  pub_date: string | null;
}

/**
 * Best-effort fetch of the updater manifest (the stable latest.json) so the UI
 * can show release notes. `url` defaults to the stable release channel; returns
 * null on any network/parse failure (offline or not yet reachable).
 */
export async function fetchUpdateManifest(url: string = LATEST_MANIFEST_URL): Promise<UpdateManifest | null> {
  try {
    const resp = await fetch(url, { method: "GET" });
    if (!resp.ok) return null;
    const j = await resp.json();
    return {
      version: typeof j?.version === "string" ? j.version : null,
      notes: typeof j?.notes === "string" ? j.notes : null,
      pub_date: typeof j?.pub_date === "string" ? j.pub_date : null,
    };
  } catch {
    return null;
  }
}

export const CURRENT_VERSION = APP_VERSION;
