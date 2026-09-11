// Tauri host implementation of the Platform drivers. This is the ONLY module
// that imports @tauri-apps/*. It wraps the current behavior exactly, so nothing
// the app does changes — a future Web/ArkWeb/Android/iOS shell implements the
// same interfaces in a sibling module (see ./index.ts).
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { parseNativePageResponse } from "../pdfNativePage";
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
    // E1: all attachment file paths are served through the custom `attachment` scheme,
    // which decrypts at-rest-encrypted attachment bytes in memory (passthrough when off).
    // Tauri resolves the platform-correct URL (Windows: http://attachment.localhost/...).
    convertFileSrc: (path) => tauriConvertFileSrc(path, "attachment"),
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
  pdfRender: {
    renderPdfPage: async (attachmentId, pageIndex, scale) => {
      // 倍率先校验：NaN/Infinity 会被 JSON 编成 null 送到 Rust，也会让画布尺寸变 NaN。
      if (!Number.isFinite(scale) || scale <= 0) {
        throw new Error(`原生 PDF 渲染的缩放倍率无效（scale=${String(scale)}）`);
      }
      // 响应形状按平台/版本都不同（macOS 的原始响应是数字数组、Windows 是 ArrayBuffer、
      // 现在是 {width,height,rgba_base64}），全部交给 parseNativePageResponse 校验后再用。
      const raw = await tauriInvoke<unknown>("render_pdf_page", {
        args: { attachment_id: attachmentId, page_index: pageIndex, scale },
      });
      return parseNativePageResponse(raw);
    },
    nativeAvailable: () => true,
  },
};
