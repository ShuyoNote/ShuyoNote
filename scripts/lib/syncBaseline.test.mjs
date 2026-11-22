// §13.12 Phase 0 基线的**可机判**那几条 —— 纯函数级（`scripts/lib/syncBaseline.mjs`）。
//
// 覆盖：
//   ① 正常行（含 `recovered_after_ms`）：字段逐个对得上；
//   ② **CRLF 真行**：行尾带 `\r` 也必须解析得出（本仓踩过「`split("\n")` 在 CRLF 上整体静默失效」，
//      而合成用例（LF）全绿 —— 所以这一格必须是**带 `\r` 的字符串**，不是靠文件系统运气）；
//   ③ 形状不对 ⇒ `null`（⛔ 不猜、不填 0）；缺 `ms` / `ms` 非整数 / 缺 `peer` 都算；
//   ④ 分位数用 nearest-rank（已知集合 → 已知读数；⛔ 不插值）；
//   ⑤ 汇总：缺口/恢复/分组都从读数来，分组**只有编号没有 id**；
//   ⑥ 一条都没量到 ⇒ 报告写「没量到」，⛔ 不写成 0ms／全绿。
import { describe, expect, it } from "vitest";

import {
  formatBaselineReport,
  parseLatencyLine,
  parseMetricsLine,
  parsePeerErrClassLine,
  parsePeerSkipLine,
  parseRoundTimingLine,
  percentile,
  splitMetricLines,
  splitRoundBlocks,
  summarizeMetrics,
  summarizeCadence,
  summarizeRoundTiming,
  summarizeSchedulingFailures,
} from "./syncBaseline.mjs";

/** 真实日志里那一行的形状（缩略了内部 id 的长度，字段一个不少）。 */
const LINE =
  "[sync-metrics] space=f28026b29a8c2a6ecb26f2203f016380 peer=4b345a0a-bdbb-4075-8768-0605b30784a2 since=9 max_seq=9 gap=0 fetched=0 applied=0 ms=37";

describe("Phase 0 基线 · 解析一行", () => {
  it("正常行：字段逐个对得上，没有 recovered_after_ms ⇒ null（⛔ 不填 0）", () => {
    const r = parseMetricsLine(LINE);
    expect(r).not.toBeNull();
    expect(r.space).toBe("f28026b29a8c2a6ecb26f2203f016380");
    expect(r.peer).toBe("4b345a0a-bdbb-4075-8768-0605b30784a2");
    expect([r.since, r.maxSeq, r.gap, r.fetched, r.applied, r.ms]).toEqual([9, 9, 0, 0, 0, 37]);
    expect(r.recoveredAfterMs).toBeNull();
  });

  it("⭐ CRLF 真行（尾随 \\r）也必须解析得出 —— 这一格是给「按行尾处理整体失效」那一类事故的", () => {
    const r = parseMetricsLine(`${LINE}\r`);
    expect(r, "带 \\r 的行解析不出来 ⇒ CRLF 工作区上整套读数会静默变成 0 条").not.toBeNull();
    expect(r.ms).toBe(37);
  });

  it("带 recovered_after_ms 的行：那一格读成数字（恢复耗时是这一族判据的来源）", () => {
    const r = parseMetricsLine(`${LINE} recovered_after_ms=4500`);
    expect(r.recoveredAfterMs).toBe(4500);
  });

  it("前缀里有别的东西（时间戳等）也认 —— 只要行里出现 `[sync-metrics]`", () => {
    const r = parseMetricsLine(`2026-11-14T09:41:07Z  [sync-metrics] space=aa peer=bb since=1 max_seq=2 gap=1 fetched=1 applied=1 ms=120`);
    expect(r).not.toBeNull();
    expect(r.gap).toBe(1);
    expect(r.ms).toBe(120);
  });

  it("形状不对 ⇒ null（⛔ 不猜、不填 0）", () => {
    expect(parseMetricsLine("")).toBeNull();
    expect(parseMetricsLine("[sync-metrics] 乱七八糟")).toBeNull();
    // 缺 ms
    expect(parseMetricsLine(LINE.replace(" ms=37", ""))).toBeNull();
    // ms 不是整数
    expect(parseMetricsLine(LINE.replace("ms=37", "ms=37.5"))).toBeNull();
    // ms 是负数（时间不可能为负 ⇒ 读数不可信）
    expect(parseMetricsLine(LINE.replace("ms=37", "ms=-1"))).toBeNull();
    // 缺 peer
    expect(parseMetricsLine(LINE.replace(" peer=4b345a0a-bdbb-4075-8768-0605b30784a2", ""))).toBeNull();
    // 根本不是这一行
    expect(parseMetricsLine("[announce] dirty=true")).toBeNull();
  });

  it("拆行同时认 LF 与 CRLF", () => {
    expect(splitMetricLines("a\r\nb\nc")).toEqual(["a", "b", "c"]);
  });
});

describe("Phase 0 基线 · 分位数（nearest-rank，⛔ 不插值）", () => {
  it("1..100：p50=50、p95=95、p100=100；单元素与空集合也说得清", () => {
    const asc = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(asc, 50)).toBe(50);
    expect(percentile(asc, 95)).toBe(95);
    expect(percentile(asc, 100)).toBe(100);
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  it("偶数个也用 nearest-rank（不上取平均）—— 15 个里 p50 就是第 8 个", () => {
    const asc = Array.from({ length: 15 }, (_, i) => i + 1);
    expect(percentile(asc, 50)).toBe(8);
  });
});

describe("Phase 0 基线 · 汇总", () => {
  function row(over = {}) {
    return {
      space: "s1",
      peer: "p1",
      since: 0,
      maxSeq: 0,
      gap: 0,
      fetched: 0,
      applied: 0,
      ms: 10,
      recoveredAfterMs: null,
      ...over,
    };
  }

  it("耗时分布 / >1s 计数 / 缺口 / 恢复都从读数来", () => {
    const s = summarizeMetrics([
      row({ ms: 10 }),
      row({ ms: 20 }),
      row({ ms: 1500 }),
      row({ ms: 50, gap: 2, fetched: 3, applied: 2 }),
      row({ ms: 30, recoveredAfterMs: 60000 }),
      row({ ms: 40, recoveredAfterMs: 4500 }),
    ]);
    expect(s.rounds).toBe(6);
    expect(s.latency).toEqual({ count: 6, p50: 30, p95: 1500, max: 1500, over1s: 1, over100ms: 1 });
    expect(s.recoveredRounds).toBe(2);
    expect(s.recovered.p50).toBe(4500);
    expect(s.recovered.max).toBe(60000);
    expect(s.gap.gappedRounds).toBe(1);
    expect(s.gap.totalGap).toBe(2);
    expect(s.fetched).toBe(3);
    expect(s.applied).toBe(2);
  });

  it("分组只有编号：⛔ 报告里不许出现空间哈希/设备号原文", () => {
    const rows = [
      row({ space: "deadbeef01", peer: "peer-aaa", ms: 12 }),
      row({ space: "deadbeef01", peer: "peer-bbb", ms: 15 }),
      row({ space: "cafebabe02", peer: "peer-aaa", ms: 18 }),
    ];
    const s = summarizeMetrics(rows);
    expect(s.spaces.map((g) => g.label)).toEqual(["空间 1", "空间 2"]);
    expect(s.spaces[0].rounds).toBe(2); // 轮数多的排前面（⛔ 不按 id 排）
    expect(s.peers.map((g) => g.label)).toEqual(["对端 1", "对端 2"]);
    const text = formatBaselineReport(s);
    for (const secret of ["deadbeef01", "cafebabe02", "peer-aaa", "peer-bbb"]) {
      expect(text.includes(secret), `报告泄漏了内部 id：${secret}`).toBe(false);
    }
    expect(text).toContain("空间 1");
    expect(text).toContain("对端 1");
  });

  it("一条都没量到 ⇒ 报告写「没量到」，⛔ 不写成 0ms / 全绿", () => {
    const s = summarizeMetrics([], 4);
    expect(s.latency).toBeNull();
    expect(s.recovered).toBeNull();
    const text = formatBaselineReport(s);
    expect(text).toContain("没量到");
    expect(text).toContain("不算通过");
    expect(text).toContain("4"); // 跳过/可疑行数照写
    expect(text).not.toContain("p50 0ms");
  });
});

// ⭐ §13.12 Phase 0 埋点（2026-11-18，owner 拍「动埋点」）：两段**本机**时刻。
// 口径：两段各报各的，⛔ 跨机不可相减（端到端还差"传输"那一段，日志里没有共同时钟）。
describe("Phase 0 埋点 · [sync-latency] 两段", () => {
  it("解析：段名 + 毫秒；CRLF 行也认", () => {
    expect(parseLatencyLine("[sync-latency] seg=save_to_announce ms=750")).toEqual({
      seg: "save_to_announce",
      ms: 750,
    });
    expect(parseLatencyLine("[sync-latency] seg=announce_to_round_done ms=61\r")).toEqual({
      seg: "announce_to_round_done",
      ms: 61,
    });
  });

  it("形状不对 ⇒ null（⛔ 不猜）：缺段名 / 毫秒非整数 / 负毫秒 / 段名带空格或路径", () => {
    expect(parseLatencyLine("[sync-latency] ms=12")).toBeNull();
    expect(parseLatencyLine("[sync-latency] seg=x ms=1.5")).toBeNull();
    expect(parseLatencyLine("[sync-latency] seg=x ms=-3")).toBeNull();
    expect(parseLatencyLine("[sync-latency] seg=a b ms=3")).toBeNull();
    expect(parseLatencyLine("[sync-metrics] space=a peer=b since=0 max_seq=0 gap=0 fetched=0 applied=0 ms=1")).toBeNull();
  });

  it("汇总把两段分开算；报告里给人话，且不认识的段名照原样列出（⛔ 不静默丢）", () => {
    const row = { space: "s", peer: "p", since: 0, maxSeq: 0, gap: 0, fetched: 0, applied: 0, ms: 10, recoveredAfterMs: null };
    const s = summarizeMetrics(
      [row, row],
      0,
      [
        { seg: "save_to_announce", ms: 750 },
        { seg: "save_to_announce", ms: 1250 },
        { seg: "announce_to_round_done", ms: 61 },
        { seg: "future_segment", ms: 9 },
      ],
    );
    expect(s.segments.map((x) => x.seg)).toEqual([
      "save_to_announce",
      "announce_to_round_done",
      "future_segment",
    ]);
    expect(s.segments[0].stats).toEqual({ count: 2, p50: 750, p95: 1250, max: 1250, over1s: 1, over100ms: 2 });
    const text = formatBaselineReport(s);
    expect(text).toContain("保存 → 公告发出");
    expect(text).toContain("收到对端公告 → 该轮跑完");
    expect(text).toContain("future_segment");
    expect(text).toContain("不认识的段名");
    // ⛔ 不把两段拼成"端到端"
    expect(text).not.toContain("端到端 =");
  });

  it("一条埋点都没有 ⇒ 报告说清「没有」，⛔ 不写成 0ms", () => {
    const row = { space: "s", peer: "p", since: 0, maxSeq: 0, gap: 0, fetched: 0, applied: 0, ms: 10, recoveredAfterMs: null };
    const text = formatBaselineReport(summarizeMetrics([row], 0, []));
    expect(text).toContain("一条都没有");
    expect(text).toContain("SHUYONOTE_LAN_DEBUG_ANNOUNCE");
    expect(text).not.toContain("save_to_announce（保存 → 公告发出）：没量到");
  });
  it("只有埋点、没有轮次读数时：分段照样列出来（⛔ 不因为缺轮次就把已有读数藏起来）", () => {
    const text = formatBaselineReport(
      summarizeMetrics([], 0, [
        { seg: "save_to_announce", ms: 238 },
        { seg: "save_to_announce", ms: 74386 },
        { seg: "save_to_announce", ms: 123 },
      ]),
    );
    expect(text).toContain("没量到");
    expect(text).toContain("save_to_announce（保存 → 公告发出）");
    expect(text).toContain("p50 238ms");
    expect(text).toContain("max 74386ms");
  });
});

// ⭐ F2/F3 Phase 0（2026-11-19）：调度读数（`[round-timing]` 逐空间耗时）＋ 水位差（每台对端落后几条）。
// 口径：**只读日志、⛔ 不改行为**；日志里**没有轮边界标记** ⇒ 每轮合计是**推断值**，必须写明怎么推的。
describe("F2/F3 Phase 0 · [round-timing] 逐空间耗时（F3 调度）", () => {
  /** 真机日志里的形状（空间标签由 Rust 侧 `mask_space` 脱敏成 `f280…`）。 */
  const T = "[round-timing] space=f280… ok=true ms=98";

  it("解析：忠实读 ok 与 ms；CRLF 行也认；⛔ 不还原脱敏标签、也不打印它", () => {
    expect(parseRoundTimingLine(T)).toEqual({ space: "f280…", ok: true, ms: 98, atMs: null });
    expect(parseRoundTimingLine("[round-timing] space=1c02… ok=false ms=21061\r")).toEqual({
      space: "1c02…",
      ok: false,
      ms: 21061,
      atMs: null,
    });
  });

  it("形状不对 ⇒ null（⛔ 不猜）：缺 space / ok 不是 true|false / ms 非整数或负数 / 带碎词", () => {
    expect(parseRoundTimingLine("")).toBeNull();
    expect(parseRoundTimingLine("[round-timing] space=x ok=true")).toBeNull(); // 缺 ms
    expect(parseRoundTimingLine("[round-timing] ok=true ms=9")).toBeNull(); // 缺 space
    expect(parseRoundTimingLine("[round-timing] space=x ok=yes ms=9")).toBeNull();
    expect(parseRoundTimingLine("[round-timing] space=x ok=true ms=9.5")).toBeNull();
    expect(parseRoundTimingLine("[round-timing] space=x ok=true ms=-1")).toBeNull();
    expect(parseRoundTimingLine("[round-timing] space=x ok=true ms=9 掐了")).toBeNull();
    expect(
      parseRoundTimingLine("[sync-metrics] space=a peer=b since=0 max_seq=0 gap=0 fetched=0 applied=0 ms=1"),
    ).toBeNull();
  });

  it("切块：**同一空间标签在块内重复** ⇒ 新一轮（日志没有轮边界标记，这是唯一可复算的推法）", () => {
    const rows = ["a", "b", "c", "a", "b", "c"].map((space) => ({ space, ok: true, ms: 10 }));
    const blocks = splitRoundBlocks(rows);
    expect(blocks.map((b) => b.rows.length)).toEqual([3, 3]);
    // 顺序不被重排（⛔ 不按标签排序 —— 那样会把"块"弄丢）
    expect(blocks[0].rows.map((r) => r.space)).toEqual(["a", "b", "c"]);
  });

  it("每轮合计**只**在「块大小＝最大块」的块上算；不完整块单独计数，⛔ 不补齐、⛔ 不丢", () => {
    const rows = [
      // 完整一轮 3 个空间
      { space: "a", ok: true, ms: 100 },
      { space: "b", ok: true, ms: 200 },
      { space: "c", ok: true, ms: 300 },
      // 重启打断的半轮（只有 2 条）
      { space: "a", ok: true, ms: 50 },
      { space: "b", ok: false, ms: 70 },
    ];
    const s = summarizeRoundTiming(rows);
    expect(s.lines).toBe(5);
    expect(s.spaces).toBe(3);
    expect(s.okLines).toBe(4);
    expect(s.failedLines).toBe(1);
    // ⚠️ `over100ms` 的既有口径是**严格 `> 100`**（与 `summarizeMetrics` 同一把尺）⇒ 100 那一条不算。
    expect(s.perSpace).toEqual({ count: 5, p50: 100, p95: 300, max: 300, over1s: 0, over100ms: 2 });
    expect(s.blocks.count).toBe(2);
    expect(s.blocks.full).toBe(1);
    expect(s.blocks.partial).toBe(1);
    expect(s.blocks.perRound).toEqual({ count: 1, p50: 600, p95: 600, max: 600, over1s: 0, over100ms: 1 });
    expect(s.blocks.sizes).toEqual([3, 2]);
  });

  it("一条都没有 ⇒ 报告写「没量到」，⛔ 不写成 0ms；已有轮次读数照旧列出来", () => {
    const row = { space: "s", peer: "p", since: 0, maxSeq: 0, gap: 0, fetched: 0, applied: 0, ms: 10, recoveredAfterMs: null };
    const text = formatBaselineReport(summarizeMetrics([row], 0, [], []));
    // 报告头是「调度（F3 Phase 0，…）」⇒ 判据用前缀，⛔ 不钉死括号后的字
    expect(text).toContain("调度（F3 Phase 0");
    expect(text).toContain("没量到");
    expect(text).not.toContain("逐空间耗时：p50 0ms");
  });

  it("报告里**不出现**空间标签原文（脱敏标签也不行 —— 它也是内部 id 的前缀）", () => {
    const rows = [
      { space: "f280…", ok: true, ms: 98 },
      { space: "1c02…", ok: true, ms: 194 },
    ];
    const text = formatBaselineReport(summarizeMetrics([], 0, [], rows));
    expect(text.includes("f280")).toBe(false);
    expect(text.includes("1c02…")).toBe(false);
    expect(text).toContain("逐空间耗时");
  });
});

describe("F2 Phase 0 · 对端水位差（谁缺谁的数据）", () => {
  function row(over = {}) {
    return {
      space: "s1",
      peer: "p1",
      since: 9,
      maxSeq: 9,
      gap: 0,
      fetched: 0,
      applied: 0,
      ms: 10,
      recoveredAfterMs: null,
      ...over,
    };
  }

  it("每台对端：最大落后 / 缺口合计 / 拉了但没融合的轮数，都从读数来", () => {
    const s = summarizeMetrics([
      row({ peer: "p1", since: 7, maxSeq: 9, gap: 2, fetched: 0, applied: 0 }),
      row({ peer: "p1", since: 9, maxSeq: 9, gap: 0 }),
      row({ peer: "p2", since: 0, maxSeq: 4, gap: 4, fetched: 2, applied: 0 }),
      row({ peer: "p2", since: 3, maxSeq: 3, gap: 0, fetched: 1, applied: 1 }),
    ]);
    const byRounds = s.peers.filter((g) => g.rounds === 2);
    expect(byRounds.length).toBe(2);
    const maxGaps = byRounds.map((g) => g.maxGap).sort((a, b) => a - b);
    const totalGaps = byRounds.map((g) => g.totalGap).sort((a, b) => a - b);
    expect(maxGaps).toEqual([2, 4]);
    expect(totalGaps).toEqual([2, 4]);
    // 拉了但没融合：p2 那一轮 fetched 2 / applied 0 ⇒ 1 轮（p1 那轮 fetched 0 ⇒ 不算）
    expect(Math.max(...byRounds.map((g) => g.notAppliedRounds))).toBe(1);
  });

  it("报告每台对端写出「缺口 N 轮 / 合计 K 条 · 拉了没融合 M 轮」，且⛔ 不打印设备号", () => {
    const rows = [
      row({ peer: "peer-zeta-9", since: 0, maxSeq: 4, gap: 4, fetched: 2, applied: 0 }),
      row({ peer: "peer-zeta-9", since: 4, maxSeq: 4, gap: 0 }),
    ];
    const text = formatBaselineReport(summarizeMetrics(rows));
    expect(text).toContain("对端 1");
    expect(text).toContain("合计 4 条");
    expect(text).toContain("拉了没融合 1 轮");
    expect(text.includes("peer-zeta-9")).toBe(false);
  });

  it("applied=0 而 fetched>0 是**洞**：⛔ 不因为 gap 后来归零就写成已收敛", () => {
    const rows = [
      row({ peer: "p1", since: 0, maxSeq: 4, gap: 4, fetched: 2, applied: 0 }),
      row({ peer: "p1", since: 4, maxSeq: 4, gap: 0 }),
    ];
    const g = summarizeMetrics(rows).peers[0];
    expect(g.gapped).toBe(1);
    expect(g.notAppliedRounds).toBe(1);
    expect(g.totalGap).toBe(4);
  });
});

// ⭐ F3 Phase 0（2026-11-20）：失败面 —— 两条解析 ＋ 汇总 ＋ 报告一节。
//    这一组是「改调度之前先把失败量出来」的唯一判据：⛔ 此工具不改任何同步行为。
describe("F3 · 失败面（[peer-skip] / [peer-err-class]）", () => {
  it("parsePeerSkipLine：只认那一个形状；数字缺失/坏 ⇒ null（⛔ 不猜）", () => {
    expect(parsePeerSkipLine("[peer-skip] 本轮已失败 2 台 ⇒ 本空间不再试它们（下一轮照旧重试）")).toEqual({
      failed: 2,
    });
    expect(parsePeerSkipLine("[peer-skip] 本轮已失败 0 台 ⇒ …")).toEqual({ failed: 0 });
    expect(parsePeerSkipLine("[peer-skip] 没有那个数字")).toBeNull();
    expect(parsePeerSkipLine("没有标记的普通行")).toBeNull();
    expect(parsePeerSkipLine("[sync-metrics] space=a peer=b")).toBeNull();
  });

  it("parsePeerErrClassLine：skip 与 errLen 各归各位（len= 是错误文本字符数，不是类数）", () => {
    // ⚠️ 这一条钉的正是第一版读歪的地方：441 这种值只能解释成「文本长度」，不可能是「类数」。
    expect(parsePeerErrClassLine(`[peer-err-class] skip=true hits=["timeout"] len=441`)).toEqual({
      skip: true,
      errLen: 441,
    });
    expect(parsePeerErrClassLine("[peer-err-class] skip=false hits=[] len=0")).toEqual({
      skip: false,
      errLen: 0,
    });
    expect(parsePeerErrClassLine("[peer-err-class] skip=maybe len=1")).toBeNull();
    expect(parsePeerErrClassLine("[peer-err-class] skip=true")).toBeNull();
    expect(parsePeerErrClassLine("普通行")).toBeNull();
  });

  it("summarizeSchedulingFailures：一条都没有 ⇒ null（⛔ 不写 0：没量到 ≠ 零失败）", () => {
    expect(summarizeSchedulingFailures([], [])).toBeNull();
    expect(summarizeSchedulingFailures()).toBeNull();
    const got = summarizeSchedulingFailures(
      [{ failed: 2 }, { failed: 1 }],
      [{ skip: true, errLen: 10 }, { skip: false, errLen: 5 }],
    );
    expect(got).toEqual({
      skipEvents: 2,
      skippedPeers: 3,
      errLines: 2,
      errSkipped: 1,
      errTextChars: 15,
    });
  });

  it("报告里那一节：有读数就列出来；没有就写「没量到」（⛔ 不写 0）", () => {
    const row = {
      space: "s",
      peer: "p",
      since: 0,
      maxSeq: 0,
      gap: 0,
      fetched: 0,
      applied: 0,
      ms: 5,
      recoveredAfterMs: null,
    };
    const withData = formatBaselineReport(
      summarizeMetrics([row], 0, [], [], [{ failed: 2 }], [{ skip: true, errLen: 10 }]),
    );
    expect(withData).toContain("失败面（F3 决策用");
    expect(withData).toContain("被跳过：1 次");
    expect(withData).toContain("累计失败 2 台次");
    expect(withData).toContain("错误文本合计 10 字符");
    const empty = formatBaselineReport(summarizeMetrics([row], 0, [], [], [], []));
    expect(empty).toContain("没量到：这批日志没有 [peer-skip]");
  });
});

// ⭐ S1/S2 Phase 0（2026-11-22）：`at_ms` 与"轮节奏"代理基线（⛔ 不是换网/休眠真实事件）。
describe("S1/S2 Phase 0：at_ms 与轮节奏", () => {
  const metrics = (extra = "") =>
    `[sync-metrics] space=a peer=b since=1 max_seq=2 gap=1 fetched=1 applied=1 ms=10${extra}`;

  it("parseMetricsLine 读 at_ms；老日志没有 ⇒ null（⛔ 不猜）", () => {
    expect(parseMetricsLine(metrics(" at_ms=1700000000000")).atMs).toBe(1700000000000);
    expect(parseMetricsLine(metrics()).atMs).toBeNull();
  });

  it("parseRoundTimingLine 也读 at_ms", () => {
    const r = parseRoundTimingLine("[round-timing] space=sp ok=true ms=12 at_ms=1700000000000");
    expect(r.atMs).toBe(1700000000000);
    expect(parseRoundTimingLine("[round-timing] space=sp ok=true ms=12").atMs).toBeNull();
  });

  it("summarizeCadence：同对端相邻间隔 + 长间隔（阈值 max(3×p50, 4 分钟)）", () => {
    const T0 = 1_700_000_000_000;
    const c = summarizeCadence([
      { peer: "p1", atMs: T0 },
      { peer: "p1", atMs: T0 + 1000 },
      { peer: "p1", atMs: T0 + 2000 },
      { peer: "p1", atMs: T0 + 3000 },
      { peer: "p1", atMs: T0 + 4000 },
      { peer: "p1", atMs: T0 + 500000 },
      { peer: "p2", atMs: T0 },
      { peer: "p2", atMs: T0 + 1000 },
      { peer: "p2", atMs: T0 + 2000 },
    ]);
    expect(c.samples).toBe(7); // p1 五个 + p2 两个
    expect(c.p50).toBe(1000);
    expect(c.thresholdMs).toBe(240000);
    expect(c.gaps).toBe(1); // 只有 496000 超过阈值
    expect(c.gapMaxMs).toBe(496000);
    expect(c.peers).toBe(2);
  });

  it("没有 at_ms ⇒ null（⛔ 不拿 0 当读数）", () => {
    expect(summarizeCadence([{ peer: "p1", atMs: null }])).toBeNull();
  });

  it("报告含轮节奏行（有轮次时；⛔ 不改行为）", () => {
    const s = summarizeMetrics([
      { space: "s1", peer: "p1", since: 0, maxSeq: 0, gap: 0, fetched: 0, applied: 0, ms: 10, recoveredAfterMs: null, atMs: 1000 },
      { space: "s1", peer: "p1", since: 0, maxSeq: 0, gap: 0, fetched: 0, applied: 0, ms: 10, recoveredAfterMs: null, atMs: 2000 },
    ]);
    const text = formatBaselineReport(s);
    expect(text).toContain("轮节奏");
    expect(text).toContain("长间隔");
    expect(text).toContain("1 个间隔");
  });
});

// ⭐ 2026-11-22：轮节奏分档 —— 后台连拉与稳态不能混算（S1/S2 Phase 0 口径）。
describe("轮节奏分档（连拉 / 中间 / 稳态）", () => {
  it("三档各自计数，互不混算", () => {
    const T0 = 1_700_000_000_000;
    const c = summarizeCadence([
      { peer: "p1", atMs: T0 },
      { peer: "p1", atMs: T0 + 100 },
      { peer: "p1", atMs: T0 + 200 },
      { peer: "p1", atMs: T0 + 5000 },
      { peer: "p1", atMs: T0 + 95000 },
      { peer: "p1", atMs: T0 + 185000 },
    ]);
    // 间隔：100 / 100 / 4800 / 90000 / 90000
    expect(c.burst.samples).toBe(2);
    expect(c.middleSamples).toBe(1);
    expect(c.steady.samples).toBe(2);
    expect(c.steady.p50).toBe(90000);
    expect(c.samples).toBe(5);
  });

  it("报告分开写「连拉档」与「稳态档」；没有稳态样本时明说没量到", () => {
    const T0 = 1_700_000_000_000;
    const row = (atMs) => ({
      space: "s1", peer: "p1", since: 0, maxSeq: 0, gap: 0,
      fetched: 0, applied: 0, ms: 10, recoveredAfterMs: null, atMs,
    });
    const withSteady = summarizeMetrics([row(T0), row(T0 + 90000)]);
    const text = formatBaselineReport(withSteady);
    expect(text).toContain("连拉档");
    expect(text).toContain("稳态档");
    expect(text).toContain("p50 90000ms");

    const burstOnly = summarizeMetrics([row(T0), row(T0 + 100)]);
    const text2 = formatBaselineReport(burstOnly);
    expect(text2).toContain("没量到（⛔ 不拿连拉冒充稳态）");
  });
});

// ⭐ 2026-11-22：按「轮」分组 —— 同一轮里多个空间不算轮间隔（修正 82ms 假读数的根因）。
describe("轮节奏按轮分组", () => {
  it("一轮内 s1→s2 不产生间隔；下一轮 s1 才开始新的一轮", () => {
    const T0 = 1_700_000_000_000;
    const c = summarizeCadence([
      { peer: "p1", space: "s1", atMs: T0 },
      { peer: "p1", space: "s2", atMs: T0 + 100 },
      { peer: "p1", space: "s1", atMs: T0 + 30000 },
      { peer: "p1", space: "s2", atMs: T0 + 30100 },
    ]);
    expect(c.samples).toBe(1); // 只有两轮之间那一个间隔
    expect(c.steady.samples).toBe(1);
    expect(c.steady.p50).toBe(30000);
    expect(c.burst.samples).toBe(0);
  });
});
