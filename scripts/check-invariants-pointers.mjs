#!/usr/bin/env node
// check-invariants-pointers.mjs —— 「规格说能跑的，判据必须真在」（**多规格／多前缀**，2026-09-29 扩 ✓）
//
// 挡的是哪次真实事故：规格表里写「今天能跑吗 = **能**（`check-xxx`）」是对人下的承诺 ✓；
//   判据被改名／被删／被摘出注册表之后，**规格还在说"能跑"** ✗ ⇒ 读规格的人（含我）会以为有承重渠道 ✓
//   —— 与「文档说能、其实没人跑」同族。
// ⚠️ 2026-09-29 两次实测订正（都写在下面，别再犯 ✓）：
//   ① 判据**不一定住在产品仓 `scripts/`** —— `check-wiki-freshness.mjs` 住在 `_workspace/bin/` ✓
//      ⇒ 按**两个位置 ＋ 两个注册表**分别解析（谁的判据，谁那边注册 ✓）
//   ② 一开始只认 `INV-KB-*` ＋ **一份规格** ✗ ⇒ 扩成**目标清单**（每项带自己的前缀 ✓）
//
// 判据（窄；纯读 spec ＋ 两个注册表 ⇒ 本机可验 ✓）：
//   对每个目标规格里前缀匹配的**表行**（状态含「能」＝含"部分能"）：
//   ① 必须点名 ≥1 个 `check-*.mjs`
//   ② 它必须在 `scripts/` **或** `../../_workspace/bin/` 真实存在
//   ③ 且必须在**它所在那一侧的注册表**里（`scripts/lib/gates.mjs` ／ `_workspace/bin/check-all.mjs`）
//   ⚠️ 刻意不管"它跑起来绿不绿"（那是 `test-report` / `check-all` 的事 ✓）；也不管措辞 ✓
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 读不到某个 spec 或任一注册表（**不算通过**）
// 用法：node scripts/check-invariants-pointers.mjs ／ --spec <p>（只查一个，前缀放宽）／ --gates <p> ／ --ws-gates <p> ／ --self-test

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const GATES = join(ROOT, "scripts", "lib", "gates.mjs");
/** 工作区侧的注册表（跨仓：`repos/ShuyoNote` 的**上两级**才是工作区根 ✓） */
export const WS_GATES = join(ROOT, "..", "..", "_workspace", "bin", "check-all.mjs");
const PRODUCT_DIR = "scripts/";
const WS_DIR = "../../_workspace/bin/";
/** ⭐ 目标清单：一份规格 ＋ 它的不变式前缀（加新规格就加一行 ✓） */
export const TARGETS = [
  { label: "知识层与智能体接入", spec: join(ROOT, "docs", "specs", "2026-09-28-knowledge-and-agent-access-spec.md"), prefix: "INV-KB" },
  { label: "CRDT 混版本共存与降级", spec: join(ROOT, "docs", "specs", "2026-09-29-crdt-mixed-version-degradation.md"), prefix: "INV-CRDT" },
];

/** 纯判据：spec 文本 ＋ 两个注册表文本 ＋ "相对 ROOT 是否存在"的函数 ＋ 前缀 ⇒ findings */
export function judge(specText, gatesText, wsGatesText, exists, prefix = "INV-[A-Za-z-]+") {
  const out = [];
  const rowRe = new RegExp("^\\| \\*\\*" + prefix + "-[a-z-]+\\*\\* \\|");
  const idRe = new RegExp(prefix + "-[a-z-]+");
  const rows = specText.split("\n").filter((l) => rowRe.test(l));
  if (!rows.length) { out.push("✗ 一行 `" + prefix + "-*` 都没解析到 ⇒ 判据**没检查到东西**（不算通过 ✗）"); return out; }
  let runnable = 0;
  for (const l of rows) {
    const c = l.split("|");
    if (c.length < 8) continue;
    const id = (c[1].match(idRe) || [])[0];
    const status = c[5] || "";
    if (!/能/.test(status)) continue;                      // 「待立」不要求指判据 ✓
    runnable++;                                            // 「能」与「部分能」都算：都对人承诺了承重渠道 ✓
    // 规格里可能写 `check-x` 也可能写 `check-x.mjs` ⇒ 两种都认 ✓（实测：表里写的是不带扩展名的）
    const named = [...status.matchAll(/`([A-Za-z0-9_.\-]+?)(\.mjs)?`/g)]
      .map((m) => m[1] + (m[2] || ".mjs"))
      .filter((n) => n.startsWith("check-"));
    if (!named.length) { out.push("✗ " + id + " 写着**能**，但没有点名任何判据 ⇒ 承诺没有落点 ✗"); continue; }
    for (const n of named) {
      const hit = [PRODUCT_DIR + n, WS_DIR + n].find((p) => exists(p));
      if (!hit) {
        out.push("✗ " + id + " 指的判据**不存在**（产品 `scripts/` 与工作区 `_workspace/bin/` 都没有）：" + n + " ⇒ 规格在说一件没有的事 ✗");
        continue;
      }
      const registry = hit.startsWith(PRODUCT_DIR) ? gatesText : wsGatesText;
      const where = hit.startsWith(PRODUCT_DIR) ? "scripts/lib/gates.mjs" : "_workspace/bin/check-all.mjs";
      if (!registry.includes(n)) out.push("✗ " + id + " 指的判据**没进它那一侧的注册表**（" + where + "）：" + n + " ⇒ 等于没人跑 ✗");
    }
  }
  if (runnable === 0) out.push("✗ 没有任何一行标「能」⇒ 判据**没检查到东西**（不算通过 ✗）");
  return out;
}

/** 检查一个目标：返回 { findings, rows } 或 { envMissing } */
export function runOne(specPath, prefix, gatesPath, wsGatesPath) {
  // ⭐ 2026-09-29（CI 实测）：**CI 上根本没有 `_workspace`** ✗（日志：/home/runner/work/_workspace/... 不存在）
  //   ⇒ 工作区侧注册表缺失时**不许判成失败** ✗：只核**产品侧** ✓，工作区侧指针降级为**点名提示** ✓
  const hasWs = existsSync(wsGatesPath);
  for (const [p, what] of [[specPath, "spec"], [gatesPath, "gates.mjs"]]) {
    if (!existsSync(p)) return { envMissing: what + "：" + p };
  }
  if (!hasWs) console.log("  ⚠️ 本次**未核工作区侧**（没有 " + wsGatesPath + " ⇒ CI 上本来就没有 `_workspace` ✓）");
  const specText = readFileSync(specPath, "utf8");
  const rowRe = new RegExp("^\\| \\*\\*" + prefix + "-[a-z-]+\\*\\* \\|");
  const rows = specText.split("\n").filter((l) => rowRe.test(l)).length;
  const findings = judge(specText, readFileSync(gatesPath, "utf8"), hasWs ? readFileSync(wsGatesPath, "utf8") : "", (rel) => existsSync(join(ROOT, rel)), prefix)
    // 工作区侧缺失时，凡"该判据本属工作区"的发现降级为提示 ✓（判据看路径前缀 ✓）
    .filter((f) => { if (hasWs) return true; const isWs = f.includes("_workspace/bin/"); if (isWs) console.log("  ⚠️ 提示（未核）：" + f); return !isWs; });
  return { findings, rows };
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const mk = (id, status) => "| **" + id + "** | 口径 | 判据 | 会红 | " + status + " | 渠道 |";
  const gates = 'id: "check-a.mjs"', wsGates = 'id: "check-w.mjs"';
  const exists = (rel) => rel.startsWith("scripts/") ? ["check-a.mjs", "check-b.mjs"].some((n) => rel.endsWith(n)) : ["check-w.mjs", "check-w2.mjs"].some((n) => rel.endsWith(n));
  const cases = [
    ["能 + 产品侧存在 + 已注册 ⇒ 空", judge(mk("INV-KB-x", "**能**（`check-a.mjs`）"), gates, wsGates, exists, "INV-KB").length === 0],
    ["⭐ 工作区侧存在 + 在 check-all 里 ⇒ 空（跨仓 ✓）", judge(mk("INV-KB-x", "**能**（`check-w.mjs`）"), gates, wsGates, exists, "INV-KB").length === 0],
    ["⭐ **另一个前缀**（INV-CRDT）也认 ✓", judge(mk("INV-CRDT-x", "**能**（`check-a.mjs`）"), gates, wsGates, exists, "INV-CRDT").length === 0],
    ["前缀对不上 ⇒ 报「没检查到东西」（不许假绿 ✗）", judge(mk("INV-KB-x", "**能**（`check-a.mjs`）"), gates, wsGates, exists, "INV-CRDT").some((s) => s.includes("没检查到东西"))],
    ["能但没点名 ⇒ 红", judge(mk("INV-KB-x", "**能**"), gates, wsGates, exists, "INV-KB").some((s) => s.includes("没有落点"))],
    ["能但两处都不存在 ⇒ 红", judge(mk("INV-KB-x", "**能**（`check-nope.mjs`）"), gates, wsGates, exists, "INV-KB").some((s) => s.includes("不存在"))],
    ["产品侧判据没进 gates.mjs ⇒ 红", judge(mk("INV-KB-x", "**能**（`check-b.mjs`）"), gates, wsGates, exists, "INV-KB").some((s) => s.includes("没进它那一侧的注册表"))],
    ["工作区侧判据没进 check-all ⇒ 红", judge(mk("INV-KB-x", "**能**（`check-w2.mjs`）"), gates, wsGates, exists, "INV-KB").some((s) => s.includes("check-all.mjs"))],
    ["待立行 ⇒ 不针对该行报缺判据", judge(mk("INV-KB-x", "**待立**"), gates, wsGates, exists, "INV-KB").every((s) => !s.includes("INV-KB-x"))],
    ["一行都没有 ⇒ 红", judge("nothing", gates, wsGates, exists, "INV-KB").some((s) => s.includes("没检查到东西"))],
    // ⭐ 2026-09-29：规格文件**不存在**时必须"不算通过"，**不许静默不查** ✗（"没查过 ≠ 通过" ✓）
    ["规格文件不存在 ⇒ envMissing（真跑 exit 2）", runOne(join(ROOT, "docs", "NOPE.md"), "INV-KB", GATES, WS_GATES).envMissing !== undefined],
  ];
  let pass = 0;
  for (const [n, ok] of cases) { console.log((ok ? "  ✓ " : "  ✗ ") + n); if (ok) pass++; }
  console.log("self-test: " + pass + "/" + cases.length + " 通过");
  process.exit(pass === cases.length ? 0 : 1);
}
const si = argv.indexOf("--spec"), gi = argv.indexOf("--gates"), wi = argv.indexOf("--ws-gates");
const gatesPath = gi >= 0 ? argv[gi + 1] : GATES;
const wsPath = wi >= 0 ? argv[wi + 1] : WS_GATES;
const targets = si >= 0 && argv[si + 1] ? [{ label: "(单查)", spec: argv[si + 1], prefix: "INV-[A-Za-z-]+" }] : TARGETS;
let all = [], total = 0;
for (const t of targets) {
  const r = runOne(t.spec, t.prefix, gatesPath, wsPath);
  if (r.envMissing) { console.error("✗ 读不到" + r.envMissing + "（**不算通过**）"); process.exit(2); }
  total += r.rows;
  for (const f of r.findings) all.push("[" + t.label + "] " + f);
}
if (all.length) { for (const x of all) console.error(x); process.exit(1); }
console.log("✓ 规格 ↔ 门禁可核：查了 " + targets.length + " 份规格 / " + total + " 行不变式；凡标「能」的都点到**存在且已注册**的判据 ✓"
  + "（产品侧对 `gates.mjs` ✓／工作区侧对 `check-all.mjs` ✓）");
