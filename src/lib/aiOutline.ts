// 扫描版电子书「AI 生成目录」的编排：逐页 OCR → 组装提示 → 调 LLM → 解析为 OutlineItem。
// 纯函数部分（buildOutlinePrompt/parseOutlineJson/toOutlineItems）见 ./pdfOutlineGen.ts（可单测）。
// 这里只做数据流编排：复用同一 OCR worker 逐页识别（避免每页重载模型）、进度上报、可取消。
import type { ProviderConfig } from "./ai/llm";
import { runInlineDraft } from "./ai/inlineDraft";
import { createOcrWorker } from "./ocr";
import { buildOutlinePrompt, parseOutlineJson, toOutlineItems } from "./pdfOutlineGen";
import type { OutlineItem } from "./pdfRender";

/** OCR 用页图缩放：略高于 1× 提升清晰度，又不至于过大拖慢识别。 */
export const OCR_OUTLINE_SCALE = 1.5;

const OCR_LANGS = "chi_sim+eng";

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
  signal?: AbortSignal;
}

export async function generateOutlineFromOcr(o: GenerateOutlineOpts): Promise<OutlineItem[]> {
  const end = Math.min(o.start + o.count, o.pageCount);
  if (end <= o.start) return [];
  const total = end - o.start;
  const cache = o.ocrCache ?? new Map<number, string>();

  // 复用同一 worker：一次加载核心 + 中文/英文模型，逐页识别，最后统一销毁。
  const ocr = await createOcrWorker(OCR_LANGS);
  const texts: string[] = [];
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
      o.onProgress?.({ done: i - o.start + 1, total, page: i });
    }
  } finally {
    await ocr.terminate();
  }

  const reply = await runInlineDraft(
    o.config,
    buildOutlinePrompt(texts, o.start + 1),
    [],
    { currentPageId: null, allPages: [] },
    {},
  );
  const entries = parseOutlineJson(reply?.reply ?? "");
  return toOutlineItems(entries, o.start, total);
}
