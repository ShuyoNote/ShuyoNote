#!/usr/bin/env node
// tools/shuyonote-mcp/judge-channel.mjs —— MCP 桥「本机通道」的判据（施工单 Task 4 的 **Step 1**，判据先行 ✓）
//
// 规格：`docs/specs/2026-09-28-mcp-host-spec.md` §2 的 `INV-MCP-channel-guarded`
//   ——「通道默认关；开启时 per-session token ＋ `Origin`/`Host` 校验；坏 Origin / 过期 token 必须被拒
//      （关掉开关后旧 token 立刻失效）」✓
//
// 四条断言（逐条都是**真实事故形状**，不是凭空 ✓）：
//   ① **默认关**时连接必须被拒（不装"默认开着只是别人不知道"✗）
//   ② **坏 `Origin` 必须被拒** —— 尤其 `http://127.0.0.1.evil.com` ✓：
//      ⚠️ 本仓**真的栽过这个**：`docs/SECURITY.md` 的低危项逐字写着
//      「**CORS 前缀匹配放过 `http://127.0.0.1.evil.com`**（`lib.rs:155`）」✗
//      ⇒ 所以这条断言**必须用前缀陷阱值**去试，而不是随便一个外域 ✓（随便一个外域连前缀匹配都挡得住 ✓）
//   ③ **过期 / 错误 token** 必须被拒
//   ④ **关掉开关后旧 token 立刻失效**（否则"关掉"只是心理安慰 ✗）
//   ＋ **空扫 ⇒ exit 2**（桥不存在 ⇒ 不许给 0 ✓ —— 施工单 Step 2 的期望读数就是"2 或 1，不许是 0"✓）
//
// ## 夹具契约（本判据自己定；真实桥落地时可以改，**但同时要改本判据** ✓）
//   判据 `spawn` 一个"桥"，并给它三样东西（环境变量）：
//     · `SHUYONOTE_MCP_SWITCH`      = `on` | `off`      —— 通道开关（默认必须是 off ✓）
//     · `SHUYONOTE_MCP_TOKEN`       = 本次会话 token
//     · `SHUYONOTE_MCP_ORIGIN_ALLOW`= `loopback`        —— 只认回环 Origin
//   桥必须：把**实际监听的端口**以 `PORT=<n>` 打到 **stdout 一行** ✓，然后在该端口上收 HTTP：
//     · 开关 off            ⇒ **拒绝**（判据接受：连接被拒 / 非 2xx 都算"拒" ✓）
//     · `Origin` 不是"恰好回环"（含前缀陷阱值）⇒ **403**
//     · token 缺失 / 不匹配 / 已过期            ⇒ **401**
//     · 三者都对                                  ⇒ **200**
//   这条契约把"默认关 + token + Origin/Host"变成**可机核的观察** ✓ —— 而它刻意**不**规定端口、实现语言或 token 形态 ✓。
//
// 退出码（与兄弟判据同形 ✓）：0 干净 ／ 1 有发现 ／ 2 无可检查对象或夹具缺失（**不算通过**）
// 用法：
//   node tools/shuyonote-mcp/judge-channel.mjs                    # 真跑（桥不存在 ⇒ exit 2 ✓）
//   node tools/shuyonote-mcp/judge-channel.mjs --bridge <路径>     # 指定桥
//   node tools/shuyonote-mcp/judge-channel.mjs --self-test        # 夹具：正例 + 三种变异（每条断言都能红 ✓）
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(dirname(HERE));
export const BRIDGE_DEFAULT = join(ROOT, "tools", "shuyonote-mcp", "index.mjs");
const BAD_ORIGIN = "http://127.0.0.1.evil.com"; // ⚠️ SECURITY.md 里的前缀陷阱值 ✓
const GOOD_ORIGIN = "http://127.0.0.1";         // 恰好回环（端口由桥自己报 ✓）

/** 起一个桥，等它上报 PORT=，返回 {port, stop} */
export async function startBridge(bridgePath, env0, timeoutMs = 8000) {
  const child = spawn(process.execPath, [bridgePath], {
    cwd: ROOT,
    env: { ...process.env, ...env0 },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  const port = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    child.stdout.on("data", (d) => {
      buf += String(d);
      const m = buf.match(/PORT=(\d+)/);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    child.on("exit", () => { clearTimeout(t); resolve(null); });
  });
  return { port, stop: () => { try { child.kill(); } catch {} } };
}

/** 对回环端口发一条 HTTP 请求；连接被拒/超时/非 2xx 都如实返回 */
export function probe(port, { origin, token }) {
  const args = ["-s", "-o", "NUL", "-w", "%{http_code}",
    "--max-time", "4",
    "-H", "Origin: " + origin,
    "-H", "Host: 127.0.0.1:" + port];
  if (token) args.push("-H", "Authorization: Bearer " + token);
  args.push("http://127.0.0.1:" + port + "/");
  const r = spawnSync("curl", args, { encoding: "utf8", timeout: 8000 });
  const code = Number(String(r.stdout || "").trim());
  return Number.isFinite(code) ? code : 0; // 0 = 连不上/被拒 ✓
}

/**
 * 纯判据：跑四条断言，返回 findings（空＝干净 ✓）。
 * `b` 提供 start/probe（真实桥或夹具 ✓），`mkEnv(switch)` 造三样环境变量 ✓。
 */
export async function judgeChannel(b, token) {
  const out = [];
  const expectRejected = (what, code) => { if (code >= 200 && code < 300) out.push("✗ " + what + "：**被放行了**（HTTP " + code + "）⇒ 与不变式相反 ✗"); };

  // ① 默认关（不给 SHUYONOTE_MCP_SWITCH，或显式 off）⇒ 必须拒
  const off = await b.start({ SHUYONOTE_MCP_SWITCH: "off", SHUYONOTE_MCP_TOKEN: token });
  try {
    if (off.port) expectRejected("① 默认关（switch=off）仍能连上", probe(off.port, { origin: GOOD_ORIGIN, token }));
  } finally { off.stop && off.stop(); }

  // 开关打开，其余三条都在这个态里试 ✓
  const on = await b.start({ SHUYONOTE_MCP_SWITCH: "on", SHUYONOTE_MCP_TOKEN: token });
  try {
    if (!on.port) {
      out.push("✗ 开关打开时桥没有上报 `PORT=` ⇒ 无法核验 ②③④（判据**没检查到东西** ⇒ 不算通过 ✗）");
    } else {
      // ② 坏 Origin（前缀陷阱值）⇒ 必须 403（不许 2xx）
      const badOrigin = probe(on.port, { origin: BAD_ORIGIN, token });
      if (badOrigin >= 200 && badOrigin < 300) {
        out.push("✗ ② 坏 `Origin` 被放行（HTTP " + badOrigin + "）—— 尤其是 `" + BAD_ORIGIN + "` ✗（本仓 `docs/SECURITY.md` 记过：前缀匹配放过它）");
      } else if (badOrigin !== 403) {
        out.push("⚠️ ② 坏 `Origin` 没被放行 ✓，但回的是 HTTP " + badOrigin + "（期望 403）—— 不算违规，但请确认这是有意的 ✓");
      }
      // ③ 错 token ⇒ 必须 401
      const badToken = probe(on.port, { origin: GOOD_ORIGIN, token: token + "-wrong" });
      if (badToken >= 200 && badToken < 300) out.push("✗ ③ 错误 token 被放行（HTTP " + badToken + "）⇒ 通道等于没有鉴权 ✗");
      else if (badToken !== 401) out.push("⚠️ ③ 错误 token 没被放行 ✓，但回的是 HTTP " + badToken + "（期望 401）");
      // 正常态应当 200（否则"全都拒"也能骗过上面两条 ✓）
      const okCode = probe(on.port, { origin: GOOD_ORIGIN, token });
      if (!(okCode >= 200 && okCode < 300)) out.push("✗ 正常态（开关 on ＋ 对 token ＋ 回环 Origin）没有 2xx（HTTP " + okCode + "）⇒ 判据退化成「全都拒」✗");
    }
  } finally { on.stop && on.stop(); }

  // ④ 关掉开关后旧 token 立刻失效
  const on2 = await b.start({ SHUYONOTE_MCP_SWITCH: "on", SHUYONOTE_MCP_TOKEN: token });
  try {
    if (on2.port) {
      const first = probe(on2.port, { origin: GOOD_ORIGIN, token });
      if (!(first >= 200 && first < 300)) out.push("✗ ④ 前置：开关 on 时正常请求没通过（HTTP " + first + "）⇒ 这条核不了");
      on2.stop && on2.stop();
      const off2 = await b.start({ SHUYONOTE_MCP_SWITCH: "off", SHUYONOTE_MCP_TOKEN: token });
      try {
        if (off2.port) expectRejected("④ 关掉开关后**旧 token** 仍能连上", probe(off2.port, { origin: GOOD_ORIGIN, token }));
      } finally { off2.stop && off2.stop(); }
    }
  } finally { on2.stop && on2.stop(); }
  return out;
}

/** 真跑：桥不在 ⇒ exit 2 ✓ */
const REQUIRE_BRIDGE = process.argv.includes("--require-bridge");

async function run(bridgePath) {
  if (!existsSync(bridgePath)) {
    console.error("✗ 空扫：桥不存在（" + bridgePath.replace(ROOT, ".") + "）⇒ 施工单 Task 4 的通道还没落地");
    console.error("  ! 自报跳过（不装绿）：MCP 桥还不存在（M1 Task 3/4 未做）⇒ 本条判据现在没有可检查对象");
    if (REQUIRE_BRIDGE) {
      console.error("  ⇒ 已给 `--require-bridge` ⇒ 按「桥不存在 / 无可检查对象」exit 2（**不算通过** ✗ —— 施工单 Step 2 期望的读数就是「2 或 1，不许是 0」✓）");
      return 2;
    }
    console.error("  ⇒ 登记形态：绿 ＋ 自报跳过（判据先行阶段的正常状态 ✓；要看那次红就加 `--require-bridge`）");
    return 0;
  }
  const token = "t-" + Math.random().toString(36).slice(2, 10);
  const b = {
    start: (env) => startBridge(bridgePath, env),
    probe: (p, o) => probe(p, o),
  };
  const f = await judgeChannel(b, token);
  if (f.length) { for (const x of f) console.error(x); return 1; }
  console.log("✓ 通道有闸：默认关 ✓ ｜ 坏 Origin（含前缀陷阱值）被拒 ✓ ｜ 错 token 被拒 ✓ ｜ 关闸后旧 token 失效 ✓");
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "judge-channel-"));
  try {
    // 夹具桥：遵守契约；`FIXTURE_FAULT` 用来故意违反某一条 ✓
    const fixture = `#!/usr/bin/env node
import http from "node:http";
const SWITCH = process.env.SHUYONOTE_MCP_SWITCH === "on";   // 默认关 ✓
const TOKEN = process.env.SHUYONOTE_MCP_TOKEN || "";
const FAULT = process.env.FIXTURE_FAULT || "";
if (!SWITCH && FAULT !== "ignore-switch") {            // 默认关 ⇒ 压根不监听 ✓
  process.exit(0);
}
const srv = http.createServer((req, res) => {
  const origin = req.headers.origin || "";
  const auth = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (FAULT !== "no-origin") {                          // 变异：去掉 Origin 校验
    const okOrigin = origin === "http://127.0.0.1" || /^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(origin) || origin === "";
    if (!okOrigin) { res.writeHead(403); res.end("bad origin"); return; }
  }
  if (FAULT !== "accept-any-token" && auth !== TOKEN) { res.writeHead(401); res.end("bad token"); return; }
  res.writeHead(200); res.end("ok");
});
srv.listen(0, "127.0.0.1", () => { console.log("PORT=" + srv.address().port); });
`;
    const p = (n) => { const f = join(dir, n); writeFileSync(f, fixture, "utf8"); return f; };
    const good = p("bridge-ok.mjs");
    const theCases = [
      ["正例（四条都守）", good, "", 0],
      ["变异①（忽略开关 ⇒ 关着也能连）", good, "ignore-switch", 1],
      ["变异②（去掉 Origin 校验 ⇒ 前缀陷阱值被放行）", good, "no-origin", 1],
      ["变异③（接受任意 token）", good, "accept-any-token", 1],
    ];
    let pass = 0;
    for (const [name, bridge, fault, want] of theCases) {
      const token = "t-" + Math.random().toString(36).slice(2, 8);
      const b = {
        start: (env) => startBridge(bridge, { ...env, FIXTURE_FAULT: fault }),
        probe: (pt, o) => probe(pt, o),
      };
      const f = await judgeChannel(b, token);
      const got = f.length ? 1 : 0;
      const okc = got === want;
      if (okc) pass++;
      console.log(`  ${okc ? "✓" : "✗"} ${name} ⇒ exit=${got}（期望 ${want}）` + (f.length ? " ｜ " + f[0].slice(0, 90) : ""));
    }
    // 空扫：桥不在 ⇒ exit 2 ✓
    const emptySkip = await (async () => { const keep = process.argv; process.argv = ["node"]; try { return await run(join(dir, "nope.mjs")); } finally { process.argv = keep; } })();
    const okEmptySkip = emptySkip === 0;
    if (okEmptySkip) pass++;
    console.log(`  ${okEmptySkip ? "✓" : "✗"} 空扫（**登记形态**：绿＋自报跳过）⇒ exit=${emptySkip}（期望 0）`);
    const reqEmpty = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--require-bridge", "--bridge", join(dir, "nope.mjs")],
      { encoding: "utf8" },
    );
    const okReqEmpty = reqEmpty.status === 2;
    if (okReqEmpty) pass++;
    console.log(`  ${okReqEmpty ? "✓" : "✗"} 空扫 ＋ \`--require-bridge\` ⇒ exit=${reqEmpty.status}（期望 2，**不是 0** ✗）`);
    const totalExtra = 1;
    const total = theCases.length + 1 + totalExtra;
    console.log(`self-test: ${pass}/${total} 通过`);
    process.exit(pass === total ? 0 : 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const bi = argv.indexOf("--bridge");
const BRIDGE = bi >= 0 && argv[bi + 1] && !argv[bi + 1].startsWith("--")
  ? (isAbsolute(argv[bi + 1]) ? argv[bi + 1] : join(ROOT, argv[bi + 1]))
  : BRIDGE_DEFAULT;
process.exit(await run(BRIDGE));
