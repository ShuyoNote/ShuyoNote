// 扫描版电子书「AI 生成目录」的纯函数部分：组装 LLM 提示、解析返回的章节 JSON、
// 换算为 OutlineItem（可单测）。真正的 OCR + LLM 编排见 ./aiOutline.ts。
import type { OutlineItem } from "./pdfRender";

/** 每页取前多少字符喂给 LLM（控制 token；章节标题通常出现在页首）。 */
export const OUTLINE_EXCERPT_CHARS = 140;

/** 组装提示：把每页 OCR 片段拼成带 [第 N 页] 前缀的文本，要求 LLM 输出章节 JSON。 */
export function buildOutlinePrompt(pageTexts: string[], startPage1: number): string {
  const lines = pageTexts
    .map((t, i) => {
      const pageNo = startPage1 + i;
      const snip = (t || "").replace(/\s+/g, " ").trim().slice(0, OUTLINE_EXCERPT_CHARS);
      return `[第 ${pageNo} 页] ${snip}`;
    })
    .filter(Boolean);
  return [
    "你是图书目录整理助手。下面是一本扫描电子书某一段的每页 OCR 文本片段，",
    "每段以 [第 N 页] 标明该页的实际物理页码（从 1 起）。请找出其中的章节/小节标题，",
    "并为每个标题标注它首次出现的物理页码（从 1 起，取自上方的 [第 N 页] 标签）。",
    "严格遵守：只输出一个 JSON 数组，格式为 [{\"title\":\"标题\",\"page\":页码}]；",
    "绝对不要输出 [第 N 页] 这种标记，不要复述任何原文，不要任何说明/开场白/结尾。",
    "没有标题的页不要输出条目；不要把页眉、页脚、页码本身当作标题。",
    "",
    ...lines,
  ].join("\n");
}

/** 从 LLM 回复中解析 [{"title","page"}]（容错：剥 markdown 围栏/说明，取第一个数组）。 */
export function parseOutlineJson(reply: string): { title: string; page: number }[] {
  if (!reply) return [];
  const raw = reply.match(/\[[\s\S]*\]/)?.[0] ?? reply.trim();
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    // 退化为逐行抓 "title" 及其后最近数字。
    const out: { title: string; page: number }[] = [];
    for (const m of reply.matchAll(/"title"\s*:\s*"([^"]+)"[\s\S]{0,80}?(\d+)/g)) {
      const title = m[1].trim();
      const page = Number(m[2]);
      if (title && Number.isFinite(page)) out.push({ title, page });
    }
    return out;
  }
  if (!Array.isArray(arr)) return [];
  return (arr as Array<{ title?: unknown; page?: unknown }>)
    .map((e) => ({ title: String(e?.title ?? "").trim(), page: Number(e?.page) }))
    .filter((e) => e.title && Number.isFinite(e.page));
}

/** 把解析结果约束到本段页码范围并排序，输出 OutlineItem[]。page 为 1 起始物理页。 */
export function toOutlineItems(
  entries: { title: string; page: number }[],
  start0: number,
  count: number,
): OutlineItem[] {
  const start1 = start0 + 1;
  const end1 = start0 + count;
  return entries
    .filter((e) => e.page >= start1 && e.page <= end1)
    .sort((a, b) => a.page - b.page)
    .map((e) => ({ title: e.title, pageIndex: e.page - 1, children: [] }));
}
