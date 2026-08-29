// M24 — OCR 兜底 (scanned PDFs without a text layer). Runs tesseract.js on a
// page image and returns recognized text. 已彻底离线：worker 脚本、core wasm、
// 中文/英文 traineddata 均由脚本拷贝进 public/ocr (见 scripts/copy-tesseract-assets.mjs)，
// 运行时不再依赖 jsdelivr CDN。仍保留超时兜底与结构化错误反馈。
// 保持在 smoke 包外（动态 import；OCR 需真实机器 + 语言数据）。

export interface OcrResult {
  /** 识别到的文本（无则为 null）。 */
  text: string | null;
  /** 失败原因：none=成功（可能无文字）；timeout=超时；error=加载/识别失败。 */
  error: "none" | "timeout" | "error";
}

const DEFAULT_TIMEOUT = 60000;

export async function ocrRecognize(
  image: string,
  langs = "chi_sim+eng",
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<OcrResult> {
  if (!image) return { text: null, error: "none" };
  // tesseract worker 非 DOM Worker，用 any 规避其动态类型。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let worker: any = null;
  try {
    const { createWorker } = await import("tesseract.js");

    // 本地打包资源路径（相对应用根，dev 与 Tauri 构建均视为同源可 fetch/importScripts）。
    // 可用 VITE_TESSERACT_CORE_PATH / VITE_TESSERACT_LANG_PATH 覆盖为镜像/自定义资源。
    const base = import.meta.env.BASE_URL || "/";
    const corePath = import.meta.env.VITE_TESSERACT_CORE_PATH as string | undefined;
    const langPath = import.meta.env.VITE_TESSERACT_LANG_PATH as string | undefined;

    const opts: Record<string, unknown> = {
      workerPath: `${base}ocr/worker.min.js`,
      corePath: corePath || `${base}ocr/core`,
      langPath: langPath || `${base}ocr/tessdata`,
      // tesseract 默认 workerBlobURL=true（blob importScripts）；改为直接 new Worker(workerPath)，
      // 更贴近同源本地 worker，减少 blob 限制风险。
      workerBlobURL: false,
      // 每次从本地路径读取模型（不读 IndexedDB 旧缓存），gzip 模型为 .traineddata.gz。
      cacheMethod: "none",
      gzip: true,
    };

    // start 以 resolve 形式返回错误（不 reject），避免超时/后台拒绝成为未捕获异常。
    const start: Promise<OcrResult> = (async (): Promise<OcrResult> => {
      worker = await createWorker(langs, 1, opts);
      const { data } = await worker.recognize(image);
      await worker.terminate();
      worker = null;
      return { text: String(data?.text ?? "").trim() || null, error: "none" };
    })().catch(() => ({ text: null, error: "error" as const }));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      start,
      new Promise<OcrResult>((resolve) => {
        timer = setTimeout(() => resolve({ text: null, error: "timeout" }), timeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });

    if (result.error === "timeout") {
      if (worker) {
        try {
          await worker.terminate();
        } catch {
          /* 忽略：终止失败不影响返回 */
        }
      }
    }
    return result;
  } catch {
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        /* 忽略 */
      }
    }
    return { text: null, error: "error" };
  }
}
