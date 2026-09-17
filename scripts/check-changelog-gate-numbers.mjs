// CHANGELOG 门禁数字门禁：最新一段里**明确绑定到套件的数字**必须等于基线读数。
//
// 为什么需要它：发版说明里"门禁全绿：… 732 用例 …"这类句子一直靠人从终端里抄。
// 抄错的数字在下一次改动后就变成假话，而且**没人会发现**（它只是散文，不参与构建）。
// 现在有了 tests/baseline.json（机器读数），这类句子可以被机器核对。
//
// 为什么规则这么窄：历史段落里的数字是在描述**当时那次发布**的状态，硬校验必然误报；
// 一个会误报的门禁很快会被绕过，等于没有。判定规则与"为什么"写在
// `scripts/lib/report-core.mjs` 的 `changelogNumberMismatches`（有单测）。
//
// 用法：node scripts/check-changelog-gate-numbers.mjs   （有不一致即非零退出）
//       数字请用 `node scripts/test-report.mjs --line` 生成后粘贴，不要手抄。

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changelogNumberMismatches } from "./lib/report-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

// 最新一段：从首个 `## [` 到下一个 `## [` 之间（顶部按 Keep a Changelog 是 Unreleased）。
const first = changelog.search(/^## \[/m);
let section = "";
if (first >= 0) {
  const rest = changelog.slice(first + 1);
  const next = rest.search(/^## \[/m);
  section = next >= 0 ? rest.slice(0, next) : rest;
}

let counts = {};
try {
  counts = JSON.parse(readFileSync(join(root, "tests", "baseline.json"), "utf8")).counts || {};
} catch {
  console.error("读不到 tests/baseline.json 的 counts——先跑 `node scripts/test-report.mjs --update-baseline`。");
  process.exit(1);
}

const heading = (section.split(/\r?\n/)[0] || "(空)").trim();
const bad = changelogNumberMismatches(section, counts);

if (bad.length) {
  console.error(`CHANGELOG 最新段（${heading}）里的门禁数字与基线不一致 ${bad.length} 处：`);
  for (const b of bad) {
    console.error(`  · ${b.suite}：写的是 ${b.found}，基线是 ${b.expected}`);
    console.error(`      该行：${b.line.slice(0, 120)}`);
  }
  console.error("  修法：用 `node scripts/test-report.mjs --line` 生成数字后粘贴；");
  console.error("        若这行确实在讲历史（不是当前读数），在该行加 `历史` 字样或在行尾加 `<!-- 豁免 -->`。");
  process.exit(1);
}

console.log(`CHANGELOG 最新段（${heading}）的门禁数字与基线一致（或未提及具体数字）。`);
