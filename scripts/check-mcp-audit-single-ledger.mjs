#!/usr/bin/env node
// scripts/check-mcp-audit-single-ledger.mjs —— 「审计**只有一本账**，且能力调用成功/失败都留痕」
//
// 挡的是哪一类事故：外部 agent 的能力调用**没进同一本审计账** ✗ —— 用户问「谁读过我的库」时答案是"查不到"，
//   而**测试全绿、什么都不报** ✗（本仓最忌的形状）。
//
// ⚠️ 与 `INV-MCP-audited` 的关系（**只做它能判的那一半** ✓）：
//   完整那条是「外部会话的每次能力调用与插件调用进**同一**审计轨迹（"谁读过我的库"可查）」✓，
//   其中"**谁**"（主体标识字段）**未定**✗、且另有两问未定（**存哪**／**丢多少** ✗，2026-10-01 读出来的实况：
//   它是**内存环形缓冲**，不落盘、满了丢最老的、还能被 `clear_plugin_audit()` 清 ✓）⇒ 已登记台账 **R104** ✓。
//   本条只钉**已经能判**的那半 ✓。
//
// ⚠️⚠️ **两版血泪（2026-10-01，同一天）—— 写这条判据的人请先读**：
//   第一版：拿 `push_back(` 当"第二本账"的指纹 ✗ ⇒ **假红** ✓ —— 因为 `plugins.rs` 里**不止一个环**
//           （插件日志那条也是 ✓，实测 `push_back(` 共 3 处、其中审计 2 处 ✓）；
//   第二版：函数体用 `\n}\n` 收尾 ✗ ⇒ **在 CRLF 检出上永不命中** ✗（＝本工作区专门有门禁写明过的那族坑 ✓）。
//   ⇒ 现在的做法：**按值认**（`push_back(PluginAuditEntry` ✓）＋ 行尾用 `\r?\n` ✓ ＋
//      自测里**专门放一条 CRLF 正例**（把那个坑变成机器能抓的回归 ✓）＋ 绝不数"恰好几处" ✗（一环两入口是有意的 ✓）。
//
// 判据四条（纯读源码 ⇒ 本机可跑 ✓）：
//   ① **账本唯一**：`static PLUGIN_AUDIT` 只声明**一次** ✓
//   ② **审计推送都进这本账**：每处 `push_back(PluginAuditEntry` 的上文必须有 `PLUGIN_AUDIT.lock()` ✓
//      （进别的队列 ⇒ 第二本账 ✗）—— 一个环、**多个入口**是允许的 ✓（`push_audit` 能力调用／`push_run_audit` 运行结局 ✓）
//   ③ **成功与失败都留痕**：`dispatch_capability` 里既有 `push_audit(…, true, …)` 也有 `…, false, …` ✓
//   ④ 宿主面（`src-tauri/src/mcp_host.rs`）**若已存在** ⇒ 不许自建审计环 ✗（未建 ⇒ 明说"无对象"✓，不假绿 ✗）
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 读不到必要文件（**不算通过**）
// 用法：node scripts/check-mcp-audit-single-ledger.mjs ／ --root <夹具根> ／ --self-test
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
const REL = { plugins: "src-tauri/src/plugins.rs", host: "src-tauri/src/mcp_host.rs" };

/** 取一个顶层 fn 的函数体：到**它自己那个顶格的 `}`** 为止 ✓ 行尾容忍 CRLF ✓（见头注释的两版血泪 ✓） */
export function bodyOf(src, name) {
  const start = src.indexOf("fn " + name);
  if (start < 0) return null;
  const rest = src.slice(start);
  const m = rest.match(/\r?\n\}\r?\n/);
  return m ? rest.slice(0, m.index + m[0].length) : rest;
}

/** 纯判据：两份文本 ⇒ { findings, passed } */
export function judge({ plugins, host }) {
  const out = [];
  let passed = 0;
  const fail = (m) => out.push("✗ " + m);
  if (plugins === null) { fail("读不到 " + REL.plugins + " ⇒ 判据没检查到东西（不算通过 ✗）"); return { findings: out, passed }; }

  // ① 账本只声明一次
  const decls = (plugins.match(/static\s+PLUGIN_AUDIT\s*:/g) || []).length;
  if (decls !== 1) fail("`static PLUGIN_AUDIT` 声明了 " + decls + " 次（期望 1）⇒ 审计账本**不唯一** ✗");
  else passed++;

  // ② 每处审计推送（按**值**认 ✓）都进这本账
  const pushes = [];
  for (let i = plugins.indexOf("push_back(PluginAuditEntry"); i >= 0; i = plugins.indexOf("push_back(PluginAuditEntry", i + 1)) pushes.push(i);
  // ⚠️ 窗口 400 字（原 200）：R104=A 之后，锁与推送之间**合法地**多了一行"丢弃计数自增" ✓
  //   （规则本意是"这次推送在同一把锁的范围内" ✓，字数只是代理阈值 ⇒ 别让它误伤正常实现 ✗）
  const stray = pushes.filter((i) => !/PLUGIN_AUDIT\s*\.\s*lock\s*\(\)/.test(plugins.slice(Math.max(0, i - 400), i)));
  if (pushes.length === 0) fail("找不到任何 `push_back(PluginAuditEntry` ⇒ 判决失效（**不算通过** ✗ —— 若落点写法变了，得改本判据 ✓）");
  else if (stray.length) fail("有 " + stray.length + " 处审计推送**没进 `PLUGIN_AUDIT`** ✗ ⇒ 第二本账（" + REL.plugins + "）");
  else passed++;

  // ③ dispatch_capability 里成功/失败都留痕
  const body = bodyOf(plugins, "dispatch_capability");
  if (body === null) fail("`" + REL.plugins + "` 里找不到 `fn dispatch_capability` ⇒ 判据没对象（不算通过 ✗）");
  else {
    const hasTrue = /push_audit\([^)]*,\s*true\s*[,)]/.test(body);
    const hasFalse = /push_audit\([^)]*,\s*false\s*[,)]/.test(body);
    if (!/push_audit\s*\(/.test(body)) fail("`dispatch_capability` 里**一次都没调用** `push_audit` ⇒ 能力调用**不进审计** ✗");
    else if (!hasTrue) fail("`dispatch_capability` 里没有**成功路**留痕（`push_audit(…, true, …)`）✗");
    else if (!hasFalse) fail("`dispatch_capability` 里没有**失败路**留痕（`push_audit(…, false, …)`）✗ —— 被拒的调用恰恰最该留痕 ✓");
    else passed++;
  }

  // ④ 宿主面不许自建一本账
  if (host === null) { passed++; console.log("  ⚠️ 宿主面（" + REL.host + "）尚未创建 ⇒ 第④项**无对象**（明说不假绿 ✓）"); }
  else if (/static\s+PLUGIN_AUDIT\s*:|push_back\(PluginAuditEntry/.test(host)) fail("宿主面（" + REL.host + "）**自建审计环** ✗ ⇒ 必须共用同一本账（" + REL.plugins + " 的那一本）✓");
  else passed++;

  // ⑤ 「来源」字段（R104=A 的第一半：**答得出"谁"** ✓）—— 只认"审计推送**那句**里带 source" ✓（与本判据"按值认"同一套思路 ✓）
  const noSource = pushes.filter((i) => {
    const semi = plugins.indexOf(";", i);
    const stmt = plugins.slice(i, semi < 0 ? Math.min(plugins.length, i + 400) : semi + 1);
    return !/source/.test(stmt);
  });
  if (pushes.length && noSource.length) fail("有 " + noSource.length + " 处审计推送**没带「来源」** ✗ ⇒ 答不出「谁读过我的库」（R104=A：加 `source` ✓）");
  else passed++;

  // ⑥ 落盘（R104=A 的第二半：**重启不丢** ✓）—— 认"常量名 ＋ 追加写"两件都在 ✓
  const hasLogName = /PLUGIN_AUDIT_LOG/.test(plugins);
  const hasAppend = /OpenOptions/.test(plugins) && /append\(true\)/.test(plugins);
  if (!hasLogName || !hasAppend) fail("审计**没落盘** ✗：缺 " + (hasLogName ? "" : "`PLUGIN_AUDIT_LOG` 常量 ")
    + (hasAppend ? "" : "`OpenOptions` ＋ `append(true)` 追加写 ") + "⇒ 重启后「谁读过」就答不出（R104=A：落盘 ✓）");
  else passed++;

  // ⑦ 丢弃可见（R104=A 的第三半：满了丢最老的**那件事要能看出来** ✓）
  const droppedRefs = (plugins.match(/PLUGIN_AUDIT_DROPPED/g) || []).length;
  const hasFetchAdd = /PLUGIN_AUDIT_DROPPED[\s\S]{0,200}?fetch_add/.test(plugins);
  const hasReader = /pub fn plugin_audit_dropped\s*\(/.test(plugins);
  if (droppedRefs < 2 || !hasFetchAdd || !hasReader) fail("丢弃**不可见** ✗：`PLUGIN_AUDIT_DROPPED` 出现 " + droppedRefs
    + " 次（期望 ≥2：声明／自增）、自增=" + hasFetchAdd + "、公开读函数=" + hasReader + " ⇒ 记录被悄悄丢掉而外面看不出（R104=A ✓）");
  else passed++;

  return { findings: out, passed };
}

function run(root) {
  const read = (rel) => { const p = join(root, rel); return existsSync(p) ? readFileSync(p, "utf8") : null; };
  const { findings, passed } = judge({ plugins: read(REL.plugins), host: read(REL.host) });
  if (findings.length) {
    for (const x of findings) console.error(x);
    console.error("[结果] " + passed + " 通过 / " + findings.length + " 失败");
    return 1;
  }
  console.log("✓ 审计只有一本账：`PLUGIN_AUDIT` 唯一 ✓ ｜ 每处审计推送都进它 ✓ ｜ `dispatch_capability` 成功/失败都留痕 ✓ ｜ 宿主面不自建环 ✓ ｜ 带「来源」✓ ｜ 落盘 ✓ ｜ 丢弃可见 ✓");
  console.log("[结果] " + passed + " 通过 / 0 失败");
  return 0;
}

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };

if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-audit-"));
  try {
    const write = (rel, text) => { const p = join(dir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text, "utf8"); };
    const OK = [
      "static PLUGIN_AUDIT: Mutex<VecDeque<PluginAuditEntry>> = Mutex::new(VecDeque::new());",
      "static PLUGIN_AUDIT_DROPPED: AtomicU64 = AtomicU64::new(0);",
      'const PLUGIN_AUDIT_LOG: &str = "plugin-audit.jsonl";',
      "",
      "fn persist(line: &str) {",
      "    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(PLUGIN_AUDIT_LOG) {",
      '        let _ = writeln!(f, "{}", line);',
      "    }",
      "}",
      "",
      "fn push_audit(plugin_id: &str, source: &str, ok: bool) {",
      "    let mut q = PLUGIN_AUDIT.lock().unwrap_or_else(|e| e.into_inner());",
      "    if q.len() >= PLUGIN_AUDIT_CAPACITY { q.pop_front(); PLUGIN_AUDIT_DROPPED.fetch_add(1, Ordering::Relaxed); }",
      "    q.push_back(PluginAuditEntry { plugin_id: plugin_id.to_string(), source: source.to_string(), ok });",
      "    persist(plugin_id);",
      "}",
      "",
      "fn push_run_audit(plugin_id: &str, source: &str, ok: bool) {",
      "    let mut q = PLUGIN_AUDIT.lock().unwrap_or_else(|e| e.into_inner());",
      "    q.push_back(PluginAuditEntry { plugin_id: plugin_id.to_string(), source: source.to_string(), ok });",
      "}",
      "",
      "pub fn plugin_audit_dropped() -> u64 { PLUGIN_AUDIT_DROPPED.load(Ordering::Relaxed) }",
      "",
      "pub fn dispatch_capability(plugin_id: &str, method: &str) -> Result<(), String> {",
      '    push_audit(plugin_id, "plugin", false);',
      '    push_audit(plugin_id, "plugin", true);',
      "    Ok(())",
      "}",
      "",
    ].join("\n");
    const put = (plugins, host) => { write(REL.plugins, plugins); const p = join(dir, REL.host); if (host === null) { if (existsSync(p)) rmSync(p); } else write(REL.host, host); };
    const strayPush = 'fn sneaky(plugin_id: &str, source: &str, ok: bool) {\n    let mut other = OTHER.lock().unwrap();\n    other.push_back(PluginAuditEntry { plugin_id: plugin_id.to_string(), source: source.to_string(), ok });\n}\n';
    const cases = [
      ["正例（LF）", () => put(OK, null), 0],
      ["正例（**CRLF** —— 上轮那个坑的回归 ✓）", () => put(OK.split("\n").join("\r\n"), null), 0],
      ["变异①（成功路不留痕）", () => put(OK.replace('    push_audit(plugin_id, "plugin", true);\n', ""), null), 1],
      ["变异②（失败路不留痕）", () => put(OK.replace('    push_audit(plugin_id, "plugin", false);\n', ""), null), 1],
      ["变异③（审计推送进**别的**队列 ⇒ 第二本账）", () => put(OK + strayPush, null), 1],
      ["变异④（宿主面自建环）", () => put(OK, "static PLUGIN_AUDIT: Mutex<VecDeque<PluginAuditEntry>> = Mutex::new(VecDeque::new());\n"), 1],
      ["变异⑤（推送不带来源 ⇒ 答不出「谁」）", () => put(OK.replace("source: source.to_string(), ", ""), null), 1],
      ["变异⑥（不落盘：去掉追加写）", () => put(OK.replace(/.*OpenOptions.*\n/, ""), null), 1],
      ["变异⑦（丢弃不可见：去掉自增）", () => put(OK.replace("PLUGIN_AUDIT_DROPPED.fetch_add(1, Ordering::Relaxed); ", ""), null), 1],
    ];
    let pass = 0;
    for (const [name, setup, want] of cases) {
      setup();
      const got = run(dir);
      const okc = got === want;
      if (okc) pass++;
      console.log(`  ${okc ? "✓" : "✗"} ${name} ⇒ exit=${got}（期望 ${want}）`);
    }
    rmSync(join(dir, REL.plugins));
    const empty = run(dir);
    const okEmpty = empty === 1;
    if (okEmpty) pass++;
    console.log(`  ${okEmpty ? "✓" : "✗"} 空扫（读不到 plugins.rs）⇒ exit=${empty}（期望 1 ＝ 有发现，**不是 0** ✗）`);
    const total = cases.length + 1;
    console.log(`self-test: ${pass}/${total} 通过`);
    process.exit(pass === total ? 0 : 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

process.exit(run(argOf("--root", ROOT)));
