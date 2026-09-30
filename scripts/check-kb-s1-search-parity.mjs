#!/usr/bin/env node
// scripts/check-kb-s1-search-parity.mjs —— 知识层 Phase 1 · **S1 ③** 的出口判据
//   「同一份夹具数据 ＋ 同一查询 ⇒ 桌面（FTS5/BM25）与 Web（LIKE）的**命中集合**必须相等（排序可比）」
//   出处：_workspace/notes/2026-10-01-knowledge-phase1-exit-criteria-draft-windows.md §1 ＋ §3（R105=A 采用 ✓）
//
// 挡的是哪一类事故（为什么它危险）：
//   两个平台各有一套检索实现 —— 桌面 Rust FTS5/BM25、Web 的 sql.js 走 LIKE ✗。
//   判据层的既有两条都**管不到这件事**：
//     · check-search-platform-parity —— 只保证「平台差异**写进了文档**」✗（不看命中集合）；
//     · check-kb-s1-search         —— 只保证「同一次查询覆盖正文＋附件」✗（只管桌面那份来源声明）。
//   ⇒ 「同一份笔记，换个平台搜出来**少了一条**」这件事**今天没有任何判据碰过** ✗ ——
//     而这正是本仓最罚的形状：不炸、不报错、只是结果不同 ✗。
//
// ## 本条的契约（跨语言夹具的**已有形状**，不新造 ✓）
//   本仓早有「两侧共读一份夹具」的做法，照抄它即可（形状出处逐条给全 ✓）：
//     · `tests/pages-get-window-parity.json` ← Rust `plugins.rs:7376` 的 `include_str!(...)` ＋
//       TS `src/lib/capabilities/pagesGet.test.ts:210` 的 `readFileSync(join(root, "tests", ...))`
//     · `tests/normalize-parity.json`        ← Rust `src-tauri/src/textnorm.rs:95` ＋
//       TS `src/lib/extract/normalize-parity.test.ts:20`
//   于是 S1 ③ 的判据是这四条（都能机核 ✓）：
//     ① **夹具只有一份**：`tests/search-parity.json` —— JSON 可解析、`note` 在（口径要自证 ✓）、
//        `cases` ≥ 2、每条有非空 `query` 与非空 `expect`（命中集合，**顺序无关** ✓）。
//     ② **Rust 侧真消费**：`src-tauri/src/**/*.rs` 里出现 `include_str!("../../tests/search-parity.json")`。
//     ③ **TS 侧真消费**：`src/**/*.test.ts*` 里读同一份（出现 `search-parity.json` ＋ `tests` 两处特征）。
//     ④ **不许两份**：全仓只允许一处叫 `search-parity.json` 的文件（两份夹具 ＝ 各说各话 ✗）。
//
// ## ⚠️ 本条**不证明**什么（照实 ✓）
//   它**不**证明两边的引擎真的算出同一个集合 —— 那要两侧都跑（桌面要 Rust/SQLite、Web 要 sql.js）✗。
//   它证明的是**前提**：两侧读的是**同一份**、**非空壳**的夹具 ⇒ 「跨语言一致性断言」才不是空话 ✓。
//   缺口明写：夹具落地后，**真正的相等断言由两侧各自的测试承担**（Rust 那半在 CI 的 rust 组 ✓）。
//
// ## 登记形态（与 `check-kb-s1-search` / `check-mcp-bridge-dumb` 同形 ✓）
//   夹具还没落地 ⇒ **绿 ＋ 自报跳过** ✓（判据先行阶段的正常状态 ✓）；
//   要看那条红 ⇒ `--require-fixture` ⇒ **exit 2**（**不算通过** ✗）。
//
// 过期条件：若哪天两侧改成跑**同一份**实现（或两侧引擎合一 ⇒ 平台差异消失 ✓），本条作废 ✓。
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 无对象（**不算通过**）
// 用法：node scripts/check-kb-s1-search-parity.mjs ／ --root <夹具根> ／ --require-fixture ／ --self-test
import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const FIXTURE_REL = "tests/search-parity.json";
const FIXTURE_NAME = "search-parity.json";
const RUST_NEEDLE = 'include_str!("../../tests/search-parity.json")';
const SKIP_DIRS = new Set(["node_modules", "target", "dist", ".git", "release", "gen"]);

/** 递归列出相对路径（跳过产物／依赖目录 ✓ —— 大仓里这两个能占 99% 的文件数 ✗） */
function walk(root, rel = ".") {
  const out = [];
  const abs = join(root, rel);
  let entries;
  try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel === "." ? e.name : rel + "/" + e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...walk(root, r));
    } else if (e.isFile()) out.push(r);
  }
  return out;
}

/** 纯判据：夹具根 ⇒ { findings, declared }（findings 空 ＝ 干净 ✓） */
export function judge(root) {
  const out = [];
  const fixAbs = join(root, FIXTURE_REL);
  if (!existsSync(fixAbs)) return { findings: [], declared: false };

  // ① 夹具本身：可解析 ＋ note ＋ cases ≥ 2 ＋ 每条 query/expect 非空
  let fx = null;
  try { fx = JSON.parse(readFileSync(fixAbs, "utf8")); } catch (e) {
    out.push("✗ " + FIXTURE_REL + " 不是合法 JSON ⇒ 夹具坏了，跨语言一致性断言会静默不存在 ✗（" + e.message + "）");
  }
  if (fx) {
    if (typeof fx.note !== "string" || !fx.note.trim()) {
      out.push("✗ " + FIXTURE_REL + " 没有 `note` ⇒ **夹具的口径不自证** ✗（照 `tests/pages-get-window-parity.json` 的写法：把刻意的选择写进去 ✓）");
    }
    const cases = Array.isArray(fx.cases) ? fx.cases : null;
    if (!cases) out.push("✗ " + FIXTURE_REL + " 没有 `cases` 数组 ⇒ 判据没有可检查对象 ✗");
    else if (cases.length < 2) {
      out.push("✗ " + FIXTURE_REL + " 只有 " + cases.length + " 条用例 ⇒ **空壳夹具** ✗"
        + "（一条用例证明不了两个平台在**不同形状**下也一致 ✓；S1 ③ 要的是「同一查询 ⇒ 命中集合相等」✓）");
    } else {
      cases.forEach((c, i) => {
        const nm = "#" + (i + 1) + (c && c.name ? "（" + c.name + "）" : "");
        if (!c || typeof c.query !== "string" || !c.query.trim()) out.push("✗ 用例 " + nm + " 缺非空 `query` ✗");
        if (!c || !Array.isArray(c.expect) || c.expect.length === 0) {
          out.push("✗ 用例 " + nm + " 缺非空 `expect`（**期望的命中集合**）✗ ⇒ 没有期望值就没有「相等」可断 ✓");
        }
      });
    }
  }

  // ②③ 两侧真消费（接线断言：光有夹具、没人读 ⇒ 与没有夹具一样 ✗）
  const rels = walk(root);
  const rustHits = rels.filter((r) => r.startsWith("src-tauri/src/") && r.endsWith(".rs")
    && readFileSync(join(root, r), "utf8").includes(RUST_NEEDLE));
  const tsHits = rels.filter((r) => r.startsWith("src/") && /\.test\.tsx?$/.test(r)
    && readFileSync(join(root, r), "utf8").includes(FIXTURE_NAME));
  if (rustHits.length === 0) {
    out.push("✗ **Rust 侧没有任何文件消费**这份夹具 ✗（找不到 `" + RUST_NEEDLE + "`）"
      + " ⇒ 桌面（FTS5/BM25）那半的命中集合**没人断** ✓ ⇒ 夹具只是半边 ✓");
  }
  if (tsHits.length === 0) {
    out.push("✗ **TS 侧没有任何测试消费**这份夹具 ✗（`src/**/*.test.ts*` 里找不到 " + FIXTURE_NAME + "）"
      + " ⇒ Web（LIKE）那半的命中集合**没人断** ✓");
  }

  // ④ 不许两份（两份夹具 ＝ 各说各话 ✗）
  const all = rels.filter((r) => r.endsWith("/" + FIXTURE_NAME) || r === FIXTURE_NAME);
  if (all.length > 1) {
    out.push("✗ 全仓出现了 " + all.length + " 份 `" + FIXTURE_NAME + "` ⇒ **两份夹具 ＝ 各说各话** ✗："
      + all.join(" ／ ") + "（跨语言一致性只认**一份** ✓）");
  }
  return { findings: out, declared: true };
}

export function run(root, requireFixture) {
  const { findings, declared } = judge(root);
  if (!declared) {
    console.error("  ! 自报跳过（不装绿）：S1 ③ 的跨语言夹具（`" + FIXTURE_REL + "`）还没落地 ⇒ 本条判据现在没有可检查对象");
    if (requireFixture) {
      console.error("  ⇒ 已给 `--require-fixture` ⇒ 按「S1 ③ 未落地 / 无可检查对象」exit 2（**不算通过** ✗）");
      return 2;
    }
    console.error("  ⇒ 登记形态：绿 ＋ 自报跳过（判据先行阶段的正常状态 ✓；要看那次红就加 `--require-fixture`）");
    return 0;
  }
  if (findings.length) { for (const x of findings) console.error(x); return 1; }
  console.log("✓ S1 ③：跨语言夹具只有一份（`" + FIXTURE_REL + "`）＋ 两侧都真消费（Rust `include_str!` ／ TS 测试）＋ 用例非空壳");
  console.log("  ⚠️ 本条只保证**前提**（同一份、非空壳、两侧都读 ✓）；真正的「命中集合相等」由两侧各自的测试在 CI 上断 ✓");
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "kb-s1-parity-"));
  const write = (rel, text) => { const p = join(dir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text, "utf8"); };
  const goodFixture = JSON.stringify({
    note: "S1 ③ 跨语言夹具：命中集合相等、排序可比（口径自证 ✓）",
    cases: [
      { name: "正文里的词", query: "会议", expect: ["p1", "p2"] },
      { name: "附件派生文本里的词", query: "发票", expect: ["p3"] },
    ],
  }, null, 2);
  const rustOk = 'const RAW: &str = include_str!("../../tests/search-parity.json");\n';
  const tsOk = 'const fixturePath = join(root, "tests", "search-parity.json");\n';
  const reset = () => {
    write(FIXTURE_REL, goodFixture);
    write("src-tauri/src/parity.rs", rustOk);
    write("src/lib/search-parity.test.ts", tsOk);
  };
  const cases = [
    ["正例（一份夹具 ＋ 两侧都消费）", () => {}, 0],
    ["变异①（Rust 侧没消费 ⇒ 桌面那半没人断）", () => { write("src-tauri/src/parity.rs", "fn nothing() {}\n"); }, 1],
    ["变异②（TS 侧没消费 ⇒ Web 那半没人断）", () => { write("src/lib/search-parity.test.ts", "// 还没写\n"); }, 1],
    ["变异③（夹具不是合法 JSON）", () => { write(FIXTURE_REL, "{ 坏 JSON"); }, 1],
    ["变异④（空壳夹具：只 1 条用例）", () => { write(FIXTURE_REL, JSON.stringify({ note: "x", cases: [{ query: "a", expect: ["p1"] }] })); }, 1],
    ["变异⑤（用例缺 expect ⇒ 没有「相等」可断）", () => { write(FIXTURE_REL, JSON.stringify({ note: "x", cases: [{ query: "a", expect: ["p1"] }, { query: "b" }] })); }, 1],
    ["变异⑥（出现第二份夹具 ⇒ 各说各话）", () => { write("src-tauri/tests/search-parity.json", goodFixture); }, 1],
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
    rmSync(join(dir, FIXTURE_REL), { force: true });
    const a = run(dir, false), b = run(dir, true);
    if (a === 0) pass++;
    if (b === 2) pass++;
    console.log(`  ${a === 0 ? "✓" : "✗"} 夹具未落地（登记形态）⇒ exit=${a}（期望 0）`);
    console.log(`  ${b === 2 ? "✓" : "✗"} 夹具未落地 ＋ \`--require-fixture\` ⇒ exit=${b}（期望 2，**不是 0** ✗）`);
    const total = cases.length + 2;
    console.log(`self-test: ${pass}/${total} 通过`);
    process.exit(pass === total ? 0 : 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const i = argv.indexOf("--root");
const root = i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : ROOT;
process.exit(run(root, argv.includes("--require-fixture")));
