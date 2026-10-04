// K4：给 LLM wiki 三条不变式各做一次「看过它红」（控制组绿 ＋ 变异组红）
// 用法：node scripts/mutate-wiki-invariants.mjs
// 判据：每条变异必须让**指定的那个测试文件**退出码非 0；跑完逐字节还原（git 工作区恢复干净）。
//
// ⚠️ 2026-10-01（windows 侧合入时修 ✗）：本文件第 7 行原来**写死了 AMD 那台机器的绝对路径**
//   （`C:/Users/zhai-amd/zhai/repos/ShuyoNote` ✓）⇒ 在**任何别的机器**上第一句就 ENOENT 崩 ✗，
//   于是这份"会红证据"**别处根本重做不了** ✗ —— 而"证据要能原地重做"正是它的全部意义 ✓。
//   改法＝按**脚本自身位置**推仓根 ✓（与仓内 `check-*.mjs` / `_workspace/bin/*.mjs` 同一条写法 ✓）；
//   ⛔ 别再退回写死路径 ✗（那类脚本会**静默失效**：本机绿、换台机器就死 ✓）。
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const VITEST = join(REPO, "node_modules", "vitest", "vitest.mjs");

/** 三条变异：文件 / 原样 / 注入后 / 期望哪个测试文件红 */
const CASES = [
  {
    inv: "INV-WIKI-provenance",
    file: `${REPO}/src/lib/ai/libraryMap.ts`,
    from: "sources: [g.id],",
    to: 'sources: [g.id, "ghost-source"],',
    test: "src/lib/ai/libraryMap.test.ts",
    why: "回链里混进一个**输入里不存在**的 id ⇒ 「sources 必须来自输入」那条断言必须红",
  },
  {
    inv: "INV-WIKI-coverage-visible",
    file: `${REPO}/src/components/LibraryMapView.tsx`,
    from: '{it.count === null ? "未知" : it.count}',
    to: "{it.count === null ? 0 : it.count}",
    test: "src/components/LibraryMapView.test.tsx",
    why: "把「没读数」画成 **0** ⇒ 「null ⇒ 未知且不出现 0」那条断言必须红",
  },
  {
    inv: "INV-WIKI-readonly-default",
    file: `${REPO}/src/lib/ai/libraryMap.ts`,
    from: "  const limit = Math.max(0, Math.floor(opts.gapLimit ?? MAP_GAP_LIMIT) || 0);",
    to: "  report.pages.indexed = 0; // 变异：偷偷改输入\n  const limit = Math.max(0, Math.floor(opts.gapLimit ?? MAP_GAP_LIMIT) || 0);",
    test: "src/lib/ai/libraryMap.test.ts",
    why: "生成时**改输入** ⇒ 「调用前后输入逐字段未变」/「深冻结也能跑完」必须红",
  },
  {
    inv: "INV-WIKI-provenance（第三块：按需单页的草稿层）",
    file: `${REPO}/src/lib/ai/topicDraft.ts`,
    from: 'const keptText = filtered.kept.join("\\n");',
    to: "const keptText = String(answer);", // 变异：绕开既有的 filterClaims ⇒ 编造的回链会原样留在草稿里
    test: "src/lib/ai/topicDraft.test.ts",
    why: "**绕开既有校验器**（`filterClaims`）⇒ 模型编造的回链不被丢 ⇒ 「编造回链被丢，droppedInventedRefs 记 1」与「refs 只来自输入」两条必须红",
  },
];

function runVitest(rel) {
  // ⚠️ 不要加 `--reporter=basic`：vitest 4 下它会内部报错（控制组也会 exit 1 ⇒ 整条证据作废）
  const r = spawnSync(process.execPath, [VITEST, "run", rel], {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const fails = [...out.matchAll(/×\s+(.+?)(?:\s+\d+ms)?$/gm)].map((m) => m[1].trim()).slice(0, 4);
  return { code: r.status, fails, out };
}

let allOk = true;
for (const c of CASES) {
  const orig = readFileSync(c.file, "utf8");
  const hits = orig.split(c.from).length - 1;
  if (hits !== 1) {
    console.log(`⚠️ ${c.inv}：注入点命中 ${hits} 次（要求恰好 1）⇒ 跳过，不假装做过`);
    allOk = false;
    continue;
  }
  // 控制组
  const ctrl = runVitest(c.test);
  // 变异组
  writeFileSync(c.file, orig.replace(c.from, c.to), "utf8");
  const mut = runVitest(c.test);
  writeFileSync(c.file, orig, "utf8"); // 逐字节还原
  const restored = readFileSync(c.file, "utf8") === orig;
  const ok = ctrl.code === 0 && mut.code !== 0 && restored;
  allOk = allOk && ok;
  console.log(`${ok ? "✅" : "✗"} ${c.inv}`);
  console.log(`   控制组 exit=${ctrl.code}（应 0）｜ 变异组 exit=${mut.code}（应非 0）｜ 还原=${restored ? "逐字节一致 ✓" : "不一致 ✗"}`);
  console.log(`   为什么这么注入：${c.why}`);
  if (mut.fails.length) console.log(`   变异组报出的用例：${mut.fails.join(" ／ ")}`);
}
console.log(`\n--- 三条不变式的变异证据：${allOk ? "全部成立" : "有不成立项（见上）"}（判据＝控制组绿 ＋ 变异组红 ＋ 还原一致）`);
process.exit(allOk ? 0 : 1);
