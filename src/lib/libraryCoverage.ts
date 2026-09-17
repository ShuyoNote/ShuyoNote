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
