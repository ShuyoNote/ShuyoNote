// 代码块高亮**只许有一条装配路径**：`src/editor/prismSetup.ts`（模块化 import）。
//
// ## 这条门禁是怎么来的（2026-09-25 清冗余文件时的**实测**，不是读注释推出来的）
//
// 仓库里本来有**两条并行的 Prism 装配路径**：
//   A. `index.html` 里 10 行 `<script src="prism/prism-*.js">` ＋ `public/prism/` 下 10 份 vendored 组件；
//   B. `src/editor/prismSetup.ts`（`Editor.tsx` 启动时 import）：`import Prism from "prismjs"` ＋
//      16 个组件 ＋ `window.Prism ??= Prism` —— 它自己的注释写着 "independent of the index.html
//      plain <script> loading"。
// 两条路做的事**完全重合**，于是 A 成了纯冗余：10 个文件 / 77 KB，而且它们是 `index.html` 里的
// **阻塞式 script**，每个用户每次启动都要下。真 Chromium 里实测（把 A 的 10 行去掉，重新加载）：
// `window.Prism` 照旧能 highlight `json` / `rust` / `sql` / `go` / `markdown`（token 都出来了）、
// 页面零 JS 报错 ⇒ **A 可以整条删掉**，本门禁就钉住"别再长回来"。
//
// ⚠️ 我第一版判据把方向判反了（写成 "vendored ⇒ 必须在 index.html 里被加载"）：那条规则会**逼着**
//    冗余的第二条路继续存在，而它唯一"证据"是 `prism-json.js` 没被加载 —— 真相是**两条路都不该有 A**。
//    这正是"先量事实、再写判据"的反面教材，留在这里当记录。
//
// ## 两条规则
//   R1（判红）**唯一路径**：`public/prism/` 下不许再有 vendored 组件，`index.html` 里不许再有
//      `<script src="prism/…">`。要动这条链，改 `prismSetup.ts`（并跑运行期那条口径）。
//   R2（只报告）**静态对账**：语言选择器（`CodeBlockToolbar.tsx` 的 `LANGS`）里，`prismSetup.ts`
//      **没有显式 import** 的语言列出来。不判红：到底能不能高亮要看运行期（实测 `markdown` 静态
//      看不到 import、运行期却有语法），所以这条只负责"摆在眼前"，不替人下结论。
//
// 用法：node scripts/check-prism-components.mjs
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `index.html` 里还残留的 Prism 组件 `<script>`（应当为空）。
 *
 * 两处刻意做严（都被真实文件教过一次）：
 *   · **先剥掉 HTML 注释** —— 说明文字里写 `<script src="prism/prism-*.js">` 是**注释**，不是加载；
 *   · 组件名只认 `[a-z0-9-]+`（真名长这样），于是 `prism-*.js` 这种"举例写法"不会被当成命中。
 */
export function legacyScripts(indexHtml) {
  const html = indexHtml.replace(/<!--[\s\S]*?-->/g, "");
  const out = [];
  const re = /<script\s+src="(?:\.\/)?prism\/(prism-[a-z0-9-]+\.js)"\s*>/g;
  for (let m; (m = re.exec(html)); ) out.push(m[1]);
  return out;
}

/** `public/prism/` 下还残留的 vendored 组件文件名（目录不存在 ⇒ 空表）。 */
export function legacyVendored(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^prism-.+\.js$/.test(n))
    .sort();
}

/** `prismSetup.ts` 里 import 了哪些组件（`prism-x` 形态的名字）。 */
export function importedComponents(setupSrc) {
  return [...setupSrc.matchAll(/import\s+"prismjs\/components\/(prism-[a-z0-9-]+)"/g)].map((m) => m[1]).sort();
}

/**
 * 语言选择器里列出的语言（`CodeBlockToolbar.tsx` 的 `LANGS` 是**唯一事实来源**）。
 * 解析不到 ⇒ `null`（列表搬家了，门禁**不猜**、只提示）。
 */
export function offeredLanguages(toolbarSrc) {
  const m = /const\s+(?:LANGS|LANGUAGES)\s*=\s*\[([\s\S]*?)\]/.exec(toolbarSrc);
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** Prism 的组件名与语言名**不总是一样**（`prism-markup` 给 html/xml、`prism-clike` 是底层文法）。 */
export const LANG_TO_COMPONENT = {
  plain: null, // 纯文本本来就不需要文法
  plaintext: null,
  text: null,
  html: "prism-markup",
  xml: "prism-markup",
  javascript: "prism-javascript",
  typescript: "prism-typescript",
  json: "prism-json",
  css: "prism-css",
  bash: "prism-bash",
  shell: "prism-bash",
  python: "prism-python",
  java: "prism-java",
  c: "prism-c",
  cpp: "prism-cpp",
  csharp: "prism-csharp",
  go: "prism-go",
  rust: "prism-rust",
  sql: "prism-sql",
  markdown: "prism-markdown",
  yaml: "prism-yaml",
};

/** 跑一遍：`{ scripts, vendored, imported, offered, notImported }`。 */
export function check(rootDir = root) {
  const indexHtml = readFileSync(join(rootDir, "index.html"), "utf8");
  const setupSrc = readFileSync(join(rootDir, "src", "editor", "prismSetup.ts"), "utf8");
  const imported = importedComponents(setupSrc);
  let offered = null;
  try {
    offered = offeredLanguages(readFileSync(join(rootDir, "src", "editor", "plugins", "CodeBlockToolbar.tsx"), "utf8"));
  } catch {
    offered = null;
  }
  const importedSet = new Set(imported);
  const notImported = offered
    ? offered.filter((lang) => {
        const comp = LANG_TO_COMPONENT[lang];
        if (comp === null) return false; // 纯文本：不需要文法
        if (comp === undefined) return true; // 映射表里没有 ⇒ 明确没有组件
        return !importedSet.has(comp);
      })
    : null;
  return {
    scripts: legacyScripts(indexHtml),
    vendored: legacyVendored(join(rootDir, "public", "prism")),
    imported,
    offered,
    notImported,
  };
}

if (isMain(import.meta.url)) {
  const { scripts, vendored, imported, offered, notImported } = check();
  const bad = [];
  if (vendored.length) {
    bad.push(
      `\`public/prism/\` 下还有 ${vendored.length} 份 vendored 组件：${vendored.join(" / ")} —— ` +
        `那是**已被取代的第二条装配路径**（模块化那条在 \`src/editor/prismSetup.ts\`），留着只会又长出一条并行的路`,
    );
  }
  if (scripts.length) {
    bad.push(`\`index.html\` 里还有 ${scripts.length} 行 Prism 的 \`<script src="prism/…">\`（阻塞式、也已冗余）：${scripts.join(" / ")}`);
  }
  if (bad.length) {
    console.error("代码块高亮出现了第二条装配路径：");
    for (const b of bad) console.error(`  ✗ ${b}`);
    console.error("  修法：`git rm public/prism/prism-*.js` 并删掉 index.html 里那几行；要加语法就改");
    console.error("        `src/editor/prismSetup.ts` 的 import（真 Chromium 实测：删掉那 10 行后高亮全在）。");
    process.exit(1);
  }
  console.log(`代码块高亮只有一条装配路径：\`prismSetup.ts\` import 了 ${imported.length} 份组件，index.html 零 script、public/prism 已删`);
  if (notImported === null) {
    console.log("· 语言选择器那份列表解析不到（`CodeBlockToolbar.tsx` 里的 LANGS 搬家了？）—— 未做静态对账");
  } else if (notImported.length) {
    console.log(
      `· 静态对账（**不判红**，可不可用要看运行期）：选择器列了 ${offered.length} 种语言，` +
        `其中 ${notImported.length} 种在 \`prismSetup.ts\` 里**没有显式 import**：${notImported.join(" / ")}`,
    );
  } else {
    console.log("· 选择器里每种语言都在 prismSetup.ts 里有对应 import");
  }
}
