// Platform-agnostic capability drivers. Each "driver" is a set of functions the
// frontend needs from its host shell. The Tauri implementation (./tauri.ts) is
// the only place that imports @tauri-apps/* — components and api.ts consume the
// interfaces below, so a future Web / ArkWeb / Android / iOS shell just swaps
// which Platform implementation is installed (see ./index.ts).
//
// M16.0 scope: introduce the interfaces + the Tauri impl, and route every
// existing @tauri-apps/* call through them, without changing behavior.

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

/** M24 — PDF page rendering. Desktop uses native MuPDF; Web degrades to pdf.js. */
export interface PdfRenderDriver {
  /** Render an attachment's PDF page to PNG bytes (native engine when available). */
  renderPdfPage(attachmentId: string, pageIndex: number, scale: number): Promise<Uint8Array>;
  /** Whether a native engine is available on this host. */
  nativeAvailable(): boolean;
}

/** The aggregate of every capability the app expects from its host. */
export interface Platform {
  executor: Executor;
  dialog: DialogDriver;
  opener: OpenerDriver;
  event: EventDriver;
  asset: AssetDriver;
  webview: WebviewDriver;
  pdfRender: PdfRenderDriver;
}
