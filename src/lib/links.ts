// M25 P2 — external project-site navigation. This is the **single source of
// truth** for the app's external links (project home / docs / releases / issues)
// and the "allow external navigation" privacy toggle. It is deliberately pure +
// dependency-light so the smoke harness can bundle and assert on it directly —
// the actual URL-opening lives in the About dialog component (which uses the
// platform opener), not here.
import pkg from "../../package.json";

export const APP_NAME = "ShuyoNote";
export const APP_VERSION: string = pkg.version || "0.0.0";
export const APP_LICENSE = "AGPL-3.0";

export interface LinkItem {
  id: string;
  label: string;
  url: string;
}

const PROJECT_BASE = "https://gitcode.com/shuyo-cn/ShuyoNote";
/** 产品官网（国内主站；README「在线试用」里那条自托管主站的域名）。 */
const PRODUCT_SITE = "https://shuyo.cn/";

// 四个干净链接 —— 不带 utm/ref/tracking 参数。
// ⚠️ 2026-09-22：**加「产品官网」、去掉「文档」**。
//    文档原来指向仓库里的 `tree/main/docs`，那是给**贡献者**看的（源码目录树），
//    对"我刚装上这是什么/能干什么"的普通用户没有用；产品官网才是那一类入口。
//    仓库本身仍在下一个链接（项目主页）里，贡献者一步可达。
export const PROJECT_LINKS: LinkItem[] = [
  { id: "site", label: "产品官网", url: PRODUCT_SITE },
  { id: "home", label: "项目主页", url: PROJECT_BASE },
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

/**
 * 「打开一个外部网站」的**纯决策**（不碰平台、不弹提示）—— 真总闸的判定就在这里，
 * 出口只有一个：`src/lib/openExternal.ts` 的 `openExternalUrl`。
 *
 * 为什么要拆成纯函数：这段逻辑要能被 `scripts/smoke-web.mjs` 直接打（它只 bundle 纯模块），
 * 也要能不依赖 WebView 单测。**调用点不许自己判** —— 各处自己写一遍 `if (!getAllowExternal())`
 * 正是这个开关以前只盖住 1/7 个外链面（关于页四个链接）的原因。
 */
export type ExternalOpenDecision =
  /** 允许打开，`url` 已过白名单（只有 http/https）。 */
  | { kind: "open"; url: string }
  /** 总闸关着 ⇒ 不打开，但**必须把原因说出来**（不许静默无反应）。 */
  | { kind: "blocked" }
  /** 不是 http(s)（`javascript:` / `file:` / `data:` / 相对路径…）⇒ 根本不打开。 */
  | { kind: "unsafe" };

export function decideExternalOpen(raw: string, allowed: boolean = getAllowExternal()): ExternalOpenDecision {
  const url = sanitizeExternalUrl(raw);
  if (!url) return { kind: "unsafe" };
  if (!allowed) return { kind: "blocked" };
  return { kind: "open", url };
}

/** 被拦下时给用户的那句话（**统一措辞**，别让每个调用点自己编一句）。 */
export function externalOpenNotice(d: ExternalOpenDecision): string {
  if (d.kind === "blocked") {
    return "已关闭外部跳转：设置里「允许跳转到外部项目网站」打开后才能跳。本地文件与离线功能不受影响。";
  }
  if (d.kind === "unsafe") return "这个链接不是 http(s) 地址，不打开。";
  return "";
}
