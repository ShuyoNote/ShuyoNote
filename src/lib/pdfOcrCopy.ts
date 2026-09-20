// 「本页文字识别」浮层的**标题与文案** —— 抽成纯函数，因为这个浮层有两条完全不同的路共用它：
//
//   · 「OCR 识别本页」= 本机 Tesseract（要语言包；首次可能要联网下一次）
//   · 「AI 识别」    = 视觉大模型（要服务商支持图像；没有"语言包"这回事）
//
// 2026-09-20 用户截图报的两件事都出在这里：
//   ① 按的是 **AI 识别**，浮层标题却写「OCR 识别结果」——两条路共用一份硬编码文案；
//   ② 识别中的正文写着"模型随包分发时首次加载稍慢；语言包按需下载时首次还要联网取一次"——
//      那是**打包方式**的内部权衡，不是用户能用的信息；而且 AI 那条路根本没有语言包，纯属误导
//      （AI 失败时还会照着 OCR 的话让人去下 30 MB 语言包）。
//
// 所以这里定两条口径：
//   · 标题与文案**跟着用户按的那个按钮走**（`OcrMode`）；
//   · 正文只放"用户现在该知道/该做什么"，**排查细节降级成第二行**（`hint`，样式更淡）。

export type OcrMode = "ocr" | "ai";

/** 浮层要表达的状态（与组件里那份 state 一一对应）。`idle` 即"正在识别"。 */
export type OcrStatus = "idle" | "empty" | "timeout" | "error" | "error-recognize";

const MODE_LABEL: Record<OcrMode, string> = { ocr: "OCR 识别", ai: "AI 识别" };

/** 浮层标题：识别中 / 已出结果两种态。 */
export function ocrPopoverTitle(mode: OcrMode, busy: boolean): string {
  return busy ? `${MODE_LABEL[mode]}中…` : `${MODE_LABEL[mode]}结果`;
}

/** 顶部按钮的忙碌文案：哪条路在跑就写哪条（别让「OCR 识别本页」顶着"识别中…"替 AI 背锅）。 */
export function ocrBusyButtonLabel(mode: OcrMode): string {
  return mode === "ai" ? "AI 识别中…" : "识别中…";
}

export interface OcrCopy {
  /** 正文：用户此刻需要知道的那一句。 */
  main: string;
  /** 第二行：怎么做 / 排查线索（更淡的字），可以没有。 */
  hint?: string;
}

/**
 * 正文文案。`status === "idle"` 表示"正在识别"（成功出文本时不走这里，直接显示文本）。
 *
 * ⚠️ 两条纪律（判据 `pdfOcrCopy.test.ts` 钉住）：
 *   1. **AI 那条路的任何一句话都不许出现 "OCR" / "语言包" / "Tesseract"** —— 用户按的是 AI，
 *      指路指到语言包上等于把人带沟里；
 *   2. 内部术语（随包分发 / 按需下载 / `VITE_` 环境变量名）不许出现在 `main` 里，
 *      要留就留在 `hint`（那是给排查用的）。
 */
export function ocrPopoverCopy(mode: OcrMode, status: OcrStatus): OcrCopy {
  if (status === "idle") {
    return mode === "ai"
      ? { main: "正在用 AI 识别本页文字…", hint: "首次调用通常慢一些，请稍等。" }
      : { main: "正在识别本页文字…", hint: "首次使用要先下载语言包（约 30 MB），之后就离线可用了。" };
  }

  if (status === "empty") {
    return {
      main: "本页没有识别到文字。",
      hint: "可能是空页、图表页，或扫描不够清晰。换一页正文再试试。",
    };
  }

  if (status === "timeout") {
    return mode === "ai"
      ? {
          main: "AI 识别超时了。",
          hint: "模型服务响应太慢。可以稍后重试，或在设置里换一个更快的视觉模型。",
        }
      : {
          main: "识别超时了。",
          hint: "首次加载模型较慢。可以稍后重试；成功识别过一次之后就快了。",
        };
  }

  if (status === "error-recognize") {
    return {
      main: "识别没能完成：模型已加载，失败出在取图或引擎这一环。",
      hint: "页面图像可能没读到，或位图过大。详见控制台 [ocr] recognize failed。",
    };
  }

  // status === "error"：两条路的失败原因完全不同，别互相抄。
  return mode === "ai"
    ? {
        main: "AI 识别失败。",
        hint:
          "请确认设置里配置的是「支持图像」的模型（如 gpt-4o / qwen-vl / llava），并检查服务地址与 Key。" +
          "具体原因见控制台 [ai] vision ocr failed。",
      }
    : {
        main: "识别没能开始：识别模型/语言包没加载成功。",
        hint:
          "第一次用 OCR 需要联网下载一次语言包（约 30 MB，之后永久离线）；" +
          "离线发行版应随包分发语言包。排查见控制台 [ocr] local assets / [ocr] worker error。",
      };
}
