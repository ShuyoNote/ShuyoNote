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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] || "" : "";
};
const has = (name) => argv.includes(name);

const root = resolve(import.meta.dirname, "..");
const manifest = join(root, "src-tauri", "Cargo.toml");
const opensslDir = argValue("--openssl-dir") || process.env.OPENSSL_DIR || "";
const MARKER = "SQLCIPHER_HMAC_SM3_LABEL";

function fail(msg) {
  console.error(`sm-library-build: ❌ ${msg}`);
  process.exit(1);
}

// ---- 1) 环境核对：没有显式后端就别往下走（与 build.rs 同一条纪律，但在这里先说清）----
if (!opensslDir) {
  fail(
    "没有给 `--openssl-dir`（或环境变量 `OPENSSL_DIR`）。\n" +
      "  库级国密**必须显式指定后端**：不给的话 SQLCipher 会落回平台默认（Apple 上是 CommonCrypto，\n" +
      "  而它只有 AES）—— 它会**编得过**，然后安静地没有国密算法。",
  );
}
if (!existsSync(opensslDir)) fail(`--openssl-dir 指向的目录不存在：${opensslDir}`);

// ---- 2) 补丁核对：**看将要编译的那份源码**，不是看环境变量 ----
function sqlcipherSourceDir() {
  if (process.env.SHUYONOTE_SQLCIPHER_SRC_DIR) return process.env.SHUYONOTE_SQLCIPHER_SRC_DIR;
  const vendored = join(root, "src-tauri", "vendor", "sqlcipher");
  if (existsSync(vendored)) return vendored;
  const cargoHome = process.env.CARGO_HOME || join(homedir(), ".cargo");
  const srcRoot = join(cargoHome, "registry", "src");
  if (!existsSync(srcRoot)) return null;
  let best = null;
  for (const reg of readdirSync(srcRoot)) {
    const regDir = join(srcRoot, reg);
    let pkgs = [];
    try {
      pkgs = readdirSync(regDir);
    } catch {
      continue;
    }
    for (const pkg of pkgs) {
      if (!pkg.startsWith("libsqlite3-sys-")) continue;
      const dir = join(regDir, pkg, "sqlcipher");
      if (!existsSync(dir)) continue;
      const m = statSync(dir).mtimeMs;
      if (!best || m > best.m) best = { m, dir };
    }
  }
  return best?.dir ?? null;
}

const srcDir = sqlcipherSourceDir();
let markerHit = null;
if (srcDir && existsSync(srcDir)) {
  for (const f of readdirSync(srcDir)) {
    if (!/\.(c|h)$/.test(f)) continue;
    try {
      if (readFileSync(join(srcDir, f), "utf8").includes(MARKER)) {
        markerHit = f;
        break;
      }
    } catch {
      /* 读不了就跳过 */
    }
  }
}

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
console.log(`sm-library-build: 补丁标记 ✓（${markerHit} @ ${srcDir}）`);

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
