// Platform-agnostic capability drivers. Each "driver" is a set of functions the
// frontend needs from its host shell. The Tauri implementation (./tauri.ts) is
// the only place that imports @tauri-apps/* — components and api.ts consume the
// interfaces below, so a future Web / ArkWeb / Android / iOS shell just swaps
// which Platform implementation is installed (see ./index.ts).
//
// M16.0 scope: introduce the interfaces + the Tauri impl, and route every
// existing @tauri-apps/* call through them, without changing behavior.

import type { ChunkStore } from "../extract/chunkStore";
import type { AttachmentTextStore } from "../extract/store";

/** 「全库 AI 覆盖」索引要的那对 store（与 `indexPage.ts::IndexPageStores` 同形）。 */
export interface IndexPageStores {
  text: AttachmentTextStore;
  chunks: ChunkStore;
}

/** The bridge used to invoke backend commands (Tauri `invoke`). */
export interface Executor {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

export interface DialogFilter {
  name: string;
  extensions: string[];
}

/** Native file-open / file-save dialogs. */
export interface DialogDriver {
  open(options: {
    title?: string;
    multiple?: boolean;
    directory?: boolean;
    filters?: DialogFilter[];
  }): Promise<string | string[] | null>;
  save(options: {
    title?: string;
    defaultPath?: string;
    filters?: DialogFilter[];
  }): Promise<string | null>;
}

/** Open external resources in the host OS. */
export interface OpenerDriver {
  openUrl(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  revealItemInDir(path: string): Promise<void>;
}

/** Subscribe to backend-emitted events. */
export interface EventDriver {
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void>;
}

/** Convert a local file path into a loadable asset URL. */
export interface AssetDriver {
  convertFileSrc(path: string): string;
}

/** Host-webview APIs (e.g. OS drag-and-drop onto the window). */
export interface WebviewDriver {
  onDragDropEvent(
    handler: (event: { payload: { type: string; paths: string[] } }) => void,
  ): Promise<() => void>;
}

/** M24 — a rendered PDF page: raw RGBA8 samples + dimensions. */
export interface PdfRenderedPage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** 页面上一块矩形：`[x, y, w, h]`，单位**页面 pt、左上角为原点**（前端习惯的坐标系）。 */
export type PdfPageRect = [number, number, number, number];

/** M24 — PDF page rendering. Desktop uses native MuPDF; Web degrades to pdf.js. */
export interface PdfRenderDriver {
  /**
   * Render an attachment's PDF page to RGBA samples (native engine when available).
   *
   * ⭐ **D1b（2026-10-15）**：`rect` 可选 —— 给了就**只渲染那一块**（`PdfPageRect`，pt、左上角原点），
   * 返回的 `width/height` 就是那一块的像素尺寸。
   *
   * 为什么要它：D1 的读数说**过桥成本 ∝ 载荷字节数**（约 0.55 ms/KB）⇒ 可见区域（实测约占整页
   * 3.8%）只出那一块 ⇒ 载荷按面积缩小 ⇒ "送过去"那段同比例缩小。
   *
   * ⚠️ 契约：引擎做不到时必须 **reject**（不许静默给整页）⇒ 调用方（D2）据此**退回整页那条路**
   * （再调一次、不带 `rect`），⛔ 而不是把整页图当成一块贴上去（那会静默错位）。
   * 实现侧：桌面走 `renderPdfPageRect` 那条命令参数；Web（pdf.js）忽略它 ⇒ 靠上面的 reject 兜底。
   */
  renderPdfPage(
    attachmentId: string,
    pageIndex: number,
    scale: number,
    rect?: PdfPageRect,
  ): Promise<PdfRenderedPage>;
  /** Whether a native engine is available on this host. */
  nativeAvailable(): boolean;
}

/** The aggregate of every capability the app expects from its host. */
/** 社区帖子（与 Rust `community::CommunityPost` 同形）。 */
export interface CommunityPostDto {
  id: string;
  title: string;
  bodyMarkdown: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  url: string;
}

export interface CommunityDriver {
  /** 抓一篇帖子。**不做任何写入**——落库由"预览 → 确认"那一步决定。 */
  fetchPost(url: string): Promise<CommunityPostDto>;
  /** 抓一份社区托管的 JSON 文档（模板文件那类），返回**原文**：形状校验在调用方。 */
  fetchDocument(url: string): Promise<string>;
}

export interface Platform {
  executor: Executor;
  dialog: DialogDriver;
  opener: OpenerDriver;
  event: EventDriver;
  asset: AssetDriver;
  webview: WebviewDriver;
  pdfRender: PdfRenderDriver;
  /** 社区帖子抓取（桌面走原生命令；Web 走浏览器 fetch，受 CORS 约束）。 */
  community: CommunityDriver;
  /**
   * 派生文本层的两个 store（「全库 AI 覆盖」的索引要用）。**可选** ——
   * 只有能写派生层的平台才实现：桌面走 `derived_apply`/`derived_query`（`derivedStores.ts`），
   * Web 走自家 sql.js store。**没实现的平台，调用方必须把「开始索引」当成不可用**
   * （界面不许承诺部署做不到的事）。
   *
   * 为什么放在 `Platform` 上、而不是让调用方自己拼：Web 的 `SqliteStore` 实例只活在
   * `web.ts` 内部（`getSharedStore()`），外面拿不到 ⇒ 不从这里出，Web 侧永远没有 store 可用。
   */
  derivedStores?(): IndexPageStores | Promise<IndexPageStores>;
}
