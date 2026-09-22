#!/usr/bin/env node
// 常开门禁：**共享 registry 上没留国密补丁**（`sm-library` 构建除外）。
//
// 为什么值得单独一条门禁（方案 §五 那一行，归属 AMD，2026-09-22）：
// 补丁打在**全机共享**的 cargo registry 源码上，而 `sm-library-build.mjs` **刻意不自动还原**
// ⇒ "跑过一次国密构建、忘了 `--revert`"会把这台机器留在看不见的状态里：macOS 上后续**默认**构建
// 红 12＋7 条且**现场不像补丁问题**（像加密库坏了）；Linux/Windows 上不红、但后续默认构建被**静默**
// 改成写 SM4 页。原先唯一的防线是横幅 ＋ 人的纪律 —— 这条把纪律变成断言。
//
// ## 三档（判定都在 `lib/sm-library-hygiene.mjs`，纯函数、有判据）
//   · **ok**     —— 原版；或"源码带补丁 ∧ 这次就是 `sm-library` 构建"（那正是要的状态）；
//   · **notice** —— 带补丁 ＋ 本平台不红（非 darwin）⇒ **不判红**，但把"默认构建会被悄悄改掉"说清；
//   · **block**  —— 带补丁 ＋ macOS 默认构建 ⇒ **exit 1**，并给出那一行修法。
//
// ## ⚠️ 两条边界（都是踩过才写下的）
//   1. **本命令只读**（绝不写盘、绝不打补丁）：`sm-library-build.mjs --print-source-sha256` /
//      `--require-static` / `--print-env` 都会**先打补丁**再干活 —— 想"核一下状态"却把源码改成
//      打过补丁的样子（2026-09-22 AMD 实测）。要读状态就用这条。
//   2. **"读不出来"不是"不干净"**：没跑过 cargo（registry 空）、拿不到 `Cargo.lock` 等 ⇒ 只提示、**不判红**
//      （与 `check-crypto-backend` 的"旧产物 ⇒ 未实查"同一条口径 —— 判红就等于逼人在干净机器上也红）。
//
// 用法：
//   node scripts/check-gm-registry-clean.mjs                  # 门禁用法（默认：这次不是 sm-library 构建）
//   node scripts/check-gm-registry-clean.mjs --feature-sm-library   # 核对"我刚跑完国密构建"这个语境 ⇒ 带补丁也算 ok
//   node scripts/check-gm-registry-clean.mjs --platform=darwin      # 在别的平台上判"若是 macOS 会怎样"（给判据/复现用）
//   node scripts/check-gm-registry-clean.mjs --json
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hygieneVerdict, registryStateOf } from "./lib/sm-library-hygiene.mjs";
import { isMain } from "./lib/is-main.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = join(root, "src-tauri", "Cargo.lock");

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);

/** 纯函数：取 `--k v` 或 `--k=v` 的值。★ 只认前一种写法时，`--platform=darwin` 会被**静默忽略**
 *  （2026-09-22 实测：输出看起来一切正常，而"按 macOS 判"这件事根本没发生）—— 正是本仓最防的假绿。 */
export function argValueIn(args, name) {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1] || "";
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : "";
}

/** node 的平台名（`--platform` 只该取这些值）。 */
export const KNOWN_PLATFORMS = ["darwin", "linux", "win32", "android", "freebsd", "openbsd", "sunos", "aix"];

/**
 * 纯函数：解析 `--platform`。**拼错不静默降级** —— 否则 `--platform=dawrin` 会被当成"非 darwin"，
 * 于是本该 `block` 的场景安静地变成 `notice`（这个门禁存在的全部意义就是不让状态被静静忽略）。
 * @returns `{ platform, error }`（`error` 非空 ⇒ 调用方应当**响亮退出**，不要继续判）
 */
export function platformFromArgv(args, fallback = process.platform) {
  const raw = argValueIn(args, "--platform");
  if (!raw) return { platform: fallback, error: null };
  if (!KNOWN_PLATFORMS.includes(raw)) {
    return { platform: raw, error: `--platform=${raw} 不是 node 的平台名（认得：${KNOWN_PLATFORMS.join(" / ")}）` };
  }
  return { platform: raw, error: null };
}

/**
 * 纯函数：把一次"读到的状态 ＋ 这次是什么语境"翻成**退出码与要说的话**（便于判据，不碰磁盘）。
 * @returns `{ code: 0|1, level, lines: string[] }`
 */
export function decideFromState(state, { platform = process.platform, featureSmLibrary = false } = {}) {
  if (!state.ok) {
    // 读不出来 ⇒ **不判红**（干净机器 / 还没 fetch 过 registry 都会走到这里）
    return {
      code: 0,
      level: "notice",
      lines: [
        `gm-registry-clean: 未实查（${state.reason}）—— 读不到共享 registry 的 SQLCipher 源码，这一格不判红`,
        `  · ${state.message}`,
        "  · 真核对要在**跑过 cargo** 的机器上：那时源码已在 registry 里",
      ],
    };
  }
  const { level, why } = hygieneVerdict({ patched: state.patched, pageCipher: state.pageCipher, platform, featureSmLibrary });
  const head = `gm-registry-clean: libsqlite3-sys ${state.version} @ ${state.srcDir}`;
  const mark = `  补丁标记 = ${state.patched ? "有（源码已被改成国密版）" : "无（原版）"} · page_cipher = ${state.pageCipher}`;
  if (level === "ok") return { code: 0, level, lines: [`${head}`, mark, `  ✅ ${why}`] };
  const badge = level === "block" ? "❌" : "⚠️";
  return { code: level === "block" ? 1 : 0, level, lines: [`${head}`, mark, `  ${badge} ${why}`] };
}

function main() {
  if (!existsSync(LOCK)) {
    console.log(`gm-registry-clean: 未实查（没有 ${LOCK}）—— 这一格不判红`);
    process.exit(0);
  }
  const { platform, error } = platformFromArgv(argv);
  if (error) {
    // 响亮退出：拼错平台名**不许**被当成"非 darwin"静默降级
    console.error(`gm-registry-clean: ${error}`);
    process.exit(2);
  }
  const featureSmLibrary = has("--feature-sm-library");
  const state = registryStateOf({ lockPath: LOCK });
  const r = decideFromState(state, { platform, featureSmLibrary });

  if (has("--json")) {
    console.log(JSON.stringify({ ...r, platform, featureSmLibrary, state: { ...state } }, null, 2));
  } else {
    for (const line of r.lines) console.log(line);
    if (r.level === "notice" && state.ok) {
      console.log("  · 本平台不会红 ⇒ 这条门禁不拦你；但**别的平台/别的项目**可能是那 12＋7 条红的那一方。");
    }
  }
  process.exit(r.code);
}

if (isMain(import.meta.url)) main();
