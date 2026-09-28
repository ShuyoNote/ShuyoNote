#!/usr/bin/env node
/**
 * gen-deploy-manifest.mjs —— **生成/校验「本地与线上对账用的文件清单」**，并且**自己写 LF**。
 *
 * 为什么有它（真事故，逐字在 `docs/RELEASING.md`）：
 *   「**清单文件必须是 LF —— 否则 `comm` 会把线上整个目录判成"多余"全删掉
 *     （2026-09-21 v1.91.19 实际踩到，网站空了约 3 分钟）**：
 *     PowerShell 5.1 的 `Set-Content -Encoding ascii`（以及 `Out-File`）写的是 **CRLF**，
 *     每行尾多一个 `\r`，而服务器 `find | sort` 出来的是 LF ⇒ 两边没有一行相等
 *     ⇒ `comm -23` 把**全部**文件判成"服务器多余"。现场读数：本地清单 311 个文件 /
 *     服务器原有 416 个 / 服务器多余（将删）416 个 ⇒ 同步后 0 个文件。」
 *
 * ⇒ 那次事故的根因是**手工步骤里"记得写 LF"**（而重定向/`Set-Content` 天生给 CRLF）。
 *   本脚本把这件事变成**构造上不可能出错**：**它自己写文件**（`\n` ＋ UTF-8 无 BOM），
 *   并且**写完自检**（重读一遍断言没有 `\r`），另提供 `--check` 在**上传前**校验手上那份清单。
 *
 * 用法：
 *   node scripts/gen-deploy-manifest.mjs --dir dist-web --out manifest.txt      # 生成（自己写 LF）
 *   node scripts/gen-deploy-manifest.mjs --check manifest.txt --dir dist-web    # 校验（CRLF / 陈旧 / 顺序）
 *   node scripts/gen-deploy-manifest.mjs --self-test                            # 判据自测（纯函数）
 *
 * 退出码：0 成功/校验通过 ｜ 1 校验发现差异 ｜ 2 用法或读文件失败（**不算通过**）
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 纯函数：把相对路径列表规范化成清单要写的那些行（POSIX 分隔、排序、去重、非空）。 */
export function manifestLines(paths) {
  return [...new Set(paths.map((p) => p.split(sep).join("/")).filter((p) => p && !p.endsWith("/")))].sort();
}

/** 纯函数：一份清单文本的问题（自测与 `--check` 都走它）。 */
export function judgeManifest({ text, expected }) {
  const problems = [];
  if (text.includes("\r")) {
    const n = (text.match(/\r/g) || []).length;
    problems.push(
      `**清单里有 ${n} 个 \`\\r\`（CRLF）** —— 与服务器 \`find | sort\` 的 LF **一行都不相等** ⇒ ` +
        `\`comm -23\` 会把线上**整个目录**判成"多余"全删掉（2026-09-21 v1.91.19 实际踩到，网站空了约 3 分钟）。`,
    );
  }
  if (text.charCodeAt(0) === 0xfeff) problems.push("清单带 UTF-8 BOM —— 第一行的文件名会多一个不可见字符，对账必错。");
  const got = text.split("\n").filter((l) => l.trim() !== "");
  const want = expected ?? null;
  if (want) {
    const extra = got.filter((l) => !want.includes(l));
    const missing = want.filter((l) => !got.includes(l));
    if (extra.length) problems.push(`清单里有 **${extra.length}** 行**不在目录里**（例：${extra.slice(0, 3).join("、")}）⇒ 这份清单陈旧或来自别的目录。`);
    if (missing.length) problems.push(`目录里有 **${missing.length}** 个文件**不在清单里**（例：${missing.slice(0, 3).join("、")}）⇒ 上传后会漏文件。`);
    const sorted = [...got].sort();
    if (got.join("\n") !== sorted.join("\n")) problems.push("清单**没排序** —— 与服务器 `find | sort` 的输出对不上（`comm` 要求两侧有序）。");
  }
  return problems;
}

/** 纯函数：列目录下所有文件（相对路径）。 */
export function walkFiles(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p, base));
    else if (e.isFile()) out.push(relative(base, p));
  }
  return out;
}

function selfTest() {
  const cases = [
    ["规范化：POSIX 分隔 + 排序 + 去重", manifestLines(["b/2.txt", "a/1.txt", "b/2.txt"]).join(","), "a/1.txt,b/2.txt"],
    ["⭐ CRLF 清单 ⇒ 判红（这是那次事故的根因）", judgeManifest({ text: "a.txt\r\nb.txt\r\n" }).length > 0, true],
    ["LF 清单 + 与目录一致 ⇒ 无问题", judgeManifest({ text: "a.txt\nb.txt\n", expected: ["a.txt", "b.txt"] }).length, 0],
    ["清单缺一个文件 ⇒ 判红", judgeManifest({ text: "a.txt\n", expected: ["a.txt", "b.txt"] }).length > 0, true],
    ["清单多一个文件 ⇒ 判红", judgeManifest({ text: "a.txt\nb.txt\nc.txt\n", expected: ["a.txt", "b.txt"] }).length > 0, true],
    ["未排序 ⇒ 判红（comm 要求两侧有序）", judgeManifest({ text: "b.txt\na.txt\n", expected: ["a.txt", "b.txt"] }).length > 0, true],
    ["BOM ⇒ 判红", judgeManifest({ text: "\uFEFFa.txt\n" }).length > 0, true],
  ];
  let fail = 0;
  for (const [n, got, want] of cases) {
    const ok = got === want;
    if (!ok) fail++;
    console.log(`${ok ? "✓" : "✗"} ${n}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
  }
  console.log(`\nself-test: ${cases.length - fail}/${cases.length} 通过`);
  return fail === 0;
}

const argv = process.argv.slice(2);
const val = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);

const dir = resolve(ROOT, val("--dir", "dist-web"));
const out = val("--out", null);
const checkPath = argv.includes("--check") ? resolve(ROOT, argv[argv.indexOf("--check") + 1] || "") : null;

if (!existsSync(dir)) {
  console.error(`✗ 目录不存在：${dir}（用法：--dir <目录>）⇒ exit 2，不算通过`);
  process.exit(2);
}
const expected = manifestLines(walkFiles(dir));

if (checkPath) {
  if (!existsSync(checkPath)) {
    console.error(`✗ 清单文件不存在：${checkPath} ⇒ exit 2，不算通过`);
    process.exit(2);
  }
  const text = readFileSync(checkPath, "utf8");
  const problems = judgeManifest({ text, expected });
  if (problems.length) {
    console.error(`✗ 清单不可用于对账（${checkPath}）：`);
    for (const p of problems) console.error(`   · ${p}`);
    console.error(`\n⇒ **先别拿它去 comm**（那一步是破坏性的）。用本脚本重新生成：`);
    console.error(`   node scripts/gen-deploy-manifest.mjs --dir ${relative(ROOT, dir)} --out ${relative(ROOT, checkPath)}`);
    process.exit(1);
  }
  console.log(`✓ 清单可用：${expected.length} 行、纯 LF、无 BOM、已排序、与 ${relative(ROOT, dir)} 逐行一致`);
  process.exit(0);
}

if (!out) {
  console.error("✗ 缺 `--out <文件>`（**不接受把输出重定向到文件** —— PowerShell 的 `>`/`Out-File` 写的是 CRLF/UTF-16，那正是 2026-09-21 那次事故的根因）⇒ exit 2");
  process.exit(2);
}
const abs = resolve(ROOT, out);
writeFileSync(abs, expected.join("\n") + "\n", "utf8"); // ⚠️ 只写 \n；不经过任何 shell 重定向
const back = readFileSync(abs, "utf8");
const problems = judgeManifest({ text: back, expected });
if (problems.length) {
  console.error(`✗ 写出来的清单自检不过（这不该发生）：`);
  for (const p of problems) console.error(`   · ${p}`);
  process.exit(1);
}
console.log(`✓ 已写 ${relative(ROOT, abs)}：${expected.length} 行、纯 LF、无 BOM、已排序（写完已重读自检）`);
console.log(`  前 3 行示例：${expected.slice(0, 3).join(" ｜ ")}`);
console.log(`  ⇒ 上传前可再校一次：node scripts/gen-deploy-manifest.mjs --check ${relative(ROOT, abs)} --dir ${relative(ROOT, dir)}`);
process.exit(0);
