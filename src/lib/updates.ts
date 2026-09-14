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
  /**
   * Android 发版件（APK）的下载地址与字节指纹，取自清单里的
   * `platforms["android-aarch64"]`（**不是**顶层键）。清单里没有这个平台键时是 null
   * ——老清单照常可读，桌面更新不受影响。
   *
   * 为什么是 sha256 而不是 minisign 签名：APK 由 `apksigner` 签在**包内**，没有
   * 旁边那个 `.sig`；Rust 侧只从 `signature`（约定的 `sha256:<hex>`）里剥出 hex。
   * 应用内不安装它，只把地址交给系统浏览器/DownloadManager，安装由系统完成。
   *
   * 两个字段都**不是**"原样带出"：`android_url` 必须是小写 `https://` 开头，
   * `android_sha256` 必须是 `sha256:` + 恰好 64 位 ASCII hex，否则为 null——与 Rust
   * `android_entry()` 逐条同判（含 trim 差异：signature 会 trim，url 不会）。
   */
  android_url: string | null;
  android_sha256: string | null;
}

/** Android 发版件在清单里的平台键（与 Rust 的 `ANDROID_PLATFORM_KEY` 同一个字符串）。 */
export const ANDROID_PLATFORM_KEY = "android-aarch64";

/**
 * `platforms["android-aarch64"].url` → 地址或 null。
 *
 * **逐字抄自 Rust `android_entry()`（`src-tauri/src/updates.rs`）的 `.filter(|u| u.starts_with("https://"))`**：
 * 只认小写 `https://` 前缀，**不做 trim**（`" https://…"` 会被拒），也不看 host。
 * 明文 `http://` 必须在这里就丢掉——弹窗的兜底 `sanitizeExternalUrl` 只要求 `http(s)://`，
 * 所以"清单被投毒时把用户导向明文 HTTP 下载"的闸门就在这一行。
 */
function androidUrl(entry: unknown): string | null {
  const url = (entry as { url?: unknown } | null | undefined)?.url;
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

/**
 * `platforms["android-aarch64"].signature` → 剥掉 `sha256:` 前缀的 64 位 hex，或 null。
 *
 * **逐字抄自 Rust 的 `.and_then(|s| s.trim().strip_prefix("sha256:")).filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))`**：
 * 整体先 trim，前缀小写敏感，其余**恰好 64 位 ASCII hex**（a-f/A-F 都收，即大小写不敏感——
 * 发布脚本产小写，大写只作兼容），`sha256:` 后为空串也算不合规 ⇒ null（不是 `""`）。
 * 六十四位必须是 ASCII：非 ASCII 字符在 Rust 侧会让 `str::len()`（字节数）不等于 64，
 * 在这里也会被 `[0-9a-fA-F]` 拒掉——两侧对**任何**输入都同判。
 */
function androidSha256(entry: unknown): string | null {
  const sig = (entry as { signature?: unknown } | null | undefined)?.signature;
  const stripped = typeof sig === "string" && sig.trim().startsWith("sha256:")
    ? sig.trim().slice("sha256:".length)
    : "";
  return /^[0-9a-fA-F]{64}$/.test(stripped) ? stripped : null;
}

/**
 * Best-effort fetch of the updater manifest (the stable latest.json) so the UI
 * can show release notes. `url` defaults to the stable release channel; returns
 * null on any network/parse failure (offline or not yet reachable).
 *
 * Android 两个字段的产出口径与 Rust `android_entry()` **必须一致**（同一份 latest.json、
 * 同一个平台键，两边结果不同就是 bug）：见上面两个 helper 的逐条对照，反分叉判据在
 * `updates.test.ts`。
 */
export async function fetchUpdateManifest(url: string = LATEST_MANIFEST_URL): Promise<UpdateManifest | null> {
  try {
    const resp = await fetch(url, { method: "GET" });
    if (!resp.ok) return null;
    const j = await resp.json();
    // 浏览器路径读不到 android 条目也无所谓（Web 版不接这条通道）——但形状与校验都要与
    // Rust 侧一致，免得两个平台的返回类型悄悄分叉。
    const android = j?.platforms?.[ANDROID_PLATFORM_KEY];
    return {
      version: typeof j?.version === "string" ? j.version : null,
      notes: typeof j?.notes === "string" ? j.notes : null,
      pub_date: typeof j?.pub_date === "string" ? j.pub_date : null,
      android_url: androidUrl(android),
      android_sha256: androidSha256(android),
    };
  } catch {
    return null;
  }
}

export const CURRENT_VERSION = APP_VERSION;
