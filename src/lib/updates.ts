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

export const CURRENT_VERSION = APP_VERSION;
