#!/usr/bin/env node
// check-ontology-generated.mjs —— 判据：**本体表必须与能力注册表逐字节一致**
//
// 挡的是哪次真实事故（incident）：
//   2026-09-28：MCP 规格把 `isWrite: true` 当作判据（**该字段在原始 JSON 里出现 0 次** ✗，
//   真实字段是 `kind`）—— 凭印象引用注册表字段，写出了"看着像判据、其实指向空气"的规则。
//   同一类错误当天还有一次：我从**6 条样本**外推"`pages.create` 不在注册表里" ✗（实际在）。
//   ⇒ 唯一出路：本体**由注册表生成**，并用本门禁**逐字节**卡住漂移 ✓
//
// 判据：`_generated/knowledge-ontology.md` 必须等于"现场重新生成"的文本 ✓
// 口径：① 文件不在 ⇒ **exit 1**（含"缺口"逐字）—— 不是环境问题，是**缺生成物** ✓
//       ② 内容漂移 ⇒ exit 1，并打出**第一处不同**（行号 ＋ 两边的原文 ✓）
//       ③ 注册表本身读不到 ⇒ exit 2（**不算通过**）
// 用法：node scripts/check-ontology-generated.mjs ／ --self-test ／ --file <路径>（夹具用 ✓）

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY, OUTPUT, renderOntology } from "./gen-knowledge-ontology.mjs";

function firstDiff(a, b) {
  const A = a.split("\n");
  const B = b.split("\n");
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if ((A[i] ?? "<缺行>") !== (B[i] ?? "<缺行>")) {
      return "第 " + (i + 1) + " 行不同：\n    盘上：" + (A[i] ?? "<缺行>") + "\n    应为：" + (B[i] ?? "<缺行>");
    }
  }
  return "";
}

/** 纯判据：给定"应为文本"与"盘上文本" ⇒ 返回 finding 字符串（空串＝一致 ✓） */
export function judge(expected, actual, label) {
  if (actual === null) return "✗ 本体表缺失：" + label + " —— 跑 `node scripts/gen-knowledge-ontology.mjs` 生成 ✓";
  if (expected === actual) return "";
  return "✗ 本体表与注册表不一致（" + label + "）：" + firstDiff(actual, expected);
}

function run(file) {
  if (!existsSync(REGISTRY)) { console.error("✗ 读不到能力注册表：" + REGISTRY + "（**不算通过**）"); return 2; }
  const expected = renderOntology(readFileSync(REGISTRY, "utf8"));
  const actual = existsSync(file) ? readFileSync(file, "utf8") : null;
  const f = judge(expected, actual, file);
  const caps = (JSON.parse(readFileSync(REGISTRY, "utf8")).capabilities || []).length;
  if (f) { console.error(f); console.error("  （注册表现有 " + caps + " 条能力 ⇒ 以注册表为准 ✗）"); return 1; }
  console.log("✓ 本体表与注册表一致（" + caps + " 条能力，逐字节 ✓）");
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "ont-gen-"));
  try {
    const good = renderOntology(readFileSync(REGISTRY, "utf8"));
    const p = join(dir, "good.md");
    writeFileSync(p, good, "utf8");
    const bad = join(dir, "bad.md");
    writeFileSync(bad, good.replace(/\| read \|/, "| 写错 |"), "utf8");
    const missing = join(dir, "nope.md");
    const cases = [
      ["一致 ⇒ 空", judge(good, good, p) === ""],
      ["漂移 ⇒ 有 finding", judge(good, good.replace(/\| read \|/, "| 写错 |"), p) !== ""],
      ["文件缺失 ⇒ 有 finding 且含'缺失'", (() => { const f = judge(good, null, missing); return f.includes("缺失"); })()],
      ["finding 里能指出**行号**", judge(good, good.replace(/\| read \|/, "| 写错 |"), p).includes("行")],
    ];
    let pass = 0;
    for (const [n, ok] of cases) { console.log((ok ? "  ✓ " : "  ✗ ") + n); if (ok) pass++; }
    console.log("self-test: " + pass + "/" + cases.length + " 通过");
    process.exit(pass === cases.length ? 0 : 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const fi = argv.indexOf("--file");
process.exit(run(fi >= 0 ? argv[fi + 1] : OUTPUT));
