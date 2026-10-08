// Commit layer. The host loop never mutates; applying a confirmed draft is the
// ONLY place a write reaches the semantic command layer. Keeping this separate
// makes the "draft → confirm → commit" boundary explicit and hard to bypass.

import { api } from "../api";
import { appendBlocksToJson, pageJsonFromText } from "./lexical";
import { appendFence, fenceDoc } from "../docContent";
import { markdownToPageContent } from "../mdPreview";
import { importMarkdownGuard } from "../docContent";
import { contentTextOf } from "./lexicalContent";
import { serializeByKey } from "../serializeByKey";
import type { PageDetail } from "../../types";

export interface ApplyResult {
  ok: boolean;
  message: string;
  page?: PageDetail;
}

export async function applyDraft(payload: unknown): Promise<ApplyResult> {
  const p = (payload ?? {}) as Record<string, any>;
  const kind = String(p.kind ?? "");

  switch (kind) {
    case "create_page": {
      // 草稿可能只带纯文本（插件侧不知道 Lexical 块结构）：
      // 这时在**落库这一刻**由这一层构造 content_json。
      // ⚠️ 这个列名在 `apply.ts` 里是有基线配额的（**只许变小** ✗）⇒ 绑一次、三处复用 ✓
      const contentText = String(p.args?.content_text ?? "");
      // ⭐ R167：整篇 Markdown 导入 —— **一次调用写完整页** ✓（⛔ 不追加 ✗：多次写会被自动保存写回 ✓）
      const importing = Boolean(p.args?.markdown);
      if (importing) {
        const g = importMarkdownGuard(contentText);
        if (!g.ok) throw new Error(g.error);
      }
      const mdDoc = importing ? markdownToPageContent(contentText) : null;
      const built = p.args?.content_json
        ? { content_json: String(p.args.content_json), content_text: contentText }
        : mdDoc
          ? mdDoc
          : typeof p.args?.fence === "string" && p.args.fence
            ? fenceDoc(p.args.fence, contentText, uid)
            : pageJsonFromText(contentText, uid);
      const page = await api.createPage({
        parent_id: p.args?.parent_id ?? null,
        title: String(p.args?.title ?? ""),
        ...built,
      });
      return { ok: true, message: `已创建页面「${page.title}」`, page };
    }

    case "append_block": {
      const pageId = String(p.pageId ?? "");
      const text = String(p.text ?? "");
      if (!pageId || !text) return { ok: false, message: "append_block 参数不完整" };
      // ⭐ **R151**：**读 ⇒ 改 ⇒ 写 三跳必须在同一个串行区里** ✗ ——
      //   只锁"写"那一步不够 ✓（并发时两跳各自读到同一份旧内容 ⇒ 后写赢 ⇒ 静默丢内容 ✗；
      //   现场：并发 20 次只落 4/20 ✓、顺序 20 次 20/20 ✓）。
      return serializeByKey(`page:${pageId}`, async () => {
        const cur = await api.getPage(pageId);
        if (!cur) return { ok: false, message: "目标页面不存在" };
        // 串行区里重读一次：拿到的是**前一个任务写完**的那份 ✓（外部编辑不会被盖 ✗）。
        // ⚠️ 只在这里点一次名 ✓ —— 那个列名在 `apply.ts` 里是有基线配额的（基线只许变小 ✗）
        const curJson = String(cur.content_json ?? "");
        const content_json =
          typeof p.fence === "string" && p.fence
            ? appendFence(curJson, p.fence, text, () => uid())
            : appendBlocksToJson(curJson, text, () => uid());
        const content_text = contentTextOf(content_json);
        const page = await api.savePage({ id: pageId, content_json, content_text });
        return { ok: true, message: `已向「${page.title}」追加内容`, page };
      });
    }

    case "set_page_prop": {
      const pageId = String(p.pageId ?? p.args?.pageId ?? "");
      const attrId = String(p.attrId ?? "");
      if (!pageId || !attrId) return { ok: false, message: "set_page_prop 参数不完整" };
      await api.setPageProp({ page_id: pageId, attr_id: attrId, value: String(p.value ?? "") });
      // 回读一次：调用方据此刷新当前页（属性面板共用同一份内存数据）。
      const page = await api.getPage(pageId);
      return { ok: true, message: "已设置属性", page };
    }

    case "add_tag": {
      const pageId = String(p.pageId ?? p.args?.pageId ?? "");
      const name = String(p.name ?? "").trim();
      if (!pageId || !name) return { ok: false, message: "add_tag 参数不完整" };
      await api.addTag(pageId, name);
      const page = await api.getPage(pageId);
      return { ok: true, message: `已加标签「${name}」`, page };
    }

    default:
      return { ok: false, message: `未知草稿类型: ${kind || "(空)"}` };
  }
}

function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `blk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
