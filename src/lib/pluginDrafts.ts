import { confirmDialog } from "../store/confirm";
import type { PluginDraft } from "../types";
import { api } from "./api";
import { applyDraftAndRefresh } from "./applyDraftAndRefresh";

/** 按**码点**数长度（与 Rust 的 `chars()` 同口径：emoji 不算 2）。 */
const cpLen = (s: string): number => Array.from(s).length;
/** 千分位：2893 读起来费劲，2,893 不费劲。 */
const fmtNum = (n: number): string => n.toLocaleString("zh-CN");

/**
 * 把来源 id 翻成人话：`external:mcp-xxxx` ⇒ 「外部 AI」；插件名/命令标题原样返回。
 *
 * 为什么翻：那个 id 是**审计用的**（`apply.log` 里对得上就行），
 * 不该出现在本该讲人话的确认框里 —— 用户只需要知道"是外部 AI 要动我的笔记"。
 */
export function friendlySource(source: string): string {
  const s = String(source ?? "").trim();
  if (s.startsWith("external:")) return "外部 AI";
  return s || "外部改动";
}

/**
 * Markdown ⇒ **预览用的纯文本**：去掉标题井号 / 加粗 / 引用 / 列表 / 链接记号。
 *
 * 为什么：确认框里如果直接显示原文，用户看到的是
 * `> 2026-10-18 整理。**一套核心 + 三种外壳** ## 0. 一句话 …` —— 那是语法，不是内容。
 * 这里只做"看得懂"这一件事，⛔ 不追求还原排版（那不是这个框的职责）。
 */
export function plainPreview(md: string): string {
  return String(md ?? "")
    .replace(/^#{1,6}\s+/gm, "") // 标题井号
    .replace(/^\s*>\s?/gm, "") // 引用
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接 → 只留文字
    .replace(/\*\*|__|`{1,3}/g, "") // 加粗 / 行内代码
    .replace(/^\s*[-*+]\s+/gm, "") // 无序列表记号
    .replace(/^\s*\d+\.\s+/gm, "") // 有序列表记号
    .replace(/\s+/g, " ")
    .trim();
}

/** 页面标题；读不到就给个短 id（⛔ 不在确认框里显示整串 UUID）。 */
async function pageTitleOf(id: string): Promise<string> {
  try {
    const page = (await api.getPage(id)) as { title?: string } | null;
    const title = String(page?.title ?? "").trim();
    if (title) return title;
  } catch {
    // 读不到就退回短 id —— 预览本来就不该拦住确认
  }
  return `页面 ${id.slice(0, 8)}…`;
}

/**
 * 草稿里"用户点确定之前必须看见"的那几行。
 *
 * 为什么要有（2026-10-18）：确认框原来只显示后端生成的 `summary`（如「更新页面 xxx（整页替换）」）——
 * 用户是在**看不见新内容**的情况下点确定的。对插件来说那还行（summary 由后端生成、改动小），
 * 但对**外部 AI 的整页替换**来说这就是**盲签**：点下去之前不知道整页会变成什么。
 *
 * 这里做的是"最低限度的知情"：动的是哪一页（**标题**，不是 UUID）、原来多少字、新的是多少字、开头是什么。
 * ⚠️ **改前字数由后端随草稿给**（`beforeChars`）—— 渲染层不去读正文列（那会绕开
 * `doc-content-access` 那条收口）；读不到就是 `null`，这里如实显示"读不到原文"。
 * ⛔ 刻意**不**做逐行 diff：那需要旧正文与排版经得起看的算法，属于另一片。
 */
export async function draftPreviewLines(drafts: PluginDraft[]): Promise<string[]> {
  const out: string[] = [];
  for (const d of drafts) {
    const p = d.payload as Record<string, unknown> | null;
    if (!p || typeof p !== "object") continue;
    const kind = String(p.kind ?? "");
    if (kind === "update_page") {
      const id = String(p.pageId ?? "");
      const next = String(p.markdown ?? p.plain ?? "");
      const title = await pageTitleOf(id);
      const before =
        typeof p.beforeChars === "number"
          ? `原文 ${fmtNum(p.beforeChars)} 字 → `
          : "（读不到原文）→ ";
      out.push(`整页替换「${title}」：${before}新正文 ${fmtNum(cpLen(next))} 字`);
      const plain = plainPreview(next);
      const head = plain.slice(0, 120);
      if (head) out.push(`开头：${head}${plain.length > 120 ? "…" : ""}`);
    } else if (kind === "create_page") {
      const title = String(p.title ?? "");
      const next = String(p.content ?? p.markdown ?? "");
      out.push(`新建页面「${title}」：正文 ${fmtNum(cpLen(next))} 字`);
    } else if (kind === "append_block") {
      const text = String(p.text ?? "");
      out.push(`追加一段：${fmtNum(cpLen(text))} 字`);
    }
  }
  return out;
}

/**
 * 把插件产出的草稿摊给用户确认，确认后才落库。
 *
 * 为什么抽成共用函数：这条链路有**两个**入口——用户点插件命令（命令面板），
 * 以及事件钩子（例如「保存后自动打标签」，用户当时并没有在看确认框）。两处要是
 * 各写一遍，就迟早会出现"某一个入口忘了确认直接落库"，而那正是本插件体系最核心的
 * 承诺（插件永远不直接写你的笔记）。所以规则只此一份：
 *   - 先展示**具体要做什么**（summary 由后端生成，不是插件随便写的文案）；
 *     ⭐ 覆盖式写还要多给几行"会变成什么"（见 [`draftPreviewLines`]）；
 *   - 用户点了确定才走共用的 `applyDraftAndRefresh`（AI 与插件同一条落库链路）；
 *   - 拒绝就是**什么都不写**（而不是写一半）。
 *
 * @param source 谁提出的改动（命令标题 / 插件名 + 事件名 / `external:…`），用于提示文案
 * @returns 给用户看的一句话结果
 */
export async function confirmAndApplyDrafts(source: string, drafts: PluginDraft[]): Promise<string> {
  if (drafts.length === 0) return "";
  const list = drafts.map((d, i) => `${i + 1}. ${d.summary}`).join("\n");
  // 预览读不到也不能拦住确认（读页失败不该让插件/AI 的改动完全无法落库）
  const preview = await draftPreviewLines(drafts).catch(() => []);
  const detail = preview.length ? `\n\n${preview.join("\n")}` : "";
  const ok = await confirmDialog({
    // 这框现在同时服务「插件」与「外部 AI」⇒ 标题不再写死成"插件"
    title: "确认这次改动",
    message: `${friendlySource(source)} 想对笔记做这些改动：\n\n${list}${detail}\n\n点「确定」才会真正写入。`,
  });
  if (!ok) return `已放弃 ${drafts.length} 项改动（未写入）`;

  const applied: string[] = [];
  for (const d of drafts) {
    try {
      const r = await applyDraftAndRefresh(d.payload);
      applied.push(r.ok ? `✓ ${d.summary}` : `✗ ${d.summary}：${r.message}`);
    } catch (e) {
      applied.push(`✗ ${d.summary}：${String(e)}`);
    }
  }
  return applied.join("；");
}
