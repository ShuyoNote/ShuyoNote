#!/usr/bin/env node
// tools/shuyonote-mcp/judge-channel.mjs —— MCP 桥「本机通道」的判据（施工单 Task 4 的 Step 1，判据先行 ✓）
//
// 规格：`docs/specs/2026-09-28-mcp-host-spec.md` §2 的 `INV-MCP-channel-guarded` ——
//   「通道默认关；开启时 per-session token ＋ `Origin`/`Host` 校验；坏 Origin / 过期 token 必须被拒
//     （关掉开关后旧 token 立刻失效）」✓
//
// 四条断言（都是**真实事故形状** ✓）：
//   ① **默认关**时连接必须被拒（不装"默认开着只是别人不知道"✗）
//   ② **坏 `Origin` 必须被拒** —— 尤其 `http://127.0.0.1.evil.com` ✓：
//      ⚠️ 本仓**真栽过**：`docs/SECURITY.md` 低危项逐字「**CORS 前缀匹配放过 `http://127.0.0.1.evil.com`**（`lib.rs:155`）」✗
//      ⇒ 所以必须用**前缀陷阱值**去试 ✓（随便一个外域连前缀匹配都挡得住，测不出这个坑 ✗）
//   ③ **过期 / 错误 token** 必须被拒
//   ④ **关掉开关后旧 token 立刻失效**（否则"关掉"只是心理安慰 ✗）
//   ＋ 判据自己还查"**正常态必须 2xx**"（否则"全都拒"也能骗过上面两条 ✗）
//
// ## 夹具契约（本判据定；真实桥落地时可以改，**但同时要改本判据** ✓）
//   判据 `spawn` 一个"桥"，给它三样环境变量：
//     · `SHUYONOTE_MCP_SWITCH`      = `on` | `off`   —— 通道开关（默认必须 off ✓）
//     · `SHUYONOTE_MCP_TOKEN_FILE`  = **装着会话 token 的文件路径** ✓
//         ⚠️ 2026-10-01 定：施工单 Task 4 Step 3 逐字要求「token 落在**只有当前用户可读**的文件里」✓
//            ⇒ 只给**路径**、不给值 ✓ ⇒ 忽略文件只认 env 的桥拿不到 token ⇒ 连正常态都过不去 ✓
//            ⇒ 那条要求才真的**被验过**，而不是"被相信"✓。判据自己用 `0600` 建它 ✓，
//            并在 POSIX 上核它没被改宽 ✓（Windows 权限位不可核 ⇒ **明说不可核** ✓，不假绿 ✗）。
//     · `SHUYONOTE_MCP_ORIGIN_ALLOW`= `loopback`
//   桥必须：把**实际监听的端口**以 `PORT=<n>` 打到 **stderr 一行** ✓ 然后在该端口收 HTTP：
//     ⚠️ **为什么是 stderr**：MCP 是**行分隔 JSON-RPC over stdio** ✓，stdout **只许协议消息** ✓
//        （AMD 的 `check-mcp-bridge-stdout` 逐字如此 ✓，并明说「**stderr 可以有内容**」✓）——
//        原先这里写 stdout，与那条判据**对撞** ✗ ⇒ 已改 stderr ✓。
//     · 开关 off ⇒ **拒绝**（连不上或非 2xx 都算"拒" ✓）
//     · `Origin` 不是"恰好回环"（含前缀陷阱值）⇒ **403**
//     · token 缺失 / 不匹配 / 已过期 ⇒ **401**
//     · 三者都对 ⇒ **200**
//
// 退出码（与兄弟判据同形 ✓）：0 干净 ／ 1 有发现 ／ 2 无可检查对象（**不算通过**）
// 用法：
//   node tools/shuyonote-mcp/judge-channel.mjs                     # 真跑（桥不存在 ⇒ 绿＋自报跳过 ✓）
//   node tools/shuyonote-mcp/judge-channel.mjs --bridge <路径>
//   node tools/shuyonote-mcp/judge-channel.mjs --require-bridge     # 桥不在 ⇒ exit 2（看那次红用 ✓）
//   node tools/shuyonote-mcp/judge-channel.mjs --self-test          # 6 条夹具（每条都能红 ✓）
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, chmodSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(dirname(HERE));
export const BRIDGE_DEFAULT = join(ROOT, "tools", "shuyonote-mcp", "index.mjs");
const BAD_ORIGIN = "http://127.0.0.1.evil.com"; // ⚠️ SECURITY.md 里的前缀陷阱值 ✓
const GOOD_ORIGIN = "http://127.0.0.1";         // 恰好回环（端口由桥自己报 ✓）

/** 起一个桥，等它在 stderr 上报 PORT=；返回 {port, stop} */
export async function startBridge(bridgePath, env0, timeoutMs = 8000) {
  const child = spawn(process.execPath, [bridgePath], {
    cwd: ROOT,
    env: { ...process.env, ...env0 },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  const port = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    child.stderr.on("data", (d) => {
      buf += String(d);
      const m = buf.match(/PORT=(\d+)/);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    child.on("exit", () => { clearTimeout(t); resolve(null); });
  });
  return { port, stop: () => { try { child.kill(); } catch { /* 已退出 ✓ */ } } };
}

/** 对回环端口发一条 HTTP 请求；连接被拒/超时/非 2xx 都如实返回 0 */
export function probe(port, { origin, token }) {
  const args = ["-s", "-o", "NUL", "-w", "%{http_code}", "--max-time", "4",
    "-H", "Origin: " + origin, "-H", "Host: 127.0.0.1:" + port];
  if (token) args.push("-H", "Authorization: Bearer " + token);
  args.push("http://127.0.0.1:" + port + "/");
  const r = spawnSync("curl", args, { encoding: "utf8", timeout: 8000 });
  const code = Number(String(r.stdout || "").trim());
  return Number.isFinite(code) ? code : 0;
}

/** 纯判据：跑四条断言，返回 findings（空＝干净 ✓） */
export async function judgeChannel(b, token, tokenFile) {
  const out = [];
  const env = (sw) => ({ SHUYONOTE_MCP_SWITCH: sw, SHUYONOTE_MCP_TOKEN_FILE: tokenFile });
  const reject = (what, code) => {
    if (code >= 200 && code < 300) out.push("✗ " + what + "：**被放行了**（HTTP " + code + "）⇒ 与不变式相反 ✗");
  };

  // ① 默认关（显式 off）⇒ 必须拒
  const off = await b.start(env("off"));
  try { if (off.port) reject("① 默认关（switch=off）仍能连上", probe(off.port, { origin: GOOD_ORIGIN, token })); }
  finally { off.stop && off.stop(); }

  // 开关打开，其余三条在这个态里试 ✓
  const on = await b.start(env("on"));
  try {
    if (!on.port) {
      out.push("✗ 开关打开时桥没有上报 `PORT=` ⇒ 无法核验 ②③④（判据**没检查到东西** ⇒ 不算通过 ✗）");
    } else {
      const badOrigin = probe(on.port, { origin: BAD_ORIGIN, token });
      if (badOrigin >= 200 && badOrigin < 300) out.push("✗ ② 坏 `Origin` 被放行（HTTP " + badOrigin + "）—— 尤其是 `" + BAD_ORIGIN + "` ✗（本仓 `docs/SECURITY.md` 记过：前缀匹配放过它）");
      else if (badOrigin !== 403) out.push("⚠️ ② 坏 `Origin` 没被放行 ✓，但回的是 HTTP " + badOrigin + "（期望 403）—— 不算违规，请确认是有意的 ✓");

      const badToken = probe(on.port, { origin: GOOD_ORIGIN, token: token + "-wrong" });
      if (badToken >= 200 && badToken < 300) out.push("✗ ③ 错误 token 被放行（HTTP " + badToken + "）⇒ 通道等于没有鉴权 ✗");
      else if (badToken !== 401) out.push("⚠️ ③ 错误 token 没被放行 ✓，但回的是 HTTP " + badToken + "（期望 401）");

      const okCode = probe(on.port, { origin: GOOD_ORIGIN, token });
      if (!(okCode >= 200 && okCode < 300)) out.push("✗ 正常态（on ＋ 对 token ＋ 回环 Origin）没有 2xx（HTTP " + okCode + "）⇒ 判据退化成「全都拒」✗");
    }
  } finally { on.stop && on.stop(); }

  // ④ 关掉开关后旧 token 立刻失效
  const on2 = await b.start(env("on"));
  try {
    if (on2.port) {
      const first = probe(on2.port, { origin: GOOD_ORIGIN, token });
      if (!(first >= 200 && first < 300)) out.push("✗ ④ 前置：开关 on 时正常请求没通过（HTTP " + first + "）⇒ 这条核不了");
      on2.stop && on2.stop();
      const off2 = await b.start(env("off"));
      try { if (off2.port) reject("④ 关掉开关后**旧 token** 仍能连上", probe(off2.port, { origin: GOOD_ORIGIN, token })); }
      finally { off2.stop && off2.stop(); }
    }
  } finally { on2.stop && on2.stop(); }
  return out;
}

/** 真跑：桥不在 ⇒ 登记形态（绿＋自报跳过 ✓）／`--require-bridge` ⇒ exit 2 ✓ */
async function run(bridgePath, requireBridge) {
  if (!existsSync(bridgePath)) {
    console.error("  ! 自报跳过（不装绿）：MCP 桥还不存在（M1 Task 3/4 未做）⇒ 本条判据现在没有可检查对象");
    if (requireBridge) {
      console.error("  ⇒ 已给 `--require-bridge` ⇒ 按「桥不存在 / 无可检查对象」exit 2（**不算通过** ✗ —— 施工单 Step 2 期望的读数就是「2 或 1，不许是 0」✓）");
      return 2;
    }
    console.error("  ⇒ 登记形态：绿 ＋ 自报跳过（判据先行阶段的正常状态 ✓；要看那次红就加 `--require-bridge`）");
    return 0;
  }
  const token = "t-" + Math.random().toString(36).slice(2, 10);
  const dir = mkdtempSync(join(tmpdir(), "judge-channel-tok-"));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, token + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(tokenFile, 0o600); } catch { /* Windows：权限位不可核 ⇒ 下面明说 ✓ */ }
  const b = { start: (env) => startBridge(bridgePath, env) };
  const f = await judgeChannel(b, token, tokenFile);
  if (f.length) { for (const x of f) console.error(x); return 1; }
  // token 文件不许被改宽（POSIX 可核 ✓；Windows 明说"不可核"✓，不假绿 ✗）
  let mode = null;
  try { mode = statSync(tokenFile).mode & 0o777; } catch { mode = null; }
  if (process.platform === "win32") console.log("  ⚠️ token 文件权限：Windows 上不可核（ACL 模型不同）⇒ 本项**没查过** ✓");
  else if (mode !== 0o600) { console.error("✗ token 文件权限被改宽：期望 0600，实际 0" + (mode === null ? "?" : mode.toString(8)) + " ✗（施工单要求只有当前用户可读 ✓）"); return 1; }
  else console.log("  ✓ token 文件权限 0600（只有当前用户可读 ✓）");
  console.log("✓ 通道有闸：默认关 ✓ ｜ 坏 Origin（含前缀陷阱值）被拒 ✓ ｜ 错 token 被拒 ✓ ｜ 关闸后旧 token 失效 ✓ ｜ token 在 0600 的文件里 ✓");
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "judge-channel-"));
  try {
    // 夹具桥：遵守契约（token 从**文件**读 ✓、端口报 **stderr** ✓）；`FIXTURE_FAULT` 故意违反某一条 ✓
    const FIXTURE = [
      'import { readFileSync } from "node:fs";',
      'import http from "node:http";',
      'const SWITCH = process.env.SHUYONOTE_MCP_SWITCH === "on";   // 默认关 ✓',
      'const TOKEN = readFileSync(process.env.SHUYONOTE_MCP_TOKEN_FILE || "", "utf8").trim();',
      'const FAULT = process.env.FIXTURE_FAULT || "";',
      'if (!SWITCH && FAULT !== "ignore-switch") process.exit(0);   // 默认关 ⇒ 压根不监听 ✓',
      'const srv = http.createServer((req, res) => {',
      '  const origin = req.headers.origin || "";',
      '  const auth = (req.headers.authorization || "").replace(/^Bearer /, "");',
      '  if (FAULT !== "no-origin") {',
      '    const okOrigin = origin === "http://127.0.0.1" || /^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(origin) || origin === "";',
      '    if (!okOrigin) { res.writeHead(403); res.end("bad origin"); return; }',
      '  }',
      '  if (FAULT !== "accept-any-token" && auth !== TOKEN) { res.writeHead(401); res.end("bad token"); return; }',
      '  res.writeHead(200); res.end("ok");',
      '});',
      'srv.listen(0, "127.0.0.1", () => console.error("PORT=" + srv.address().port));',
    ].join("\n");
    const p = (n) => { const f = join(dir, n); writeFileSync(f, FIXTURE, "utf8"); return f; };
    const mkTf = (tok) => { const tf = join(dir, "tok-" + Math.random().toString(36).slice(2, 8)); writeFileSync(tf, tok + "\n", { encoding: "utf8", mode: 0o600 }); return tf; };
    const good = p("bridge-ok.mjs");
    const cases = [
      ["正例（四条都守）", good, "", 0],
      ["变异①（忽略开关 ⇒ 关着也能连）", good, "ignore-switch", 1],
      ["变异②（去掉 Origin 校验 ⇒ 前缀陷阱值被放行）", good, "no-origin", 1],
      ["变异③（接受任意 token）", good, "accept-any-token", 1],
    ];
    let pass = 0;
    for (const [name, bridge, fault, want] of cases) {
      const token = "t-" + Math.random().toString(36).slice(2, 8);
      const b = { start: (env) => startBridge(bridge, { ...env, FIXTURE_FAULT: fault }) };
      const f = await judgeChannel(b, token, mkTf(token));
      const got = f.length ? 1 : 0;
      const okc = got === want;
      if (okc) pass++;
      console.log(`  ${okc ? "✓" : "✗"} ${name} ⇒ exit=${got}（期望 ${want}）` + (f.length ? " ｜ " + f[0].slice(0, 88) : ""));
    }
    const skip = await run(join(dir, "nope.mjs"), false);
    const okSkip = skip === 0;
    if (okSkip) pass++;
    console.log(`  ${okSkip ? "✓" : "✗"} 空扫（**登记形态**：绿＋自报跳过）⇒ exit=${skip}（期望 0）`);
    const reqEmpty = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--require-bridge", "--bridge", join(dir, "nope.mjs")], { encoding: "utf8" });
    const okReq = reqEmpty.status === 2;
    if (okReq) pass++;
    console.log(`  ${okReq ? "✓" : "✗"} 空扫 ＋ \`--require-bridge\` ⇒ exit=${reqEmpty.status}（期望 2，**不是 0** ✗）`);
    const total = cases.length + 2;
    console.log(`self-test: ${pass}/${total} 通过`);
    process.exit(pass === total ? 0 : 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const bi = argv.indexOf("--bridge");
const BRIDGE = bi >= 0 && argv[bi + 1] && !argv[bi + 1].startsWith("--")
  ? (isAbsolute(argv[bi + 1]) ? argv[bi + 1] : join(ROOT, argv[bi + 1]))
  : BRIDGE_DEFAULT;
process.exit(await run(BRIDGE, argv.includes("--require-bridge")));
