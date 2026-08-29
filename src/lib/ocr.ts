// M24 — OCR 兜底 (scanned PDFs without a text layer). Runs tesseract.js on a
// page image and returns recognized text. tesseract.js 默认从 jsdelivr CDN 下载
// core wasm 与语言 traineddata——受限网络下会长时间挂起，UI 一直"识别中"。这里：
//  - 加超时兜底：超时即终止 worker 并返回明确错误，不再无限等待；
//  - 允许经 VITE_TESSERACT_CORE_PATH / VITE_TESSERACT_LANG_PATH 指定可达的镜像或本地资源；
//  - 失败/超时返回结构化错误，由调用方给出用户可读的提示。
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
    // 可选：受限网络指向可达镜像/本地资源；不设则用 tesseract 默认（jsdelivr CDN）。
    const corePath = (import.meta.env.VITE_TESSERACT_CORE_PATH as string | undefined) || undefined;
    const langPath = (import.meta.env.VITE_TESSERACT_LANG_PATH as string | undefined) || undefined;
    const opts: Record<string, string> = {};
    if (corePath) opts.corePath = corePath;
    if (langPath) opts.langPath = langPath;

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
