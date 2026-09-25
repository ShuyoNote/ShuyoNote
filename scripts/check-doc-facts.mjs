// 门禁：**文档里写死的机器事实，必须与代码一致**。
//
// ## 为什么需要它
// 门禁条数、能力条数、命令条数这三类数字，此前散在 `docs/TESTING.md` / `docs/SHUYONOTE_STATE.md` 里**靠人手抄**。
// 抄错的后果不是报错，而是"读文档的人照着做、做到一半发现文档是旧的"——本仓最反对的那种**静默漂移**。
// 所以这里把两件事变成断言：
//   A. **注册表里每条门禁都要在 `docs/TESTING.md` 里出现**（至少出现一次 `` `id` ``）
//      ⇒ 新加门禁不许"只进代码、不进文档"（本门禁上线当天就抓到 7 条漏写的）；
//   B. **`docs/TESTING.md` 里的「机器事实」块必须与代码逐字一致** —— 块里那两行由本脚本按代码生成，
//      不一致时**直接把该替换的内容打出来**（照抄即可，不用人肉算）：
//        第一行：门禁条数/分组 ＋ 能力条数 ＋ 命令数（取自 `scripts/lib/gates.mjs` 与另两条门禁的自报输出）；
//        第二行：**各门禁的读数下限**（取自 `tests/baseline.json`）—— 2026-09-25 加，因为正文里
//                手写的「vitest 885 用例」在下界与实测都已到 2262 之后仍在原地：**能漂的数字不该手写在散文里**。
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

  // 各门禁的读数下限：**从 tests/baseline.json 读**（不重算 —— 那份文件就是记录本身）。
  // 读不到/解析不了 ⇒ **判不了**：那样这一块的第二行就没人核了，绝不能静默当通过。
  let counts = null;
  try {
    counts = JSON.parse(read("tests/baseline.json")).counts ?? {};
  } catch (e) {
    fail(`读不到/解析不了 tests/baseline.json（${e.message}）⇒「机器事实」块里的下限行没法核，**不当通过**`);
  }

  if (cmd && cap) {
    const byGroup = GROUP_ORDER.filter((g) => DEFAULT_GROUPS.includes(g) || true)
      .map((g) => `${g} ${GATES.filter((x) => x.group === g).length}`)
      .join(" / ");
    const factsLine =
      `门禁 ${GATES.length} 条（${byGroup}）· 能力 ${cap[1]} 条 · ` +
      `命令 Rust ${cmd[1]} / web ${cmd[2]} / CommandMap ${cmd[3]}`;

    // ★ 第二行：各门禁的**读数下限**。
    //
    // 为什么要把数字搬进这个块（2026-09-25，实测漂移）：正文表格里手写着「`vitest` 单测回归
    // （**885 用例**）」，而 `tests/baseline.json` 的下界与实测读数都已经到 **2262** ——
    // 抄错不报错，照文档对账的人会读到一句早就过期的数字。**能漂的数字不该手写在散文里**：
    // ⇒ 下限统一从 `tests/baseline.json` 生成，放进这个由门禁逐字核对的块；
    // ⇒ 正文里凡要给数字，就指到这里来。
    //
    // 顺序取**注册表顺序**（`GATES` 里标了 `baseline: true` 且有读数的那些），不另排。
    const floors = counts
      ? GATES.filter((g) => typeof counts[g.id] === "number").map((g) => `${g.id} ${counts[g.id]}`)
      : null;
    const floorsLine = floors
      ? `基线下限（与 tests/baseline.json 逐字一致，共 ${floors.length} 条）${floors.join(" · ")}`
      : null;
    const expected = [factsLine, floorsLine].filter(Boolean).join("\n");

    const got = testing.slice(testing.indexOf(FACTS_BEGIN) + FACTS_BEGIN.length, testing.indexOf(FACTS_END)).trim();
    if (floorsLine && got !== expected) {
      fail(
        `「机器事实」块与代码/基线不一致。\n   文档里写的是：\n${got.split("\n").map((l) => "     " + l).join("\n")}\n` +
          `   算出来是：\n${expected.split("\n").map((l) => "     " + l).join("\n")}\n` +
          `   ⇒ 把 ${FACTS_FILE} 里 ${FACTS_BEGIN} 与 ${FACTS_END} 之间的内容整段替换成上面那两行`,
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
  `✓ 文档事实与代码一致：${GATES.length} 条门禁（全部在 ${FACTS_FILE} 里有名字）` +
    `＋ 能力/命令数一致 ＋ 各门禁读数下限与 tests/baseline.json 逐字一致`,
);
