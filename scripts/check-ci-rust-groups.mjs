#!/usr/bin/env node
// ⭐ **2026-11-21（owner 拍「补一条机器判据」）**：CI 的两份 `--only` 名单**并集**必须等于注册表里的 rust 组。
//
// 挡的是什么（这条门禁自己的来由，逐字记）：
//   2026-11-21 为了把 rust 线从"1 个 39.1 分钟的串行 job"拆成"2 个并行 job"，
//   `ci.yml` 里出现**两份** `--only` 名单（各跑 rust 组的一部分）。
//   ⇒ 那天起，"往 rust 组加一条门禁"变成**要改两处**：只改一处 ⇒ 那条门禁**没有任何 job 跑它**，
//     而 CI 会**全绿**（"拆完没人跑"的假绿 —— 与本仓历史上 `mobile-views`、`check-hook-order`
//     "只挂在 build 链上"那两次是同一族事故）。
//   拆 job 的那一轮只有 4 处注释在提醒（注释不是判据）⇒ 本条把它变成机器判据。
//
// 判据（三条，缺一不可）：
//   ① `ci.yml` 里每一份 `--only <ids>` 的 id 都必须在注册表里**存在**（拼错/改名后残留 ⇒ 红）；
//   ② 所有 `--only` 的**并集**必须**覆盖** rust 组的每一个 id（漏一条 ⇒ 红，并点名是谁）；
//   ③ rust 组的 id **不许**出现在 union 之外（等价于 ①在 rust 子集上的说法，但点名更清楚）。
//   ⚠️ 只判 **rust 组**：其它组没有拆 job，仍是整组跑 ⇒ 它们不需要这条。
//
// 退出码：0 通过 ／ 1 有发现 ／ 2 读不到（不算通过）。
// 用法：`node scripts/check-ci-rust-groups.mjs`（本机/CI 都能跑；纯 Node、不联网）。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GATES } from "./lib/gates.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const CI = join(root, ".github", "workflows", "ci.yml");

let raw;
try {
  raw = readFileSync(CI, "utf8");
} catch (e) {
  console.error(`读不到 ${CI}：${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

const rustIds = GATES.filter((g) => g.group === "rust").map((g) => g.id);
if (rustIds.length === 0) {
  console.error("注册表里 rust 组是空的 —— 扫描器/注册表坏了（⛔ 不算通过）");
  process.exit(2);
}

// 收集所有 `--only a,b,c`（允许跨行 `>-` 折叠后的同一行）
const lists = [...raw.matchAll(/--only\s+([a-z0-9,\-]+)/g)].map((m) =>
  m[1]
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean),
);
if (lists.length === 0) {
  // 没有 --only ⇒ 说明回到"整组跑"的形态，那本身是对的（不需要这条判据约束）
  console.log("没找到任何 `--only` 名单（CI 是整组跑）⇒ 本条无事可做 ✓");
  process.exit(0);
}

const all = GATES.map((g) => g.id);
const union = [...new Set(lists.flat())];
const problems = [];

// ① 名单里的 id 必须存在
for (const id of union) {
  if (!all.includes(id)) problems.push(`` + `\`${id}\` 不在注册表里（拼错/改名残留？）`);
}
// ② 并集要覆盖 rust 组
const missing = rustIds.filter((id) => !union.includes(id));
for (const id of missing) {
  problems.push(`rust 门禁 \`${id}\` **没有任何 job 跑它**（两份 --only 都没写）`);
}
// ③ rust id 不许在 union 之外（与 ② 等价，但把"多写了非 rust 的"也点出来）
const extra = union.filter((id) => {
  const g = GATES.find((x) => x.id === id);
  return g && g.group !== "rust";
});
for (const id of extra) {
  problems.push(`\`${id}\` 不是 rust 组的门禁，却被写进了 rust 的 --only 名单（跑错 job？）`);
}

const head =
  `CI 的 --only 名单 ${lists.length} 份（${lists.map((l) => l.length).join("+")}=${lists.flat().length} 条）` +
  ` ｜ rust 组 ${rustIds.length} 条`;

if (problems.length === 0) {
  console.log(`${head} ⇒ 并集相等、无未知 id ✓`);
  console.log(
    `  （提醒：往 rust 组加门禁时，**两份** --only 都要改 —— 改漏了本条会红，这就是它的用处）`,
  );
  process.exit(0);
}

console.error(`${head} ⇒ ❌ ${problems.length} 处不一致：`);
for (const p of problems) console.error(`  - ${p}`);
  console.error('  怎么修：在 .github/workflows/ci.yml 的两份 --only 里按「哪条该在哪个 job」补/删；');
  console.error('  哪条属于国密那条线见注释里的分工表（sm-library 相关 ⇒ rust-gm-wiring；其余 ⇒ rust-tests）。');
process.exit(1);
