// P1「全部空间立即同步」的**纯逻辑**：挑目标空间 ＋ 串行一轮的进度/汇总/失败重试目标。
//
// ## 为什么单独一个文件（而不是全塞进 `SyncPanel.tsx`）
// 面板已经 2300+ 行，而这一档真正需要被机器钉住的只有三件**纯**的事：
//   ① **挑哪些空间**（个人空间；团队空间不走局域网这一档）；
//   ② **进度/汇总怎么说人话**（x/y、当前空间名、成功/失败/收下页数、被停止时怎么说）；
//   ③ **失败项重试**（只重跑失败的那几个，⛔ 不重跑已成功的）。
// 串行循环本身留在组件里（它要碰 `api.meshSyncNow` 与既有状态），但这三件都在这里，
// 判据不用打桩网络也能逐条钉死。
//
// ## ⛔ 三条纪律
// 1. **不新增第二条同步路**：目标全部走**既有**的 `api.meshSyncNow(ws_id)`（与单空间「立即同步」
//    同一个命令、同一份结果形状）；本文件不 import api、不联网。
// 2. **串行**（并发 ≤ 1）：进度/结果都是**一条一条**记的（`done`/`current`/`results`），
//    组件也只在上一台返回后才开下一台 —— 避免多窗口/多空间抢锁（任务第 2 条）。
// 3. **读不到 ≠ 团队空间**：空间分类来自 `spaceSecurityOverview`（桌面），读不到时
//    **按现有空间列表全算**（任务给的兜底口径）—— ⛔ 不因为分类缺失就静默少同步几个空间 ✗。
//
// 判据：`src/lib/meshAllSpaces.test.ts`。
import type { WorkspaceMeta } from "../types";
import { meshProgressText, meshRoundSummaryText } from "./meshRoundSummary";

/** 一个要跑的空间（只带界面要点名的两格）。 */
export interface AllSyncTarget {
  wsId: string;
  /** 界面上叫它什么（空 ⇒ 回落「这个空间」，⛔ 不显示内部 id ✗）。 */
  name: string;
}

/** 一个空间跑完的结果（成功/失败都记；`applied` 用 Rust 的 `rep.applied`，⛔ 不自己遍历 peers ✗）。 */
export interface AllSyncResult {
  target: AllSyncTarget;
  ok: boolean;
  /** 收下页数（失败 ⇒ 0）。 */
  applied: number;
  /** 成功时 Rust 的 `rep.note` 原文；失败时空串。 */
  note: string;
  /** 失败原因（成功 ⇒ null）。 */
  error: string | null;
}

/** 一轮「全部空间」的现场（组件持有；本文件只读它算字）。 */
export interface AllSyncRun {
  targets: AllSyncTarget[];
  /** 已经处理完的条数（0..targets.length）。 */
  done: number;
  /** 正在跑的那一条；不在跑 ⇒ null。 */
  current: AllSyncTarget | null;
  /** 与 `targets` 同序的结果（没跑到的没有条目）。 */
  results: AllSyncResult[];
  /** 用户在跑的过程中按了「停止」：**正在跑的那一条会跑完**，之后不再开下一条。 */
  stopped: boolean;
  /** 开始时刻（ms；只用于进度里的「已 Ns」）。 */
  startedAt: number;
  /** 开始那一刻的附近设备数（`lanStatus.nearby.length`；进度里照原口径显示）。 */
  nearbyCount: number;
  /** 这轮是否还在跑（组件用它开关按钮/禁用单空间同步）。 */
  running: boolean;
}

/**
 * 挑出「全部空间立即同步」要跑的空间。
 *
 * 口径（按现有数据源，⛔ 不新增命令）：
 * * 分类来自 `spaceSecurityOverview()`（桌面；`space_id` 实为 workspace id —— 与 `SyncPanel`
 *   那次 `kindByWs` 的读法**同一处口径**），读不到分类 ⇒ 该空间照收（任务给的兜底）；
 * * **明确是 `team` 的跳过**（团队空间走服务器那条路，局域网这一档不是它的路径）；
 * * 其余（`personal` / 未分类 / 分类读不到）都算目标 —— 与 Rust 侧「存量空串按个人处理」同口径；
 * * 去重（同一 wsId 只跑一次）、保持传入顺序（`list_workspaces` 已按 `sort_order`）；
 * * 空间名空 ⇒ 「这个空间」（⛔ 不回落成内部 id）。
 */
export function pickAllSyncSpaces(
  spaces: ReadonlyArray<Pick<WorkspaceMeta, "id" | "name" | "kind">> | null | undefined,
  kindByWs?: ReadonlyMap<string, string> | null,
): AllSyncTarget[] {
  if (!Array.isArray(spaces)) return [];
  const seen = new Set<string>();
  const out: AllSyncTarget[] = [];
  for (const s of spaces) {
    const wsId = (s?.id ?? "").trim();
    if (!wsId || seen.has(wsId)) continue;
    const kind = kindByWs?.get(wsId) ?? (s?.kind ?? "");
    if (kind === "team") continue;
    seen.add(wsId);
    out.push({ wsId, name: (s?.name ?? "").trim() || "这个空间" });
  }
  return out;
}

/** 进度那句话（复用 `meshProgressText`，只在它前面加 `x/y` 的总量）。 */
export function allSyncProgressText(run: AllSyncRun, now: number): string {
  const total = run.targets.length;
  if (total === 0) return "没有可同步的个人空间";
  if (run.current) {
    const no = Math.min(total, run.done + 1);
    const elapsed = Math.max(0, now - run.startedAt);
    return `全部空间 ${no}/${total} · ${meshProgressText(run.current.name, run.nearbyCount, elapsed)}`;
  }
  if (run.stopped) return `全部空间 ${Math.min(run.done, total)}/${total} · 已停止`;
  if (run.done >= total) return `全部空间 ${total}/${total} · 正在收尾…`;
  return `全部空间 ${run.done}/${total} · 准备下一个空间…`;
}

/** 汇总的机器可读部分（组件按它决定给不给「重试失败项」）。 */
export interface AllSyncSummary {
  okCount: number;
  failedCount: number;
  applied: number;
  /** 只含失败项的目标（顺序同 `targets`）—— 重试就再拿它跑一轮。 */
  failures: AllSyncTarget[];
  /** 一句人话（直接进状态行/底部 foot）。 */
  text: string;
}

/** 一轮结束后的汇总（成功几台 / 失败几台 / 共收下几页；被停止时如实说处理到哪）。 */
export function allSyncSummary(run: AllSyncRun): AllSyncSummary {
  const total = run.targets.length;
  const okCount = run.results.filter((r) => r.ok).length;
  const failures = run.results.filter((r) => !r.ok).map((r) => r.target);
  const failedCount = failures.length;
  const applied = run.results.reduce((n, r) => n + (Number.isFinite(r.applied) ? r.applied : 0), 0);
  let text: string;
  if (total === 0) {
    text = "没有可同步的个人空间";
  } else if (run.stopped && run.done < total) {
    text =
      `已停止：处理了 ${run.done}/${total} 个空间（成功 ${okCount}、失败 ${failedCount}）` +
      meshRoundSummaryText(applied) +
      (failedCount > 0 ? "；失败项可以重试" : "");
  } else if (failedCount === 0) {
    text = `全部空间同步完成：${total}/${total} 个空间成功` + meshRoundSummaryText(applied);
  } else {
    text =
      `全部空间同步完成：${okCount}/${total} 个空间成功，${failedCount} 个失败` +
      meshRoundSummaryText(applied) +
      "；失败项可以重试";
  }
  return { okCount, failedCount, applied, failures, text };
}

/** 只取失败项（供「重试失败项」再跑一轮；⛔ 不重跑已经成功的那几个 ✗）。 */
export function allSyncFailures(run: AllSyncRun): AllSyncTarget[] {
  return allSyncSummary(run).failures;
}
