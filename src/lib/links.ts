// M25 P2 — external project-site navigation. This is the **single source of
// truth** for the app's external links (project home / docs / releases / issues)
// and the "allow external navigation" privacy toggle. It is deliberately pure +
// dependency-light so the smoke harness can bundle and assert on it directly —
// the actual URL-opening lives in the About dialog component (which uses the
// platform opener), not here.
import pkg from "../../package.json";

export const APP_NAME = "ShuyoNote";
/** App 中文名，用于"关于"等面向用户的中文界面。 */
export const APP_NAME_ZH = "数友笔记";
export const APP_VERSION: string = pkg.version || "0.0.0";
export const APP_LICENSE = "AGPL-3.0";
export const APP_DESCRIPTION =
  "本地优先 · 类 Notion 的知识管理笔记应用。数据全在本机（SQLite + 附件目录），离线可用。";

export interface LinkItem {
  id: string;
  label: string;
  url: string;
}

const PROJECT_BASE = "https://gitcode.com/shuyo-cn/ShuyoNote";

// Four clean links — no utm/ref/tracking params. Docs/releases/issues points at
// the project site (P2 external static docs site, reusable via M21 wiki export).
export const PROJECT_LINKS: LinkItem[] = [
  { id: "home", label: "项目主页", url: PROJECT_BASE },
  { id: "docs", label: "文档", url: `${PROJECT_BASE}/tree/main/docs` },
  { id: "releases", label: "发布", url: `${PROJECT_BASE}/releases` },
  { id: "issues", label: "问题", url: `${PROJECT_BASE}/issues` },
];

/** Return the external link items (pure, for tests + UI). */
export function linkItems(): LinkItem[] {
  return PROJECT_LINKS;
}

/**
 * Only allow http(s) URLs (blocks javascript:/file:/data:). Returns "" when the
 * URL is not safe to open — the About dialog skips empty results.
 */
export function sanitizeExternalUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "";
}

const EXTERNAL_KEY = "shuyonote-allow-external";
const DEFAULT_ALLOW = true;

/** Whether external project-site navigation is allowed (default on). */
export function getAllowExternal(): boolean {
  try {
    return localStorage.getItem(EXTERNAL_KEY) !== "false";
  } catch {
    // Node/test has no localStorage.
    return DEFAULT_ALLOW;
  }
}

export function setAllowExternal(v: boolean): void {
  try {
    localStorage.setItem(EXTERNAL_KEY, String(v));
  } catch {
    // Ignore in non-browser/test.
  }
}
