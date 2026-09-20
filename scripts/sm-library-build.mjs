#!/usr/bin/env node
// 库级国密（`sm-library`）的**构建胶水**：把"改了补丁不重编"这个坑固化掉。
//
// 为什么要有它（两个实测过的坑，见 patches/README.md）：
//   ① `libsqlite3-sys` 的 build.rs **没有**为 `OPENSSL_DIR` 声明 `rerun-if-env-changed` ⇒
//      只设环境变量时 cargo 认为环境没变、构建脚本不重跑 ⇒ **后端悄悄保持原样**（macOS 侧实测）；
//   ② `patches/` 里的补丁文件**不被任何 rerun-if-changed 覆盖** ⇒ 改了补丁也不重编。
//   ⇒ 这一条胶水固定做两件：**先 `cargo clean -p libsqlite3-sys`**，再带着环境变量构建。
//
// 用法：
//   node scripts/sm-library-build.mjs --openssl-dir <Tongsuo 前缀>            # 构建（默认 cargo build）
//   node scripts/sm-library-build.mjs --openssl-dir <p> --check              # 只做构建前的核对，不构建
//   node scripts/sm-library-build.mjs --openssl-dir <p> --print              # 只打印将要执行的命令
//
// 退出码：0 = 成功（或 --print/--check 通过）；1 = 环境不满足；其它 = cargo 的退出码。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] || "" : "";
};
const has = (name) => argv.includes(name);

// ⚠️ 不要用 `import.meta.dirname`（Node ≥ 20.11 才有）：本仓要在 CI/旧 Node 上跑，
//    在 Node 18 上它是 `undefined` ⇒ `resolve(undefined, "..")` 直接抛
//    `ERR_INVALID_ARG_TYPE: The "paths[0]" argument must be of type string`（2026-09-19 在 WSL 的 Node 18 上实测到）。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = join(root, "src-tauri", "Cargo.toml");
const opensslDir = argValue("--openssl-dir") || process.env.OPENSSL_DIR || "";

function fail(msg) {
  console.error(`sm-library-build: ❌ ${msg}`);
  process.exit(1);
}

// 锁文件路径（**显式传进库** —— 库不猜仓库在哪，便于单测与复用）
const LOCK = join(root, "src-tauri", "Cargo.lock");

// ---- 2) 补丁核对：**看将要编译的那份源码**，不是看环境变量 ----
//
// ★ 版本取法（2026-09-19 macOS 侧受控实验证明第一版错了）：
//   旧版按「registry 里 mtime 最新的那个版本」挑 —— 他那台机器上 **0.30.1 的 mtime 比 0.38.2 新**
//   （陈旧副本），于是补丁正确打在 0.38.2 上时报"没有标记"（假阴性），
//   而**只往 0.30.1 注入标记**也能让构建打出"补丁已应用"（假阳性）。
//   ⇒ 现在只认 `src-tauri/Cargo.lock` 里锁的那个版本；拿不到就**当场失败**，绝不退而求其次。
//   （与 Rust 侧同一份规则，实现分别在 `src/gm_patch_probe.rs` 与本文件 —— 两侧都由判据守着。）
//
// ★ 解析逻辑**不在这里**：它是 `scripts/lib/sm-library-source.mjs`（**JS 那份唯一实现**），
//   命令行与外部消费方（macOS 侧的门禁）都 import 它 —— 免得出现"第三份实现各自漂移"。
//   本文件只负责：① 环境核对；② 用库定位源码并扫标记；③ 固定两步命令（clean → build）。
import { MARKER, markerFileOf, resolveSqlcipherSource, sha256OfFile } from "./lib/sm-library-source.mjs";
const PRINT_SHA = argv.includes("--print-source-sha256");
if (PRINT_SHA) {
  // 给"另一侧"（macOS 的门禁）用：<sha256> <path> <version> via=<...>
  // ⚠️ 标记文件**不存在**时（补丁还没打）也照样输出：给的是"当前将要编译的那份源码"的哈希，
  //    这不是错误状态 —— 判"过期标记"要的正是这个值。
  let pick;
  try {
    pick = resolveSqlcipherSource({ lockPath: LOCK });
  } catch (e) {
    console.error(`sm-library-build: ${e.message}`);
    process.exit(1);
  }
  const file = markerFileOf(pick.dir) ?? join(pick.dir, "sqlite3.c");
  if (!existsSync(file)) {
    console.error(`sm-library-build: 找不到可哈希的文件：${file}`);
    process.exit(1);
  }
  console.log(`${sha256OfFile(file)} ${file} ${pick.version} via=${pick.via}`);
  process.exit(0);
}

// ---- 1) 环境核对：没有显式后端就别往下走（与 build.rs 同一条纪律，但在这里先说清）----
// ⚠️ 这段必须在 `--print-source-sha256` **之后**：那条路只回答"当前将要编译的那份源码的哈希"，
//    与后端无关（我第一次把它放在这段之后 ⇒ `--print-source-sha256` 在没给 OPENSSL_DIR 时直接失败，
//    而 macOS 侧的门禁正是在"只想算哈希"的场合调它）。
if (!opensslDir) {
  fail(
    "没有给 `--openssl-dir`（或环境变量 `OPENSSL_DIR`）。\n" +
      "  库级国密**必须显式指定后端**：不给的话 SQLCipher 会落回平台默认（Apple 上是 CommonCrypto，\n" +
      "  而它只有 AES）—— 它会**编得过**，然后安静地没有国密算法。",
  );
}
if (!existsSync(opensslDir)) fail(`--openssl-dir 指向的目录不存在：${opensslDir}`);

let srcDir = null;
try {
  const pick = resolveSqlcipherSource({ lockPath: LOCK });
  srcDir = pick.dir;
} catch (e) {
  fail(e.message);
}

console.log(`sm-library-build: 源码 = ${srcDir}`);

// 标记扫描与上面 `markerFileOf()` 同序（单一实现的又一处：CLI 的 --print-source-sha256 与这里共用它）
const markerPath = markerFileOf(srcDir);
const markerHit = markerPath ? basename(markerPath) : null;

if (!srcDir) {
  fail("找不到 cargo 将要编译的 SQLCipher 源码（registry 里没有 libsqlite3-sys-*/sqlcipher）。");
}
if (!markerHit) {
  fail(
    `将要编译的那份 SQLCipher 源码里**没有** \`${MARKER}\` 标记：\n` +
      `  ${srcDir}\n` +
      "  ⇒ 这个构建不含国密标签（而它不会报错：设了标签回显仍是 HMAC_SHA512，盘上仍是 SHA512 那套）。\n" +
      "  修法：打 patches/0001-sqlcipher-sm3-provider.patch（见 patches/README.md 的三格核对）。",
  );
}
console.log(`sm-library-build: 补丁标记 ✓（${markerHit} @ ${srcDir}，src_sha256=${sha256OfFile(markerPath).slice(0, 12)}…）`);

// ---- 3) 命令（固定两步：先 clean 再 build）----
const env = { ...process.env, OPENSSL_DIR: opensslDir };
const cleanCmd = ["cargo", ["clean", "-p", "libsqlite3-sys", "--manifest-path", manifest]];
const buildCmd = ["cargo", ["build", "--features", "sm-library", "--manifest-path", manifest]];
if (has("--print")) {
  console.log(`  ${cleanCmd[0]} ${cleanCmd[1].join(" ")}`);
  console.log(`  OPENSSL_DIR=${opensslDir} ${buildCmd[0]} ${buildCmd[1].join(" ")}`);
  process.exit(0);
}
if (has("--check")) {
  console.log("sm-library-build: --check 通过（环境与补丁都满足，未构建）");
  process.exit(0);
}

for (const [cmd, args, label] of [
  [cleanCmd[0], cleanCmd[1], "① 清掉 libsqlite3-sys 的产物（否则改了后端/补丁也不会重编）"],
  [buildCmd[0], buildCmd[1], "② 带 OPENSSL_DIR 构建 sm-library"],
]) {
  console.log(`sm-library-build: ${label}`);
  try {
    execFileSync(cmd, args, { cwd: root, env, stdio: "inherit" });
  } catch (e) {
    process.exit(typeof e.status === "number" ? e.status : 1);
  }
}
console.log("sm-library-build: ✅ 完成 —— 事后核对：node scripts/sm-library-build.mjs --check ／ check-crypto-backend ／ cargo test --lib gm_provider::");
