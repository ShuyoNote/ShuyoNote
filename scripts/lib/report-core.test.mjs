// scripts/lib/report-core.mjs 的单测。
//
// 为什么要测这些纯函数：它们是**公开汇总表的唯一出口**——一旦解析或判定写错，
// 贴出去的"绿"就是假的。而且这里已经有过一次真实事故：
// 早先用裸 `(\d+)/(\d+)` 兜底解析读数，把 `check-plugin-hosting.mjs` 输出里的进度数字
// 当成了 "2280/4560 断言" 写进汇总表。下面 "绝不把无关数字当断言数" 那条就是它的回归用例。
import { describe, expect, it } from "vitest";
import {
  baselineViolations,
  countsForGate,
  countsFromOutput,
  countsFromSmokeJson,
  countsFromVitestJson,
  extractFailures,
  markdownReport,
  summaryLine,
  upsertSuiteStatus,
} from "./report-core.mjs";

describe("读数解析（countsFromOutput）", () => {
  it("认仓库的中文汇总格式：[结果] N 通过 / M 失败", () => {
    expect(countsFromOutput("面板布局验收\n[结果] 25 通过 / 0 失败\n")).toEqual({ passed: 25, failed: 0, total: 25 });
    expect(countsFromOutput("[结果] 8 通过 / 2 失败")).toEqual({ passed: 8, failed: 2, total: 10 });
  });

  it("认 smoke-web 的英文格式：N passed, M failed", () => {
    expect(countsFromOutput("\n350 passed, 0 failed")).toEqual({ passed: 350, failed: 0, total: 350 });
  });

  it("绝不把无关数字当断言数（2280/4560 那次事故的回归用例）", () => {
    // check-plugin-hosting.mjs 会打印 `逐条核对 N 个包` 和各种进度数字。
    expect(countsFromOutput("逐条核对 2280 个包：2280/4560 已完成\n[结果] 60 通过 / 0 失败")).toEqual({
      passed: 60,
      failed: 0,
      total: 60,
    });
    // 只有裸的 N/M、没有任何"通过/失败"语义时，必须返回 null（宁可显示"—"）。
    expect(countsFromOutput("progress 2280/4560")).toBeNull();
  });

  it("空输出 / 无汇总行 → null", () => {
    expect(countsFromOutput("")).toBeNull();
    expect(countsFromOutput(undefined)).toBeNull();
    expect(countsFromOutput("一切正常，没有任何计数行")).toBeNull();
  });
});

describe("读数解析（JSON 来源）", () => {
  it("vitest JSON：取 numTotalTests / numPassedTests / numFailedTests", () => {
    expect(countsFromVitestJson({ numTotalTests: 702, numPassedTests: 700, numFailedTests: 2 })).toEqual({
      total: 702,
      passed: 700,
      failed: 2,
    });
  });

  it("vitest JSON：缺字段或不是对象 → null（不猜）", () => {
    expect(countsFromVitestJson({ numPassedTests: 3 })).toBeNull();
    expect(countsFromVitestJson(null)).toBeNull();
    expect(countsFromVitestJson("702")).toBeNull();
  });

  it("smoke-web JSON：取 total / passed / failed", () => {
    expect(countsFromSmokeJson({ total: 350, passed: 350, failed: 0 })).toEqual({ total: 350, passed: 350, failed: 0 });
    expect(countsFromSmokeJson({ passed: 1 })).toBeNull();
    expect(countsFromSmokeJson(undefined)).toBeNull();
  });

  it("countsForGate 按 counters 路由，并注入 readJson（IO 留在调用方）", () => {
    const gate = { id: "vitest", counters: "vitest" };
    expect(countsForGate(gate, "", (name) => (name === "vitest.json" ? { numTotalTests: 5, numPassedTests: 5, numFailedTests: 0 } : null))).toEqual(
      { total: 5, passed: 5, failed: 0 },
    );
    // 文件不存在（readJson 返回 null）→ null，而不是抛异常
    expect(countsForGate(gate, "", () => null)).toBeNull();
    // 未声明 counters（auto）→ 走文本兜底
    expect(countsForGate({ id: "x", counters: "auto" }, "[结果] 3 通过 / 1 失败", () => null)).toEqual({
      passed: 3,
      failed: 1,
      total: 4,
    });
  });
});

describe("失败明细（extractFailures）", () => {
  it("只挑明确的失败行，且最多 25 条", () => {
    const out = extractFailures("  ✓ ok\n  ✗ 第一条失败 — 详情\n随便一行\nFAIL something\nnot ok 2\n");
    expect(out).toEqual(["✗ 第一条失败 — 详情", "FAIL something", "not ok 2"]);
  });

  it("超过 25 条时截断（够定位，不撑爆报告）", () => {
    const many = Array.from({ length: 40 }, (_, i) => `✗ fail ${i}`).join("\n");
    expect(extractFailures(many)).toHaveLength(25);
  });
});

describe("基线判定（baselineViolations）", () => {
  const gates = [
    { id: "smoke-web", group: "smoke" },
    { id: "mobile-overlays", group: "mobile" },
  ];
  const baseline = { counts: { "smoke-web": 350 }, gates: { smoke: ["smoke-web"], mobile: ["mobile-overlays"] } };

  it("读数不低于基线 → 无违规", () => {
    const results = [{ id: "smoke-web", baseline: true, status: "passed", counts: { total: 350 } }];
    expect(baselineViolations({ results, baseline, currentGates: gates })).toEqual([]);
    const higher = [{ id: "smoke-web", baseline: true, status: "passed", counts: { total: 361 } }];
    expect(baselineViolations({ results: higher, baseline, currentGates: gates })).toEqual([]);
  });

  it("读数低于基线 → 违规（点名 from → to）", () => {
    const results = [{ id: "smoke-web", baseline: true, status: "passed", counts: { total: 349 } }];
    const v = baselineViolations({ results, baseline, currentGates: gates });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("从 350 降到 349");
  });

  it("通过了却读不到读数 → 违规（解析链断了，基线校验对它已失效）", () => {
    const results = [{ id: "smoke-web", baseline: true, status: "passed", counts: null }];
    expect(baselineViolations({ results, baseline, currentGates: gates })[0]).toContain("没有解析出读数");
  });

  it("基线里缺这条门禁的读数 → 违规（基线名存实亡）", () => {
    const results = [{ id: "mobile-overlays", baseline: true, status: "passed", counts: { total: 979 } }];
    const v = baselineViolations({ results, baseline, currentGates: gates });
    expect(v[0]).toContain("没有对应读数");
  });

  it("跳过 / 失败的门禁不参与基线比较（跳过既不算通过也不算退步）", () => {
    const skipped = [{ id: "smoke-web", baseline: true, status: "skipped", counts: null }];
    expect(baselineViolations({ results: skipped, baseline, currentGates: gates })).toEqual([]);
  });

  it("注册表里少了一条已登记的门禁 → 违规（被顺手删掉/改名）", () => {
    const v = baselineViolations({ results: [], baseline, currentGates: [{ id: "smoke-web", group: "smoke" }] });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("mobile-overlays");
  });

  it("--update-baseline 时不产生任何违规（这一轮就是要重写基线）", () => {
    const results = [{ id: "smoke-web", baseline: true, status: "passed", counts: { total: 1 } }];
    expect(baselineViolations({ results, baseline, currentGates: [], updateBaseline: true })).toEqual([]);
  });
});

describe("机器生成的汇总行（summaryLine，发版说明用）", () => {
  const report = {
    ok: true,
    results: [
      { id: "smoke-web", group: "smoke", status: "passed", counts: { total: 350 } },
      { id: "tsc", group: "smoke", status: "passed", counts: null },
      { id: "mobile-layout", group: "mobile", status: "passed", counts: { total: 43 } },
      { id: "external-index", group: "artifact", status: "skipped", counts: null },
    ],
  };

  it("包含结论、分组通过数与断言合计", () => {
    const line = summaryLine(report);
    expect(line).toContain("门禁全绿");
    expect(line).toContain("smoke 2/2");
    expect(line).toContain("mobile 1/1/43 断言");
    expect(line).toContain("合计 393 条断言/用例");
    expect(line).toContain("1 条显式跳过");
  });

  it("有失败时结论改为「存在失败」", () => {
    const bad = { ...report, ok: false, results: [...report.results, { id: "x", group: "smoke", status: "failed", counts: null }] };
    expect(summaryLine(bad)).toContain("门禁存在失败");
  });
});

describe("外部套件状态回写（upsertSuiteStatus）", () => {
  const suites = [
    { id: "sync-regression", name: "同步回归", where: "私有服务端仓库 CI", status: "本仓库不可见" },
    { id: "manual-device", name: "真机验收", where: "人工", status: "未记录" },
  ];

  it("按 id 定位并写入人类可读状态 + 机器可读字段", () => {
    const { suites: next, found } = upsertSuiteStatus(suites, {
      id: "sync-regression",
      status: "passed",
      commit: "abc1234",
      evidence: "run #42",
      at: "2026-09-16T16:00:00Z",
    });
    expect(found).toBe(true);
    expect(next[0].status).toBe("通过（2026-09-16T16:00:00Z，commit abc1234，run #42）");
    expect(next[0].lastStatus).toBe("passed");
    expect(next[0].lastRunAt).toBe("2026-09-16T16:00:00Z");
    // 原数组不被就地修改（纯函数）
    expect(suites[0].status).toBe("本仓库不可见");
  });

  it("失败状态同样可写，且未涉及的套件原样保留", () => {
    const { suites: next } = upsertSuiteStatus(suites, { id: "manual-device", status: "failed", at: "2026-09-16T16:00:00Z" });
    expect(next[1].status).toBe("失败（2026-09-16T16:00:00Z）");
    expect(next[0]).toEqual(suites[0]);
  });

  it("id 不存在时 found=false 且不改数据（调用方据此非零退出）", () => {
    const { suites: next, found } = upsertSuiteStatus(suites, { id: "nope", status: "passed" });
    expect(found).toBe(false);
    expect(next).toEqual(suites);
  });
});

describe("汇总 markdown（markdownReport）", () => {
  const base = {
    groups: ["smoke"],
    baselineViolations: [],
    externalSuites: [],
    ok: true,
    results: [
      { id: "smoke-web", group: "smoke", label: "冒烟", status: "passed", counts: { passed: 350, total: 350, failed: 0 }, durationMs: 2800, attempts: 1, failures: [] },
    ],
  };

  it("永远有表头与最后那行机器生成的汇总", () => {
    const md = markdownReport(base);
    expect(md).toContain("| 门禁 | 结果 | 断言 / 用例 | 耗时 |");
    expect(md).toContain("`smoke-web`");
    expect(md).toContain("350 / 350");
    expect(md).toContain("门禁全绿");
  });

  it("没有失败/跳过/重试时，不出这些小节（避免噪音被忽略）", () => {
    const md = markdownReport(base);
    expect(md).not.toContain("### 失败明细");
    expect(md).not.toContain("### 显式跳过");
    expect(md).not.toContain("靠重试才通过");
  });

  it("有失败、跳过、基线违规、外部套件时逐节出现", () => {
    const md = markdownReport({
      ...base,
      ok: false,
      baselineViolations: ["`smoke-web` 断言数从 350 降到 349"],
      externalSuites: [{ name: "sync-regression", where: "私有服务端仓库 CI", status: "本仓库不可见" }],
      results: [
        ...base.results,
        { id: "two-device-sync", group: "sync", label: "同步", status: "failed", counts: null, durationMs: 300, attempts: 1, failures: ["✗ 冲突没合上"], reason: "" },
        { id: "external-index", group: "artifact", label: "外部产物", status: "skipped", counts: null, durationMs: 0, attempts: 0, reason: "缺少环境变量 X", failures: [] },
      ],
    });
    expect(md).toContain("### 失败明细");
    expect(md).toContain("✗ 冲突没合上");
    expect(md).toContain("### 显式跳过（不是通过）");
    expect(md).toContain("缺少环境变量 X");
    expect(md).toContain("### 基线违规");
    expect(md).toContain("### 外部执行");
    expect(md).toContain("sync-regression");
  });

  it("靠重试才通过的单独列出来（flake 不许被抹平）", () => {
    const md = markdownReport({
      ...base,
      results: [{ ...base.results[0], attempts: 3 }],
    });
    expect(md).toContain("靠重试才通过的");
    expect(md).toContain("第 3 次才通过");
  });
});
