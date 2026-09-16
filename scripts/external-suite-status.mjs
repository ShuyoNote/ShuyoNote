// 外部套件状态回写：把"不在本仓库跑"的回归结果写进 tests/external-suites.json。
//
// 为什么需要它（P1 的另一半）：`sync-regression` / `sync-collab-regression` 需要真实同步服务端，
// 跑在**私有**服务端仓库的 CI 里；客户端仓库只登记"它存在、跑在别处"。此前那个 status 字段
// 是**手写**的，于是它必然腐烂（要么一直是"见服务端 CI"，要么写着早就不成立的好话）。
// 这个脚本给它一条机器可走的路：服务端 CI 跑完 → 回写 → 对公开仓库开 PR。
// 汇总摘要里会带上这张表，读者因此能区分"跑了且通过"与"没人跑过"。
//
// 用法：
//   node scripts/external-suite-status.mjs --suite sync-regression --status passed \
//        --evidence "服务端 CI run #42" --commit abc1234
//   node scripts/external-suite-status.mjs --suite sync-collab-regression --status failed --evidence "run #43"
//   node scripts/external-suite-status.mjs --list          # 看有哪些套件 id
//   node scripts/external-suite-status.mjs ... --dry-run   # 只打印结果，不写文件
//
// `--status` 只接受 passed / failed / unknown（unknown 用于"跑了但结果不明"，别写 passed 糊过去）。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { upsertSuiteStatus } from "./lib/report-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] || "" : "";
};

const file = resolve(root, argValue("--file") || "tests/external-suites.json");
if (!existsSync(file)) {
  console.error(`找不到 ${file}`);
  process.exit(2);
}
const doc = JSON.parse(readFileSync(file, "utf8"));
const suites = Array.isArray(doc.suites) ? doc.suites : [];

if (argv.includes("--list")) {
  for (const s of suites) console.log(`${String(s.id || "(无 id)").padEnd(24)} ${s.name}\n    跑在：${s.where}\n    现状：${s.status}`);
  process.exit(0);
}

const id = argValue("--suite");
const status = argValue("--status");
const evidence = argValue("--evidence");
const commit = argValue("--commit");
const DRY = argv.includes("--dry-run");

if (!id || !status) {
  console.error("用法：node scripts/external-suite-status.mjs --suite <id> --status passed|failed|unknown [--evidence 文本] [--commit sha] [--dry-run]");
  console.error("      加 --list 看现有套件 id。");
  process.exit(2);
}
if (!["passed", "failed", "unknown"].includes(status)) {
  console.error(`--status 只接受 passed / failed / unknown，收到：${status}`);
  process.exit(2);
}

const { suites: next, found } = upsertSuiteStatus(suites, { id, status, evidence, commit });
if (!found) {
  console.error(`没有 id 为 \`${id}\` 的套件（用 --list 看现有 id）。`);
  process.exit(1);
}

const updated = next.find((s) => s.id === id);
if (DRY) {
  console.log(`[dry-run] ${id} → ${updated.status}`);
  process.exit(0);
}

writeFileSync(file, JSON.stringify({ ...doc, suites: next }, null, 2) + "\n");
console.log(`${file} 已更新：${id} → ${updated.status}`);
console.log("下一步：对公开仓库开 PR（这条回写路径写在 docs/TESTING.md 的「覆盖边界」一节）。");
