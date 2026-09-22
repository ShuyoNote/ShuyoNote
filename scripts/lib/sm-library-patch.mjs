// `patches/0001-sqlcipher-sm3-provider.patch` 的**应用胶水**（纯函数 + 两个真实副作用函数）。
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

// ⚠️ **`git apply` 的行尾必须钉死**（2026-09-20，被自己的判据抓到）：Windows 上 `core.autocrlf=true` 时
//    `git apply` 会把**输出**整体改写成 CRLF —— 后果不只是"工作树脏"：
//      ① 同一份源码在 Windows 与 macOS/Linux 上**哈希不同** ⇒ `src_sha256` 的跨机比对（我们特意做的那格）失效；
//      ② 之后 `git apply -R` 的上下文行对不上。
//    `-c core.autocrlf=false` 让"应用/撤回"都是**逐字节**的，三平台一致。
//    （补丁**文件本身**的行尾由仓库 `.gitattributes` 的 `* text=auto eol=lf` 保证 —— 那是另一件事。）
const GIT_APPLY = ["-c", "core.autocrlf=false", "apply"];

/**
 * 把 `dir`（SQLCipher 源码目录，里面有 `sqlite3.c`）带到"补丁已打"的状态。
 *
 * @returns {{status:"already"|"applied"|"absent", file:string, tool:string|null, bytes:number}}
 * @throws 当 `apply` 为真、补丁文件在、`--check` 通过，但**打完仍扫不到标记**时（说明应用得不完整）。
 */
/**
 * ★ 纯函数：**这次调用该不该真的打补丁**（2026-09-22 加，因为它出过一次真事故）。
 *
 * `scripts/sm-library-build.mjs --check` 的帮助文字是「只做构建前的核对，不构建」，但它原先照样
 * `apply: true` ⇒ **一次核对就把补丁打到全机共享的 registry 源码上**：我拿 `--check` 去确认
 * 「源码干不干净」，结果它把源码变成了「打过补丁」的样子 —— 于是「我刚还原过」当场变成假话，
 * 跟着的所有读数都不可信。核对是**只读**动作；要改状态请显式跑构建或 `--revert`。
 *
 * 放在 lib 而不是 CLI 里，是因为那个脚本**不是模块**（import 它就会执行脚本主体并 `process.exit`），
 * 判据没法在单测里 import 它。
 */
export function patchApplyDecision({ noApply = false, checkOnly = false } = {}) {
  return { apply: !noApply && !checkOnly };
}

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
    run("git", [...GIT_APPLY, "--check", "-p1", patchFile], dir);
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
    run("git", [...GIT_APPLY, "-p1", patchFile], dir);
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

/**
 * 把补丁**撤掉**（mac 2026-09-20 提的第 2 条修法：胶水要能撤回）。
 *
 * 为什么值得有：那份源码在 cargo registry 里是**全机共享**的一份 —— 补丁留在那里，同机其它构建
 * （不开 `sm-library`、不给 `OPENSSL_DIR` 的默认构建）编译的也是打过补丁的源码。能力门修好之后
 * 那已是**行为中性**的，但"能一键回到原版"仍然是做 A/B（以及判"这条红是不是补丁引起的"）的前提。
 *
 * @returns {{status:"reverted"|"absent", file:string, tool:string|null, bytes:number}}
 */
export function revertPatch(dir, patchFile) {
  const file = join(dir, "sqlite3.c");
  if (!existsSync(file)) throw new Error(`revertPatch: 找不到 ${file}`);
  const before = readFileSync(file, "utf8");
  if (!before.includes(PATCH_MARKER)) return { status: "absent", file, tool: null, bytes: before.length };
  if (!existsSync(patchFile)) throw new Error(`revertPatch: 找不到补丁文件 ${patchFile}`);

  let tool = null;
  let firstErr = null;
  try {
    run("git", [...GIT_APPLY, "-R", "-p1", patchFile], dir);
    tool = "git apply -R -p1";
  } catch (e1) {
    firstErr = e1;
    try {
      run("patch", ["-R", "-p1", "-i", patchFile], dir);
      tool = "patch -R -p1";
    } catch (e2) {
      throw new Error(
        `revertPatch: 撤回失败（git apply -R 与 patch -R 都失败）。\n` +
          `  git：${String(e1.stderr || e1.message).trim().split("\n")[0]}\n` +
          `  patch：${String(e2.stderr || e2.message).trim().split("\n")[0]}`,
      );
    }
  }

  const after = readFileSync(file, "utf8");
  if (after.includes(PATCH_MARKER)) {
    throw new Error(
      `revertPatch: ${tool} 退出码是 0，但**文件里仍有** ${PATCH_MARKER} ⇒ 不接受这次撤回` +
        `（原始报错：${String(firstErr?.message || "").split("\n")[0]}）。`,
    );
  }
  return { status: "reverted", file, tool, bytes: after.length };
}
