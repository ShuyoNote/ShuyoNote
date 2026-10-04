#!/usr/bin/env node
// scripts/check-kb-s1-search.mjs —— 知识层 Phase 1 · **S1 检索**的两条出口判据（R105=A 采用 ✓）
//
// 出口判据草案出处：`_workspace/notes/2026-10-01-knowledge-phase1-exit-criteria-draft-windows.md` ✓
//   S1 三条里，这条判据管前两条（第三条"两平台命中集合一致"归平台差异那条 ✓）：
//     ① **覆盖**：个人空间里，**正文**与**附件派生文本**要能被**同一次查询**命中 ✓
//        （今天 `search_chunks` 只查块 ✓，`read_attachment_text` 是另一条命令 ✗ ⇒ 用户得搜两次 ✓）
//     ② **降级可见**：索引不可用／没建 ⇒ 必须给**稳定码**，**不许静默返回空** ✗
//        （"没有结果"与"搜不了"对用户是两件事 ✓ —— 与 `check-locked-loud` 同族 ✓）
//
// ## 登记形态（与 MCP 那批同形 ✓）
//   规格/实现里**还没**声明检索来源时 ⇒ **绿 ＋ 自报跳过** ✓（判据先行阶段的正常状态 ✓）；
//   要看那条红 ⇒ `--require-sources` ⇒ **exit 2**（不算通过 ✗）。
//
// ## 契约（本判据定 ✓，实现照它落；改了实现就同时改这里 ✓）
//   `src-tauri/src/search.rs` 里必须有一处**唯一**的来源声明：
//     · `SEARCH_SOURCES`  —— 列出这次查询**一次扫哪些来源**；必须同时含 `page` 与 `attachment` ✓
//     · 索引不可用时必须给**稳定码** `index_unavailable` ✓（不许把"搜不了"折成空结果 ✗）
//
// ⚠️ 判据自己的教训（2026-10-01 当场踩到 ✓）：第一版用 `SEARCH_SOURCES[^;]*;` 去截来源声明 ✗ ——
//   而类型标注里就有分号（`[&str; 2]` ✓）⇒ 只截到 `SEARCH_SOURCES: [&str;` ✓ ⇒ **正例被判红** ✗。
//   ⇒ 改成"取其后 300 字"这种**不依赖标点**的取法 ✓（别拿分号当边界 ✗）。
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 无对象（**不算通过**）
// 用法：node scripts/check-kb-s1-search.mjs ／ --root <夹具根> ／ --require-sources ／ --self-test
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const SEARCH_REL = "src-tauri/src/search.rs";

/** 纯判据：search.rs 的文本 ⇒ { findings, declared }（findings 空＝干净 ✓） */
export function judgeSearch(src) {
  const out = [];
  if (src === null) return { findings: ["读不到 " + SEARCH_REL + " ⇒ 判据没检查到东西（不算通过 ✗）"], declared: false };
  const at = src.indexOf("SEARCH_SOURCES");
  if (at < 0) return { findings: [], declared: false };

  // ① 覆盖：来源声明的**附近**必须同时出现正文与附件派生文本（不拿分号当边界 ✓）
  const decl = src.slice(at, at + 300);
  const hasPage = /"page"|\bpage\b/.test(decl);
  const hasAttach = /"attachment"|\battachment\b/.test(decl);
  if (!hasPage || !hasAttach) {
    out.push("✗ S1 检索的**来源声明**没有同时含正文与附件派生文本（正文=" + hasPage + " ／ 附件=" + hasAttach + "）"
      + " ⇒ 用户得搜两次才知道「附件里有没有」（R105=A 的 S1 第①条 ✓）");
  }

  // ② 降级可见：索引不可用要给稳定码，不许静默空
  if (!/index_unavailable/.test(src)) {
    out.push("✗ 索引不可用时**没有稳定码** `index_unavailable` ✗ ⇒ 「搜不到」与「搜不了」分不开（S1 第②条 ✓，与 `check-locked-loud` 同族 ✓）");
  }
  // ③ **接线**：光声明没用 ✗ —— 页面级那条路必须真的把块命中**归并进来** ✓
  //    （认那段特有的 snippet 标记「【来自附件】」✓ —— 它只在归并里出现 ✓）
  const iMark = src.indexOf('【来自附件】');
  if (iMark < 0) {
    out.push('✗ 声明了来源，但页面级那条路**没有把块命中归并进来** ✗（找不到「【来自附件】」标记）'
      + ' ⇒ 附件文本依旧搜不到（S1 第①条的**接线**半 ✓）');
  } else {
    // ④ **归并必须在 `results.truncate(` 之前** ✓（否则补进来的命中会被截掉 ✗）
    const iTrunc = src.indexOf('results.truncate(');
    if (iTrunc >= 0 && iMark > iTrunc) {
      out.push('✗ 块级归并出现在 `results.truncate(` **之后** ✗ ⇒ 补进来的命中会被截掉（S1 第①条 ✓）');
    }
  }
  return { findings: out, declared: true };
}

function run(root, requireSources) {
  const p = join(root, SEARCH_REL);
  const src = existsSync(p) ? readFileSync(p, "utf8") : null;
  const { findings, declared } = judgeSearch(src);
  if (!declared) {
    console.error("  ! 自报跳过（不装绿）：S1 的来源声明（`SEARCH_SOURCES`）还没落地 ⇒ 本条判据现在没有可检查对象");
    if (requireSources) {
      console.error("  ⇒ 已给 `--require-sources` ⇒ 按「S1 未落地 / 无可检查对象」exit 2（**不算通过** ✗）");
      return 2;
    }
    console.error("  ⇒ 登记形态：绿 ＋ 自报跳过（判据先行阶段的正常状态 ✓；要看那次红就加 `--require-sources`）");
    return 0;
  }
  if (findings.length) { for (const x of findings) console.error(x); return 1; }
  console.log("✓ S1 检索：同一次查询覆盖正文＋附件派生文本 ✓ ｜ 索引不可用给稳定码 ✓");
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "kb-s1-"));
  try {
    const write = (text) => { const p = join(dir, SEARCH_REL); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text, "utf8"); };
    // 正例＝**已正确接线**的形状 ✓：两个来源 ✓、稳定码 ✓、并把块命中归并进来（标记在 `truncate` 之前 ✓）
    const OK = 'const SEARCH_SOURCES: [&str; 2] = ["page", "attachment"];\nconst E: &str = "index_unavailable";\nfn merge() { let s = "【来自附件】"; results.truncate(limit); }\n';
    const cases = [
      ["正例（两个来源 ＋ 稳定码）", OK, 0],
      ["变异①（只扫正文 ⇒ 附件搜不到）", 'const SEARCH_SOURCES: [&str; 1] = ["page"];\nconst E: &str = "index_unavailable";\n', 1],
      ["变异②（索引坏了却静默返空）", 'const SEARCH_SOURCES: [&str; 2] = ["page", "attachment"];\nfn degraded() -> Vec<u8> { Vec::new() }\n', 1],
      // ③④ 两条新断言的变异：**声明了却没接线** / **接线接在 truncate 之后** ✓
      ["变异③（声明了来源，却没归并块命中）", 'const SEARCH_SOURCES: [&str; 2] = ["page", "attachment"];\nconst E: &str = "index_unavailable";\n', 1],
      ["变异④（归并接在 truncate 之后）", 'const SEARCH_SOURCES: [&str; 2] = ["page", "attachment"];\nconst E: &str = "index_unavailable";\nfn f() { results.truncate(limit); let s = "【来自附件】"; }\n', 1],
    ];
    let pass = 0;
    for (const [name, text, want] of cases) {
      write(text);
      const got = run(dir, false);
      const okc = got === want;
      if (okc) pass++;
      console.log(`  ${okc ? "✓" : "✗"} ${name} ⇒ exit=${got}（期望 ${want}）`);
    }
    write("fn search() {}\n");
    const a = run(dir, false), b = run(dir, true);
    if (a === 0) pass++;
    if (b === 2) pass++;
    console.log(`  ${a === 0 ? "✓" : "✗"} 未声明（登记形态）⇒ exit=${a}（期望 0）`);
    console.log(`  ${b === 2 ? "✓" : "✗"} 未声明 ＋ \`--require-sources\` ⇒ exit=${b}（期望 2，**不是 0** ✗）`);
    const total = cases.length + 2;
    console.log(`self-test: ${pass}/${total} 通过`);
    process.exit(pass === total ? 0 : 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const i = argv.indexOf("--root");
const root = i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : ROOT;
process.exit(run(root, argv.includes("--require-sources")));
