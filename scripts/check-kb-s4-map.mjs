#!/usr/bin/env node
// scripts/check-kb-s4-map.mjs —— 知识层 Phase 1 · **S4 知识地图**的三条出口判据
//   出处：_workspace/notes/2026-10-01-knowledge-phase1-exit-criteria-draft-windows.md §1 ＋ §3（R105=A 采用 ✓）
//     ① 关系数据**可重建**（派生 ✓ —— `INV-KB-derived-rebuildable` ✓）
//     ② 大库不许把界面拖死：给**条数上限 ＋ 明示「只画了一部分」** ✓（本仓最忌「悄悄截断」✗）
//     ③ 与既有 `GraphView`／`backlinks` 的**口径不许打架**（同一份关系不许两套算法 ✗）
//
// 挡的是哪一类事故（为什么它危险）：
//   本仓**已经有**关系视图与反链（`src/components/GraphView.tsx` ✓、`BacklinksPanel.tsx` ✓、
//   `get_backlinks`／`list_block_backlinks` ✓、Web 侧 `backlinkRefMatches` ✓）。S4 再画一张地图，
//   最容易出三类**不炸、不报错**的坏法：
//     ① 把关系**存下来**（缓存/落表）⇒ 它不再能从内容重建 ⇒ 与派生表纪律打架 ✗；
//     ② 大库上默默只画前 N 条 ⇒ 用户以为「我的图就这么大」✗（本仓逐字罚过「悄悄截断」✓）；
//     ③ 第三套 `[[…]]` 匹配算法 ⇒ 同一份内容在两个视图里连出的边不同 ✗（既有两套已经要靠夹具对齐 ✓）。
//   ⇒ 三条都只能靠判据钉 ✓。
//
// ## 本条的契约（**先判据后实现** —— 与 `check-kb-s1-search` / `check-kb-s3-timeline` 同形 ✓）
//   实现落地时，**每个实现 S4 的文件**里写一个标记 `KB-S4-MAP` ✓；带标记的文件即检查面（opt-in ⇒ 今天零影响 ✓）：
//     ① 不持久化关系：不出现 SQL 写动词（`INSERT`/`UPDATE`/`DELETE`/`CREATE`）✗、
//        不出现 `localStorage.setItem` ✗（关系必须**从内容重建** ✓）；
//     ② 上限与截断**成对**出现、且都在**同一处**：`GRAPH_NODE_CAP` 必须跟着一个**数字** ✓、
//        `GRAPH_TRUNCATED` 必须在同一文件里声明（明示「只画了一部分」✓）——
//        只有上限没有「截断了」的标志 ⇒ 就是**悄悄截断** ✗；
//     ③ 口径复用：带标记的文件里**不许**自己写 `[[` 的匹配（`\[\[` ✗），
//        且必须引用既有的关系出处之一（`backlinkRefMatches` ／ `get_backlinks` ／ `list_block_backlinks` ✓）。
//
// ## 判据 / 命令 / 反例 / 过期条件（四要件 ✓）
//   判据：`node scripts/check-kb-s4-map.mjs` ⇒ 0（带标记的文件全合格）／1（有一条被破）／2（无对象）
//   命令：同上 ／ `--root <夹具根>` ／ `--require-map`（**把「还没落地」也判红** ⇒ exit 2 ✓）／ `--self-test`
//   反例：`--self-test` 里逐条造（正例 ＋ 六条变异 ⇒ 每条都真 exit 1，逐字输出见 `_workspace/mutation-evidence.json` ✓）
//   过期条件：S4 实现**不写标记** ⇒ 本条静默跳过 ✗（**已知缺口，明写不藏** ✓ ——
//     补救是 `--require-map` ＋ 本文件头 ＋ 草案 §3 的契约段；S4 上线后应改成"按文件路径找"✓）
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 无对象（**不算通过**）
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const MARKER = "KB-S4-MAP";
const SCAN_ROOTS = ["src", "src-tauri/src"];
const EXTS = [".ts", ".tsx", ".rs"];
const SKIP_DIRS = new Set(["node_modules", "target", "dist", ".git", "release", "gen"]);
const SHARED_RELATION = ["backlinkRefMatches", "get_backlinks", "list_block_backlinks"];

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

/** 纯判据：带标记的文件 ⇒ { findings }（空 ＝ 干净 ✓） */
export function judgeMarked(files) {
  const out = [];
  if (files.length === 0) return { findings: out };

  for (const f of files) {
    // ① 关系可重建：不许持久化
    const sql = f.text.match(/\b(INSERT|UPDATE|DELETE|CREATE)\b/);
    if (sql) {
      out.push("✗ " + f.rel + " 出现了 SQL 写动词 `" + sql[1] + "` ✗ ⇒ 关系要**可从内容重建**（S4 ① ✓，"
        + "`INV-KB-derived-rebuildable` ✓）：存下来就多了一份会漂的真相 ✗");
    }
    if (f.text.includes("localStorage.setItem")) {
      out.push("✗ " + f.rel + " 里出现 `localStorage.setItem` ✗ ⇒ 关系被**持久化**了（S4 ① ✓）："
        + "派生数据不许另存一份（重建不了 ＝ 与内容脱钩 ✗）");
    }

    // ② 上限 ＋ 截断必须成对、且都在这一个文件里
    const hasCap = f.text.includes("GRAPH_NODE_CAP");
    const hasTrunc = f.text.includes("GRAPH_TRUNCATED");
    if (!hasCap && !hasTrunc) {
      out.push("✗ " + f.rel + " 既没有 `GRAPH_NODE_CAP` 也没有 `GRAPH_TRUNCATED` ✗ ⇒ 大库上要么拖死界面、"
        + "要么**悄悄截断**（S4 ② ✓）—— 本仓逐字罚过「悄悄截断」✗");
    } else {
      if (!hasCap) out.push("✗ " + f.rel + " 有 `GRAPH_TRUNCATED` 却**没有** `GRAPH_NODE_CAP` ✗ ⇒ 截断没有上限可依（S4 ② ✓）");
      else {
        const i = f.text.indexOf("GRAPH_NODE_CAP");
        const near = f.text.slice(i, i + 60);
        if (!/[:=]\s*\d+/.test(near)) {
          out.push("✗ `GRAPH_NODE_CAP` 后面没跟着一个**数字** ✗（读到：" + near.split("\n")[0].trim()
            + "）⇒ 「上限」没写数 ⇒ 等于没有上限（S4 ② ✓）");
        }
      }
      if (!hasTrunc) {
        out.push("✗ " + f.rel + " 有上限却**没有** `GRAPH_TRUNCATED` ✗ ⇒ **悄悄截断**（S4 ② ✓）："
          + "用户会以为「我的图就这么大」，而实际只画了一部分 ✗");
      }
    }

    // ③ 口径复用：不许第三套 [[ 匹配
    //   ⚠️ 认**两种写法**（都是"自己写解析"的证据 ✓）：正则字面量 `/\[\[/` 与字符串形式 `"\\[\\["` ✓
    //   —— 第一版只认前者 ⇒ 变异⑤（`new RegExp("\\[\\[")` 那种）**逃掉了** ✗（自测当场 8/9 ✓ 抓到 ✓）。
    if (f.text.includes("\\[\\[") || f.text.includes("\\\\[\\\\[")) {
      out.push("✗ " + f.rel + " 里出现了自己写的 `[[` 匹配 ✗ ⇒ 第三套关系算法（S4 ③ ✓）："
        + "同一份内容在两个视图里会连出不同的边（既有 `backlinkRefMatches` ／ `get_backlinks` / `list_block_backlinks` 是口径出处 ✓）");
    }
  }
  if (!files.some((f) => SHARED_RELATION.some((n) => f.text.includes(n)))) {
    out.push("✗ 带 `" + MARKER + "` 标记的文件里**没有任何一处**引用既有关系出处 ✗（"
      + SHARED_RELATION.join(" ／ ") + "）⇒ 与 `GraphView`／`backlinks` 的口径**必然各写一套**（S4 ③ ✓）");
  }
  return { findings: out };
}

export function run(root, requireMap) {
  const files = [];
  for (const r of SCAN_ROOTS) for (const rel of walk(root, r)) {
    const text = readFileSync(join(root, rel), "utf8");
    if (text.includes(MARKER)) files.push({ rel, text });
  }
  if (files.length === 0) {
    console.error("  ! 自报跳过（不装绿）：没有任何文件带 `" + MARKER + "` 标记 ⇒ S4 知识地图还没落地，本条判据现在没有可检查对象");
    if (requireMap) {
      console.error("  ⇒ 已给 `--require-map` ⇒ 按「S4 未落地 / 无可检查对象」exit 2（**不算通过** ✗）");
      return 2;
    }
    console.error("  ⇒ 登记形态：绿 ＋ 自报跳过（判据先行阶段的正常状态 ✓；要看那次红就加 `--require-map`）");
    return 0;
  }
  const { findings } = judgeMarked(files);
  if (findings.length) { for (const x of findings) console.error(x); return 1; }
  console.log("✓ S4 知识地图：" + files.length + " 个带标记的文件 ⇒ 关系可重建 ✓ ｜ 上限＋截断明示 ✓ ｜ 口径复用既有出处 ✓");
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "kb-s4-"));
  const put = (rel, text) => { const p = join(dir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text, "utf8"); };
  const OK = '// ' + MARKER + '\nimport { backlinkRefMatches } from "./platform/web";\nexport const GRAPH_NODE_CAP = 500;\nexport const GRAPH_TRUNCATED = false;\nexport function build(links: string[]) { return links.filter((l) => backlinkRefMatches(l, "x")); }\n';
  const reset = () => put("src/components/KnowledgeMap.tsx", OK);
  const cases = [
    ["正例（不落盘 ＋ 上限带数 ＋ 截断明示 ＋ 复用既有口径）", () => {}, 0],
    ["变异①（把关系存下来 ⇒ 不可重建）", () => { put("src/components/KnowledgeMap.tsx", OK + 'db.exec("INSERT INTO graph_edges VALUES (1)");\n'); }, 1],
    ["变异②（关系塞进 localStorage）", () => { put("src/components/KnowledgeMap.tsx", OK + 'localStorage.setItem("graph", JSON.stringify(x));\n'); }, 1],
    ["变异③（只有上限、没有「截断了」标志 ⇒ 悄悄截断）", () => { put("src/components/KnowledgeMap.tsx", '// ' + MARKER + '\nimport { get_backlinks } from "../lib/api";\nexport const GRAPH_NODE_CAP = 500;\n'); }, 1],
    ["变异④（上限没带数字 ⇒ 等于没有上限）", () => { put("src/components/KnowledgeMap.tsx", '// ' + MARKER + '\nimport { get_backlinks } from "../lib/api";\nexport const GRAPH_NODE_CAP = "大库就别画了";\nexport const GRAPH_TRUNCATED = false;\n'); }, 1],
    ["变异⑤a（正则字面量自己写 [[ 匹配 ⇒ 口径打架）", () => { put("src/components/KnowledgeMap.tsx", OK + "const re = /\\[\\[([^\\]]+)\\]\\]/g;\n"); }, 1],
    ["变异⑤b（RegExp 字符串形式自己写 [[ 匹配 ⇒ 同上）", () => { put("src/components/KnowledgeMap.tsx", OK + 'const re = new RegExp("\\\\[\\\\[([^\\\\]]+)\\\\]\\\\]");\n'); }, 1],
    ["变异⑥（一处都不引用既有关系出处 ⇒ 各写一套）", () => { put("src/components/KnowledgeMap.tsx", '// ' + MARKER + '\nexport const GRAPH_NODE_CAP = 500;\nexport const GRAPH_TRUNCATED = false;\nexport function build(rows: string[]) { return rows; }\n'); }, 1],
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
    put("src/components/KnowledgeMap.tsx", "export const x = 1;\n");
    const a = run(dir, false), b = run(dir, true);
    if (a === 0) pass++;
    if (b === 2) pass++;
    console.log(`  ${a === 0 ? "✓" : "✗"} 无标记（登记形态）⇒ exit=${a}（期望 0）`);
    console.log(`  ${b === 2 ? "✓" : "✗"} 无标记 ＋ \`--require-map\` ⇒ exit=${b}（期望 2，**不是 0** ✗）`);
    const total = cases.length + 2;
    console.log(`self-test: ${pass}/${total} 通过`);
    process.exit(pass === total ? 0 : 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const i = argv.indexOf("--root");
const root = i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : ROOT;
process.exit(run(root, argv.includes("--require-map")));
