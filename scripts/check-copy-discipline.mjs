// 文案纪律门禁（三条不变式，见 `docs/specs/2026-09-28-user-facing-copy-spec.md`）
//
// 为什么是**独立脚本**而不是塞进 `verify-mobile-views.mjs`：
//   那三条要**跑真 Chromium**（量渲染结果）；这三条是**静态扫描**（扫源码）。
//   两者前置条件不同（一个要 dev server，一个不要）⇒ 混在一起会让"要不要起服务器"变成
//   一半的判据说不清。仓内先例：静态扫描类（`check-hook-order` / `check-store-subscriptions`）
//   都是独立脚本 ＋ `--self-test`。
//
// ---------------------------------------------------------------------------
// 三条判据
// ---------------------------------------------------------------------------
// C1 `INV-UI-copy-no-internal-ids`：**用户可见的文案里不得插值内部标识的裸值**
//   口径（规格 §3.1）：字符串**含中文** ⇒ 近似为"给人看的"；再要求插值的是**不透明身份标识**
//   （`space_id` / `orig_id` / `page_id` / `entity_id` / `target` / `seq` / `id` …）。
//   豁免（规格 §3.1 逐条）：URL 拼装 / 文件名 / meta key / SQL / 日志（`push_log`/`log::`/`println`）
//   注释与测试文件（`*_sim.rs` / `/tests/` / `#[cfg(test)]` 块里的断言）。
//   ⚠️ **这是"候选过滤器"，不是结论**：它只能说明"这句话含中文且插了个身份标识"，
//      不能说明"它一定到界面"。⇒ 用【已知红基线】落进 CI，逐条人工交代（同 `check-plan-status`）。
//   **判据的判据**：能红的只有"候选数变多"；候选数不变**不等于**已交代过。
//
// C2 `INV-UI-copy-inline-markdown`：**后端给的 `**强调**` 必须经 `inlineMd` 才到 DOM**
//   两条路选 (A)：让契约生效（规格 §3.2）。可机检的代理指标两条：
//     ① Rust 侧含 `**` 的字符串数 **只减不增**（新增一个 ⇒ 必须交代它怎么渲染）
//     ② `inlineMd(` 调用点数 **只增不减**（覆盖率的分子不许掉）
//   ⚠️ 代理指标**不等于**覆盖率：它挡的是"又加了一个含星号的后端串而没人管"，
//      不是"某个具体串渲染错了"。后者要跑真浏览器（属 `verify-mobile-*` 的面）。
//
// C3 `INV-UI-copy-inline-separators`：**相邻的 `display:inline` 文案元素之间必须有分隔**
//   ⚠️ **这一条【故意不在本脚本里判】** —— 原因是实测出来的，不是省事：
//      "两个元素挨着"这个形状在 JSX 里**到处都是**（`<span>名字</span><span class="数">3</span>`），
//      而它们**大多靠 CSS `gap`/`margin` 分隔开了** ⇒ 只看 JSX **判不出** `display:inline`，也判不出间距。
//      实测：按这个形状扫 `src/components/*.tsx` 得 **32 处，逐条看全是误报**（0 真阳）。
//      ⇒ 一个 32/32 误报的判据就是"噪声门禁"（本仓 AI-NATIVE-DEV §12.2 那一族）。
//      真正的判定要**跑真浏览器量两个 inline 盒子的间距**（`getBoundingClientRect` 相邻且间距 ≤0）
//      ⇒ 它落在 `verify-mobile-views.mjs` 的面里（那里已经开了真 Chromium）。
//      本条在本脚本里只留一个**候选计数**（`::jsx-adjacent-expr`）作参考，**不参与判红**。
//
// ---------------------------------------------------------------------------
// 用法
// ---------------------------------------------------------------------------
//   node scripts/check-copy-discipline.mjs                 # 判据（有新增即 exit 1）
//   node scripts/check-copy-discipline.mjs --self-test     # 夹具自检（每条一正一负）
//   node scripts/check-copy-discipline.mjs --update-baseline
//
// 退出码：0 干净 / 1 有发现 / 2 环境不具备（同本仓惯例）

import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isMain = (u) => process.argv[1] && resolve(process.argv[1]) === fileURLToPath(u);

const CJK = /[\u4e00-\u9fff]/;
const STR_LIT = /"((?:[^"\\]|\\.)*)"/g;
const INTERP = /\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\}/g;
/** 不透明身份标识：用户拿它**做不了动作**（规格 §4 那 10 条的共同点）。 */
const OPAQUE = /^(space_id|orig_id|entity_id|page_id|device_id|peer|target|seq|id|run_id|attr_id)$/;
/** 明显不是身份标识的值（报错/消息/名字/数量）。 */
const NOT_ID = new Set(["e", "err", "msg", "s", "v", "value", "name", "title", "url", "path", "n", "i", "key"]);

/**
 * 把 `#[cfg(test)]` 修饰的模块/函数**整块挖空**（按花括号配平）。
 *
 * ⚠️ 2026-09-28 修正：原来这里用的是一个 `inTest` 布尔量，**置位后永不复位** ——
 *    于是文件里**第一个 `#[cfg(test)]` 之后的所有代码都被跳过**。
 *    症状是【漏扫】（"空扫给绿"的变体）：`db.rs` / `space_crypto.rs` / `security.rs`
 *    的候选明明在规格 §4 里，却一个都没进基线。
 *    是**变异测试**发现的：往 `db.rs` 末尾追加一条明显该命中的中文 `{space_id}` 文案，
 *    判据**照样绿** ⇒ 才回头查出这个。
 * @param {string} text
 */
export function blankTestBlocks(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#\[cfg\(test\)\]/.test(line)) {
      out.push("");
      // 从这里往后找第一个 `{`，再配平到它的闭合
      let depth = 0;
      let started = false;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        for (const ch of l) {
          if (ch === "{") { depth++; started = true; }
          else if (ch === "}") depth--;
        }
        out.push("");
        if (started && depth <= 0) break;
      }
      i = j;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- C1 检测器
/**
 * 扫一段 Rust 源码，返回"含中文且插了不透明身份标识"的候选。
 * @param {string} text
 * @returns {{line:number, ident:string, text:string}[]}
 */
export function scanRustCopy(text) {
  const out = [];
  const lines = blankTestBlocks(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const st = line.trim();
    if (!st) continue;                                                 // 挖空掉的行
    if (st.startsWith("//") || st.startsWith("#[")) continue;          // 注释 / 属性
    if (/push_log|log::|println!|eprintln!|assert!|assert_eq!|debug_assert/.test(line)) continue; // 日志/断言
    for (const m of line.matchAll(STR_LIT)) {
      const lit = m[1];
      if (!CJK.test(lit)) continue;                                    // 不含中文 ⇒ 不是给人看的
      for (const im of lit.matchAll(INTERP)) {
        const full = im[1];
        const base = full.split(".").pop();
        if (NOT_ID.has(base)) continue;
        if (!OPAQUE.test(base)) continue;
        out.push({ line: i + 1, ident: full, text: lit.slice(0, 60) });
      }
    }
  }
  return out;
}

/** 这个 .rs 文件该不该扫（规格 §3.1 的豁免）。 */
export function skipRustFile(rel) {
  return /_sim\.rs$/.test(rel) || /(^|\/)tests\//.test(rel) || /_test\.rs$/.test(rel);
}

// ---------------------------------------------------------------- C2 检测器
/** Rust 侧含 `**` 的字符串字面量数（"行内 Markdown 写法的源头"）。 */
export function countRustStars(text) {
  let n = 0;
  for (const line of text.split("\n")) {
    const st = line.trim();
    if (st.startsWith("//")) continue;
    for (const m of line.matchAll(STR_LIT)) if (m[1].includes("**")) n++;
  }
  return n;
}

/** `inlineMd(` 调用点数（覆盖率的分子）。 */
export function countInlineMd(text) {
  return [...text.matchAll(/\binlineMd\s*\(/g)].length;
}

// ---------------------------------------------------------------- C3 检测器
/**
 * 扫一段 TSX，返回"两个兄弟元素挨着、各自只渲染一个表达式容器"的位置。
 *
 * ⚠️ **这是粗筛，不是结论**：`display:inline` 静态判不出来（要 CSS 归属与布局），
 *    所以这里只收"上一行以闭合标签收尾、本行以带 className 的开标签起头、
 *    两边各自渲染一个 `{expr}`"这一形态 —— 它正是规格 §0 第 3 条的现场
 *    （两个 `.sync-hint` 首尾相黏）。**真正的判定要跑真浏览器量两个 inline 盒子的间距**，
 *    那属 `verify-mobile-*` 的面；本函数挡的是"又写出这种形态"。
 * @param {string} text
 */
export function scanAdjacentExprRef(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1].trim();
    const cur = lines[i].trim();
    if (prev.startsWith("//") || prev.startsWith("*") || prev.startsWith("{/*")) continue;
    if (cur.startsWith("//") || cur.startsWith("*") || cur.startsWith("{/*")) continue;
    // 上一行：以闭合标签收尾，且里面渲染了一个表达式容器
    if (!/<\/[A-Za-z][\w.]*>\s*$/.test(prev)) continue;
    if (!/\{[^}]+\}\s*<\/[A-Za-z]/.test(prev)) continue;
    // 本行：以开标签起头、带 className、其后紧跟一个表达式容器（中间没有文本/分隔符）
    if (!/^<[A-Za-z][\w.]*[\s>]/.test(cur)) continue;
    if (!/className=/.test(cur)) continue;
    if (!/>\s*\{[^}]+\}/.test(cur)) continue;
    out.push({ line: i + 1, text: (prev.slice(-30) + "  ⏎  " + cur.slice(0, 30)).trim() });
  }
  return out;
}

// ---------------------------------------------------------------- 基线比较
/** 与 `check-store-subscriptions` 同一套纪律：按文件计数。
 *
 * 但**方向不止一个**（2026-09-28 由变异测试发现）：
 *   · 默认（C1 候选 / C2 的 `rust-star-strings`）：**只减不增** ⇒ 变多【红】、变少【可收紧】
 *   · `MUST_NOT_DECREASE`（C2 的 `inlineMd-sites`）：**只增不减** ⇒ 变少【红】、变多【可收紧】
 *   原来只有“只减不增”一向，于是【删掉一处 `inlineMd(` 调用】判据**照样绿** ——
 *   而规格 §3.2 要的正是“覆盖率不许掉”。变异测试（去掉一个 `inlineMd(`）把它抓出来了。
 */
export const MUST_NOT_DECREASE = new Set(["::inlineMd-sites"]);

export function compareCounts(counts, baseline) {
  const raised = [];
  const lowerable = [];
  const keys = new Set([...Object.keys(counts), ...Object.keys(baseline)]);
  for (const key of keys) {
    const now = counts[key] ?? 0;
    const was = baseline[key] ?? 0;
    if (now === was) continue;
    const wrongWay = MUST_NOT_DECREASE.has(key) ? now < was : now > was;
    if (wrongWay) raised.push({ file: key, was, now });
    else lowerable.push({ file: key, was, now });
  }
  return { raised, lowerable };
}

// ---------------------------------------------------------------- 自检
function selfTest() {
  const cases = [
    // ---- C1 一正一负
    {
      name: "C1 正例：中文字符串里插了 space_id ⇒ 命中",
      got: scanRustCopy('Err(format!("空间「{space_id}」不存在"))').length,
      want: 1,
    },
    {
      name: "C1 负例：URL 拼装（不含中文）⇒ 不命中",
      got: scanRustCopy('format!("{}/push", base)').length,
      want: 0,
    },
    {
      name: "C1 负例：文件名/临时名（含中文但插的不是身份标识）⇒ 不命中",
      got: scanRustCopy('let p = format!("{space_id}.db");').length,
      want: 0,
    },
    {
      name: "C1 负例：日志行 ⇒ 不命中",
      got: scanRustCopy('push_log("host", "info", format!("空间 {space_id} 的库"));').length,
      want: 0,
    },
    {
      name: "C1 负例：只插报错变量 {e} ⇒ 不命中",
      got: scanRustCopy('Err(format!("读取附件失败：{e}"))').length,
      want: 0,
    },
    {
      name: "C1 正例：测试块【之后】的代码仍会被扫（原来这里漏扫）",
      got: scanRustCopy(
        '#[cfg(test)]\nmod tests {\n  #[test]\n  fn t() { assert!(format!("测试里的 {space_id} 不算")); }\n}\nfn real() -> String { format!("空间「{space_id}」不存在") }\n',
      ).length,
      want: 1,
    },
    {
      name: "C1 负例：测试块【之内】的不算",
      got: scanRustCopy('#[cfg(test)]\nmod tests {\n  fn t() -> String { format!("空间「{space_id}」不存在") }\n}\n').length,
      want: 0,
    },
    // ---- C2
    { name: "C2 正例：含 ** 的字符串 ⇒ 计 1", got: countRustStars('let s = "…**能被别人拉到**…";'), want: 1 },
    { name: "C2 负例：不含星号 ⇒ 计 0", got: countRustStars('let s = "普通文案";'), want: 0 },
    { name: "C2 正例：inlineMd( ⇒ 计 1", got: countInlineMd("<b>{inlineMd(x)}</b>"), want: 1 },
    // ---- C3
    {
      name: "方向：只减不增的键【变少】⇒ 可收紧、不算红",
      got: compareCounts({ "a.rs": 1 }, { "a.rs": 3 }).raised.length,
      want: 0,
    },
    {
      name: "方向：只增不减的键（inlineMd）【变少】⇒ 必须红",
      got: compareCounts({ "::inlineMd-sites": 7 }, { "::inlineMd-sites": 8 }).raised.length,
      want: 1,
    },
    {
      name: "方向：只增不减的键【变多】⇒ 可收紧、不算红",
      got: compareCounts({ "::inlineMd-sites": 9 }, { "::inlineMd-sites": 8 }).raised.length,
      want: 0,
    },
  ];
  let bad = 0;
  for (const c of cases) {
    const pass = c.got === c.want;
    if (!pass) bad++;
    console.log(`  ${pass ? "✓" : "✗"} ${c.name}（得 ${c.got}，期望 ${c.want}）`);
  }
  console.log(
    bad ? `[check-copy-discipline] self-test: ${bad} 项失败` : `[check-copy-discipline] self-test: ${cases.length}/${cases.length} 通过`,
  );
  return bad === 0;
}

// ---------------------------------------------------------------- 主流程
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "target", "dist", "dist-web", ".git"].includes(e.name)) continue;
      walk(p, acc);
    } else acc.push(p);
  }
  return acc;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) return selfTest() ? 0 : 1;

  // ---- C1
  const c1 = {};
  const c1hits = [];
  for (const f of walk(join(root, "src-tauri", "src"))) {
    if (!f.endsWith(".rs")) continue;
    const rel = relative(root, f);
    if (skipRustFile(rel)) continue;
    const hits = scanRustCopy(readFileSync(f, "utf8"));
    if (hits.length) {
      c1[rel] = (c1[rel] ?? 0) + hits.length;
      for (const h of hits) c1hits.push({ file: rel, ...h });
    }
  }

  // ---- C2
  let stars = 0;
  for (const f of walk(join(root, "src-tauri", "src"))) {
    if (!f.endsWith(".rs") || skipRustFile(relative(root, f))) continue;
    stars += countRustStars(readFileSync(f, "utf8"));
  }
  let inlineMdSites = 0;
  const mdFiles = [];
  for (const f of walk(join(root, "src"))) {
    if (!/\.(tsx?|jsx?)$/.test(f) || /\.test\./.test(f)) continue;
    const n = countInlineMd(readFileSync(f, "utf8"));
    if (n) {
      inlineMdSites += n;
      mdFiles.push(relative(root, f));
    }
  }

  // ---- C3（**只计数、不判红**，理由见文件头）
  let c3ref = 0;
  for (const f of walk(join(root, "src", "components"))) {
    if (!/\.tsx$/.test(f) || /\.test\./.test(f)) continue;
    c3ref += scanAdjacentExprRef(readFileSync(f, "utf8")).length;
  }

  const counts = { ...c1 };
  counts["::rust-star-strings"] = stars;
  counts["::inlineMd-sites"] = inlineMdSites;

  const baseArg = argv.indexOf("--baseline");
  const baselinePath =
    baseArg >= 0 && argv[baseArg + 1]
      ? resolve(root, argv[baseArg + 1])
      : join(root, "scripts", "copy-discipline-baseline.json");

  if (argv.includes("--update-baseline")) {
    const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(baselinePath, JSON.stringify(sorted, null, 2) + "\n", "utf8");
    console.log(`[check-copy-discipline] 基线已更新：${relative(root, baselinePath)}（${Object.keys(sorted).length} 个键）`);
    return 0;
  }

  const baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, "utf8").replace(/^\uFEFF/, ""))
    : {};
  const { raised, lowerable } = compareCounts(counts, baseline);

  console.log(
    `[check-copy-discipline] C1 候选（中文字符串里的身份标识）：${Object.values(c1).reduce((a, b) => a + b, 0)} 处 / ${Object.keys(c1).length} 个文件`,
  );
  console.log(`                        C2 rust 含 ** 的字符串：${stars} ｜ inlineMd 调用点：${inlineMdSites}（${mdFiles.length} 个文件）`);
  console.log(`                        C3 相邻表达式容器：${c3ref} 处（**只计数不判红** —— 实测 0 真阳，见文件头；真正的判定在 verify-mobile-views 的运行时面）`);
  for (const l of lowerable) console.log(`  可收紧基线（已修少）：${l.file} ${l.was} → ${l.now}`);

  if (raised.length) {
    console.error(`\n[check-copy-discipline] 文案纪律：${raised.length} 个键变多 —— 请改文案，或用 --update-baseline 交代理由：`);
    for (const r of raised) {
      console.error(`  ${r.file}: ${r.was} → ${r.now}`);
      for (const h of [...c1hits].filter((h) => h.file === r.file).slice(0, 4)) {
        console.error(`      ${h.line}: ${h.text}`);
      }
    }
    console.error("\n（C1 是候选过滤器：命中不等于「一定到界面」，但不交代就不许变多 —— 同 check-plan-status 的纪律）");
    return 1;
  }
  console.log("没有新增文案纪律问题。");
  return 0;
}

if (isMain(import.meta.url)) process.exit(main());
