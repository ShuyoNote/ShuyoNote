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
import { isMain } from "./lib/is-main.mjs";

/** 本机所在时区的 IANA 名（拿不到 ⇒ 退回 `"UTC"`，⛔ 不抛 ✗）。 */
export function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * 一个时刻在**给定时区**里的日期戳（`YYYY-MM-DD`）。
 *
 * ⚠️ ⭐ **为什么不再用 `toISOString().slice(0, 10)`** ✗（2026-10-12 改）：
 *   那取的是 **UTC 日** ⇒ ⭐ **CST（UTC+8）00:00–07:59 之间发版会把段头写成「前一天」** ✗。
 *   ⚠️ 它**在 CI 上会假绿**（runner 是 UTC，两边同日 ✓）、本机傍晚发版也**是运气**（CST 16:00 后才是同日 ✓）
 *   ⇒ 判据必须用「**固定时刻 ＋ 点名时区**」：`scripts/update-changelog.test.mjs` ✓。
 * ⚠️ **向后兼容**：只影响**新生成**的段头 ✓；⛔ 已有历史段一个字都不动 ✗。
 */
export function dateStampInZone(date, timeZone) {
  // `en-CA` 的短日期形状就是 `YYYY-MM-DD` ✓（与段头要的形状一致 ✓）
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** 新段头写的日期 ＝ **本机本地日**（⛔ 不是 UTC 日 ✗）。 */
export function todayStamp(now = new Date()) {
  return dateStampInZone(now, localTimeZone());
}

// ⭐ 判据要 `import` 上面那几个纯函数 ⇒ ⛔ 被 import 时**绝不执行**脚本体 ✗
//   （`scripts/lib/is-main.mjs` 是本仓唯一那处实现：**两边 realpath 后再比**，符号链接下也判得准 ✓）
const IS_MAIN = isMain(import.meta.url);

function main() {
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

  const today = todayStamp();
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
}

if (IS_MAIN) main();
