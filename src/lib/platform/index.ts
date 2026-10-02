// Aggregator for the active Platform implementation.
//
// The app imports `platform` from here and calls its driver methods; it never
// imports @tauri-apps/* directly. Today the implementation is Tauri. A future
// Web / ArkWeb / Android / iOS shell exports its own Platform and `setPlatform`
// (or environment detection) installs it at bootstrap.
//
// Environment detection: Tauri v2 injects `window.__TAURI_INTERNALS__`. When it
// is absent we assume a plain browser and use the localStorage-backed Web
// platform, so `pnpm dev:web` runs without the Rust backend.
import type { Platform } from "./types";
import { tauriPlatform } from "./tauri";
import { createWebPlatform } from "./web";
import { computeEmailSupported, isMobileUserAgent as isMobileUserAgentPure } from "./capabilities";

export type { Platform } from "./types";
export type {
  AssetDriver,
  DialogDriver,
  EventDriver,
  Executor,
  OpenerDriver,
  WebviewDriver,
  PdfRenderDriver,
} from "./types";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** True when running inside the Tauri desktop shell (vs the plain-browser Web
 *  platform). UI uses this to show explicit "Web 版不支持" degradation hints for
 *  desktop-only features (sync / at-rest encryption / plugins).
 *
 *  ⚠️ 语义是「**有没有 Rust 内核**」，**不是**「是不是桌面操作系统」——Tauri 的
 *  Android/iOS 壳同样为真，而同步 / 加密 / 插件在移动端是要保留的（这正是选 Tauri
 *  原生壳而不是 WebView 壳的理由）。要判断"某个只在桌面存在的功能"，用下面的
 *  `emailSupported()` 这类**具体能力**函数，别拿这个当近似。 */
export function isDesktopPlatform(): boolean {
  return isTauri();
}

/** 纯函数：从 UA 判断移动端操作系统（可单测）。
 *
 *  为什么用 UA 而不是别的：Tauri 没有把 OS 名暴露给页面（`@tauri-apps/plugin-os`
 *  没装），而 `matchMedia("(max-width: 768px)")` 判的是**视口宽度**——桌面端把窗口
 *  拖窄就会误判，两者不是一回事。 */
export function isMobileUserAgent(ua: string): boolean {
  return isMobileUserAgentPure(ua);
}

/**
 * 聚合邮箱是否可用。**桌面专属**（2026-09-13 定）。
 *
 * 它走 `native-tls`（桌面用系统 TLS），Android 上要为此从源码交叉编译一份 OpenSSL；
 * 而 `EmailPanel` 里早就写着「邮箱是**桌面版独有**能力」，只是那条声明当时还没落到移动端。
 *
 * Rust 侧对应边界：`src-tauri/src/lib.rs` 的 `mod email` / `mod smtp` 与 23 个邮箱命令
 * 都带 `#[cfg(desktop)]`，**移动端这些命令不存在**——所以这里返回 false 时前端必须真的别去调，
 * 否则会拿到 "command not found"。判定逻辑在同目录的 `capabilities.ts`（纯函数，可单测）。
 */
export function emailSupported(): boolean {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return computeEmailSupported(isTauri(), ua);
}

let current: Platform = isTauri() ? tauriPlatform : createWebPlatform();

/** Replace the active platform implementation (e.g. on Web/native shells). */
export function setPlatform(p: Platform): void {
  current = p;
}

/** The active platform implementation (auto-detected: Tauri or Web). */
export const platform: Platform = {
  get executor() {
    return current.executor;
  },
  get dialog() {
    return current.dialog;
  },
  get opener() {
    return current.opener;
  },
  get event() {
    return current.event;
  },
  get asset() {
    return current.asset;
  },
  get webview() {
    return current.webview;
  },
  get community() {
    return current.community;
  },
  get pdfRender() {
    return current.pdfRender;
  },
  // ⚠️⚠️ **2026-10-02 补**：这个 getter 原先**漏了** ⇒ 不管底层是 `tauriPlatform`（有 ✓）
  // 还是 `createWebPlatform()`（有 ✓），`platform.derivedStores` **永远是 `undefined`** ✗。
  // 后果不是报错，而是**整条派生层静默不可用**：`AiSettingsForm` 读到 `undefined` ⇒
  // 报「这个平台不提供派生层」⇒「开始索引」按钮不提供、覆盖检查失败 ⇒ 抽取/索引/切块全走不通 ✓
  // ⚠️ 而它**测不出来**：`aiSettingsCoverage.test.tsx` 把 `platform.derivedStores` **mock 掉了** ✗
  // ⇒ 那是**假绿** ✓（本仓最防的"不炸不报错"那类 ✓）；`platformDerivedWiring.test.ts` 测的是
  //   **实现** `tauriPlatform.derivedStores` ✓ —— **门面这一跳没人管** ✗ ⇒ 已在那里补一条断言 ✓。
  // ⭐ 来由：2026-10-02 一次**真机端到端**发现的（设置→AI 报「不提供派生层」）✓ —— 纯单测全绿时它不可见 ✓
  get derivedStores() {
    return current.derivedStores;
  },
};
