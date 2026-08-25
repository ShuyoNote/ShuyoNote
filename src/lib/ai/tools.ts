import { api } from "../api";
import { appendBlocksToJson, contentTextOf } from "./lexical";
import type { AiTool, DraftResult } from "./types";

// Generate a UUID for block ids (mirrors web.ts uid(), kept local to avoid
// importing platform internals into the AI layer).
function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `blk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function draft(key: string, summary: string, payload: unknown): DraftResult {
  return { draft: true, key, summary, payload };
}

// Build a Lexical content_json for a new page from a plain-text `content` string.
function pageJsonFromText(content: string): { content_json: string; content_text: string } {
  const content_json = String(content ?? "").trim()
    ? appendBlocksToJson("", content, makeId)
    : '{"root":{"children":[],"type":"root","version":1}}';
  return { content_json, content_text: contentTextOf(content_json) };
}

const TOOL_LIST: AiTool[] = [
  {
    id: "search_pages",
    description:
      "在全库中检索页面，按相关度排序(关键词匹配 + 语义相近, 意思相近的内容也能命中)。参数: query (必填, 关键词/内容描述), limit (可选, 默认 8)。返回匹配页面的 id/title/snippet。",
    argsSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
    isWrite: false,
    run: async (args) => {
      const query = String(args.query ?? "");
      const limit = typeof args.limit === "number" ? args.limit : 8;
      if (!query) return { ok: false, error: "search_pages 需要 query" };
      const rows = await api.search(query, limit, false);
      return { ok: true, pages: rows.map((r) => ({ id: r.id, title: r.title, snippet: r.snippet })) };
    },
  },
  {
    id: "read_page",
    description:
      "读取单个页面的标题与正文纯文本。参数: pageId (必填)。返回 id/title/content_text(截断显示)。",
    argsSchema: {
      type: "object",
      properties: { pageId: { type: "string" } },
      required: ["pageId"],
    },
    isWrite: false,
    run: async (args) => {
      const pageId = String(args.pageId ?? "");
      if (!pageId) return { ok: false, error: "read_page 需要 pageId" };
      const p = await api.getPage(pageId);
      if (!p) return { ok: false, error: `未找到页面 ${pageId}` };
      const text = (p.content_text ?? "").trim();
      return {
        ok: true,
        page: {
          id: p.id,
          title: p.title,
          content_text: text.length > 6000 ? `${text.slice(0, 6000)}…` : text,
        },
      };
    },
  },
  {
    id: "read_block",
    description:
      "列出页面中的所有顶级块(每块 id + 文本)。参数: pageId (必填)。返回块数组，可用于定位具体块。",
    argsSchema: {
      type: "object",
      properties: { pageId: { type: "string" } },
      required: ["pageId"],
    },
    isWrite: false,
    run: async (args) => {
      const pageId = String(args.pageId ?? "");
      if (!pageId) return { ok: false, error: "read_block 需要 pageId" };
      const blocks = await api.getPageBlocks(pageId);
      return { ok: true, blocks: blocks.map((b) => ({ blockId: b.block_id, text: b.text })) };
    },
  },
  {
    id: "get_backlinks",
    description:
      "查询哪些页面反向链接到目标页面。参数: pageId (必填)。返回引用它的页面列表。",
    argsSchema: {
      type: "object",
      properties: { pageId: { type: "string" } },
      required: ["pageId"],
    },
    isWrite: false,
    run: async (args) => {
      const pageId = String(args.pageId ?? "");
      if (!pageId) return { ok: false, error: "get_backlinks 需要 pageId" };
      const links = await api.getBacklinks(pageId);
      return { ok: true, backlinks: links.map((l) => ({ id: l.id, title: l.title })) };
    },
  },
  {
    id: "list_files",
    description:
      "列出页面附件。参数: pageId (必填)。返回文件名/类型/大小。",
    argsSchema: {
      type: "object",
      properties: { pageId: { type: "string" } },
      required: ["pageId"],
    },
    isWrite: false,
    run: async (args) => {
      const pageId = String(args.pageId ?? "");
      if (!pageId) return { ok: false, error: "list_files 需要 pageId" };
      const files = await api.listPageAttachments(pageId);
      return {
        ok: true,
        files: files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size })),
      };
    },
  },
  {
    id: "create_page",
    description:
      "新建页面。参数: title (必填), content (可选正文, 支持换行分段), parentId (可选父页面 id, 缺省为顶层)。这是写操作，返回草稿供用户确认。",
    argsSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        parentId: { type: "string" },
      },
      required: ["title"],
    },
    isWrite: true,
    run: async (args) => {
      const title = String(args.title ?? "").trim();
      if (!title) return { ok: false, error: "create_page 需要 title" };
      const { content_json, content_text } = pageJsonFromText(String(args.content ?? ""));
      const parentId = typeof args.parentId === "string" && args.parentId ? args.parentId : null;
      return draft(
        `create_page:${title}`,
        `新建页面「${title}」`,
        { kind: "create_page", args: { parent_id: parentId, title, content_json, content_text } },
      );
    },
  },
  {
    id: "append_block",
    description:
      "向现存页面追加一个或多个段落(按换行分段)。参数: pageId (必填), text (必填正文)。这是写操作，返回草稿供用户确认。",
    argsSchema: {
      type: "object",
      properties: { pageId: { type: "string" }, text: { type: "string" } },
      required: ["pageId", "text"],
    },
    isWrite: true,
    run: async (args) => {
      const pageId = String(args.pageId ?? "");
      const text = String(args.text ?? "").trim();
      if (!pageId) return { ok: false, error: "append_block 需要 pageId" };
      if (!text) return { ok: false, error: "append_block 需要 text" };
      return draft(
        `append_block:${pageId}:${text.slice(0, 24)}`,
        `向页面追加 ${text.split("\n").filter((s) => s.trim()).length} 个段落`,
        { kind: "append_block", pageId, text },
      );
    },
  },
];

export const aiTools: AiTool[] = TOOL_LIST;

export function getAiTool(id: string): AiTool | undefined {
  return TOOL_LIST.find((t) => t.id === id);
}

/** Compact tool description listing for the system prompt. */
export function aiToolSummaries(): string {
  return TOOL_LIST.map((t) => `- ${t.id}: ${t.description}`).join("\n");
}

/** Compose the system prompt for a session. */
export function buildSystemPrompt(ctx: { pages: Array<{ id: string; title: string }> }): string {
  const spacePages = ctx.pages.slice(0, 200).map((p) => `  ${p.id}  ${p.title}`).join("\n");
  return [
    "你是 ShuyoNote 的写作助手。你只能使用下面这些工具操作笔记。",
    "规则:",
    "1. 读取类工具(检索/读页/读块/反链/文件)可直接执行。",
    "2. 写入类工具(新建页面/追加块)返回的是「草稿」：需要用户确认后才真正保存，所以你只需说明意图，不要声称它已保存。",
    "3. 不要执行任何工具外操作(没有 shell、没有任意文件、没有联网)。",
    "",
    "可用工具:",
    aiToolSummaries(),
    "",
    "当前空间的页面(用于把名称解析成 pageId):",
    spacePages || "  (无页面)",
  ].join("\n");
}
