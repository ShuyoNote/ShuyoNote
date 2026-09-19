// 断言「**实际编进 SQLCipher 的加密后端**」与**声明**一致。
//
// ## 为什么必须有一条这样的门禁
//
// SQLCipher 的页加密后端是**编译期**决定的（见方案 §3）：
//   · Apple 默认 ⇒ `SQLCIPHER_CRYPTO_CC` + `Security.framework`，而 **CommonCrypto 只有 AES**；
//   · 显式给 `OPENSSL_DIR` ⇒ 链 `libcrypto`（Tongsuo 就是这一支才有 SM4）。
// 所以「**能编过**」与「**真的换了后端**」是两件事 —— 而后者一旦判断错，后果是
// **国密 provider 根本没被编进去**，或者更糟：**换后端之后用户的旧库打不开**。
//
// ## 作者本人踩过的那一脚（本脚本存在的直接理由）
//
// 2026-09-19 我按方案 §3 第 5 条设了 `OPENSSL_DIR=<Tongsuo>` 跑 `cargo test`，编译通过、
// 测试全绿 —— 但产物的 `output` 里**仍然是 `framework=Security`**。原因：
// **`libsqlite3-sys` 的 build.rs 没有为 `OPENSSL_DIR` 声明 `rerun-if-env-changed`**
// （它只声明了 `SQLITE_MAX_*` / `LIBSQLITE3_FLAGS` / `SQLCIPHER_{INCLUDE,LIB}_DIR` 这些），
// 于是 cargo 认为"环境没变" ⇒ **构建脚本根本没重跑** ⇒ 后端保持原样。
// ⇒ "设了环境变量" ≠ "换了后端"；必须 `cargo clean -p libsqlite3-sys` 逼它重跑。
//
// ## 判据口径（三种状态分得清清楚楚，别混）
//
//   · **没有构建产物** ⇒ `!` 自报跳过（还没编过，不是失败）；
//   · **最新产物 ≠ 声明** ⇒ **红**（这是真问题：你以为编进去的是 A，实际是 B）；
//   · **存在更旧、且分类不同的产物** ⇒ `!` 提示（这正是"沉默不换后端"的现场痕迹，
//     但旧产物本身不算失败 —— 它会让人误判，所以要说出来）。
//
// 声明来源：`SHUYONOTE_EXPECT_CRYPTO_BACKEND`（`commoncrypto` / `openssl`），
// 不设则按平台默认（macOS 今天仍是 CommonCrypto —— 见 `PLATFORM_DEFAULT` 的注释）。

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = join(root, "src-tauri", "target");

// 各平台**今天**默认会编出什么（不是我们希望的，是实测的）：
//   · darwin：无 OPENSSL_DIR ⇒ CommonCrypto（只有 AES）。**这是 P2/P3 的前置缺口**：
//     等 AMD 的 provider 补丁线落地时，这里要跟着改成 "openssl"，并让 macOS 的构建侧显式给 OPENSSL_DIR。
//   · linux：build.rs 的最后一支是 `link-lib=dylib=crypto`（系统 OpenSSL）⇒ openssl。
//   · win32：release.yml 已经显式设 OPENSSL_DIR ⇒ openssl。
const PLATFORM_DEFAULT = { darwin: "commoncrypto", linux: "openssl", win32: "openssl" };
const expected =
  process.env.SHUYONOTE_EXPECT_CRYPTO_BACKEND || PLATFORM_DEFAULT[process.platform] || null;

const problems = [];
const notices = [];

/** 把一个 libsqlite3-sys 的 `output` 分类。返回 null 表示这不是 SQLCipher 那份产物。 */
function classify(outputPath) {
  let text;
  try {
    text = readFileSync(outputPath, "utf8");
  } catch {
    return null;
  }
  const isSqlcipher = /sqlcipher/i.test(text);
  if (!isSqlcipher) return null;
  const cc = /SQLCIPHER_CRYPTO_CC|framework=Security/.test(text);
  const openssl = /SQLCIPHER_CRYPTO_OPENSSL|rustc-link-lib=dylib=crypto/.test(text);
  if (cc && openssl) return { kind: "ambiguous", detail: "同时出现 CC 与 OpenSSL 的标记" };
  if (cc) return { kind: "commoncrypto" };
  if (openssl) {
    const m = /rustc-link-search[^\n]*?(?<dir>[^\s=]*\/(?:lib64|lib))\b/.exec(text);
    const dir = m?.groups?.dir ?? "";
    return { kind: "openssl", tongsuo: /tongsuo/i.test(dir), searchDir: dir };
  }
  return { kind: "unknown", detail: "既没有 CC 也没有 OpenSSL 的标记" };
}

/** 收集所有 profile 下的产物，按 `output` 的 mtime 从新到旧。 */
function collect() {
  const found = [];
  for (const profile of ["debug", "release"]) {
    const buildDir = join(targetDir, profile, "build");
    if (!existsSync(buildDir)) continue;
    for (const entry of readdirSync(buildDir)) {
      if (!entry.startsWith("libsqlite3-sys-")) continue;
      const outputPath = join(buildDir, entry, "output");
      if (!existsSync(outputPath)) continue;
      const cls = classify(outputPath);
      if (!cls) continue;
      found.push({ profile, entry, outputPath, mtime: statSync(outputPath).mtimeMs, ...cls });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

const all = collect();

if (all.length === 0) {
  console.error(
    "! 未找到 SQLCipher 的构建产物 ⇒ 未实查（先跑一次 `cargo build --manifest-path src-tauri/Cargo.toml`；" +
      "本机没编过就下结论等于装绿）",
  );
  process.exit(0);
}

const newest = all[0];
const describe = (x) =>
  `${x.profile}/${x.entry} ⇒ **${x.kind}**` +
  (x.kind === "openssl" ? `（link-search=${x.searchDir || "(未解析出)"}${x.tongsuo ? "，路径含 tongsuo" : ""}）` : "") +
  (x.detail ? `（${x.detail}）` : "");

// ① 最新产物 = 当前真正编进去的那个
if (expected === null) {
  console.error(`! 平台 ${process.platform} 没有默认声明 ⇒ 只报告不判定：${describe(newest)}`);
} else if (newest.kind !== expected) {
  problems.push(
    `声明要 **${expected}**，但**最新**产物是 ${describe(newest)}`,
  );
  problems.push(
    "⚠️ 最常见的成因不是「参数写错」，而是**构建脚本没重跑**：`libsqlite3-sys` 没有为 `OPENSSL_DIR` " +
      "声明 `rerun-if-env-changed` ⇒ 改环境变量对 cargo 是「不可见」的。强制重跑：\n" +
      "      cargo clean -p libsqlite3-sys --manifest-path src-tauri/Cargo.toml\n" +
      "    （`cargo clean -p` 之后**必须**在带着目标环境变量的那次调用里重新构建，否则还是原样）",
  );
}

// ② 更旧、分类不同的产物：这正是"沉默不换后端"的现场痕迹，得说出来
const stale = all.filter((x) => x !== newest && x.kind !== newest.kind);
if (stale.length) {
  notices.push(
    `有 ${stale.length} 份**更旧**、分类不同的产物（同一次构建里它们不会同时生效，但会让人误判"我换过后端"）：` +
      stale.map(describe).join("；") +
      " —— 想看清当前状态就跑 `cargo clean -p libsqlite3-sys` 再编一次",
  );
}

for (const n of notices) console.error(`! ${n}`);
if (problems.length) {
  console.error("check-crypto-backend: ❌ 不通过");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `✓ 加密后端与声明一致：${expected}（${describe(newest)}；候选产物 ${all.length} 份，` +
    `${expected === "openssl" ? "OpenSSL/Tongsuo 支" : "CommonCrypto 支"}）`,
);
