// store 订阅粒度门禁：**有没有组件对整个 store 订阅？**
//
// 为什么要有它（2026-09-25，复核技术选型评估里"Zustand 在多空间/多视图规模下需警惕
// 隐式依赖导致的重渲染"那一条时实测出来的）：
//
//   Zustand 的 `useStore()`（**不带选择器**）订阅的是**整个 state 对象**：只要这个 store 里
//   任何一次 `set()` 发生，组件就重渲染——哪怕它只用了其中一个字段，**甚至一个字段都没用、
//   只用到了 action**（action 引用恒定，本来一次都不该被唤醒）。
//
//   实测：213 个 store 调用点里 **39 处 / 32 个文件**是这种写法，仅 `useNotes` 就有 24 处。
//   而 `useNotes` 恰好是变更最频繁的 store —— `App.tsx` 的自动保存（600ms 去抖）每次都
//   `updateCurrent()` ＋ `loadPages()`（全量重拉页面表）⇒ 三次全量广播。叠加下面这条：
//
//     `PageTree.tsx` 的 `TreeItem` 是**每个可见树节点渲染一次**的递归组件，却也整店订阅
//     ⇒ 一次保存唤醒 N 个树节点实例，外加 DatabaseView(1751 行) / FileManagerView(1208 行) /
//       SyncPanel(1071 行) / GraphView / CommandPalette 一起重跑 render。
//
//   这类写法与 `check-hook-order` 是同族：**不炸、不报错、测试全绿**，只是安静地多渲染；
//   写的人也没"写错"——`const { openPage } = useNotes();` 读起来完全无辜，
//   是**没人告诉过他这行是订阅**。所以只能靠机器判据钉住。
//
// 判据：
//   1. 从 `src/store/*.ts` 收集所有 `export const useXxx = create(...)` 的 hook 名；
//   2. 扫 `src/**/*.{ts,tsx}`（排除 `*.test.*` 与 `src/store/**`）；
//   3. 命中 `<已知 store hook>()`——**调用括号里没有任何参数**——即违规；
//   4. **按文件计数**与基线比较（与 `check-doc-content-access` 同一套纪律：只减不增）。
//
// 为什么基线是"文件 → 计数"而不是"文件:行号"（这不是设计洁癖，是被咬过一次）：
//   第一版基线存 `src/App.tsx:655` 这种行号键。同一天里，在一处订阅**上方**加了 8 行注释
//   ⇒ 那条订阅平移成 663 ⇒ 门禁报"新增整店订阅 1 处"，而**实际一处都没多**。
//   行号会因任何无关编辑漂移，用它当基线等于让门禁在每个 PR 上喊狼来了；按文件计数则
//   不受平移影响，只在"真的多了一处订阅"或"多了一个文件"时响。代价是：同一文件内
//   "改掉一处又新增一处"不会响 —— 报错时会**逐行打出**命中位置，评审看得到。
//
// ⚠️ 边界（如实写清，别当它是 AST）：
//   - 纯文本启发式：会先抹掉注释再匹配；**字符串字面量里**出现 `useNotes()` 这种字样仍可能
//     被误报（本仓目前没有；真出现了就用行内 `// gate-allow: <理由>` 显式放行）。
//   - 只认"同一行闭合的空括号"：`useNotes(\n)` 这种跨行写法**漏报**（本仓一处都没有）。
//   - 不判断"这个组件到底用没用 state 字段"——那要读 store 的类型定义，误报率太高。
//     **整店订阅一律算违规**，包括只用 action 的（后者改起来最简单：删掉那行 hook，
//     在回调里 `useNotes.getState().openPage(id)`，或改成 `useNotes((s) => s.openPage)`）。
//   - 它证明的是"订阅关系"，**不是**"渲染耗时"：React 仍会跳过 props 未变的子元素，
//     所以真实代价小于"30 个组件全量重绘"，但组件自身的 render 函数与子树协调确实白跑。
//
// 修好后重跑 `pnpm check:store-subscriptions`（自测：`node scripts/check-store-subscriptions.mjs --self-test`）；
// 修掉一处就用 `--update-baseline` 把基线收紧一处，直到基线为空。
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const STORE_HOOK_RE = /export\s+const\s+(use[A-Za-z0-9_$]+)\s*=\s*create\s*[<(]/g;
const ALLOW_MARK = /gate-allow\s*:/;

/** 收集 store hook 名：只认 `src/store/*.ts` 里 `create(...)` 出来的那些。 */
export function collectStoreHooks(files) {
  const names = new Set();
  for (const { text } of files) {
    for (const m of text.matchAll(STORE_HOOK_RE)) names.add(m[1]);
  }
  return [...names].sort();
}

/** 抹掉块注释与行注释，保留行号（换成等长空白）。 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  let inBlock = false;
  let inLine = false;
  let inStr = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; } else out += " ";
      i++;
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") { inBlock = false; out += "  "; i += 2; continue; }
      out += c === "\n" ? c : " ";
      i++;
      continue;
    }
    if (inStr) {
      if (c === "\\") { out += "  "; i += 2; continue; }
      if (c === inStr) inStr = null;
      out += c === "\n" ? c : " ";
      i++;
      continue;
    }
    if (c === "/" && n === "/") { inLine = true; out += "  "; i += 2; continue; }
    if (c === "/" && n === "*") { inBlock = true; out += "  "; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; out += " "; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

/** 在若干源码里找"整店订阅"命中，返回 `{ relPath, line, hook, text }`。 */
export function findWholeStoreSubscriptions(sources, hooks) {
  if (!hooks.length) return [];
  const re = new RegExp("\\b(" + hooks.join("|") + ")\\s*\\(\\s*\\)", "g");
  const hits = [];
  for (const { relPath, text } of sources) {
    const lines = stripComments(text).split(/\r?\n/);
    const raw = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (!m) continue;
      if (ALLOW_MARK.test(raw[i])) continue;
      hits.push({ relPath, line: i + 1, hook: m[1], text: raw[i].trim() });
    }
  }
  return hits;
}

/** 命中 → `{ 相对路径: 条数 }`（基线键，与行号无关）。 */
export function countsOf(hits) {
  const counts = {};
  for (const h of hits) counts[h.relPath] = (counts[h.relPath] ?? 0) + 1;
  return counts;
}

/**
 * 与基线比较。`raised` = 变多或新出现的文件（判红）；`lowerable` = 已经修到基线以下的文件
 * （提示收紧基线，不判红）。
 */
export function compareCounts(counts, baseline) {
  const raised = [];
  for (const [file, now] of Object.entries(counts)) {
    const was = baseline[file] ?? 0;
    if (now > was) raised.push({ file, was, now });
  }
  const lowerable = [];
  for (const [file, was] of Object.entries(baseline)) {
    const now = counts[file] ?? 0;
    if (now < was) lowerable.push({ file, was, now });
  }
  const byFile = (a, b) => a.file.localeCompare(b.file);
  return { raised: raised.sort(byFile), lowerable: lowerable.sort(byFile) };
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === "dist-web" || e === "target" || e.startsWith(".")) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

function readSources(root, files) {
  return files.map((p) => ({ relPath: relative(root, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") }));
}

function selfTest() {
  const storeSrc = [{ relPath: "src/store/demo.ts", text: "export const useDemo = create<DemoState>((set) => ({}));" }];
  const hooks = collectStoreHooks(storeSrc);
  const cases = [
    { src: "const { openPage } = useDemo();", want: 1, why: "空选择器的整店订阅" },
    { src: "const { openPage } = useDemo((s) => s.openPage);", want: 0, why: "带选择器，放行" },
    { src: "const x = useDemo.getState().flag;", want: 0, why: "getState 不是订阅" },
    { src: "const y = useDemoFoo();", want: 0, why: "名字前缀相同但不是同一个 hook" },
    { src: "// const { a } = useDemo();", want: 0, why: "注释里的不算" },
    { src: "const { a } = useDemo(); // gate-allow: 例外", want: 0, why: "行内放行标记" },
  ];
  let bad = 0;
  for (const c of cases) {
    const got = findWholeStoreSubscriptions([{ relPath: "t.tsx", text: c.src }], hooks).length;
    const ok = got === c.want;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"}  want=${c.want} got=${got}  ${c.why}  :: ${c.src}`);
  }

  // 基线比较（按文件计数）：这是"行号平移不误报"这条性质的判据。
  const cmp = [
    { counts: { "a.tsx": 1 }, baseline: {}, wantRaised: 1, wantLowerable: 0, why: "新文件出现即红" },
    { counts: { "a.tsx": 1 }, baseline: { "a.tsx": 1 }, wantRaised: 0, wantLowerable: 0, why: "持平不报（行号平移就是这一档）" },
    { counts: { "a.tsx": 2 }, baseline: { "a.tsx": 1 }, wantRaised: 1, wantLowerable: 0, why: "同一文件多了一处 ⇒ 红" },
    { counts: { "a.tsx": 1 }, baseline: { "a.tsx": 3 }, wantRaised: 0, wantLowerable: 1, why: "修少了 ⇒ 只提示可收紧，不判红" },
    { counts: {}, baseline: { "a.tsx": 1 }, wantRaised: 0, wantLowerable: 1, why: "整文件修干净 ⇒ 提示收紧" },
  ];
  for (const c of cmp) {
    const { raised, lowerable } = compareCounts(c.counts, c.baseline);
    const ok = raised.length === c.wantRaised && lowerable.length === c.wantLowerable;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"}  raised=${raised.length}(want ${c.wantRaised}) lowerable=${lowerable.length}(want ${c.wantLowerable})  ${c.why}`);
  }

  console.log(bad ? `[check-store-subscriptions] self-test: ${bad} 项失败` : "[check-store-subscriptions] self-test: 全部通过");
  return bad;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) return process.exit(selfTest() ? 1 : 0);

  const rootArg = argv.indexOf("--root");
  const root = resolve(rootArg >= 0 ? argv[rootArg + 1] : join(HERE, ".."));
  const update = argv.includes("--update-baseline");
  const baseArg = argv.indexOf("--baseline");
  const baselinePath = baseArg >= 0
    ? resolve(argv[baseArg + 1])
    : join(root, "scripts", "store-subscription-baseline.json");

  const storeDir = join(root, "src", "store");
  const storeFiles = readdirSync(storeDir).filter((f) => f.endsWith(".ts")).map((f) => join(storeDir, f));
  const hooks = collectStoreHooks(readSources(root, storeFiles));

  const srcFiles = walk(join(root, "src")).filter((p) => !p.startsWith(storeDir));
  const hits = findWholeStoreSubscriptions(readSources(root, srcFiles), hooks);
  const counts = countsOf(hits);
  const total = hits.length;

  if (update) {
    const sorted = {};
    for (const k of Object.keys(counts).sort()) sorted[k] = counts[k];
    writeFileSync(baselinePath, JSON.stringify(sorted, null, 2) + "\n", "utf8");
    console.log(`[check-store-subscriptions] 基线已更新：${relative(root, baselinePath)}（${Object.keys(sorted).length} 个文件 / ${total} 处）`);
    return 0;
  }

  const baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, "utf8").replace(/^\uFEFF/, ""))
    : {};
  const { raised, lowerable } = compareCounts(counts, baseline);

  console.log(
    `[check-store-subscriptions] store hook：${hooks.length} 个；整店订阅：${total} 处 / ${Object.keys(counts).length} 个文件；` +
      `基线：${Object.values(baseline).reduce((a, b) => a + b, 0)} 处 / ${Object.keys(baseline).length} 个文件`,
  );
  for (const l of lowerable) console.log(`  可收紧基线（已修少）：${l.file} ${l.was} → ${l.now}`);

  if (raised.length) {
    console.error(`\n[check-store-subscriptions] 整店订阅变多（${raised.length} 个文件）——请改成字段级选择器，或在回调里用 getState()`);
    console.error("（真需要整店订阅时，行内写 `// gate-allow: <理由>` 显式放行）：");
    for (const r of raised) {
      console.error(`  ${r.file}: ${r.was} → ${r.now}`);
      for (const h of hits.filter((h) => h.relPath === r.file)) {
        console.error(`      ${h.line}: ${h.hook}()  ::  ${h.text}`);
      }
    }
    console.error("\n修好后重跑 `pnpm check:store-subscriptions`（自测：`node scripts/check-store-subscriptions.mjs --self-test`）。");
    return 1;
  }
  console.log("没有新增整店订阅。");
  return 0;
}

if (isMain(import.meta.url)) process.exit(main());
