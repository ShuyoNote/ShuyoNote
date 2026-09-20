// `patches/0001-sqlcipher-sm3-provider.patch` 的**应用胶水**（纯函数 + 一个真实副作用函数）。
//
// 为什么要单独一个模块：这条路上有**三种状态**，而它们的正确读法完全不同 ——
//   ① `already`：源码里已经有标记（上一次打过）⇒ **不重复打**（`git apply` 会失败，那才是真错）；
//   ② `applied`：这次打上了 ⇒ 必须**复扫标记**确认真的生效（"命令退出码 0" ≠ "文件里有那行"）；
//   ③ `absent`：没有标记也没打（`--no-apply`）⇒ **不是错误**，但必须如实报出来，
//      调用方据此把 `--print-source-sha256` 的读数标成"这份哈希对应**未打补丁**的源码"。
//
// ⚠️ 与判据的分工：本模块只负责"把文件变成该有的样子 + 说清是哪一种"；
//   "该不该有标记"由 `src-tauri/build.rs`（构建期）与 `scripts/check-crypto-backend.mjs`（门禁）判。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PATCH_BASENAME = "0001-sqlcipher-sm3-provider.patch";
export const PATCH_MARKER = "SQLCIPHER_HMAC_SM3_LABEL";

export function patchFileOf(repoRoot) {
  return join(repoRoot, "patches", PATCH_BASENAME);
}

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * 把 `dir`（SQLCipher 源码目录，里面有 `sqlite3.c`）带到"补丁已打"的状态。
 *
 * @returns {{status:"already"|"applied"|"absent", file:string, tool:string|null, bytes:number}}
 * @throws 当 `apply` 为真、补丁文件在、`--check` 通过，但**打完仍扫不到标记**时（说明应用得不完整）。
 */
export function ensurePatch(dir, patchFile, { apply = true } = {}) {
  const file = join(dir, "sqlite3.c");
  if (!existsSync(file)) throw new Error(`ensurePatch: 找不到 ${file}`);
  const before = readFileSync(file, "utf8");
  if (before.includes(PATCH_MARKER)) {
    return { status: "already", file, tool: null, bytes: before.length };
  }
  if (!apply) return { status: "absent", file, tool: null, bytes: before.length };
  if (!existsSync(patchFile)) {
    throw new Error(`ensurePatch: 找不到补丁文件 ${patchFile}`);
  }

  // 先 `--check`：失败要报得具体（多半是源码不是"原始那份"，或 SQLCipher 版本变了）
  let checkErr = null;
  try {
    run("git", ["apply", "--check", "-p1", patchFile], dir);
  } catch (e) {
    checkErr = e;
  }
  if (checkErr) {
    throw new Error(
      `ensurePatch: 补丁**打不上**（git apply --check 失败）⇒ 源码可能不是本补丁对应的那一份。\n` +
        `  补丁：${patchFile}\n  源码：${file}\n  git 说：${String(checkErr.stderr || checkErr.message).trim().split("\n")[0]}`,
    );
  }

  let tool = null;
  try {
    run("git", ["apply", "-p1", patchFile], dir);
    tool = "git apply -p1";
  } catch (e1) {
    try {
      run("patch", ["-p1", "-i", patchFile], dir);
      tool = "patch -p1";
    } catch (e2) {
      throw new Error(
        `ensurePatch: 补丁应用失败（git apply 与 patch 都失败）。\n` +
          `  git：${String(e1.stderr || e1.message).trim().split("\n")[0]}\n` +
          `  patch：${String(e2.stderr || e2.message).trim().split("\n")[0]}`,
      );
    }
  }

  const after = readFileSync(file, "utf8");
  if (!after.includes(PATCH_MARKER)) {
    throw new Error(
      `ensurePatch: ${tool} 退出码是 0，但打完**文件里仍然没有** ${PATCH_MARKER} ⇒ 不接受这次应用（"命令成功"≠"改到了"）。`,
    );
  }
  return { status: "applied", file, tool, bytes: after.length };
}
