// KB-S3-TIMELINE —— S3「时间复盘页」的**数据层**（判据先行那份契约的实现 ✓）。
//
// 判据：`scripts/check-kb-s3-timeline.mjs`（R105=A 采用的 S3 三条 ✓）。本文件**带标记** ⇒ 三条都落在它身上：
//   ① **只读派生**：只读 `PageMeta` 的时间戳，不碰内容列、也没有任何落库路径 ✓
//      （"直接摸内容列"那条全量面另由 `check-doc-content-access` 守 ✓）；
//   ② **两种空态分得开**：「这个空间还没有页面」与「有页面、但这些天没有活动」对用户是两件事 ✓
//      （与 `check-locked-loud` 同族：把两种"空"折成一句，用户就分不清是该建页面还是该翻旧账 ✓）；
//   ③ **时间口径只有一处**：`TIMELINE_DAY_BUCKET` 是**唯一**的"哪一天"口径（`export` ⇒ 组件共用它 ✓）。
import type { PageMeta } from "../types";

/** 空态标识（**恰好两个互异** ✓ —— 判据靠"恰好两个不同的字符串"钉住"折成一个"这种坏法 ✓）。 */
export const TIMELINE_STATES = ["no_pages", "no_recent_activity"] as const;
export type TimelineState = (typeof TIMELINE_STATES)[number];

/** 默认回看窗口（天）。只在这里定义一次 ✓。 */
export const TIMELINE_WINDOW_DAYS = 30;

/**
 * **唯一**的"哪一天"口径 ✓ —— **本地时区**（用户看到的日期必须与他的日历一致 ✓；
 * 按 UTC 分桶会让「昨晚 23:30 改的」跳到第二天 ✗）。返回 `YYYY-MM-DD`。
 * ⚠️ 要按天分组就**调它** ✓，别处不许自己再算一遍 ✗（判据会拒那种写法 ✓）。
 */
export const TIMELINE_DAY_BUCKET = (atMs: number): string => {
  const d = new Date(atMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/** 一条活动的时间：优先 `updated_at`（改过就算那天 ✓），没有就退回 `created_at` ✓。 */
const activityOf = (p: PageMeta): number => Number(p.updated_at || p.created_at || 0);

/** 一条活动的**种类** ✓（S3 第二片）：这一笔就是它被建出来的那一刻 ⇒ 新建；建得更早、当天才被改 ⇒ 改过 ✓。 */
export type TimelineKind = "created" | "edited";
const kindOf = (p: PageMeta): TimelineKind => {
  const born = Number(p.created_at || 0);
  const at = activityOf(p);
  // ⚠️ 判据只有这一条：**活动时间晚于诞生时间**才算"改过" ✓ —— 别拿"created_at 在不在窗口内"当种类
  //   （那会把"三天前建、今天改"的页面在今天标成"新建" ✗ —— 用户会以为今天新建了一篇 ✓）。
  return born > 0 && at > born ? "edited" : "created";
};

/** 窗口起点（含）✓ —— 只在这一个地方算 ✓（别处要"多久算最近"就用它 ✓）。 */
const windowStart = (nowMs: number, windowDays: number) =>
  nowMs - windowDays * 24 * 60 * 60 * 1000;

export interface TimelineEntry {
  id: string;
  title: string;
  atMs: number;
  /** 这一笔是「新建」还是「改过」✓（给界面上的小标签用 ✓） */
  kind: TimelineKind;
}

export interface TimelineDay {
  day: string;
  entries: TimelineEntry[];
  /** 当天一览（给人看的**汇总** ✓）：新建几篇、改过几篇 ✓ */
  created: number;
  edited: number;
}

/**
 * 两种空态 ✓：没有页面 ⇒ `no_pages`；有页面但窗口内一条活动都没有 ⇒ `no_recent_activity`。
 * 窗口内有活动 ⇒ `null`（调用方去画时间轴 ✓）。
 */
export function timelineStateOf(
  pages: PageMeta[],
  nowMs: number,
  windowDays: number = TIMELINE_WINDOW_DAYS,
): TimelineState | null {
  const live = pages.filter((p) => !p.deleted_at);
  if (live.length === 0) return "no_pages";
  const from = windowStart(nowMs, windowDays);
  return live.some((p) => activityOf(p) >= from) ? null : "no_recent_activity";
}

/** 按天分组（**新的一天在前** ✓；同一天内**新的一条在前** ✓）。窗口外的活动不进来 ✓。 */
export function buildTimeline(
  pages: PageMeta[],
  nowMs: number,
  windowDays: number = TIMELINE_WINDOW_DAYS,
): TimelineDay[] {
  const from = windowStart(nowMs, windowDays);
  const byDay = new Map<string, TimelineEntry[]>();
  for (const p of pages) {
    if (p.deleted_at) continue;
    const atMs = activityOf(p);
    if (atMs < from) continue;
    const day = TIMELINE_DAY_BUCKET(atMs);
    const entry: TimelineEntry = { id: p.id, title: p.title || "未命名", atMs, kind: kindOf(p) };
    const list = byDay.get(day);
    if (list) list.push(entry);
    else byDay.set(day, [entry]);
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, entries]) => {
      const sorted = [...entries].sort((a, b) => b.atMs - a.atMs);
      return {
        day,
        entries: sorted,
        created: sorted.filter((e) => e.kind === "created").length,
        edited: sorted.filter((e) => e.kind === "edited").length,
      };
    });
}

/** 一天给人看的形状 ✓ —— **只比较** `TIMELINE_DAY_BUCKET` 给出的 day 串，不另算日界 ✓。 */
export type DayLabel =
  | { kind: "today" }
  | { kind: "yesterday" }
  | { kind: "date"; month: number; day: number };

export function dayLabelOf(day: string, nowMs: number): DayLabel {
  if (day === TIMELINE_DAY_BUCKET(nowMs)) return { kind: "today" };
  const prev = new Date(nowMs);
  prev.setDate(prev.getDate() - 1);
  if (day === TIMELINE_DAY_BUCKET(prev.getTime())) return { kind: "yesterday" };
  const parts = day.split("-");
  return { kind: "date", month: Number(parts[1] || 0), day: Number(parts[2] || 0) };
}
