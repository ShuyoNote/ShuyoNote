// Commit layer. The host loop never mutates; applying a confirmed draft is the
// ONLY place a write reaches the semantic command layer. Keeping this separate
// makes the "draft → confirm → commit" boundary explicit and hard to bypass.

import { api } from "../api";
import { platform } from "../platform";
import { importDocumentPackage } from "../docPackageTransfer";
import { uploadAttachmentFromPicker } from "../attachmentUpload";
import { appendBlocksToJson, pageJsonFromText } from "./lexical";
import { appendFence, fenceDoc, stampTopLevelBlockIds, templateContentFields, emptyPageContent } from "../docContent";
import { markdownToPageContent } from "../mdPreview";
import { importMarkdownGuard } from "../docContent";
import { contentTextOf } from "./lexicalContent";
import { pageRev } from "../capabilities/pageAnchors";
import { jsonTextOf, docJsonOfPage, saveFieldsWithChildren, topChildren } from "../docContent";
import { serializeByKey } from "../serializeByKey";
import { useSpaceStore } from "../../store/space";
import type { PageDetail } from "../../types";

export interface ApplyResult {
  ok: boolean;
  message: string;
  page?: PageDetail;
}

/** 写前乐观并发校验：草稿带了 `expectedRev` 就必须与当前一致（不一致 ⇒ 拒，⛔ 不覆盖）。 */
async function revProblem(pageId: string, expected: unknown, spaceId?: string): Promise<string | null> {
  if (typeof expected !== "string" || !expected.trim()) return null;
  const page = await api.getPage(pageId, spaceId);
  if (!page) return `目标页面 ${pageId} 不存在`;
  const cur = await pageRev(page.updated_at, docJsonOfPage(page));
  if (!cur) return "算不出当前 rev（正文读不到）";
  if (cur !== expected) {
    return `rev_conflict：expectedRev=${expected}，当前 rev=${cur}（请重新读一遍再改）`;
  }
  return null;
}

/** 把一段 Markdown/纯文本变成"新块数组"；首个块强制用给定 id（patch 要求 id 不变），其余新 id。 */
function blocksFromInput(
  markdown: string | undefined,
  plain: string | undefined,
  firstId?: string,
): Array<Record<string, unknown>> {
  const built =
    markdown && markdown.trim()
      ? (() => {
          const doc = markdownToPageContent(markdown);
          return doc ? topChildren(jsonTextOf(doc)) : [];
        })()
      : topChildren(jsonTextOf(pageJsonFromText(plain ?? "", uid)));
  if (built.length === 0) return built;
  return built.map((b, i) => ({
    ...b,
    blockId: i === 0 && firstId ? firstId : typeof b.blockId === "string" && b.blockId ? b.blockId : uid(),
  }));
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
        // ⭐ 跨空间写 v1：给了目标空间就传给命令（只有 pages.create 链路支持）
        ...(typeof p.args?.spaceId === "string" && p.args.spaceId
          ? { space_id: p.args.spaceId }
          : {}),
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
        const spaceId = typeof p.spaceId === "string" ? p.spaceId : undefined;
        const cur = await api.getPage(pageId, spaceId);
        if (!cur) return { ok: false, message: "目标页面不存在" };
        const rp = await revProblem(pageId, p.expectedRev, typeof p.spaceId === "string" ? p.spaceId : undefined);
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
        const page = await api.savePage({ id: pageId, spaceId, ...(title ? { title } : {}), ...built });
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
      const spaceId = typeof p.spaceId === "string" ? p.spaceId : undefined;
      // ⭐ **R151**：**读 ⇒ 改 ⇒ 写 三跳必须在同一个串行区里** ✗ ——
      //   只锁"写"那一步不够 ✓（并发时两跳各自读到同一份旧内容 ⇒ 后写赢 ⇒ 静默丢内容 ✗；
      //   现场：并发 20 次只落 4/20 ✓、顺序 20 次 20/20 ✓）。
      return serializeByKey(`page:${pageId}`, async () => {
        const cur = await api.getPage(pageId, spaceId);
        if (!cur) return { ok: false, message: "目标页面不存在" };
        const rp = await revProblem(pageId, p.expectedRev, typeof p.spaceId === "string" ? p.spaceId : undefined);
        if (rp) return { ok: false, message: rp };
        // 串行区里重读一次：拿到的是**前一个任务写完**的那份 ✓（外部编辑不会被盖 ✗）。
        // ⚠️ 只在这里点一次名 ✓ —— 那个列名在 `apply.ts` 里是有基线配额的（基线只许变小 ✗）
        const curJson = String(cur.content_json ?? "");
        const content_json =
          typeof p.fence === "string" && p.fence
            ? appendFence(curJson, p.fence, text, () => uid())
            : appendBlocksToJson(curJson, text, () => uid());
        const content_text = contentTextOf(content_json);
        const page = await api.savePage({ id: pageId, spaceId, content_json, content_text });
        return { ok: true, message: `已向「${page.title}」追加内容`, page };
      });
    }

    case "set_page_prop": {
      const pageId = String(p.pageId ?? p.args?.pageId ?? "");
      const attrId = String(p.attrId ?? "");
      if (!pageId || !attrId) return { ok: false, message: "set_page_prop 参数不完整" };
      const rp = await revProblem(pageId, p.expectedRev, typeof p.spaceId === "string" ? p.spaceId : undefined);
      if (rp) return { ok: false, message: rp };
      await api.setPageProp({ page_id: pageId, attr_id: attrId, value: String(p.value ?? ""), spaceId: typeof p.spaceId === "string" ? p.spaceId : undefined });
      // 回读一次：调用方据此刷新当前页（属性面板共用同一份内存数据）。
      const page = await api.getPage(pageId, typeof p.spaceId === "string" ? p.spaceId : undefined);
      return { ok: true, message: "已设置属性", page };
    }

    case "add_tag": {
      const pageId = String(p.pageId ?? p.args?.pageId ?? "");
      const name = String(p.name ?? "").trim();
      if (!pageId || !name) return { ok: false, message: "add_tag 参数不完整" };
      const rp = await revProblem(pageId, p.expectedRev, typeof p.spaceId === "string" ? p.spaceId : undefined);
      if (rp) return { ok: false, message: rp };
      await api.addTag(pageId, name, typeof p.spaceId === "string" ? p.spaceId : undefined);
      const page = await api.getPage(pageId, typeof p.spaceId === "string" ? p.spaceId : undefined);
      return { ok: true, message: `已加标签「${name}」`, page };
    }

    // ⭐ B2-结构（2026-10-29）：节点/文件夹/回收站/回退/标签移除/属性去掉
    case "create_folder": {
      const title = String(p.title ?? "").trim();
      if (!title) return { ok: false, message: "create_folder 需要 title" };
      const spaceId = typeof p.spaceId === "string" ? p.spaceId : undefined;
      const folder = await api.createFolder({ parent_id: p.parent_id ?? null, title, spaceId });
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
        spaceId: typeof p.spaceId === "string" ? p.spaceId : undefined,
      });
      return { ok: true, message: "已移动节点" };
    }

    case "rename_node": {
      const id = String(p.id ?? "");
      const title = String(p.title ?? "").trim();
      if (!id || !title) return { ok: false, message: "rename_node 参数不完整" };
      const rp = await revProblem(id, p.expectedRev);
      if (rp) return { ok: false, message: rp };
      const page = await api.savePage({ id, title, spaceId: typeof p.spaceId === "string" ? p.spaceId : undefined });
      return { ok: true, message: `已改名为「${page.title}」`, page };
    }

    case "delete_node": {
      const id = String(p.id ?? "");
      if (!id) return { ok: false, message: "delete_node 需要 id" };
      const rp = await revProblem(id, p.expectedRev);
      if (rp) return { ok: false, message: rp };
      await api.deletePage(id, typeof p.spaceId === "string" ? p.spaceId : undefined);
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
      const rp = await revProblem(pageId, p.expectedRev, typeof p.spaceId === "string" ? p.spaceId : undefined);
      if (rp) return { ok: false, message: rp };
      const page = await api.restoreVersion(versionId);
      return { ok: true, message: `已回退到版本 ${versionId}`, page };
    }

    case "remove_tag": {
      const pageId = String(p.pageId ?? "");
      const name = String(p.name ?? "").trim();
      const tagId = String(p.tagId ?? "");
      if (!pageId) return { ok: false, message: "remove_tag 需要 pageId" };
      const rp = await revProblem(pageId, p.expectedRev, typeof p.spaceId === "string" ? p.spaceId : undefined);
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
      const rp = await revProblem(pageId, p.expectedRev, typeof p.spaceId === "string" ? p.spaceId : undefined);
      if (rp) return { ok: false, message: rp };
      await api.removePageProp(pageId, attrId);
      const page = await api.getPage(pageId);
      return { ok: true, message: "已去掉属性", page };
    }

    case "blocks_patch": {
      const pageId = String(p.pageId ?? "");
      const blockId = String(p.blockId ?? "").trim();
      if (!pageId || !blockId) return { ok: false, message: "blocks_patch 参数不完整" };
      const rp = await revProblem(pageId, p.expectedRev, typeof p.spaceId === "string" ? p.spaceId : undefined);
      if (rp) return { ok: false, message: rp };
      const spaceId = typeof p.spaceId === "string" ? p.spaceId : undefined;
      const page = await api.getPage(pageId, spaceId);
      if (!page) return { ok: false, message: "目标页面不存在" };
      const children = topChildren(docJsonOfPage(page));
      const at = children.findIndex((b) => String((b as { blockId?: unknown }).blockId ?? "") === blockId);
      if (at < 0) return { ok: false, message: `块 ${blockId} 不在这一页的顶层` };
      const next = blocksFromInput(p.markdown, p.plain, blockId);
      if (next.length === 0) return { ok: false, message: "新块内容为空" };
      children.splice(at, 1, ...next);
      const saved = await api.savePage({ id: pageId, spaceId, ...saveFieldsWithChildren(docJsonOfPage(page), children, contentTextOf) });
      return { ok: true, message: `已替换块「${blockId}」`, page: saved };
    }

    case "blocks_insert": {
      const pageId = String(p.pageId ?? "");
      const afterBlockId = typeof p.afterBlockId === "string" && p.afterBlockId ? p.afterBlockId : null;
      const firstId = typeof p.newBlockId === "string" && p.newBlockId ? p.newBlockId : undefined;
      if (!pageId) return { ok: false, message: "blocks_insert 需要 pageId" };
      const rp = await revProblem(pageId, p.expectedRev, typeof p.spaceId === "string" ? p.spaceId : undefined);
      if (rp) return { ok: false, message: rp };
      const spaceId = typeof p.spaceId === "string" ? p.spaceId : undefined;
      const page = await api.getPage(pageId, spaceId);
      if (!page) return { ok: false, message: "目标页面不存在" };
      const children = topChildren(docJsonOfPage(page));
      const at = afterBlockId
        ? children.findIndex((b) => String((b as { blockId?: unknown }).blockId ?? "") === afterBlockId) + 1
        : 0;
      if (afterBlockId && at === 0) return { ok: false, message: `块 ${afterBlockId} 不在这一页的顶层` };
      const next = blocksFromInput(p.markdown, p.plain, firstId);
      if (next.length === 0) return { ok: false, message: "新块内容为空" };
      children.splice(at, 0, ...next);
      const saved = await api.savePage({ id: pageId, spaceId, ...saveFieldsWithChildren(docJsonOfPage(page), children, contentTextOf) });
      return { ok: true, message: "已插入新块", page: saved };
    }

    case "blocks_delete": {
      const pageId = String(p.pageId ?? "");
      const blockId = String(p.blockId ?? "").trim();
      if (!pageId || !blockId) return { ok: false, message: "blocks_delete 参数不完整" };
      const rp = await revProblem(pageId, p.expectedRev, typeof p.spaceId === "string" ? p.spaceId : undefined);
      if (rp) return { ok: false, message: rp };
      const spaceId = typeof p.spaceId === "string" ? p.spaceId : undefined;
      const page = await api.getPage(pageId, spaceId);
      if (!page) return { ok: false, message: "目标页面不存在" };
      const children = topChildren(docJsonOfPage(page));
      const at = children.findIndex((b) => String((b as { blockId?: unknown }).blockId ?? "") === blockId);
      if (at < 0) return { ok: false, message: `块 ${blockId} 不在这一页的顶层` };
      if (children.length <= 1) return { ok: false, message: "这是最后一个顶层块 —— 不制造空页面" };
      children.splice(at, 1);
      const saved = await api.savePage({ id: pageId, spaceId, ...saveFieldsWithChildren(docJsonOfPage(page), children, contentTextOf) });
      return { ok: true, message: `已删除块「${blockId}」`, page: saved };
    }

    // ⭐ B2-附件与模板（2026-10-29）：附件归属/改名/删除（引用检查已在能力层做）＋ 模板建页
    case "move_attachment": {
      const attId = String(p.attId ?? "");
      const toPageId = String(p.toPageId ?? "");
      if (!attId || !toPageId) return { ok: false, message: "move_attachment 参数不完整" };
      await api.moveAttachment(attId, toPageId, typeof p.spaceId === "string" ? p.spaceId : undefined);
      return { ok: true, message: "已移动附件" };
    }

    case "rename_attachment": {
      const attId = String(p.attId ?? "");
      const name = String(p.name ?? "").trim();
      if (!attId || !name) return { ok: false, message: "rename_attachment 参数不完整" };
      await api.renameAttachment(attId, name, typeof p.spaceId === "string" ? p.spaceId : undefined);
      return { ok: true, message: `已把附件改名为「${name}」` };
    }

    case "delete_attachment": {
      const attId = String(p.attId ?? "");
      if (!attId) return { ok: false, message: "delete_attachment 需要 attId" };
      await api.removeAttachment(attId, typeof p.spaceId === "string" ? p.spaceId : undefined);
      return { ok: true, message: "已删除附件条目（字节仍按内容寻址保留，除非没有任何引用）" };
    }

    case "apply_template": {
      const templateId = String(p.templateId ?? "");
      const parentId = typeof p.parentId === "string" && p.parentId ? p.parentId : null;
      if (!templateId) return { ok: false, message: "apply_template 需要 templateId" };
      const templates = await api.listTemplates();
      const tpl = templates.find((x) => x.id === templateId);
      if (!tpl) return { ok: false, message: "模板不存在（可先刷新模板列表）" };
      const page = await api.createPage({
        parent_id: parentId,
        title: tpl.name,
        ...templateContentFields(tpl),
      });
      return { ok: true, message: `已用模板「${tpl.name}」新建页面`, page };
    }

    // ⭐ B2-补遗-1（2026-10-29）：受控上传通道（系统文件选择框）＋ import.docpackage ＋ detach
    case "upload_attachment": {
      const pageId = String(p.pageId ?? "");
      if (!pageId) return { ok: false, message: "upload_attachment 需要 pageId" };
      const hint = typeof p.nameHint === "string" && p.nameHint ? p.nameHint : undefined;
      const r = await uploadAttachmentFromPicker(pageId, hint, {
        pickFile: async () => {
          const picked = await platform.dialog.open({ title: "选择要上传的文件", multiple: false });
          return typeof picked === "string" && picked ? picked : null;
        },
        importFiles: (pid, paths) => api.importAttachmentFiles(pid, paths),
        listAttachments: (pid) => api.listPageAttachments(pid),
        rename: (id, name) => api.renameAttachment(id, name),
        remove: async (id) => {
          await api.removeAttachment(id);
        },
      });
      if (r.kind === "ok") {
        return {
          ok: true,
          message: `已上传「${r.name}」（sha256=${r.sha256.slice(0, 12)}…，${r.size} 字节）`,
        };
      }
      if (r.kind === "cancelled") return { ok: false, message: "cancelled: 用户取消了文件选择（没有上传任何东西）" };
      return { ok: false, message: r.kind === "needs_confirm" ? r.message : r.message };
    }

    case "import_docpackage": {
      const parentId = typeof p.parentId === "string" && p.parentId ? p.parentId : null;
      const r = await importDocumentPackage(parentId);
      if (r.ok) return { ok: true, message: r.message };
      return { ok: false, message: r.canceled ? "cancelled: 用户取消了导入（没有新建任何页面）" : r.message };
    }

    case "detach_attachment": {
      const attId = String(p.attId ?? "");
      if (!attId) return { ok: false, message: "detach_attachment 需要 attId" };
      await api.detachAttachment(attId, typeof p.spaceId === "string" ? p.spaceId : undefined);
      return { ok: true, message: "已把附件从页面摘除（文件保留，变为未整理）" };
    }

    // ⭐ B2-补遗-2（2026-10-29）：数据库行写入/删除 —— 行是数据库页的**子页面**（title + page_props），
    //   所以落库复用**既有命令**（createPage / setPageProp / deletePage），零新写库入口。
    case "db_rows_write": {
      const pageId = String(p.pageId ?? "");
      const rows = Array.isArray(p.rows) ? (p.rows as Array<Record<string, unknown>>) : [];
      if (!pageId || rows.length === 0) return { ok: false, message: "db_rows_write 参数不完整" };
      const rp = await revProblem(pageId, p.expectedRev, typeof p.spaceId === "string" ? p.spaceId : undefined);
      if (rp) return { ok: false, message: rp };
      let changed = 0;
      for (const row of rows) {
        const rowId = typeof row.rowId === "string" && row.rowId ? row.rowId : "";
        let target = rowId;
        if (!target) {
          const title = String(row.title ?? "").trim();
          const created = await api.createPage({ parent_id: pageId, title, ...emptyPageContent() });
          target = created.id;
        } else if (typeof row.title === "string" && row.title.trim()) {
          await api.savePage({ id: target, title: row.title.trim() });
        }
        const props = Array.isArray(row.props) ? (row.props as Array<Record<string, unknown>>) : [];
        for (const prop of props) {
          await api.setPageProp({
            page_id: target,
            attr_id: String(prop.attrId ?? ""),
            value: String(prop.value ?? ""),
          });
        }
        changed += 1;
      }
      return { ok: true, message: `已写入数据库行（${changed} 行）` };
    }

    case "db_rows_delete": {
      const pageId = String(p.pageId ?? "");
      const rowIds = Array.isArray(p.rowIds) ? (p.rowIds as unknown[]).map((x) => String(x)) : [];
      if (!pageId || rowIds.length === 0) return { ok: false, message: "db_rows_delete 参数不完整" };
      const rp = await revProblem(pageId, p.expectedRev, typeof p.spaceId === "string" ? p.spaceId : undefined);
      if (rp) return { ok: false, message: rp };
      for (const id of rowIds) await api.deletePage(id);
      return { ok: true, message: `已删除数据库行（${rowIds.length} 行）` };
    }

    default:
      return { ok: false, message: `未知草稿类型: ${kind || "(空)"}` };
  }
}

function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `blk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
