// 能力在**前端（渲染进程）**这一侧的实现。
//
// 插件那一侧的实现是 Rust（`src-tauri/src/plugins.rs` 的 cap_*）；两边消费的是
// **同一份注册表**（capabilities/capabilities.json），所以工具的 id / 描述 / 参数
// schema / 是不是写操作都只有一处定义——这里只负责"怎么在前端真去执行"。
// 门禁（scripts/check-capabilities.mjs）会校验注册表里 `ai:true` 的能力在这里都有实现。
//
// 语义要与插件侧保持一致：省略 pageId 时都用**当前打开的页面**（插件侧由宿主解析，
// 这一侧由 notes store 解析）。

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
 * `pages.get` 返回正文的**上限**（字）。
 *
 * ⚠️ 这个上限本身是既有行为（防止一页几万字把模型上下文撑爆），**没有改**。
 * 改的是"截断时**说不说**"——见 `pages.get` 实现里的注释。
 * 真正去掉这个上限需要给工具加 `offset`/`limit` 参数，而那要改
 * `capabilities/capabilities.json` 并重新生成（生成器会写出 `src-tauri/src/capabilities_gen.rs`）
 * ⇒ **Rust 侧不能在本机自验**，属"待可复核环境"的活（方案 §8.0 未做表）。
 */
const PAGE_TEXT_LIMIT = 6000;

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
    const text = (p.content_text ?? "").trim();
    const total = text.length;
    const truncated = total > PAGE_TEXT_LIMIT;

    // ⚠️ **"成功"不等于"读全了"** —— 与抽取层的 `ExtractCoverage` 同一条原则（方案 §15.10）。
    // 原先截断后只在末尾补一个 `…`，有两个问题：
    //  ① **有歧义**：原文本身可能就以省略号结尾，模型分不清哪个是我们加的；
    //  ② **没信号**：模型看到 6000 字会以为"这就是整页"，然后自信地总结一个片段。
    // ⇒ 现在**不再改写文本**（返回的就是原文的忠实前缀），截断与否由**显式字段**说明，
    //    并且**直接告诉模型下一步该做什么**（否则它拿到"已截断"也不知道怎么办）。
    return {
      ok: true,
      page: {
        id: p.id,
        title: p.title,
        content_text: truncated ? text.slice(0, PAGE_TEXT_LIMIT) : text,
        truncated,
        chars_total: total,
        chars_returned: truncated ? PAGE_TEXT_LIMIT : total,
        ...(truncated
          ? {
              note:
                `内容已截断：该页正文共 ${total} 字，这里只返回了前 ${PAGE_TEXT_LIMIT} 字。` +
                `**不要据此以为读完了整页**；请先 pages.search 定位相关段落，再用 blocks.list 逐块读。`,
            }
          : {}),
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
