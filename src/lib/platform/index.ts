// Aggregator for the active Platform implementation.
//
// The app imports `platform` from here and calls its driver methods; it never
// imports @tauri-apps/* directly. Today the implementation is Tauri. A future
// Web / ArkWeb / Android / iOS shell exports its own Platform in a sibling
// module, and `setPlatform` installs it at bootstrap (or a bundler condition /
// entry switch swaps the whole implementation).
import type { Platform } from "./types";
import { tauriPlatform } from "./tauri";

export type { Platform } from "./types";
export type {
  AssetDriver,
  DialogDriver,
  EventDriver,
  Executor,
  OpenerDriver,
  WebviewDriver,
} from "./types";

let current: Platform = tauriPlatform;

/** Replace the active platform implementation (e.g. on Web/native shells). */
export function setPlatform(p: Platform): void {
  current = p;
}

/** The active platform implementation (defaults to the Tauri host). */
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
