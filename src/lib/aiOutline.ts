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
