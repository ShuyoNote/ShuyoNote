// Commit layer. The host loop never mutates; applying a confirmed draft is the
// ONLY place a write reaches the semantic command layer. Keeping this separate
// makes the "draft → confirm → commit" boundary explicit and hard to bypass.

import { api } from "../api";
import { appendBlocksToJson, pageJsonFromText } from "./lexical";
import { appendFence, fenceDoc, stampTopLevelBlockIds } from "../docContent";
import { markdownToPageContent } from "../mdPreview";
import { importMarkdownGuard } from "../docContent";
import { contentTextOf } from "./lexicalContent";
import { pageRev } from "../capabilities/pageAnchors";
import { docJsonOfPage } from "../docContent";
import { serializeByKey } from "../serializeByKey";
import { useSpaceStore } from "../../store/space";
import type { PageDetail } from "../../types";

export interface ApplyResult {
  ok: boolean;
  message: string;
  page?: PageDetail;
}

/** 写前乐观并发校验：草稿带了 `expectedRev` 就必须与当前一致（不一致 ⇒ 拒，⛔ 不覆盖）。 */
async function revProblem(pageId: string, expected: unknown): Promise<string | null> {
  if (typeof expected !== "string" || !expected.trim()) return null;
  const page = await api.getPage(pageId);
  if (!page) return `目标页面 ${pageId} 不存在`;
  const cur = await pageRev(page.updated_at, docJsonOfPage(page));
  if (!cur) return "算不出当前 rev（正文读不到）";
  if (cur !== expected) {
    return `rev_conflict：expectedRev=${expected}，当前 rev=${cur}（请重新读一遍再改）`;
  }
  return null;
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
      const mdDoc = importing
        ? (() => {
            const doc = markdownToPageContent(contentText);
            // ⭐ 2026-10-17：Markdown 转出来的块没有 blockId，而 CRDT 播种不造身份 ⇒ 落库前先补种一次。
            return doc ? stampTopLevelBlockIds(doc) : null;
          })()
        : null;
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

    case "update_page": {
      // ⭐ pages.update（2026-10-17）：**整页替换**已有页面（不是追加）。
      //   正文可以是 Markdown 原文（复用导入管道 `markdownToPageContent` ✓，全仓一份解析）
      //   或纯文本（`pageJsonFromText` ✓）；目标页必须已存在（不存在就报错，不偷偷新建 ✗）。
      //   ⚠️ 串行化与 append_block 同理：读 ⇒ 改 ⇒ 写三跳同区，避免和自动保存互相覆盖。
      const pageId = String(p.pageId ?? p.args?.pageId ?? "");
      const title = typeof p.title === "string" && p.title.trim() ? p.title.trim() : undefined;
      const md = typeof p.markdown === "string" ? p.markdown : "";
      const plain = typeof p.plain === "string" ? p.plain : "";
      if (!pageId) return { ok: false, message: "update_page 参数不完整" };
      if (!md.trim() && !plain.trim()) return { ok: false, message: "update_page 需要新正文" };
      return serializeByKey(`page:${pageId}`, async () => {
        const cur = await api.getPage(pageId);
        if (!cur) return { ok: false, message: "目标页面不存在" };
        const rp = await revProblem(pageId, p.expectedRev);
        if (rp) return { ok: false, message: rp };
        let built;
        if (md.trim()) {
          const g = importMarkdownGuard(md);
          if (!g.ok) throw new Error(g.error);
          const doc = markdownToPageContent(md);
          if (!doc) return { ok: false, message: "Markdown 转块失败（正文为空）" };
          built = doc;
        } else {
          built = pageJsonFromText(plain, uid);
        }
        // ⭐ 2026-10-17：同上 —— 整页写入前补块身份（CRDT 播种不造身份，缺了会播种失败）。
        built = stampTopLevelBlockIds(built);
        const page = await api.savePage({ id: pageId, ...(title ? { title } : {}), ...built });
        return { ok: true, message: `已更新「${page.title}」`, page };
      });
    }

    case "switch_space": {
      // ⭐ spaces.switch（2026-10-17）：真正切空间的唯一实现是 space store（换连接 + 刷新界面）。
      //   这里只把草稿交给它，不另写一条切换路径。
      const spaceId = String(p.spaceId ?? "");
      if (!spaceId) return { ok: false, message: "switch_space 需要 spaceId" };
      const ok = await useSpaceStore.getState().switchTo(spaceId);
      return ok
        ? { ok: true, message: `已切换到空间「${String(p.name ?? spaceId)}」` }
        : { ok: false, message: "切换空间失败（可能需要口令或被拒绝）" };
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
        const rp = await revProblem(pageId, p.expectedRev);
        if (rp) return { ok: false, message: rp };
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
      const rp = await revProblem(pageId, p.expectedRev);
      if (rp) return { ok: false, message: rp };
      await api.setPageProp({ page_id: pageId, attr_id: attrId, value: String(p.value ?? "") });
      // 回读一次：调用方据此刷新当前页（属性面板共用同一份内存数据）。
      const page = await api.getPage(pageId);
      return { ok: true, message: "已设置属性", page };
    }

    case "add_tag": {
      const pageId = String(p.pageId ?? p.args?.pageId ?? "");
      const name = String(p.name ?? "").trim();
      if (!pageId || !name) return { ok: false, message: "add_tag 参数不完整" };
      const rp = await revProblem(pageId, p.expectedRev);
      if (rp) return { ok: false, message: rp };
      await api.addTag(pageId, name);
      const page = await api.getPage(pageId);
      return { ok: true, message: `已加标签「${name}」`, page };
    }

    // ⭐ B2-结构（2026-10-29）：节点/文件夹/回收站/回退/标签移除/属性去掉
    case "create_folder": {
      const title = String(p.title ?? "").trim();
      if (!title) return { ok: false, message: "create_folder 需要 title" };
      const folder = await api.createFolder({ parent_id: p.parent_id ?? null, title });
      return { ok: true, message: `已创建文件夹「${folder.title ?? title}」` };
    }

    case "move_node": {
      const id = String(p.id ?? "");
      if (!id) return { ok: false, message: "move_node 需要 id" };
      const rp = await revProblem(id, p.expectedRev);
      if (rp) return { ok: false, message: rp };
      await api.movePage({
        id,
        new_parent_id: p.newParentId ?? null,
        sort_order: Number.isFinite(Number(p.sortOrder)) ? Number(p.sortOrder) : 0,
      });
      return { ok: true, message: "已移动节点" };
    }

    case "rename_node": {
      const id = String(p.id ?? "");
      const title = String(p.title ?? "").trim();
      if (!id || !title) return { ok: false, message: "rename_node 参数不完整" };
      const rp = await revProblem(id, p.expectedRev);
      if (rp) return { ok: false, message: rp };
      const page = await api.savePage({ id, title });
      return { ok: true, message: `已改名为「${page.title}」`, page };
    }

    case "delete_node": {
      const id = String(p.id ?? "");
      if (!id) return { ok: false, message: "delete_node 需要 id" };
      const rp = await revProblem(id, p.expectedRev);
      if (rp) return { ok: false, message: rp };
      await api.deletePage(id);
      return { ok: true, message: "已移入回收站（可恢复）" };
    }

    case "restore_page": {
      const id = String(p.id ?? "");
      if (!id) return { ok: false, message: "restore_page 需要 id" };
      await api.restorePage(id);
      return { ok: true, message: "已从回收站恢复" };
    }

    case "revert_page": {
      const pageId = String(p.pageId ?? "");
      const versionId = String(p.versionId ?? "");
      if (!pageId || !versionId) return { ok: false, message: "revert_page 参数不完整" };
      const rp = await revProblem(pageId, p.expectedRev);
      if (rp) return { ok: false, message: rp };
      const page = await api.restoreVersion(versionId);
      return { ok: true, message: `已回退到版本 ${versionId}`, page };
    }

    case "remove_tag": {
      const pageId = String(p.pageId ?? "");
      const name = String(p.name ?? "").trim();
      const tagId = String(p.tagId ?? "");
      if (!pageId) return { ok: false, message: "remove_tag 需要 pageId" };
      const rp = await revProblem(pageId, p.expectedRev);
      if (rp) return { ok: false, message: rp };
      let resolved = tagId;
      if (!resolved && name) {
        const tags = await api.listTags();
        resolved = tags.find((x) => x.name === name)?.id ?? "";
      }
      if (!resolved) return { ok: false, message: `找不到标签「${name || tagId}」` };
      await api.removeTag(pageId, resolved);
      const page = await api.getPage(pageId);
      return { ok: true, message: `已移除标签「${name || resolved}」`, page };
    }

    case "unset_page_prop": {
      const pageId = String(p.pageId ?? "");
      const attrId = String(p.attrId ?? "");
      if (!pageId || !attrId) return { ok: false, message: "unset_page_prop 参数不完整" };
      const rp = await revProblem(pageId, p.expectedRev);
      if (rp) return { ok: false, message: rp };
      await api.removePageProp(pageId, attrId);
      const page = await api.getPage(pageId);
      return { ok: true, message: "已去掉属性", page };
    }

    default:
      return { ok: false, message: `未知草稿类型: ${kind || "(空)"}` };
  }
}

function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `blk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
