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

/** Quick-start templates shown in the "用 AI 起草" dropdown. */
export interface InlineTemplate {
  key: string;
  label: string;
  promptTemplate: string;
}

export const INLINE_TEMPLATES: InlineTemplate[] = [
  { key: "outline", label: "文章大纲", promptTemplate: "为当前主题写一篇文章大纲。" },
  { key: "summary", label: "内容简介", promptTemplate: "写一段内容简介。" },
  { key: "social", label: "社交媒体帖子", promptTemplate: "写一条社交媒体帖子。" },
  { key: "email", label: "电子邮件", promptTemplate: "写一封电子邮件。" },
  { key: "ad", label: "广告文案", promptTemplate: "写一段广告文案。" },
  { key: "story", label: "短篇故事", promptTemplate: "帮我写一则短篇故事。" },
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
