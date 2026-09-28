#!/usr/bin/env node
// check-agent-surface.mjs —— 判据（**同时覆盖施工单 Task 2 与 Task 3**）：
//   ① **只读面（m1）里 `kind === 'write'` 的条数 = 0**（`INV-KB-readonly-surface`）
//   ② **面的描述里不出现内部标识**（窄名单 ✓，`INV-KB-tool-desc-clean`）
//   ③ 面与注册表**逐字节一致**（生成物漂移 ⇒ 红 ✓，与 `check-ontology-generated` 同一纪律）
//
// 为什么把两条判据合在一个门禁（与施工单的差异，如实记 ✓）：
//   它们读的是**同一份生成物**；拆成两条门禁等于把同一份生成跑两遍 ⇒ 更慢、更容易不一致 ✓
//
// 判据的"窄名单"从哪来（2026-09-28 实测，不是猜 ✓）：
//   注册表 25 条的 `desc` 里：`content_json` 出现 **1** 次（在 `page.current`，而它**不是** `ai:true` ✓）；
//   `content_text` / `workspace_id` / `deleted_at` / `src/` / `src-tauri` / `plugins.rs` / `ipc` / `invoke` /
//   `capabilities.json` / `apply.ts` / `crdt` 全部 **0** 次 ⇒ 名单取这些**具体串**，
//   **不用 `json` 这种宽词**（`files.read` 的描述里就有"json"，那是用户能懂的正常说法 ✓）
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 注册表读不到或 phase 非法（**不算通过**）
// 用法：node scripts/check-agent-surface.mjs ／ --self-test ／ --phase m1 --file <路径>（夹具 ✓）

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY, PHASES, renderSurface, surfacePath } from "./gen-agent-tool-surface.mjs";

export const INTERNAL_MARKERS = [
  "content_json", "content_text", "workspace_id", "deleted_at",
  "src/", "src-tauri", "plugins.rs", "ipc", "invoke",
  "capabilities.json", "apply.ts", "crdt",
];

function firstDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if ((A[i] ?? "<缺行>") !== (B[i] ?? "<缺行>")) return "第 " + (i + 1) + " 行不同：\n    盘上：" + (A[i] ?? "<缺行>") + "\n    应为：" + (B[i] ?? "<缺行>");
  }
  return "";
}

/** 纯判据：给定"应为文本"与"盘上文本" ⇒ findings 数组（空＝干净 ✓） */
export function judge(expected, actual, phase) {
  const out = [];
  if (actual === null) { out.push("✗ 面清单缺失：" + (surfacePath(phase) || phase) + " —— 跑 `node scripts/gen-agent-tool-surface.mjs --phase " + phase + "` 生成 ✓"); return out; }
  // ③ 逐字节
  if (expected !== actual) out.push("✗ 面与注册表不一致： " + firstDiff(actual, expected));
  // ① 只读面不许出现写能力（从**盘上文本**数，防"生成器写错但比得上" ✗）
  if (phase === "m1") {
    const rows = actual.split("\n").filter((l) => /^\| [a-z0-9_.]+ \|/.test(l));
    const caps = rows.map((l) => l.split("|")[1].trim());
    // 判据以**注册表**为准：m1 的 id 集合必须等于 ai && kind==='read'
    const reg = readFileSync(REGISTRY, "utf8");
    const j = JSON.parse(reg);
    const aiRead = (j.capabilities || []).filter((c) => c.ai === true && c.kind === "read").map((c) => c.id).sort();
    const aiWrite = (j.capabilities || []).filter((c) => c.ai === true && c.kind === "write").map((c) => c.id);
    const leaked = caps.filter((id) => aiWrite.includes(id));
    if (leaked.length) out.push("✗ 只读面里出现写能力 " + leaked.length + " 条：" + leaked.join(", ") + "（`kind === 'write'` 应为 0 ✓）");
    const missing = aiRead.filter((id) => !caps.includes(id));
    if (missing.length) out.push("✗ 只读面缺 " + missing.length + " 条（注册表里 `ai && kind==='read'` 应为 " + aiRead.length + " 条）：" + missing.join(", "));
  }
  // ② 描述里不许出现内部标识（窄名单 ✓）
  //    ⚠️ **只扫表格里的 desc 格**，不扫表头与说明行 —— 表头本来就写着"从 capabilities/capabilities.json 生成"，
  //    全文件扫会把**判据自己的溯源信息**当成违规 ⇒ 假红 ✗（2026-09-28 实测撞到，当场收窄 ✓）
  const descCells = actual.split("\n").filter((l) => /^\| [a-z0-9_.]+ \|/.test(l)).map((l) => (l.split("|")[4] || ""));
  for (const m of INTERNAL_MARKERS) {
    if (descCells.some((d) => d.includes(m))) out.push("✗ 描述里出现内部标识「" + m + "」—— 工具面＝对外暴露面 ✓");
  }
  return out;
}

function run(phase, file) {
  if (!PHASES[phase]) { console.error("✗ --phase 只接受 m1 / m2（**不算通过**）"); return 2; }
  if (!existsSync(REGISTRY)) { console.error("✗ 读不到能力注册表（**不算通过**）"); return 2; }
  const expected = renderSurface(readFileSync(REGISTRY, "utf8"), phase);
  const actual = existsSync(file) ? readFileSync(file, "utf8") : null;
  const f = judge(expected, actual, phase);
  if (f.length) { for (const x of f) console.error(x); return 1; }
  const n = (JSON.parse(readFileSync(REGISTRY, "utf8")).capabilities || []).filter((c) => c.ai === true && c.kind === PHASES[phase]).length;
  console.log("✓ " + phase + " 面与注册表一致（" + n + " 条）｜ 写能力 " + (phase === "m1" ? "0" : n) + " 条 ｜ 描述无内部标识 ✓");
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "surface-"));
  try {
    const reg = readFileSync(REGISTRY, "utf8");
    const good = renderSurface(reg, "m1");
    const p = join(dir, "m1.md");
    writeFileSync(p, good, "utf8");
    const withWrite = good.replace(/(\| pages\.get \|)/, "| pages.create | current-space | write:pages | 新建页面 |\n$1");
    const withMarker = good.replace("读取单个页面的标题", "读取 content_json 里的正文");
    const cases = [
      ["合规面 ⇒ 空", judge(good, good, "m1").length === 0],
      ["塞进一个写能力 ⇒ 有 finding", judge(good, withWrite, "m1").some((s) => s.includes("写能力"))],
      ["描述里带 content_json ⇒ 有 finding", judge(good, withMarker, "m1").some((s) => s.includes("content_json"))],
      ["面缺失 ⇒ 有 finding 且含'缺失'", judge(good, null, "m1").some((s) => s.includes("缺失"))],
      ["漂移 ⇒ finding 指出行号", judge(good, good.replace("| current-space |", "| 改过 |"), "m1").some((s) => s.includes("行"))],
    ];
    let pass = 0;
    for (const [n, ok] of cases) { console.log((ok ? "  ✓ " : "  ✗ ") + n); if (ok) pass++; }
    console.log("self-test: " + pass + "/" + cases.length + " 通过");
    process.exit(pass === cases.length ? 0 : 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const pi = argv.indexOf("--phase");
const phase = pi >= 0 ? argv[pi + 1] : "m1";
const fi = argv.indexOf("--file");
process.exit(run(phase, fi >= 0 ? argv[fi + 1] : surfacePath(phase)));
