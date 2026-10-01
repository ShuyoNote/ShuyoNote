// KB-S3-TIMELINE —— S3 第三片：**块级活动明细**（Web 侧那一半 ✓；只读 ✓）。
//
// 与桌面 `src-tauri/src/activity.rs` **逐条对应** ✓（改一边必须同时看另一边 —— 与 `blockRev.ts` /
// `block_rev.rs` 那一对同一个规矩 ✓）：同一组线上字符串（`added`／`edited`／`removed` ✓）、
// 同一份"变没变"的判定 —— 复用 `docContent.blockSnapshotsOf`（顶层块 ＋ 去 `blockRev` ＋ 键排序 ✓）
// 与 `blockRev.canonicalContent` ✓，**不另造一套** ✗。
//
// 为什么 Web 要自己有一份（而不是"绕后端"）：Web 平台没有 Rust，`changes` 表就在它自己的 sql.js 里 ✓；
// 硬绕后端只会把同一段逻辑抄第二遍 ✗（`check-web-commands` 的 DESKTOP_ONLY 那张表讲的是同一件事 ✓）。
import type { ActivityBlockChange, ActivityEvent } from "../types";

import { blockSnapshotsOf, docJsonOfPayload } from "./docContent";

/** 载荷里的标题 ✓（解析不了就给空串 —— 明细照样给，不因标题读不到就整条丢掉 ✓）。 */
export function titleOfPayload(payload: string): string {
  try {
    const v = JSON.parse(payload) as Record<string, unknown>;
    return typeof v.title === "string" ? v.title : "";
  } catch {
    return "";
  }
}

/**
 * 相邻两版文档 JSON ⇒ 块级差异 ✓。
 *
 * 顺序与桌面**逐字相同** ✓：先按**新版**顺序给 `added`/`edited`，再按**旧版**顺序补 `removed` ✓。
 * ⚠️ 只有 `blockRev` 变了而内容逐字相同的 ⇒ **不算**一次改动 ✓（rev 是管道值，不是内容 ✓）。
 */
export function changedBlocks(prevJson: string | undefined, nextJson: string): ActivityBlockChange[] {
  const next = blockSnapshotsOf(nextJson);
  if (!next) return []; // 新版判不了 ⇒ 不报 ✓（宁可少报，不假报 ✓）
  const prev = (prevJson === undefined ? undefined : blockSnapshotsOf(prevJson)) ?? [];
  const prevById = new Map(prev.map((b) => [b.blockId, b]));
  const nextIds = new Set(next.map((b) => b.blockId));
  const out: ActivityBlockChange[] = [];
  for (const b of next) {
    const old = prevById.get(b.blockId);
    if (!old) out.push({ blockId: b.blockId, kind: "added" });
    else if (old.json !== b.json) out.push({ blockId: b.blockId, kind: "edited" });
  }
  for (const b of prev) {
    if (!nextIds.has(b.blockId)) out.push({ blockId: b.blockId, kind: "removed" });
  }
  return out;
}

/** 相邻两条**载荷** ⇒ 块级差异 ✓（把"载荷 ⇒ 正文 JSON"这一步也包进来 ✓ —— 解析走 `docContent` 那一层 ✓）。 */
export function changedBlocksBetweenPayloads(
  prevPayload: string | undefined,
  nextPayload: string,
): ActivityBlockChange[] {
  const next = docJsonOfPayload(nextPayload);
  if (next === undefined) return [];
  return changedBlocks(prevPayload === undefined ? undefined : docJsonOfPayload(prevPayload), next);
}

/** `changes` 表里我们真正读的那几列 ✓（桌面与 Web **列名不同**：序列列叫 `seq` ／ `id` ✓ —— 调用方各按自己的表写 SELECT ✓）。 */
export interface ChangeRow {
  entity_id: string;
  op: string;
  payload: string | null;
  updated_at: number;
}

/** 把 `changes` 的页面行按读取顺序折成活动明细 ✓（与桌面 `activity_feed` 同一形状 ✓）。 */
export function activityFeedOf(rows: readonly ChangeRow[]): ActivityEvent[] {
  const prev = new Map<string, string>();
  const out: ActivityEvent[] = [];
  for (const r of rows) {
    const payload = r.payload ?? "";
    const isUpsert = r.op === "upsert" && payload.length > 0;
    const changes = isUpsert ? changedBlocksBetweenPayloads(prev.get(r.entity_id), payload) : [];
    if (isUpsert) prev.set(r.entity_id, payload);
    out.push({
      pageId: r.entity_id,
      title: titleOfPayload(payload),
      atMs: r.updated_at,
      op: r.op,
      changes,
    });
  }
  return out;
}
