// 回归门禁的统一执行 / 汇总 / 基线校验。
//
// 为什么需要它（把「救火」变「防火」的后一半）：
//   1. 门禁此前散在 .github/workflows/ci.yml 的十几个 step 里：本地想复现一轮，只能照着
//      YAML 手抄命令，抄漏一条没人会发现——这是"本地绿、CI 红"的常见来源。
//   2. 结果只活在终端与 Actions UI：`N passed, M failed` 一闪而过，绿是**口头的**，
//      别人无法核验，也看不出断言数是在涨还是在悄悄减少。
//   3. 断言数"只增不减"此前只是文档里的纪律（117→…→350 记在计划文档里），没有机器校验：
//      删掉一条断言不会有任何东西变红。
//   本脚本把这三件事收在一处：同一份清单（scripts/lib/gates.mjs）既给本地 `pnpm verify`，
//   也给 CI；每条门禁跑完都产出可汇总的读数；tests/baseline.json 把纪律变成门禁。
//
// 用法：
//   node scripts/test-report.mjs                     # 默认组 contract,smoke,sync,plugin（纯 Node）
//   node scripts/test-report.mjs --group browser     # 追加需要真实 Chromium 的验收
//   node scripts/test-report.mjs --group mobile      # 需要先起 dev server（:5173）
//   node scripts/test-report.mjs --group rust --strict
//   node scripts/test-report.mjs --only smoke-web,vitest
//   node scripts/test-report.mjs --list              # 打印门禁清单（文档与自测都用它）
//   node scripts/test-report.mjs --json out.json --summary out.md
//   node scripts/test-report.mjs --update-baseline   # 把当前读数写回 tests/baseline.json
//
// 环境变量：
//   GITHUB_STEP_SUMMARY  —— 设置了就自动把 markdown 摘要追加上去（CI 里公开可见）
//   TEST_REPORT_STRICT=1 —— 等价于 --strict：被跳过的门禁按失败计

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GROUPS, GATES, GROUP_ORDER, gateSetOf } from "./lib/gates.mjs";
import { baselineNoteFor, baselineViolations, countsForGate, extractFailures, extractSkips, markdownReport, mergeBaselineCounts, outputTail, staleBaselineNotices, summaryLine } from "./lib/report-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = join(root, ".test-report-tmp");

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function argValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] || "" : "";
}
const LIST = argv.includes("--list");
const STRICT = argv.includes("--strict") || process.env.TEST_REPORT_STRICT === "1";
const UPDATE_BASELINE = argv.includes("--update-baseline");
// 只在**显式**给 `--retry N` 时才对标记 `flaky: true` 的门禁重试，且重试次数会写进报告
// （摘要里单独列一节"靠重试才通过的"）。CI 默认 0 次：**flake 要吵，不要被抹平**。
const RETRY = Number(argValue("--retry") || 0);
// 只额外打印一行机器生成的汇总（粘进发版说明 / CHANGELOG 用），不改变其它输出。
const LINE = argv.includes("--line");
const baselinePath = resolve(root, argValue("--baseline") || "tests/baseline.json");
const jsonPath = argValue("--json");
const summaryPath = argValue("--summary");
const only = argValue("--only").split(",").map((s) => s.trim()).filter(Boolean);
const groups = argValue("--group")
  ? argValue("--group").split(",").map((s) => s.trim()).filter(Boolean)
  : only.length
    ? []
    : DEFAULT_GROUPS;

if (LIST) {
  for (const g of GROUP_ORDER) {
    const inGroup = GATES.filter((x) => x.group === g);
    if (!inGroup.length) continue;
    console.log(`[${g}]${DEFAULT_GROUPS.includes(g) ? "（本地默认组）" : ""}`);
    for (const gate of inGroup) console.log(`  ${gate.id.padEnd(22)} ${gate.label}`);
  }
  process.exit(0);
}

// 从别处跑出来的报告（CI artifact）并入基线：**不跑任何门禁**，只写 tests/baseline.json。
// 典型用途：rust 组的**全量**读数只在 Linux CI 上有可信读数（Windows 本机可用
// scripts/win-cargo-test.ps1 跑 lib 目标，但 `plugins::` 那 34 条要真宿主进程；
// 见 docs/TESTING.md 的"已知边界"）。用法：
//   node scripts/test-report.mjs --baseline-from rust-report.json
const baselineFrom = argValue("--baseline-from");
if (baselineFrom) {
  const files = baselineFrom.split(",").map((s) => s.trim()).filter(Boolean);
  const imported = [];
  for (const f of files) {
    if (!existsSync(f)) {
      console.error(`找不到报告文件：${f}`);
      process.exit(2);
    }
    let j;
    try {
      j = JSON.parse(readFileSync(f, "utf8"));
    } catch (err) {
      console.error(`${f} 不是合法 JSON：${err.message}`);
      process.exit(2);
    }
    if (!Array.isArray(j.results)) {
      console.error(`${f} 不像 test-report 报告（缺 results 数组）`);
      process.exit(2);
    }
    imported.push(...j.results);
  }
  const base = readBaseline();
  const merged = mergeBaselineCounts({ baseline: base, results: imported, gates: GATES });
  writeFileSync(baselinePath, JSON.stringify({ ...base, counts: merged.counts }, null, 2) + "\n");
  console.log(`已并入 ${files.length} 份报告的读数 → ${baselinePath}`);
  for (const i of merged.imported) {
    const note = i.enforced
      ? "受基线契约保护"
      : "⚠️ 注册表里**未**标 baseline: true —— 读数已记下，但还不会被校验（要生效请在 scripts/lib/gates.mjs 补该字段）";
    const warn = i.status === "passed" ? "" : `  ⚠️ 该门禁本次 status=${i.status}：读数已并入，但请人工确认它可信`;
    console.log(`  ✓ ${i.id}: ${i.before ?? "(无)"} → ${i.total}  ${note}${warn}`);
  }
  for (const u of merged.unusable) console.log(`  ⏭ ${u.id}: 未并入 —— ${u.why}`);
  process.exit(0);
}

const unknownGroup = groups.find((g) => !GROUP_ORDER.includes(g));
if (unknownGroup) {
  console.error(`未知分组：${unknownGroup}（可选：${GROUP_ORDER.join(", ")}）`);
  process.exit(2);
}
const unknownGate = only.find((id) => !GATES.some((g) => g.id === id));
if (unknownGate) {
  console.error(`未知门禁：${unknownGate}（用 --list 看清单）`);
  process.exit(2);
}
const selected = only.length
  ? GATES.filter((g) => only.includes(g.id))
  : GATES.filter((g) => groups.includes(g.group));
if (!selected.length) {
  console.error("没有选中任何门禁——参数写错了？");
  process.exit(2);
}

mkdirSync(tmpDir, { recursive: true });

// 读数可能来自门禁自己落的 JSON（vitest / smoke-web）。这里只负责把文件读成对象；
// 解析与判定全在 scripts/lib/report-core.mjs（纯函数、有单测）。
function readTmpJson(name) {
  const p = join(tmpDir, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------
function runCommand(cmdline) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(cmdline, { cwd: root, shell: true, windowsHide: true });
    let output = "";
    const tee = (buf) => {
      const text = buf.toString("utf8");
      output += text;
      // 实时透传：CI 日志要能看见进度，而不是等全部跑完才刷出来。
      process.stdout.write(text);
    };
    child.stdout.on("data", tee);
    child.stderr.on("data", tee);
    child.on("error", (err) => {
      output += `\n[spawn error] ${err.message}\n`;
      resolvePromise({ status: "failed", code: -1, output, durationMs: Date.now() - started, cmdline });
    });
    child.on("close", (code) => {
      resolvePromise({
        status: code === 0 ? "passed" : "failed",
        code,
        output,
        durationMs: Date.now() - started,
        cmdline,
      });
    });
  });
}

// 插件作者 CLI：对 examples/plugins/* 逐个 validate。
// 用 JS 循环而不是 shell 的 `for …; do` ——Windows 上没有 bash，shell 循环会让本地（Windows）
// 与 CI（Linux）跑的**不是同一件事**（仓库里已有过同类教训：打包工具依赖命令行 `zip`，
// Windows 上红过三条）。
async function runPluginCliGate(gate) {
  const base = join(root, "examples", "plugins");
  let dirs = [];
  try {
    dirs = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return { ...gate, status: "failed", reason: `示例插件目录不存在：${base}`, durationMs: 0, counts: null, failures: [] };
  }
  const failed = [];
  let durationMs = 0;
  for (const name of dirs) {
    const r = await runCommand(`node scripts/plugin-cli.mjs validate examples/plugins/${name}`);
    durationMs += r.durationMs;
    if (r.status !== "passed") failed.push(name);
  }
  process.stdout.write(`  → 示例插件 ${dirs.length} 个，失败 ${failed.length} 个${failed.length ? "：" + failed.join(", ") : ""}\n`);
  return {
    ...gate,
    status: failed.length ? "failed" : "passed",
    durationMs,
    counts: { total: dirs.length, passed: dirs.length - failed.length, failed: failed.length },
    failures: failed,
  };
}

// 打包工具不许依赖命令行的 `zip`。
// 原先这条只写在 ci.yml 的 Linux `run:` 里（grep），于是 Windows 上根本没人挡——
// 而 Windows 上没有命令行 zip，那边 `pnpm test` 红过三条。搬到注册表后本地也能跑。
async function runNoSystemZipGate(gate) {
  const started = Date.now();
  const target = join(root, "scripts", "plugin-fragment.mjs");
  if (!existsSync(target)) {
    return { ...gate, status: "failed", reason: `找不到 ${target}`, durationMs: 0, counts: null, failures: [] };
  }
  const text = readFileSync(target, "utf8");
  const hit = /execFileSync\("zip"|execSync\("zip/.exec(text);
  if (hit) {
    const line = text.slice(0, hit.index).split("\n").length;
    process.stdout.write(`  ✗ plugin-fragment.mjs:${line} 又用命令行 zip 了——Windows 上没有它，请用 fflate\n`);
    return {
      ...gate,
      status: "failed",
      durationMs: Date.now() - started,
      counts: { total: 1, passed: 0, failed: 1 },
      failures: [`plugin-fragment.mjs:${line} 依赖命令行 zip`],
    };
  }
  process.stdout.write("  ✓ 打包工具没有依赖命令行 zip\n");
  return { ...gate, status: "passed", durationMs: Date.now() - started, counts: { total: 1, passed: 1, failed: 0 }, failures: [] };
}

async function runGate(gate) {
  process.stdout.write(`\n${"─".repeat(72)}\n▸ ${gate.id} — ${gate.label}\n${"─".repeat(72)}\n`);

  const missingEnv = (gate.requiresEnv || []).filter((k) => !process.env[k]);
  if (missingEnv.length) {
    const reason = `缺少环境变量 ${missingEnv.join(", ")}（需要先产出对应的真包 / fixture）`;
    process.stdout.write(`  ⏭ 跳过：${reason}\n`);
    return { ...gate, status: STRICT ? "failed" : "skipped", reason, durationMs: 0, counts: null, failures: [] };
  }

  if (gate.runner === "plugin-cli") return runPluginCliGate(gate);
  if (gate.runner === "no-system-zip") return runNoSystemZipGate(gate);

  // 重试只对**显式标记 `flaky: true`** 的门禁生效，而且一定要留下痕迹（报告里记 `attempts`）：
  // 静默重试会把真实的 flake 变成"看起来一直绿"，那比红更危险——红了才有人查。
  const maxAttempts = gate.flaky && RETRY > 0 ? RETRY + 1 : 1;
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await runGateOnce(gate);
    last.attempts = attempt;
    if (last.status === "passed") break;
    if (attempt < maxAttempts) {
      process.stdout.write(`  ↻ 第 ${attempt} 次未通过，重试（该门禁标记为 flaky；只有显式 --retry 时才重试）\n`);
    }
  }
  return last;
}

// 跑一次（可能由多条命令组成，如 `pnpm build:web` + `check-web-build`）：
// 任一条失败即整条门禁失败，且**不继续往下跑**——后续命令依赖前者的产物。

/**
 * 从门禁自己写下的**机器可读报告**里补出"哪几条用例红了"。
 *
 * 为什么需要（2026-09-17 实测）：`vitest` 门禁用的是 `--reporter=json --outputFile=…`，
 * **stdout 上没有 `✗ …` 那种行**可以解析 ⇒ `extractFailures(output)` 是空的 ⇒ 报告与 CI 注解
 * 都只能说得出"vitest 红了"，说不出是哪条用例 —— 而"哪条"正是唯一有用的信息。
 * 报告文件就在 tmp 目录里（这一次运行还没被清掉），读它即可。
 *
 * ⚠️ 只能在此处读：`test-report.mjs` 结尾会把整个 tmp 目录删掉，
 * 所以**事后**（例如 CI 里下一个步骤）再想读就已经没有了 —— 第一次写注解步骤时就踩了这个。
 */
function failedCasesFromJsonReport(gate, results) {
  const out = [];
  for (const r of results) {
    const m = /--outputFile=(\S+)/.exec(String(r.cmdline ?? ""));
    if (!m || !existsSync(m[1])) continue;
    let j;
    try {
      j = JSON.parse(readFileSync(m[1], "utf8"));
    } catch {
      continue;
    }
    for (const file of j.testResults ?? []) {
      for (const a of file.assertionResults ?? []) {
        if (a.status !== "failed") continue;
        const first = String((a.failureMessages ?? [])[0] ?? "").split("\n")[0].trim();
        out.push(`✗ ${(a.fullName || a.title || "?").trim()} 〔${String(file.name ?? "").split("/").slice(-2).join("/")}〕${first ? ` — ${first}` : ""}`);
      }
    }
  }
  return out;
}

async function runGateOnce(gate) {
  const cmds = Array.isArray(gate.cmd) ? gate.cmd : [gate.cmd];
  const results = [];
  let output = "";
  for (const raw of cmds) {
    const r = await runCommand(raw.replaceAll("{tmp}", tmpDir));
    results.push(r);
    output += r.output;
    if (r.status !== "passed") break;
  }
  return {
    ...gate,
    status: results.every((r) => r.status === "passed") ? "passed" : "failed",
    durationMs: results.reduce((a, r) => a + r.durationMs, 0),
    counts: countsForGate(gate, output, readTmpJson),
    // stdout 行 + 机器可读报告**取并集**：前者覆盖 "✗ …" 那种输出，后者覆盖 JSON reporter
    // （那种门禁的 stdout 里一条失败行都没有，见 failedCasesFromJsonReport 的注释）。
    failures: [...new Set([...extractFailures(output), ...failedCasesFromJsonReport(gate, results)])].slice(0, 25),
    // 门禁**自报跳过**的条目（绿也可能"少跑了几条"）：见 report-core 里 extractSkips 的注释。
    skips: extractSkips(output),
    // 失败时把输出尾巴也写进报告（CI 注解会带出去）：这一路吃过"红了但没有证据"的亏，
    // 而 cargo 这类门禁的失败明细不在 stdout 的 `✗` 行里、日志又要 admin 权限。
    outputTail: results.some((r) => r.status !== "passed") ? outputTail(output) : "",
    commands: results.map((r) => ({ cmdline: r.cmdline, status: r.status, code: r.code })),
  };
}

// 读数解析与汇总渲染都搬到了 scripts/lib/report-core.mjs（纯函数 + 单测）。
// 这里曾经有一版裸 `(\d+)/(\d+)` 兜底，把 check-plugin-hosting 的进度数字当成
// "2280/4560 断言"贴进了公开汇总表——那次事故的单测现在钉在 report-core.test.mjs 里。

// ---------------------------------------------------------------------------
// 基线（tests/baseline.json）：把"只增不减"和"门禁不得被删"变成机器校验
// ---------------------------------------------------------------------------
function readBaseline() {
  if (!existsSync(baselinePath)) return { note: "首次运行尚未建立基线", counts: {}, gates: {} };
  try {
    return JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (err) {
    console.error(`基线文件解析失败：${baselinePath} — ${err.message}`);
    process.exit(2);
  }
}

function readExternalSuites() {
  const p = join(root, "tests", "external-suites.json");
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(j.suites) ? j.suites : [];
  } catch {
    return [];
  }
}

function markdown(report) {
  return markdownReport(report);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const baseline = readBaseline();
const violations = [];
const results = [];
console.log(`回归门禁：${selected.length} 条（分组 ${groups.join(", ") || "按 id"}），工作目录 ${root}`);
const t0 = Date.now();
for (const gate of selected) {
  results.push(await runGate(gate));
}
const totalMs = Date.now() - t0;

// 基线校验（判定逻辑在 report-core.mjs，有单测）：只对**确实跑出读数**的门禁比较——
// 跳过的门禁既不算通过，也不算退步；`--update-baseline` 时不比较（这一次就是要重写它）。
violations.push(
  ...baselineViolations({ results, baseline, currentGates: GATES, updateBaseline: UPDATE_BASELINE }),
);

// 基线**太旧**的提示（不是失败）：见 `staleBaselineNotices` 的注释 ——
// 「读数下降」红、「下界太旧」只提示，两件事的后果不同，别混成一条。
const baselineNotices = UPDATE_BASELINE ? [] : staleBaselineNotices({ results, baseline });

// 写基线：只记**这次真正跑出来**的读数（跳过的门禁不写，避免把 null 当基线）。
if (UPDATE_BASELINE) {
  const counts = { ...(baseline.counts || {}) };
  for (const r of results) {
    if (r.baseline && r.counts && typeof r.counts.total === "number" && r.status === "passed") counts[r.id] = r.counts.total;
  }
  writeFileSync(
    baselinePath,
    JSON.stringify(
      {
        // `note` 里累积着**手写的历史**（哪条门禁哪天加的、为什么加）⇒ 只更新读数，别动它。
        // 以前这里写死一段固定文案，于是每次抬基线都静默抹掉那段历史（见 report-core 的 baselineNoteFor）。
        note: baselineNoteFor(existsSync(baselinePath) ? baseline.note : ""),
        counts,
        gates: gateSetOf(GATES),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\n基线已更新：${baselinePath}`);
}

const report = {
  groups,
  selected: selected.map((g) => g.id),
  startedAt: new Date(t0).toISOString(),
  durationMs: totalMs,
  node: process.version,
  platform: process.platform,
  results: results.map((r) => ({
    id: r.id,
    group: r.group,
    label: r.label,
    status: r.status,
    reason: r.reason || "",
    counts: r.counts || null,
    failures: r.failures || [],
    // ⚠️ 显式列出来：报告对象是**逐字段**构造的，漏一个字段就等于那个信息不存在
    //（第一版就漏了它：`skips` 在结果里算了，却没进报告 ⇒ `--json` 里看不到）。
    skips: r.skips || [],
    incident: r.incident || "",
    durationMs: r.durationMs,
    attempts: r.attempts || 1,
    commands: r.commands || [],
  })),
  baselineViolations: violations,
  // 显式进报告：提示也要能在 `--json` 里被读到（否则"终端一闪而过"就等于不存在）
  baselineNotices,
  externalSuites: readExternalSuites(),
};
const failedCount = report.results.filter((r) => r.status === "failed").length;
const skippedCount = report.results.filter((r) => r.status === "skipped").length;
report.ok = failedCount === 0 && violations.length === 0;

console.log(`\n${"═".repeat(72)}\n回归门禁结果\n${"═".repeat(72)}`);
for (const r of report.results) {
  const icon = r.status === "passed" ? "✅" : r.status === "failed" ? "❌" : "⏭️ ";
  const counts = r.counts && typeof r.counts.total === "number" ? ` (${r.counts.passed ?? "?"}/${r.counts.total})` : "";
  console.log(`${icon} ${r.id.padEnd(22)} ${(r.durationMs / 1000).toFixed(1).padStart(6)}s${counts}`);
}
for (const v of violations) console.log(`❌ 基线：${v}`);
for (const n of baselineNotices) console.log(`! 基线提示：${n}`);
console.log(
  `\n${report.ok ? "全部通过" : "存在失败"}：${report.results.length} 条门禁，失败 ${failedCount} 条，跳过 ${skippedCount} 条，`
    + `总耗时 ${(totalMs / 1000).toFixed(1)}s`,
);

if (jsonPath) {
  const p = resolve(root, jsonPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(report, null, 2) + "\n");
  console.log(`报告 → ${p}`);
}
// 发版说明要用的那一行：机器生成，直接复制，不要人肉从终端里抄数字。
if (LINE) console.log(`\n${summaryLine(report)}`);
const md = markdown(report);
if (summaryPath) {
  const p = resolve(root, summaryPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, md);
  console.log(`摘要 → ${p}`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: "a" });
    console.log("摘要已追加到 $GITHUB_STEP_SUMMARY");
  } catch (err) {
    console.log(`写入 GITHUB_STEP_SUMMARY 失败（忽略）：${err.message}`);
  }
}

try {
  rmSync(tmpDir, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

process.exit(report.ok ? 0 : 1);
