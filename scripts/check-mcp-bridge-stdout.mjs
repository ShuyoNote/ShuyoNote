#!/usr/bin/env node
// scripts/check-mcp-bridge-stdout.mjs —— `INV-MCP-bridge-stdout`：**MCP 桥的 stdout 只许协议消息** ✓
//
// 为什么这条必须独立存在（施工单 Task 3 ✓）：MCP 是「行分隔 JSON-RPC over stdio」——
// 客户端按**行**解析 stdout ⇔ **多印一行日志就把协议打断** ✗（表现是客户端报
// "Unexpected token" 或干脆挂住，而桥这边看着一切正常 ✓）。本仓此前只有别处的**说明**
// （`check-mcp-bridge-dumb` 的头注里提到"AMD 那条"，但本仓**并没有这个文件** ✗）
// ⇒ 这一条把它补上，并且做成**真起进程**的判据（不是读源码猜 ✓）。
//
// 四条判据：
//   ① **静态**：桥源码里**不许出现** `console.log`（日志一律 `process.stderr.write` ✓）；
//   ② **动态**：真起桥、喂 `initialize` / `notifications/initialized` / `tools/list`
//      ⇒ **每一行 stdout 都必须 `JSON.parse` 得动** ✓，且**带 id 的请求必有回** ✓、
//      通知**不许**有回（MCP 语义 ✓ —— 所以是"2 条回 / 3 条请求"，⛔ 不是"3 条都回" ✗）；
//   ③ **版本协商**：请求 `2024-11-05` ⇒ 回同一个 ✓；请求一个不支持的版本 ⇒ 回**自己支持的**那个 ✓
//      （不是把对方的版本原样抄回来 ✗）。
//   ④ **无对象**：桥文件不存在 ⇒ **exit 2**（**不算通过** ✓ —— "没扫到"不是"干净" ✗）。
//
// 退出码：0 全过 ／ 1 有发现 ／ 2 环境不具备（不算通过）／ 3 本形态下无对象
// 用法：node scripts/check-mcp-bridge-stdout.mjs
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const BRIDGE = join(ROOT, "tools", "shuyonote-mcp", "index.mjs");

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log("  ✓ " + msg); } else { fail++; console.log("  ✗ " + msg); }
};

if (!existsSync(BRIDGE)) {
  console.error("✗ 桥不存在（" + BRIDGE + "）⇒ **环境不具备，不算通过**（exit 2）");
  process.exit(2);
}

/** 起桥、喂若干行、收 stdout（按行切 ✓）与 stderr；返回解析结果。 */
function runBridge(lines, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE], {
      // ⚠️ 刻意**不给**任何 `SHUYONOTE_MCP_*` ⇒ 桥应"通道未就绪"但仍照协议应答 ✓
      env: { ...process.env, SHUYONOTE_MCP_PORT_FILE: "", SHUYONOTE_MCP_TOKEN_FILE: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.stdin.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    setTimeout(() => { try { child.stdin.end(); } catch { /* ignore */ } }, 50);
    const t = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    child.on("close", () => {
      clearTimeout(t);
      const raw = out.split("\n").filter((l) => l.trim() !== "");
      const parsed = raw.map((l) => {
        try { return { good: true, value: JSON.parse(l) }; } catch { return { good: false, raw: l }; }
      });
      resolve({ raw, parsed, err });
    });
  });
}

console.log("MCP 桥的 stdout 纯净判据（真起进程 ✓）");

// ---------- ① 静态：源码里不许出现 console.log ----------
{
  const src = readFileSync(BRIDGE, "utf8");
  // 只看真正的代码行（去掉注释行 ✓ —— 头注里正解释"本文件一次 console.log 都没有" ✓，
  // 那是**说明**不是代码 ✗，扫进来会变成假红 ✓）。
  const codeLines = src
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const hits = codeLines.filter((l) => /console\.log\s*\(/.test(l));
  ok(hits.length === 0, `桥源码里没有 console.log（找到 ${hits.length} 处 —— 找到就是把协议行混进日志 ✗）`);
}

// ---------- ② 动态：stdout 每行都必须是协议消息 ----------
{
  const r = await runBridge([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  const bad = r.parsed.filter((p) => !p.good);
  ok(bad.length === 0, `stdout 每一行都是合法 JSON（${r.raw.length} 行；坏行 ${bad.length}${bad.length ? "：" + JSON.stringify(bad[0].raw).slice(0, 80) : ""}）`);
  const ids = r.parsed.filter((p) => p.good).map((p) => p.value.id);
  ok(ids.includes(1), "带 id=1 的 initialize 有回 ✓");
  ok(ids.includes(2), "带 id=2 的 tools/list 有回 ✓");
  ok(!ids.includes(undefined), "通知**没有**回（MCP 语义：通知不回 ✓ —— 所以 3 条请求只该有 2 条回 ✓）");
  ok(ids.length === 2, `回的行数正好 2（实际 ${ids.length}）—— 多一条就是"没问也答" ✗`);
  const init = r.parsed.find((p) => p.good && p.value.id === 1)?.value;
  ok(!!init?.result?.serverInfo?.name, "initialize 回了 serverInfo ✓");
}

// ---------- ③ 版本协商 ----------
{
  const same = await runBridge([{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }]);
  const v1 = same.parsed.find((p) => p.value?.id === 1)?.value?.result?.protocolVersion;
  ok(v1 === "2024-11-05", `客户端要什么就回什么（要 2024-11-05 ⇒ 回 ${v1}）✓`);
  const other = await runBridge([{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }]);
  const v2 = other.parsed.find((p) => p.value?.id === 1)?.value?.result?.protocolVersion;
  ok(!!v2 && v2 !== "1999-01-01", `不支持的版本不原样抄回来（要 1999-01-01 ⇒ 回 ${v2}）✓`);
}

console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
