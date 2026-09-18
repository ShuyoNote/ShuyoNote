// 能力在**前端（渲染进程）**这一侧的实现。
//
// 插件那一侧的实现是 Rust（`src-tauri/src/plugins.rs` 的 cap_*）；两边消费的是
// **同一份注册表**（capabilities/capabilities.json），所以工具的 id / 描述 / 参数
// schema / 是不是写操作都只有一处定义——这里只负责"怎么在前端真去执行"。
// 门禁（scripts/check-capabilities.mjs）会校验注册表里 `ai:true` 的能力在这里都有实现。
//
// 语义要与插件侧保持一致：省略 pageId 时都用**当前打开的页面**（插件侧由宿主解析，
// 这一侧由 notes store 解析）。

import { codePointLength, sliceByCodePoints } from "../textSnippet";
import { api } from "../api";
import { pageJsonFromText } from "../ai/lexical";
import type { DraftResult } from "../ai/types";

/** 宿主（AI 宿主）传给适配器的上下文：当前打开的页面。 */
export interface AdapterContext {
  currentPageId?: string | null;
}

export type CapabilityAdapter = (
  args: Record<string, unknown>,
  ctx?: AdapterContext,
) => Promise<unknown>;

// 与 web.ts 的 uid() 同形（本地一份，避免把平台内部实现拖进能力层）。
function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `blk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function draft(key: string, summary: string, payload: unknown): DraftResult {
  return { draft: true, key, summary, payload };
}

/**
 * 省略 pageId 时用当前打开的页面（与插件侧同一语义：**宿主解析**，插件不用自己猜）。
 *
 * 当前页来自宿主传进来的 ctx —— 这里**刻意不导入 UI store**：能力层要保持薄，
 * 一旦它依赖 store，就会把整条 UI 依赖链（编辑器/公式/katex…）拖进 AI 能力层。
 */
function targetPage(args: Record<string, unknown>, ctx?: AdapterContext): string {
  const given = String(args.pageId ?? "");
  if (given) return given;
  return ctx?.currentPageId ?? "";
}

/**
 * `pages.get` 单次返回正文的**上限**（字，按码点）。与 Rust 侧 `MAX_PAGE_TEXT_LIMIT` 一致，
 * 也与 `capabilities/capabilities.json` 里 `limit` 的 desc 一致。
 *
 * ⚠️ 这个上限本身是既有行为（防止一页几万字把模型上下文撑爆），**没有改**。
 * 改的是"截断时**说不说**"以及"**能不能往下翻**"——见 `pages.get` 实现里的注释。
 */
const PAGE_TEXT_LIMIT = 6000;
const MAX_PAGE_TEXT_LIMIT = 20_000;

export const FRONTEND_ADAPTERS: Record<string, CapabilityAdapter> = {
  "pages.search": async (args) => {
    const query = String(args.q ?? "");
    const limit = typeof args.limit === "number" ? args.limit : 8;
    if (!query) return { ok: false, error: "pages.search 需要 q" };
    const rows = await api.search(query, limit, false);
    return { ok: true, pages: rows.map((r) => ({ id: r.id, title: r.title, snippet: r.snippet })) };
  },

  "pages.get": async (args) => {
    const id = String(args.id ?? "");
    if (!id) return { ok: false, error: "pages.get 需要 id" };
    const p = await api.getPage(id);
    if (!p) return { ok: false, error: `未找到页面 ${id}` };

    // ⚠️ **这里刻意不再 `trim()`**（2026-09-18 改）。原因不是洁癖，是分页一旦存在，
    // 窗口的"起点"就必须是**同一个固定字符串**：
    //   · 桌面路径（Rust `cap_pages_get`）切的是库里原始的正文列；
    //   · 这里若先 trim，`offset=6000` 在两条路径上指向的**不是同一个字符**
    //     ⇒ 调用方按同一条规则翻页会漏字/重字，而这种错**只在正文首尾有空白时**才出现（极难发现）。
    // 返回忠实原文也顺带满足"截断不改写文本"的既有原则（见下）。
    const raw = String(p.content_text ?? "");
    const total = codePointLength(raw); // 按码点计数，emoji 不会被算成 2
    const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
    const limit = Math.min(MAX_PAGE_TEXT_LIMIT, Math.max(1, Math.floor(Number(args.limit ?? PAGE_TEXT_LIMIT)) || PAGE_TEXT_LIMIT));
    const text = sliceByCodePoints(raw, offset, limit);
    const returned = codePointLength(text);
    // `truncated` 的含义是"**还没读完**"（窗口没够到正文末尾），而不是"这页太长"：
    // 翻到最后一页时它必须是 false，否则模型会以为还有内容、无限翻下去。
    const truncated = offset + returned < total;

    // ⚠️ **"成功"不等于"读全了"** —— 与抽取层的 `ExtractCoverage` 同一条原则（方案 §15.10）。
    // 原先截断后只在末尾补一个 `…`，有两个问题：
    //  ① **有歧义**：原文本身可能就以省略号结尾，模型分不清哪个是我们加的；
    //  ② **没信号**：模型看到 6000 字会以为"这就是整页"，然后自信地总结一个片段。
    // ⇒ 现在**不再改写文本**（返回的就是原文的忠实窗口），截断与否由**显式字段**说明，
    //    并且**直接告诉模型下一步该做什么**（否则它拿到"已截断"也不知道怎么办）。
    const parts: string[] = [];
    if (truncated) {
      parts.push(
        `内容已截断：该页正文共 ${total} 字，本次返回第 ${offset + 1}~${offset + returned} 字。` +
          `**不要据此以为读完了整页**；继续读取请再调 pages.get 并传 offset=${offset + returned}` +
          `（也可先 pages.search 定位相关段落，再用 blocks.list 逐块读）。`,
      );
    } else if (offset > 0) {
      // 翻到末尾时也要有明确信号，否则模型分不清"读完了"和"传错 offset 拿到空串"。
      parts.push(`本次返回第 ${offset + 1}~${offset + returned} 字，已到正文末尾（共 ${total} 字）。`);
    }
    return {
      ok: true,
      page: {
        id: p.id,
        title: p.title,
        content_text: text,
        truncated,
        chars_total: total,
        offset,
        limit,
        chars_returned: returned,
        ...(parts.length ? { note: parts.join("") } : {}),
      },
    };
  },

  "blocks.list": async (args) => {
    const pageId = String(args.pageId ?? "");
    if (!pageId) return { ok: false, error: "blocks.list 需要 pageId" };
    const blocks = await api.getPageBlocks(pageId);
    return { ok: true, blocks: blocks.map((b) => ({ blockId: b.block_id, text: b.text })) };
  },

  "backlinks.list": async (args, ctx) => {
    const pageId = targetPage(args, ctx);
    if (!pageId) return { ok: false, error: "backlinks.list 需要 pageId" };
    const links = await api.getBacklinks(pageId);
    return { ok: true, backlinks: links.map((l) => ({ id: l.id, title: l.title })) };
  },

  "files.list": async (args, ctx) => {
    const pageId = targetPage(args, ctx);
    if (!pageId) return { ok: false, error: "files.list 需要 pageId" };
    const files = await api.listPageAttachments(pageId);
    return {
      ok: true,
      files: files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size })),
    };
  },

  "files.search": async (args) => {
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, error: "files.search 需要 query" };
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(100, args.limit) : 10;
    const hits = await api.searchChunks(query, limit);
    // 原样透出（pageId/attId/loc 就是回链三件套）：这一层**不加工**，
    // 免得 AI 与插件看到两种形状 —— 加工（拼标题、去重）属于调用方的展示逻辑。
    return { ok: true, hits };
  },

  "files.read": async (args) => {
    const id = String(args.id ?? "");
    if (!id) return { ok: false, error: "files.read 需要 id" };
    const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(1000, Math.floor(args.limit)) : 200;
    const page = await api.readAttachmentText(id, offset, limit);
    // ⚠️ **不存在**（null）与**还没抽过**（segments 空）必须分开回话：
    //    合成一种，AI 就会把"还没索引"读成"文件里没有相关内容" —— 与 §15.10 用 ExtractCoverage
    //    防的是同一件事，只是发生在 AI 工具面。
    if (page === null) return { ok: true, file: null };
    return {
      ok: true,
      file: {
        id,
        segments: page.segments.map((r) => ({ extractor: r.extractor, kind: r.kind, text: r.text, loc: r.loc })),
        total: page.total,
        truncated: page.truncated,
        ...(page.segments.length === 0
          ? {
              note:
                "该附件没有派生文本：可能没有抽取器认领这种格式、抽取失败、或还没跑过抽取。" +
                "**不要**据此断言文件里没有相关内容。",
            }
          : {}),
      },
    };
  },

  "pages.create": async (args) => {
    const title = String(args.title ?? "").trim();
    if (!title) return { ok: false, error: "pages.create 需要 title" };
    const { content_json, content_text } = pageJsonFromText(String(args.content ?? ""), makeId);
    const parentId = typeof args.parentId === "string" && args.parentId ? args.parentId : null;
    return draft(`create_page:${title}`, `新建页面「${title}」`, {
      kind: "create_page",
      args: { parent_id: parentId, title, content_json, content_text },
    });
  },

  "blocks.append": async (args, ctx) => {
    const pageId = targetPage(args, ctx);
    const text = String(args.text ?? "").trim();
    if (!pageId) return { ok: false, error: "blocks.append 需要 pageId" };
    if (!text) return { ok: false, error: "blocks.append 需要 text" };
    return draft(
      `append_block:${pageId}:${text.slice(0, 24)}`,
      `向页面追加 ${text.split("\n").filter((s) => s.trim()).length} 个段落`,
      { kind: "append_block", pageId, text },
    );
  },
};
