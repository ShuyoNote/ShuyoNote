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

// 首个 `## [` 版本段的起始位置（顶部为最新版本）。
const m = content.match(/^## \[/m);
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

// 插入到现有最顶段之前，保留全部旧段（不再覆盖任何段头）。
content = content.slice(0, pos) + seg + content.slice(pos);
fs.writeFileSync(changelog, content, "utf8");

console.log(`已插入 ## [${version}] 段到 CHANGELOG 顶部之前（保留全部旧段）。`);
