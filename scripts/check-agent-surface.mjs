#!/usr/bin/env node
// check-agent-surface.mjs —— 判据（覆盖施工单 Task 2／3 ＋ R43 的能力面收窄）：
//   ① **只读面（m1）里 `kind === 'write'` 的条数 = 0**（`INV-KB-readonly-surface`）
//   ② **面的描述里不出现内部标识**（窄名单 ✓，`INV-KB-tool-desc-clean`）
//   ③ 面与注册表**逐字节一致**（生成物漂移 ⇒ 红 ✓）
//   ④ **能力面必须限于「笔记域」**（`INV-KB-agent-priv-separation`，来由＝R43：
//      「笔记库权限 与 代码仓权限 没有区分」✗）—— 判据三条，刻意窄、不做子串猜测 ✓：
//      ⑴ id 必须落在**笔记域前缀集**里 ⑵ `kind` 只能是 read／write（**不许 `host`**）
//      ⑶ `scope` 必须是 `current-space`（不许"全局" ✗）
//      ⇒ 今天实测这 10 条全绿 ✓；将来谁把**文件系统／命令／网络**类能力挂上 `ai:true` ⇒ **必红** ✓
//
// 为什么把四条合在一个门禁（与施工单的差异，如实记 ✓）：
//   它们读的是**同一份生成物／同一个注册表**；拆开等于把同一份生成跑几遍 ⇒ 更慢、更容易不一致 ✓
//
// 窄名单的来路（2026-09-28 实测，不是猜 ✓）：注册表 25 条 `desc` 里 `content_json` 出现 **1** 次
//   （在 `page.current`，而它**不是** `ai:true` ✓）；其余名单内串全 **0** 次 ⇒
//   **不用 `json` 这种宽词** ✗（`files.read` 的描述里就有"json"，那是用户看得懂的正常说法 ✓）
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 注册表读不到或 phase 非法（**不算通过**）
// 用法：node scripts/check-agent-surface.mjs ／ --self-test ／ --phase m1 --file <路径> ／ --registry <路径>

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY, PHASES, renderSurface, surfacePath } from "./gen-agent-tool-surface.mjs";

export const INTERNAL_MARKERS = [
  "content_json", "content_text", "workspace_id", "deleted_at",
  "src/", "src-tauri", "plugins.rs", "ipc", "invoke",
  "capabilities.json", "apply.ts", "crdt",
];
export const NOTE_ID_PREFIXES = [
  "pages.", "blocks.", "backlinks.", "files.", "coverage.",
  "tags.", "links.", "search.", "media.", "attachments.", "spaces.",
];
export const ALLOWED_AI_KINDS = ["read", "write"];
export const ALLOWED_AI_SCOPE = "current-space";

function firstDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if ((A[i] ?? "<缺行>") !== (B[i] ?? "<缺行>")) return "第 " + (i + 1) + " 行不同：\n    盘上：" + (A[i] ?? "<缺行>") + "\n    应为：" + (B[i] ?? "<缺行>");
  }
  return "";
}

/** 纯判据：应为文本 ＋ 盘上文本 ＋ 注册表文本 ⇒ findings（空＝干净 ✓） */
export function judge(expected, actual, phase, registryText) {
  const out = [];
  const reg = registryText ?? (existsSync(REGISTRY) ? readFileSync(REGISTRY, "utf8") : "");
  if (actual === null) { out.push("✗ 面清单缺失：" + surfacePath(phase) + " —— 跑 `node scripts/gen-agent-tool-surface.mjs --phase " + phase + "` 生成 ✓"); return out; }
  // ③ 逐字节
  if (expected !== actual) out.push("✗ 面与注册表不一致： " + firstDiff(actual, expected));
  if (!reg) { out.push("✗ 读不到能力注册表 ⇒ **不算通过**"); return out; }
  const j = JSON.parse(reg);
  const caps = (j.capabilities || []).filter((c) => c.ai === true);
  // ① 只读面不许出现写能力（以**注册表**为准 ✓）
  if (phase === "m1") {
    const ids = actual.split("\n").filter((l) => /^\| [a-z0-9_.]+ \|/.test(l)).map((l) => l.split("|")[1].trim());
    const aiRead = caps.filter((c) => c.kind === "read").map((c) => c.id).sort();
    const aiWrite = caps.filter((c) => c.kind === "write").map((c) => c.id);
    const leaked = ids.filter((id) => aiWrite.includes(id));
    if (leaked.length) out.push("✗ 只读面里出现写能力 " + leaked.length + " 条：" + leaked.join(", ") + "（`kind === 'write'` 应为 0 ✓）");
    const missing = aiRead.filter((id) => !ids.includes(id));
    if (missing.length) out.push("✗ 只读面缺 " + missing.length + " 条（注册表里 `ai && kind==='read'` 应为 " + aiRead.length + " 条）：" + missing.join(", "));
  }
  // ② 描述里不许出现内部标识 —— **只扫表格里的 desc 格**，不扫表头/说明行 ✗
  //    ⚠️ 表头本来就写着"从 capabilities/capabilities.json 生成"；全文件扫会把**判据自己的溯源信息**当违规 ✗
  const descCells = actual.split("\n").filter((l) => /^\| [a-z0-9_.]+ \|/.test(l)).map((l) => (l.split("|")[4] || ""));
  for (const m of INTERNAL_MARKERS) {
    if (descCells.some((d) => d.includes(m))) out.push("✗ 描述里出现内部标识「" + m + "」—— 工具面＝对外暴露面 ✓");
  }
  // ④ 能力面必须限于「笔记域」
  for (const c of caps) {
    const id = String(c.id);
    if (!NOTE_ID_PREFIXES.some((p) => id.startsWith(p))) out.push("✗ `ai:true` 的能力「" + id + "」不在**笔记域**前缀集里 ⇒ 这是把**库以外**的东西暴露给了 agent ✗（R43：库权限 ≠ 仓库权限 ✓）");
    if (!ALLOWED_AI_KINDS.includes(c.kind)) out.push("✗ `ai:true` 的能力「" + id + "」的 `kind` 是 `" + c.kind + "` ⇒ 只许 read／write（**不许 host** ✓）");
    if (c.scope !== ALLOWED_AI_SCOPE) out.push("✗ `ai:true` 的能力「" + id + "」的 `scope` 是 `" + c.scope + "` ⇒ 只许 `" + ALLOWED_AI_SCOPE + "`（不许全局 ✗）");
  }
  return out;
}

export function run(phase, file, registryPath) {
  if (!PHASES[phase]) { console.error("✗ --phase 只接受 m1 / m2（**不算通过**）"); return 2; }
  const regPath = registryPath ?? REGISTRY;
  if (!existsSync(regPath)) { console.error("✗ 读不到能力注册表（**不算通过**）"); return 2; }
  const reg = readFileSync(regPath, "utf8");
  const expected = renderSurface(reg, phase);
  const actual = existsSync(file) ? readFileSync(file, "utf8") : null;
  const f = judge(expected, actual, phase, reg);
  if (f.length) { for (const x of f) console.error(x); return 1; }
  const n = (JSON.parse(reg).capabilities || []).filter((c) => c.ai === true && c.kind === PHASES[phase]).length;
  const aiAll = (JSON.parse(reg).capabilities || []).filter((c) => c.ai === true).length;
  console.log("✓ " + phase + " 面与注册表一致（" + n + " 条）｜ 写能力 " + (phase === "m1" ? "0" : n) + " 条 ｜ 描述无内部标识 ✓ ｜ 能力面限于笔记域（`ai:true` 共 " + aiAll + " 条 ✓）");
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "surface-"));
  try {
    const reg = readFileSync(REGISTRY, "utf8");
    const good = renderSurface(reg, "m1");
    const withWrite = good.replace(/(\| pages\.get \|)/, "| pages.create | current-space | write:pages | 新建页面 |\n$1");
    const withMarker = good.replace("读取单个页面的标题", "读取 content_json 里的正文");
    const badReg = JSON.stringify({
      apiVersion: "1.0.0", registryVersion: "1",
      capabilities: [
        { id: "pages.get", kind: "read", scope: "current-space", permission: "read:pages", ai: true, desc: "读页面" },
        { id: "fs.read", kind: "host", scope: "global", permission: "host:fs", ai: true, desc: "读任意文件" },
      ],
    });
    const badSurface = renderSurface(badReg, "m1");
    const cases = [
      ["合规面 ⇒ 空", judge(good, good, "m1", reg).length === 0],
      ["塞进一个写能力 ⇒ 有 finding", judge(good, withWrite, "m1", reg).some((s) => s.includes("写能力"))],
      ["描述里带 content_json ⇒ 有 finding", judge(good, withMarker, "m1", reg).some((s) => s.includes("content_json"))],
      ["面缺失 ⇒ 有 finding 且含'缺失'", judge(good, null, "m1", reg).some((s) => s.includes("缺失"))],
      ["漂移 ⇒ finding 指出行号", judge(good, good.replace("| current-space |", "| 改过 |"), "m1", reg).some((s) => s.includes("行"))],
      ["④ 库外能力(fs.read) ⇒ 红", judge(badSurface, badSurface, "m1", badReg).some((s) => s.includes("不在**笔记域**"))],
      ["④ host 类 ⇒ 红", judge(badSurface, badSurface, "m1", badReg).some((s) => s.includes("不许 host"))],
      ["④ 全局 scope ⇒ 红", judge(badSurface, badSurface, "m1", badReg).some((s) => s.includes("不许全局"))],
      ["④ 真实注册表 ⇒ ④ 不报（今天全绿 ✓）", judge(good, good, "m1", reg).every((s) => !s.includes("笔记域"))],
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
const ri = argv.indexOf("--registry");
process.exit(run(phase, fi >= 0 ? argv[fi + 1] : surfacePath(phase), ri >= 0 ? argv[ri + 1] : undefined));
