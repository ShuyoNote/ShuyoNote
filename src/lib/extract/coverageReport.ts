// 索引覆盖报告 —— "全库 AI 覆盖"这个承诺应当**可度量**，而不是假设成功。
// 契约见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md（§15.10 的同一条原则）。
//
// ## 为什么要有它
// P1/P2 做完之后，"到底覆盖了多少"这个问题**没有任何地方能回答**：
// 抽失败的附件不会留行（失败不毁旧数据），空页面与"只有图片的页面"在派生层长得一样，
// 没有抽取器认领的格式与"抽出来是空的"也无法区分。
// ⇒ 结果就是用户（和 AI）**没法知道库里哪些内容其实没进检索面** ——
// 这正是 §15.10 那条"「成功」不等于「抽全了」"的**全库版本**。
//
// ## 三条口径
// 1. **只读、纯函数**：不写库、不触发抽取。它回答"现在覆盖到哪"，不负责"去补齐"。
// 2. **"没被索引"必须分类**，因为三类的处理方式完全不同：
//    `no_extractor`（没人认领这种格式 → 要加抽取器）、
//    `no_content`（抽出来是空 → 可能是空文件/加密/纯图，要人工看）、
//    `page_empty`（页面在检索面没内容 → **但它的附件可能是被索引的**，见下）。
// 3. **明细只放"有问题的"**（`gaps`）。全库清单没有信息量，反而让人不看。
//
// ## ⚠️ 一个容易误读的地方，报告里必须说清
// **页面没有块 ≠ 这个页面的内容没被索引**：页面的图片/附件/数据库块**本来就不在 `content_text` 里**，
// 它们由**附件侧**（`attachment_text` / 附件块）负责。所以"页面空"与"附件已索引"是**互补**关系，
// 不是矛盾。报告里的 reason 文案就是这么写的，免得看报告的人去"修"一个不是问题的问题。
//
// ## 成本
// 每页一次 `chunksOf`、每附件一次 `segmentsOf` + `chunksOf` ⇒ **O(N) 次查询**。
// 对"用户主动点一下检查覆盖"这个场景足够；真要跑几十万附件，应先加批量查询（见文件末尾 TODO）。

import type { ChunkStore } from "./chunkStore";
import type { Extractor } from "./types";
import { pickExtractor, REGISTRY } from "./registry";
import type { AttachmentTextStore } from "./store";

/** 未被索引的原因（**分类**，因为处置方式不同）。 */
export type GapReason = "no_extractor" | "no_content" | "not_chunked" | "page_empty";

export interface AttachmentCoverage {
  attId: string;
  /** 落库的段数。 */
  segments: number;
  /** 落库的块数。 */
  chunks: number;
  /** 产出这些行的抽取器 id（`''` = 库里没有它的派生行）。 */
  extractor: string;
  /** 未被索引时的分类；已被索引则为 `null`。 */
  reason: GapReason | null;
}

export interface CoverageGap {
  kind: "page" | "attachment";
  id: string;
  reason: GapReason;
  /** 给人看的一句话（含"该怎么办"）。 */
  detail: string;
}

export interface CoverageReport {
  pages: { total: number; indexed: number; empty: number };
  attachments: {
    total: number;
    /** 抽到了文本的数量（**不等于**已索引，见 `not_chunked`）。 */
    extracted: number;
    /** **有块**的数量 —— 这才是"检索面看得到"。 */
    indexed: number;
    notIndexed: number;
    byReason: Record<string, number>;
  };
  /** 派生层的总量（来自 `text.stats()`，一次查询）。 */
  derived: { extractors: number; segments: number; chars: number };
  chunks: { total: number };
  gaps: CoverageGap[];
}

export interface CoverageSubject {
  pageIds: readonly string[];
  /** 附件清单。`mime` / `filename` 给了才能区分"没有抽取器认领"与"抽出来是空"。 */
  attachments: readonly { id: string; mime?: string; filename?: string }[];
}

export interface CoverageStores {
  text: AttachmentTextStore;
  chunks: ChunkStore;
}

export interface CoverageOptions {
  /** 用于判断"有没有抽取器认领这个格式"。默认用全局注册表。 */
  registry?: readonly Extractor[];
}

const DETAIL: Record<GapReason, string> = {
  no_extractor: "没有抽取器认领这种格式 —— 内容目前进不了检索面，需要补一个抽取器（或改用能抽的格式）",
  no_content: "抽取器认领了，但抽出来是 0 段 —— 可能是空文件、加密件、或整篇都是图片（后者要 OCR/视觉通道）",
  not_chunked:
    "**抽到了文本，但没有块** —— 检索面看到的是块，所以这份内容现在搜不到。" +
    "多半是「抽取跑了、分块那一步没跑」（两条链没有一起接线），不是抽取器的问题",
  page_empty:
    "页面正文在检索面没有内容 —— ⚠️ **这不一定是缺口**：页面的图片/附件/数据库块本来就不在 content_text 里，" +
    "由附件侧负责。请对照附件侧的覆盖情况再判断",
};

/**
 * 算出一份覆盖报告。**只读**：不抽取、不写库。
 *
 * ⚠️ 是 `async`：两个 store 的读方法现在是 [`Awaitable`]（桌面侧走命令面，必然异步，见 `store.ts` 的
 * `Awaitable` 注释）。**这里漏一个 `await` 不会报编译错**（仓库没有 `no-floating-promises`），
 * 症状是「覆盖报告恒为 0」—— 所以配套判据是 `coverageReport.test.ts` 里那个**慢假后端**用例。
 */
export async function indexCoverage(
  subject: CoverageSubject,
  stores: CoverageStores,
  opts: CoverageOptions = {},
): Promise<CoverageReport> {
  const registry = opts.registry ?? REGISTRY;
  const gaps: CoverageGap[] = [];

  // ---- 页面 ----
  let pageIndexed = 0;
  for (const pageId of subject.pageIds) {
    const n = (await stores.chunks.chunksOf({ kind: "page", pageId })).length;
    if (n > 0) {
      pageIndexed++;
      continue;
    }
    gaps.push({ kind: "page", id: pageId, reason: "page_empty", detail: DETAIL.page_empty });
  }

  // ---- 附件 ----
  let attExtracted = 0;
  let attIndexed = 0;
  const byReason: Record<string, number> = {};
  for (const att of subject.attachments) {
    const segments = (await stores.text.segmentsOf(att.id)).length;
    const chunks = (await stores.chunks.chunksOf({ kind: "attachment", attId: att.id })).length;
    if (segments > 0) attExtracted++;

    // **"已索引"以"有没有块"为准** —— 检索面看到的是块，不是段。
    if (segments > 0 && chunks > 0) {
      attIndexed++;
      continue;
    }

    let reason: GapReason;
    if (segments > 0) {
      // 抽到了文本但没块：**两条链没一起接线**，与"抽不出来"是两回事
      reason = "not_chunked";
    } else {
      // 分类：**先问"有没有人认领"**，再问"抽出来是不是空的"。
      // 拿不到 mime/filename 时不要瞎猜成 no_extractor —— 那会把"可能是空文件"说成"格式不支持"。
      const claimed =
        att.mime !== undefined || att.filename !== undefined
          ? pickExtractor(att.mime ?? "", att.filename ?? "", registry) !== null
          : true;
      reason = claimed ? "no_content" : "no_extractor";
    }
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    gaps.push({ kind: "attachment", id: att.id, reason, detail: DETAIL[reason] });
  }

  const stats = await stores.text.stats();
  return {
    pages: {
      total: subject.pageIds.length,
      indexed: pageIndexed,
      empty: subject.pageIds.length - pageIndexed,
    },
    attachments: {
      total: subject.attachments.length,
      extracted: attExtracted,
      indexed: attIndexed,
      notIndexed: subject.attachments.length - attIndexed,
      byReason,
    },
    derived: {
      extractors: stats.length,
      segments: stats.reduce((n, s) => n + s.rows, 0),
      chars: stats.reduce((n, s) => n + s.chars, 0),
    },
    chunks: { total: (await stores.chunks.stats()).chunks },
    gaps,
  };
}

/** 把报告压成一行给人看的摘要（UI/日志直接可用）。 */
export function summarizeCoverage(r: CoverageReport): string {
  const reasons = Object.entries(r.attachments.byReason)
    .map(([k, v]) => `${k} ${v}`)
    .join(" / ");
  return (
    `页面 ${r.pages.indexed}/${r.pages.total} 有块；` +
    `附件 ${r.attachments.indexed}/${r.attachments.total} 已索引` +
    (r.attachments.extracted > r.attachments.indexed
      ? `（其中 ${r.attachments.extracted} 份抽到了文本但未切块）`
      : "") +
    (r.attachments.notIndexed > 0
      ? `（未索引 ${r.attachments.notIndexed}：${reasons || "未分类"}）`
      : "") +
    `；派生文本 ${r.derived.segments} 段 / ${r.derived.chars} 字；块 ${r.chunks.total}`
  );
}

// TODO（成本）：现在每页/每附件各查一次。若报告要跑几十万附件，应在 `store.ts` 加**批量**查询
// （一次拿到全部 att_id 的段数与块数），并把这里的 O(N) 换成一次往返。
// 现在不做：一条"用户主动点一下"的检查，O(N) 足够，而批量接口是**只在这条路径上**的复杂度。
