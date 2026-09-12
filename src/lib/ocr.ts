// M24 — OCR 兜底 (scanned PDFs without a text layer). Runs tesseract.js on a
// page image and returns recognized text.
//
// 资源分两类，**来源不同**（2026-09-13 起）：
//   · worker 脚本 + core wasm：仍随包分发（`public/ocr/worker.min.js` 与 `core/`，
//     见 scripts/copy-tesseract-assets.mjs）——它们不大，且是"能不能跑起来"的前提；
//   · **语言包（29.6 MiB）改为按需下载**（见 DEFAULT_OCR_LANG_BASE）并缓存在 IndexedDB，
//     因为它在 Android 上会被装两遍（APK assets + .so 内嵌），见上线计划的体积账。
// 提供两种用法：ocrRecognize（一次性）与 createOcrWorker（批量复用同一 worker，避免每页新建）。
// 保持在 smoke 包外（动态 import；OCR 需真实机器 + 语言数据）。

export interface OcrResult {
  /** 识别到的文本（无则为 null）。 */
  text: string | null;
  /** 失败原因：none=成功（可能无文字）；timeout=超时；error=加载/识别失败。 */
  error: "none" | "timeout" | "error";
  /** 失败阶段：load=worker/core/语言模型加载失败；recognize=识别阶段（取图/引擎）失败。 */
  stage?: "load" | "recognize";
  /** 原始错误消息（排查用，不直接面向用户）。 */
  detail?: string;
}

export interface OcrWorkerHandle {
  /** 识别单张图片（每次调用带超时）。
   *  传 `Blob`/`File` 走 FileReader（推荐，无需 fetch，不受 CSP `connect-src` 限制）；
   *  传 string 时 tesseract 会 `fetch()` 它——若为 `blob:`/`asset:` URL，需 CSP `connect-src` 放行。 */
  recognize(image: string | Blob, timeoutMs?: number): Promise<OcrResult>;
  /** 释放底层 worker（幂等）。 */
  terminate(): Promise<void>;
}

const DEFAULT_TIMEOUT = 60000;

/** 把任意抛出物转成可读消息（不要把真实错误吞掉）。 */
function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** 单页 OCR 用的页面重渲染缩放：宁可稍小避免超大位图导致 tesseract 抛错，又能保证基本清晰度（约 2.5× ⇒ ~180 DPI）。 */
export const OCR_PAGE_SCALE = 2.5;

/** 识别参数：对书籍单栏正文使用 PSegMode 6（视为单一文本块），通常优于自动分割。 */
const OCR_RECOGNIZE_OPTIONS: Record<string, string> = { tessedit_pageseg_mode: "6" };

// 首次构造 worker 选项时把实际用到的离线资源路径打印一次，便于排查。
let loggedPaths = false;

/**
 * 语言包（`*.traineddata.gz`）的默认来源。
 *
 * **为什么不打进安装包**：实测（2026-09-13）两个语言包共 29.6 MiB，而 Android 上它们会被
 * **装两遍** —— APK 的 `assets/` 一份、`.so` 里 Tauri 内嵌的前端副本里又一份；桌面安装包
 * 同样带着它们。改为按需下载后：**首次使用 OCR 需要联网一次（约 30 MB），之后由 tesseract
 * 的 IndexedDB 缓存复用，永久离线可用**。
 *
 * 路径里带的是 **tessdata 版本号**（取自 npm 包 `@tesseract.js-data/<lang>/<版本>/`），
 * 所以服务端可以长缓存；换模型版本＝换路径，不会让用户跑着旧模型还看不出来。
 *
 * 托管与头部的规矩见 `docs/nginx-ocr.conf`（含**必须给 CORS** 那条：应用壳的 origin 是
 * `tauri://localhost`，跨域取不到就会在 WebView 里被拦，而 Web 版同源不会暴露这个问题）。
 *
 * 自托管 / 完全离线发行：把语言包放进 `public/ocr/tessdata`，并设
 * `VITE_TESSERACT_LANG_PATH=/ocr/tessdata`；构建脚本侧用 `SHUYONOTE_OCR_BUNDLE=1` 自动拷贝。
 */
export const DEFAULT_OCR_LANG_BASE = "https://shuyo.cn/ocr/tessdata/4.0.0";

function buildWorkerOptions(onWorkerError?: (msg: string) => void): Record<string, unknown> {
  // 本地打包资源路径（dev 与 Tauri 构建均为同源可 fetch/importScripts）。
  // 说明：tesseract.js v7 的 resolvePaths 只做 `new URL(p, location.href)`，**没有** is-url 判断
  // （is-url 分流是 v4/v5 的行为）。这里仍输出绝对 URL，便于日志核对与自定义覆盖，
  // 但它不是成败关键——不要再据此判断「相对路径被判非 URL」。
  // 仍可用 VITE_TESSERACT_CORE_PATH / VITE_TESSERACT_LANG_PATH 覆盖为镜像/自定义资源。
  const base = import.meta.env.BASE_URL || "/";
  const abs = (p: string) => new URL(p, window.location.origin).href;
  const corePath = import.meta.env.VITE_TESSERACT_CORE_PATH as string | undefined;
  const langPath = import.meta.env.VITE_TESSERACT_LANG_PATH as string | undefined;
  const opts: Record<string, unknown> = {
    workerPath: abs(`${base}ocr/worker.min.js`),
    corePath: corePath ? (corePath.includes("://") ? corePath : abs(corePath)) : abs(`${base}ocr/core`),
    // 默认走远端（见 DEFAULT_OCR_LANG_BASE）；给了 VITE_TESSERACT_LANG_PATH 就用它。
    langPath: langPath ? (langPath.includes("://") ? langPath : abs(langPath)) : DEFAULT_OCR_LANG_BASE,
    // tesseract 默认 workerBlobURL=true（blob importScripts）；改为直接 new Worker(workerPath)。
    workerBlobURL: false,
    // ⚠️ **必须缓存**：语言包现在是从网络按需取的，`"write"` = 有缓存用缓存、没有才下载并写入。
    // 这里原先写的是 `"none"`（注释是"每次从本地路径读取模型，不读 IndexedDB 旧缓存"）——
    // 那是模型随包分发时才成立的前提；一旦改为远端，`"none"` 会让**每次 OCR 都重下约 30 MB**。
    // 门禁 scripts/check-ocr-assets.mjs 钉住了这条对应关系。
    cacheMethod: "write",
    gzip: true,
  };
  // tesseract 内部 createWorker 对 load/loadLanguage/initialize 的失败是 `.catch(() => {})` 静默吞掉的，
  // 不传 errorHandler 就只能等我们的超时，完全看不到原因。这里接住它，日志留痕 + 供超时消息引用。
  opts.errorHandler = (e: unknown) => {
    const msg = errText(e);
    onWorkerError?.(msg);
    console.error("[ocr] worker error:", msg);
  };
  if (!loggedPaths) {
    loggedPaths = true;
    console.info("[ocr] local assets:", { workerPath: opts.workerPath, corePath: opts.corePath, langPath: opts.langPath });
  }
  return opts;
}

function recognizeWithTimeout(
  worker: { recognize: (image: string | Blob, opts?: Record<string, string>) => Promise<{ data?: { text?: string } }> },
  image: string | Blob,
  timeoutMs: number,
  opts?: Record<string, string>,
): Promise<OcrResult> {
  const run: Promise<OcrResult> = (async (): Promise<OcrResult> => {
    const { data } = await worker.recognize(image, opts);
    return { text: String(data?.text ?? "").trim() || null, error: "none" };
  })().catch((e: unknown) => {
    // 过去这里把错误整个吞掉（`.catch(() => ({error:'error'}))`），UI 又把 error 一律说成
    // 「无法加载离线识别模型/语言数据」——「取图失败」因此被误判为「模型缺失」，排查方向被带偏。
    // 现在保留真实原因并区分阶段。
    const detail = errText(e);
    console.error("[ocr] recognize failed:", detail);
    return { text: null, error: "error" as const, stage: "recognize" as const, detail };
  });

  return new Promise<OcrResult>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<OcrResult>((r) => {
      timer = setTimeout(() => r({ text: null, error: "timeout" }), timeoutMs);
    });
    Promise.race([run, timeout]).then((r) => {
      if (timer) clearTimeout(timer);
      resolve(r);
    });
  });
}

/** 创建一个可复用的 OCR worker（批量识别复用同一 worker，避免每页重载模型/核心）。 */
export async function createOcrWorker(
  langs = "chi_sim+eng",
  createTimeoutMs = 60000,
): Promise<OcrWorkerHandle> {
  const { createWorker } = await import("tesseract.js");
  // worker 创建（含 core + 模型首次加载）可能较慢/卡住，加超时避免永久"识别中"。
  let timer: ReturnType<typeof setTimeout> | undefined;
  let worker: any;
  // 接住 worker 内部错误：tesseract 会把加载失败的 reject 丢给 errorHandler（未提供则内部 throw），
  // 且 createWorker 自身的 promise 会静默悬挂，所以失败时只能靠这里拿原因 + 超时兜底。
  let lastWorkerError: string | null = null;
  try {
    worker = await Promise.race([
      createWorker(langs, 1, buildWorkerOptions((msg) => { lastWorkerError = msg; })),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(lastWorkerError ? `OCR 模型加载失败：${lastWorkerError}` : "OCR 模型加载超时")),
          createTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return {
    recognize(image: string | Blob, timeoutMs: number = DEFAULT_TIMEOUT) {
      return recognizeWithTimeout(worker, image, timeoutMs, OCR_RECOGNIZE_OPTIONS);
    },
    async terminate() {
      try {
        await worker.terminate();
      } catch {
        /* 忽略：终止失败不影响返回 */
      }
    },
  };
}

/** 一次性识别单张图片（创建→识别→销毁）。
 *  批量场景请用 createOcrWorker 复用 worker。
 *  `image` 建议直接传 `Blob`（走 FileReader；传 string 会被 tesseract `fetch()`，
 *  而 `blob:`/`asset:` URL 需要 CSP `connect-src` 放行，容易在桌面壳里被拦）。 */
export async function ocrRecognize(
  image: string | Blob,
  langs = "chi_sim+eng",
  timeoutMs: number = DEFAULT_TIMEOUT,
): Promise<OcrResult> {
  if (!image) return { text: null, error: "none" };
  let handle: OcrWorkerHandle | null = null;
  try {
    handle = await createOcrWorker(langs);
  } catch (e: unknown) {
    const detail = errText(e);
    console.error("[ocr] worker/model load failed:", detail);
    return { text: null, error: "error", stage: "load", detail };
  }
  try {
    return await handle.recognize(image, timeoutMs);
  } finally {
    await handle.terminate();
  }
}
