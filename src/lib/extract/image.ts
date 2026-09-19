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
// 第二档（VLM 语义描述 → `kind: "caption"`）：**2026-09-19 落地**。
// 方案 §13 待拍板第 2 项（"图片的第二档要不要进 P1"）已按"现在就做"处置，
// 且 §13 第 7 项的政策是**只许本机推理** —— 所以这一档与 OCR 一样，靠注入的 `deps.vision`
// 工作；本机没跑视觉模型时它返回 `provider_error`，**不会**自己去找云端。
//
// 与 OCR 的关系是**兜底链**（`pipeline.ts` 只对 `unsupported` / `empty` 换下一个候选）：
//   `image.ocr@1`（有文字 ⇒ 采用）→ 空了才轮到 `image.caption@1`（照片/纯图形 ⇒ 描述）。
// ⇒ 一张**带文字的**图今天只出 OCR 文本、不出描述；这条取舍写在 registry 的注册处。

import {
  fail,
  ok,
  type ExtractInput,
  type ExtractResult,
  type Extractor,
} from "./types";

const IMAGE_OCR_ID = "image.ocr@1";
const IMAGE_CAPTION_ID = "image.caption@1";

/** 与 `src/lib/ai/ocrVision.ts` 的 PROMPT 对齐：只要文字本身，不要解释与格式标记。 */
export const OCR_PROMPT =
  "请识别这张图片中的所有文字，按阅读顺序原样输出，保留段落与换行。只输出文字本身，不要任何解释、标题或格式标记。";

/**
 * 语义描述的提示词。四条措辞都是刻意的，改之前先读理由：
 *  1. **一到两句** —— 这段文本要进检索层（`kind: "caption"`），长描述会把块的语义摊薄；
 *  2. **优先名词与数字**（对象/场景/图表类型与关键数值或文字）—— 检索命中的就是这些；
 *  3. **只描述确实看到的** ＋ **看不清就直说看不清** —— 与"不许凭空造数据"同一条纪律
 *     （xlsx 日期那条也是这个理由：猜错比如实给出更糟，而用户看不出来）；
 *  4. **只输出描述本身** —— 免得模型加上"这张图片显示…"这类壳，白占检索文本。
 */
export const CAPTION_PROMPT =
  "请用一到两句话描述这张图片的内容，优先说清主要对象与场景；如果是图表或表格，说明类型与关键数值或文字。" +
  "只描述你确实看到的内容；看不清或不确定就直接说看不清，不要推测、不要补充图片里没有的信息。只输出描述本身。";

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

/** 视觉模型调用失败的统一收口（两个抽取器同一套错误码与措辞）。 */
function visionFailure(id: string, e: unknown): ExtractResult {
  const msg = e instanceof Error ? e.message : String(e);
  return fail(id, "provider_error", `视觉模型调用失败：${msg}`);
}

function extractImageCaption(input: ExtractInput): Promise<ExtractResult> {
  const vision = input.deps.vision;
  // 与 OCR 同一条红线（契约 §15.3-7）：没有注入视觉模型就立刻 provider_error，绝不自己连网。
  if (!vision) {
    return Promise.resolve(
      fail(IMAGE_CAPTION_ID, "provider_error", "未配置视觉模型（deps.vision 缺失）"),
    );
  }
  const mime = input.mime || "image/png";
  return vision(CAPTION_PROMPT, input.bytes, mime).then(
    (raw) => {
      const text = String(raw ?? "").trim();
      if (!text) {
        // 视觉模型没给出描述 ⇒ empty（调度器据此知道"试过了、没内容"）
        return fail(IMAGE_CAPTION_ID, "empty", "视觉模型没有给出描述");
      }
      // `loc` 为空：单张图没有页/时间码概念（与 `image.ocr@1` 同口径，契约 §15.2）
      return ok(IMAGE_CAPTION_ID, [{ kind: "caption", text, loc: "" }]);
    },
    (e: unknown) => visionFailure(IMAGE_CAPTION_ID, e),
  );
}

/**
 * 第二档：图片 → **语义描述**（`kind: "caption"`）。
 *
 * 只在 `image.ocr@1` 判 `empty`（图里没文字）时被调度到 —— 见文件头"兜底链"那段。
 */
export const imageCaptionExtractor: Extractor = {
  id: IMAGE_CAPTION_ID,
  mimes: ["image/*"],
  extensions: IMAGE_EXTENSIONS,
  cost: "gpu",
  extract: async (input: ExtractInput): Promise<ExtractResult> => {
    try {
      return await extractImageCaption(input);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(IMAGE_CAPTION_ID, "internal", msg);
    }
  },
};
