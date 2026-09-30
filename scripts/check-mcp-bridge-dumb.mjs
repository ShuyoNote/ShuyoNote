#!/usr/bin/env node
// scripts/check-mcp-bridge-dumb.mjs —— `INV-MCP-bridge-dumb`：**桥必须"哑"**
//
// 规格 `docs/specs/2026-09-28-mcp-host-spec.md` §2 的 `INV-MCP-bridge-dumb`：
//   「桥**只转发**，不做权限/落库/审计决策」✓
//
// 为什么这条必须**独立**存在（不能靠别的判据顺带 ✓）：
//   `check-mcp-bridge-stdout`（AMD 那条 ✓）管的是"stdout 只许协议帧"✓；`check-mcp-host-authz` 管的是
//   "宿主面不许自开鉴权"✓ —— **都不管"桥里有没有偷偷长出一个权限/落库分支"** ✗。
//   而桥是最容易被加料的地方：它离协议最近，顺手 `if (locked) return err` 或顺手查一次库，
//   **代码看着更聪明、测试全绿**，但"唯一鉴权点""同一本审计账"就同时被绕开了 ✗（本仓最忌的形状 ✓）。
//
// 判据四条（**"不许出现"型** ⇒ 桥不在时无对象 ✓，不假绿 ✗）：
//   ① 桥里**不许出现数据库访问**：`rusqlite` / `Connection::open` / `sqlite` / `execute(` 之类 ✗
//   ② 桥里**不许出现权限/解锁判定**：`has_permission` / `require_permission` / `space_locked` / `unlock` ✗
//   ③ 桥里**不许出现审计写入**：`push_audit` / `plugin_audit` / `INSERT INTO` ✗
//   ④ 桥里**不许出现"权威形态"的读写**：`content_json` / `content_text` / `chunks` 表 ✗
//      （桥只该搬字节与协议帧 ✓；上面四类都属于"决策与落库"，归宿主面与 `plugins.rs` ✓）
//
// 登记形态（与 `check-mcp-host-authz`／`judge-channel` 同形 ✓）：
//   桥不存在 ⇒ **绿 ＋ 自报跳过** ✓；要看那次红 ⇒ `--require-bridge` ⇒ **exit 2**（不算通过 ✗）
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 无对象或读不到（**不算通过**）
// 用法：node scripts/check-mcp-bridge-dumb.mjs ／ --bridge <路径> ／ --require-bridge ／ --self-test
import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const BRIDGE_DEFAULT = join(ROOT, "tools", "shuyonote-mcp", "index.mjs");

/** 四类"决策/落库"痕迹 —— 每条都给"为什么它属于宿主面而不是桥" ✓ */
export const FORBIDDEN = [
  { id: "db", why: "桥不许碰库（落库归宿主面／`plugins.rs`）", re: /rusqlite|Connection::open|sqlite3?|\.execute\s*\(/i },
  { id: "authz", why: "桥不许判权限/解锁（唯一鉴权点不在这里）", re: /has_permission|require_permission|check_permission|space_locked|unlock/i },
  { id: "audit", why: "桥不许写审计（同一本账由 `plugins.rs` 写）", re: /push_audit|plugin_audit|INSERT\s+INTO/i },
  { id: "authoritative", why: "桥不许读/写权威形态（`content_json`/`content_text`/`chunks`）", re: /content_json|content_text|\bchunks\b/i },
];

/** 纯判据：桥源码文本 ⇒ findings（空＝干净 ✓） */
export function judgeBridge(src) {
  const out = [];
  for (const f of FORBIDDEN) {
    const m = src.match(f.re);
    if (m) out.push("✗ 桥里出现了「" + m[0] + "」⇒ **它不哑了** ✗：" + f.why + "（`INV-MCP-bridge-dumb` ✓）");
  }
  return out;
}

function run(bridgePath, requireBridge) {
  if (!existsSync(bridgePath)) {
    console.error("  ! 自报跳过（不装绿）：MCP 桥还不存在（M1 Task 3/4 未做）⇒ 本条判据现在没有可检查对象");
    if (requireBridge) {
      console.error("  ⇒ 已给 `--require-bridge` ⇒ 按「桥不存在 / 无可检查对象」exit 2（**不算通过** ✗）");
      return 2;
    }
    console.error("  ⇒ 登记形态：绿 ＋ 自报跳过（判据先行阶段的正常状态 ✓；要看那次红就加 `--require-bridge`）");
    return 0;
  }
  const src = readFileSync(bridgePath, "utf8");
  const findings = judgeBridge(src);
  if (findings.length) { for (const x of findings) console.error(x); return 1; }
  console.log("✓ 桥是哑的：没碰库 ✓ ｜ 没判权限/解锁 ✓ ｜ 没写审计 ✓ ｜ 没读写权威形态 ✓（" + src.split(/\r?\n/).length + " 行 ✓）");
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const cases = [
    ["正例（只搬协议帧）", 'import process from "node:process";\nprocess.stdin.on("data", (b) => process.stdout.write(b));\n', 0],
    ["变异①（桥里查库）", 'const db = require("rusqlite");\n', 1],
    ["变异②（桥里判权限）", 'if (!has_permission(id)) return err("denied");\n', 1],
    ["变异③（桥里写审计）", 'push_audit(id, "pages.get", true);\n', 1],
    ["变异④（桥里摸权威形态）", 'const rows = db.query("SELECT content_json FROM pages");\n', 1],
  ];
  let pass = 0;
  for (const [name, src, want] of cases) {
    const f = judgeBridge(src);
    const got = f.length ? 1 : 0;
    const okc = got === want;
    if (okc) pass++;
    console.log(`  ${okc ? "✓" : "✗"} ${name} ⇒ exit=${got}（期望 ${want}）` + (f.length ? " ｜ " + f[0].slice(0, 80) : ""));
  }
  // 空扫：桥不在 ⇒ 登记形态 0；加 --require-bridge ⇒ 2 ✓
  const a = run(join(ROOT, "tools", "shuyonote-mcp", "__nope__.mjs"), false);
  const b = run(join(ROOT, "tools", "shuyonote-mcp", "__nope__.mjs"), true);
  const okA = a === 0, okB = b === 2;
  if (okA) pass++;
  if (okB) pass++;
  console.log(`  ${okA ? "✓" : "✗"} 空扫（登记形态）⇒ exit=${a}（期望 0）`);
  console.log(`  ${okB ? "✓" : "✗"} 空扫 ＋ \`--require-bridge\` ⇒ exit=${b}（期望 2，**不是 0** ✗）`);
  const total = cases.length + 2;
  console.log(`self-test: ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

const bi = argv.indexOf("--bridge");
const BRIDGE = bi >= 0 && argv[bi + 1] && !argv[bi + 1].startsWith("--")
  ? (isAbsolute(argv[bi + 1]) ? argv[bi + 1] : join(ROOT, argv[bi + 1]))
  : BRIDGE_DEFAULT;
process.exit(run(BRIDGE, argv.includes("--require-bridge")));
