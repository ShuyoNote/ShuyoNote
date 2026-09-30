#!/usr/bin/env node
// scripts/check-kb-s3-timeline.mjs —— 知识层 Phase 1 · **S3 时间复盘页**的三条出口判据
//   出处：_workspace/notes/2026-10-01-knowledge-phase1-exit-criteria-draft-windows.md §1 ＋ §3（R105=A 采用 ✓）
//     ① 时间轴数据**只读**派生（不改 `content_json` ✓ —— 全量那条面由 `check-doc-content-access` 守 ✓）
//     ② 空态与「没数据」必须**分得开**（有页面但没活动 ≠ 没有页面 ✓）
//     ③ 时间口径**只有一处**（本地时区/UTC 不许两处各算一遍 ✗）
//
// 挡的是哪一类事故（为什么它危险）：
//   「时间复盘页」是把「我这些天做过什么」摆出来的只读视图。它有三类**不炸、不报错**的坏法：
//     ① 为了显示而在读路径上顺手补一次写（回填/打点）⇒ 派生数据变成第二份真相源 ✗；
//     ② 把两种空态折成一句「暂无数据」⇒ 用户分不清「这个空间还没有页面」和「有页面但这些天没活动」✗
//        （本仓同族先例：`check-locked-loud` —— 「搜不到」与「搜不了」必须分得开 ✓）；
//     ③ 今天用本地时区分桶、明天另一个文件用 UTC 分桶 ⇒ 同一条活动在两次刷新里换了一天 ✗。
//   ⇒ 三条都是「看着对、只是行为不同」的形状 —— 只能靠判据钉 ✓。
//
// ## 本条的契约（**先判据后实现** —— 与 `check-kb-s1-search` 同形 ✓）
//   实现落地时，**每个实现 S3 的文件**（TS 组件/lib 与 Rust 命令都可以）里写一个标记 `KB-S3-TIMELINE` ✓；
//   带标记的文件即本条判据的检查面（**opt-in** ⇒ 对今天的代码零影响 ✓）。带标记的文件必须：
//     ① 只读：不出现 SQL 写动词（`INSERT`/`UPDATE`/`DELETE`/`CREATE`）✗，
//        也不出现直接给 `content_json`／`content_text` 赋值（`= ` 或 `: `）✗；
//     ② 空态分得开：**恰好一处**声明 `TIMELINE_STATES`，里面**恰好两个互不相同**的字符串
//        （一个表「没有页面」、一个表「有页面但没活动」✓ —— 名字自取，个数与互异由判据钉 ✓）；
//     ③ 时间口径一处：**恰好一处** `TIMELINE_DAY_BUCKET`（且要 `export`/`pub` ⇒ 别人能共用 ✓），
//        并且任何带标记的文件里**不许**再出现 `toISOString().slice(0` 这种「另算一天」的写法 ✗。
//
// ## 判据 / 命令 / 反例 / 过期条件（四要件 ✓）
//   判据：`node scripts/check-kb-s3-timeline.mjs` ⇒ 0（带标记的文件全合格）／1（有一条被破）／2（无对象）
//   命令：同上 ／ `--root <夹具根>` ／ `--require-timeline`（**把「还没落地」也判红** ⇒ exit 2 ✓）／ `--self-test`
//   反例：`--self-test` 里逐条造（正例 ＋ 五条变异 ⇒ 每条都真 exit 1，逐字输出见 `_workspace/mutation-evidence.json` ✓）
//   过期条件：S3 实现**不写标记** ⇒ 本条静默跳过 ✗（**这是已知缺口，明写不藏** ✓ ——
//     补救是 `--require-timeline` ＋ 本文件头 ＋ 草案 §3 的契约段；S3 上线后应把它改成"按文件路径找"✓）
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 无对象（**不算通过**）
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const MARKER = "KB-S3-TIMELINE";
const SCAN_ROOTS = ["src", "src-tauri/src"];
const EXTS = [".ts", ".tsx", ".rs"];
const SKIP_DIRS = new Set(["node_modules", "target", "dist", ".git", "release", "gen"]);

function walk(root, rel) {
  const out = [];
  let entries;
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel + "/" + e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...walk(root, r)); }
    else if (e.isFile() && EXTS.some((x) => e.name.endsWith(x))) out.push(r);
  }
  return out;
}

/** 从一段文本里取所有双引号字符串字面量（只用于数「两个互不相同的状态名」✓ —— 不拿它当语义判据 ✗） */
function quoted(text) {
  return (text.match(/"[^"]*"/g) || []).map((s) => s.slice(1, -1)).filter((s) => s.length > 0);
}

/** 纯判据：{ files: [{rel, text}] } ⇒ { findings }（空 ＝ 干净 ✓） */
export function judgeMarked(files) {
  const out = [];
  if (files.length === 0) return { findings: out, marked: 0 };
  const all = files.map((f) => f.text).join("\n");

  // ① 只读：写动词 / 直接给内容列赋值
  for (const f of files) {
    const sql = f.text.match(/\b(INSERT|UPDATE|DELETE|CREATE)\b/);
    if (sql) {
      out.push("✗ " + f.rel + " 出现了 SQL 写动词 `" + sql[1] + "` ✗ ⇒ 时间轴是**只读派生**视图（S3 ① ✓）："
        + "读路径上补一次写 ⇒ 派生数据成了第二份真相源 ✗");
    }
    const assign = f.text.match(/content_(json|text)\s*[:=]/);
    if (assign) {
      out.push("✗ " + f.rel + " 直接给 `" + assign[0].trim() + "` 赋值 ✗ ⇒ 时间轴不许改内容列（S3 ① ✓，"
        + "全量那条面另由 `check-doc-content-access` 守 ✓）");
    }
  }

  // ② 空态分得开：恰好一处 TIMELINE_STATES，里面恰好两个互不相同的名字
  const decls = files.filter((f) => f.text.includes("TIMELINE_STATES"));
  if (decls.length === 0) {
    out.push("✗ 带 `" + MARKER + "` 标记的文件里**没有** `TIMELINE_STATES` 声明 ✗ ⇒ 「有页面但没活动」与「没有页面」"
      + "分不开（S3 ② ✓）—— 两者对用户是两件事（与 `check-locked-loud` 同族 ✓）");
  } else if (decls.length > 1) {
    out.push("✗ `TIMELINE_STATES` 在 **" + decls.length + " 个文件**里各声明了一次 ✗（"
      + decls.map((f) => f.rel).join(" ／ ") + "）⇒ 两处状态定义迟早不一致（S3 ② 要有**一处**真相源 ✓）");
  } else {
    // ⚠️ 取法要**有边界**：从 `TIMELINE_STATES` 后的第一个 `[` 到它的 `]` ✓
    //   （别用"其后 300 字"—— 那会把后面无关行的字符串也数进来 ⇒ **正例被误判** ✗；
    //    也别拿分号当边界 —— 类型标注里就有分号 ✓，这是 `check-kb-s1-search` 踩过的同一个坑 ✓）
    const at = decls[0].text.indexOf("TIMELINE_STATES");
    const open = decls[0].text.indexOf("[", at);
    const close = open >= 0 ? decls[0].text.indexOf("]", open) : -1;
    const body = close > open ? decls[0].text.slice(open, close + 1) : decls[0].text.slice(at, at + 200);
    const names = [...new Set(quoted(body))];
    if (names.length !== 2) {
      out.push("✗ `TIMELINE_STATES` 里的状态名不是**恰好两个互不相同**的（读到 " + names.length
        + " 个：" + (names.join(" ／ ") || "无") + "）✗ ⇒ 折成一个 ⇒ 两种空态分不开（S3 ② ✓）");
    }
  }

  // ③ 时间口径只有一处
  const dayDecls = files.filter((f) => f.text.includes("TIMELINE_DAY_BUCKET"));
  if (dayDecls.length === 0) {
    out.push("✗ 带 `" + MARKER + "` 标记的文件里**没有** `TIMELINE_DAY_BUCKET` ✗ ⇒ 时间口径没有单一出处（S3 ③ ✓）");
  } else if (dayDecls.length > 1) {
    out.push("✗ `TIMELINE_DAY_BUCKET` 在 **" + dayDecls.length + " 个文件**里各有一份 ✗（"
      + dayDecls.map((f) => f.rel).join(" ／ ") + "）⇒ 两处各算一遍 = 同一条活动会换天（S3 ③ ✓）");
  } else {
    const i = dayDecls[0].text.indexOf("TIMELINE_DAY_BUCKET");
    const before = dayDecls[0].text.slice(Math.max(0, i - 60), i);
    if (!/\b(export|pub)\b/.test(before)) {
      out.push("✗ `TIMELINE_DAY_BUCKET` 不是 `export`/`pub` 的 ✗（" + dayDecls[0].rel + "）⇒ **别人共用不到** ⇒ "
        + "别处一定会再算一遍（S3 ③ 要的是**一处**口径 ✓）");
    }
  }
  for (const f of files) {
    if (f.text.includes("toISOString().slice(0")) {
      out.push("✗ " + f.rel + " 里出现了 `toISOString().slice(0` ✗ ⇒ 在 `TIMELINE_DAY_BUCKET` 之外**另算了一天**"
        + "（S3 ③：本地时区/UTC 不许两处各算一遍 ✗ —— 全走那一处 ✓）");
    }
  }
  return { findings: out, marked: files.length };
}

export function run(root, requireTimeline) {
  const files = [];
  for (const r of SCAN_ROOTS) for (const rel of walk(root, r)) {
    const text = readFileSync(join(root, rel), "utf8");
    if (text.includes(MARKER)) files.push({ rel, text });
  }
  if (files.length === 0) {
    console.error("  ! 自报跳过（不装绿）：没有任何文件带 `" + MARKER + "` 标记 ⇒ S3 时间复盘页还没落地，本条判据现在没有可检查对象");
    if (requireTimeline) {
      console.error("  ⇒ 已给 `--require-timeline` ⇒ 按「S3 未落地 / 无可检查对象」exit 2（**不算通过** ✗）");
      return 2;
    }
    console.error("  ⇒ 登记形态：绿 ＋ 自报跳过（判据先行阶段的正常状态 ✓；要看那次红就加 `--require-timeline`）");
    return 0;
  }
  const { findings } = judgeMarked(files);
  if (findings.length) { for (const x of findings) console.error(x); return 1; }
  console.log("✓ S3 时间复盘页：" + files.length + " 个带标记的文件 ⇒ 只读派生 ✓ ｜ 两种空态分得开 ✓ ｜ 时间口径只有一处 ✓");
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "kb-s3-"));
  const put = (rel, text) => { const p = join(dir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text, "utf8"); };
  const OK = '// ' + MARKER + '\nexport const TIMELINE_STATES = ["no_pages", "no_activity"];\nexport const TIMELINE_DAY_BUCKET = (t: string) => t.slice(0, 10);\n';
  const reset = () => put("src/lib/timeline.ts", OK);
  const cases = [
    ["正例（只读 ＋ 两态 ＋ 一处口径）", () => {}, 0],
    ["变异①（读路径上补写 ⇒ 派生变第二份真相源）", () => { put("src/lib/timeline.ts", OK + 'db.exec("UPDATE pages SET content_json = ?");\n'); }, 1],
    ["变异②（空态折成一个状态）", () => { put("src/lib/timeline.ts", '// ' + MARKER + '\nexport const TIMELINE_STATES = ["empty"];\nexport const TIMELINE_DAY_BUCKET = (t: string) => t;\n'); }, 1],
    ["变异③（时间口径没有单一出处）", () => { put("src/lib/timeline.ts", '// ' + MARKER + '\nexport const TIMELINE_STATES = ["no_pages", "no_activity"];\nconst d = new Date().toISOString().slice(0, 10);\n'); }, 1],
    ["变异④（口径不 export ⇒ 别人共用不到）", () => { put("src/lib/timeline.ts", '// ' + MARKER + '\nexport const TIMELINE_STATES = ["no_pages", "no_activity"];\nconst TIMELINE_DAY_BUCKET = (t: string) => t;\n'); }, 1],
    ["变异⑤（另算一天：toISOString().slice(0 ⇒ 与口径两处各算）", () => { put("src/lib/timeline.ts", OK + 'const k = new Date().toISOString().slice(0, 10);\n'); }, 1],
  ];
  let pass = 0;
  try {
    for (const [name, setup, want] of cases) {
      reset();
      setup();
      const got = run(dir, false);
      const okc = got === want;
      if (okc) pass++;
      console.log(`  ${okc ? "✓" : "✗"} ${name} ⇒ exit=${got}（期望 ${want}）`);
    }
    put("src/lib/timeline.ts", "export const x = 1;\n");
    const a = run(dir, false), b = run(dir, true);
    if (a === 0) pass++;
    if (b === 2) pass++;
    console.log(`  ${a === 0 ? "✓" : "✗"} 无标记（登记形态）⇒ exit=${a}（期望 0）`);
    console.log(`  ${b === 2 ? "✓" : "✗"} 无标记 ＋ \`--require-timeline\` ⇒ exit=${b}（期望 2，**不是 0** ✗）`);
    const total = cases.length + 2;
    console.log(`self-test: ${pass}/${total} 通过`);
    process.exit(pass === total ? 0 : 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const i = argv.indexOf("--root");
const root = i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : ROOT;
process.exit(run(root, argv.includes("--require-timeline")));
