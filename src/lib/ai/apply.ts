// Commit layer. The host loop never mutates; applying a confirmed draft is the
// ONLY place a write reaches the semantic command layer. Keeping this separate
// makes the "draft → confirm → commit" boundary explicit and hard to bypass.

import { api } from "../api";
import { appendBlocksToJson, contentTextOf } from "./lexical";
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
      const page = await api.createPage({
        parent_id: p.args?.parent_id ?? null,
        title: String(p.args?.title ?? ""),
        content_json: String(p.args?.content_json || '{"root":{"children":[]}}'),
        content_text: String(p.args?.content_text ?? ""),
      });
      return { ok: true, message: `已创建页面「${page.title}」`, page };
    }

    case "append_block": {
      const pageId = String(p.pageId ?? "");
      const text = String(p.text ?? "");
      if (!pageId || !text) return { ok: false, message: "append_block 参数不完整" };
      const cur = await api.getPage(pageId);
      if (!cur) return { ok: false, message: "目标页面不存在" };
      // Re-read at commit time so concurrent edits are not clobbered: we append to
      // whatever is current rather than to the snapshot from draft time.
      const content_json = appendBlocksToJson(cur.content_json, text, () => uid());
      const content_text = contentTextOf(content_json);
      const page = await api.savePage({ id: pageId, content_json, content_text });
      return { ok: true, message: `已向「${page.title}」追加内容`, page };
    }

    default:
      return { ok: false, message: `未知草稿类型: ${kind || "(空)"}` };
  }
}

function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `blk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
