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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
//
// ★ 版本取法（2026-09-19 macOS 侧受控实验证明第一版错了）：
//   旧版按「registry 里 mtime 最新的那个版本」挑 —— 他那台机器上 **0.30.1 的 mtime 比 0.38.2 新**
//   （陈旧副本），于是补丁正确打在 0.38.2 上时报"没有标记"（假阴性），
//   而**只往 0.30.1 注入标记**也能让构建打出"补丁已应用"（假阳性）。
//   ⇒ 现在只认 `src-tauri/Cargo.lock` 里锁的那个版本；拿不到就**当场失败**，绝不退而求其次。
//   （与 Rust 侧同一份规则，实现分别在 `src/gm_patch_probe.rs` 与本文件 —— 两侧都由判据守着。）
function lockVersion() {
  const lockPath = join(root, "src-tauri", "Cargo.lock");
  if (!existsSync(lockPath)) return { version: null, why: `没有 ${lockPath}` };
  const lines = readFileSync(lockPath, "utf8").split(/\r?\n/);
  let inPkg = false;
  let isTarget = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[[package]]")) {
      inPkg = true;
      isTarget = false;
      continue;
    }
    if (line.startsWith("[")) {
      inPkg = false;
      isTarget = false;
      continue;
    }
    if (!inPkg) continue;
    if (line.startsWith("name = ")) {
      isTarget = line.slice(7).trim().replace(/"/g, "") === "libsqlite3-sys";
      continue;
    }
    if (isTarget && line.startsWith("version = ")) {
      return { version: line.slice(10).trim().replace(/"/g, ""), why: "cargo.lock" };
    }
  }
  return { version: null, why: "Cargo.lock 里没有 libsqlite3-sys" };
}

function registryRoots() {
  const cargoHome = process.env.CARGO_HOME || join(homedir(), ".cargo");
  const srcRoot = join(cargoHome, "registry", "src");
  if (!existsSync(srcRoot)) return [];
  return readdirSync(srcRoot).map((r) => join(srcRoot, r));
}

const { version: locked, why: lockedWhy } = lockVersion();
const found = [];
for (const reg of registryRoots()) {
  let pkgs = [];
  try {
    pkgs = readdirSync(reg);
  } catch {
    continue;
  }
  for (const pkg of pkgs) {
    if (!pkg.startsWith("libsqlite3-sys-")) continue;
    const sc = join(reg, pkg, "sqlcipher");
    if (existsSync(sc)) found.push({ version: pkg.replace("libsqlite3-sys-", ""), dir: sc });
  }
}
found.sort((a, b) => a.version.localeCompare(b.version));

let srcDir = null;
if (!locked) {
  fail(`拿不到 libsqlite3-sys 的锁定版本（${lockedWhy}）⇒ **不猜**，无法核对补丁。`);
}
const hit = found.find((f) => f.version === locked);
if (!hit) {
  fail(
    `Cargo.lock 锁的是 libsqlite3-sys **${locked}**，但 registry 里找到的是 ` +
      `[${found.map((f) => f.version).join(", ") || "（无）"}] ⇒ **不挑别的版本**：\n` +
      "  按 mtime 挑会挑到陈旧副本（macOS 侧实测过：0.30.1 的 mtime 比 0.38.2 新）⇒\n" +
      "  假阴性（补丁打了却报没有）与假阳性（往陈旧副本注入也能通过）都会发生。\n" +
      "  修法：cargo fetch（把锁定版本取下来），再重跑。",
  );
}
srcDir = hit.dir;
console.log(`sm-library-build: 源码 = ${srcDir}（Cargo.lock: ${locked}）`);

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
