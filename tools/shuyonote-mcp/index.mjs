#!/usr/bin/env node
// tools/shuyonote-mcp/index.mjs —— **MCP 桥**（M1 · Task 3／4 的第一块：通道层 ＋ stdio 帧 ✓）
//
// 它是什么：外部 agent 那一侧的小程序。两件事，**都只做搬运** ✓：
//   ① **stdio 帧**：MCP 是「行分隔 JSON-RPC over stdio」⇒ stdin 一行一条请求、stdout 一行一条响应 ✓
//      ⚠️ 所以 **stdout 只许出现协议行** ✗：本文件里**一次 `console.log` 都没有** ✓
//      （判据：AMD 的 `check-mcp-bridge-stdout` ✓ —— 逐字「stdio 桥的 stdout 只许出现协议消息」✓）
//   ② **本机通道**：默认**关** ✓；开了之后只监听回环，校验**文件里的 token** ＋ `Origin`/`Host` ✓
//      （判据：`tools/shuyonote-mcp/judge-channel.mjs` ✓ —— 四条断言：默认关拒连／坏 Origin 拒／错 token 拒／关闸后旧 token 失效 ✓）
//
// 它**不做什么**（判据：`scripts/check-mcp-bridge-dumb.mjs` ✓）：不碰库、不判权限、不写审计、不摸权威形态 ✓
//   —— 那些全归宿主面与 `plugins.rs` ✓。桥一旦"聪明"起来，唯一鉴权点与同一本审计账就同时被绕开 ✗。
//
// ## 契约（与上面两条判据逐字对齐 ✓）
//   环境变量：
//     · `SHUYONOTE_MCP_SWITCH`      = `on` | `off`（**默认 off** ✓）
//     · `SHUYONOTE_MCP_TOKEN_FILE`  = 装着会话 token 的文件路径（**只读** ✓）
//     · `SHUYONOTE_MCP_ORIGIN_ALLOW`= `loopback`
//   行为：
//     · 开关 off ⇒ **不监听** ✓（进程安静退出 ✓）
//     · 开关 on  ⇒ 监听 `127.0.0.1:0` ⇒ 把 `PORT=<n>` 打到 **stderr** ✓
//     · `Origin` 不是"恰好回环"⇒ **403** ✓ ／ token 不对 ⇒ **401** ✓ ／ 都对 ⇒ **200** ✓
//     · `Host` 不是回环 ⇒ 403 ✓（防 DNS rebinding 那一类 ✓）
//
// 退出码：0 正常 ／ 2 环境不具备（开关 on 却拿不到 token 文件 ✓ —— **不算通过** ✗）
// 用法：由宿主面／判据 spawn 起来；人工看 stdout 帧：`echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | node tools/shuyonote-mcp/index.mjs`
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const SWITCH_ON = process.env.SHUYONOTE_MCP_SWITCH === "on";
const TOKEN_FILE = process.env.SHUYONOTE_MCP_TOKEN_FILE || "";
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "shuyonote-bridge", version: "0.0.1" };

/** 日志一律走 stderr ✓（stdout 只许协议行 ✓） */
const log = (...a) => process.stderr.write(a.join(" ") + "\n");
/** 唯一的 stdout 出口 ✓ —— 每行都是可 parse 的 JSON ✓ */
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

// ---------------- ① 本机通道（默认关 ✓） ----------------
function readToken() {
  if (!TOKEN_FILE) return null;
  try { return readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return null; }
}
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
function originOk(origin) {
  if (origin === undefined || origin === "") return true; // 原生客户端可能不发 Origin ✓（但 Host 仍要核 ✓）
  return LOOPBACK_ORIGIN.test(String(origin));
}
function hostOk(host) {
  if (!host) return false;
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(host));
}
function startChannel() {
  const token = readToken();
  if (!token) {
    log("环境不具备：开关是 on，但读不到 token 文件（`SHUYONOTE_MCP_TOKEN_FILE`）⇒ 不启动通道（**不算通过**）");
    process.exitCode = 2;
    return null;
  }
  const srv = createServer((req, res) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!originOk(origin) || !hostOk(host)) {
      log("拒绝：Origin/Host 不是回环");
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden_origin" }));
      return;
    }
    const auth = String(req.headers.authorization || "");
    const got = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (got !== token) {
      log("拒绝：token 不匹配");
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_token" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, bridge: SERVER_INFO, note: "宿主面未接线（M1 Task 5）⇒ 能力转发为 0 条" }));
  });
  srv.listen(0, "127.0.0.1", () => {
    // ⚠️ 端口报 **stderr** ✓（stdout 归协议 ✓；这条曾经写错过 ⇒ 与 stdout 纯净判据对撞 ✗）
    log("PORT=" + srv.address().port);
  });
  return srv;
}

// ---------------- ② stdio 帧（只搬运 ✓） ----------------
function handle(msg) {
  const { id, method } = msg || {};
  const isNotification = id === undefined || id === null;
  const reply = (result) => { if (!isNotification) send({ jsonrpc: "2.0", id, result }); };
  const fail = (code, message) => { if (!isNotification) send({ jsonrpc: "2.0", id, error: { code, message } }); };

  if (method === "initialize") {
    reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return; // 通知：不回 ✓
  if (method === "ping") { reply({}); return; }
  if (method === "tools/list") {
    // 桥不会自己编工具 ✓：清单由能力注册表生成、由宿主面提供 ⇒ 宿主面没接线就是**空清单** ✓（不假装有 ✓）
    reply({ tools: [], note: "宿主面未接线（M1 Task 5）⇒ 还没有可转发的只读工具" });
    return;
  }
  if (method === "tools/call") {
    fail(-32000, "宿主面未接线（M1 Task 5）：桥只搬运，不代办 ✓");
    return;
  }
  fail(-32601, "method not found: " + String(method));
}

function startStdio() {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    for (;;) {
      const i = buf.indexOf("\n");
      if (i < 0) break;
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { log("丢弃非 JSON 行（stdout 只许协议行 ✓，这一行也不往外写 ✗）"); continue; }
      try { handle(msg); } catch (e) { log("处理失败：" + (e && e.message)); }
    }
  });
  process.stdin.on("end", () => {
    // ⚠️ 只有**通道没开**时才能因为 stdin 结束而退出 ✓
    //   （教训：判据用 `stdin: "ignore"` 起桥 ⇒ stdin **立刻 EOF** ⇒ 旧写法把正在服务的通道一起杀了 ✗，
    //    表现是 curl 连不上（HTTP 0）、四条断言全"没检查到东西" ✓。2026-10-01 实测抓到 ✓）
    if (!SWITCH_ON) process.exit(0);
    log("stdin 结束，但通道开着 ⇒ 继续服务 ✓");
  });
}

// ---------------- ③ 启动 ----------------
if (!SWITCH_ON) {
  log("通道默认关（`SHUYONOTE_MCP_SWITCH != on`）⇒ 不监听 ✓；stdio 帧仍可用 ✓");
} else {
  startChannel();
}
startStdio();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
