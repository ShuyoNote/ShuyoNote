#!/usr/bin/env node
// check-derived-provenance.mjs —— 「派生内容必须自证"从哪来"」的类型级判据（`INV-KB-derived-provenance`）
//
// 来由（2026-09-29 读数，且**推翻了我先前一句错的台账描述** ✗）：
//   我先写「库条目还没有来源字段」—— 读数说：`source` 列确实有，但**只属于插件两表**
//   （`plugin_install.source` 默认 'local' ／ `plugin_publisher_key.source` ✓）；**内容**层面没有 ✗。
//   而**派生内容**这边**早已有**"从哪来"的强制字段：`ExtractedSegment` 的
//     `kind: SegmentKind` ＋ `loc: string`（**都必填** ✓，类型注释：「决定检索侧如何展示与加权，
//     也决定 loc 的格式」✓）—— 检索、引用、加权全靠它 ✓ ⇒ 它是**引用链的地基** ✓
//   ⇒ 地基若被改成可选（`loc?: string`），引用/定位能力会**静默**降级 ✗ ⇒ 值得一条判据 ✓
//
// 判据（窄，且**今天全绿** ✓；纯读 TS 源码 ⇒ 不需要 Chromium／cargo ✓）：
//   ① `src/lib/extract/types.ts` 里 `ExtractedSegment` 的 `kind` 与 `loc` **必须是必填**（不许 `?`）
//   ② `SegmentKind` 联合类型必须存在**且非空**（至少 3 个成员 —— 只有一种就等于没区分 ✓）
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 读不到 types.ts（**不算通过**）
// 用法：node scripts/check-derived-provenance.mjs ／ --file <路径>（夹具 ✓）／ --self-test

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const TYPES = join(ROOT, "src", "lib", "extract", "types.ts");
const MIN_KINDS = 3;

/** 纯判据：types.ts 文本 ⇒ findings（空＝干净 ✓） */
export function judge(text) {
  const out = [];
  const m = text.match(/export\s+interface\s+ExtractedSegment\s*\{([\s\S]*?)\n\}/);
  if (!m) { out.push("✗ 找不到 `interface ExtractedSegment` ⇒ 判据**没检查到东西**（不算通过 ✗）"); return out; }
  const body = m[1];
  for (const f of ["kind", "loc"]) {
    const opt = new RegExp("^\\s*" + f + "\\??\\s*:", "m").exec(body);
    if (!opt) { out.push("✗ `ExtractedSegment` 里没有 `" + f + "` ⇒ 派生内容失去「从哪来」✓"); continue; }
    if (opt[0].includes("?")) out.push("✗ `ExtractedSegment." + f + "` 被改成**可选**（`" + f + "?`）⇒ 引用/定位会**静默**降级 ✗");
  }
  const u = text.match(/export\s+type\s+SegmentKind\s*=([\s\S]*?);/);
  if (!u) out.push("✗ 找不到 `type SegmentKind` ⇒ 判据**没检查到东西**（不算通过 ✗）");
  else {
    const n = (u[1].match(/"[a-z_]+"/g) || []).length;
    if (n < MIN_KINDS) out.push("✗ `SegmentKind` 只有 " + n + " 个成员（少于 " + MIN_KINDS + "）⇒ 等于没在区分来源/位置 ✓");
  }
  return out;
}

function run(file) {
  if (!existsSync(file)) { console.error("✗ 读不到 " + file + "（**不算通过**）"); return 2; }
  const f = judge(readFileSync(file, "utf8"));
  if (f.length) { for (const x of f) console.error(x); return 1; }
  console.log("✓ 派生内容自证来源：`ExtractedSegment.kind` ＋ `.loc` **必填** ✓ ｜ `SegmentKind` 成员数 >= " + MIN_KINDS + " ✓");
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "derived-prov-"));
  try {
    const good = 'export type SegmentKind = "text" | "ocr" | "transcript";\nexport interface ExtractedSegment {\n  kind: SegmentKind;\n  loc: string;\n}\n';
    const optLoc = good.replace("  loc: string;", "  loc?: string;");
    const noKind = good.replace('export type SegmentKind = "text" | "ocr" | "transcript";\n', "");
    const thin = good.replace('"text" | "ocr" | "transcript"', '"text"');
    const cases = [
      ["合规 ⇒ 空", judge(good).length === 0],
      ["loc 变可选 ⇒ 红", judge(optLoc).some((s) => s.includes("可选"))],
      ["缺 SegmentKind ⇒ 红", judge(noKind).some((s) => s.includes("SegmentKind"))],
      ["成员太少 ⇒ 红", judge(thin).some((s) => s.includes("少于"))],
      ["缺接口 ⇒ 红（不许假绿 ✗）", judge("const x = 1;\n").some((s) => s.includes("没检查到东西"))],
      ["文件不在 ⇒ exit 2", run(join(dir, "nope.ts")) === 2],
    ];
    let pass = 0;
    for (const [n, ok] of cases) { console.log((ok ? "  ✓ " : "  ✗ ") + n); if (ok) pass++; }
    console.log("self-test: " + pass + "/" + cases.length + " 通过");
    process.exit(pass === cases.length ? 0 : 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const fi = argv.indexOf("--file");
process.exit(run(fi >= 0 ? argv[fi + 1] : TYPES));
