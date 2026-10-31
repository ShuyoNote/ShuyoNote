#!/usr/bin/env node
// gen-css-tokens.mjs —— 从 `src/styles/tokens.json` 生成 `src/styles/tokens.css` ＋ `tokens.d.ts`。
//
// 为什么要有生成器（S3，2026-10-31）：App.css 里 1,100+ 处 `font-size: Npx` 是"手抄的刻度"，
// 改一次字号要全仓搜；而且「设计稿写的 13px」与「代码里的 13px」没有单一出处。
// 现在刻度只写一处（tokens.json），CSS/TS 两边的 token 名由同一份数据生成。
//
// 口径：
//   · 只收**数值已存在**的刻度 ⇒ 替换成 `var(--fs-N)` 不会改变任何计算值（S3 的硬要求）。
//   · 半像素值**先不收**（owner 2026-10-31：11.5/12.5/10.5 等留到有稳定视觉基线再议）。
//   · `--space-1..8` 已存在（4/8/12/16/24/32/40/64），**不是**计划草稿里的 2/4/6/8/10/12/16/24 ⇒ 不重定义（会改所有用点）；将来要动单独一批。
//
// 用法：node scripts/gen-css-tokens.mjs
// 产物是 `@layer legacy` 里的 `:root` 定义（与 S2 的层序一致；custom property 在层里照常生效）。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = "src/styles/tokens.json";
const OUT_CSS = "src/styles/tokens.css";
const OUT_DTS = "src/styles/tokens.d.ts";

const HEADER = "本文件由 scripts/gen-css-tokens.mjs 从 src/styles/tokens.json 生成 —— 请勿手改。";

export function loadTokens() {
  return JSON.parse(readFileSync(resolve(ROOT, SRC), "utf8"));
}

/** 稳定顺序：按数值大小排（生成物逐字节可复现）。 */
function sortedEntries(map) {
  return Object.entries(map).sort((a, b) => Number.parseFloat(a[1]) - Number.parseFloat(b[1]));
}

export function renderCss(tokens = loadTokens()) {
  const lines = [];
  lines.push(`/* ${HEADER} */`);
  lines.push(`/* 源：${SRC}（字号刻度；半像素值按 owner 拍板暂不纳入） */`);
  lines.push("");
  lines.push("@layer legacy {");
  lines.push(":root {");
  for (const [key, value] of sortedEntries(tokens.fontSize ?? {})) {
    lines.push(`  --fs-${key}: ${value};`);
  }
  lines.push("}");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

export function renderDts(tokens = loadTokens()) {
  const keys = sortedEntries(tokens.fontSize ?? {}).map(([key]) => `--fs-${key}`);
  const union = keys.map((k) => `  | "${k}"`).join("\n");
  return `/* ${HEADER} */\n\n/** 生成的 CSS token 名（tokens.css 的镜像；TS 侧只做形状提示，不做运行时校验）。 */\nexport type CssFontSizeToken =\n${union};\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tokens = loadTokens();
  writeFileSync(resolve(ROOT, OUT_CSS), renderCss(tokens));
  writeFileSync(resolve(ROOT, OUT_DTS), renderDts(tokens));
  console.log(`✓ ${OUT_CSS} ／ ${OUT_DTS}（字号 ${Object.keys(tokens.fontSize ?? {}).length} 档）`);
}
