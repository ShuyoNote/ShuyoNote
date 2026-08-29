// M24 — OCR 兜底 (scanned PDFs without a text layer). Runs tesseract.js on a
// page image and returns recognized text. 已彻底离线：worker 脚本、core wasm、
// 中文/英文 traineddata 均由脚本拷贝进 public/ocr (见 scripts/copy-tesseract-assets.mjs)，
// 运行时不再依赖 jsdelivr CDN。
// 提供两种用法：ocrRecognize（一次性）与 createOcrWorker（批量复用同一 worker，避免每页新建）。
// 保持在 smoke 包外（动态 import；OCR 需真实机器 + 语言数据）。

export interface OcrResult {
  /** 识别到的文本（无则为 null）。 */
  text: string | null;
  /** 失败原因：none=成功（可能无文字）；timeout=超时；error=加载/识别失败。 */
  error: "none" | "timeout" | "error";
}

export interface OcrWorkerHandle {
  /** 识别单张图片（每次调用带超时）。 */
  recognize(image: string, timeoutMs?: number): Promise<OcrResult>;
  /** 释放底层 worker（幂等）。 */
  terminate(): Promise<void>;
}

const DEFAULT_TIMEOUT = 60000;

function buildWorkerOptions(): Record<string, unknown> {
  // 本地打包资源路径（dev 与 Tauri 构建均视为同源可 fetch/importScripts）。
  // 可用 VITE_TESSERACT_CORE_PATH / VITE_TESSERACT_LANG_PATH 覆盖为镜像/自定义资源。
  const base = import.meta.env.BASE_URL || "/";
  const corePath = import.meta.env.VITE_TESSERACT_CORE_PATH as string | undefined;
  const langPath = import.meta.env.VITE_TESSERACT_LANG_PATH as string | undefined;
  return {
    workerPath: `${base}ocr/worker.min.js`,
    corePath: corePath || `${base}ocr/core`,
    langPath: langPath || `${base}ocr/tessdata`,
    // tesseract 默认 workerBlobURL=true（blob importScripts）；改为直接 new Worker(workerPath)。
    workerBlobURL: false,
    // 每次从本地路径读取模型（不读 IndexedDB 旧缓存），gzip 模型为 .traineddata.gz。
    cacheMethod: "none",
    gzip: true,
  };
}

function recognizeWithTimeout(
  worker: { recognize: (image: string) => Promise<{ data?: { text?: string } }> },
  image: string,
  timeoutMs: number,
): Promise<OcrResult> {
  const run: Promise<OcrResult> = (async (): Promise<OcrResult> => {
    const { data } = await worker.recognize(image);
    return { text: String(data?.text ?? "").trim() || null, error: "none" };
  })().catch(() => ({ text: null, error: "error" as const }));

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
): Promise<OcrWorkerHandle> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker(langs, 1, buildWorkerOptions());
  return {
    recognize(image: string, timeoutMs: number = DEFAULT_TIMEOUT) {
      return recognizeWithTimeout(worker, image, timeoutMs);
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
 *  批量场景请用 createOcrWorker 复用 worker。 */
export async function ocrRecognize(
  image: string,
  langs = "chi_sim+eng",
  timeoutMs: number = DEFAULT_TIMEOUT,
): Promise<OcrResult> {
  if (!image) return { text: null, error: "none" };
  let handle: OcrWorkerHandle | null = null;
  try {
    handle = await createOcrWorker(langs);
    return await handle.recognize(image, timeoutMs);
  } catch {
    return { text: null, error: "error" };
  } finally {
    await handle?.terminate();
  }
}
