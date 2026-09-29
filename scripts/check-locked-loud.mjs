#!/usr/bin/env node
// check-locked-loud.mjs —— 「锁定 ⇒ 大声失败，不许返回空」的**静态**判据（`INV-KB-locked-loud` / MCP 那句）
//
// 挡的是哪次真实事故（为什么它危险）：
//   加密空间在会话未解锁时，若把错误**吞掉**、返回**空结果**，用户看到的是"没内容" ✓ ——
//   而真相是"**你还没解锁**" ✗ ⇒ 他会以为数据丢了／搜不到，然后去找备份、去重装 ✓
//   这正是工作区反复罚的那族：**把"我不知道"说成"没有"** ✗
//
// 今天已有的实现（2026-09-29 实测读数，**不是愿望** ✓）：
//   · `plugins.rs:1386-1387`：`if e.contains("会话未解锁") || e.contains("locked") { "space_locked: …" }` ✓
//   · 代码注释原话：「加密空间在会话锁定时会走到 `space_locked`——插件调用不能成为绕过启动锁的通路」
//   · 单测 `plugins.rs:7613 fn locked_space_maps_to_a_stable_error_code()` ✓ 断言 `starts_with("space_locked")`
//   ⇒ 所以本判据**不发明新规矩**，只是把"这三样必须同时存在"钉成机器可核 ✓
//
// 判据四条（窄；**今天全绿** ✓；纯读 Rust 源码 ⇒ **不需要 cargo** ✓）：
//   ① 必须存在 `map_open_error`（锁定/打开失败的统一映射点 ✓）
//   ② 它的函数体里必须出现稳定错误码 `space_locked`
//   ③ 它的函数体里**不许**把锁定映射成空（不许 `String::new()` ／ `"".to_string()`）
//   ④ 必须存在钉它的单测 `locked_space_maps_to_a_stable_error_code`
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 读不到源码（**不算通过**）
// 用法：node scripts/check-locked-loud.mjs ／ --file <路径>（夹具 ✓）／ --self-test

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const PLUGINS = join(ROOT, "src-tauri", "src", "plugins.rs");
const CODE = "space_locked";
const TEST_FN = "locked_space_maps_to_a_stable_error_code";

/** 取一个函数的大致函数体：从 `fn name` 到下一个顶层 `\nfn ` 或文件末 */
export function fnBody(text, name) {
  const i = text.search(new RegExp("fn\\s+" + name + "\\b"));
  if (i < 0) return null;
  const rest = text.slice(i);
  const j = rest.search(/\n(?:pub\s+)?fn\s+/);
  return j > 0 ? rest.slice(0, j) : rest;
}

/** 纯判据：plugins.rs 文本 ⇒ findings（空＝干净 ✓） */
export function judge(text) {
  const out = [];
  const body = fnBody(text, "map_open_error");
  if (body === null) out.push("✗ 找不到 `map_open_error` ⇒ 锁定/打开失败**没有统一映射点**（判据**没检查到东西** ⇒ 不算通过 ✗）");
  else {
    if (!body.includes(CODE)) out.push("✗ `map_open_error` 里没有稳定错误码 `" + CODE + "` ⇒ **锁定不再是大声明** ✗（调用方只能靠猜 ✓）");
    if (/String::new\(\)|""\.to_string\(\)/.test(body)) out.push("✗ `map_open_error` 把某类失败映射成**空字符串** ⇒ 「我不知道」会被说成「没有」✗");
  }
  if (!new RegExp("fn\\s+" + TEST_FN + "\\b").test(text)) {
    out.push("✗ 找不到钉它的单测 `" + TEST_FN + "` ⇒ 这条不变式**没有承重渠道**（改了没人红 ✗）");
  }
  return out;
}

function run(file) {
  if (!existsSync(file)) { console.error("✗ 读不到 " + file + "（**不算通过**）"); return 2; }
  const f = judge(readFileSync(file, "utf8"));
  if (f.length) { for (const x of f) console.error(x); return 1; }
  console.log("✓ 锁定会大声失败：`map_open_error` 有稳定码 `" + CODE + "` ✓ ｜ 不映射成空 ✓ ｜ 单测 `" + TEST_FN + "` 在 ✓");
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "locked-loud-"));
  try {
    const good = 'fn map_open_error(e: String) -> String {\n    if e.contains("locked") { return "space_locked: x".to_string(); }\n    e\n}\n#[test]\nfn locked_space_maps_to_a_stable_error_code() { assert!(true); }\n';
    const noMap = good.replace("fn map_open_error", "fn other");
    const silent = good.replace('if e.contains("locked") { return "space_locked: x".to_string(); }', 'if e.contains("locked") { return String::new(); }');
    const noTest = good.replace('fn locked_space_maps_to_a_stable_error_code() { assert!(true); }', 'fn something_else() {}');
    const cases = [
      ["合规 ⇒ 空", judge(good).length === 0],
      ["缺 map_open_error ⇒ 红", judge(noMap).some((s) => s.includes("没检查到东西"))],
      ["映射成空 ⇒ 红", judge(silent).some((s) => s.includes("空字符串")) || judge(silent).some((s) => s.includes("space_locked"))],
      ["缺单测 ⇒ 红（没有承重渠道 ✗）", judge(noTest).some((s) => s.includes("承重渠道"))],
      ["文件不在 ⇒ exit 2", run(join(dir, "nope.rs")) === 2],
    ];
    let pass = 0;
    for (const [n, ok] of cases) { console.log((ok ? "  ✓ " : "  ✗ ") + n); if (ok) pass++; }
    console.log("self-test: " + pass + "/" + cases.length + " 通过");
    process.exit(pass === cases.length ? 0 : 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const fi = argv.indexOf("--file");
process.exit(run(fi >= 0 ? argv[fi + 1] : PLUGINS));
