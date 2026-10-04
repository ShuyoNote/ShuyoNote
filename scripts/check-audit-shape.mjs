#!/usr/bin/env node
// check-audit-shape.mjs —— 审计的**形状**判据（`INV-KB-audit-shape`，纯读 Rust 源码 ⇒ **不需要 cargo** ✓）
//
// 挡的是哪次真实事故（incident，2026-09-29 读数）：
//   `push_audit(plugin_id, capability, scope, ok, error_code)` 是**内存环形队列**（容量 500），
//   写它的**只有 `plugins.rs` 一个文件**（实测 ✓）。但当"外部助手也能调能力"落地时（M2），
//   审计要能回答"**是谁**"（人／插件／外部 Agent）与"**哪次会话**"—— 而 `plugin_id` 答不了 ✓
//   ⇒ 在补字段之前，先把**今天已经成立的三条形状**钉死，别在补字段的路上把形状弄坏 ✗
//
// 判据三条（都窄，且**今天全绿** ✓）：
//   ① **入口唯一**：写审计的 `.rs` 文件只能有一个（今天＝`plugins.rs` ✓）
//   ② **不含正文**：审计条目结构体的字段名不许出现 content／body／text／payload／json 等
//      （审计只放元数据 ✓ —— 它不该变成第二份内容副本 ✗）
//   ③ **只增**：审计源码里不许出现对审计存储的 `UPDATE`／`DELETE FROM`
//      （容量裁剪用 `pop_front` 是允许的 ✓；"清空日志"是显式用户动作，不算改写单条 ✓）
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 源码树不在（**不算通过**）
// 用法：node scripts/check-audit-shape.mjs ／ --root <目录>（夹具 ✓）／ --self-test

import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const SRC = join(ROOT, "src-tauri", "src");
const CONTENT_MARKERS = ["content", "body", "payload", "attachment_text", "content_json", "snapshot"];

function rsFiles(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) rsFiles(p, out);
    else if (e.endsWith(".rs")) out.push(p);
  }
  return out;
}

/** 纯判据：一堆 {path, text} ⇒ findings（空＝干净 ✓） */
export function judge(sources) {
  const out = [];
  const auditWriters = [];
  let structFields = null;
  for (const { path, text } of sources) {
    // 谁在写审计队列？（定义或入队都算）
    if (/PLUGIN_AUDIT|push_audit|push_run_audit/.test(text)) auditWriters.push(path);
    // ② 结构体字段
    const m = text.match(/struct\s+PluginAuditEntry\s*\{([\s\S]*?)\n\}/);
    if (m) structFields = m[1];
    // ③ 只增
    if (/(UPDATE\s+\w*audit|DELETE\s+FROM\s+\w*audit)/i.test(text)) {
      out.push("✗ 审计源码里出现了对审计存储的改写/删除：" + path + " ⇒ 审计必须**只增** ✓");
    }
  }
  // ① 入口唯一
  if (auditWriters.length === 0) out.push("✗ 找不到任何写审计的地方 ⇒ 判据**没检查到东西**（不算通过 ✗）");
  else if (auditWriters.length > 1) {
    out.push("✗ 写审计的文件有 " + auditWriters.length + " 个 ⇒ 必须**入口唯一**（那样审计才能覆盖所有能力调用 ✓）：\n     " + auditWriters.join("\n     "));
  }
  // ② 不含正文
  if (structFields === null) out.push("✗ 找不到 `PluginAuditEntry` 结构体 ⇒ 判据**没检查到东西**（不算通过 ✗）");
  else {
    const bad = CONTENT_MARKERS.filter((mk) => new RegExp("^\\s*(pub\\s+)?\\w*" + mk, "im").test(structFields));
    if (bad.length) out.push("✗ 审计条目的字段里出现内容类名字「" + bad.join("／") + "」⇒ 审计只放元数据（不许变成第二份内容副本 ✗）");
  }
  return out;
}

function run(root) {
  const src = join(root, "src-tauri", "src");
  if (!existsSync(src)) { console.error("✗ 源码树不在：" + src + "（**不算通过**）"); return 2; }
  const files = rsFiles(src);
  if (files.length === 0) { console.error("✗ 一个 `.rs` 都没扫到（**不算通过**）"); return 2; }
  const f = judge(files.map((p) => ({ path: p.slice(src.length + 1).replace(/\\/g, "/"), text: readFileSync(p, "utf8") })));
  if (f.length) { for (const x of f) console.error(x); return 1; }
  console.log("✓ 审计形状三条成立：入口唯一（写审计的 `.rs` 只有 1 个 ✓）｜ 条目不含正文 ✓ ｜ 只增（无 UPDATE／DELETE ✓）");
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "audit-shape-"));
  try {
    const good = [{ path: "plugins.rs", text: 'struct PluginAuditEntry {\n    plugin_id: String,\n    capability: String,\n    scope: String,\n    ok: bool,\n    error_code: Option<String>,\n}\nstatic PLUGIN_AUDIT: Mutex<VecDeque<PluginAuditEntry>> = todo!();\nfn push_audit() {}\n' }];
    const twoWriters = [...good, { path: "mcp.rs", text: 'fn push_audit() {}\n' }];
    const withBody = [{ path: "plugins.rs", text: 'struct PluginAuditEntry {\n    capability: String,\n    content_json: String,\n}\nstatic PLUGIN_AUDIT: Mutex<VecDeque<PluginAuditEntry>> = todo!();\n' }];
    const withDelete = [{ path: "plugins.rs", text: 'struct PluginAuditEntry {\n    capability: String,\n}\nstatic PLUGIN_AUDIT: Mutex<VecDeque<PluginAuditEntry>> = todo!();\nfn x(){ conn.execute("DELETE FROM plugin_audit WHERE id=?", []); }\n' }];
    const nothing = [{ path: "lib.rs", text: "fn main() {}\n" }];
    const cases = [
      ["合规 ⇒ 空", judge(good).length === 0],
      ["两个写者 ⇒ 红（入口唯一 ✓）", judge(twoWriters).some((s) => s.includes("入口唯一"))],
      ["条目带 content_json ⇒ 红", judge(withBody).some((s) => s.includes("内容类名字"))],
      ["出现 DELETE FROM audit ⇒ 红", judge(withDelete).some((s) => s.includes("只增"))],
      ["什么都没扫到 ⇒ 红（不许假绿 ✗）", judge(nothing).length >= 2],
    ];
    let pass = 0;
    for (const [n, ok] of cases) { console.log((ok ? "  ✓ " : "  ✗ ") + n); if (ok) pass++; }
    console.log("self-test: " + pass + "/" + cases.length + " 通过");
    process.exit(pass === cases.length ? 0 : 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const ri = argv.indexOf("--root");
process.exit(run(ri >= 0 ? argv[ri + 1] : ROOT));
