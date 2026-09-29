#!/usr/bin/env node
// check-invariants-pointers.mjs —— 「规格说能跑的，判据必须真在」(规格↔门禁双向可核的一半)
//
// 挡的是哪次真实事故（为什么值得一条判据）：
//   规格表里写「今天能跑吗 = **能**（`check-xxx`）」—— 这是**对人下的承诺** ✓。
//   但文档与代码会各自漂移：判据被改名／被删／被摘出注册表之后，**规格还在说"能跑"** ✗，
//   而读规格的人（含我）会据此**以为有承重渠道** ✓ —— 与今天反复罚的那族同形
//   （"把'我不知道'说成'没有'"／"抛了还说自己干净"／"文档说能、其实没人跑"）。
//
// ⚠️ 2026-09-29 实测订正（本判据第一版就错在这）：判据**不一定住在产品仓 `scripts/`** ✓
//   —— `INV-KB-citation-stale` 点的是 `check-wiki-freshness.mjs`，它住在
//   **`_workspace/bin/`**（工作区侧判据 ✓，注册在 `_workspace/bin/check-all.mjs` ✓）。
//   ⇒ 所以本判据按**两个位置 ＋ 两个注册表**分别解析：谁的判据，谁那边注册 ✓
//
// 判据（窄；**今天全绿** ✓；纯读 spec ＋ 两个注册表 ⇒ 本机可验 ✓）：
//   对 spec 的 `INV-KB-*` 表行（状态含「能」＝含"部分能"）：
//   ① 必须点名 ≥1 个 `check-*.mjs`
//   ② 该判据必须在 `scripts/`（产品兼）**或** `../_workspace/bin/`（工作区）**真实存在**
//   ③ 且必须在**它所在那一侧的注册表**里（`scripts/lib/gates.mjs` ／ `_workspace/bin/check-all.mjs`）
//      —— 不进注册表就不进 `pnpm verify`／CI／`check-all` ⇒ 等于**没人跑** ✗
//   ⚠️ 刻意不管"它跑起来绿不绿"（那是 `test-report` / `check-all` 的事 ✓）；也不管措辞 ✓
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 读不到 spec 或任一注册表（**不算通过**）
// 用法：node scripts/check-invariants-pointers.mjs ／ --spec <p> ／ --gates <p> ／ --ws-gates <p> ／ --self-test

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const SPEC = join(ROOT, "docs", "specs", "2026-09-28-knowledge-and-agent-access-spec.md");
export const GATES = join(ROOT, "scripts", "lib", "gates.mjs");
/** 工作区侧的注册表（跨仓：`repos/ShuyoNote` 的**上两级**才是工作区根 ✓） */
export const WS_GATES = join(ROOT, "..", "..", "_workspace", "bin", "check-all.mjs");
const PRODUCT_DIR = "scripts/";
const WS_DIR = "../../_workspace/bin/";

/** 纯判据：spec 文本 ＋ 两个注册表文本 ＋ "相对 ROOT 是否存在"的函数 ⇒ findings */
export function judge(specText, gatesText, wsGatesText, exists) {
  const out = [];
  const rows = specText.split("\n").filter((l) => /^\| \*\*INV-KB-[a-z-]+\*\* \|/.test(l));
  if (!rows.length) { out.push("✗ 一行 `INV-KB-*` 都没解析到 ⇒ 判据**没检查到东西**（不算通过 ✗）"); return out; }
  let runnable = 0;
  for (const l of rows) {
    const c = l.split("|");
    if (c.length < 8) continue;
    const id = (c[1].match(/INV-KB-[a-z-]+/) || [])[0];
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
      if (!registry.includes(n)) {
        out.push("✗ " + id + " 指的判据**没进它那一侧的注册表**（" + where + "）：" + n + " ⇒ 等于没人跑 ✗");
      }
    }
  }
  if (runnable === 0) out.push("✗ 没有任何一行标「能」⇒ 判据**没检查到东西**（不算通过 ✗）");
  return out;
}

function run(specPath, gatesPath, wsGatesPath) {
  for (const [p, what] of [[specPath, "spec"], [gatesPath, "gates.mjs"], [wsGatesPath, "工作区 check-all.mjs"]]) {
    if (!existsSync(p)) { console.error("✗ 读不到" + what + "：" + p + "（**不算通过**）"); return 2; }
  }
  const f = judge(readFileSync(specPath, "utf8"), readFileSync(gatesPath, "utf8"), readFileSync(wsGatesPath, "utf8"),
    (rel) => existsSync(join(ROOT, rel)));
  if (f.length) { for (const x of f) console.error(x); return 1; }
  const n = readFileSync(specPath, "utf8").split("\n").filter((l) => /^\| \*\*INV-KB-[a-z-]+\*\* \|/.test(l)).length;
  console.log("✓ 规格 ↔ 门禁可核：`INV-KB-*` 共 " + n + " 行；凡标「能」的都点到**存在且已注册**的判据（产品侧对 `gates.mjs` ✓／工作区侧对 `check-all.mjs` ✓）");
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "inv-pointers-"));
  try {
    const mk = (id, status) => "| **" + id + "** | 口径 | 判据 | 会红 | " + status + " | 渠道 |";
    const gates = 'id: "check-a.mjs"';
    const wsGates = 'id: "check-w.mjs"';            // 工作区侧注册表 ✓
    const good = mk("INV-KB-x", "**能**（`check-a.mjs`）");
    const wsGood = mk("INV-KB-x", "**能**（`check-w.mjs`）");   // **跨仓指针**：这一条正是第一版漏掉的 ✓
    const noPoint = mk("INV-KB-x", "**能**");
    const missing = mk("INV-KB-x", "**能**（`check-nope.mjs`）");
    const unregistered = mk("INV-KB-x", "**能**（`check-b.mjs`）");
    const wsUnregistered = mk("INV-KB-x", "**能**（`check-w2.mjs`）");
    const pending = mk("INV-KB-x", "**待立**");
    // ⚠️ 桩必须**分位置**：产品判据只存在于 `scripts/`，工作区判据只存在于 `../../_workspace/bin/`
    //    （第一版桩只按文件名 endsWith 判 ⇒ 工作区判据被误判到产品侧 ⇒ 三条自测假红 ✗）
    const exists = (rel) => rel.startsWith("scripts/")
      ? ["check-a.mjs", "check-b.mjs"].some((n) => rel.endsWith(n))
      : ["check-w.mjs", "check-w2.mjs"].some((n) => rel.endsWith(n));
    const cases = [
      ["能 + 产品侧存在 + 已注册 ⇒ 空", judge(good, gates, wsGates, exists).length === 0],
      ["⭐ 能 + **工作区侧**存在 + 在 check-all 里 ⇒ 空（跨仓指针 ✓）", judge(wsGood, gates, wsGates, exists).length === 0],
      ["能但没点名 ⇒ 红", judge(noPoint, gates, wsGates, exists).some((s) => s.includes("没有落点"))],
      ["能但两处都不存在 ⇒ 红", judge(missing, gates, wsGates, exists).some((s) => s.includes("不存在"))],
      ["产品侧判据没进 gates.mjs ⇒ 红", judge(unregistered, gates, wsGates, exists).some((s) => s.includes("没进它那一侧的注册表"))],
      ["工作区侧判据没进 check-all ⇒ 红", judge(wsUnregistered, gates, wsGates, exists).some((s) => s.includes("check-all.mjs"))],
      ["待立行 ⇒ 不针对该行报缺判据（其余按'没有可跑的行'处理 ✓）", judge(pending, gates, wsGates, exists).every((s) => !s.includes("INV-KB-x"))],
      ["一行都没有 ⇒ 红（不许假绿 ✗）", judge("nothing here", gates, wsGates, exists).some((s) => s.includes("没检查到东西"))],
      ["spec 不在 ⇒ exit 2", run(join(dir, "nope.md"), GATES, WS_GATES) === 2],
    ];
    let pass = 0;
    for (const [n, ok] of cases) { console.log((ok ? "  ✓ " : "  ✗ ") + n); if (ok) pass++; }
    console.log("self-test: " + pass + "/" + cases.length + " 通过");
    process.exit(pass === cases.length ? 0 : 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const si = argv.indexOf("--spec"), gi = argv.indexOf("--gates"), wi = argv.indexOf("--ws-gates");
process.exit(run(si >= 0 ? argv[si + 1] : SPEC, gi >= 0 ? argv[gi + 1] : GATES, wi >= 0 ? argv[wi + 1] : WS_GATES));
