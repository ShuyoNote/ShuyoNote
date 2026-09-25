// 死代码收据门禁：**`#[allow(dead_code)]` 不许无名无期**。
//
// 为什么需要它（2026-09-25）：给"清掉编译器报的死代码"这件事收尾时做了一轮全仓稽查，
// 结果不是"有几个警告要修"，而是**一整类东西没人管**：
//   · `sync.rs::IncomingChange.seq` 挂着 `#[allow(dead_code)]`，而它其实**被生产代码读了 8 处** ——
//     豁免早就过期了，只是没人会去看（`allow` 不产生任何输出）；
//   · `gm_patch_probe.rs` 里 8 处逐项豁免挡着的，是"这个模块在产品二进制里根本不需要存在"；
//   · `commands.rs::mupdf_compiled()` 的 body 就是 `cfg!(feature)`，它唯一的使用者是一条
//     `assert_eq!(cfg!(f), cfg!(f))` 的**空转判据** —— 死代码不但没被发现，还自己长了一条判据；
//   · `security.rs` 一次"文档与属性被留在上一个函数下面"的事故让一个夹具生成器**被 libtest
//     注册两遍**（跑两遍），而另一条 generation 彻底不可达。
// 共同点：**一个 `#[allow(dead_code)]` 就让一整块东西免检**，而且它不吵不闹。
// ⇒ 本门禁只做一件机器能做的事：**每处豁免必须带一条带日期的收据**（为什么留着 ＋ 什么时候删）。
// 收据不判"理由好不好"（那要人读），它判"有没有人会想起来它"。
//
// ⚠️ 边界（写清楚，免得被当成比它更大的东西）：
//   · 只管 Rust 侧的 `dead_code`。`#[allow(unused)]` / `unused_imports` 之类不在内 ——
//     那些是编译器每一次都会吵的，不需要收据。
//   · **不判**豁免的理由是否成立，也**不判**那段代码该不该留。它只保证"有人签过字"。
//   · 命中必须**在代码里**（用 `lib/rust-scan.mjs::rustRegions` 打掩码）：
//     仓库里有十几处注释**在讲**这件事（"删掉 lib.rs 里那行 `#[allow(dead_code)]`"），
//     拿 grep 数会把它们全算成违规 —— 那正是"空输出与零命中是两件事"那一族的坑。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";
import { rustRegions } from "./lib/rust-scan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 豁免扫描的文件（机器产物）：**不是"这些豁免可以有理由不说"，是"它们不是手写的"**。
 * 手改生成物会被 `check-capabilities` 判红，所以要求"给生成物里的每一行补日期"没有意义；
 * 这里只把它**显式列出来**（门禁每次都打印），而不是假装没看见。
 */
export const EXEMPT = new Map([
  [
    "src-tauri/src/capabilities_gen.rs",
    "生成物（`scripts/gen-capabilities.mjs` 写出）：豁免由生成器统一决定，手改会被 check-capabilities 判红",
  ],
]);

/** 收据的日期形态：`YYYY-MM-DD`。刻意只认这一种（"上周"、"最近"都不是收据）。 */
export const RECEIPT_DATE = /\b20\d\d-\d\d-\d\d\b/;

/** 一份 Rust 文本里的所有行（含起始偏移），供"往上找收据"用。 */
function linesWithOffset(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      out.push({ start, text: text.slice(start, i) });
      start = i + 1;
    }
  }
  return out;
}

/**
 * 找出**代码里**（不是注释里）每一处 `allow(dead_code)`。返回 `[{ index, line, col, attrLine }]`。
 * `line` / `col` 都是 1 起（与人看到的行号一致）。
 */
export function findAllowDeadCode(text) {
  const M = rustRegions(text);
  const hits = [];
  const re = /allow\(\s*dead_code\b/g;
  for (let m; (m = re.exec(text)); ) {
    if (M[m.index] !== 0) continue; // 注释 / 字符串里的假命中
    const before = text.slice(0, m.index);
    const line = before.split("\n").length;
    const col = m.index - (before.lastIndexOf("\n") + 1) + 1;
    hits.push({ index: m.index, line, col });
  }
  return hits;
}

/**
 * 取"这条属性往上连续的一段收据区"：**跳过紧邻的空行，然后吃掉连续的注释与属性行**。
 *
 * 为什么允许跳过紧邻空行：`#[allow(...)]` 上面常常先空一行（视觉分组），那不该判违规。
 * 为什么碰到**代码行**就停：日期必须长在这条属性旁边 —— 隔着别的函数写一句 2026-01-01 不算收据
 * （这条由 `.test.mjs` 的变异用例钉住）。
 */
export function receiptBlock(text, index) {
  const lines = linesWithOffset(text);
  let i = 0;
  while (i < lines.length && lines[i].start <= index) i++;
  let at = i - 1; // 属性所在行（0 起）
  const M = rustRegions(text);
  const kindOf = (idx) => {
    const ln = lines[idx];
    const trimmed = ln.text.trim();
    if (trimmed.length === 0) return "blank";
    if (/^#!?\[/.test(trimmed)) return "attr";
    // 注释判定要**先去掉缩进**：`///` 前面那几格缩进在掩码里是"代码"（掩码从 `//` 起才标），
    // 拿"整行都在掩码里"去判缩进过的文档注释会全部判否 —— 那正是 2026-09-25 实测踩到的假红
    // （`hlc.rs::observe` 明明写着带日期的收据，门禁却只看到属性那一行）。
    const firstNonSpace = ln.text.indexOf(ln.text.trimStart()[0]);
    const allComment = [...trimmed].every((_, k) => M[ln.start + firstNonSpace + k] !== 0);
    if (allComment) return "comment";
    return "code";
  };
  const picked = [lines[at].text];
  let j = at - 1;
  while (j >= 0 && kindOf(j) === "blank") j--; // 只跳过"紧邻"的空行
  for (; j >= 0; j--) {
    const k = kindOf(j);
    if (k === "comment" || k === "attr") picked.push(lines[j].text);
    else break;
  }
  return picked.reverse().join("\n");
}

/** 这份文本里所有**缺收据**的豁免（`[{ line, col, snippet }]`）。 */
export function offendersOf(text) {
  return findAllowDeadCode(text)
    .filter((h) => !RECEIPT_DATE.test(receiptBlock(text, h.index)))
    .map((h) => ({
      line: h.line,
      col: h.col,
      snippet: text.split("\n")[h.line - 1].trim(),
    }));
}

/** 扫描 `src-tauri/src/` 下全部 `.rs` ＋ `src-tauri/build.rs`。 */
export function collectRustFiles(rootDir = root, out = []) {
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".rs")) out.push(p);
    }
  };
  walk(join(rootDir, "src-tauri", "src"));
  const buildRs = join(rootDir, "src-tauri", "build.rs");
  try {
    if (statSync(buildRs).isFile()) out.push(buildRs);
  } catch {
    /* 没有 build.rs 的 checkout 也能跑（离线夹具） */
  }
  return out.sort();
}

/** 跑一遍：`{ files, occurrences, offenders, exempt }`（`occurrences` 只统计被扫描的文件）。 */
export function check(rootDir = root) {
  const files = collectRustFiles(rootDir);
  const occurrences = [];
  const offenders = [];
  const exempt = [];
  for (const f of files) {
    const rel = relative(rootDir, f).replace(/\\/g, "/");
    const text = readFileSync(f, "utf8");
    const hits = findAllowDeadCode(text);
    if (!hits.length) continue;
    if (EXEMPT.has(rel)) {
      exempt.push({ file: rel, count: hits.length });
      continue;
    }
    for (const h of hits) occurrences.push({ file: rel, line: h.line });
    for (const o of offendersOf(text)) offenders.push({ file: rel, ...o });
  }
  return { files, occurrences, offenders, exempt };
}

if (isMain(import.meta.url)) {
  const { files, occurrences, offenders, exempt } = check();
  if (offenders.length) {
    console.error("`#[allow(dead_code)]` 必须带一条**带日期的收据**（为什么留着 ＋ 什么时候删）：");
    for (const o of offenders) {
      console.error(`  - ${o.file}:${o.line}:${o.col}  ${o.snippet}`);
    }
    console.error("  修法三选一（按优先级）：");
    console.error("    ① 那段代码真的死了 ⇒ 删掉它；");
    console.error("    ② 只有判据 / 仿真夹具在用 ⇒ 门进 `#[cfg(test)]`（产品二进制里根本不存在，比豁免诚实）；");
    console.error("    ③ 确实要留 ⇒ 在上面写一句 `// ★ YYYY-MM-DD 收据：为什么留 ＋ 删除条件`。");
    process.exit(1);
  }
  const exemptNote = exempt.length
    ? `（另有 ${exempt.reduce((n, e) => n + e.count, 0)} 处豁免在生成物里，未计：${exempt
        .map((e) => e.file)
        .join(", ")}）`
    : "";
  console.log(
    `死代码收据齐备：扫了 ${files.length} 个 .rs，${occurrences.length} 处 \`allow(dead_code)\`，全部带日期收据${exemptNote}`,
  );
}
