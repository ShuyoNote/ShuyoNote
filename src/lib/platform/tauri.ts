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
  pdfRender: {
    renderPdfPage: async (attachmentId, pageIndex, scale) => {
      // 二进制响应：8 字节头 (width:u32 LE, height:u32 LE) + RGBA8。避免 JSON number 数组
      // 对 6.8MB 大页的巨量反序列化（适配页宽后翻页慢的主因）。
      const buf = await tauriInvoke<ArrayBuffer | { bytes: number[]; width: number; height: number }>("render_pdf_page", {
        args: { attachment_id: attachmentId, page_index: pageIndex, scale },
      });
      if (buf instanceof ArrayBuffer) {
        const view = new DataView(buf);
        const width = view.getUint32(0, true);
        const height = view.getUint32(4, true);
        return { bytes: new Uint8Array(buf, 8), width, height };
      }
      // 回退：某些环境若未能返回二进制，则按 JSON 结构解析。
      return {
        bytes: new Uint8Array((buf as { bytes: number[] }).bytes),
        width: (buf as { width: number }).width,
        height: (buf as { height: number }).height,
      };
    },
    nativeAvailable: () => true,
  },
};
