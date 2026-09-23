// scripts/lib/report-core.mjs 的单测。
//
// 为什么要测这些纯函数：它们是**公开汇总表的唯一出口**——一旦解析或判定写错，
// 贴出去的"绿"就是假的。而且这里已经有过一次真实事故：
// 早先用裸 `(\d+)/(\d+)` 兜底解析读数，把 `check-plugin-hosting.mjs` 输出里的进度数字
// 当成了 "2280/4560 断言" 写进汇总表。下面 "绝不把无关数字当断言数" 那条就是它的回归用例。
import { describe, expect, it } from "vitest";
import { DEFAULT_BASELINE_NOTE, baselineNoteFor, baselineViolations, changelogNumberMismatches, countsForGate, countsFromCargoOutput, countsFromOutput, countsFromSmokeJson, countsFromVitestJson, extractFailures, extractSkips, markdownReport, mergeBaselineCounts, outputTail, staleBaselineNotices, summaryLine, upsertSuiteStatus } from "./report-core.mjs";

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

  it("cargo test：多个测试二进制的 `test result` 行必须**求和**（只取第一行会算少一大截）", () => {
    const out = [
      "running 12 tests",
      "test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
      "running 3 tests",
      "test result: ok. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out",
      "running 0 tests",
      "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
    ].join("\n");
    expect(countsFromCargoOutput(out)).toEqual({ passed: 15, failed: 1, total: 16 });
  });

  it("cargo test：没有汇总行 → null（别把编译期输出当读数）", () => {
    expect(countsFromCargoOutput("   Compiling shuyonote v1.91.3\n    Finished `test` profile")).toBeNull();
    expect(countsFromCargoOutput("")).toBeNull();
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

describe("基线太旧的提示（staleBaselineNotices：**提示**，不是失败）", () => {
  it("★ 下界远低于当前读数 ⇒ 出一条提示（点名百分比与建议）", () => {
    // 真实案例：tests/baseline.json 里 vitest 记着 746，而当前读数是 1299（57%）
    const n = staleBaselineNotices({
      results: [{ id: "vitest", baseline: true, status: "passed", counts: { total: 1299 } }],
      baseline: { counts: { vitest: 746 } },
    });
    expect(n).toHaveLength(1);
    expect(n[0]).toContain("746");
    expect(n[0]).toContain("1299");
    expect(n[0]).toContain("57%");
    expect(n[0]).toContain("--update-baseline");
  });

  it("下界接近当前读数 ⇒ 不提示（80% 是「够不够用」的界线，不是「完不完美」）", () => {
    const n = staleBaselineNotices({
      results: [{ id: "smoke-web", baseline: true, status: "passed", counts: { total: 352 } }],
      baseline: { counts: { "smoke-web": 350 } },
    });
    expect(n).toEqual([]);
  });

  it("阈值可调：90% 时 80% 的比值也会被提示", () => {
    const args = {
      results: [{ id: "smoke-web", baseline: true, status: "passed", counts: { total: 100 } }],
      baseline: { counts: { "smoke-web": 80 } },
    };
    expect(staleBaselineNotices(args)).toEqual([]); // 80% 不小于默认阈值
    expect(staleBaselineNotices({ ...args, thresholdPct: 90 })).toHaveLength(1);
  });

  it("没标 baseline / 没读数 / 读数下降 ⇒ 都不在这里报（下降那条归 baselineViolations 管）", () => {
    const base = { counts: { a: 10, b: 10, c: 100 } };
    expect(staleBaselineNotices({ results: [{ id: "a", baseline: false, status: "passed", counts: { total: 999 } }], baseline: base })).toEqual([]);
    expect(staleBaselineNotices({ results: [{ id: "b", baseline: true, status: "passed", counts: null }], baseline: base })).toEqual([]);
    // 读数下降：不在本函数报（否则会与"红"重复，读者会以为有两类失败）。
    // ⚠️ 这一条**必须把阈值调到 >100%** 才真的承重：默认 80% 时，下降会让比值 >100%，
    //    光靠比值判断就已经排除了 ⇒ 「expected >= actual 显式排除」那行看起来绿其实是摆设
    //    （变异证明当场抓到了这一点：去掉那行，默认阈值下 46 条全绿）。
    expect(staleBaselineNotices({ results: [{ id: "c", baseline: true, status: "passed", counts: { total: 50 } }], baseline: base })).toEqual([]);
    expect(
      staleBaselineNotices({
        results: [{ id: "c", baseline: true, status: "passed", counts: { total: 50 } }],
        baseline: base,
        thresholdPct: 250,
      }),
      "阈值 >100% 时，「下降」也必须被显式排除挡住（否则它会伪装成「下界太旧」）",
    ).toEqual([]);
  });
});

describe("抬基线时**保留手写历史**（baselineNoteFor）", () => {
  const HISTORY = "各门禁的下线。 2026-09-22：新增门禁 `rust-sm-wired`（库级国密接线），登记进 gates.rust。";

  it("★ 已有历史 ⇒ **逐字**保留（抬读数不许把它抹掉——那段历史就是 `note` 存在的理由）", () => {
    expect(baselineNoteFor(HISTORY)).toBe(HISTORY);
  });

  it("首次建立（空 / 缺失 / 只有空白）⇒ 写默认说明，别写空 `note`", () => {
    expect(baselineNoteFor("")).toBe(DEFAULT_BASELINE_NOTE);
    expect(baselineNoteFor("   \n")).toBe(DEFAULT_BASELINE_NOTE);
    expect(baselineNoteFor(undefined)).toBe(DEFAULT_BASELINE_NOTE);
    expect(baselineNoteFor(null)).toBe(DEFAULT_BASELINE_NOTE);
    // 读基线文件失败时 `readBaseline()` 给的是**对象**，不是字符串 ⇒ 同样走默认（别把对象写进 JSON）
    expect(baselineNoteFor({ junk: true })).toBe(DEFAULT_BASELINE_NOTE);
  });

  it("默认说明自己要被认成「没有历史」（否则第二次抬基线会把默认说明当历史留下）", () => {
    // 这条钉的是"默认说明不是历史"：它必须与真历史一样能往返，但空值判定只看**内容非空**
    expect(baselineNoteFor(DEFAULT_BASELINE_NOTE)).toBe(DEFAULT_BASELINE_NOTE);
    expect(DEFAULT_BASELINE_NOTE).toContain("--update-baseline");
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

describe("CHANGELOG 门禁数字校验（changelogNumberMismatches）", () => {
  const counts = { vitest: 732, "smoke-web": 350, "mobile-overlays": 979 };

  it("套件名与数字一对一绑定且一致 → 无违规", () => {
    expect(changelogNumberMismatches("门禁全绿：smoke-web 350 条、732 条单测", counts)).toEqual([]);
  });

  it("数字对不上 → 点名报出（写的是 X，基线是 Y）", () => {
    const bad = changelogNumberMismatches("smoke-web 300 条全绿", counts);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ suite: "smoke-web", found: 300, expected: 350 });
  });

  it("一行里出现多个套件或多个数字 → 跳过（说不清对应谁，宁可不判）", () => {
    expect(changelogNumberMismatches("smoke-web 350 条 与 732 条单测 都绿", counts)).toEqual([]);
    expect(changelogNumberMismatches("2026-09-16 门禁 smoke-web 350 条", counts)).toEqual([]);
  });

  it("历史/此前/曾/豁免 标记 → 跳过（历史段落的数字本来就不该被硬校验）", () => {
    expect(changelogNumberMismatches("此前 smoke-web 300 条（历史）", counts)).toEqual([]);
    expect(changelogNumberMismatches("smoke-web 300 条 <!-- 豁免 -->", counts)).toEqual([]);
  });

  it("没提到已知套件 → 跳过", () => {
    expect(changelogNumberMismatches("修了三个 bug，顺带把面板对齐", counts)).toEqual([]);
    expect(changelogNumberMismatches("", counts)).toEqual([]);
  });

  it("中文别名（单测/用例）绑定到 vitest", () => {
    expect(changelogNumberMismatches("732 条单测全过", counts)).toEqual([]);
    const bad = changelogNumberMismatches("700 条用例", counts);
    expect(bad[0]).toMatchObject({ suite: "vitest", found: 700, expected: 732 });
  });

  it("版本号这种带点的数字不算候选（1.91.3 不该被当成读数）", () => {
    expect(changelogNumberMismatches("v1.91.3 的 smoke-web 350 条", counts)).toEqual([]);
  });
});

describe("从 CI 报告并入基线（mergeBaselineCounts）", () => {
  const gates = [
    { id: "rust-test", counters: "cargo" }, // 尚无 baseline 契约
    { id: "smoke-web", counters: "smoke-web", baseline: true },
    { id: "tsc" }, // 无 counters：读数不可信
  ];

  it("导入有读数的门禁，并保留其它已有读数", () => {
    const { counts, imported } = mergeBaselineCounts({
      baseline: { counts: { "smoke-web": 350 } },
      results: [
        { id: "rust-test", status: "passed", counts: { total: 143, passed: 143, failed: 0 } },
        { id: "smoke-web", status: "passed", counts: { total: 350 } },
      ],
      gates,
    });
    expect(counts).toEqual({ "smoke-web": 350, "rust-test": 143 });
    expect(imported.find((i) => i.id === "rust-test")).toMatchObject({ total: 143, before: undefined, enforced: false, changed: true });
    expect(imported.find((i) => i.id === "smoke-web")).toMatchObject({ before: 350, enforced: true, changed: false });
  });

  it("无 counters 的门禁、缺读数的门禁、注册表里没有的 id → 一律不写，并说明原因", () => {
    const { counts, unusable } = mergeBaselineCounts({
      baseline: { counts: {} },
      results: [
        { id: "tsc", status: "passed", counts: { total: 1 } },
        { id: "rust-test", status: "failed", counts: null },
        { id: "ghost", status: "passed", counts: { total: 9 } },
      ],
      gates,
    });
    expect(counts).toEqual({});
    expect(unusable.map((u) => u.id)).toEqual(["tsc", "rust-test", "ghost"]);
  });

  it("只写读数值，**不**擅自建立/取消 baseline 契约（enforced 仅作提示）", () => {
    const { counts, imported } = mergeBaselineCounts({
      baseline: { counts: {}, gates: { rust: ["rust-test"] } },
      results: [{ id: "rust-test", status: "passed", counts: { total: 143 } }],
      gates,
    });
    expect(counts["rust-test"]).toBe(143);
    expect(imported[0].enforced).toBe(false); // 契约仍在注册表里，由人决定
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

  it("**门禁自报跳过**要进报告：绿的门禁也可能少跑了几条（`extractSkips`）", () => {
    const out = [
      "  ✓ 三条都跑到了",
      "  ⏭ Linux deb 实查：本机没有 dpkg ⇒ 未实查",
      "  ! 没找到插件入口（界面文案可能变了），跳过这一项",
      "  · 注释里出现「跳过」两个字不该被当成跳过（行首标记才认）",
      "  详情：这一行中间有跳过但不是判据",
    ].join("\n");
    const skips = extractSkips(out);
    // 只认行首标记 ⇒ 后两行不该进来（否则报告里全是噪声，等于没报）
    expect(skips).toHaveLength(2);
    expect(skips[0]).toContain("未实查");
    expect(skips[1]).toContain("跳过这一项");
    // 空输出 ⇒ 空数组（不是 null/undefined：下游要能 `.length`）
    expect(extractSkips("")).toEqual([]);
  });

  it("自报跳过会出现在 markdown 摘要里（否则它只活在 JSON 里，没人看）", () => {
    const md = markdownReport({
      ...base,
      results: [{ ...base.results[0], skips: ["⏭ 依赖缺失，跳过这一项"] }],
    });
    expect(md).toContain("门禁自报跳过");
    expect(md).toContain("依赖缺失");
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

// cargo 形态的失败行必须被认出来（2026-09-19 加）：rust 组红了以后，报告与 CI 注解里
// **一条失败明细都没有**，只能看到 "failed(101)" —— 而日志要 admin 权限，那是唯一的证据通道。
describe("extractFailures：cargo 的失败形态", () => {
  it("`test a::b ... FAILED` 与 panic 首行都要认（不能只认 ✗/FAIL 开头）", () => {
    const out = extractFailures(
      [
        "   Compiling shuyonote v1.91.3",
        "test plugins::tests::foo ... ok",
        "test plugins::tests::bar ... FAILED",
        "",
        "---- plugins::tests::bar stdout ----",
        "thread 'plugins::tests::bar' panicked at src/plugins.rs:1:1:",
        "assertion failed",
      ].join("\n"),
    );
    expect(out.join(" | ")).toContain("test plugins::tests::bar ... FAILED");
    expect(out.join(" | ")).toContain("panicked at");
    expect(out).not.toContain("test plugins::tests::foo ... ok");
  });

  it("outputTail 只留尾巴且有上限（不能把整份日志塞进报告）", () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const t = outputTail(long, { maxLines: 5, maxChars: 30 });
    expect(t).toContain("line 199");
    expect(t.length).toBeLessThanOrEqual(31); // 30 + 省略号
  });
});
