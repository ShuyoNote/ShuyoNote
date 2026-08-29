// 扫描版电子书「AI 生成目录」的纯函数部分：组装 LLM 提示、解析返回的章节 JSON、
// 换算为带层级的 OutlineItem（可单测）。真正的 OCR + LLM 编排见 ./aiOutline.ts。
import type { OutlineItem } from "./pdfRender";

/** 每页取前多少字符喂给 LLM（控制 token；章节标题通常出现在页首）。 */
export const OUTLINE_EXCERPT_CHARS = 140;

/** 一条目录候选。level：1=章/一级标题，2=节，3=小节（默认 1）。 */
export interface OutlineEntry {
  title: string;
  /** 物理页（1 起）。 */
  page: number;
  level?: number;
}

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

/** 从 LLM 回复中解析 [{"title","page","level"?}]（容错：剥 markdown 围栏/说明，取第一个数组）。 */
export function parseOutlineJson(reply: string): OutlineEntry[] {
  if (!reply) return [];
  const raw = reply.match(/\[[\s\S]*\]/)?.[0] ?? reply.trim();
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    // 退化为逐行抓 "title" 及其后最近数字。
    const out: OutlineEntry[] = [];
    for (const m of reply.matchAll(/"title"\s*:\s*"([^"]+)"[\s\S]{0,80}?(\d+)/g)) {
      const title = m[1].trim();
      const page = Number(m[2]);
      if (title && Number.isFinite(page)) out.push({ title, page, level: 1 });
    }
    return out;
  }
  if (!Array.isArray(arr)) return [];
  return (arr as Array<{ title?: unknown; page?: unknown; level?: unknown }>)
    .map((e) => ({ title: String(e?.title ?? "").trim(), page: Number(e?.page), level: Number(e?.level ?? 1) || 1 }))
    .filter((e) => e.title && Number.isFinite(e.page));
}

/** 把「逐页识别到的疑似目录条目」交给文本 LLM 整合的提示：去噪、定层级、排序。尽量保留，避免遗漏。 */
export function buildIntegratePrompt(entries: OutlineEntry[]): string {
  const list = entries.map((e) => `第 ${e.page} 页：${e.title}`).join("\n");
  return [
    "你是图书目录整理助手。下面是从一本扫描书各页识别到的「疑似目录条目」列表（含页码）。",
    "请从中整理出**目录**：**尽量保留所有可能是目录项的行**（章节/小节/部分标题等），只剔除明显不是标题的正文长句；",
    "判断层级：一级大标题（“第X章”“第一章”“第一部分”“附录”等）= level 1；二级小节（“X.X”“第X节”）= level 2；三级 = level 3。",
    "按阅读顺序输出；**页码（1 起）必须与上方条目一致，不要改动或新增**；可合并同一章跨页、去重类似项、校正明显错字。",
    '只输出一个 JSON 数组：[{"title":"标题","page":页码,"level":1|2|3}]，不要任何其他文字。',
    "",
    "疑似条目：",
    list,
  ].join("\n");
}

/** 纯函数：按标题命名规则推断层级（1=章/大标题，2=节，3=小节）。用于整合模型未给 level 时兜底。 */
export function inferOutlineLevel(title: string): number {
  const t = (title || "").trim();
  if (/^\s*\d+\s*\.\s*\d+\s*\.\s*\d+/.test(t)) return 3;
  if (/^\s*\d+\s*\.\s*\d+/.test(t) || /第\s*[一二三四五六七八九十百零\d]+\s*节/.test(t)) return 2;
  if (/(第\s*[一二三四五六七八九十百零\d]+\s*[章篇部]|chapter\s*\d+|第?\d+\s*章|序章|导言|绪论|前言|引言|后记|结语|附录|索引|参考文献)/i.test(t)) return 1;
  return 1;
}

/** 把解析结果约束到本段页码范围、排序，并按 level 构造成带 children 的目录树。 */
export function toOutlineItems(entries: OutlineEntry[], start0: number, count: number): OutlineItem[] {
  const start1 = start0 + 1;
  const end1 = start0 + count;
  const sorted = entries
    .filter((e) => e.page >= start1 && e.page <= end1)
    .sort((a, b) => a.page - b.page);
  const roots: OutlineItem[] = [];
  const stack: { item: OutlineItem; level: number }[] = [];
  for (const e of sorted) {
    const node: OutlineItem = { title: e.title, pageIndex: e.page - 1, children: [] };
    // 用「模型给的 level」与「标题命名推断」取较大值，避免模型给平铺(1)时丢了层级。
    const level = Math.max(e.level ?? 1, inferOutlineLevel(e.title));
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    if (stack.length) stack[stack.length - 1].item.children.push(node);
    else roots.push(node);
    stack.push({ item: node, level });
  }
  return roots;
}
