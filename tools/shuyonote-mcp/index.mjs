#!/usr/bin/env node
// tools/shuyonote-mcp/index.mjs —— **MCP 桥**（M1 · Task 3：stdio 帧 ＋ 转发到 App 的本机通道 ✓）
//
// 它是什么：外部 agent（Claude Code / CodeBuddy / WorkBuddy / DSH …）那一侧的小程序。
// 只做两件事，**都是搬运** ✓：
//   ① **stdio 帧**：MCP 是「行分隔 JSON-RPC over stdio」⇒ stdin 一行一条请求、stdout 一行一条响应 ✓
//      ⚠️ **stdout 只许出现协议行** ✗：本文件里一次 `console.log` 都没有 ✓（日志一律 stderr ✓）
//      —— 判据 `tools/shuyonote-mcp/judge-protocol.mjs`（Task 3）逐字核这件事 ✓
//   ② **转发**：`tools/list` / `tools/call` ⇒ POST 给 **App 的本机通道** ✓
//      （`src-tauri/src/mcp_channel.rs`：默认关、只绑回环、token 从文件读、Origin/Host 必须回环 ✓）
//
// ⛔ **桥不做什么**（判据 `scripts/check-mcp-bridge-dumb.mjs`）：不碰库、不判权限、不写审计、
//   不摸权威形态、**也不自己编工具清单** —— 清单由 App 原样吐出注册表生成物 ✓。
//   桥一旦"聪明"起来，唯一鉴权点与同一本审计账就同时被绕开 ✗。
//
// ⚠️ **2026-10-06（M1 收口）方向纠正**：先前这一版自己 `createServer().listen()` ✗ ——
//   于是"App 是服务端（`mcp_channel.rs:183`）＋ 桥也是服务端" ⇒ **两边都不是客户端** ⇒
//   一跳都走不通 ✗（`tools/list` 只能空着、`tools/call` 直接报"宿主面未接线"✗）。
//   按施工单 §1「哑桥只转发 MCP ⇄ 本机通道」✓ ⇒ **桥是客户端、App 是服务端** ✓。
//
// ## 契约（与判据逐字对齐 ✓）
//   环境变量（由 agent 的 MCP 配置给 ✓）：
//     · `SHUYONOTE_MCP_PORT_FILE`  = App 写下的**端口文件**（内容就是端口号 ✓）
//     · `SHUYONOTE_MCP_TOKEN_FILE` = 会话 token 文件（只读 ✓，第一行 token ✓）
//   行为：
//     · 两个文件读不到 ⇒ **不猜**：`tools/list` 回空清单 ＋ `tools/call` 回一条**说清原因**的错误 ✓
//       （通道没开 / 路径没给对 —— 都属于"没连上"，不是"有 0 个工具" ✓）；
//     · 转发用 `Authorization: Bearer <token>` ⇒ 由 **App** 校验 token/Origin/Host ✓（桥不判 ✗）；
//     · 一切日志走 stderr ✓；stdout 只有协议行 ✓。
// 退出码：0 正常结束 ／ 2 起不来（stdin 不可用等）
// 人工看帧：`SHUYONOTE_MCP_PORT_FILE=… SHUYONOTE_MCP_TOKEN_FILE=… \
//            echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node tools/shuyonote-mcp/index.mjs`
import { readFileSync } from "node:fs";

const PORT_FILE = process.env.SHUYONOTE_MCP_PORT_FILE || "";
const TOKEN_FILE = process.env.SHUYONOTE_MCP_TOKEN_FILE || "";
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "shuyonote-bridge", version: "0.1.0" };

/** 日志一律走 stderr ✓（stdout 只许协议行 ✓） */
const log = (...a) => process.stderr.write(a.join(" ") + "\n");
/** 唯一的 stdout 出口 ✓ —— 每行都是可 parse 的 JSON ✓ */
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

// ---------------- ① 读连接信息（App 那一侧写的两个文件 ✓） ----------------
/** 返回 `{ ok: true, port, token }` 或 `{ ok: false, why }` —— **原因要说清** ✓（别静默当"没工具" ✗）。 */
function readEndpoint() {
  if (!PORT_FILE) return { ok: false, why: "没给 `SHUYONOTE_MCP_PORT_FILE`（App 写的端口文件）" };
  if (!TOKEN_FILE) return { ok: false, why: "没给 `SHUYONOTE_MCP_TOKEN_FILE`（会话 token 文件）" };
  let portText;
  let token;
  try {
    portText = readFileSync(PORT_FILE, "utf8").trim();
  } catch {
    return { ok: false, why: `读不到端口文件（${PORT_FILE}）—— ShuyoNote 里的「外部接入」开关是不是没开？` };
  }
  try {
    token = (readFileSync(TOKEN_FILE, "utf8").split("\n")[0] || "").trim();
  } catch {
    return { ok: false, why: `读不到 token 文件（${TOKEN_FILE}）—— 同上，先开开关` };
  }
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, why: `端口文件内容不是合法端口（${JSON.stringify(portText)}）` };
  }
  if (!token) return { ok: false, why: "token 文件是空的" };
  return { ok: true, port, token };
}

/** 把一次调用 POST 给 App 的通道 ✓（**只搬运**：不判权限、不重试、不缓存 ✓）。 */
async function callApp(method, args) {
  const ep = readEndpoint();
  if (!ep.ok) return { ok: false, error: "通道未开：" + ep.why };
  // ⚠️ 路径**必须是 `/call`**：宿主面的 `serve_one` 先核 `POST /call`，不然直接 404 `not_found` ✓
  //    （2026-10-06 真端到端第一次就撞上：桥 post `/` ⇒ 每条调用都回 `not_found` ✗，
  //     而判据当时用的假 App 通道**不核路径** ⇒ 15/0 全绿也挡不住 ✗）。
  const url = `http://127.0.0.1:${ep.port}/call`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + ep.token },
      body: JSON.stringify({ method, args: args ?? {} }),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: `App 通道回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}` };
    }
    if (!json || json.ok !== true) return { ok: false, error: String((json && json.error) || `HTTP ${res.status}`) };
    return { ok: true, result: json.result };
  } catch (e) {
    return { ok: false, error: `连不上 App 的通道（127.0.0.1:${ep.port}）：${e && e.message}` };
  }
}

// ---------------- ② stdio 帧（只搬运 ✓） ----------------
/** 工具名 ↔ 能力 id 的映射：**由 App 给的清单现算** ✓（⛔ 不写死工具名 —— DSH 侧会改写不合规字符 ✓）。 */
async function listTools() {
  const r = await callApp("__tools_list", {});
  if (!r.ok) return { ok: false, error: r.error };
  // ⚠️ 清单的**真形状**由生成物决定：`capabilities/mcp-tools.json` 是**裸数组** ✓
  //    （`[{name, capabilityId, description, inputSchema}, …]` ✓）。宿主面**原样**透出来 ✓ ⇒
  //    这里同时认"裸数组"与"`{tools:[…]}`"两种（后者是夹具/将来换形状时的兜底 ✓，不猜内容 ✓）。
  const raw = r.result;
  const entries = Array.isArray(raw) ? raw : Array.isArray(raw?.tools) ? raw.tools : [];
  return {
    ok: true,
    tools: entries.map((t) => ({
      name: String(t.name || ""),
      description: String(t.description || ""),
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      // ⚠️ 这一格**不是** MCP 规范字段，但对得上"能力 id" ⇒ 调用时原样带回去 ✓（桥不解释它 ✓）
      "x-shuyonote-capability": String(t.capabilityId || ""),
    })),
  };
}

async function handle(msg) {
  const { id, method, params } = msg || {};
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
    const r = await listTools();
    if (!r.ok) {
      // ⚠️ 连不上时**回空清单 ＋ 把原因写 stderr** ✓（别假装"有 0 个工具" ✗；也别把错误塞进 result ✗）
      log("tools/list：没有工具可列 —— " + r.error);
      reply({ tools: [] });
      return;
    }
    log(`tools/list：${r.tools.length} 条（来自 App 的能力注册表 ✓）`);
    reply({ tools: r.tools });
    return;
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const r = await listTools();
    if (!r.ok) { fail(-32000, r.error); return; }
    const tool = r.tools.find((t) => t.name === name);
    if (!tool) { fail(-32602, `未知工具：${String(name)}（清单见 tools/list）`); return; }
    const capabilityId = tool["x-shuyonote-capability"] || name;
    const call = await callApp(capabilityId, args);
    if (!call.ok) { fail(-32000, call.error); return; }
    reply({ content: [{ type: "text", text: JSON.stringify(call.result) }] });
    return;
  }
  fail(-32601, "method not found: " + String(method));
}

function startStdio() {
  let buf = "";
  // ⚠️ **stdin EOF 不等于"可以立刻退出"** ✗：MCP 客户端常常写完请求就关 stdin（判据就是这么喂的 ✓），
  //    而 `handle` 现在是 async（要真转发 ✓）⇒ 立刻 exit 会把**在途的转发**一起杀掉 ✗，
  //    表现是"少回了一条响应"（2026-10-06 本机实测：4 条请求只回了 2 条 ✓）。
  //    ⇒ 等"在途请求归零"再退 ✓（这也是旧版那条教训的同类：stdin 结束不代表没活干 ✓）。
  let inFlight = 0;
  let stdinEnded = false;
  const maybeExit = () => {
    if (stdinEnded && inFlight === 0) process.exit(0);
  };
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
      inFlight++;
      // ⚠️ 处理失败也只能走**错误响应** ✓，绝不打到 stdout 之外 ✓
      Promise.resolve(handle(msg))
        .catch((e) => {
          log("处理失败：" + (e && e.message));
          const id = msg && msg.id;
          if (id !== undefined && id !== null) {
            send({ jsonrpc: "2.0", id, error: { code: -32603, message: String((e && e.message) || e) } });
          }
        })
        .finally(() => { inFlight--; maybeExit(); });
    }
  });
  process.stdin.on("end", () => { stdinEnded = true; maybeExit(); });
}

// ---------------- ③ 启动 ----------------
const ep = readEndpoint();
if (ep.ok) log(`通道已就绪：127.0.0.1:${ep.port}（token 从文件读 ✓，校验由 App 做 ✓）`);
else log("通道未就绪：" + ep.why + "（stdio 帧仍可用 ✓：tools/list 会回空清单、tools/call 会回原因 ✓）");
startStdio();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
