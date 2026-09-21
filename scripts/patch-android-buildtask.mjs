// 修 `tauri android init` 生成的那份 Gradle `BuildTask.kt`：把 "node tauri …" 改成
// "node <cli.js> …"（**显式路径**）。
//
// 为什么需要（2026-09-21，本机实测）：
//   init 会把"用哪个可执行文件 + 什么参数去调 Tauri CLI"**烘进**生成的 Kotlin 里。
//   本机那份写成：
//       val executable = """node""";
//       val args = listOf("tauri", "android", "android-studio-script");   // ← node 把 "tauri" 当模块名找
//   ⇒ Gradle 到 `:app:rustBuildArm64Release` 这一步直接炸：
//       Error: Cannot find module 'C:\…\ShuyoNote-androidfix\src-tauri\tauri'
//       Execution failed for task ':app:rustBuildArm64Release'
//   （在 DSH 会话里初次 init 时甚至把 harness 自带那份 node 的绝对路径烘进去了，跨机器必挂。）
//   CI 的 Android job 没这个问题，所以**不要**把它接进 CI 流程；它是"本机 init 之后补一刀"的脚本。
//
// 用法：node scripts/patch-android-buildtask.mjs [--check]
// 退出码：0 = 已修好/本来就对；1 = 没修成；2 = **没验**（没 init 过，gen/ 里没有那个文件）
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 生成物里那条 args 的固定写法（模板原文）。 */
export const TEMPLATE_ARGS_LINE = 'val args = listOf("tauri", "android", "android-studio-script");';

export function buildTaskPath(repoRoot = root) {
  return join(
    repoRoot,
    "src-tauri",
    "gen",
    "android",
    "buildSrc",
    "src",
    "main",
    "java",
    "cn",
    "shuyo",
    "shuyonote",
    "kotlin",
    "BuildTask.kt",
  );
}

export function patchAndroidBuildTask({ root: repoRoot = root, check = false, log = console.log, err = console.error } = {}) {
  const file = buildTaskPath(repoRoot);
  if (!existsSync(file)) {
    err(`✗ 没验：找不到 ${file}`);
    err("  ⇒ 先跑 `pnpm tauri android init --ci`（该文件是 init 生成的，不入库）。");
    return 2;
  }
  const cliJs = join(repoRoot, "node_modules", "@tauri-apps", "cli", "tauri.js").split("\\").join("/");
  const fixedLine = `val args = listOf("${cliJs}", "android", "android-studio-script");`;

  let text = readFileSync(file, "utf8");
  const alreadyFixed = text.includes(`listOf("${cliJs}"`);
  if (alreadyFixed) {
    log("✓ 已经是显式 CLI 路径（无需改动）");
    return 0;
  }
  if (!text.includes(TEMPLATE_ARGS_LINE)) {
    err(`✗ 没认出模板那条 args（既不是已修好的，也不是已知的模板原文）—— 打开看一眼：${file}`);
    err(`   期望模板原文：${TEMPLATE_ARGS_LINE}`);
    return 1;
  }
  if (check) {
    err(`✗ 还没修：${file} 里仍是 \`node tauri …\`（Gradle 会在 :app:rustBuild*Release 崩）`);
    err("  ⇒ 跑 `node scripts/patch-android-buildtask.mjs`");
    return 1;
  }
  text = text.replace(TEMPLATE_ARGS_LINE, fixedLine);
  writeFileSync(file, text, "utf8");
  log(`✓ 已把 BuildTask.kt 的 CLI 调用改成显式路径：${cliJs}`);
  return 0;
}

if (isMain(import.meta.url)) {
  process.exit(patchAndroidBuildTask({ check: process.argv.slice(2).includes("--check") }));
}
