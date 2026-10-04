#!/usr/bin/env node
// check-mcp-host-authz.mjs —— 「外部宿主的每次能力调用都经**同一处**权限校验」的静态判据
//   （规格 `docs/specs/2026-09-28-mcp-host-spec.md` §2 的 `INV-MCP-single-authz` ✓）
//
// 挡的是哪一类事故（为什么它危险）：
//   MCP 宿主面一旦**自己开库**或**自己判权限**，就长出**第二条鉴权路径** ✗ ——
//   于是「未解锁就大声失败」「写必须经草稿确认」「每次调用都留审计」这些**都只对插件那条路成立** ✓，
//   而外部 agent 从另一条路进来，全部绕过 ✓（而测试全绿、没有一条门禁会红 ✗ —— 本仓最忌的形状）。
//
// 判据（窄；**纯读源码 ⇒ 不需要 cargo** ✓）：
//   ① `dispatch_capability` 必须存在（唯一鉴权点 ✓）—— 它没了 ⇒ 红（这是真回归 ✗）
//   ② 宿主面文件（`src-tauri/src/mcp_host.rs`）**存在时**：
//      · 必须**调用** `dispatch_capability`（否则它自己就是另一条路 ✗）
//      · **不许**自己开库（`Connection::open` / `rusqlite::Connection|Connection::`）
//      · **不许**自己判权限（`has_permission` / `require_permission` / `check_permission`）
//   ③ 宿主面**不存在时** ⇒ 按登记形态「**绿 ＋ 自报跳过**」（先例 `rust-sm-wired` / `check-mcp-bridge-stdout` ✓）：
//      跳过 ≠ 通过；注册表 `selfSkipOk` 声明理由，`--strict-self-skip` 下按失败计 ✓；
//      判据先行阶段要看那次"红"就加 `--require-host` ⇒ exit 2（逐字含「宿主面不存在 / 无可检查对象」✓）
//
// ⚠️ **命中必须落在代码里**（2026-10-01 修 ✓）：上面那些名字都用 `rustRegions` **掩掉注释/字符串/字符字面量**
//   之后再找 ✓ —— 两个方向都得修，而且两个方向都真踩过：
//     · 假红 ✗：我刚写下 `mcp_host.rs`，它的模块文档里**在讲这条规矩**（"不许出现 `Connection::…`"）
//       ⇒ 判据把**讲解**当成了**违规** ⇒ 红 ✓（本仓同一个坑 `check-dead-code-receipts` 早有先例：
//       "仓库里有十几处注释在讲这件事，拿 grep 数会把它们全算成违规"）。
//     · 假绿 ✗：反过来，把 `dispatch_capability(` 写进**字符串**或注释里也能满足正面断言 ⇒
//       "调用"变成了"提了一嘴"（判据比事实宽 ✗）。掩码把这一半也堵上了 ✓。
//     ⇒ 两条都进了自测（注释讲规矩 ⇒ 必须绿／把调用藏进字符串 ⇒ 必须红 ✓）。
//
// 退出码（与兄弟判据同形 ✓）：0 干净（含登记形态的自报跳过）／1 有发现／2 环境不具备或读不到源码（**不算通过**）
// 用法：
//   node scripts/check-mcp-host-authz.mjs
//   node scripts/check-mcp-host-authz.mjs --host <路径>      # 用别的宿主面文件
//   node scripts/check-mcp-host-authz.mjs --plugins <路径>   # 用别的 plugins.rs
//   node scripts/check-mcp-host-authz.mjs --require-host     # 宿主面不在 ⇒ exit 2（判据先行阶段看红用）
//   node scripts/check-mcp-host-authz.mjs --self-test        # 夹具：正例／三种变异／缺席＋require
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { rustRegions } from "./lib/rust-scan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const PLUGINS_DEFAULT = join(ROOT, "src-tauri", "src", "plugins.rs");
export const HOST_DEFAULT = join(ROOT, "src-tauri", "src", "mcp_host.rs");
const AUTHZ_POINT = "dispatch_capability";

/**
 * 只留**代码**：注释 / 字符串 / 字符字面量一律换成空白（换行保留 ⇒ 行号对得上 ✓）。
 * 为什么要它：判据找的是**名字**，而"讲解这条规矩的注释"与"真的这么写的代码"在原文里长得一样 ✗
 * （今天就是这么假红的 ✓）；反过来，把调用藏进字符串也会假绿 ✗。掩码把两个方向一起堵上 ✓。
 * 方向性约定照 `lib/rust-scan.mjs`：**宁可不切（多算 ⇒ 假红，看得见），绝不漏切（少算 ⇒ 假绿，看不见）** ✓。
 */
export function codeOnly(text) {
  const M = rustRegions(text);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    out += M[i] === 0 ? text[i] : text[i] === "\n" ? "\n" : " ";
  }
  return out;
}

/** 判据：(plugins.rs 文本, 宿主面文本|null) ⇒ findings（空＝干净 ✓） */
export function judge(pluginsText, hostText) {
  const out = [];
  if (pluginsText === null) {
    out.push("✗ 读不到 `src-tauri/src/plugins.rs` ⇒ **判据没检查到东西**（不算通过 ✗）");
    return out;
  }
  const pluginsCode = codeOnly(pluginsText);
  if (!new RegExp("fn\\s+" + AUTHZ_POINT + "\\b").test(pluginsCode)) {
    out.push("✗ 找不到唯一鉴权点 `" + AUTHZ_POINT + "` ⇒ 每次能力调用不再经同一处校验 ✗（这条不变式的地基没了）");
  }
  if (hostText === null) return out; // 缺席 ⇒ 由 run() 决定"登记形态跳过 / exit 2"
  const hostCode = codeOnly(hostText);
  if (!hostCode.includes(AUTHZ_POINT + "(")) {
    out.push("✗ 宿主面没有调用 `" + AUTHZ_POINT + "(…)` ⇒ **它自己就是第二条鉴权路径** ✗（权限/解锁/审计全绕开）");
  }
  if (/Connection::open|rusqlite::Connection|Connection::/.test(hostCode)) {
    out.push("✗ 宿主面**自己开库** ✗（不变式原话：宿主面不许自己开库）⇒ 它看到的库状态可以绕过统一校验");
  }
  for (const bad of ["has_permission", "require_permission", "check_permission"]) {
    if (new RegExp("fn\\s+" + bad + "\\b|" + bad + "\\(").test(hostCode)) {
      out.push("✗ 宿主面**自己判权限**（出现 `" + bad + "` ✗）⇒ 权限判定长出了第二处实现");
    }
  }
  return out;
}

function run(hostPath, pluginsPath, requireHost) {
  if (!existsSync(pluginsPath)) {
    console.error("✗ 读不到 " + pluginsPath.replace(ROOT, ".") + "（**不算通过**）");
    return 2;
  }
  const pluginsText = readFileSync(pluginsPath, "utf8");
  const hostText = existsSync(hostPath) ? readFileSync(hostPath, "utf8") : null;
  if (hostText === null) {
    // 登记形态：绿 ＋ 自报跳过（跳过 ≠ 通过 ✓）
    const why = "MCP 宿主面还不存在（`" + hostPath.replace(ROOT, ".").replace(/\\/g, "/") + "` 未创建 ⇒ M1 Task 5 未做）";
    console.error("! 自报跳过（不装绿）：" + why + " ⇒ 本条判据现在没有可检查对象");
    if (requireHost) {
      console.error("  ⇒ 已给 `--require-host` ⇒ 按「宿主面不存在 / 无可检查对象」exit 2（**不算通过** ✗）");
      return 2;
    }
    console.error("  ⇒ 登记形态：绿 ＋ 自报跳过（判据先行阶段的正常状态 ✓；要看红就加 `--require-host`）");
    const f0 = judge(pluginsText, null);
    if (f0.length) { for (const x of f0) console.error(x); return 1; }
    return 0;
  }
  const f = judge(pluginsText, hostText);
  if (f.length) { for (const x of f) console.error(x); return 1; }
  console.log("✓ 单一鉴权点成立：`" + AUTHZ_POINT + "` 在 ✓ ｜ 宿主面调用了它 ✓ ｜ 不自开库 ✓ ｜ 不自判权限 ✓");
  return 0;
}

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? (isAbsolute(v) ? v : join(ROOT, v)) : dflt;
};
const PLUGINS = argOf("--plugins", PLUGINS_DEFAULT);
const HOST = argOf("--host", HOST_DEFAULT);
const REQUIRE_HOST = argv.includes("--require-host");

if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-authz-"));
  try {
    const plugins = 'fn dispatch_capability(method: &str, args_json: &str) -> Result<String, String> { Ok(String::new()) }\n';
    const good = 'pub fn handle(method: &str, args: &str) -> Result<String, String> {\n    dispatch_capability(method, args)\n}\n';
    const noCall = 'pub fn handle(method: &str, args: &str) -> Result<String, String> {\n    Ok("{}".to_string())\n}\n';
    const ownDb = 'pub fn handle() { let c = Connection::open("x.db").unwrap(); }\nfn dispatch_capability() {}\n';
    const ownPerm = 'pub fn handle() { if has_permission("read:pages") { } }\n fn dispatch_capability() {}\n';
    // ⚠️ 2026-10-01 加的三条：掩码的两个方向（**假红**：注释里讲规矩 ⇒ 必须绿／**假绿**：把调用藏进字符串 ⇒ 必须红 ✓）
    const commentedOk = '// 不许 Connection::open，也不许 has_permission\npub fn handle(m: &str, a: &str) -> Result<String, String> { dispatch_capability(m, a) }\n';
    const callInString = 'pub fn handle() { let _ = "dispatch_capability(x)"; }\n';
    const forbiddenInString = 'pub fn handle() { let s = "Connection::open(\'x\')"; dispatch_capability(1, 2); }\n';
    const write = (n, t) => { const p = join(dir, n); writeFileSync(p, t, "utf8"); return p; };
    const pPlugins = write("plugins.rs", plugins);
    const pGood = write("mcp_host_good.rs", good);
    const pNoCall = write("mcp_host_nocall.rs", noCall);
    const pOwnDb = write("mcp_host_owndb.rs", ownDb);
    const pOwnPerm = write("mcp_host_ownperm.rs", ownPerm);
    const cases = [
      ["正例（宿主面调用唯一鉴权点）", run(pGood, pPlugins, false), 0],
      ["变异①（宿主面不调用它）", run(pNoCall, pPlugins, false), 1],
      ["变异②（宿主面自己开库）", run(pOwnDb, pPlugins, false), 1],
      ["变异③（宿主面自己判权限）", run(pOwnPerm, pPlugins, false), 1],
      ["宿主面缺席（**登记形态**：绿 ＋ 自报跳过）", run(join(dir, "nope.rs"), pPlugins, false), 0],
      ["唯一鉴权点消失（plugins.rs 里没有 `dispatch_capability`）", run(join(dir, "nope.rs"), write("plugins_noauthz.rs", "fn other() {}\n"), false), 1],
      // ⚠️ 掩码的两个方向（都真踩过 ✓）
      ["注释里讲这条规矩（`Connection::open`/`has_permission` 只出现在注释里）⇒ **必须绿**", run(write("host_commented.rs", commentedOk), pPlugins, false), 0],
      ["把调用藏进**字符串**（`\"dispatch_capability(x)\"`）⇒ **必须红**（假绿方向 ✓）", run(write("host_instr.rs", callInString), pPlugins, false), 1],
      ["禁用名字只出现在**字符串**里（代码里真调了鉴权点）⇒ **必须绿**", run(write("host_strforbid.rs", forbiddenInString), pPlugins, false), 0],
    ];
    let pass = 0;
    for (const [name, got, want] of cases) {
      const okc = got === want;
      if (okc) pass++;
      console.log(`  ${okc ? "✓" : "✗"} ${name} ⇒ exit=${got}（期望 ${want}）`);
    }
    // 端到端第 7 条：`--require-host` ＋ 宿主面不在 ⇒ exit 2（判据先行阶段要看的那次"红" ✓）
    const req = (await import("node:child_process")).spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--require-host", "--host", join(dir, "nope.rs"), "--plugins", pPlugins],
      { encoding: "utf8" },
    );
    const reqOk = req.status === 2 && String(req.stderr).includes("宿主面不存在 / 无可检查对象");
    if (reqOk) pass++;
    console.log(`  ${reqOk ? "✓" : "✗"} --require-host ＋ 宿主面不在 ⇒ exit=${req.status}（期望 2，且逐字含「宿主面不存在 / 无可检查对象」）`);
    const total = cases.length + 1;
    console.log(`self-test: ${pass}/${total} 通过`);
    process.exit(pass === total ? 0 : 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(run(HOST, PLUGINS, REQUIRE_HOST));
