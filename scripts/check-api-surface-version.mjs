#!/usr/bin/env node
// check-api-surface-version.mjs —— 判据（施工单 Task 4）：**接口变了就必须升 `apiVersion`**
//
// 挡的是哪次真实事故（incident）：
//   注册表顶层本来就有 `registryVersion` / `apiVersion` ✓（2026-09-28 实测），但**没有任何东西强制它** ✗ ——
//   改 id／删能力／改语义时，正在用它的外部程序会在**没有任何信号**的情况下坏掉；
//   同一天我还实测出另一面：MCP 规格把写判定写成查 `isWrite`（该字段出现 0 次 ✗）⇒ 接口的"形状"必须**机器可查** ✓
//
// 指纹口径（**刻意窄** ✓）：只取接口相关字段 **id | kind | scope | permission**（排序后拼接再 sha256）。
//   **不含 `desc`**：改文案不算破坏接口（否则每改一句话都要升版本 ⇒ 判据会被绕过 ✗）；
//   含 `kind`／`permission`：它们正是"能不能写、要什么权限"的对外承诺 ✓
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 注册表读不到（**不算通过**）
// 用法：node scripts/check-api-surface-version.mjs ／ --update（记下当前指纹，**改了版本才用**）／ --self-test

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REGISTRY } from "./gen-agent-tool-surface.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const RECORD = join(ROOT, "_generated", "api-surface.json");

/** 纯函数：注册表文本 ⇒ 接口指纹与计数（同输入必同输出 ✓） */
export function fingerprint(registryText) {
  const j = JSON.parse(registryText);
  const caps = [...(j.capabilities || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const face = caps.map((c) => [c.id, c.kind, c.scope, c.permission].join("|")).join("\n");
  const by = (f) => caps.filter(f).length;
  return {
    apiVersion: j.apiVersion ?? null,
    registryVersion: j.registryVersion ?? null,
    fingerprint: createHash("sha256").update(face).digest("hex"),
    counts: {
      total: caps.length,
      read: by((c) => c.kind === "read"),
      write: by((c) => c.kind === "write"),
      host: by((c) => c.kind === "host"),
      aiRead: by((c) => c.ai === true && c.kind === "read"),
      aiWrite: by((c) => c.ai === true && c.kind === "write"),
    },
  };
}

/** 纯判据：现在 vs 记录 ⇒ findings（空＝干净 ✓） */
export function judge(now, rec) {
  if (!rec) return ["✗ 接口指纹记录缺失：" + RECORD.replace(ROOT, ".").replace(/\\/g, "/") + " —— 跑 `node scripts/check-api-surface-version.mjs --update` 记下 ✓"];
  const out = [];
  const faceChanged = now.fingerprint !== rec.fingerprint;
  const verChanged = now.apiVersion !== rec.apiVersion;
  if (faceChanged && !verChanged) {
    out.push("✗ **接口变了但 `apiVersion` 没变**（" + rec.apiVersion + "）—— 正在用它的外部程序会**没有信号地坏掉** ✓");
    out.push("   现在：" + JSON.stringify(now.counts));
    out.push("   记录：" + JSON.stringify(rec.counts));
  } else if (faceChanged && verChanged) {
    out.push("✗ 接口与 `apiVersion` 都变了，但记录还没更新 ⇒ 跑 `--update` 记下（" + rec.apiVersion + " → " + now.apiVersion + " ✓）");
  } else if (!faceChanged && verChanged) {
    out.push("✗ `apiVersion` 变了但接口没变，记录也未更新 ⇒ 跑 `--update`（或说明这次为何只升版本 ✓）");
  }
  return out;
}

function loadRec() {
  if (!existsSync(RECORD)) return null;
  try { return JSON.parse(readFileSync(RECORD, "utf8")); } catch { return null; }
}
function update() {
  const now = fingerprint(readFileSync(REGISTRY, "utf8"));
  mkdirSync(dirname(RECORD), { recursive: true });
  writeFileSync(RECORD, JSON.stringify({ ...now, at: new Date().toISOString().slice(0, 10), by: "check-api-surface-version --update" }, null, 2) + "\n", "utf8");
  console.log("✓ 已记下接口指纹：apiVersion=" + now.apiVersion + " ｜ " + JSON.stringify(now.counts));
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "apiver-"));
  try {
    const base = { apiVersion: "1.0.0", fingerprint: "aaa", counts: { total: 25, read: 15, write: 8, host: 2, aiRead: 8, aiWrite: 2 } };
    const cases = [
      ["记录缺失 ⇒ 有 finding", judge(base, null).length === 1],
      ["指纹变了·版本没变 ⇒ 红（危险那一种）", judge({ ...base, fingerprint: "bbb" }, base).some((s) => s.includes("接口变了但"))],
      ["指纹与版本都没变 ⇒ 空", judge(base, base).length === 0],
      ["两者都变了 ⇒ 只提示 --update", judge({ ...base, fingerprint: "bbb", apiVersion: "1.1.0" }, base).every((s) => !s.includes("没有信号"))],
      ["只升版本 ⇒ 有 finding（记录未更新）", judge({ ...base, apiVersion: "1.1.0" }, base).length >= 1],
    ];
    let pass = 0;
    for (const [n, ok] of cases) { console.log((ok ? "  ✓ " : "  ✗ ") + n); if (ok) pass++; }
    console.log("self-test: " + pass + "/" + cases.length + " 通过");
    process.exit(pass === cases.length ? 0 : 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
if (argv.includes("--update")) { update(); process.exit(0); }
if (!existsSync(REGISTRY)) { console.error("✗ 读不到能力注册表（**不算通过**）"); process.exit(2); }
const f = judge(fingerprint(readFileSync(REGISTRY, "utf8")), loadRec());
if (f.length) { for (const x of f) console.error(x); process.exit(1); }
console.log("✓ 接口指纹与 `apiVersion` 一致（apiVersion=" + fingerprint(readFileSync(REGISTRY, "utf8")).apiVersion + " ✓）");
process.exit(0);
