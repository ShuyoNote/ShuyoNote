// ⭐ P3-3a 第四小步（task-67）：**影子观测近 7 天历史**的纯函数（不碰 localStorage）。
//
// 口径（唯一实现）：
// · 一天一条 `{date: YYYY-MM-DD, total, withState, equal, differ, uncomparable}`（**本地日期**）；
// · 同一天再扫 ⇒ **覆盖当天**（只留最新一次，不累加）；按日期升序；**只留最近 7 天**；
// · 坏记录（缺字段/日期非法/计数非法）**丢弃并给原因**（⛔ 不猜、⛔ 不把坏记录算进摘要）；
// · 无差异/有差异都记（"没差异"本身是观测结果）。
import type { ShadowRowsResult } from "./crdtShadow";

/** localStorage 键（唯一出处；hook 读写、面板读）。 */
export const SHADOW_HISTORY_KEY = "shuyonote:crdt-shadow-history";
/** 只留最近 N 天。 */
export const SHADOW_HISTORY_DAYS = 7;

/**
 * ⭐ **2026-11-19（owner 拍）**：**这一天之前**的影子记录**一律作废、不计入摘要**。
 *
 * 来由：`equal=0` 的根因（落盘 block 带 `blockRev`、CRDT 投影不带）在 **2026-11-14** 才修（修法 A），
 * 那之前的"有差异"是**口径偏差**造出来的，不是真实差异（见
 * `docs/plans/2026-11-14-a1-shadow-equal-zero-rootcause.md`）。
 * ⇒ 面板上原先显示「最近 7 天 / 有差异 5 天」——那 5 天全是作废数据，会让人误以为现在还在差。
 * ⚠️ **只过滤"计入"**：记录本身**不删**（`localStorage` 里原样留着，方便回看"为什么作废"）。
 * ⚠️ 边界取值：`date >= "2026-11-14"` 才算有效（那一天是修法 A 落地当天，当天首扫 `equal 5 / differ 0`）。
 */
export const SHADOW_VALID_FROM_DATE = "2026-11-14";

/**
 * ⭐ **2026-11-22（owner 拍 B 后补的机器判据）**：**从这一天起**，一天的记录必须带
 * `differPending` 与 `differUnexplained` 两列；缺失 ⇒ 判「记录格式旧、不可归类」，
 * **不计入有效日**（⛔ 不补造、不按 0 处理）。
 *
 * 为什么是 11-22：11-20/11-21 那两天的记录**确实丢过这两列** —— 根因是 `parseShadowHistory`
 * 只回读了 6 个计数字段、把可选分类字段丢了，随后 `recordShadowDay` 再把整份历史写回时
 * 这两列就永久消失（本文件同日修掉：解析时保留它们）。11-22 起写入/回读都带分类字段，
 * 所以拿它当"必须带分类"的起点；更早的日子按 owner 已接受的书面解释（U4-B T-B 测试页）处理，
 * 不在这里追溯判无效。
 */
export const SHADOW_CLASSIFY_FROM_DATE = "2026-11-22";

/** 一条记录的分类字段是否齐全（两者都必须是合法计数）。 */
export function isClassificationComplete(r: ShadowDayRecord): boolean {
  return (
    typeof r.differPending === "number" &&
    typeof r.differUnexplained === "number" &&
    Number.isFinite(r.differPending) &&
    Number.isFinite(r.differUnexplained)
  );
}


export interface ShadowDayRecord {
  date: string;
  total: number;
  withState: number;
  equal: number;
  differ: number;
  uncomparable: number;
  /** ⭐ 2026-11-11（P0-1b）：差异里“有远端状态待合并”的页数（已知噪声）。旧记录缺省 = 0。 */
  differPending?: number;
  /** ⭐ 差异里“没有待合并、却投影≠CRDT”的页数（待查）。旧记录缺省 = 0。 */
  differUnexplained?: number;
}

export interface ShadowHistoryParseResult {
  records: ShadowDayRecord[];
  /** 被丢弃的坏记录条数。 */
  dropped: number;
  /** 丢弃原因（人话；判据/日志用，最多每条一句）。 */
  reasons: string[];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 本地日期键（YYYY-MM-DD；⛔ 不用 UTC —— "同一天"按用户本地日历算）。 */
export function shadowDateKey(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function isDateKey(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map((x) => Number(x));
  const dt = new Date(y, m - 1, d);
  return (
    dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
  );
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

/** 校验/规范化一条记录；坏 ⇒ 返回原因字符串，好 ⇒ 返回 `null`。 */
export function validateShadowDayRecord(v: unknown): string | null {
  if (!v || typeof v !== "object") return "记录不是对象";
  const r = v as Record<string, unknown>;
  if (!isDateKey(r.date)) return "日期非法（要 YYYY-MM-DD 且真实存在）";
  for (const k of ["total", "withState", "equal", "differ", "uncomparable"] as const) {
    if (!isCount(r[k])) return `计数非法：${k}`;
  }
  if ((r.withState as number) > (r.total as number)) return "withState 超过 total";
  if ((r.differ as number) > (r.total as number)) return "differ 超过 total";
  // ⭐ 2026-11-11（P0-1b）：差异分类字段可选（旧记录没有）；有就必须是合法计数。
  for (const k of ["differPending", "differUnexplained"] as const) {
    if (r[k] !== undefined && !isCount(r[k])) return `计数非法：${k}`;
  }
  const splitSum =
    (typeof r.differPending === "number" ? r.differPending : 0) +
    (typeof r.differUnexplained === "number" ? r.differUnexplained : 0);
  if (splitSum > (r.differ as number)) {
    return "差异分类之和超过 differ";
  }
  return null;
}

/** 把一条 summary 变成当天记录（只存计数；⛔ 不存 differPageIds/正文）。 */
export function dayRecordFromSummary(summary: ShadowRowsResult, now: Date): ShadowDayRecord {
  return {
    date: shadowDateKey(now),
    total: summary.total,
    withState: summary.withState,
    equal: summary.equal,
    differ: summary.differ,
    uncomparable: summary.uncomparable,
    // ⭐ 2026-11-11（P0-1b）：差异分类（旧调用方不给这两个字段 ⇒ 写 0，形状保持兼容）。
    differPending: summary.differPending ?? 0,
    differUnexplained: summary.differUnexplained ?? 0,
  };
}

/** 解析存储内容（`null`/坏 JSON ⇒ 空数组＋原因）；逐条校验、丢弃坏记录。 */
export function parseShadowHistory(raw: string | null | undefined): ShadowHistoryParseResult {
  if (raw == null || raw.trim() === "") return { records: [], dropped: 0, reasons: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { records: [], dropped: 0, reasons: ["历史不是合法 JSON"] };
  }
  if (!Array.isArray(parsed)) {
    return { records: [], dropped: 0, reasons: ["历史不是数组"] };
  }
  const records: ShadowDayRecord[] = [];
  const reasons: string[] = [];
  for (const item of parsed) {
    const reason = validateShadowDayRecord(item);
    if (reason) {
      reasons.push(reason);
      continue;
    }
    const r = item as ShadowDayRecord;
    records.push({
      date: r.date,
      total: r.total,
      withState: r.withState,
      equal: r.equal,
      differ: r.differ,
      uncomparable: r.uncomparable,
      // ⭐ 2026-11-22 修：**保留**可选分类字段。原先这里只回读 6 个计数 ⇒ 历史被写回时
      //   两列永久丢失（11-20/21 的"未分类"就是这么来的）。缺字段仍保持 undefined。
      ...(typeof r.differPending === "number" ? { differPending: r.differPending } : {}),
      ...(typeof r.differUnexplained === "number" ? { differUnexplained: r.differUnexplained } : {}),
    });
  }
  return { records, dropped: reasons.length, reasons };
}

/** 记录一天：同日覆盖、升序、只留最近 7 天（输入应已 sanitize；这里再兜一层）。 */
export function recordShadowDay(
  prev: ShadowDayRecord[],
  summary: ShadowRowsResult,
  now: Date,
): ShadowDayRecord[] {
  const clean = prev.filter((r) => validateShadowDayRecord(r) === null);
  const rec = dayRecordFromSummary(summary, now);
  const byDate = new Map<string, ShadowDayRecord>();
  for (const r of clean) byDate.set(r.date, r);
  byDate.set(rec.date, rec); // 同一天 ⇒ 覆盖成最新
  return [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-SHADOW_HISTORY_DAYS);
}

export type ShadowHistoryTone = "muted" | "ok" | "warn";

export interface ShadowHistorySummary {
  /** 有效天数（0 ⇒ 无记录/读不出/全是作废）。 */
  days: number;
  /** 历史读不出来（null/坏 JSON/非数组）⇒ unknown（⛔ 不假装"无记录"）。 */
  unknown: boolean;
  lastDate: string | null;
  last: ShadowDayRecord | null;
  /** 近 7 天里有差异的天数（**只数有效日**）。 */
  differDays: number;
  lastDifferDate: string | null;
  /** ⭐ **2026-11-19**：`SHADOW_VALID_FROM_DATE` 之前的记录天数（**作废、不计入**；记录本身不删）。 */
  voidedDays: number;
  /** ⭐ 2026-11-22：记录格式旧（缺分类列、不可归类）而被剔除的天数（⛔ 不补造、不按 0 算）。 */
  schemaOutdatedDays: number;
  schemaOutdatedDates: string[];
  text: string;
  tone: ShadowHistoryTone;
}

/** 摘要（面板只读行/复制摘要共用）。`records=null/undefined` ⇒ unknown 文案。 */
export function summarizeShadowHistory(
  records: ShadowDayRecord[] | null | undefined,
): ShadowHistorySummary {
  if (records == null) {
    return {
      days: 0,
      unknown: true,
      lastDate: null,
      last: null,
      differDays: 0,
      lastDifferDate: null,
      voidedDays: 0,
      schemaOutdatedDays: 0,
      schemaOutdatedDates: [],
      text: "未知（历史读不出来或格式坏了）",
      tone: "muted",
    };
  }
  const clean = records
    .filter((r) => validateShadowDayRecord(r) === null)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-SHADOW_HISTORY_DAYS);
  // ⭐ 2026-11-19（owner 拍）：口径修好（2026-11-14）之前的记录**作废** —— 只从"计入"里去掉，记录不删。
  const validFrom = clean.filter((r) => r.date >= SHADOW_VALID_FROM_DATE);
  const voidedDays = clean.length - validFrom.length;
  // ⭐ 2026-11-22（owner 拍 B 后）：从 SHADOW_CLASSIFY_FROM_DATE 起，缺分类列的记录**不可归类** ⇒ 不计入。
  const outdated = validFrom.filter(
    (r) => r.date >= SHADOW_CLASSIFY_FROM_DATE && !isClassificationComplete(r),
  );
  const valid = validFrom.filter((r) => !outdated.includes(r));
  const schemaOutdatedDays = outdated.length;
  const schemaOutdatedDates = outdated.map((r) => r.date);
  if (valid.length === 0) {
    return {
      days: 0,
      unknown: false,
      lastDate: null,
      last: null,
      differDays: 0,
      lastDifferDate: null,
      voidedDays,
      schemaOutdatedDays,
      schemaOutdatedDates,
      text:
        voidedDays > 0 || schemaOutdatedDays > 0
          ? `无有效记录（另有 ${voidedDays} 天作废${schemaOutdatedDays > 0 ? `、${schemaOutdatedDays} 天记录格式旧` : ""}，不计入）`
          : "无记录（还没跑过影子扫描）",
      tone: "muted",
    };
  }
  const last = valid[valid.length - 1];
  const differ = valid.filter((r) => r.differ > 0);
  const lastDifferDate = differ.length ? differ[differ.length - 1].date : null;
  const notes = [
    voidedDays > 0 ? `${voidedDays} 天作废` : "",
    schemaOutdatedDays > 0 ? `${schemaOutdatedDays} 天记录格式旧` : "",
  ].filter(Boolean);
  const voidedNote = notes.length ? `（另有 ${notes.join("、")}·不计入）` : "";
  const text =
    differ.length === 0
      ? `最近 ${valid.length} 天无差异 / 最近 ${last.date}${voidedNote}`
      : `最近 ${valid.length} 天 / 有差异 ${differ.length} 天 / 最近 ${last.date} / 最近差异 ${lastDifferDate}${voidedNote}`;
  return {
    days: valid.length,
    unknown: false,
    lastDate: last.date,
    last,
    differDays: differ.length,
    lastDifferDate,
    voidedDays,
    schemaOutdatedDays,
    schemaOutdatedDates,
    text,
    tone: differ.length > 0 ? "warn" : "ok",
  };
}

/** 复制摘要（脱敏：只有日期/计数；⛔ 不含 differPageIds/正文）。 */
export function shadowHistoryCopyText(summary: ShadowHistorySummary): string {
  return [
    "[crdt-shadow] 影子观测（只读）",
    summary.text,
    ...(summary.last
      ? [
          `最近一次：${summary.last.date} 总 ${summary.last.total} / 有状态 ${summary.last.withState} / 一致 ${summary.last.equal} / 差异 ${summary.last.differ} / 不可比 ${summary.last.uncomparable}`,
        ]
      : []),
    // ⭐ 2026-11-22：记录格式旧的日子单列，别让人以为"没差异"或"有差异"。
    ...(summary.schemaOutdatedDays > 0
      ? [
          `记录格式旧·不计入：${summary.schemaOutdatedDates.join(" / ")}（缺分类列；⛔ 不补造）`,
        ]
      : []),
  ].join("\n");
}
