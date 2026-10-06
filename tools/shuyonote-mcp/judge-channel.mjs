#!/usr/bin/env node
// tools/shuyonote-mcp/judge-channel.mjs —— 桥的**转发面**判据（M1 · Task 4，2026-10-06 改方向 ✓）
//
// ⚠️ **为什么改方向**：这一条原先测的是「桥自己起的那个服务端」✗
//    （默认关／坏 Origin 拒／错 token 拒／关闸后旧 token 失效 —— 那四条现在是 **App 那半**的判据 ✓，
//     见 `scripts/check-mcp-host-channel.mjs` 与 `src-tauri/src/mcp_channel.rs`）。
//    而施工单 §1 写的架构是「**哑桥只转发** MCP ⇄ 本机通道」✓ ⇒ 桥是**客户端**、App 是服务端 ✓。
//    两半都写成服务端时，一跳都走不通 ✗（`tools/list` 只能空着、`tools/call` 报"宿主面未接线"✗，
//    而那时 6 条判据**全绿** —— 判据盖不到"方向"这一格 ✓，这正是本次纠正的来由）。
//    ⇒ 本条改为钉**桥这一侧**的五件事（都真起进程，不是读源码 ✓）：
//      ① 没配连接信息 ⇒ `tools/call` **如实报"通道未开"**（⛔ 不许静默当"有 0 个工具" ✗）；
//      ② 端口文件指向没人监听的地方 ⇒ 如实报"连不上"，且**不卡死**；
//      ③ 有一个真的 App 通道（夹具）⇒ `tools/list` 把**App 给的清单原样**翻成 MCP 工具 ✓；
//      ④ `tools/call` 转发的是 `{method: <能力 id>, args: <原样参数>}` ＋ `Authorization: Bearer <token>` ✓，
//         结果包成 MCP 的 `content[]` ✓；**App 拒绝时如实带回**（桥不吞、不自己判权限 ✗）；
//      ⑤ 全程 **stdout 只许协议行**（每一行都能 JSON.parse ✓）；一切日志走 stderr ✓。
//
// 退出码：0 全过 ／ 1 有发现 ／ 2 环境不具备（**不算通过** ✗）
// 用法：node tools/shuyonote-mcp/judge-channel.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, "index.mjs");

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log("  ✓ " + msg); } else { fail++; console.log("  ✗ " + msg); }
};

/** 起桥（stdio 管道 ✓），喂若干行 JSON-RPC，收 stdout/stderr；返回解析好的 stdout 行。 */
function runBridge({ env, lines, timeoutMs = 6000 }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.stdin.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const t = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      const parsed = out.split("\n").filter((l) => l.trim()).map((l) => {
        try { return { okJson: true, value: JSON.parse(l) }; } catch { return { okJson: false, raw: l }; }
      });
      resolve({ out, err, code, parsed });
    });
    setTimeout(() => { try { child.stdin.end(); } catch { /* ignore */ } }, 50);
  });
}

const dir = mkdtempSync(join(tmpdir(), "shuyonote-mcp-judge-"));
const portFile = join(dir, "port");
const tokenFile = join(dir, "token");
const TOKEN = "judge-token-abcdef";
writeFileSync(tokenFile, TOKEN + "\nread:pages\n", "utf8");

try {
  console.log("MCP 桥的转发面判据（真起进程 ✓）");

  // ---------- ① 没配连接信息 ⇒ 如实报"通道未开" ----------
  {
    const r = await runBridge({
      env: { SHUYONOTE_MCP_PORT_FILE: "", SHUYONOTE_MCP_TOKEN_FILE: "" },
      lines: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pages_search", arguments: { q: "x" } } }],
    });
    const line = r.parsed[0];
    ok(r.parsed.length > 0 && r.parsed.every((p) => p.okJson), "stdout 每一行都是合法 JSON（协议纯净 ✓）");
    ok(!!line && !!line.value.error, "没配连接信息时 tools/call 回的是 **error**（不是空 result ✓）");
    ok(String(line?.value?.error?.message || "").includes("通道未开"), `错误里说清原因（拿到：${line?.value?.error?.message}）`);
  }

  // ---------- ② 端口文件存在但没人监听 ⇒ 如实报错、不卡死 ----------
  {
    writeFileSync(portFile, "9\n", "utf8"); // 9 = discard：本机不会有人听
    const r = await runBridge({
      env: { SHUYONOTE_MCP_PORT_FILE: portFile, SHUYONOTE_MCP_TOKEN_FILE: tokenFile },
      lines: [{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pages_search", arguments: {} } }],
      timeoutMs: 8000,
    });
    const line = r.parsed[0];
    ok(!!line && !!line.value.error, "端口没人听时回的是 error ✓（不是静默成功 ✓）");
    ok(/连不上|通道未开/.test(String(line?.value?.error?.message || "")), `错误里说清是"连不上"（拿到：${line?.value?.error?.message}）`);
  }

  // ---------- ③④⑤ 起一个**假 App 通道**（夹具 ✓）⇒ 真转发 ----------
  const seen = [];
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      seen.push({ method: parsed.method, args: parsed.args, auth: req.headers.authorization, host: req.headers.host });
      if (parsed.method === "__tools_list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          result: {
            tools: [
              { name: "pages_search", capabilityId: "pages.search", description: "搜页面", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
              { name: "files_read", capabilityId: "files.read", description: "读文件", inputSchema: { type: "object" } },
            ],
          },
        }));
        return;
      }
      if (parsed.method === "pages.search") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { hits: [{ id: "p1", title: "命中" }] } }));
        return;
      }
      // 别的调用：**如实拒绝**（模拟 App 判权限不过 ✓ —— 桥必须原样带回 ✗ 不许吞 ✓）
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "permission_denied: 缺 read:pages" }));
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  writeFileSync(portFile, String(fake.address().port) + "\n", "utf8");

  {
    const r = await runBridge({
      env: { SHUYONOTE_MCP_PORT_FILE: portFile, SHUYONOTE_MCP_TOKEN_FILE: tokenFile },
      lines: [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pages_search", arguments: { q: "命" } } },
        // ⚠️ 这一条要用**清单里真有**的工具（`files_read` ✓）—— 夹具会拒它（模拟 App 判权限不过 ✓）；
        //    用清单外的名字只会测出"未知工具"✗（那是另一条路径 ✓）
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "files_read", arguments: { id: "f1" } } },
      ],
      timeoutMs: 8000,
    });
    ok(r.parsed.length >= 4 && r.parsed.every((p) => p.okJson), "全程 stdout 只有协议行（4 条请求 ⇒ 每行都 JSON.parse 得动 ✓）");
    const byId = new Map(r.parsed.map((p) => [p.value?.id, p.value]));
    ok(byId.get(1)?.result?.serverInfo?.name === "shuyonote-bridge", "initialize 回了 serverInfo ✓");
    const tools = byId.get(2)?.result?.tools || [];
    ok(tools.length === 2 && tools[0]?.name === "pages_search", `tools/list 把 App 给的清单**原样**翻出来（${tools.length} 条，第一条 ${tools[0]?.name}）`);
    ok(tools[0]?.["x-shuyonote-capability"] === "pages.search", "工具上带回了能力 id（调用时按它转发 ✓）");
    const callRes = byId.get(3)?.result?.content;
    ok(Array.isArray(callRes) && String(callRes[0]?.text || "").includes("命中"), "tools/call 把 App 的结果包成 content[] 回给 agent ✓");
    ok(
      String(byId.get(4)?.error?.message || "").includes("permission_denied"),
      `App 拒绝时桥**如实带回**（拿到：${byId.get(4)?.error?.message}）—— 桥不自己判权限 ✗`,
    );
    const listCall = seen.find((s) => s.method === "__tools_list");
    const realCall = seen.find((s) => s.method === "pages.search");
    ok(!!listCall && !!realCall, "夹具收到两次真请求：清单一次 ＋ 调用一次 ✓");
    ok(realCall?.args?.q === "命", "转发时**参数原样**带上（没有被桥改写 ✓）");
    ok(
      String(realCall?.auth || "") === "Bearer " + TOKEN,
      "转发带 `Authorization: Bearer <token>`（token 由桥从文件读、**校验在 App** ✓）",
    );
    ok(/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(realCall?.host || "")), `Host 是回环（拿到 ${realCall?.host} ✓）`);
  }

  await new Promise((r) => fake.close(r));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
