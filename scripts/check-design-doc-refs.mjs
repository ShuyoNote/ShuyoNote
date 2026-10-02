#!/usr/bin/env node
// check-design-doc-refs.mjs —— 「效果图点名的需求/不变式必须真实存在」+「每条 MUST 至少有一张图」
//
// 挡的是哪一类真实事故（incident）：
//   效果图的 README 里那张「覆盖哪几条需求」的表**是人工写的** ✗ ——
//   写一个不存在的 `M9`、或者需求加了新条目却没人画图，**两者都不会有任何报错** ✓：
//   图照样出、评审照样看、而**图与文档的关联是假的** ✓。
//   ⇒ 图事实上在扮演"规格"（大家照着图做），**而它没有判据兜** ✗
//     —— 这正是本仓反复要消灭的「两份真相源」✓。
//
// 两条判据（都是真断言）：
//   ① **引用的 id 必须真实存在**：`design/**/README.md` 里点名的 `M#`／`W#` 必须能在需求文档里找到；
//      `INV-IM-*` 必须能在规格里找到。**写假 id ⇒ 红** ✓
//   ② **每条 MUST 至少被一张图引用**：`M#`（要做的那些）逐条必须出现在图 README 里。
//      **需求加了、图没跟 ⇒ 红** ✓（而 `W#`（不做的）不要求逐条引 ✓ —— 不做的东西不必每张都画 ✓）
//
// ⚠️ 边界（写在脚本头，README 里也点名）：
//   · ⛔ **它不判"图长得对不对"** ✗ —— 只判**引用是不是真的** ✓（那是评审的活 ✓）
//   · ⛔ **它不要求每张图都引 id** ✗ —— 没有对应需求的图（例：纯说明性的）可以一条都不引 ✓
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 环境不具备（**不算通过**）／ 3 无可检查对象
// 用法：node scripts/check-design-doc-refs.mjs ／ --root <仓根> ／ --self-test

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);

/** 图 README → 它的 id 出处（**这份映射是显式的** ✓ —— ⛔ 不靠猜路径 ✗） */
export const TARGETS = [
  {
    readme: "design/enterprise-im/README.md",
    needs: "docs/specs/2026-10-01-enterprise-im-requirements.md",
    spec: "docs/specs/2026-10-01-enterprise-im-spec.md",
    needPrefix: "M",
    wontPrefix: "W",
    invPrefix: "INV-IM-",
    // ⭐ 规格里那些**还只是口径、没进 §1 不变式表**的编号（规格 §7 的 `**N1**`–`**N4**`）
    //   ⇒ 图 README 引用它们时也要真实存在 ✓（否则"图引了一个规格里没有的口径" ✗）
    specPrefix: "N",
    // ⭐ 2026-10-02：这一份还多一条**口径尺子**（见 `judgeA1`）—— agent 走进讨论线的**主体模型**
    agentModel: true,
  },
];

const uniq = (a) => [...new Set(a)];

/** 逐条对：引用的 id 必须真实存在 ＋ 每条 MUST 至少被引用一次 */
export function judge({ readme, needs, spec, t }) {
  const out = [];
  const invRe = new RegExp(t.invPrefix + "[a-z][a-z-]*[a-z]", "g");
  const invCited = uniq(readme.match(invRe) || []);
  const numRe = new RegExp("\\b([" + t.needPrefix + t.wontPrefix + "])(\\d{1,2})\\b", "g");
  const citedM = new Set(), citedW = new Set();
  for (const m of readme.matchAll(numRe)) (m[1] === t.needPrefix ? citedM : citedW).add(Number(m[2]));

  // ① 不变式必须存在
  if (!invCited.length && !citedM.size) {
    out.push("✗ 图 README 里没引用任何需求号或不变式 ⇒ 判据**没检查到东西**（不算通过 ✗）");
  }
  for (const id of invCited) {
    if (!spec.includes(id)) out.push("✗ 图 README 点名了规格里**不存在**的不变式：`" + id + "` ✗（写假 id ⇒ 图与文档的关联是假的 ✓）");
  }

  // ① 规格里那些"还只是口径"的编号（§7 的 N1–N4）也必须存在
  if (t.specPrefix) {
    const nRe = new RegExp("\\b" + t.specPrefix + "(\\d{1,2})\\b", "g");
    const citedN = uniq([...readme.matchAll(nRe)].map((m) => m[1]));
    const realN = new Set([...spec.matchAll(new RegExp("\\*\\*" + t.specPrefix + "(\\d{1,2})\\*\\*", "g"))].map((m) => m[1]));
    if (citedN.length && !realN.size) out.push("✗ 从规格里解析不出任何 `**" + t.specPrefix + "n**` 口径行 ⇒ 判据**没检查到东西**（不算通过 ✗）");
    for (const n of citedN) {
      if (!realN.has(n)) out.push("✗ 图 README 点名了规格里**不存在**的口径 `" + t.specPrefix + n + "` ✗");
    }
  }

  // ① 需求号必须存在
  const allNums = (text, prefix) =>
    new Set([...text.matchAll(new RegExp("\\*\\*(" + prefix + ")(\\d{1,2})\\*\\*", "g"))].map((m) => Number(m[2])));
  const realM = allNums(needs, t.needPrefix), realW = allNums(needs, t.wontPrefix);
  if (!realM.size) out.push("✗ 从需求文档里解析不出任何 `**" + t.needPrefix + "n**` 行 ⇒ 判据**没检查到东西**（不算通过 ✗）");
  for (const n of [...citedM].sort((a, b) => a - b)) {
    if (!realM.has(n)) out.push("✗ 图 README 点名了需求里**不存在**的 `" + t.needPrefix + n + "` ✗");
  }
  for (const n of [...citedW].sort((a, b) => a - b)) {
    if (!realW.has(n)) out.push("✗ 图 README 点名了需求里**不存在**的 `" + t.wontPrefix + n + "` ✗");
  }

  // ② 每条 MUST 至少被一张图引用
  for (const n of [...realM].sort((a, b) => a - b)) {
    if (!citedM.has(n)) {
      out.push("✗ `" + t.needPrefix + n + "` 这条 MUST **没有任何一张图引用它** ✗" +
        "（需求加了、图没跟 ⇒ 图与文档的关联断了 ✓）");
    }
  }
  return out;
}

/** ⭐ **2026-10-02**：agent 走进讨论线的**主体模型口径尺子**（owner 拍「A1」✓）。
 *
 * ⚠️ **它量的是「文档口径不许漂」，⛔ 不是产品行为** ✗ —— 这一点必须写清楚：
 *   产品代码**一行都没有** ⇒ 若去量"agent 会不会主动插话／会不会自激"，
 *   那把尺子**今天必然是绿的**，而且**永远绿到功能做出来为止** ✗
 *   ⇒ 那正是本仓最忌的「**看起来有其实没有**」✓。
 *   ⇒ **产品那三把尺子，等代码出现时再立** ✓（判据先行 ≠ 提前立一把永远绿的假尺子 ✗）。
 *
 * 今天能立、而且**真的会响**的三条：
 *   ① 规格里**必须写明** A1 的三条守卫（防自激／只被 @ 才答／在线依赖如实说）—— 谁删掉一条 ⇒ 红 ✓
 *   ② 主体模型**只能有一个口径**（选定 A1）—— ⛔ 同时写「A1 ＋ A2 并存」⇒ 红 ✗（两套口径＝两份真相 ✓）
 *   ③ 图 README 里 **08 必须标【选定】、09 必须标【对照／未选】** —— ⛔ 不许让人把 09 读成计划 ✗
 */
export function judgeA1({ readme, spec }) {
  const out = [];
  for (const g of ["防自激", "只被 @ 才答", "在线依赖如实说"]) {
    if (!spec.includes(g)) {
      out.push("✗ 规格里**没有** A1 的守卫「" + g + "」✗（删掉它 ⇒ 将来做的人只能凭记忆，而记忆会漂 ✓）");
    }
  }
  if (!/选\s*定?\s*[:：]?\s*\**\s*A1|A1[^\n]{0,30}——\s*选定/.test(spec)) {
    out.push("✗ 规格里读不出「**选定 A1**」✗（主体模型必须有**一个**明确口径 ✓）");
  }
  const 并存 = spec.split("\n").filter((l) => /A1/.test(l) && /A2/.test(l) && /并存/.test(l) && !/先|随后|不是/.test(l));
  if (并存.length) {
    out.push("✗ 规格里同时写着「A1 ＋ A2 并存」✗ —— 两套口径就是**两份真相** ✓（本仓最忌）");
  }
  const 行 = (n) => readme.split("\n").find((l) => l.startsWith("| " + n + " |")) || "";
  // ③ ⭐ 2026-10-02（§1.8 之后）：**两张都选定，只是各管一类 agent** ✓
  //    08 ＝ **内置 agent** 的形状；09 ＝ **外部 agent**（甲：借成员身份）的形状 ✓
  //    ⛔ 而"09 是对照／未选"是 §1.8 **之前**的写法 ✗ ⇒ 现在那样写就是**口径过期** ✓
  //    ⚠️ **两个词都要**（"选定" ＋ "内置／外部"）✗→✓：只查"外部"太松 ——
  //    那一行的说明里本来就会出现「外部」⇒ 变异（把它改回"对照 · 未选"）**照样绿** ✗（实测踩到 ✓）。
  if (!/选定/.test(行("08")) || !/内置/.test(行("08"))) out.push("✗ 图 README 第 08 行要同时标出【选定】与【内置 agent】✗");
  if (!/选定/.test(行("09")) || !/外部/.test(行("09"))) out.push("✗ 图 README 第 09 行要同时标出【选定】与【外部 agent】✗（§1.8 选的甲 ✓）");
  return out;
}

function run(root) {
  let checked = 0;
  const findings = [];
  for (const t of TARGETS) {
    const rp = join(root, t.readme), np = join(root, t.needs), sp = join(root, t.spec);
    if (!existsSync(rp)) { findings.push("✗ 图 README 不在：" + t.readme + "（**不算通过**）"); continue; }
    if (!existsSync(np) || !existsSync(sp)) { findings.push("✗ 需求或规格文档不在（**不算通过**）：" + t.needs + " / " + t.spec); continue; }
    findings.push(...judge({
      readme: readFileSync(rp, "utf8"),
      needs: readFileSync(np, "utf8"),
      spec: readFileSync(sp, "utf8"),
      t,
    }).map((x) => "[" + t.readme + "] " + x));
    if (t.agentModel) {
      findings.push(...judgeA1({ readme: readFileSync(rp, "utf8"), spec: readFileSync(sp, "utf8") })
        .map((x) => "[" + t.readme + "] " + x));
    }
    checked++;
  }
  if (!checked) { for (const x of findings) console.error(x); return 2; }
  if (findings.length) { for (const x of findings) console.error(x); return 1; }
  console.log("✓ 效果图与文档的关联成立：" + checked + " 份图 README ｜ 点名的需求号与不变式**全部真实存在** ✓ ｜ 每条 MUST **至少被一张图引用** ✓");
  if (TARGETS.some((t) => t.agentModel)) {
    console.log("✓ agent 走进讨论线的**口径**也在岗：A1 三条守卫写着 ✓ ｜ 主体模型只有「选定 A1」一个口径 ✓ ｜ 图 08 标【内置 agent】、09 标【外部 agent】✓");
  }
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const T = TARGETS[0];
  const needs = "| **M1** | 甲 |\n| **M2** | 乙 |\n| **W1** | 不做甲 |\n";
  const spec = "| **INV-IM-alpha-beta** | … |\n";
  const cases = [
    ["合规 ⇒ 空", judge({ readme: "覆盖 M1 M2（W1）；关联 INV-IM-alpha-beta", needs, spec, t: T }).length === 0],
    ["点名不存在的 M9 ⇒ 红", judge({ readme: "M1 M2 M9", needs, spec, t: T }).some((s) => s.includes("不存在") && s.includes("M9"))],
    ["点名不存在的 W9 ⇒ 红", judge({ readme: "M1 M2 W9", needs, spec, t: T }).some((s) => s.includes("W9"))],
    ["点名不存在的不变式 ⇒ 红", judge({ readme: "M1 M2 INV-IM-not-real", needs, spec, t: T }).some((s) => s.includes("INV-IM-not-real"))],
    ["有 MUST 没被任何图引用 ⇒ 红", judge({ readme: "只画了 M1", needs: "| **M1** | 甲 |\n| **M2** | 乙 |\n", spec, t: T }).some((s) => s.includes("M2") && s.includes("没有任何一张图"))],
    ["W 不要求逐条引 ⇒ 绿", judge({ readme: "M1 M2", needs, spec, t: T }).length === 0],
    ["一条 id 都不引 ⇒ 红（不许假绿）", judge({ readme: "这张图没有引用任何编号", needs, spec, t: T }).some((s) => s.includes("没检查到东西"))],
    ["需求文档解析不出条目 ⇒ 红（不许假绿）", judge({ readme: "M1", needs: "没有条目", spec, t: T }).some((s) => s.includes("没检查到东西"))],
    ["点名不存在规格口径 N9 ⇒ 红", judge({ readme: "M1 M2 N9", needs, spec: spec + "| **N1** | 甲 |", t: T }).some((s) => s.includes("N9"))],
    ["点名存在的规格口径 N1 ⇒ 绿", judge({ readme: "M1 M2 N1", needs, spec: spec + "| **N1** | 甲 |", t: T }).length === 0],
  ];
  const specA1 = "## 1.7\n选 A1 ✓\n① ⛔ **防自激**\n④ ⛔ **只被 @ 才答**\n③ ⚠️ **在线依赖如实说**\n";
  const readmeA1 = "| 08 | 甲 | 选定 · 内置 |\n| 09 | 乙 | 选定 · 外部 |\n";
  const casesA1 = [
    ["A1 合规 ⇒ 空", judgeA1({ readme: readmeA1, spec: specA1 }).length === 0],
    ["删掉「防自激」⇒ 红", judgeA1({ readme: readmeA1, spec: specA1.replace("防自激", "防") }).some((s) => s.includes("防自激"))],
    ["删掉「只被 @ 才答」⇒ 红", judgeA1({ readme: readmeA1, spec: specA1.replace("只被 @ 才答", "只被") }).some((s) => s.includes("只被 @ 才答"))],
    ["删掉「在线依赖如实说」⇒ 红", judgeA1({ readme: readmeA1, spec: specA1.replace("在线依赖如实说", "在线") }).some((s) => s.includes("在线依赖如实说"))],
    ["读不出「选定 A1」⇒ 红", judgeA1({ readme: readmeA1, spec: "没有那个词" }).some((s) => s.includes("选定 A1"))],
    ["又写「A1 ＋ A2 并存」⇒ 红（两份真相）", judgeA1({ readme: readmeA1, spec: specA1 + "A1 ＋ A2 两种主体模型并存\n" }).some((s) => s.includes("两份真相"))],
    ["08 行不标【内置】⇒ 红", judgeA1({ readme: "| 08 | 甲 |\n| 09 | 乙 | 选定 · 外部 |\n", spec: specA1 }).some((s) => s.includes("08"))],
    ["09 行不标【外部】⇒ 红", judgeA1({ readme: "| 08 | 甲 | 选定 · 内置 |\n| 09 | 乙 | 对照 · 未选 |\n", spec: specA1 }).some((s) => s.includes("09"))],
  ];

  let pass = 0;
  for (const [n, ok] of cases) { console.log((ok ? "  ✓ " : "  ✗ ") + n); if (ok) pass++; }
  for (const [n, ok] of casesA1) { console.log((ok ? "  ✓ " : "  ✗ ") + n); if (ok) pass++; }
  const all = [...cases, ...casesA1];
  console.log("self-test: " + pass + "/" + all.length + " 通过");
  process.exit(pass === all.length ? 0 : 1);
}

const ri = argv.indexOf("--root");
process.exit(run(ri >= 0 ? argv[ri + 1] : ROOT));
