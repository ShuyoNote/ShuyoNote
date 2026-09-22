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
  /**
   * 语音转写（音视频）。
   *
   * 与 `vision` 同一条口径：**没给 ⇒ `av.transcript@1` 走 `provider_error`**（不瞎试网络）。
   * 实装在 `src/lib/ai/localTranscribe.ts`（本机端点），由调用方构造后传进来 ——
   * 抽取层与平台层都不该自己造网络客户端（契约 §15.3-1）。
   */
  transcribe?: ExtractDeps["transcribe"];
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
    const r = await extractAttachment(attId, stores, {
      ...(opts.vision ? { vision: opts.vision } : {}),
      ...(opts.transcribe ? { transcribe: opts.transcribe } : {}),
    });
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

// ---------------------------------------------------------------- 全库

export interface LibraryIndexReport {
  pages: { total: number; ok: number; failed: number };
  attachments: {
    total: number;
    /** 有块 = 检索面看得到。 */
    searchable: number;
    /** 按 `ExtractOutcome.status` 分组。 */
    byStatus: Record<string, number>;
  };
  /** 库里**当前**的块总数（页面 + 附件，来自一次 `stats()`；不编造分项）。 */
  chunks: { total: number };
  unfiled: UnfiledIndexResult;
  /** 明细只放有问题的（全库清单没有信息量）——与覆盖报告同一条口径。 */
  failures: { kind: "page" | "attachment"; id: string; reason: string }[];
  summary: string;
}

export interface IndexLibraryOptions extends IndexPageOptions {
  /** 进度回调 `(done, total, label)`。**顺序执行** ⇒ `done` 单调递增，可直接驱动进度条。 */
  onProgress?: (done: number, total: number, label: string) => void;
}

/**
 * **全库索引**：列出所有页面逐个索引，再索引"未整理"的附件 —— 即 UI 上那个「开始索引」。
 *
 * ## 为什么是**顺序**执行
 * 方案 §9 的架构约束：本机显存放不下「文本模型＋嵌入＋VLM」三件常驻，**抽取必须排队错峰**。
 * 并发跑只会把内存/显存顶满，而用户感知不到"更快" —— 所以他这里**不提供并发参数**：
 * 想快应该去解决"跑在哪台机器"（§13 第 7 项），而不是在这里加并发。
 *
 * ## 三条不变量
 * 1. **一页失败不停整个库**：坏页面/坏附件都会记进 `failures`，其余的照样索引完。
 * 2. **可重复、可中断**：每步都走 `indexPage` 的缓存判据 ⇒ 中断后重跑，已索引的部分**几乎不花时间**。
 * 3. **只处理已导入的内容**：页面来自 `listPages`、附件来自 `listPageAttachments`，
 *    **不遍历用户磁盘**（§10 红线）。
 *
 * ⚠️ **这个函数本身不做"什么时候跑"的决定**。它在页面保存路径之外，是**用户显式动作**。
 * 把索引悄悄挂到每次保存上是有性能含义的行为改动，应由应用层按自己的节奏（去抖/空闲）调用它。
 */
export async function indexLibrary(
  stores: IndexPageStores,
  opts: IndexLibraryOptions = {},
): Promise<LibraryIndexReport> {
  const pageIds = (await api.listPages()).map((p) => p.id);
  const total = pageIds.length + 1; // +1 是"未整理附件"那一步
  const failures: LibraryIndexReport["failures"] = [];
  const byStatus: Record<string, number> = {};
  let attTotal = 0;
  let attSearchable = 0;
  let ok = 0;

  const tally = (list: PageAttachmentIndex[]) => {
    for (const a of list) {
      attTotal++;
      if (a.chunks > 0) attSearchable++;
      byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
      if (a.status === "failed") {
        failures.push({ kind: "attachment", id: a.attId, reason: a.code ?? "failed" });
      }
    }
  };

  for (let i = 0; i < pageIds.length; i++) {
    const id = pageIds[i];
    opts.onProgress?.(i, total, `页面 ${id}`);
    try {
      const r = await indexPage(id, stores, opts);
      ok++;
      tally(r.attachments);
    } catch (e) {
      // 一页取不到/坏掉 ⇒ 记下来继续（否则一个坏页面会让整库索引停在半路）
      failures.push({ kind: "page", id, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  opts.onProgress?.(pageIds.length, total, "未整理附件");
  const unfiled = await indexUnfiled(stores, opts);
  tally(unfiled.attachments);
  opts.onProgress?.(total, total, "完成");

  const chunks = (await stores.chunks.stats()).chunks;
  return {
    pages: { total: pageIds.length, ok, failed: pageIds.length - ok },
    attachments: { total: attTotal, searchable: attSearchable, byStatus },
    chunks: { total: chunks },
    unfiled,
    failures,
    summary:
      `页面 ${ok}/${pageIds.length} 已索引；附件 ${attSearchable}/${attTotal} 可检索` +
      (failures.length > 0 ? `；失败 ${failures.length}` : "") +
      `；块 ${chunks}`,
  };
}
