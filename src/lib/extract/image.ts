// 图片抽取器：图片 → OCR 文字。
// 契约见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §15。
//
// 这是**第一个 `cost: "gpu"` 的抽取器**，因此它同时是契约 §15.3-7 那条不变量的活样板：
//   「不自建网络客户端：`cost:"gpu"` 的抽取器在 `deps.vision` 缺失时必须立刻 `provider_error`，
//     不许"顺手"读个环境变量自己连——那会让"默认不出网"的承诺失效（§10 红线）。」
//
// ⚠️ 与原型的边界（避免误以为这里是重复实现）：
// 应用里已经有一条 VLM 通道 `src/lib/ai/ocrVision.ts`（注释原文：
// "用「视觉大模型（VLM）」识别页面图片中的文字——对中文/复杂/低清扫描件通常远优于 tesseract"）。
// 本抽取器**不 import 它**，原因是分层的：契约禁止抽取层自建网络栈，而 `ocrVision.ts` 自带
// provider 配置与 `coreFetch`。正确的接法是由**适配器**把 `ocrVision` 包成 `deps.vision` 注入进来
// （那一步属于"接进平台"，不在本文件）。所以提示词在这里是**自带**的，措辞与 `ocrVision.ts` 对齐。
//
// 第二档（VLM 语义描述 → `kind: "caption"`）**刻意不做**：方案 §13 待拍板第 2 项把"图片的第二档
// 要不要进 P1"列为未决，默认值 = P1 只做 OCR、描述留到 P3。

import {
  fail,
  ok,
  type ExtractInput,
  type ExtractResult,
  type Extractor,
} from "./types";

const IMAGE_OCR_ID = "image.ocr@1";

/** 与 `src/lib/ai/ocrVision.ts` 的 PROMPT 对齐：只要文字本身，不要解释与格式标记。 */
export const OCR_PROMPT =
  "请识别这张图片中的所有文字，按阅读顺序原样输出，保留段落与换行。只输出文字本身，不要任何解释、标题或格式标记。";

/** 图片扩展名兜底（mime 常缺失或不可信）。 */
const IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
  ".avif",
];

function extractImageOcr(input: ExtractInput): Promise<ExtractResult> {
  const vision = input.deps.vision;
  // 契约 §15.3-7：没有注入视觉模型就**立刻** provider_error，绝不自己连网。
  if (!vision) {
    return Promise.resolve(
      fail(IMAGE_OCR_ID, "provider_error", "未配置视觉模型（deps.vision 缺失）"),
    );
  }
  const mime = input.mime || "image/png";
  return vision(OCR_PROMPT, input.bytes, mime).then(
    (raw) => {
      const text = String(raw ?? "").trim();
      if (!text) {
        // 合法图片但没字（纯照片、纯图形）⇒ empty，让调度器知道"抽过了但没内容"
        return fail(IMAGE_OCR_ID, "empty", "图片里没有识别到文字");
      }
      // loc 为空：单张图没有页/时间码的概念（契约 §15.2 对 ocr 的规定）
      return ok(IMAGE_OCR_ID, [{ kind: "ocr", text, loc: "" }]);
    },
    (e: unknown) => {
      // **关键**：视觉模型的异常必须转成错误码，不能穿透（契约 §15.3-2）
      const msg = e instanceof Error ? e.message : String(e);
      return fail(IMAGE_OCR_ID, "provider_error", `视觉模型调用失败：${msg}`);
    },
  );
}

export const imageOcrExtractor: Extractor = {
  id: IMAGE_OCR_ID,
  mimes: ["image/*"],
  extensions: IMAGE_EXTENSIONS,
  cost: "gpu",
  extract: async (input: ExtractInput): Promise<ExtractResult> => {
    try {
      return await extractImageOcr(input);
    } catch (e) {
      // 兜底：任何漏网的同步异常也按 internal 返回
      const msg = e instanceof Error ? e.message : String(e);
      return fail(IMAGE_OCR_ID, "internal", msg);
    }
  },
};
