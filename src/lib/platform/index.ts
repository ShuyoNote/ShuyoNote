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

export type { Platform } from "./types";
export type {
  AssetDriver,
  DialogDriver,
  EventDriver,
  Executor,
  OpenerDriver,
  WebviewDriver,
} from "./types";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
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
};
