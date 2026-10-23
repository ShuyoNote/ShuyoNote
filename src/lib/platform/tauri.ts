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
import { desktopDerivedStores } from "./derivedStores";

export const tauriPlatform: Platform = {
  executor: {
    invoke: (cmd, args) => tauriInvoke(cmd, args),
  },
  // 派生层（索引）的写入通道：桌面库是 SQLCipher、连接在 Rust 手里 ⇒ 只能过命令面。
  // 适配器的语义与纪律见 ../platform/derivedStores.ts 与 Rust derived_transport.rs。
  derivedStores: () => desktopDerivedStores({ invoke: (cmd, args) => tauriInvoke(cmd, args) }),
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
    /**
     * 桌面端正文里存的是**真实文件路径**（`save_image` 返回它）⇒ 本来就持久，原样返回即可。
     * ⚠️ 万一是 web 那份稳定引用 `asst:<hash>`（同一个空间在两端口径混过），这里**解析不了** ⇒
     * 回空串，让界面画占位框 —— ⛔ 不要把 `asst:…` 当路径喂给 `convertFileSrc`（会得到一个坏 URL）。
     */
    resolveRef: async (src) => (src.startsWith("asst:") ? "" : src),
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
    renderPdfPage: async (attachmentId, pageIndex, scale, rect) => {
      // 倍率先校验：NaN/Infinity 会被 JSON 编成 null 送到 Rust，也会让画布尺寸变 NaN。
      if (!Number.isFinite(scale) || scale <= 0) {
        throw new Error(`原生 PDF 渲染的缩放倍率无效（scale=${String(scale)}）`);
      }
      // ⭐ D1b：`rect` 是**可选**的（`[x, y, w, h]`，页面 pt、左上角原点）。
      // ⚠️ 每项都要先过一遍有限性 —— 否则 NaN 会被 JSON 编成 null，Rust 那边看到的是
      //    "形状不对"而不是"数值不对"，报错会指错方向（前端这条闸门就是干这个的）。
      if (rect && !rect.every((v) => Number.isFinite(v))) {
        throw new Error(`原生 PDF 渲染的矩形无效（rect=${JSON.stringify(rect)}）`);
      }
      // 响应形状按平台/版本都不同（macOS 的原始响应是数字数组、Windows 是 ArrayBuffer、
      // 现在是 {width,height,rgba_base64}），全部交给 parseNativePageResponse 校验后再用。
      const raw = await tauriInvoke<unknown>("render_pdf_page", {
        // ⚠️ 不带 rect 时**不要**塞一个 `rect: undefined` 进去：那会让旧后端把它当"显式给了"
        //    （虽然 serde 会解成 None，但没必要让报文变大/让旧版判据看到多余字段）。
        args: rect
          ? { attachment_id: attachmentId, page_index: pageIndex, scale, rect }
          : { attachment_id: attachmentId, page_index: pageIndex, scale },
      });
      return parseNativePageResponse(raw);
    },
    nativeAvailable: () => true,
  },
  community: {
    // 走原生抓取：CORS 在 WebView 里会把 401/404 变成一句 "Failed to fetch"，
    // 而原生那条路（reqwest）没有这个问题，状态码能如实上报。
    fetchPost: (url) => tauriInvoke("fetch_community_post", { url }),
    fetchDocument: (url) => tauriInvoke("fetch_community_json", { url }),
  },
};
