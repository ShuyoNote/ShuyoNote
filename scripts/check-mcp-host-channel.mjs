#!/usr/bin/env node
// check-mcp-host-channel.mjs —— **宿主面那半**通道的判据（规格 §2 的 `INV-MCP-channel-guarded` ✓）
//
// 为什么要有**这一条**（与 `tools/shuyonote-mcp/judge-channel.mjs` 不重叠 ✓）：
//   那条管**桥**（`tools/shuyonote-mcp/index.mjs`）那一半 —— 它真的 spawn 桥、真发 HTTP ✓；
//   而 2026-10-01 owner 裁定通道方向＝**② 桥 → App（App 当服务端）** ✓（见
//   `_workspace/notes/2026-10-01-task5-host-face-plan-windows.md` §8 ✓）⇒ **监听这一侧搬到了 App** ✓
//   ⇒ 安全三件套（默认关 ＋ per-session token ＋ `Origin`/`Host` 恰好回环）必须在 **App 这侧**也成立 ✓，
//   否则"外面那台机器校验过了"就成了唯一的一道门 ✗（而门在**被调用方**这里才作数 ✓）。
//
// 七条断言（每条都配一个变异 ⇒ 都见过它红 ✓）：
//   ① **默认关**：`MCP_CHANNEL_ENABLED` 必须声明且**初值是 `false`** ✓（"默认开着只是别人不知道" ✗）
//   ② **只绑回环**：代码里必须有 `127.0.0.1` ✓，**不许**出现 `0.0.0.0` / `Ipv4Addr::UNSPECIFIED` ✗
//   ③ **token 从文件读**：必须出现**令牌文件名**（`SHUYONOTE_MCP_TOKEN_FILE` ✓）—— 只读路径、不读 env 里的值 ✓
//      （与桥那侧同一条契约 ✓：施工单 Step 3 要求 token 落在只有当前用户可读的文件里 ✓）
//   ④ **`Origin`／`Host` 恰好回环**：两个头都要核 ✓，且**不许**用前缀匹配 ✗
//      ⚠️ 本仓**真栽过**：`docs/SECURITY.md` 低危项逐字「CORS 前缀匹配放过 `http://127.0.0.1.evil.com`」✗
//      ⇒ 所以把 `starts_with("http://127.0.0.1")` 这种形状直接判红 ✓（前缀陷阱值必须被拒 ✓）
//   ⑤ **唯一入口**：必须**调用** `handle_external_call` ✓，且**不许**直接调 `dispatch_capability` ✗
//      （后者会绕过"外部会话"这个来源标记 ⇒ 审计里看不出是谁读的 ✓）
//
// ⚠️ 命中一律落在**代码**里（`rustRegions` 掩掉注释/字符串/字符字面量 ✓）：讲这条规矩的注释不该被判红 ✗，
//   而把"调用"写进字符串也不该算数 ✗（两个方向都踩过 ✓，见 `check-mcp-host-authz.mjs` 的同类注释 ✓）。
//
// 退出码（与兄弟判据同形 ✓）：0 干净（含登记形态的自报跳过）／1 有发现／2 环境不具备（读不到源码 ⇒ 不算通过）
// 用法：
//   node scripts/check-mcp-host-channel.mjs
//   node scripts/check-mcp-host-channel.mjs --channel <路径…>
//   node scripts/check-mcp-host-channel.mjs --require-channel   # 通道文件不在 ⇒ exit 2（判据先行阶段看红用）
//   node scripts/check-mcp-host-channel.mjs --self-test          # 夹具：正例／八个变异／两条掩码方向／缺席＋require
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { rustRegions } from "./lib/rust-scan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
/** 通道落在**这一个**文件里（判据先行阶段它还不存在 ⇒ 登记形态的自报跳过 ✓）。
 *  ⚠️ **刻意不含 `mcp_host.rs`**：那个文件由 `check-mcp-host-authz.mjs` 判（唯一鉴权点那半 ✓），
 *  把它也算进来会造出两条判据互相重叠 ✗，而且会让本判据**在实现之前就红** ✗
 *  （判据先行要求的是"没有对象 ⇒ 自报跳过"✓，不是"先判红再说" ✗）。 */
export const CHANNEL_CANDIDATES = [join(ROOT, "src-tauri", "src", "mcp_channel.rs")];
const TOKEN_FILE_NAME = "SHUYONOTE_MCP_TOKEN_FILE";
const SWITCH_NAME = "MCP_CHANNEL_ENABLED";
const ENTRY = "handle_external_call";
const AUTHZ_POINT = "dispatch_capability";
const WRITE_SCOPE = "write:pages";

/** 只留**代码**：注释 / 字符串 / 字符字面量换成空白（换行保留 ⇒ 行号对得上 ✓）。
 *  用途：判**"有没有真的调用"**（把调用藏进字符串不算调用 ✓）。 */
export function codeOnly(text) {
  const M = rustRegions(text);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    out += M[i] === 0 ? text[i] : text[i] === "\n" ? "\n" : " ";
  }
  return out;
}

/** 只掩**注释**（字符串与字符字面量**保留** ✓）。
 *  ⚠️ 这一档是必需的（2026-10-01 第一版就栽了 ✗）：本判据要核的东西**本来就写在字符串里** ——
 *  绑定地址 `"127.0.0.1"` ✓、令牌文件名 `"SHUYONOTE_MCP_TOKEN_FILE"` ✓、`Origin`/`Host` 的字面比较 ✓ ——
 *  用 `codeOnly` 会把它们**一起掩掉** ⇒ 连**正例都红** ✗（实测：正例报 3 条 ✗）。
 *  ⇒ 口径：**证据在字符串里 ⇒ 只掩注释**；**证据在调用形态里 ⇒ 掩字符串**（两档各有其用 ✓）。 */
export function noComments(text) {
  const M = rustRegions(text);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const isComment = M[i] === 1 || M[i] === 2;
    out += isComment ? (text[i] === "\n" ? "\n" : " ") : text[i];
  }
  return out;
}

/** 判据：通道文件文本列表 ⇒ findings（空＝干净 ✓）。空列表 ⇒ 没有任何通道文件 ✓。 */
export function judge(texts) {
  const out = [];
  if (!texts || texts.length === 0) return { findings: out, absent: true };
  const code = texts.map(codeOnly).join("\n"); // 调用形态（⑤）
  const lit = texts.map(noComments).join("\n"); // 字符串里的证据（①②③④）

  // ① 默认关：声明在 + 初值 false ✓
  const m = new RegExp("(?:pub\\s+)?const\\s+" + SWITCH_NAME + "\\s*:\\s*bool\\s*=\\s*(true|false)").exec(code);
  if (!m) {
    out.push("✗ 没有声明 `" + SWITCH_NAME + ": bool = false` ✗ ⇒ 通道**默认关**这件事在代码里不存在；"
      + "「默认开着、只是别人不知道」不算默认关 ✗");
  } else if (m[1] !== "false") {
    out.push("✗ `" + SWITCH_NAME + "` 的初值是 `true` ✗ ⇒ **默认开着**（`INV-MCP-channel-guarded` 要求默认关 ✓）");
  }

  // ② 只绑回环（地址在字符串里 ⇒ 用 lit ✓）
  if (!lit.includes("127.0.0.1")) {
    out.push("✗ 没有 `127.0.0.1` ✗ ⇒ 绑到哪里看不出来（只绑回环是本条的全部意义 ✓）");
  }
  for (const bad of ["0.0.0.0", "Ipv4Addr::UNSPECIFIED"]) {
    if (lit.includes(bad)) {
      out.push("✗ 出现 `" + bad + "` ✗ ⇒ 监听面**不止回环**（同网段任何设备都能连 ✓ —— 本仓安全红线之一 ✓）");
    }
  }

  // ③ token 从文件读（只给路径，不给值 ✓）
  if (!lit.includes(TOKEN_FILE_NAME)) {
    out.push("✗ 没有令牌文件名 `" + TOKEN_FILE_NAME + "` ✗ ⇒ per-session token **没有从文件读**这条契约"
      + "（只认环境变量里的值 ✗ ⇒ 与桥那侧同一条要求对不上 ✓）");
  }

  // ④ Origin / Host 恰好回环，且不许前缀匹配（都是字面比较 ⇒ lit ✓）
  const hasOrigin = /origin/i.test(lit);
  const hasHost = /host/i.test(lit);
  if (!hasOrigin || !hasHost) {
    out.push("✗ `Origin`／`Host` 校验缺项 ✗（origin=" + hasOrigin + " host=" + hasHost + "）"
      + "⇒ 防不住 DNS rebinding 那一类（`Host: 127.0.0.1.evil.com` 也会被放进来 ✓）");
  }
  const prefixMatch = /starts_with\s*\(\s*"(?:http:\/\/)?(?:127\.0\.0\.1|localhost)/.exec(lit);
  if (prefixMatch) {
    out.push("✗ 用了**前缀匹配**判回环（`" + prefixMatch[0].trim() + "` ✗）⇒ `http://127.0.0.1.evil.com` 会被放过 ✓"
      + "—— 本仓真栽过这一条（`docs/SECURITY.md` 低危项逐字 ✓）⇒ 必须**恰好相等** ✓");
  }

  // ⑤ 唯一入口（调用形态 ⇒ code ✓）
  if (!new RegExp(ENTRY + "\\s*\\(").test(code)) {
    out.push("✗ 通道**没有调用** `" + ENTRY + "(` ✗ ⇒ 它要么自己就是另一条路（绕过来源标记 ✓），要么根本没接线 ✗");
  }
  if (new RegExp(AUTHZ_POINT + "\\s*\\(").test(code)) {
    out.push("✗ 通道**直接调**了 `" + AUTHZ_POINT + "(` ✗ ⇒ 绕过「外部会话」这个来源 ⇒ 审计里看不出是谁读的 ✓"
      + "（唯一入口是 `" + ENTRY + "` ✓，它内部才转给鉴权点 ✓）");
  }
  // ⑥ ⭐ 2026-10-08（R147）：**授权写那一档必须存在，并且要落盘** ✓
  //    来由（逐字现场）：owner 打开「免确认写」后外部 AI 仍被
  //      `permission_denied: 能力 pages.create 需要权限 write:pages，但 manifest.permissions 未声明它` 拒掉 ✗ ——
  //    因为两条写能力都要 `write:pages` ✓，而**全仓没有任何地方把它加进 granted** ✗ ⇒ 那是个**空开关** ✓。
  //    ⚠️ 只换令牌文件不够 ✗：`set_enabled(true)` 铸令牌读的是 `cfg.granted` ✓ ⇒ 必须**落盘配置** ✓。
  // ⚠️ 授权那两条**必须限定在 `set_write_grant` 的函数体内** ✗ ——
  //   2026-10-08 实测：只判「全仓有没有 `write_new_token(`」会被 `set_enabled`／`rotate_token` 那两处**顶替** ✓
  //   ⇒ 我把 `set_write_grant` 里那句换成空操作，门禁**照样绿** ✗（假绿 ✓，正是本条要防的形状 ✓）。
  const grantBody = (() => {
    const i = code.indexOf("fn set_write_grant(");
    if (i < 0) return null;
    const rest = code.slice(i);
    const j = rest.indexOf("\npub fn ");
    return j < 0 ? rest : rest.slice(0, j);
  })();
  if (!lit.includes(WRITE_SCOPE)) {
    out.push("✗ 通道里没有 `" + WRITE_SCOPE + "` ✗ ⇒ **授权写那一档不存在** ⇒ 两条写能力（`pages.create`／`blocks.append`）"
      + "永远被 `permission_denied` 拒 ✓（＝面板那个「免确认写」开关是**空开关** ✗ —— R147 的现场 ✓）");
  } else if (grantBody === null) {
    out.push("✗ 有 `" + WRITE_SCOPE + "` 但没有 `set_write_grant(` ✗ ⇒ 授权那一档**没有唯一的落点** ✓"
      + "（散在别处就说不清「谁把写权限授出去」✗）");
  } else if (!/write_new_token\s*\(/.test(grantBody)) {
    out.push("✗ 有 `" + WRITE_SCOPE + "` 但**没换令牌**（`write_new_token(` ✗）⇒ 面板读的授权清单来自**令牌文件** ⇒ "
      + "开关会「看起来点不开」✗（2026-10-08 现场：`config.json` 有了 `write:pages` ✓ 而 token 没被换 ✗）");
  } else if (!/write_file_config\s*\(/.test(grantBody)) {
    out.push("✗ 有 `" + WRITE_SCOPE + "` 但**没有落盘配置**（`write_file_config(` ✗）⇒ 只改了令牌文件的话，"
      + "**禁用再启用会被 `cfg.granted` 覆盖回只读** ✗（这正是「空开关」的根 ✓）");
  }
  return { findings: out, absent: false };
}

function readIfExists(p) {
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

export function run(paths, requireChannel) {
  const list = paths.length ? paths : CHANNEL_CANDIDATES;
  const texts = [];
  for (const p of list) {
    const t = readIfExists(p);
    if (t !== null) texts.push(t);
  }
  if (texts.length === 0) {
    if (requireChannel) {
      console.error("✗ 通道文件不存在（找过：" + list.join(" ／ ") + "）⇒ **无可检查对象**（不算通过 ✗）");
      return 2;
    }
    console.log("! 自报跳过（不装绿）：MCP 宿主面通道还没写 ⇒ 本条现在没有可检查对象");
    return 0;
  }
  const { findings } = judge(texts);
  if (findings.length) {
    for (const f of findings) console.error(f);
    return 1;
  }
  console.log("✓ MCP 宿主面通道：默认关 ✓ ｜ 只绑回环 ✓ ｜ token 从文件读 ✓ ｜ Origin/Host 恰好回环 ✓ ｜ 唯一入口 ✓ ｜ 授权写那一档在且落盘 ✓");
  return 0;
}

const argv = process.argv.slice(2);
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check-mcp-host-channel.mjs");

if (isMain && argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-channel-"));
  const OK = [
    `pub const ${SWITCH_NAME}: bool = false;`,
    `const TOKEN_ENV: &str = "${TOKEN_FILE_NAME}";`,
    `/// 只绑回环：127.0.0.1 ✓（注释里讲的规矩不该被判红 ✓）`,
    `let addr = "127.0.0.1:0";`,
    // ⚠️ 这里刻意用**裸的 `origin` / `host`**（真实实现多半写成 `origin_ok` 之类 ⇒
    //    判据用**子串**而不是 `\b` 词边界 ✓ —— 否则 `origin_ok` 会被判成"没有 origin" ✗，第一版就这么假红过 ✓）
    `fn headers_ok(origin: Option<&str>, host: Option<&str>) -> bool { origin.is_none() || (origin == Some("http://127.0.0.1") && host == Some("127.0.0.1")) }`,
    `fn serve() { let _ = crate::mcp_host::handle_external_call(1, &[], "pages.list", "{}"); }`,
    // ⭐ R147：授权写那一档（判据⑥）—— 常量 ＋ 落盘 ✓
    `pub(crate) const WRITE_SCOPE: &str = "write:pages";`,
    `pub fn set_write_grant(on: bool) -> Result<(), String> { write_file_config(&cfg) && write_new_token(&cfg.granted).is_ok() }`,
  ].join("\n");
  const put = (name, text) => {
    const p = join(dir, name);
    writeFileSync(p, text, "utf8");
    return p;
  };
  const cases = [
    ["正例（五条都在）⇒ 绿", () => [put("mcp_channel.rs", OK)], 0],
    ["变异① 默认开（初值 true）⇒ 红", () => [put("mcp_channel.rs", OK.replace("bool = false", "bool = true"))], 1],
    ["变异② 绑 0.0.0.0 ⇒ 红", () => [put("mcp_channel.rs", OK + '\nlet bad = "0.0.0.0:0";')], 1],
    ["变异③ 不给令牌文件名 ⇒ 红", () => [put("mcp_channel.rs", OK.replace(TOKEN_FILE_NAME, "TOKEN_ENV_X"))], 1],
    ["变异④ 前缀匹配判回环 ⇒ 红", () => [put("mcp_channel.rs", OK + '\nfn bad(o: &str) -> bool { o.starts_with("http://127.0.0.1") }')], 1],
    ["变异⑤ 直接调鉴权点（绕过唯一入口）⇒ 红", () => [put("mcp_channel.rs", OK + '\nfn bad() { let _ = crate::plugins::dispatch_capability("pages.list", "{}"); }')], 1],
    ["变异⑥ 不调唯一入口 ⇒ 红", () => [put("mcp_channel.rs", OK.replace(ENTRY, "some_other_entry"))], 1],
    ["变异⑦ 授权写那一档没了（write:pages 被改名）⇒ 红", () => [put("mcp_channel.rs", OK.replace("write:pages", "write-renamed"))], 1],
    ["变异⑧ 授权面存在但不换令牌（write_new_token 拿掉）⇒ 红", () => [put("mcp_channel.rs", OK.replace("write_new_token(&cfg.granted)", "/*拿掉*/"))], 1],
    ["掩码方向① 注释里讲规矩（含 0.0.0.0 与前缀写法）⇒ 必须绿", () => [put("mcp_channel.rs", OK + '\n// 注意：不许出现 0.0.0.0，也不许 o.starts_with("http://127.0.0.1")')], 0],
    ["掩码方向② 把调用藏进字符串 ⇒ 必须红", () => [put("mcp_channel.rs", OK.replace(`${ENTRY}(1`, `"${ENTRY}("; let _ = (1`))], 1],
    ["缺席（判据先行阶段）⇒ 绿＋自报跳过", () => [join(dir, "nope.rs")], 0],
  ];
  let pass = 0;
  for (const [name, setup, want] of cases) {
    const got = run(setup(), false);
    const okc = got === want;
    if (okc) pass++;
    console.log(`  ${okc ? "✓" : "✗"} ${name} ⇒ exit=${got}（期望 ${want}）`);
  }
  const miss = run([join(dir, "nope.rs")], true);
  const okMiss = miss === 2;
  if (okMiss) pass++;
  console.log(`  ${okMiss ? "✓" : "✗"} 缺席 ＋ --require-channel ⇒ exit=${miss}（期望 2，**不是 0** ✗）`);
  rmSync(dir, { recursive: true, force: true });
  const total = cases.length + 1;
  console.log(`self-test: ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

if (isMain) {
  const ci = argv.indexOf("--channel");
  const paths = ci >= 0 ? argv.slice(ci + 1).filter((a) => !a.startsWith("--")).map((p) => (isAbsolute(p) ? p : join(ROOT, p))) : [];
  process.exit(run(paths, argv.includes("--require-channel")));
}
