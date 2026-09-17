// 「把一个页面索引完整」—— 把已有的三块接成一条链：
//   ① 页面正文 → 块（`platform/pageChunks.ts`）
//   ② 该页的每个附件 → 抽取 → 派生文本 → 顺手分块（`platform/extractDeps.ts`）
//   ③ 汇总成一句可记日志/可展示的结果
//
// ## 为什么需要这个编排层
// 上面两块**各自都有入口**，但**没有任何地方按"一个页面"把它们串起来**：
// 页面保存时应触发的是"这一页现在可检索了吗"，而不是"某个附件抽了吗"。
// ⇒ 这个函数就是那个**单位**：UI 一次保存调它一次，全库索引循环也按它迭代。
//
// ## 三条刻意的不变量
// 1. **单个附件失败不拖垮整页**：加密件/损坏件是常态，一个失败不应让整页的索引工作白做。
//    失败**如实进结果**（`status` / `code`），由调用方决定要不要提示。
// 2. **重复调用很便宜**：`chunkPage` 内容没变就不写库、`extractAttachment` 命中缓存就什么都不做
//    ⇒ 页面保存时无脑调用它，不必自己判断"要不要重新索引"。
// 3. **不碰检索侧**：这里只负责"把内容放进派生层"，怎么检索是检索那一层的事（Mac 已认领）。
//
// ## 已知边界（不解决，只是说清）
// - 页面里 `content_text` 之外的内容（图片/视频/数据库块/绘图结构）**不在本函数的范围**：
//   图片/附件由②负责，数据库块与绘图结构属 P3。
// - **不遍历用户磁盘**（方案 §10 红线）：只处理**已导入的附件**（即 `listPageAttachments` 的返回）。

import { api } from "./api";
import { extractAttachment } from "./platform/extractDeps";
import { chunkPage, type ChunkPageResult } from "./platform/pageChunks";
import type { AttachmentTextStore } from "./extract/store";
import type { ChunkStore } from "./extract/chunkStore";
import type { ExtractDeps } from "./extract/types";

export interface PageAttachmentIndex {
  attId: string;
  /** 抽取结果的状态（与 `ExtractOutcome.status` 同义）。 */
  status: "cached" | "stored" | "no_extractor" | "failed";
  /** 该附件当前的块数。 */
  chunks: number;
  /** 失败时的错误码（其余情况没有）。 */
  code?: string;
}

export interface PageIndexResult {
  pageId: string;
  page: ChunkPageResult;
  attachments: PageAttachmentIndex[];
  /** 一句话摘要（直接可记日志/展示）。 */
  summary: string;
}

export interface IndexPageStores {
  text: AttachmentTextStore;
  chunks: ChunkStore;
}

export interface IndexPageOptions {
  /** 视觉模型调用（扫描件/图片）。**没给 ⇒ 需要它的抽取器走 `provider_error`**，不会瞎试网络。 */
  vision?: ExtractDeps["vision"];
  /** 只处理这些附件（给"我只要重抽这一个"的场景）。省略 = 该页全部附件。 */
  onlyAttachmentIds?: readonly string[];
}

/** 把一个页面索引完整（正文分块 + 全部附件抽取分块）。 */
export async function indexPage(
  pageId: string,
  stores: IndexPageStores,
  opts: IndexPageOptions = {},
): Promise<PageIndexResult> {
  // ① 页面正文 —— 先做，因为它最便宜，且失败要立刻暴露（附件再多也救不了一个空的页面记录）
  const page = await chunkPage(pageId, stores.chunks);

  // ② 该页的附件。⚠️ `listPageAttachments(pageId)` 是按页过滤 —— 传 null 是"未整理"，
  //    那是另一批（见 `libraryCoverage.ts` 的注释），这里**不该**顺手把它们也算进来。
  const listed = await api.listPageAttachments(pageId);
  const only = opts.onlyAttachmentIds ? new Set(opts.onlyAttachmentIds) : null;
  const targets = listed.filter((a) => (only ? only.has(a.id) : true));

  const attachments: PageAttachmentIndex[] = [];
  for (const att of targets) {
    // ⚠️ 这里**不把 `att.mime`/`att.name` 传下去**：`extractAttachment` 自己去平台取 meta
    // （那是单一来源），分派用它的那份。列表里的 meta 只用来"知道有哪些附件"。
    // 代价是每附件多一次 `get_attachment` —— 换来的是"抽取的输入只有一处定义"，
    // 不会出现"列表说 docx、平台说 pdf"这种两套真相。
    attachments.push(await indexOne(att.id, stores, opts));
  }

  return { pageId, page, attachments, summary: summarizePageIndex({ pageId, page, attachments }) };
}

/** 一句话摘要：把"这一页现在可检索了吗"说清。 */
function summarizePageIndex(r: Omit<PageIndexResult, "summary">): string {
  const failed = r.attachments.filter((a) => a.status === "failed");
  const noExtractor = r.attachments.filter((a) => a.status === "no_extractor");
  const indexed = r.attachments.filter((a) => a.chunks > 0);
  const parts = [
    `页面块 ${r.page.chunks}`,
    `附件 ${r.attachments.length} 个（可检索 ${indexed.length}）`,
  ];
  if (noExtractor.length > 0) parts.push(`无抽取器 ${noExtractor.length}`);
  if (failed.length > 0) parts.push(`失败 ${failed.length}（${[...new Set(failed.map((f) => f.code))].join("/")}）`);
  return parts.join("，");
}

/** 未整理附件的索引结果（与 `PageAttachmentIndex` 同形，只是没有 page 那一半）。 */
export interface UnfiledIndexResult {
  attachments: PageAttachmentIndex[];
  summary: string;
}

/**
 * 索引**未整理**的附件（`page_id IS NULL`，即空间根下没归到任何页面的文件）。
 *
 * ## 为什么必须有它（否则覆盖报告会一直指着一个补不掉的缺口）
 * `indexPage` 是**按页**的，够不着这批文件；而 `scanLibraryCoverage` 的取材是
 * "逐页列举 **+ 一次未整理**" ⇒ 报告会把它们算成"未索引"，
 * **却没有任何一条路径能把它们索引掉** —— 用户看到"有 N 个没索引"，然后无事可做。
 * ⇒ 这个函数就是那条路径：**报告指出的缺口，要有对应的修复入口**。
 *
 * ⚠️ **不遍历磁盘**（§10 红线）：`listPageAttachments(null)` 返回的是**已导入**的附件。
 */
export async function indexUnfiled(
  stores: IndexPageStores,
  opts: IndexPageOptions = {},
): Promise<UnfiledIndexResult> {
  const listed = await api.listPageAttachments(null);
  const only = opts.onlyAttachmentIds ? new Set(opts.onlyAttachmentIds) : null;
  const targets = listed.filter((a) => (only ? only.has(a.id) : true));

  const attachments: PageAttachmentIndex[] = [];
  for (const att of targets) {
    attachments.push(await indexOne(att.id, stores, opts));
  }
  const failed = attachments.filter((a) => a.status === "failed").length;
  const indexed = attachments.filter((a) => a.chunks > 0).length;
  return {
    attachments,
    summary: `未整理附件 ${attachments.length} 个（可检索 ${indexed}${failed ? `，失败 ${failed}` : ""}）`,
  };
}

/** 索引单个附件（`indexPage` 与 `indexUnfiled` 共用的那一段）。**失败不抛**：如实记进结果。 */
async function indexOne(
  attId: string,
  stores: IndexPageStores,
  opts: IndexPageOptions,
): Promise<PageAttachmentIndex> {
  try {
    const r = await extractAttachment(attId, stores, opts.vision ? { vision: opts.vision } : {});
    return {
      attId,
      status: r.outcome.status,
      chunks: r.chunks,
      ...(r.outcome.status === "failed" ? { code: r.outcome.code } : {}),
    };
  } catch {
    // 读字节/取 meta 就失败（附件不存在、盘上没字节）—— **不中断整批**，也不假装成功。
    return { attId, status: "failed", chunks: 0, code: "internal" };
  }
}
