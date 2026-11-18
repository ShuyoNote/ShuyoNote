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
  parseMetricsLine,
  percentile,
  splitMetricLines,
  summarizeMetrics,
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
