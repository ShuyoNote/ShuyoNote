// 门禁：**文档里写死的机器事实，必须与代码一致**。
//
// ## 为什么需要它
// 门禁条数、能力条数、命令条数这三类数字，此前散在 `docs/TESTING.md` / `docs/SHUYONOTE_STATE.md` 里**靠人手抄**。
// 抄错的后果不是报错，而是"读文档的人照着做、做到一半发现文档是旧的"——本仓最反对的那种**静默漂移**。
// 所以这里把两件事变成断言：
//   A. **注册表里每条门禁都要在 `docs/TESTING.md` 里出现**（至少出现一次 `` `id` ``）
//      ⇒ 新加门禁不许"只进代码、不进文档"（本门禁上线当天就抓到 7 条漏写的）；
//   B. **`docs/TESTING.md` 里的「机器事实」块必须与代码逐字一致** —— 块里那行由本脚本按代码生成，
//      不一致时**直接把该替换的那一行打出来**（照抄即可，不用人肉算）。
//
// ## 事实从哪里来（**不重复实现**）
//   · 门禁清单/分组 → `scripts/lib/gates.mjs`（注册表本身）；
//   · 命令数（Rust / web / CommandMap）→ 跑 `scripts/check-web-commands.mjs` 并解析它自己的汇总行
//     （那三条计数只有一处实现，别在这里再数一遍）；
//   · 能力数 → 跑 `scripts/check-capabilities.mjs` 并解析它的汇总行。
//   上游门禁本身没过 ⇒ 这里**不猜**，直接红并说明"先修上游"。
//
// 用法：node scripts/check-doc-facts.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_GROUPS, GATES, GROUP_ORDER } from "./lib/gates.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const FACTS_BEGIN = "<!-- facts:begin -->";
const FACTS_END = "<!-- facts:end -->";
const FACTS_FILE = "docs/TESTING.md";

const failures = [];
const fail = (msg) => failures.push(msg);

function runNode(script) {
  try {
    return execFileSync("node", [script], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

// ---- A. 每条门禁都要在文档里出现 ----
const testing = read(FACTS_FILE);
for (const g of GATES) {
  if (!testing.includes(`\`${g.id}\``)) {
    fail(`${FACTS_FILE} 里没有提到门禁 \`${g.id}\`（${g.group} · ${g.label}）—— 新门禁不许只进代码不进文档`);
  }
}

// ---- B. 机器事实块 ----
if (!testing.includes(FACTS_BEGIN) || !testing.includes(FACTS_END)) {
  fail(`${FACTS_FILE} 里找不到「机器事实」块（${FACTS_BEGIN} … ${FACTS_END}）`);
} else {
  // 命令数：解析 check-web-commands 自己的汇总行（只有一处实现）
  const cmdOut = runNode("scripts/check-web-commands.mjs");
  const cmd = /Rust (\d+) 个命令.*?web 共 (\d+) 个.*?CommandMap 契约全覆盖（(\d+) 个/.exec(cmdOut);
  if (!cmd) {
    fail(`解析不了 check-web-commands 的汇总（它自己可能红了，先修它）：${cmdOut.trim().split("\n").slice(-2).join(" / ")}`);
  }
  // 能力数：解析 check-capabilities 自己的汇总行
  const capOut = runNode("scripts/check-capabilities.mjs");
  const cap = /能力注册表一致：(\d+) 条能力/.exec(capOut);
  if (!cap) {
    fail(`解析不了 check-capabilities 的汇总（它自己可能红了，先修它）：${capOut.trim().split("\n").slice(-2).join(" / ")}`);
  }

  if (cmd && cap) {
    const byGroup = GROUP_ORDER.filter((g) => DEFAULT_GROUPS.includes(g) || true)
      .map((g) => `${g} ${GATES.filter((x) => x.group === g).length}`)
      .join(" / ");
    const expected =
      `门禁 ${GATES.length} 条（${byGroup}）· 能力 ${cap[1]} 条 · ` +
      `命令 Rust ${cmd[1]} / web ${cmd[2]} / CommandMap ${cmd[3]}`;
    const got = testing.slice(testing.indexOf(FACTS_BEGIN) + FACTS_BEGIN.length, testing.indexOf(FACTS_END)).trim();
    if (got !== expected) {
      fail(
        `「机器事实」块与代码不一致。\n   文档里写的是：${got}\n   代码算出来是：${expected}\n` +
          `   ⇒ 把 ${FACTS_FILE} 里 ${FACTS_BEGIN} 与 ${FACTS_END} 之间的那一行替换成上面第二行`,
      );
    }
  }
}

if (failures.length) {
  console.error("文档事实门禁未通过：");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(
  `✓ 文档事实与代码一致：${GATES.length} 条门禁（全部在 ${FACTS_FILE} 里有名字）＋ 能力/命令数一致`,
);
