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
//   node scripts/sm-library-build.mjs --print-source-sha256                  # 只打印"将要编译的那份源码"的哈希
//   node scripts/sm-library-build.mjs --revert                                # 把补丁从**全机共享的** registry 源码上撤回
//   node scripts/sm-library-build.mjs ... --no-apply                          # 不打补丁（**读数会标成 patch=absent**）
//
// 补丁（`patches/0001-sqlcipher-sm3-provider.patch`）由本脚本**幂等地**应用到 cargo 将要编译的那份源码上，
// 且**在算 `--print-source-sha256` 之前**：build.rs 记进产物标记的哈希，必须是"已打补丁那份"的哈希。
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
import { ensurePatch, patchFileOf, revertPatch } from "./lib/sm-library-patch.mjs";
const PRINT_SHA = argv.includes("--print-source-sha256");
const NO_APPLY = argv.includes("--no-apply");

// ---- 0) 定位源码（**只定位一次**，后面补丁/哈希/标记扫描都用这一个 srcDir）----
let pick;
try {
  pick = resolveSqlcipherSource({ lockPath: LOCK });
} catch (e) {
  fail(e.message);
}
const srcDir = pick.dir;
console.log(`sm-library-build: 源码 = ${srcDir}（libsqlite3-sys ${pick.version}，via=${pick.via}）`);

// ---- 0.4) `--revert`：把这份**全机共享的** registry 源码撤回原版（mac 2026-09-20 提的第 2 条修法）----
// 为什么要能撤：那份源码是 cargo registry 里全机共享的一份 —— 补丁留在那儿，同机其它构建
// （不开 `sm-library`、不给 `OPENSSL_DIR` 的默认构建）编译的也是打过补丁的源码。能力门修好之后那是
// **行为中性**的，但"一键回到原版"仍是做 A/B（以及判"这条红是不是补丁引起的"）的前提。
// ⚠️ 与 `--print-source-sha256` 一样**不需要后端**（撤回与编不编得起来无关）。
if (has("--revert")) {
  let r;
  try {
    r = revertPatch(srcDir, patchFileOf(root));
  } catch (e) {
    fail(e.message);
  }
  const hits = (readFileSync(join(srcDir, "sqlite3.c"), "utf8").match(/SM3/g) || []).length;
  console.log(
    `sm-library-build: 撤回 = ${r.status}${r.tool ? `（工具=${r.tool}）` : ""}；` +
      `撤回后源码里 SM3 命中 = ${hits}${r.status === "reverted" ? "（原版应当是 0）" : "（本来就没打）"}`,
  );
  process.exit(0);
}

// ---- 0.5) 补丁：幂等地把目录带到"该有的样子"，并**如实报出是哪一种状态** ----
// 三种状态与三种误读（都踩过）：
//   already（源码里已有标记）⇒ 不重复打；再打一次 `git apply` 会失败，那不是错误而是重复动作；
//   applied ⇒ 打上了，且 `ensurePatch` 内部**复扫过标记**（退出码 0 ≠ 文件里有那行）；
//   absent（--no-apply）⇒ **不是错误**，但下面的读数必须被读成"未打补丁的源码"。
let patchState;
try {
  patchState = ensurePatch(srcDir, patchFileOf(root), { apply: !NO_APPLY });
} catch (e) {
  fail(e.message);
}
const PATCH_NOTE = {
  already: "already（源码里已有标记 ⇒ 不重复打）",
  applied: `applied（本次打上，工具=${patchState.tool}）`,
  absent: "absent（**没打**：--no-apply ⇒ 下面的读数都属于**未打补丁**的源码）",
}[patchState.status];
console.log(`sm-library-build: 补丁 = ${PATCH_NOTE}`);

// ---- 0.6) `--print-source-sha256`：给"另一侧"（macOS 的门禁）用 ----
// 输出：<sha256> <path> <version> via=<...> patch=<already|applied|absent>
// ⚠️ 必须在**补丁之后**算：build.rs 记进产物标记的哈希 = "将要编译的那份（＝已打补丁的）源码"的哈希，
//    两边要能对上就得在同一状态上取。`patch=` 那格是给"读到过期标记"时用的：
//    哈希对不上时先看这格是不是 absent（那是**假红**，不是补丁过期）。
if (PRINT_SHA) {
  const file = markerFileOf(srcDir) ?? join(srcDir, "sqlite3.c");
  if (!existsSync(file)) {
    console.error(`sm-library-build: 找不到可哈希的文件：${file}`);
    process.exit(1);
  }
  console.log(`${sha256OfFile(file)} ${file} ${pick.version} via=${pick.via} patch=${patchState.status}`);
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

// 标记扫描与上面 `markerFileOf()` 同序（单一实现的又一处：CLI 的 --print-source-sha256 与这里共用它）
const markerPath = markerFileOf(srcDir);
const markerHit = markerPath ? basename(markerPath) : null;

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
// ⚠️ 第二条 clean 是为了**读数可信**，不是洁癖：本 crate 的构建脚本不重跑时，cargo 会把**上一次的
//    `cargo:warning`**（也就是"补丁已应用"那一行，含旧 `src_sha256`）从缓存里**重放**出来 ——
//    于是一份没打补丁的构建也会打出"补丁已应用"。要拿构建期那一格的可信读数，先清本 crate 的脚本产物。
const cleanSelfCmd = ["cargo", ["clean", "-p", "shuyonote", "--manifest-path", manifest]];
const buildCmd = ["cargo", ["build", "--features", "sm-library", "--manifest-path", manifest]];
if (has("--print")) {
  console.log(`  ${cleanCmd[0]} ${cleanCmd[1].join(" ")}`);
  console.log(`  ${cleanSelfCmd[0]} ${cleanSelfCmd[1].join(" ")}`);
  console.log(`  OPENSSL_DIR=${opensslDir} ${buildCmd[0]} ${buildCmd[1].join(" ")}`);
  process.exit(0);
}
if (has("--check")) {
  console.log(`sm-library-build: --check 通过（环境与补丁都满足，未构建；补丁状态=${patchState.status}）`);
  process.exit(0);
}

for (const [cmd, args, label] of [
  [cleanCmd[0], cleanCmd[1], "① 清掉 libsqlite3-sys 的产物（否则改了后端/补丁也不会重编）"],
  [cleanSelfCmd[0], cleanSelfCmd[1], "①.5 清掉本 crate 的构建脚本产物（否则 cargo **重放**上一次的 cargo:warning）"],
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
