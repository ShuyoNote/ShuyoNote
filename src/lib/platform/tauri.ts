// Tauri host implementation of the Platform drivers. This is the ONLY module
// that imports @tauri-apps/*. It wraps the current behavior exactly, so nothing
// the app does changes — a future Web/ArkWeb/Android/iOS shell implements the
// same interfaces in a sibling module (see ./index.ts).
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { convertFileSrc as tauriConvertFileSrc } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWebview as tauriGetCurrentWebview } from "@tauri-apps/api/webview";
import { open as tauriDialogOpen, save as tauriDialogSave } from "@tauri-apps/plugin-dialog";
import {
  openPath as tauriOpenPath,
  openUrl as tauriOpenUrl,
  revealItemInDir as tauriRevealItemInDir,
} from "@tauri-apps/plugin-opener";
import type { Platform } from "./types";

export const tauriPlatform: Platform = {
  executor: {
    invoke: (cmd, args) => tauriInvoke(cmd, args),
  },
  dialog: {
    open: (options) => tauriDialogOpen(options),
    save: (options) => tauriDialogSave(options),
  },
  opener: {
    openUrl: (url) => tauriOpenUrl(url),
    openPath: (path) => tauriOpenPath(path),
    revealItemInDir: (path) => tauriRevealItemInDir(path),
  },
  event: {
    listen: (event, handler) => tauriListen(event, handler),
  },
  asset: {
    convertFileSrc: (path) => tauriConvertFileSrc(path),
  },
  webview: {
    onDragDropEvent: (handler) =>
      // The Tauri drag-drop payload differs per event type (e.g. "over" has no
      // `paths`), so its raw event type won't match our narrow handler. Cast to
      // the app's shape; runtime behavior is identical (we only read `.type`
      // and, on "drop", `.paths`).
      tauriGetCurrentWebview().onDragDropEvent(
        (e) =>
          handler(e as unknown as { payload: { type: string; paths: string[] } }),
      ),
  },
};
