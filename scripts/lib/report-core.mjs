// 回归汇总器的**纯逻辑**（无 IO、无副作用）——单独一个文件是为了能被单测覆盖。
//
// 为什么把它抽出来：scripts/test-report.mjs 是"门禁的执行者"，它自己却长期没有测试。
// 而我们已经在它身上踩过一次真实事故：早先用裸 `(\d+)/(\d+)` 兜底解析汇总读数，
// 结果把 `check-plugin-hosting.mjs` 里的进度数字当成"2280/4560 断言"贴进了公开的汇总表
// ——**假数字比没有数字更糟**。这类解析/判定逻辑必须能被字符串级的单测钉死。
//
// 覆盖：scripts/lib/report-core.test.mjs

// 仓库里两种既有的汇总格式（其余一律返回 null，绝不让无关数字冒充断言数）。
//   1) `[结果] N 通过 / M 失败`  —— check-panel-layout / verify-mobile-* / check-pdf-reload …
//   2) `N passed, M failed`      —— scripts/smoke-web.mjs
const ZH_RESULT = /(\d+)\s*通过\s*\/\s*(\d+)\s*失败/;
const EN_RESULT = /(\d+)\s*passed,\s*(\d+)\s*failed/i;

export function countsFromOutput(output) {
  const zh = ZH_RESULT.exec(output || "");
  if (zh) return { passed: Number(zh[1]), failed: Number(zh[2]), total: Number(zh[1]) + Number(zh[2]) };
  const en = EN_RESULT.exec(output || "");
  if (en) return { passed: Number(en[1]), failed: Number(en[2]), total: Number(en[1]) + Number(en[2]) };
  return null;
}

export function countsFromVitestJson(j) {
  if (!j || typeof j !== "object") return null;
  if (typeof j.numTotalTests !== "number") return null;
  return {
    total: j.numTotalTests,
    passed: typeof j.numPassedTests === "number" ? j.numPassedTests : null,
    failed: typeof j.numFailedTests === "number" ? j.numFailedTests : null,
  };
}

export function countsFromSmokeJson(j) {
  if (!j || typeof j !== "object") return null;
  if (typeof j.total !== "number") return null;
  return {
    total: j.total,
    passed: typeof j.passed === "number" ? j.passed : null,
    failed: typeof j.failed === "number" ? j.failed : null,
  };
}

// cargo test 的汇总行是**每个测试二进制一行**：
//   `test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out`
// 一个门禁（如 `cargo test` 全量）会打印好几行（lib 测试 / 集成测试 / 文档测试），
// 所以这里必须**求和**，只取第一行会把 Rust 侧的读数算少一大截。
export function countsFromCargoOutput(output) {
  const re = /test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/g;
  let passed = 0;
  let failed = 0;
  let seen = false;
  for (const m of (output || "").matchAll(re)) {
    seen = true;
    passed += Number(m[1]);
    failed += Number(m[2]);
  }
  return seen ? { passed, failed, total: passed + failed } : null;
}

// gate.counters 决定读数来源；`auto`（或未声明）走文本兜底。
// readJson(name) 由调用方注入（脚本里读临时文件，单测里给假数据）。
export function countsForGate(gate, output, readJson) {
  if (gate.counters === "vitest") return countsFromVitestJson(readJson ? readJson("vitest.json") : null);
  if (gate.counters === "smoke-web") return countsFromSmokeJson(readJson ? readJson("smoke-web.json") : null);
  if (gate.counters === "cargo") return countsFromCargoOutput(output);
  return countsFromOutput(output);
}

// 失败明细：只在输出里找"明确的失败行"，最多留 25 条（够定位，不至于把报告撑爆）。
export function extractFailures(output) {
  const out = [];
  for (const line of (output || "").split(/\r?\n/)) {
    if (/^\s*(\u2717|✗|FAIL|not ok)/.test(line)) out.push(line.trim());
  }
  return out.slice(0, 25);
}

// 基线违规：两类，都是"静默退化"——本文件存在的意义就是把它们变成红灯。
//   1) 有读数的门禁低于基线（只增不减是硬约束）
//   2) 标了 baseline 却读不到数（基线名存实亡）
//   3) 注册表里少了一条已登记的门禁（被顺手删掉 / 改名）
export function baselineViolations({ results, baseline, currentGates, updateBaseline }) {
  if (updateBaseline) return [];
  const out = [];
  for (const r of results) {
    if (!r.baseline || r.status !== "passed") continue;
    const expected = baseline.counts?.[r.id];
    const actual = r.counts?.total;
    if (typeof expected !== "number") {
      out.push(`\`${r.id}\` 在注册表里标了 baseline，但 tests/baseline.json 没有对应读数（跑 --update-baseline 建立）`);
      continue;
    }
    // 通过了却读不到读数：说明**解析链断了**（门禁改了自己的汇总输出格式、或 JSON 报告没落盘）。
    // 这类退化最危险——表面全绿，实际上"只增不减"已经不再生效。必须吵出来。
    if (typeof actual !== "number") {
      out.push(`\`${r.id}\` 这次通过但**没有解析出读数**——读数解析可能坏了（门禁改了汇总输出格式？），基线校验对它已失效`);
      continue;
    }
    if (actual < expected) {
      out.push(
        `\`${r.id}\` 断言/用例数从 ${expected} 降到 ${actual}——"只增不减"是硬约束；确需减少请在 PR 里说明并跑 --update-baseline`,
      );
    }
  }
  if (!baseline.gates) return out;
  const byGroup = {};
  for (const gate of currentGates) (byGroup[gate.group] ||= []).push(gate.id);
  for (const [group, ids] of Object.entries(baseline.gates)) {
    const now = byGroup[group] || [];
    const missing = ids.filter((id) => !now.includes(id));
    if (missing.length) {
      out.push(`分组 \`${group}\` 少了门禁：${missing.join(", ")}（被删了？改名前请同步 tests/baseline.json）`);
    }
  }
  return out;
}

// 机器生成的一行汇总（P2：消除"手抄断言数"带来的漂移）。
// 用途：发版说明 / CHANGELOG 里需要"门禁全绿：… 702 用例 …"这类句子时**复制它**，
// 而不是人肉从终端里抄——抄错的数字会在下一次改动后变成假话，而且没人会发现。
export function summaryLine(report) {
  const byGroup = {};
  for (const r of report.results) {
    const g = (byGroup[r.group] ||= { gates: 0, passed: 0, counts: 0, failed: 0 });
    g.gates += 1;
    if (r.status === "passed") g.passed += 1;
    if (r.status === "failed") g.failed += 1;
    if (r.counts && typeof r.counts.total === "number") g.counts += r.counts.total;
  }
  const parts = Object.entries(byGroup).map(([group, g]) => {
    const counts = g.counts ? `/${g.counts} 断言` : "";
    return `${group} ${g.passed}/${g.gates}${counts}`;
  });
  const verdict = report.ok ? "门禁全绿" : "门禁存在失败";
  const totalCounts = report.results.reduce((a, r) => a + (r.counts?.total || 0), 0);
  const skipped = report.results.filter((r) => r.status === "skipped").length;
  return `${verdict}：${parts.join("、")}；合计 ${totalCounts} 条断言/用例${skipped ? `（${skipped} 条显式跳过）` : ""}。`;
}

// 外部套件状态的回写（P1：让"不在本仓库跑的套件"在公开侧可见且**可更新**）。
// 纯函数：只做数据变换，文件读写在 scripts/external-suite-status.mjs 里。
// 服务端仓库 CI 跑完 → 调那个脚本写回 → 对公开仓库开 PR（路径与命令写在 docs/TESTING.md）。
const STATUS_LABEL = { passed: "通过", failed: "失败", unknown: "状态未知" };

export function upsertSuiteStatus(suites, patch) {
  const idx = suites.findIndex((s) => s.id === patch.id);
  if (idx < 0) return { suites, found: false };
  const at = patch.at || new Date().toISOString();
  const bits = [at];
  if (patch.commit) bits.push(`commit ${patch.commit}`);
  if (patch.evidence) bits.push(patch.evidence);
  const next = suites.slice();
  next[idx] = {
    ...suites[idx],
    lastStatus: patch.status,
    lastRunAt: at,
    ...(patch.commit ? { lastCommit: patch.commit } : {}),
    ...(patch.evidence ? { lastEvidence: patch.evidence } : {}),
    status: `${STATUS_LABEL[patch.status] || patch.status}（${bits.join("，")}）`,
  };
  return { suites: next, found: true };
}

// CHANGELOG 里的门禁数字校验（P2：消除"手抄断言数"的漂移）。
//
// 为什么只做**最窄**的一条规则：CHANGELOG 的历史段落里那些数字（"607 条单测"）是在描述
// **当时那次发布**的状态，硬校验必然误报——一个会误报的门禁很快就会被绕过，等于没有。
// 所以这里的判定极保守，只有同时满足才比较：
//   1. 只看**最新一段**（Unreleased 或最顶版本段），历史段落一律不碰；
//   2. 该行必须**恰好提到一个**已知套件名，且**恰好含一个**数字（多个/零个都跳过）；
//   3. 行内出现 `历史` / `此前` / `曾` / `豁免` 等标记时跳过（允许显式豁免）。
// 宁可漏判（数字仍然是手抄的），也不要误报。
const SUITE_ALIASES = [
  ["smoke-web", "smoke-web"],
  ["vitest", "vitest"],
  ["单测", "vitest"],
  ["用例", "vitest"],
  ["mobile-overlays", "mobile-overlays"],
  ["mobile-layout", "mobile-layout"],
  ["check-panel-layout", "check-panel-layout"],
  ["check-pdf-reload", "check-pdf-reload"],
  ["check-web-build", "check-web-build"],
];

const EXEMPT_MARKERS = ["历史", "此前", "曾", "豁免"];

export function changelogNumberMismatches(sectionText, counts) {
  const out = [];
  for (const raw of (sectionText || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || EXEMPT_MARKERS.some((m) => line.includes(m))) continue;
    const suites = [...new Set(SUITE_ALIASES.filter(([alias]) => line.includes(alias)).map(([, key]) => key))];
    if (suites.length !== 1) continue; // 零个：这行没谈门禁数字；多个：说不清对应谁
    const nums = [...line.matchAll(/(?<![\d.])(\d{2,5})(?![\d.])/g)].map((m) => Number(m[1]));
    if (nums.length !== 1) continue; // 日期、多组数字等一律跳过
    const key = suites[0];
    const expected = counts?.[key];
    if (typeof expected !== "number") continue;
    if (nums[0] !== expected) out.push({ line, suite: key, found: nums[0], expected });
  }
  return out;
}

// 把**别处跑出来的报告**（CI artifact）里的读数并进基线。
//
// 用途：rust 组只在 Linux CI 上有可信读数（本机 Windows 上测试二进制加载期就异常退出，
// 见 docs/TESTING.md 的"已知边界"）。于是流程是：CI 出报告 → 下载 → 一条命令并入。
// 语义边界（重要，别混）：
//   · baseline.json 的 `counts` 是**读数值**；
//   · 注册表的 `baseline: true` 是**契约**（"这条必须有读数，缺了就是违规"）。
//   本函数只写读数值，不擅自改契约——是否需要把某条纳入契约由人显式决定（返回 enforced 供提示）。
export function mergeBaselineCounts({ baseline, results, gates }) {
  const byId = new Map(gates.map((g) => [g.id, g]));
  const counts = { ...(baseline.counts || {}) };
  const imported = [];
  const unusable = [];
  for (const r of results || []) {
    const gate = byId.get(r.id);
    if (!gate) {
      unusable.push({ id: r.id, why: "注册表里没有这条门禁（改名了？）" });
      continue;
    }
    if (!gate.counters) {
      unusable.push({ id: r.id, why: "注册表未声明 counters，读数不可信" });
      continue;
    }
    const total = r.counts?.total;
    if (typeof total !== "number") {
      unusable.push({ id: r.id, why: `报告里没有读数（status=${r.status}）` });
      continue;
    }
    const before = counts[r.id];
    counts[r.id] = total;
    imported.push({ id: r.id, total, before, status: r.status, enforced: gate.baseline === true, changed: before !== total });
  }
  return { counts, imported, unusable };
}

export function markdownReport(report) {  const lines = [];
  lines.push(`## 回归门禁汇总（${report.groups.join(" + ") || "按 id 选择"}）`);
  lines.push("");
  lines.push("| 门禁 | 结果 | 断言 / 用例 | 耗时 |");
  lines.push("| --- | --- | --- | --- |");
  for (const r of report.results) {
    const icon = r.status === "passed" ? "✅" : r.status === "failed" ? "❌" : "⏭️";
    const counts =
      r.counts && typeof r.counts.total === "number"
        ? `${r.counts.passed ?? "?"} / ${r.counts.total}${r.counts.failed ? `（失败 ${r.counts.failed}）` : ""}`
        : "—";
    const retry = r.attempts > 1 ? `（第 ${r.attempts} 次才过）` : "";
    lines.push(
      `| ${icon} \`${r.id}\` ${r.label} | ${r.status}${retry} | ${counts} | ${(r.durationMs / 1000).toFixed(1)}s |`,
    );
  }
  lines.push("");
  const failed = report.results.filter((r) => r.status === "failed");
  if (failed.length) {
    lines.push("### 失败明细");
    for (const r of failed) {
      lines.push(`- \`${r.id}\`${r.reason ? "：" + r.reason : ""}`);
      for (const f of r.failures || []) lines.push(`  - ${f}`);
    }
    lines.push("");
  }
  // 只在重试真的发生过时才出现——否则这一节会变成噪音，被读的人忽略。
  const retried = report.results.filter((r) => (r.attempts || 1) > 1);
  if (retried.length) {
    lines.push("### ⚠️ 靠重试才通过的（不算干净的绿）");
    for (const r of retried) lines.push(`- \`${r.id}\`：第 ${r.attempts} 次才通过（flake 信号，别让它烂在那里）`);
    lines.push("");
  }
  const skipped = report.results.filter((r) => r.status === "skipped");
  if (skipped.length) {
    lines.push("### 显式跳过（不是通过）");
    for (const r of skipped) lines.push(`- \`${r.id}\`：${r.reason}`);
    lines.push("");
  }
  if (report.baselineViolations.length) {
    lines.push("### 基线违规");
    for (const v of report.baselineViolations) lines.push(`- ${v}`);
    lines.push("");
  }
  if (report.externalSuites.length) {
    lines.push("### 外部执行（不在本仓库，公开侧只做可见性登记）");
    lines.push("");
    lines.push("| 套件 | 跑在哪 | 最近一次已知状态 |");
    lines.push("| --- | --- | --- |");
    for (const s of report.externalSuites) lines.push(`| ${s.name} | ${s.where} | ${s.status} |`);
    lines.push("");
  }
  lines.push("<!-- 这一行由 scripts/test-report.mjs 生成，可直接粘进发版说明 -->");
  lines.push(summaryLine(report));
  return lines.join("\n") + "\n";
}
