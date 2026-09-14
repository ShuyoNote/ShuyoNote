#!/usr/bin/env node
// 新增一个 CHANGELOG 版本段（在现有最顶版本前插入），并**保留**原有所有段头。
// 用法：node scripts/update-changelog.mjs <version> [简介]
//   例：node scripts/update-changelog.mjs 1.82.8 "同步完善 + 修复"
//
// 教训（曾出过 bug）：直接用前一版本段头做替换锚点会覆盖掉旧段头，导致 CHANGELOG
// 版本「中间断」。此脚本只在首个版本头之前插入新段，原内容一概不动。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = (process.argv[2] || "").replace(/^v/, "");
const title = process.argv[3] || "";
if (!version) {
  console.error("用法: node scripts/update-changelog.mjs <version> [简介]");
  process.exit(1);
}

const changelog = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));
let content = fs.readFileSync(changelog, "utf8");

// 首个 `## [X.Y.Z] 版本段的起始位置（顶部为最新版本）。
// 注意跳过顶部的 `## [Unreleased]`：它是"下一版内容写哪儿"的落点，必须在最上面
// （Keep a Changelog；`scripts/check-changelog.mjs` 会强制这一点）。
// 故这里锚定的是第一个**带数字版本号**的段头，而不是第一个 `## [`。
const m = content.match(/^## \[[0-9]/m);
const pos = m ? m.index : content.length;

const today = new Date().toISOString().slice(0, 10);
const seg =
  `## [${version}] - ${today}\n\n` +
  `> ${title}\n\n` +
  "### 新增\n" +
  "- \n\n" +
  "### 变更\n" +
  "- \n\n" +
  "\n";

// 插入到现有最顶**版本**段之前（若有 `## [Unreleased]` 则插在它下面），保留全部旧段。
content = content.slice(0, pos) + seg + content.slice(pos);
fs.writeFileSync(changelog, content, "utf8");

console.log(`已插入 ## [${version}] 段（在 [Unreleased] 之下、最顶版本段之上；保留全部旧段）。`);
console.log("提醒：小标题请只用 新增 / 变更 / 修复 / 移除 / 安全 / 废弃 / 其它（pnpm check:changelog 会挡）。");
