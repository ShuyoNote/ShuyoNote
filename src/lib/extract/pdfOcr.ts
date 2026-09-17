// PDF 视觉通道抽取器（扫描件 / 混合文档）—— 家族「PDF + 扫描件」。
// 契约见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §15（§15.3 不变量 / §15.4 候选顺序 / §15.8 deps）。
//
// ## 它和 `pdf.text` 的分工（顺序即优先级，见 registry.ts）
// `pdf.text@1` 走文本层（cpu、便宜）；它抽不到东西时返回 `empty`，调度器按候选列表自然落到这里（§15.4）。
// 本抽取器**自带文本层**：有文本层的页直接用文本，**只对空页**做视觉 —— 对"正文是文字、中间插了几页扫描"
// 的混合文档，这是**数量级**的差别（否则要么白烧一遍 VLM，要么扫描页永远没内容）。
//
// ## 三条落定的事（都写成了判据，不只是注释）
//  1. **页数不从"渲染到失败为止"猜**：`rasterize(bytes, pageIndex, scale)` 没有"页数"能力，
//     而"渲染失败"与"文档结束"不可区分（第 3 页真失败会被当成到此为止，后面的页静默消失）。
//     ⇒ 页数用 pdf.js 读（`readPdfPages`，与 `pdf.text` 共用；§15.8 已明确 pdfjs 允许留在抽取层）。
//  2. **失败就红、截断就标注**：任一层失败（光栅化 / 视觉）⇒ `provider_error`（不留半份）；
//     而**页数上限**改成"落已抽到的部分 + 用 `coverage` 如实标注缺口"。
//     ⚠️ 这里前后立场变过一次，如实记下来：上限原先也是"直接红"（理由是"契约里没有表达部分覆盖的位置，
//     半份会被当成全文"）。2026-09-17 契约补了 `ExtractCoverage`（`complete` / `gapIndexes` / `note`），
//     调度器也改成"不完整就试下一个、谁缺口少用谁" ⇒ 那条理由消失了：现在**标注出来的部分**比
//     "整体失败、什么都没有"更有用，而且不会骗下游。
//  3. **不自建渲染、不自建网络**（§15.3-7 的活样板）：像素只从 `deps.rasterize` 来，
//     文字只从 `deps.vision` 来；缺任何一个**立刻** `provider_error`。

import { OCR_PROMPT } from "./image";
import { looksLikePdf, readPdfPages } from "./pdf";
import {
  fail,
  ok,
  type ExtractCoverage,
  type ExtractInput,
  type ExtractResult,
  type ExtractedSegment,
  type Extractor,
  type RasterizedPage,
} from "./types";

const ID = "pdf.ocr@1";

/** 视觉调用的页数上限（**防御性**，不是成本口径）：超过就拒绝落半份并报错。
 *
 *  ⚠️ 200 取"正常扫描件够得到、病态文档够不到"：一页一次模型调用（**要钱**），
 *  但真正的成本闸门应该在调度器/成本口径那一层（§13），不该由抽取器偷偷截断内容。 */
export const MAX_OCR_PAGES = 200;

/** 光栅化倍率（相对 PDF 默认 72dpi）：2 ⇒ 约 144dpi。
 *  ⚠️ **待真样张标定**：中文小字通常要 200–300dpi（scale 3–4），但像素数（≈视觉 token 成本）按平方涨。
 *  这个值先取 2 并留在这里一处，等有真扫描件 + 可用视觉通道时再调。 */
export const OCR_SCALE = 2;

/** 一页光栅化结果 → 视觉通道能吃的载荷。 */
interface PageImage {
  bytes: Uint8Array;
  mime: string;
}

/**
 * ⚠️ **契约缺口（2026-09-17，已提给契约所有者，见信箱 `2026-09-17-pdf-ocr-rasterizer-gap.reply-9`）**：
 *
 * - `deps.rasterize` 按契约给的是**裸 RGBA + 宽高**；
 * - `deps.vision(prompt, image, mime)` 要的是**编码图** —— 平台侧真正的视觉通道
 *   `src/lib/ai/ocrVision.ts` 只吃 `data:image/…;base64,…`（`image_url.url` / ollama `images:[b64]`）；
 * - 中间那一步（RGBA → PNG）**只能由平台做**（要 canvas / 原生库，正是 `isolated.test.ts` 禁的那类）。
 *
 * 所以这里**不猜**：只有当平台给出的页图**自带 mime**（即"光栅化直接产出编码图"这一裁定落地）时
 * 才把图交给视觉通道；否则报 `provider_error` 并把缺的那一步说清楚 ——
 * 这比"把裸 RGBA 塞进 `vision` 让它在适配器里崩成一句难懂的话"（或者更糟：让适配器去猜尺寸）好。
 */
function toVisionImage(page: RasterizedPage): PageImage | { missing: string } {
  const p = page as RasterizedPage & { bytes?: unknown; mime?: unknown };
  if (p.bytes instanceof Uint8Array && typeof p.mime === "string" && p.mime.length > 0) {
    return { bytes: p.bytes, mime: p.mime };
  }
  return {
    missing:
      "平台只给了裸 RGBA（+宽高），而视觉通道要的是**编码图**（OCR 通道只吃 data URL）——"
      + "中间缺「RGBA → PNG」这一步，而它在抽取层做不了（要 canvas / 原生库）。"
      + "这一条已提给契约所有者（信箱 2026-09-17-pdf-ocr-rasterizer-gap.reply-9）",
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 缺口序号 → 覆盖度（`null` = 完整覆盖，此时**不传** `coverage`，与"省略即完整"的契约一致）。 */
function coverageOf(
  gaps: readonly number[],
  ctx: { totalPages: number; hitCap: boolean; truncated: boolean; readPages: number },
): ExtractCoverage | null {
  if (gaps.length === 0) return null;
  const parts: string[] = [];
  if (ctx.hitCap) parts.push(`需要视觉识别的页超过单次上限 ${MAX_OCR_PAGES} 页，只处理了靠前的那些`);
  if (ctx.truncated) parts.push(`超过页读取上限，只读到 p.${ctx.readPages}（源 ${ctx.totalPages} 页）`);
  const noText = gaps.length - (ctx.hitCap ? 1 : 0);
  if (noText > 0) parts.push(`${noText} 页既没有文本层、视觉也没得到文字`);
  return { complete: false, gapIndexes: [...gaps], note: parts.join("；") };
}

async function extractPdfOcr(input: ExtractInput): Promise<ExtractResult> {
  if (!looksLikePdf(input.bytes)) return fail(ID, "unsupported", "不是 PDF：开头 1 KiB 里找不到 %PDF-");

  const rasterize = input.deps.rasterize;
  const vision = input.deps.vision;
  // §15.3-7：缺平台能力**立刻** provider_error，绝不自己想办法（不自建渲染、不自建网络）。
  if (!rasterize) {
    return fail(ID, "provider_error", "未注入光栅化（deps.rasterize 缺失）—— 抽取层不自己渲染页面");
  }
  if (!vision) {
    return fail(ID, "provider_error", "未配置视觉模型（deps.vision 缺失）—— 抽取层不自己连模型");
  }

  const read = await readPdfPages(ID, input.bytes);
  if (!read.ok) return read.result;
  const { pages, totalPages } = read.value;

  const segments: ExtractedSegment[] = [];
  /** 没有产出内容的单元序号（**0 基**，契约口径）—— 供调度器比较"谁缺口少"。 */
  const gaps: number[] = [];
  let ocrPages = 0;
  let hitCap = false;

  for (const page of pages) {
    // 有文本层的页直接给文本：**不烧视觉调用**（混合文档里这一步省掉的是大头）
    if (page.text.length > 0) {
      segments.push({ kind: "text", text: page.text, loc: `p.${page.page}` });
      continue;
    }

    if (ocrPages >= MAX_OCR_PAGES) {
      // 见文件头第 2 条：不再整体失败，改为"抽出能抽的 + 标注缺口"。
      hitCap = true;
      gaps.push(page.page - 1);
      continue;
    }

    let rasterized: RasterizedPage;
    try {
      // 页码：契约里 `pageIndex` 是 0 基，`loc` 是 1 基 —— 只在这一行做转换，别处都别动。
      rasterized = await rasterize(input.bytes, page.page - 1, OCR_SCALE);
    } catch (e) {
      return fail(ID, "provider_error", `第 p.${page.page} 页光栅化失败：${messageOf(e)}`);
    }

    const image = toVisionImage(rasterized);
    if ("missing" in image) return fail(ID, "provider_error", image.missing);

    let raw: string;
    try {
      raw = await vision(OCR_PROMPT, image.bytes, image.mime);
    } catch (e) {
      // 视觉模型的异常必须转成错误码，不能穿透（§15.3-2）
      return fail(ID, "provider_error", `第 p.${page.page} 页视觉识别失败：${messageOf(e)}`);
    }

    ocrPages++;
    const text = String(raw ?? "").trim();
    // 单页没认出字是**正常**的（整页是图/照片）⇒ 这一页不出段、不算错误，但**要记成缺口**：
    // 覆盖度是对"有没有内容"说的，不是对"调用有没有成功"说的。
    if (text.length > 0) segments.push({ kind: "ocr", text, loc: `p.${page.page}` });
    else gaps.push(page.page - 1);
  }

  if (segments.length === 0) {
    return fail(ID, "empty", `PDF 共 ${totalPages} 页，文本层与视觉通道都没得到文字`);
  }

  // 截断（页读取上限）也算缺口：那些页我们**没读**，不能说它们没内容。
  const truncated = totalPages > pages.length;
  if (truncated) for (let i = pages.length; i < totalPages; i++) gaps.push(i);

  const coverage = coverageOf(gaps, { totalPages, hitCap, truncated, readPages: pages.length });
  return coverage ? ok(ID, segments, coverage) : ok(ID, segments);
}

export const pdfOcrExtractor: Extractor = {
  id: ID,
  mimes: ["application/pdf"],
  extensions: [".pdf"],
  // 视觉通道：调度器据此排队错峰（与 image.ocr 同档）
  cost: "gpu",

  async extract(input: ExtractInput): Promise<ExtractResult> {
    try {
      return await extractPdfOcr(input);
    } catch (e) {
      // 兜底：任何漏网的同步异常也按 internal 返回（抽取器不抛异常，§15.3）
      return fail(ID, "internal", messageOf(e));
    }
  },
};
