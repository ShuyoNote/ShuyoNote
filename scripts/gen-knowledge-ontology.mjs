#!/usr/bin/env node
// gen-knowledge-ontology.mjs —— 从能力注册表**生成**知识层本体表（唯一的源是 capabilities.json ✓）
//
// 为什么必须生成（incident，2026-09-28 实测）：
//   MCP 规格里写着「M1 不许出现 `isWrite: true` 的 `pages.create` / `blocks.append`」，
//   而**原始 JSON 里 `isWrite` 出现 0 次** ✗（真实字段是 `kind`：read 15 / write 8 / host 2）——
//   也就是说：**凭印象引用注册表字段**会写出"看起来像判据、其实指向空气"的规则。
//   ⇒ 本体表必须**由注册表生成**，不许手抄第二份 ✓（这也正是本仓"门禁清单唯一出处"的同一条课）
//
// 用法：
//   node scripts/gen-knowledge-ontology.mjs            # 写入 _generated/knowledge-ontology.md
//   node scripts/gen-knowledge-ontology.mjs --stdout    # 只打印（判据用它比对 ✓，不写盘）
// 退出码：0 生成成功 ／ 2 读不到注册表（**不算通过**）

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const REGISTRY = join(ROOT, "capabilities", "capabilities.json");
export const OUTPUT = join(ROOT, "_generated", "knowledge-ontology.md");

/** 生成本体表文本（**纯函数**：给定注册表 JSON 文本 ⇒ 固定输出 ✓ 便于判据逐字节比） */
export function renderOntology(registryText) {
  const j = JSON.parse(registryText);
  const caps = [...(j.capabilities || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const sha = createHash("sha256").update(registryText).digest("hex");
  const byKind = {};
  for (const c of caps) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
  const kindLine = Object.keys(byKind).sort().map((k) => k + " " + byKind[k]).join(" / ");
  const L = [];
  L.push("# 知识层本体（**生成物 —— 不要手改** ✗）");
  L.push("");
  L.push("> 由 `scripts/gen-knowledge-ontology.mjs` 从 `capabilities/capabilities.json` 生成 ✓");
  L.push("> 判据：`node scripts/check-ontology-generated.mjs`（与注册表逐字节一致；不一致就红 ✓）");
  L.push("");
  L.push("| 源 | 值 |");
  L.push("|---|---|");
  L.push("| 注册表文件 | `capabilities/capabilities.json` |");
  L.push("| 注册表 sha256 | `" + sha + "` |");
  L.push("| `registryVersion` | " + (j.registryVersion ?? "（无）") + " |");
  L.push("| `apiVersion` | " + (j.apiVersion ?? "（无）") + " |");
  L.push("| 能力条数 | **" + caps.length + "**（按 `kind`：" + kindLine + "） |");
  L.push("| 生成命令 | `node scripts/gen-knowledge-ontology.mjs` |");
  L.push("");
  L.push("| id | kind | scope | permission | ai | mediate | desc |");
  L.push("|---|---|---|---|---|---|---|");
  for (const c of caps) {
    const cell = (v) => (v === undefined || v === null || v === "" ? "—" : String(v).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim());
    L.push("| " + cell(c.id) + " | " + cell(c.kind) + " | " + cell(c.scope) + " | " + cell(c.permission) + " | " + (c.ai ? "✓" : "") + " | " + (c.mediate ? "✓" : "") + " | " + cell(c.desc) + " |");
  }
  L.push("");
  return L.join("\n");
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("gen-knowledge-ontology.mjs");
if (isMain) {
  let text;
  try {
    text = readFileSync(REGISTRY, "utf8");
  } catch (e) {
    console.error("✗ 读不到能力注册表：" + REGISTRY + "（**不算通过**）");
    process.exit(2);
  }
  const out = renderOntology(text);
  if (process.argv.includes("--stdout")) {
    process.stdout.write(out);
  } else {
    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, out, "utf8");
    console.log("✓ 已生成 " + OUTPUT.replace(ROOT, ".").replace(/\\/g, "/"));
    console.log("  能力条数：" + (JSON.parse(text).capabilities || []).length + "（**以注册表为准，别抄这个数** ✗）");
  }
}
