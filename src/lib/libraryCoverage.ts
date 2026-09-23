// 「检查索引覆盖」的应用侧入口：把 `api` 的清单喂给纯函数 `indexCoverage`。
//
// 分工：`extract/coverageReport.ts` 只做**纯计算**（不碰平台、不碰 api）；
// 本文件只做**取材**（列页面、列附件）。这样报告逻辑可以在没有平台的情况下测，
// 而取材逻辑只有一处需要跟着命令面变化。
//
// ## ⚠️ 一个必须核实的语义（差点写错）
// `api.listPageAttachments(pageId)` 的参数是 `string | null`。**`null` 不是"全部附件"** ——
// Rust 侧 `list_page_attachments` 的 SQL 明写着分支依据：`page_id = NULL` 永远不成立，
// 所以 `None` 走的是 **`IS NULL`** 那条路，即「**空间根下的未整理文件**」。
// ⇒ 想拿"全库附件"，必须 **逐页列举 + 再取一次未整理的**；
//    只调 `listPageAttachments(null)` 会**漏掉所有归属页面的附件**（那才是大多数）。
//
// ## 成本
// O(页面数) 次命令调用（+1）。对"用户主动点一下检查覆盖"足够；
// 若将来要跑几万页，应该让命令面提供一个"列全部附件"的命令，而不是在这里并发打。

import { api } from "./api";
import {
  indexCoverage,
  summarizeCoverage,
  type CoverageReport,
  type CoverageStores,
} from "./extract/coverageReport";

/**
 * 扫一遍全库，算出现在"有多少内容真的进了检索面"。
 *
 * **只读**：不触发抽取、不写库。它回答"现在覆盖到哪"，不负责"去补齐"。
 */
export async function scanLibraryCoverage(stores: CoverageStores): Promise<CoverageReport> {
  const pages = await api.listPages();
  const pageIds = pages.map((p) => p.id);

  // 按 id 去重：同一个附件不会被两页同时引用，但"未整理"那一批与逐页结果可能有交集，
  // 与其相信"不会重复"，不如去重 —— 否则报告里的 total 会虚高。
  const attachments = new Map<string, { id: string; mime: string; filename: string }>();
  const collect = (list: { id: string; mime: string; name: string }[]) => {
    for (const a of list) {
      if (!attachments.has(a.id)) {
        attachments.set(a.id, { id: a.id, mime: a.mime, filename: a.name });
      }
    }
  };

  for (const pageId of pageIds) {
    collect(await api.listPageAttachments(pageId));
  }
  // 未整理的（page_id IS NULL）—— 见文件头注释，这一批**不在**任何页面的结果里
  collect(await api.listPageAttachments(null));

  return indexCoverage({ pageIds, attachments: [...attachments.values()] }, stores);
}

/** 缺口明细最多给 AI 列几条（多了会把上下文吃掉，而且人也不会看）。**截断必须说出来**。 */
export const COVERAGE_GAP_LIMIT = 20;

/**
 * 把报告压成**能力面（AI 工具）的返回形状** —— 一行摘要 ＋ 结构化明细。
 *
 * 为什么单独一个纯函数：能力面的形状是"给模型读的"，与"给人看的 UI 形状"不完全一样
 * （模型要**计数 + 分类 + 明细**，UI 要一句话），而这两者的取值口径必须**同一处**决定 ——
 * 各写一遍就会出现"AI 说 3 份没抽全、界面说 2 份"这种没人会发现的漂移。
 *
 * ⚠️ **两条刻意的口径**（都源自 §15.10 那条"成功 ≠ 抽全了"）：
 * 1. `attachments.partial` 与 `indexed` **并列给出**，且摘要里明写"其中 K 份没抽全" ——
 *    只给"已索引 3/3"会让模型答"内容全在检索面里"。
 * 2. **缺口列表可能被截断**（`gapsTotal`/`gapsTruncated`/`note` 三件套明说）——
 *    "少给几条"与"只有几条"必须分得开，否则模型会把截断当成全部。
 */
export function coverageReportTool(
  report: CoverageReport,
  gapLimit = COVERAGE_GAP_LIMIT,
): {
  ok: true;
  summary: string;
  report: {
    pages: CoverageReport["pages"];
    attachments: CoverageReport["attachments"];
    derived: CoverageReport["derived"];
    chunks: CoverageReport["chunks"];
    gaps: CoverageReport["gaps"];
    gapsTotal: number;
    gapsTruncated: boolean;
    note: string;
  };
} {
  const lim = Math.max(0, Math.floor(gapLimit) || 0);
  const gaps = report.gaps.slice(0, lim);
  const truncated = report.gaps.length > gaps.length;
  return {
    ok: true,
    summary: summarizeCoverage(report),
    report: {
      pages: report.pages,
      attachments: report.attachments,
      derived: report.derived,
      chunks: report.chunks,
      gaps,
      gapsTotal: report.gaps.length,
      gapsTruncated: truncated,
      note: truncated
        ? `缺口明细只列了前 ${gaps.length} 条（共 ${report.gaps.length} 条）；要全量请用界面里的「检查索引覆盖」`
        : "",
    },
  };
}
