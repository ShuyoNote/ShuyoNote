#!/usr/bin/env node
// ⭐ §13.12 **Phase 0 基线**的**执行者**（工具，⛔ 不是门禁 —— 故意不叫 `check-*`、不注册进 `scripts/lib/gates.mjs`）：
// 读一份或多份 dev 日志，把里面的 `[sync-metrics]` 行汇总成基线读数（p50/p95/恢复/缺口）。
//
// ## 口径（与 `scripts/lib/syncBaseline.mjs` 的文件头同一套）
// · **只读**：不发包、不建连接、不写库；被读的日志是应用自己打的（`_tmp/scratch/dev-*.log.err`）。
// · **脱敏**：报告里只有「空间 N / 对端 N」与计数，⛔ 不打印空间哈希、设备号、文件路径。
// · **没量到 ≠ 通过**：一行都没解析出来 ⇒ 退 **2**（与仓内「环境不具备/没查过」同一档）。
//
// ## 用法
//   node scripts/measure-sync-baseline.mjs --log C:\path\dev-20261114.log.err
//   node scripts/measure-sync-baseline.mjs --log a.log.err b.log.err --json
//   node scripts/measure-sync-baseline.mjs --log x.log.err --max-lines 200000   # 只扫前 N 行（大文件试跑）
//
// 退出码：0 量到 ／ 1 用法错或文件读不到 ／ 2 没量到（**不算通过**）

import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";

import {
  formatBaselineReport,
  parseLatencyLine,
  parseMetricsLine,
  parsePeerErrClassLine,
  parsePeerSkipLine,
  parseRoundTimingLine,
  summarizeMetrics,
} from "./lib/syncBaseline.mjs";

function usage() {
  return [
    "Phase 0 基线（只读日志，不改行为）",
    "",
    "用法：node scripts/measure-sync-baseline.mjs --log <日志文件> [更多日志…] [--json] [--max-lines N]",
    "",
    "说明：",
    "  · 日志由应用自己打（每轮一行 [sync-metrics] … ms=…）；本工具只读它。",
    "  · 报告脱敏：只有「空间 N / 对端 N」与计数。",
    "  · 一行都没量到 ⇒ 退出码 2（没查过 ≠ 通过）。",
  ].join("\n");
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {string[]} */
  const logs = [];
  let json = false;
  let maxLines = 0;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--json") json = true;
    else if (a === "--log") {
      // `--log a b c`：一直吃到下一个以 `--` 开头的参数
      let j = i + 1;
      while (j < argv.length && !argv[j].startsWith("--")) {
        logs.push(argv[j]);
        j += 1;
      }
      if (j === i + 1) throw new Error("--log 后面没给文件");
      i = j - 1;
    } else if (a === "--max-lines") {
      const n = Number(argv[i + 1]);
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error("--max-lines 需要一个正整数");
      maxLines = n;
      i += 1;
    } else if (a.startsWith("--")) {
      throw new Error(`不认识的参数：${a}`);
    } else {
      logs.push(a);
    }
  }
  return { logs, json, maxLines, help };
}

/**
 * 流式扫一份日志：返回解析出的行 ＋ 看着像但形状不对的行数（⛔ 不静默吞掉）。
 * @param {string} file
 * @param {number} maxLines
 */
async function scanFile(file, maxLines) {
  /** @type {import("./lib/syncBaseline.mjs").MetricRow[]} */
  const rows = [];
  /** @type {{seg: string, ms: number}[]} */
  const latencies = [];
  /** @type {{space: string, ok: boolean, ms: number}[]} */
  const roundRows = [];
  /** @type {{failed: number}[]} ⭐ F3（2026-11-20）：被跳过的事件（按空间） */
  const skipRows = [];
  /** @type {{skip: boolean, kinds: number}[]} ⭐ F3：错误分类行 */
  const errRows = [];
  let suspicious = 0;
  let seen = 0;
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    seen += 1;
    if (maxLines > 0 && seen > maxLines) break;
    if (line.includes("[sync-metrics]")) {
      const row = parseMetricsLine(line);
      if (row) rows.push(row);
      else suspicious += 1;
      continue;
    }
    // ⭐ §13.12 埋点两段（同一份日志里混着；⛔ 与轮次读数是两回事）
    if (line.includes("[sync-latency]")) {
      const seg = parseLatencyLine(line);
      if (seg) latencies.push(seg);
      else suspicious += 1;
      continue;
    }
    // ⭐ F3 Phase 0：逐空间耗时（同一 debug 开关；⛔ 与 [sync-metrics] 不是同一条口径）
    if (line.includes("[round-timing]")) {
      const rt = parseRoundTimingLine(line);
      if (rt) roundRows.push(rt);
      else suspicious += 1;
      continue;
    }
    // ⭐ F3（2026-11-20）：失败面两条 —— 「被跳过」与「错误分类」（⛔ 只量不改行为）
    if (line.includes("[peer-skip]")) {
      const sk = parsePeerSkipLine(line);
      if (sk) skipRows.push(sk);
      else suspicious += 1;
      continue;
    }
    if (line.includes("[peer-err-class]")) {
      const ec = parsePeerErrClassLine(line);
      if (ec) errRows.push(ec);
      else suspicious += 1;
    }
  }
  return { rows, latencies, roundRows, skipRows, errRows, suspicious };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`用法错：${e instanceof Error ? e.message : String(e)}`);
    console.error(usage());
    return 1;
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.logs.length === 0) {
    console.error("没给日志文件（--log <文件>）。");
    console.error(usage());
    return 1;
  }
  const missing = args.logs.filter((f) => !existsSync(f) || !statSync(f).isFile());
  if (missing.length > 0) {
    // ⚠️ 路径是调用方给的、不是秘密；但报告里不打印路径（口径统一）。
    console.error(`读不到 ${missing.length} 份日志（路径不给打印；请自己核对）。`);
    return 1;
  }

  /** @type {import("./lib/syncBaseline.mjs").MetricRow[]} */
  const all = [];
  /** @type {{seg: string, ms: number}[]} */
  const latencies = [];
  /** @type {{space: string, ok: boolean, ms: number}[]} */
  const roundRows = [];
  /** @type {{failed: number}[]} ⭐ F3（2026-11-20）：被跳过的事件（按空间） */
  const skipRows = [];
  /** @type {{skip: boolean, kinds: number}[]} ⭐ F3：错误分类行 */
  const errRows = [];
  let suspicious = 0;
  for (const file of args.logs) {
    const {
      rows,
      latencies: segs,
      roundRows: rts,
      skipRows: sks,
      errRows: ers,
      suspicious: bad,
    } = await scanFile(file, args.maxLines);
    all.push(...rows);
    latencies.push(...segs);
    roundRows.push(...rts);
    skipRows.push(...sks);
    errRows.push(...ers);
    suspicious += bad;
  }

  const summary = summarizeMetrics(all, suspicious, latencies, roundRows, skipRows, errRows);
  if (args.json) {
    // ⛔ 不输出原始 id：这里只给数字与编号标签。
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatBaselineReport(summary));
    console.log("", `本次扫了 ${args.logs.length} 份日志${args.maxLines > 0 ? `（每份只扫前 ${args.maxLines} 行）` : ""}。`);
  }
  // 没量到 ⇒ 2（没查过 ≠ 通过；与仓内其它工具同一档）
  return summary.rounds === 0 ? 2 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`跑挂了：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
