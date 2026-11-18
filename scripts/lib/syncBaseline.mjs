// ⭐ §13.12 **Phase 0 基线**：把 `[sync-metrics]` 日志行翻成可复算的读数（p50 / p95 / 恢复时间 / 缺口）。
//
// ## 为什么要有这个文件
// 需求书 §13.12 的原话是「**先有基线，再谈「≤2s / ≤15s」**；没有基线的优化不算完成」。
// 而 `[sync-metrics]`（`src-tauri/src/mesh.rs` 里的 `metrics_line`）**每轮已经在打**这一行：
//
//   [sync-metrics] space=<空间哈希> peer=<设备号> since=9 max_seq=9 gap=0 fetched=0 applied=0 ms=37
//   末尾可能还有 ` recovered_after_ms=<n>`（这一轮之前断了多久才恢复）
//
// ⇒ 本文件只做**纯函数**：解析这些行 ＋ 算分位数/缺口/恢复时间。**⛔ 不改任何行为**：
//   不发包、不建连接、不写库、不动 Rust 侧一行；它只读已经写下来的日志。
//
// ## 三条纪律
// 1. **⛔ 不猜**：形状不对／关键字段不是整数的行 ⇒ `null`（跳过并计数），⛔ 不填 0 混进分位数。
// 2. **⛔ 不脱敏就输出**：`space` / `peer` 是内部 id（空间哈希 / 设备号）—— 报告里只出现
//    「空间 1」「对端 1」（按轮数降序编号），**原文一个字符都不打印**。
// 3. **读不到 ≠ 0**：一条都没解析到时，报告必须写「没量到（⛔ 不算基线）」，调用方按"不算通过"退。
//
// ## 这一版能量什么、量不到什么（如实写，⛔ 别让下一刀以为量过了）
// ✅ 能：单轮拉取耗时分布（`ms`）、缺口（`gap>0` 的轮数）、恢复耗时分布（`recovered_after_ms`）、
//       每台对端/每个空间的轮数与耗时（编号后）
// ⛔ 不能：**改 → 对端可见延迟**（要「保存时刻」与「对端拉完时刻」跨机对齐，日志里没有共同时钟）、
//       通知/轮询端到端时延（同上）、耗电/流量（日志里没有）、换网恢复时间（只有断连/重启类恢复）
//
// 判据：`scripts/lib/syncBaseline.test.mjs`（含 **CRLF 真行** 那一格 —— 本仓踩过
// 「`split("\n")` 在 CRLF 工作区整体静默失效」）。

/**
 * @typedef {object} MetricRow 一条读数（`space`/`peer` 只在内部用来分组，⛔ 不进报告）
 * @property {string} space   空间哈希
 * @property {string} peer    对端设备号
 * @property {number} since
 * @property {number} maxSeq
 * @property {number} gap
 * @property {number} fetched
 * @property {number} applied
 * @property {number} ms      这一轮耗时（毫秒）
 * @property {number|null} recoveredAfterMs 之前断了多久才恢复（日志里没有这一格 ⇒ null）
 */

/** 整数读数：⛔ 不把 `""` / `"abc"` / `"1.5"` 当 0。 */
function intOf(raw) {
  if (raw === undefined) return null;
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * 解析**一行**。形状不对 ⇒ `null`（调用方计数并跳过；⛔ 不许"尽力读出个大概"）。
 *
 * ⚠️ 行尾的 `\r` 必须先剥（Windows 日志 / CRLF 检出常见）—— 否则按行尾锚定的处理会整体静默失效，
 *    而合成用例（LF）会全绿。这一格由测试里的 CRLF 用例钉住。
 *
 * @param {string} line
 * @returns {MetricRow|null}
 */
export function parseMetricsLine(line) {
  const text = String(line ?? "").replace(/\r$/, "");
  const at = text.indexOf("[sync-metrics]");
  if (at < 0) return null;
  const body = text.slice(at + "[sync-metrics]".length);
  /** @type {Map<string,string>} */
  const kv = new Map();
  for (const token of body.trim().split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    kv.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const space = kv.get("space");
  const peer = kv.get("peer");
  const since = intOf(kv.get("since"));
  const maxSeq = intOf(kv.get("max_seq"));
  const gap = intOf(kv.get("gap"));
  const fetched = intOf(kv.get("fetched"));
  const applied = intOf(kv.get("applied"));
  const ms = intOf(kv.get("ms"));
  if (!space || !peer) return null;
  if (since === null || maxSeq === null || gap === null || fetched === null || applied === null) {
    return null;
  }
  if (ms === null || ms < 0) return null;
  const recovered = intOf(kv.get("recovered_after_ms"));
  return {
    space,
    peer,
    since,
    maxSeq,
    gap,
    fetched,
    applied,
    ms,
    recoveredAfterMs: recovered === null || recovered < 0 ? null : recovered,
  };
}

/** 把整段文本拆成行（**同时**认 `\n` 与 `\r\n`；⛔ 不写死 `split("\n")` 再假设没有 `\r`）。 */
export function splitMetricLines(text) {
  return String(text ?? "").split(/\r?\n/);
}

/**
 * ⭐ **§13.12 Phase 0 埋点（2026-11-18）**：解析一行 `[sync-latency] seg=<段名> ms=<差>`。
 *
 * 这两段是**本机两段时刻**（`lan_state::latency_line` 打的）：
 * · `save_to_announce`：本地保存 → 那条带 `dirty` 的公告真的发出去；
 * · `announce_to_round_done`：收到对端 `dirty` 公告 → 被唤醒的那一轮跑完。
 *
 * ⚠️ 两段**只能各自看、⛔ 不能跨机相减**：跨机的「改 → 对端可见」要共同时钟，日志里没有。
 * ⚠️ 形状不对 ⇒ `null`（⛔ 不猜）；`seg` 只收 `[A-Za-z0-9_-]+`（代码常量，不是用户内容）。
 *
 * @param {string} line
 * @returns {{seg: string, ms: number}|null}
 */
export function parseLatencyLine(line) {
  const text = String(line ?? "").replace(/\r$/, "");
  const at = text.indexOf("[sync-latency]");
  if (at < 0) return null;
  const body = text.slice(at + "[sync-latency]".length).trim();
  if (!body) return null;
  /** @type {Map<string,string>} */
  const kv = new Map();
  for (const token of body.split(/\s+/)) {
    const eq = token.indexOf("=");
    // ⚠️ 这一行只有两个字段 ⇒ **一个不带 `=` 的碎词就整行不认**：
    //    否则 `seg=a b` 会被读成 `seg=a`（静默截断 = 猜）。⛔ 不是"宽松一点更好"。
    if (eq <= 0) return null;
    kv.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const seg = kv.get("seg");
  const ms = intOf(kv.get("ms"));
  if (!seg || !/^[A-Za-z0-9_-]+$/.test(seg)) return null;
  if (ms === null || ms < 0) return null;
  return { seg, ms };
}

/**
 * 分位数（nearest-rank：取第 `ceil(p/100 × n)` 个，1 起；⛔ 不插值 —— 日志读数不该被"造"出来）。
 * @param {number[]} sortedAsc 已升序
 * @param {number} p 0..100
 * @returns {number|null}
 */
export function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const pct = Math.min(100, Math.max(0, p));
  const rank = Math.ceil((pct / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

/**
 * @typedef {object} PercStats
 * @property {number} count
 * @property {number} p50
 * @property {number} p95
 * @property {number} max
 * @property {number} over1s   `> 1000ms` 的条数（QUIC 长尾那一族判据看这一格）
 * @property {number} over100ms
 */

/** @param {number[]} values @returns {PercStats|null} */
function statsOf(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    over1s: sorted.filter((v) => v > 1000).length,
    over100ms: sorted.filter((v) => v > 100).length,
  };
}

/**
 * @typedef {object} GroupReading 一个编号分组（⛔ 只有编号与计数，没有 id）
 * @property {string} label   `空间 1` / `对端 1`（按轮数降序编号）
 * @property {number} rounds
 * @property {number} fetched
 * @property {number} applied
 * @property {number} gapped
 * @property {PercStats} lat
 */

/** @param {MetricRow[]} rows @param {(r: MetricRow) => string} keyOf @returns {GroupReading[]} */
function groupBy(rows, keyOf) {
  /** @type {Map<string, MetricRow[]>} */
  const acc = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    const list = acc.get(k);
    if (list) list.push(r);
    else acc.set(k, [r]);
  }
  return [...acc.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([, list]) => ({
      label: "",
      rounds: list.length,
      fetched: list.reduce((s, r) => s + r.fetched, 0),
      applied: list.reduce((s, r) => s + r.applied, 0),
      gapped: list.filter((r) => r.gap > 0).length,
      lat: statsOf(list.map((r) => r.ms)),
    }));
}

/**
 * @typedef {object} BaselineSummary
 * @property {number} rounds 解析成功了多少行
 * @property {number} skipped 看着像 `[sync-metrics]` 但形状不认识的行数（⛔ 不是 0 就当没看见）
 * @property {PercStats|null} latency 单轮耗时；一条都没解析到 ⇒ null（⛔ 不拿 0 冒充"很快"）
 * @property {PercStats|null} recovered
 * @property {number} recoveredRounds
 * @property {{rounds:number, gappedRounds:number, totalGap:number}} gap
 * @property {number} fetched
 * @property {number} applied
 * @property {GroupReading[]} spaces
 * @property {GroupReading[]} peers
 * @property {LatencySegment[]} segments ⭐ 埋点两段（本机；⛔ 跨机不可相减）
 */

/**
 * @typedef {object} LatencySegment
 * @property {string} seg  段名（代码常量：`save_to_announce` / `announce_to_round_done`）
 * @property {PercStats} stats
 */

/** 已知段名（报告里给它们配人话；不认识的段名照原样列出 —— ⛔ 不静默丢）。 */
export const LATENCY_SEGMENT_TEXT = {
  save_to_announce: "保存 → 公告发出",
  announce_to_round_done: "收到对端公告 → 该轮跑完",
};

/**
 * 汇总。**纯函数**（⛔ 不读文件、不读时钟）。`skipped` 由调用方传入（它才知道原文里有多少可疑行）。
 * @param {MetricRow[]} rows
 * @param {number} [skipped]
 * @returns {BaselineSummary}
 */
export function summarizeMetrics(rows, skipped = 0, latencyRows = []) {
  const recoveredValues = rows.map((r) => r.recoveredAfterMs).filter((v) => v !== null);
  const spaces = groupBy(rows, (r) => r.space).map((g, i) => ({ ...g, label: `空间 ${i + 1}` }));
  const peers = groupBy(rows, (r) => r.peer).map((g, i) => ({ ...g, label: `对端 ${i + 1}` }));
  // ⭐ 埋点两段：按段名分组（顺序：先已知的两段，再其它 —— ⛔ 不静默丢掉不认识的段名）
  /** @type {Map<string, number[]>} */
  const bySeg = new Map();
  for (const r of latencyRows) {
    const list = bySeg.get(r.seg);
    if (list) list.push(r.ms);
    else bySeg.set(r.seg, [r.ms]);
  }
  const knownOrder = Object.keys(LATENCY_SEGMENT_TEXT);
  const segments = [...bySeg.entries()]
    .sort((a, b) => {
      const ia = knownOrder.indexOf(a[0]);
      const ib = knownOrder.indexOf(b[0]);
      if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return b[1].length - a[1].length;
    })
    .map(([seg, values]) => ({ seg, stats: statsOf(values) }));
  return {
    rounds: rows.length,
    skipped: Math.max(0, skipped),
    latency: statsOf(rows.map((r) => r.ms)),
    recovered: statsOf(recoveredValues),
    recoveredRounds: recoveredValues.length,
    gap: {
      rounds: rows.length,
      gappedRounds: rows.filter((r) => r.gap > 0).length,
      totalGap: rows.reduce((s, r) => s + Math.max(0, r.gap), 0),
    },
    fetched: rows.reduce((s, r) => s + r.fetched, 0),
    applied: rows.reduce((s, r) => s + r.applied, 0),
    spaces,
    peers,
    segments,
  };
}

/** @param {PercStats|null} s */
function percText(s) {
  if (!s) return "没量到（⛔ 不算 0）";
  return `p50 ${s.p50}ms · p95 ${s.p95}ms · max ${s.max}ms · >1s ${s.over1s} 条 · >100ms ${s.over100ms} 条（${s.count} 轮）`;
}

/** @param {LatencySegment[]} segments */
function segmentLines(segments) {
  if (segments.length === 0) {
    return [
      "  （一条都没有：本批日志没打 [sync-latency]。只有在开着 SHUYONOTE_LAN_DEBUG_ANNOUNCE 时才会打）",
    ];
  }
  return segments.map((s) => {
    const human = LATENCY_SEGMENT_TEXT[s.seg];
    const stats = percText(s.stats);
    return `  ${s.seg}${human ? `（${human}）` : "（不认识的段名，照实列出）"}：${stats}`;
  });
}

/** @param {GroupReading[]} groups */
function groupLines(groups) {
  if (groups.length === 0) return ["  （没有）"];
  return groups.map(
    (g) =>
      `  ${g.label}：${g.rounds} 轮 · ${g.lat.p50}/${g.lat.p95}/${g.lat.max} ms（p50/p95/max）` +
      ` · 缺口 ${g.gapped} 轮 · fetched ${g.fetched} · applied ${g.applied}`,
  );
}

/**
 * 报告文本（**脱敏**：只有计数与编号；⛔ 不含空间哈希、设备号、文件路径）。
 *
 * 一条都没量到 ⇒ 第一行就写「没量到」，调用方据此退 2（**没查过 ≠ 通过**）。
 * @param {BaselineSummary} s
 * @param {string} [title]
 */
export function formatBaselineReport(s, title = "个人版同步 2.0 · Phase 0 基线（只读日志）") {
  const lines = [title];
  if (s.rounds === 0) {
    lines.push(
      "没量到：这一批日志里没有一行能解析的 [sync-metrics]（⛔ 这不算基线，也不算通过）",
      `跳过/可疑行：${s.skipped}`,
      "能怎么量：让网格这一档跑起来打一轮同步，日志里每轮会写一行 [sync-metrics] … ms=…。",
      `分段读数：${s.segments.length === 0 ? "一条都没有" : `${s.segments.length} 段（但没有轮次读数，⛔ 不作基数）`}`,
    );
    return lines.join("\n");
  }
  lines.push(
    `轮数：${s.rounds} 条（跳过/可疑 ${s.skipped} 条）`,
    `单轮拉取耗时：${percText(s.latency)}`,
    `恢复耗时（recovered_after_ms，断过多长时间才恢复）：${
      s.recovered ? percText(s.recovered) : `没出现这一格（0/${s.rounds} 轮）`
    }`,
    `缺口：${s.gap.gappedRounds}/${s.gap.rounds} 轮有缺口（gap>0），合计缺口 ${s.gap.totalGap} 条`,
    `明细：fetched 合计 ${s.fetched} · applied 合计 ${s.applied}`,
    "",
    "按空间（编号代替空间名/哈希）：",
    ...groupLines(s.spaces),
    "",
    "按对端（编号代替设备号）：",
    ...groupLines(s.peers),
    "",
    "分段（⭐ 埋点：**本机两段时刻**，⛔ 跨机不可相减 —— 端到端还差「传输」那一段，日志里没有）：",
    ...segmentLines(s.segments),
    "",
    "⚠️ 这份基线**量不到**：改→对端可见延迟、通知/轮询端到端时延、耗电/流量、换网恢复时间",
    "   （前两项要跨机对齐同一个时钟，日志里没有 ⇒ ⛔ 不许拿本机 ms 冒充「改→可见」）。",
  );
  return lines.join("\n");
}
