// ⭐ P3-3a 第三小步（task-56）：CRDT **影子体检**的人话文案（纯函数，判据够得着）。
//
// 输入是 `shadowScanSpace` 的**脱敏汇总**（只含计数与差异页 id 列表）；本文件**只生成文案**：
// · ⛔ 不读库、不扫页、不修复、不改数据；
// · ⛔ 不显示正文、⛔ **界面/复制摘要也不逐个列 page id**（内部标识不进界面）—— 只回数量。
import type { ShadowRowsResult } from "./crdtShadow";

export type ShadowDiagnoseTone = "muted" | "ok" | "warn" | "error";

/** 一句话结论（给卡片标题）。口径：空空间 / 全等 / 有差异 / 不可比 / 混合。 */
export function diagnoseHeadline(s: ShadowRowsResult): string {
  if (s.total === 0) return "这个空间还没有页（没有可比的）";
  if (s.differ > 0) {
    return `发现 ${s.differ} 页的 CRDT 投影与落盘正文不一致（共 ${s.total} 页）`;
  }
  if (s.equal > 0 && s.uncomparable === 0) {
    return `全部一致（${s.equal} 页都有 CRDT 状态，且投影与落盘正文相同）`;
  }
  if (s.equal === 0 && s.uncomparable > 0) {
    return `${s.uncomparable} 页无法比较（没有 CRDT 状态／落盘正文读不出）`;
  }
  return `部分可比：${s.equal} 页一致、${s.uncomparable} 页无法比较（共 ${s.total} 页）`;
}

/** 逐行明细（卡片正文；⛔ 只有计数，不含正文/路径/内部 id）。 */
export function diagnoseDetailLines(s: ShadowRowsResult): string[] {
  return [
    `总页数：${s.total}`,
    `有 CRDT 状态：${s.withState}`,
    `一致：${s.equal}`,
    `不一致：${s.differ}`,
    `不可比：${s.uncomparable}`,
  ];
}

/** 一句话提醒（卡片脚注）：明确"只读、不自动修复"。 */
export function diagnoseFootnote(s: ShadowRowsResult): string {
  if (s.differ > 0) {
    return "只是读数：本体检⛔ 不自动修复、⛔ 不改任何数据。需要处理时请按这条线索人工排查。";
  }
  if (s.uncomparable > 0 && s.equal === 0) {
    return "这些页多半还没建立 CRDT 状态（或落盘正文暂时读不出）；打开一次页面通常会让状态补上。";
  }
  return "只读体检：不显示正文、不自动修复、不改任何数据。";
}

/** 卡片色调（界面按它选 class；纯函数便于判据）。 */
export function diagnoseTone(s: ShadowRowsResult): ShadowDiagnoseTone {
  if (s.total === 0) return "muted";
  if (s.differ > 0) return "warn";
  if (s.uncomparable > 0) return "warn";
  return "ok";
}

/** 复制摘要（脱敏：只有计数＋结论；⛔ 不含 page id/正文）。 */
export function diagnoseCopyText(s: ShadowRowsResult): string {
  return [
    "[crdt-shadow] 体检结果（只读）",
    diagnoseHeadline(s),
    ...diagnoseDetailLines(s),
    diagnoseFootnote(s),
  ].join("\n");
}

/** 体检失败的人话（只用于行内错误/toast；不影响同步）。 */
export function diagnoseErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `体检没跑成：${message}（不影响同步，也没有改任何数据）`;
}
