// 扫描版电子书「AI 生成目录」的编排。
// 纯函数部分（buildOutlinePrompt/parseOutlineJson/toOutlineItems）见 ./pdfOutlineGen.ts（可单测）。
// 两条路径：
//  - generateOutlineFromVision（默认，侧重视觉大模型）：逐页把页面图发给多模态模型，由模型直接
//    识别章节标题+页码（JSON），无需 tesseract，质量更高。
//  - generateOutlineFromOcr（离线 tesseract）：逐页 OCR 文本 → LLM 提取，作为无视觉模型时的回退。
import type { ProviderConfig } from "./ai/llm";
import { runInlineDraft } from "./ai/inlineDraft";
import { ocrWithVision, blobToDataUrl } from "./ai/ocrVision";
import { createOcrWorker } from "./ocr";
import { OCR_PAGE_SCALE } from "./ocr";
import { buildOutlinePrompt, parseOutlineJson, toOutlineItems } from "./pdfOutlineGen";
import type { OutlineItem } from "./pdfRender";

/** OCR 用页图缩放：略高于 1× 提升清晰度，又不至于过大拖慢识别。 */
export const OCR_OUTLINE_SCALE = 1.5;

const OCR_LANGS = "chi_sim+eng";

/** 视觉模型识别某一页时用的提示（直接输出该页的章节标题 + 页码 JSON）。 */
function visionPagePrompt(pageNo: number): string {
  return [
    "你是图书目录整理助手。请查看这张扫描书页，找出其中的章节/小节标题（如“第一章 …”“第X章”“XX节”等），",
    "并给出每个标题所在的页码（本页物理页码为 " + pageNo + "，从 1 起）。",
    '只输出一个 JSON 数组，格式 [{"title":"标题","page":页码}]；若本页没有标题，输出 []。',
    "不要把页眉、页脚、页码本身当作标题。只输出 JSON，不要任何其他文字。",
  ].join("\n");
}

export interface GenerateOutlineOpts {
  attachmentId: string;
  pageCount: number;
  /** 起始页（0 起，当前打开的页）。 */
  start: number;
  /** 向后生成多少页。 */
  count: number;
  config: ProviderConfig;
  /** 渲染一页为 Blob（native mupdf 或 pdf.js 均可用）。 */
  renderPage: (attachmentId: string, pageIndex: number, scale: number) => Promise<Blob>;
  /** 逐页 OCR 结果内存缓存（同一段重复生成可秒过）。 */
  ocrCache?: Map<number, string>;
  onProgress?: (p: { done: number; total: number; page: number }) => void;
  /** 阶段回调：ocr=逐页识别中；ai=让 AI 提取目录中。 */
  onStage?: (s: "ocr" | "ai") => void;
  signal?: AbortSignal;
}

export interface OutlineGenResult {
  items: OutlineItem[];
  /** 识别出非空文字的页数。 */
  recognizedPages: number;
  /** 所有页 OCR 文字总字符数（用于判断 OCR 是否有效）。 */
  totalChars: number;
}

export async function generateOutlineFromOcr(o: GenerateOutlineOpts): Promise<OutlineGenResult> {
  const end = Math.min(o.start + o.count, o.pageCount);
  const empty: OutlineGenResult = { items: [], recognizedPages: 0, totalChars: 0 };
  if (end <= o.start) return empty;
  const total = end - o.start;
  const cache = o.ocrCache ?? new Map<number, string>();

  // 复用同一 worker：一次加载核心 + 中文/英文模型，逐页识别，最后统一销毁。
  const ocr = await createOcrWorker(OCR_LANGS);
  const texts: string[] = [];
  let recognizedPages = 0;
  let totalChars = 0;
  try {
    for (let i = o.start; i < end; i++) {
      if (o.signal?.aborted) throw new DOMException("已取消", "AbortError");
      let t = cache.get(i);
      if (t === undefined) {
        const blob = await o.renderPage(o.attachmentId, i, OCR_OUTLINE_SCALE);
        const url = URL.createObjectURL(blob);
        try {
          const res = await ocr.recognize(url);
          t = res.text ?? "";
        } finally {
          URL.revokeObjectURL(url);
        }
        cache.set(i, t);
      }
      texts[i - o.start] = t;
      if (t.trim()) recognizedPages++;
      totalChars += t.length;
      o.onProgress?.({ done: i - o.start + 1, total, page: i });
    }
  } finally {
    await ocr.terminate();
  }

  o.onStage?.("ai");
  const reply = await runInlineDraft(
    o.config,
    buildOutlinePrompt(texts, o.start + 1),
    [],
    { currentPageId: null, allPages: [] },
    {},
  );
  const raw = reply?.reply ?? "";
  const entries = parseOutlineJson(raw);
  if (!entries.length && raw.trim()) {
    // 便于排查：LLM 有返回但解析为空时，把原始回复记到控制台。
    console.warn("[ai-outline] LLM replied but no entries parsed:", raw.slice(0, 400));
  }
  return { items: toOutlineItems(entries, o.start, total), recognizedPages, totalChars };
}

/** 视觉大模型版目录生成（默认，侧重视觉）：逐页把页面图发给多模态模型，由模型直接识别标题+页码。 */
export async function generateOutlineFromVision(o: GenerateOutlineOpts): Promise<OutlineGenResult> {
  const end = Math.min(o.start + o.count, o.pageCount);
  const empty: OutlineGenResult = { items: [], recognizedPages: 0, totalChars: 0 };
  if (end <= o.start) return empty;
  const total = end - o.start;
  const cache = o.ocrCache ?? new Map<number, string>();

  const all: { title: string; page: number }[] = [];
  let recognizedPages = 0;
  let totalChars = 0;
  for (let i = o.start; i < end; i++) {
    if (o.signal?.aborted) throw new DOMException("已取消", "AbortError");
    let json = cache.get(i);
    if (json === undefined) {
      const blob = await o.renderPage(o.attachmentId, i, OCR_PAGE_SCALE);
      const dataUrl = await blobToDataUrl(blob);
      // 视觉模型识别该页标题；失败则返回空（不中断整段）。
      const res = await ocrWithVision(o.config, dataUrl, visionPagePrompt(i + 1));
      json = res.text ?? "";
      cache.set(i, json);
    }
    const pageEntries = parseOutlineJson(json);
    for (const e of pageEntries) {
      all.push({ title: e.title, page: e.page });
      totalChars += e.title.length;
    }
    if (pageEntries.length) recognizedPages++;
    o.onProgress?.({ done: i - o.start + 1, total, page: i });
  }

  return { items: toOutlineItems(all, o.start, total), recognizedPages, totalChars };
}
