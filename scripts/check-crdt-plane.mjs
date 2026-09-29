#!/usr/bin/env node
// check-crdt-plane.mjs —— 「JSON 是权威落盘形态、Rust 不认识 CRDT、转换只有一份实现」
//
// 挡的是哪次真实事故（为什么值得一条判据）：
//   混版本共存的地基是**三句话**（见 `docs/specs/2026-09-29-crdt-mixed-version-degradation.md`）：
//     ① 权威落盘形态永远是 `pages.content_json`（**TEXT**，JSON）—— 老客户端只认它 ✓
//     ② CRDT 状态**只**进 `page_crdt` / `page_crdt_pending`（**BLOB**）—— 不塞进 `content_json` ✗
//     ③ Rust 侧不认识 CRDT；`content_json` ⇄ `ydoc` 的转换**只有一份实现**
//   这三句**已经写在代码注释里**（`db.rs:1040` 附近、`crdt_wire.rs:12`、`commands.rs:374`）✓，
//   但**没有任何判据**：谁哪天把 BLOB 塞进 `content_json`、或给 Rust 加一个 yjs crate、
//   或长出第二份转换实现，**都不会炸、不会报错、测试全绿** —— 只是**老客户端的页打不开** ✗。
//   ⇒ 这正是本仓 §8 那族（"违规不炸，只是用户那边出问题"）。
//
// 判据（窄；纯读源码 ⇒ 本机可验 ✓）：
//   ① `db.rs` 里每个 `content_json` 声明都必须是 **TEXT**；`page_crdt`/`page_crdt_pending` 的 `state` 必须是 **BLOB**
//   ② `src-tauri/**/Cargo.toml` 不许出现 yjs／yrs／y-crdt 依赖（Rust 不认识 CRDT ✓）
//   ③ `contentJsonToYDoc` / `yDocToContentJson` 的**定义**只许出现在 `src/lib/crdt/yDocBridge.ts`
//   ④ `mergeRemotePageState` 的**定义**只许出现在一个非测试文件里
//   ⚠️ **不判**"合并结果要不要回写 `content_json`" —— 那是**未决问题**（见规格 §5②），没有读数 ⇒ 不许假装判得了 ✗
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 读不到必要文件（**不算通过**）
// 用法：node scripts/check-crdt-plane.mjs ／ --root <p> ／ --self-test

import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const CONVERTER = "src/lib/crdt/yDocBridge.ts";

/** 递归列出文件（跳过 node_modules / .git ✓） */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.name === "node_modules" || d.name === ".git" || d.name === "target" || d.name === "dist") continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 在 `src/` 下找某个标识符的**定义**（`export function X` / `export const X` / `function X`），返回相对路径组 */
export function definersOf(srcDir, name) {
  const re = new RegExp(String.raw`(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+${name}\b`);
  return walk(srcDir)
    .filter((p) => /\.(ts|tsx|mts|js|mjs)$/.test(p) && !/\.test\./.test(p) && !/\.spec\./.test(p))
    .filter((p) => re.test(readFileSync(p, "utf8")))
    .map((p) => relative(dirname(srcDir), p).replace(/\\/g, "/"));
}

/** 纯判据：把"读到的东西"喂进来 ⇒ findings（便于自测 ✓） */
export function judge({ contentJsonDecls, crdtStateDecls, pendingPk, cargoDeps, converterDefiners, mergeDefiners }) {
  const out = [];
  for (const d of contentJsonDecls) {
    if (!/\bTEXT\b/i.test(d)) out.push("✗ `content_json` 必须是 **TEXT**（老客户端只认 JSON ✓）：" + d.trim().slice(0, 90));
  }
  for (const d of crdtStateDecls) {
    if (!/\bBLOB\b/i.test(d)) out.push("✗ CRDT 状态列必须是 **BLOB**（不许混进 `content_json` ✗）：" + d.trim().slice(0, 90));
  }
  for (const dep of cargoDeps) {
    if (/(^|[^a-z])(yjs|yrs|y-crdt|y_rs)([^a-z]|$)/i.test(dep)) out.push("✗ `src-tauri` 里出现了 Yjs 系依赖：" + dep.trim().slice(0, 70) + " ⇒ **先问一句：决策改了吗？** 本条口径是「**`yrs` 现在不引，到 S5 阶段 2 再定**（owner 2026-09-29 ✓）」。若确实要引，请**同时**改三处：规格 `INV-CRDT-rust-agnostic` 行／`src-tauri/src/crdt_wire.rs` 文件头（那里写着「要不要引进是 S5 阶段 2 的决策」）／本条判据 ✓");
  }
  const conv = converterDefiners.filter((p) => p !== CONVERTER);
  if (converterDefiners.length && conv.length) out.push("✗ `content_json` ⇄ `ydoc` 的转换实现**不止一份**（唯一实现应是 `" + CONVERTER + "` ✓）：" + conv.join("、"));
  if (!converterDefiners.length) out.push("✗ 找不到转换实现的**定义**（`contentJsonToYDoc`/`yDocToContentJson`）⇒ 判据什么也没查到（**不算通过** ✗）");
  if (mergeDefiners.length > 1) out.push("✗ `mergeRemotePageState` 有 " + mergeDefiners.length + " 处**定义**（只许一处 —— 合并不许长第二份 ✗）：" + mergeDefiners.join("、"));
  if (!mergeDefiners.length) out.push("✗ 找不到 `mergeRemotePageState` 的定义 ⇒ 判据什么也没查到（**不算通过** ✗）");
  // ⭐ 2026-09-29：把 `INV-CRDT-pending-per-seq` 从「待立」变成「能跑」✓
  //   判据＝主键含 `seq` ✓（来由见 `db.rs:1044` 附近：「服务端 pull 不回 `device_id`，
  //   不同设备的**全量**状态互相不包含对方的编辑 ⇒ 「每页一行」会**真丢**」✓）
  if (!/PRIMARY\s+KEY\s*\(\s*page_id\s*,\s*seq\s*\)/i.test(pendingPk || "")) {
    out.push("✗ `page_crdt_pending` 的主键必须是 `(page_id, seq)`（**按 seq 逐条留** —— 「每页一行」会真丢编辑 ✗）：" + String(pendingPk || "（没读到主键）").trim().slice(0, 90));
  }
  return out;
}

function gather(root) {
  const dbPath = join(root, "src-tauri", "src", "db.rs");
  if (!existsSync(dbPath)) return { envMissing: dbPath };
  const db = readFileSync(dbPath, "utf8").split(/\r?\n/);
  const contentJsonDecls = db.filter((l) => /content_json\s+(TEXT|BLOB|INTEGER|REAL|NUMERIC)/i.test(l));
  // `page_crdt` / `page_crdt_pending` 的 state 列（建表块内 ✓）
  const crdtStateDecls = [];
  for (let i = 0; i < db.length; i++) {
    if (/CREATE TABLE IF NOT EXISTS (page_crdt|page_crdt_pending)\b/.test(db[i])) {
      for (let j = i; j < Math.min(i + 12, db.length); j++) { if (/^\s*state\s+\w+/i.test(db[j])) crdtStateDecls.push(db[j]); if (/\)\s*",?\s*$/.test(db[j])) break; }
    }
  }
  // `page_crdt_pending` 的主键（`INV-CRDT-pending-per-seq` 的判据 ✓）
  let pendingPk = "";
  for (let i = 0; i < db.length; i++) {
    if (/CREATE TABLE IF NOT EXISTS page_crdt_pending\b/.test(db[i])) {
      for (let j = i; j < Math.min(i + 12, db.length); j++) { if (/PRIMARY\s+KEY/i.test(db[j])) pendingPk = db[j]; if (/\)\s*",?\s*$/.test(db[j])) break; }
    }
  }
  const cargoDeps = [];
  for (const p of walk(join(root, "src-tauri"))) {
    if (!p.endsWith("Cargo.toml")) continue;
    for (const l of readFileSync(p, "utf8").split(/\r?\n/)) if (/^\s*"?[a-z0-9_-]+"?\s*=/.test(l)) cargoDeps.push(l);
  }
  const srcDir = join(root, "src");
  return {
    contentJsonDecls, crdtStateDecls, pendingPk, cargoDeps,
    converterDefiners: [...definersOf(srcDir, "contentJsonToYDoc"), ...definersOf(srcDir, "yDocToContentJson")],
    mergeDefiners: definersOf(srcDir, "mergeRemotePageState"),
  };
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const base = { contentJsonDecls: ["content_json TEXT NOT NULL DEFAULT '{}',"], crdtStateDecls: ["    state      BLOB NOT NULL"], pendingPk: "    PRIMARY KEY (page_id, seq)", cargoDeps: ['serde = "1"'], converterDefiners: [CONVERTER], mergeDefiners: ["lib/crdt/pageSession.ts"] };
  const cases = [
    ["全绿 ⇒ 空", judge(base).length === 0],
    ["content_json 变 BLOB ⇒ 红", judge({ ...base, contentJsonDecls: ["content_json BLOB,"] }).some((s) => s.includes("TEXT"))],
    ["state 变 TEXT ⇒ 红", judge({ ...base, crdtStateDecls: ["state TEXT"] }).some((s) => s.includes("BLOB"))],
    ["Rust 加 yjs ⇒ 红", judge({ ...base, cargoDeps: ['yrs = "0.17"'] }).some((s) => s.includes("Rust 侧"))],
    ["第二份转换实现 ⇒ 红", judge({ ...base, converterDefiners: [CONVERTER, "lib/crdt/other.ts"] }).some((s) => s.includes("不止一份"))],
    ["没有转换实现 ⇒ 红（不许假绿）", judge({ ...base, converterDefiners: [] }).some((s) => s.includes("不算通过"))],
    ["两处 merge 定义 ⇒ 红", judge({ ...base, mergeDefiners: ["a.ts", "b.ts"] }).some((s) => s.includes("两处" ) || s.includes("?") || s.includes("处**定义**"))],
    ["没有 merge 定义 ⇒ 红", judge({ ...base, mergeDefiners: [] }).some((s) => s.includes("不算通过"))],
    ["pending 主键丢了 seq ⇒ 红（每页一行会真丢 ✗）", judge({ ...base, pendingPk: "    PRIMARY KEY (page_id)" }).some((s) => s.includes("page_id, seq"))],
  ];
  let pass = 0;
  for (const [n, ok] of cases) { console.log((ok ? "  ✓ " : "  ✗ ") + n); if (ok) pass++; }
  console.log("self-test: " + pass + "/" + cases.length + " 通过");
  process.exit(pass === cases.length ? 0 : 1);
}
const rI = argv.indexOf("--root");
const root = rI >= 0 && argv[rI + 1] ? argv[rI + 1] : ROOT;
const g = gather(root);
if (g.envMissing) { console.error("✗ 读不到：" + g.envMissing + "（**不算通过**）"); process.exit(2); }
const findings = judge(g);
if (findings.length) { for (const f of findings) console.error(f); process.exit(1); }
console.log("✓ CRDT 平面：`content_json` 是 TEXT（" + g.contentJsonDecls.length + " 处）／CRDT 状态是 BLOB（" + g.crdtStateDecls.length + " 处）／"
  + "Rust 无 Yjs 依赖（查了 " + g.cargoDeps.length + " 条）／待并状态主键=" + String(g.pendingPk).trim().replace(/\s+/g, " ") + "／转换与合并各只有一份实现（" + g.converterDefiners.join("、") + "）");
