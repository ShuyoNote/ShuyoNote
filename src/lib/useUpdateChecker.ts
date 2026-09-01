import { useEffect } from "react";
import { useEditorStore } from "../store/editor";
import { checkDesktopUpdate } from "./updater";
import { APP_VERSION } from "./links";
import { debugUpdateVersion, compareVersions } from "./updates";

// The stable "latest" release channel that always carries the newest metadata.
const LATEST_ENDPOINT = "https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/latest/latest.json";

export const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function normVer(v: string | null | undefined): string {
  return (v ?? "").match(/\d+\.\d+\.\d+/)?.[0] ?? (v ?? "");
}

/** Desktop fallback: compare against the gitcode release channel (install bundle). */
async function detectFromGitcode(): Promise<{ available: boolean; latest: string | null }> {
  try {
    const resp = await fetch(LATEST_ENDPOINT, { method: "GET" });
    if (!resp.ok) return { available: false, latest: null };
    const j = await resp.json();
    const latest: string | null = j?.version ?? null;
    if (!latest) return { available: false, latest: null };
    const lv = normVer(latest), cur = normVer(APP_VERSION);
    return { available: compareVersions(lv, cur) > 0, latest: lv };
  } catch {
    return { available: false, latest: null };
  }
}

/**
 * Web 版：读服务器「部署版本」version.json，与当前构建版本对比。
 * 与桌面版不同——桌面更新=下载安装包；Web 更新=服务器新静态文件，
 * 所以对比源是服务器上实际部署的版本（而非 gitcode 发布渠道），
 * 有新版即提示「刷新页面」加载。
 *
 * 取版本必须绕开缓存：`cache: "no-store"` 保证不吃浏览器 HTTP 缓存
 * （旧的 404 也会被启发式缓存，导致部署后仍报「未部署」），URL 相对
 * `document.baseURI` 解析，子路径挂载（/app/）与深层路由都能取对。
 * 失败时回传 `error`（HTTP 状态 / 异常原因），UI 直接显示真实原因。
 */
export async function detectFromDeployed(): Promise<{
  available: boolean;
  latest: string | null;
  error?: string;
}> {
  const href =
    typeof document !== "undefined" && document.baseURI
      ? new URL("version.json", document.baseURI).href
      : "version.json";
  try {
    const resp = await fetch(href, { method: "GET", cache: "no-store" });
    if (!resp.ok) return { available: false, latest: null, error: `HTTP ${resp.status}` };
    let j: unknown;
    try {
      j = await resp.json();
    } catch {
      return { available: false, latest: null, error: "响应不是 JSON（可能被 SPA 回退成 index.html）" };
    }
    const latest: string | null = (j as { version?: string } | null)?.version ?? null;
    if (!latest) return { available: false, latest: null, error: "JSON 缺少 version 字段" };
    const lv = normVer(latest), cur = normVer(APP_VERSION);
    return { available: compareVersions(lv, cur) > 0, latest: lv };
  } catch (e) {
    return { available: false, latest: null, error: `请求失败：${String((e as Error)?.message ?? e)}` };
  }
}

/** Try the in-app updater (desktop) / server version.json (web). */
async function detectUpdate(): Promise<{ available: boolean; latest: string | null }> {
  // Dev-only debug hook: append ?updateDebug=<version> (e.g. ?updateDebug=9.9.9)
  // to force "an update is available" so the red dot + upgrade panel can be
  // previewed without publishing a real newer release. Never affects prod.
  const dbg = debugUpdateVersion();
  if (dbg) return { available: true, latest: dbg };

  if (isDesktop()) {
    // Desktop in-app updater is authoritative.
    const up = await checkDesktopUpdate();
    if (up.state === "update-available") return { available: true, latest: up.latest };
    if (up.state === "up-to-date") return { available: false, latest: null };
    // updater unavailable → degrade to the gitcode release channel.
    return detectFromGitcode();
  }
  // Web 版：对比服务器部署版本。
  return detectFromDeployed();
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
