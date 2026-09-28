#!/usr/bin/env node
// gen-agent-tool-surface.mjs —— 从能力注册表**生成**外部工具面清单（M1 只读 / M2 写）
//
// 为什么生成（incident 同 Task 1）：工具面**照抄注册表**，不许手写第二份 ✗ ——
//   2026-09-28 实测：注册表里 `ai: true` 恰好 **10 条**（`read` 8 ／ `write` 2），
//   而 MCP 规格里把"写判定"写成查 `isWrite` —— **该字段在原始 JSON 里出现 0 次** ✗（真实字段是 `kind`）。
//   ⇒ 面必须由注册表生成，且**只读面里出现任何 `kind === 'write'` 就红** ✓
//
// 用法：
//   node scripts/gen-agent-tool-surface.mjs --phase m1          # 只读面 ⇒ _generated/agent-tool-surface.m1.md
//   node scripts/gen-agent-tool-surface.mjs --phase m2          # 写面   ⇒ _generated/agent-tool-surface.m2.md
//   node scripts/gen-agent-tool-surface.mjs --phase m1 --stdout  # 只打印（判据比对用 ✓）
// 退出码：0 成功 ／ 2 注册表读不到或 phase 非法（**不算通过**）

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const REGISTRY = join(ROOT, "capabilities", "capabilities.json");
export const PHASES = { m1: "read", m2: "write" };

/** 纯函数：注册表文本 ＋ phase ⇒ 面清单文本（同输入必同输出 ✓） */
export function renderSurface(registryText, phase) {
  const want = PHASES[phase];
  if (!want) throw new Error("phase 非法：" + phase);
  const j = JSON.parse(registryText);
  const caps = [...(j.capabilities || [])].filter((c) => c.ai === true && c.kind === want).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const sha = createHash("sha256").update(registryText).digest("hex");
  const L = [];
  L.push("# 外部工具面：" + phase.toUpperCase() + "（" + (want === "read" ? "只读" : "可写") + "，**生成物 —— 不要手改** ✗）");
  L.push("");
  L.push("> 由 `scripts/gen-agent-tool-surface.mjs --phase " + phase + "` 从 `capabilities/capabilities.json` 生成 ✓");
  L.push("> 判据：`node scripts/check-agent-surface.mjs`（面 ≡ 注册表 ／ 只读面写能力数 = 0 ／ 描述无内部标识 ✓）");
  L.push("");
  L.push("| 源 | 值 |");
  L.push("|---|---|");
  L.push("| 注册表 sha256 | `" + sha + "` |");
  L.push("| `apiVersion` | " + (j.apiVersion ?? "（无）") + " |");
  L.push("| 取用条件 | `ai === true` **且** `kind === \"" + want + "\"` |");
  L.push("| 条数 | **" + caps.length + "** |");
  L.push("");
  L.push("| id | scope | permission | desc |");
  L.push("|---|---|---|---|");
  for (const c of caps) {
    const cell = (v) => (v === undefined || v === null || v === "" ? "—" : String(v).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim());
    L.push("| " + cell(c.id) + " | " + cell(c.scope) + " | " + cell(c.permission) + " | " + cell(c.desc) + " |");
  }
  L.push("");
  return L.join("\n");
}
export function surfacePath(phase) { return join(ROOT, "_generated", "agent-tool-surface." + phase + ".md"); }

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("gen-agent-tool-surface.mjs");
if (isMain) {
  const ai = process.argv.indexOf("--phase");
  const phase = ai >= 0 ? process.argv[ai + 1] : "";
  if (!PHASES[phase]) { console.error("✗ --phase 只接受 m1 / m2（**不算通过**）"); process.exit(2); }
  let text;
  try { text = readFileSync(REGISTRY, "utf8"); } catch { console.error("✗ 读不到能力注册表：" + REGISTRY + "（**不算通过**）"); process.exit(2); }
  const out = renderSurface(text, phase);
  if (process.argv.includes("--stdout")) process.stdout.write(out);
  else {
    mkdirSync(dirname(surfacePath(phase)), { recursive: true });
    writeFileSync(surfacePath(phase), out, "utf8");
    const n = (JSON.parse(text).capabilities || []).filter((c) => c.ai === true && c.kind === PHASES[phase]).length;
    console.log("✓ 已生成 " + surfacePath(phase).replace(ROOT, ".").replace(/\\/g, "/") + "（" + n + " 条，**以注册表为准别抄这个数** ✗）");
  }
}
