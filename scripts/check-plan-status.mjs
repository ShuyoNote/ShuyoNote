#!/usr/bin/env node
// scripts/check-plan-status.mjs
//
// 门禁：**每篇方案（`docs/plans/*.md`）头部必须有一行可判定的「状态」，且报"完成"不许空口无凭。**
//
// ## 为什么需要它（incident，2026-09-27 实测）
//
// `docs/plans/` 当天有 **91 篇**方案。**「写状态」这件事是 `2026-08-24` 才成为习惯的**：
//   · `2026-08-24` 起的方案，头部统一长这样：`> 目标版本：…` ＋ `> 状态：规划（建议）。…`
//   · `2026-08-22` 及更早那批是 `# 标题` → `> 目标：…` → `## 1. 背景与竞品对照`，**没有状态这一行**
//
// 而后果是具体的：那批里好几篇的功能**早已落地**（`docs/roadmap.md` 有
// `✅ M9（v1.13.0）` / `✅ M10（v1.11.0）` / `✅ M12（v1.33.0）` / `✅ M13（v1.25.0）` /
// `✅ M14（v1.37.0）` 带版本号），**可它们在文档里和"未实装"长得一模一样**
// ⇒ 读文档的人（包括 agent）分不出哪些还有效。本仓 `scripts/lib/docs-index.mjs` 的注释
// 已经记着这条后果：**「同一件事被第二次立项」（本仓已经有过"两份口径"的教训）**。
//
// ## 判据（3 条）
//
// 1. **头部必须有 `状态：` 字段**。"头部" = 第一个 `## ` 标题之前（没有 `## ` 则取前 40 行）。
//    ⚠️ 只在头部找 —— 修正过一版错法：第一版扫**全文**，于是 `状态：施工单（…）`
//    这种**正文里的别的字段**被误判成了方案状态。
// 2. **取值是自由文本**。实测仓库里在用的状态词有十几种
//    （`已收口` `已实现` `已拍板` `已定` `规划` `提议` `施工单` `决策/建议` `进度口径` `待拍板` …）。
//    ⇒ **门禁不发明词表**。只报告"没见过的首个词"作为提醒，**不判红**（那是文风，不是缺陷）。
// 3. **报完成就必须有可核证据**：取值含 `已完成 / 已实现 / 已收口 / 已落地 / 已拍板 / 已定`
//    之一的，必须带 `证据：`，且证据里用反引号写出的每个**仓内相对路径都要真实存在**。
//    —— 与 `tests/baseline.json` 同一思路：**"已完成"不许是空口声明**。
//
// ## 刻意**不做**的（边界，写下来免得后人"顺手补上"）
//
// · **不判状态对不对**。门禁只能证"有状态、报完成的证据在"。它证明不了"已收口"是不是真做完了 ——
//   那是语义，靠人。这里只保证**声明不空口**。
// · **不强制 91 篇一次性回填**。它把旧账一次报全，逼后续一篇篇收口。
// · **不判"超 N 天未动"**：那要读 git 历史 + 一个任意的 N，而 N 没有真值。
//   按本仓口径（"能漂的数字不该手写在散文里"），**宁可少判一条，不造假判据**。
//
// 退出码：0 干净 / 1 有发现 / 2 环境不具备（找不到 docs/plans ⇒ **不算通过**）
//
// 旧账冻结：发现数按"类型"记进 `scripts/plan-status-baseline.json`（**只减不增**，
// 与 `check-store-subscriptions` / `check-doc-content-access` 同一套纪律）：
//   · 某类型比基线**多** ⇒ 红（新增了一篇没状态的方案）；
//   · 某类型比基线**少** ⇒ 只提示，用 `--update-baseline` 收紧。
// 之所以要有基线：上线当天就有 64 处旧账。**没有基线，门禁第一天就得被绕开或被删。**
//
// 用法：
//   node scripts/check-plan-status.mjs
//   node scripts/check-plan-status.mjs --self-test
//   node scripts/check-plan-status.mjs --update-baseline
//   node scripts/check-plan-status.mjs --root <dir>       # 自测/夹具用
//   node scripts/check-plan-status.mjs --baseline <file>

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..");

/** 「报完成」的取值必须带可核证据。 */
export const DONE_WORDS = ["已完成", "已实现", "已收口", "已落地", "已拍板", "已定"];

/** 实测在用的首个状态词（**只用于"没见过"提醒，不参与判红**）。 */
export const SEEN_WORDS = [
  "已收口", "已实现", "已拍板", "已定", "规划", "提议", "施工单", "施工准备",
  "决策/建议", "进度口径", "待拍板", "方案", "设计", "决策", "决策补充", "未实装",
];

const HEADER_LIMIT = 40;

/**
 * 取方案头部：第一个 `## ` 标题之前；没有则取前 40 行。
 * @returns {{ head: string, headLines: number }}
 */
export function headerOf(text) {
  const lines = String(text ?? "").split("\n");
  const cut = lines.findIndex((l, i) => i > 0 && /^##\s/.test(l));
  const end = cut >= 0 ? cut : Math.min(lines.length, HEADER_LIMIT);
  return { head: lines.slice(0, end).join("\n"), headLines: end };
}

/** 头部里的 `状态：` 字段值；没有返回 null。 */
export function parseStatus(text) {
  const { head } = headerOf(text);
  // 允许前导 `>`、`-`、`*`；允许 `**状态：**` 这种加粗
  const m = head.match(/^[\s>*\-]*\**\s*状态\s*[:：]\s*(.*)$/m);
  if (!m) return null;
  const raw = m[1].replace(/\*\*/g, "").trim();
  return { raw, firstWord: raw.split(/[（(，,。.；;｜|\s]/)[0] || raw };
}

/** 值是否声明"完成"。 */
export function isDoneClaim(value) {
  return DONE_WORDS.some((w) => String(value).includes(w));
}

/** 头部里的 `证据：` 值；允许与 `状态：` 同行（用 `。`/`；` 分隔）。 */
export function parseEvidence(text) {
  const { head } = headerOf(text);
  const m = head.match(/^[\s>*\-]*\**\s*证据\s*[:：]\s*(.*)$/m);
  if (m) return m[1].replace(/\*\*/g, "").trim();
  // 同行写法：`> 状态：已收口（M10）。证据：见 \`../roadmap.md\``
  const s = parseStatus(text);
  if (s && /证据\s*[:：]/.test(s.raw)) {
    const parts = s.raw.split(/[。；;]/);
    const idx = parts.findIndex((p) => /证据\s*[:：]/.test(p));
    if (idx >= 0) return parts.slice(idx).join("。").replace(/^.*?证据\s*[:：]/, "").trim();
  }
  return null;
}

/**
 * 从证据文本里抽"看起来像仓内相对路径"的项。**两种写法都认**：
 *   · 反引号：`` 见 `../roadmap.md` ``
 *   · markdown 链接：`见 [roadmap](../roadmap.md)`
 * 判据：含 `/`、无空格、不是带 scheme 的 URL。
 * 返回**去重后按字典序排**，与两种写法谁先出现无关（否则调用方会依赖提取顺序）。
 */
export function pathsInEvidence(evidence) {
  if (!evidence) return [];
  const out = new Set();
  const push = (s) => {
    const v = String(s ?? "").trim();
    if (!v.includes("/")) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return; // URL
    if (/\s/.test(v)) return;
    out.add(v.replace(/^\.\//, ""));
  };
  for (const m of String(evidence).matchAll(/`([^`\n]+)`/g)) push(m[1]);
  for (const m of String(evidence).matchAll(/\]\(([^)\s]+)\)/g)) push(m[1]);
  return [...out].sort();
}

/**
 * 纯函数：判定一批方案。
 * @param {{ plans: {name:string,text:string}[], existsFn: (rel:string)=>boolean }} input
 * @returns {{ problems: {file:string,kind:string,msg:string}[], notices: {file:string,word:string}[] }}
 */
export function judgePlans({ plans, existsFn }) {
  const problems = [];
  const notices = [];
  for (const p of plans) {
    const st = parseStatus(p.text);
    if (!st) {
      problems.push({ file: p.name, kind: "缺状态行", msg: "头部没有 `状态：` 字段" });
      continue;
    }
    if (!isDoneClaim(st.raw)) {
      if (!SEEN_WORDS.includes(st.firstWord)) notices.push({ file: p.name, word: st.firstWord });
      continue; // 非完成类声明：不要求证据
    }
    const ev = parseEvidence(p.text);
    if (ev === null) {
      problems.push({ file: p.name, kind: "报完成但无证据", msg: "声明了完成，但头部没有 `证据：`" });
      continue;
    }
    const paths = pathsInEvidence(ev);
    if (paths.length === 0) {
      problems.push({
        file: p.name,
        kind: "证据不可核",
        msg: "`证据：` 里没有可核的仓内相对路径（用反引号写出 `../roadmap.md` 这种）",
      });
      continue;
    }
    const missing = paths.filter((rel) => !existsFn(rel));
    if (missing.length) {
      problems.push({ file: p.name, kind: "证据路径不存在", msg: `指向不存在的路径：${missing.join(", ")}` });
    }
  }
  return { problems, notices };
}

/** 读 docs/plans 下全部方案；目录不在返回 null（调用方按 exit 2 处理）。 */
export function loadPlans(root) {
  const dir = join(root, "docs", "plans");
  if (!existsSync(dir)) return null;
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    out.push({ name, text: readFileSync(join(dir, name), "utf8") });
  }
  return out;
}

/** 按 kind 计数。 */
export function countsByKind(problems) {
  const counts = {};
  for (const p of problems) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
  return counts;
}

/**
 * 与基线比较（**只减不增**，与 `check-store-subscriptions` 同一套纪律）。
 * @returns {{ raised: {kind:string,now:number,was:number}[], lowerable: string[] }}
 */
export function compareCounts(counts, baseline) {
  const raised = [];
  for (const [kind, now] of Object.entries(counts)) {
    const was = baseline[kind] ?? 0;
    if (now > was) raised.push({ kind, now, was });
  }
  const lowerable = [];
  for (const [kind, was] of Object.entries(baseline)) {
    const now = counts[kind] ?? 0;
    if (now < was) lowerable.push(kind);
  }
  return { raised, lowerable };
}

// --------------------------------------------------------------------- self-test
function selfTest() {
  const results = [];
  const t = (name, got, want) =>
    results.push({ name, pass: JSON.stringify(got) === JSON.stringify(want), got, want });
  const kinds = (plans) => judgePlans({ plans, existsFn: (rel) => rel === "../roadmap.md" }).problems.map((p) => p.kind);
  const mk = (name, body) => ({ name, text: body });

  // headerOf —— 头部只到第一个 `## ` 为止（这条是修正过的那版错法）
  t("头部止于第一个 `## `",
    headerOf("# t\n\n> 状态：规划\n\n## 1. 背景\n\n状态：别的").head.includes("状态：别的"), false);
  t("没有 `## ` 时取前 40 行",
    headerOf("# t\n\n> 状态：规划").headLines, 3);

  // parseStatus
  t("解析 `> 状态：已收口（M10）`", parseStatus("> 状态：**已收口**（M10）。")?.raw, "已收口（M10）。");
  t("首个词 = 已收口", parseStatus("> 状态：**已收口**（M10）。")?.firstWord, "已收口");
  t("解析裸 `状态：规划（建议）`", parseStatus("状态：规划（建议）")?.firstWord, "规划");
  t("正文里的 `状态：` 不算（在 `## ` 之后）", parseStatus("# t\n\n## 1. x\n\n状态：施工单"), null);
  t("完全没状态 ⇒ null", parseStatus("# t\n\n正文"), null);

  // isDoneClaim
  t("已收口 ⇒ 报完成", isDoneClaim("已收口（M10）"), true);
  t("已实现 ⇒ 报完成", isDoneClaim("已实现（未提交）"), true);
  t("已拍板 ⇒ 报完成", isDoneClaim("已拍板：走 ①"), true);
  t("规划 ⇒ 不算报完成", isDoneClaim("规划（建议）"), false);
  t("施工单 ⇒ 不算报完成", isDoneClaim("施工单（2026-09-17）"), false);

  // parseEvidence —— 两种写法
  t("证据独占一行", parseEvidence("> 状态：已收口\n> 证据：见 `../roadmap.md`"), "见 `../roadmap.md`");
  t("证据与状态同行", parseEvidence("> 状态：已收口（M10）。证据：见 `../roadmap.md`"), "见 `../roadmap.md`");

  // pathsInEvidence —— 两种写法都认；**返回按字典序**，与写法顺序无关
  t("抽出反引号里的相对路径", pathsInEvidence("见 `../roadmap.md` 与 `scripts/x.mjs`"), ["../roadmap.md", "scripts/x.mjs"]);
  t("抽出 markdown 链接里的路径", pathsInEvidence("见 [roadmap](../roadmap.md)"), ["../roadmap.md"]);
  t("两种写法混用", pathsInEvidence("见 [roadmap](../roadmap.md) 与 `scripts/x.mjs`"), ["../roadmap.md", "scripts/x.mjs"]);
  t("顺序无关（链接在前）", pathsInEvidence("[z](../z.md) 与 `a/a.md`"), ["../z.md", "a/a.md"]);
  t("跳过 URL", pathsInEvidence("见 `https://x.com/a/b` 与 [x](https://y.com/a/b)"), []);
  t("跳过不带 / 的裸名", pathsInEvidence("见 `roadmap.md`"), []);
  t("跳过带空格", pathsInEvidence("见 `a b/c.md`"), []);

  // judgePlans
  t("缺状态 ⇒ 报", kinds([mk("a.md", "# t\n\n正文")]), ["缺状态行"]);
  t("报完成 + 证据存在 ⇒ 不报", kinds([mk("a.md", "# t\n\n> 状态：已收口\n> 证据：见 `../roadmap.md`")]), []);
  t("报完成 + 无证据 ⇒ 报", kinds([mk("a.md", "# t\n\n> 状态：已收口")]), ["报完成但无证据"]);
  t("报完成 + 证据路径不存在 ⇒ 报", kinds([mk("a.md", "# t\n\n> 状态：已收口\n> 证据：见 `../nope.md`")]), ["证据路径不存在"]);
  t("报完成 + 证据无路径 ⇒ 报", kinds([mk("a.md", "# t\n\n> 状态：已收口\n> 证据：口头说的")]), ["证据不可核"]);
  t("规划 ⇒ 不报（也不要求证据）", kinds([mk("a.md", "# t\n\n> 状态：规划（建议）")]), []);
  t("施工单 ⇒ 不报", kinds([mk("a.md", "# t\n\n> 状态：施工单（2026-09-17）")]), []);

  // notices 只提醒、不判红
  const r = judgePlans({ plans: [mk("a.md", "# t\n\n> 状态：某种新词")], existsFn: () => true });
  t("没见过的词 ⇒ 只进 notices", [r.problems.length, r.notices.length], [0, 1]);

  // compareCounts —— 只减不增
  t("持平不报", compareCounts({ a: 2 }, { a: 2 }), { raised: [], lowerable: [] });
  t("变多 ⇒ raised", compareCounts({ a: 3 }, { a: 2 }).raised, [{ kind: "a", now: 3, was: 2 }]);
  t("基线里没有的 kind ⇒ 视为 0 起，变多即 raised",
    compareCounts({ b: 1 }, { a: 2 }).raised.map((x) => x.kind), ["b"]);
  t("变少 ⇒ 只 lowerable、不 raised",
    compareCounts({ a: 1 }, { a: 2 }), { raised: [], lowerable: ["a"] });
  t("清空 ⇒ lowerable", compareCounts({}, { a: 2 }).lowerable, ["a"]);

  // countsByKind
  t("按 kind 计数", countsByKind([{ kind: "x" }, { kind: "x" }, { kind: "y" }]), { x: 2, y: 1 });

  const failed = results.filter((x) => !x.pass);
  for (const x of results) {
    console.log(`${x.pass ? "✓" : "✗"} ${x.name}`);
    if (!x.pass) console.log(`    got=${JSON.stringify(x.got)} want=${JSON.stringify(x.want)}`);
  }
  console.log(`\nself-test: ${results.length - failed.length}/${results.length} 通过`);
  return failed.length === 0;
}

// --------------------------------------------------------------------- main
// ⚠️ 2026-09-27 补守卫（由 macOS 侧的 import 安全普查点出）：**flag 解析与动作一起**放进 `main()`。
//    此前它们全在顶层 ⇒ 谁 `import` 这个文件，宿主的 argv 就漏进来 —— 
//    实测（本机探针）：import 即把整条检查跑完并输出；带 `--update*` 时会写基线。
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);

  const rArg = argv.indexOf("--root");
  const root = resolve(rArg >= 0 ? argv[rArg + 1] : DEFAULT_ROOT);

  const plans = loadPlans(root);
  if (plans === null) {
    console.error(`环境不具备：找不到 ${join(root, "docs", "plans")} —— **什么都没检查不算通过**。`);
    process.exit(2);
  }

  const existsFn = (rel) => {
    const p = resolve(join(root, "docs", "plans"), rel);
    try { return statSync(p).isFile(); } catch { return false; }
  };

  const { problems, notices } = judgePlans({ plans, existsFn });
  const counts = countsByKind(problems);

  const bArg = argv.indexOf("--baseline");
  const baselinePath = bArg >= 0
    ? resolve(argv[bArg + 1])
    : join(root, "scripts", "plan-status-baseline.json");
  let baseline = {};
  try { baseline = JSON.parse(readFileSync(baselinePath, "utf8")); } catch { baseline = {}; }

  if (argv.includes("--update-baseline")) {
    const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(baselinePath, JSON.stringify(sorted, null, 2) + "\n", "utf8");
    console.log(`基线已更新：${baselinePath}`);
    console.log(`  ${JSON.stringify(sorted)}`);
    process.exit(0);
  }

  console.log(`方案文档：${plans.length} 篇`);
  console.log(`判据：头部有 \`状态：\`；报完成（${DONE_WORDS.join("/")}）必须带可核 \`证据：\``);
  if (notices.length) {
    const words = [...new Set(notices.map((n) => n.word))];
    console.log(`\n提醒（不判红）：${notices.length} 篇用了没见过的首个状态词：${words.slice(0, 12).join(" / ")}${words.length > 12 ? " …" : ""}`);
  }

  const { raised, lowerable } = compareCounts(counts, baseline);

  if (raised.length) {
    console.log(`\n★ 比基线**多**了 ${raised.length} 类（新增了没状态 / 空口说完成的方案）：`);
    for (const r of raised) console.log(`    [${r.kind}] ${r.now} 篇（基线 ${r.was}）`);
  }
  if (lowerable.length) {
    console.log(`\n↓ 比基线**少**了（可用 --update-baseline 收紧）：${lowerable.join(", ")}`);
  }

  console.log(`\n当前各类发现：${JSON.stringify(counts)}`);
  console.log(`基线（${baselinePath.replace(root + "/", "")}）：${JSON.stringify(baseline)}`);

  if (problems.length) {
    console.log(`\n明细（共 ${problems.length} 处）：`);
    const byKind = {};
    for (const p of problems) (byKind[p.kind] ??= []).push(p);
    for (const [kind, arr] of Object.entries(byKind)) {
      console.log(`\n  [${kind}] ${arr.length} 篇`);
      for (const p of arr.slice(0, 8)) console.log(`    · docs/plans/${p.file}  —— ${p.msg}`);
      if (arr.length > 8) console.log(`    … 另有 ${arr.length - 8} 篇`);
    }
  }

  if (raised.length) {
    console.log(`\n结果：红 —— 比基线多（${raised.map((r) => r.kind + " " + r.now).join(", ")}）`);
    process.exit(1);
  }
  if (problems.length && Object.keys(baseline).length === 0) {
    console.log(`\n结果：红 —— 基线为空但有 ${problems.length} 处发现。先修，或显式跑 --update-baseline 冻结旧账。`);
    process.exit(1);
  }
  console.log(`\n结果：干净（发现数与基线持平或更少；` + (problems.length ? `${problems.length} 处旧账已冻结` : "无发现") + `）`);
  process.exit(0);
}

if (isMain(import.meta.url)) main();

