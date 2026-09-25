// 「库级国密构建」的**步骤计划**（纯函数，便于判据 —— CLI 本身不是模块，import 它会执行主体）。
//
// ★ 为什么要有这个文件（2026-09-22 一次真实事故）：
//   `--prepare` 里我原本只写 `cargo clean -p libsqlite3-sys`（**不带 `--release`**），
//   而发版链跑的是 `tauri build`（release）⇒ **release profile 的旧产物活了下来**。
//   又因为 `libsqlite3-sys` 的 build.rs **没有**为 `OPENSSL_DIR` 声明 `rerun-if-env-changed`
//   （docs/development.md 工具坑第 5 条），cargo 认为它"还是新鲜的" ⇒ **不重编** ⇒
//   那一份 CommonCrypto 的 SQLCipher 被原样链进 release 产物。
//   于是"按发版链构建出来的包"表面全对（补丁标记 `page_cipher=sm4` 也在），而**库级根本不是国密**。
//   ⇒ 我在本机把发版链的步骤原样跑了一遍，`check-crypto-backend` 那三条断言**当场把它抓住**。
//
//   结论写成计划：**清产物必须覆盖"这次要构建的那个 profile"**，而最省心的做法是两个都清
//   （多一次 `cargo clean -p` 而已，换来的是"永远不会因为一份陈旧产物而发出非国密包"）。

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 需要清的 crate（两个都清：`libsqlite3-sys` 决定 SQLCipher 后端，本 crate 决定 build.rs 标记是否重跑）。 */
export const CLEAN_PACKAGES = ["libsqlite3-sys", "shuyonote"];

/**
 * 纯函数：返回**清产物**的步骤列表。每个包给 dev 与 release 各一条。
 * @returns {{cmd: string, args: string[], label: string}[]}
 */
export function cleanCommands({ manifest }) {
  const steps = [];
  for (const pkg of CLEAN_PACKAGES) {
    for (const [profileFlag, profileName] of [
      [null, "debug"],
      ["--release", "release"],
    ]) {
      steps.push({
        cmd: "cargo",
        args: ["clean", "-p", pkg, ...(profileFlag ? [profileFlag] : []), "--manifest-path", manifest],
        label:
          `清 ${pkg} 的 ${profileName} 产物` +
          (profileName === "release"
            ? "（★ 少了这一条：release 的旧 SQLCipher 会在 `tauri build` 里被**原样复用** ⇒ 发出非国密包）"
            : ""),
      });
    }
  }
  return steps;
}

/**
 * 纯函数：`--prepare` 到底做不做"构建"。
 * 准备模式的用途：CI 里只打补丁 ＋ 清产物，构建交给带 `--features sm-library` 的 `tauri build`，
 * 免得同一份代码编两遍。
 */
export function shouldBuild({ prepare = false } = {}) {
  return !prepare;
}

/**
 * ★ **把 OpenSSL 前缀翻译成两个 crate 都认的环境变量**（2026-09-22，CI 真跑抓出来的）。
 *
 * 起因（CI 日志逐字）：
 * ```text
 * openssl-sys-0.9.117/build/main.rs:539: panicked:
 * OpenSSL libdir at `["/usr/lib64", "/usr/lib"]` does not contain the required files
 * to either statically or dynamically link OpenSSL
 * ```
 * Ubuntu 的开发文件在 **多架构目录**（`/usr/lib/x86_64-linux-gnu/`），而 `openssl-sys` 只看
 * `<OPENSSL_DIR>/lib` 与 `<OPENSSL_DIR>/lib64` ⇒ 单给 `OPENSSL_DIR=/usr` 会**在编译期炸**。
 * `libsqlite3-sys` 则**同时**认 `OPENSSL_LIB_DIR` ＋ `OPENSSL_INCLUDE_DIR` 这一对（它的 build.rs 里那一支）。
 * ⇒ 两个都接受的形态是：`OPENSSL_DIR`（我们的 build.rs 用它做 fail-fast 判断）＋
 *    `OPENSSL_LIB_DIR`（真正含 `libcrypto.{so,a}` 的那个目录）＋ `OPENSSL_INCLUDE_DIR`。
 *
 * 纯函数，便于判据；找不到就返回 null（调用方据此**响亮跳过**，而不是让 cargo 去炸）。
 */
export function opensslEnvFor(prefix, { exists = existsSync, readdir = readdirSync } = {}) {
  if (!prefix) return null;
  const hasCrypto = (names) => names.some((n) => /^libcrypto\.(so|a|dylib|lib)$/i.test(n));
  const inc = join(prefix, "include");
  const includeDir = exists(inc) ? inc : undefined;
  const libDirs = ["lib", "lib64"].map((sub) => join(prefix, sub)).filter((d) => exists(d));
  for (const libDir of libDirs) {
    let names = [];
    try {
      names = readdir(libDir);
    } catch {
      continue;
    }
    if (hasCrypto(names)) return { OPENSSL_DIR: prefix, OPENSSL_LIB_DIR: libDir, OPENSSL_INCLUDE_DIR: includeDir };
    // 多架构：`lib/x86_64-linux-gnu/`
    for (const entry of names) {
      const sub = join(libDir, entry);
      let subNames = null;
      try {
        subNames = exists(sub) ? readdir(sub) : null;
      } catch {
        subNames = null;
      }
      if (subNames && hasCrypto(subNames)) {
        return { OPENSSL_DIR: prefix, OPENSSL_LIB_DIR: sub, OPENSSL_INCLUDE_DIR: includeDir };
      }
    }
  }
  return null;
}

/** 纯函数：把 env 对象渲染成 `KEY=value` 行（给 CI 写进 `$GITHUB_ENV`；不打印 undefined）。 */
export function envFileLines(env) {
  return Object.entries(env || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/**
 * `--print-env` 的 stdout **只许**有 `KEY=value` 行 —— 它的下游是 CI 的 `>> "$GITHUB_ENV"`。
 *
 * 来历（2026-09-25，真 CI，run 36096199288 的 step 23）：两条 android job 把 `--print-env` 的
 * stdout **整体**重定向进 `$GITHUB_ENV`，而 CLI 那时把「源码 = …」「隔离 ✓ 补丁打在私有副本 …」
 * 这些**给人看的行**也打在 stdout ⇒ runner 报
 *   `Invalid format 'sm-library-build: 隔离 ✓ 补丁打在私有副本 /home/runner/…'`
 *   `Unable to process file command 'env' successfully.`
 * ⇒ **交接这一步自己红**，紧随其后的 `Build APK` 被 skip。现场看着像"补丁没打完"，
 *   其实是"这一步的 stdout 不干净" —— 与 2026-09-12 那次"非法 YAML ⇒ 0 个 job"同一类：
 *   **把人的可读输出喂给机器**。
 *
 * ⇒ 守卫而不是纪律：`console.log` 最终走 `process.stdout.write`，所以把 stdout 换成
 *   `write()`（默认改道 stderr）即可 —— 后人再加一行日志会**自动**落到 stderr，不会再捅回来；
 *   真正的数据行必须显式走 `emit()`。
 *
 * @param {{ stdout: { write: Function }, stderr: { write: Function } }} streams 两个可写流（测试里给假流）
 * @returns {{ write: Function, emit: (text: string) => void }}
 */
export function installEnvStdoutGuard({ stdout, stderr }) {
  let allow = false;
  return {
    write: (chunk, ...rest) => (allow ? stdout.write(chunk, ...rest) : stderr.write(chunk, ...rest)),
    emit(text) {
      allow = true;
      try {
        stdout.write(text);
      } finally {
        allow = false;
      }
    },
  };
}

