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
//   · **最新产物 ≠ 声明**（且认得出后端）⇒ **红**（真问题：你以为编进去的是 A，实际是 B）；
//   · **认不出后端**（如 vendored-openssl 分支不打印任何标记）⇒ `!` 自报"未实查"，**不冒充通过**；
//   · **存在更旧、且分类不同的产物** ⇒ `!` 提示（这正是"沉默不换后端"的现场痕迹）。
//
// 声明来源：`SHUYONOTE_EXPECT_CRYPTO_BACKEND`（`commoncrypto` / `openssl`），
// 不设则按平台默认（见 `PLATFORM_DEFAULT`）。分类与判定都是导出的纯函数，单测见
// `scripts/check-crypto-backend.test.mjs`。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = join(root, "src-tauri", "target");

// 各平台**今天**默认会编出什么（不是我们希望的，是实测的）：
//   · darwin：无 OPENSSL_DIR ⇒ CommonCrypto（只有 AES）。**这是 P2/P3 的前置缺口**：
//     等 AMD 的 provider 补丁线落地时，这里要跟着改成 "openssl"，并让 macOS 的国密版构建显式给 OPENSSL_DIR。
//   · linux：build.rs 的最后一支是 `link-lib=dylib=crypto`（系统 OpenSSL）⇒ openssl。
//   · win32：release.yml 已经显式设 OPENSSL_DIR ⇒ openssl（打的库名是 `libcrypto`）。
export const PLATFORM_DEFAULT = { darwin: "commoncrypto", linux: "openssl", win32: "openssl" };

/** 从环境/平台推出"应该是什么"。空字符串与未设都当"未设"。 */
export function expectedFromEnv(env, platform) {
  const raw = (env.SHUYONOTE_EXPECT_CRYPTO_BACKEND || "").trim();
  if (raw) return raw;
  return PLATFORM_DEFAULT[platform] ?? null;
}

/**
 * 把一个 libsqlite3-sys 的 `output` **分类**（纯函数）。返回 `null` 表示这不是 SQLCipher 那份产物。
 *
 * ⚠️ **可移植性是被实测教训过的**：第一版只认 `rustc-link-lib=dylib=crypto`，
 * 而 Windows 上 build.rs 打的是 `dylib=libcrypto`（`lib_name = if is_windows {"libcrypto"} else {"crypto"}`）
 * ⇒ 那条正则在 Windows 上**必然漏判**，门禁会对着一个完全正常的构建喊红。
 * 所以四种真实形状（CC / Linux-macOS OpenSSL / Windows OpenSSL / vendored 无标记）都有夹具。
 */
export function classifyOutput(text) {
  if (typeof text !== "string" || !/libsqlite3|sqlcipher/i.test(text)) return null;
  const cc = /SQLCIPHER_CRYPTO_CC|framework=Security/.test(text);
  // `libcrypto`（Windows）/ `crypto`（Unix）都要认。
  const openssl = /SQLCIPHER_CRYPTO_OPENSSL|rustc-link-lib=dylib=(?:lib)?crypto/.test(text);
  if (cc && openssl) return { kind: "ambiguous", detail: "同时出现 CommonCrypto 与 OpenSSL 的标记" };
  if (cc) return { kind: "commoncrypto" };
  if (openssl) {
    // 取 link-search 里最后一个以 lib/lib64 结尾的路径（`/` 与 `\` 都要认）。
    const dirs = [
      ...text.matchAll(/cargo:rustc-link-search[^\n]*?([^\s=]*[\\/](?:lib64|lib))(?=[\s]|$)/gm),
    ].map((m) => m[1]);
    const dir = dirs.at(-1) ?? "";
    return { kind: "openssl", tongsuo: /tongsuo/i.test(dir), searchDir: dir };
  }
  // 有 sqlcipher 的编译痕迹、但没有任何后端标记：典型是
  // `bundled-sqlcipher-vendored-openssl`（后端由 openssl-sys 去链，这个 build.rs 不打印任何标记）。
  // ⇒ **不猜**：报"没标记"，由调用处自报未实查，绝不冒充通过。
  return { kind: "no-marker", detail: "没有任何后端标记（vendored-openssl 分支就是这样）" };
}

/** 给人看的描述。 */
export function describe(x) {
  return (
    `${x.profile}/${x.entry} ⇒ **${x.kind}**` +
    (x.kind === "openssl"
      ? `（link-search=${x.searchDir || "(未解析出)"}${x.tongsuo ? "，路径含 tongsuo" : ""}）`
      : "") +
    (x.detail ? `（${x.detail}）` : "")
  );
}

/**
 * 判定（纯函数）：返回 `{ problems, notices }`。
 * 三种状态分得清 —— 没产物/没标记 ⇒ 只提示；**认得出的产物 ≠ 声明 ⇒ 红**；旧产物分类不同 ⇒ 提示。
 */
export function decide({ all, expected }) {
  const problems = [];
  const notices = [];
  if (!all.length) return { problems, notices };

  const newest = all[0];
  const stale = all.filter((x) => x !== newest && x.kind !== newest.kind);
  if (stale.length) {
    notices.push(
      `有 ${stale.length} 份**更旧**、分类不同的产物（同一次构建里它们不会同时生效，但会让人误判「我换过后端」）：` +
        stale.map(describe).join("；") +
        " —— 想看清当前状态就跑 `cargo clean -p libsqlite3-sys` 再编一次",
    );
  }

  if (expected === null) {
    notices.push(`平台没有默认声明 ⇒ 只报告不判定：${describe(newest)}`);
    return { problems, notices };
  }
  if (newest.kind === "commoncrypto" || newest.kind === "openssl") {
    if (newest.kind !== expected) {
      problems.push(`声明要 **${expected}**，但**最新**产物是 ${describe(newest)}`);
      problems.push(
        "⚠️ 最常见的成因不是「参数写错」，而是**构建脚本没重跑**：`libsqlite3-sys` 没有为 `OPENSSL_DIR` " +
          "声明 `rerun-if-env-changed` ⇒ 改环境变量对 cargo 是「不可见」的。强制重跑：\n" +
          "      cargo clean -p libsqlite3-sys --manifest-path src-tauri/Cargo.toml\n" +
          "    （`cargo clean -p` 之后**必须**在带着目标环境变量的那次调用里重新构建，否则还是原样）",
      );
    }
  } else {
    // 认不出后端 ⇒ **不判红也不装绿**，如实说"未实查"（判据的名字不能比它能证明的多）。
    notices.push(
      `最新产物认不出后端（${describe(newest)}）⇒ **未实查**：这条门禁只对认得出的形状下结论，` +
        "认不出的形状一律自报，不冒充通过",
    );
  }
  return { problems, notices };
}

/** 收集所有 profile 下的产物，按 `output` 的 mtime 从新到旧。 */
export function collect(dir) {
  const found = [];
  for (const profile of ["debug", "release"]) {
    const buildDir = join(dir, profile, "build");
    if (!existsSync(buildDir)) continue;
    for (const entry of readdirSync(buildDir)) {
      if (!entry.startsWith("libsqlite3-sys-")) continue;
      const outputPath = join(buildDir, entry, "output");
      if (!existsSync(outputPath)) continue;
      let text;
      try {
        text = readFileSync(outputPath, "utf8");
      } catch {
        continue;
      }
      const cls = classifyOutput(text);
      if (!cls) continue;
      found.push({ profile, entry, outputPath, mtime: statSync(outputPath).mtimeMs, ...cls });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

export function main() {
  const expected = expectedFromEnv(process.env, process.platform);
  const all = collect(targetDir);

  if (all.length === 0) {
    console.error(
      "! 未找到 SQLCipher 的构建产物 ⇒ 未实查（先跑一次 `cargo build --manifest-path src-tauri/Cargo.toml`；" +
        "本机没编过就下结论等于装绿）",
    );
    process.exit(0);
  }

  const { problems, notices } = decide({ all, expected });
  for (const n of notices) console.error(`! ${n}`);
  if (problems.length) {
    console.error("check-crypto-backend: ❌ 不通过");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `✓ 加密后端与声明一致：${expected}（${describe(all[0])}；候选产物 ${all.length} 份，` +
      `${expected === "openssl" ? "OpenSSL/Tongsuo 支" : "CommonCrypto 支"}）`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
