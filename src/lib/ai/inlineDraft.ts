// Inline AI drafting (M18). This is the "write into the current page" surface,
// separate from the sidebar chat. It reuses the SAME thin-agent core (runAiLoop)
// and transport routing, but streams the reply to a highlighted pending draft
// that the user commits or discards in place.

import { createProviderTransport, type ProviderConfig } from "./llm";
import { createBackendStreamingTransport } from "./transport";
import { runAiLoop } from "./host";
import type { AiRunResult } from "./types";
import { appendBlocksToJson } from "./lexical";

const IS_WEB = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

/** Quick-start actions shown in the "用 AI 写作" dropdown (grouped). */
export interface InlineTemplate {
  key: string;
  label: string;
  promptTemplate: string;
  /** Group header; empty string = top-level (no header). */
  group: string;
}

// Context-aware: pages WITH content → edit/continue actions.
export const INLINE_EDIT_TEMPLATES: InlineTemplate[] = [
  { key: "continue", label: "续写", promptTemplate: "继续接着当前内容往下写。", group: "" },
  { key: "summary", label: "总结", promptTemplate: "总结当前页面的核心内容。", group: "根据页面内容生成" },
  { key: "translate", label: "翻译", promptTemplate: "把当前页面内容翻译成中文/英文（按需求）。", group: "根据页面内容生成" },
  { key: "polish", label: "文本润色", promptTemplate: "润色当前页面文字，使其更通顺自然。", group: "编辑页面内容" },
  { key: "correct", label: "智能纠错", promptTemplate: "校对并纠正当前页面的错别字与语法问题。", group: "编辑页面内容" },
];

// Context-aware: EMPTY pages → generate fresh content.
export const INLINE_CREATE_TEMPLATES: InlineTemplate[] = [
  { key: "outline", label: "文章大纲", promptTemplate: "帮我写一篇文章大纲，主题/要求是...", group: "" },
  { key: "story", label: "短篇故事", promptTemplate: "帮我写一则短篇故事，故事主题/要求是...", group: "内容创作" },
  { key: "xhs", label: "小红书种草笔记", promptTemplate: "帮我写一篇小红书种草笔记，内容主题/要求是...", group: "内容创作" },
  { key: "article", label: "文章", promptTemplate: "帮我写一篇文章，主题/要求是...", group: "内容创作" },
  { key: "meeting", label: "会议纪要", promptTemplate: "帮我写一份会议纪要，会议主题/要点是...", group: "内容创作" },
  { key: "todo", label: "待办清单", promptTemplate: "帮我列一份待办清单，针对的是...", group: "内容创作" },
];

export interface InlineDraftOpts {
  onDelta?: (text: string) => void;
  onThinking?: (text: string) => void;
}

// For the inline writer we want ONLY the content (a story/outline/summary…), not
// the conversational framing the general assistant tends to add ("草稿已生成…",
// "确认无误的话…", markdown markers). A content-only system prompt keeps those out.
const CONTENT_SYSTEM_PROMPT = [
  "你是 ShuyoNote 的内联写作助手，会直接把内容写到用户当前页面。",
  "只输出「内容本身」，严格遵守：",
  "1. 直接给出要写的内容（故事/大纲/摘要/帖子/邮件等），不要任何开场白（如“好的”“草稿已生成”“以下是我准备的”）。",
  "2. 不要任何结尾说明（如“确认无误的话…”“需要修改可以告诉我”“我已…”，以及任何询问或等待确认的话）。",
  "3. 不要 markdown 标记（**、*、`、---、```、> 等），纯文本即可；留出自然分段空行。",
  "4. 不要声称“已保存/已创建/已追加”——你只是给出内容。",
].join("\n");

/** Run the inline drafting loop against the configured provider (content-only). */
export async function runInlineDraft(
  config: ProviderConfig,
  prompt: string,
  pages: Array<{ id: string; title: string }>,
  ctx: { currentPageId: string | null; allPages: Array<{ id: string; title: string; parent_id: string | null }> },
  opts: InlineDraftOpts = {},
): Promise<AiRunResult> {
  const transport = IS_WEB
    ? createProviderTransport(config)
    : createBackendStreamingTransport(config);
  return runAiLoop(prompt, pages, ctx, {
    transport,
    onDelta: opts.onDelta,
    onThinking: opts.onThinking,
    systemPrompt: CONTENT_SYSTEM_PROMPT,
  });
}

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `blk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Convert accumulated draft text into a usable Lexical content_json (testable,
 *  and used to verify the pending block would be valid to commit). */
export function draftBlocksToContentJson(text: string): string {
  return appendBlocksToJson("", text, makeId);
}
