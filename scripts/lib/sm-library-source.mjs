// 「cargo 将要编译的那份 SQLCipher 源码在哪」——**纯函数库**（路径都从参数进来，便于单测与复用）。
//
// 为什么单独一层（macOS 侧 2026-09-19 的要求）：他要算"当前将要编译的那份源码"的 sha256 来判
// **过期标记**，而这套解析（`Cargo.lock` 版本优先 ＋ registry 扫描）**已经有实现**（本文件 ＋ Rust 侧
// `src-tauri/src/gm_patch_probe.rs`）。**不要第三份** —— 那正是我们一路在防的"两套实现漂移"。
// ⇒ 本文件是 **JS 那份唯一实现**：命令行（`scripts/sm-library-build.mjs`）与外部消费方（macOS 的门禁）
//    都 import 它；`--print-source-sha256` 只是它的一层薄壳。
//
// ## 取法（为什么不是 mtime）
// 2026-09-19 macOS 侧的受控实验：按「registry 里 mtime 最新」挑会挑到**陈旧副本**（他那台 0.30.1 的
// mtime 比 0.38.2 新），于是 ① 假阴性：补丁打在真版本上却报"没有"；② 假阳性：只往陈旧副本注入标记，
// 构建也会打出"补丁已应用"。⇒ 只认 `Cargo.lock` 锁的版本；拿不到 / 找不到 ⇒ **当场失败**，绝不退而求其次。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** sqlcipher 源码目录里，我们扫标记时只看这两种后缀（与 Rust 侧 `find_marker` 同口径）。 */
export const MARKER_SUFFIXES = [".c", ".h"];
export const MARKER = "SQLCIPHER_HMAC_SM3_LABEL";

/** 从 `Cargo.lock` 文本里读出 `libsqlite3-sys` 的版本（手写解析，不引 toml 依赖）。 */
export function lockVersion(lockPath) {
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
      return { version: line.slice(10).trim().replace(/"/g, ""), via: "cargo.lock" };
    }
  }
  return { version: null, why: "Cargo.lock 里没有 libsqlite3-sys" };
}

/** `$CARGO_HOME/registry/src` 下的各个 registry 根。 */
export function registryRoots(cargoHome) {
  const home = cargoHome || process.env.CARGO_HOME || join(homedir(), ".cargo");
  const srcRoot = join(home, "registry", "src");
  if (!existsSync(srcRoot)) return [];
  return readdirSync(srcRoot).map((r) => join(srcRoot, r));
}

/**
 * 解析"将要编译的那份 SQLCipher 源码"。
 *
 * @returns `{ dir, version, via }`
 * @throws  `Error`，其 `code` 是机器可判的失败分类：
 *   · `no-locked-version` —— 拿不到 `Cargo.lock` 里的版本；
 *   · `version-mismatch`  —— registry 里有别的版本、**没有**要的那个（`err.found` 列出看到哪些）。
 */
export function resolveSqlcipherSource({ lockPath, cargoHome, roots } = {}) {
  if (!lockPath) {
    const e = new Error("resolveSqlcipherSource 需要 lockPath（不猜仓库位置）");
    e.code = "bad-args";
    throw e;
  }
  const { version: locked, why } = lockVersion(lockPath);
  if (!locked) {
    const e = new Error(`拿不到 libsqlite3-sys 的锁定版本（${why}）⇒ 不猜，无法核对补丁`);
    e.code = "no-locked-version";
    throw e;
  }
  const found = [];
  for (const reg of roots || registryRoots(cargoHome)) {
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
  const hit = found.find((f) => f.version === locked);
  if (!hit) {
    const e = new Error(
      `Cargo.lock 锁的是 libsqlite3-sys **${locked}**，但 registry 里找到的是 ` +
        `[${found.map((f) => f.version).join(", ") || "（无）"}] ⇒ 不挑别的版本（按 mtime 挑会挑到陈旧副本）`,
    );
    e.code = "version-mismatch";
    e.found = found.map((f) => f.version);
    throw e;
  }
  return { dir: hit.dir, version: locked, via: "cargo.lock" };
}

/** 文件 sha256（小写十六进制）—— 与 `build.rs` 那行标记里的 `src_sha256=` 同一算法、同一对象。 */
export function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 「将要编译的那份源码」里**会被扫描标记**的那份文件；没有标记时回落到 `sqlite3.c`。
 *
 * 顺序与 Rust 侧 `find_marker` 一致（**文件名排序**后取第一个含标记的 `.c/.h`）——
 * 两侧必须一致，否则 `src_sha256` 会比不同的文件、判据就变成假话。
 */
export function markerFileOf(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  names.sort();
  for (const f of names) {
    if (!MARKER_SUFFIXES.some((s) => f.endsWith(s))) continue;
    try {
      if (readFileSync(join(dir, f), "utf8").includes(MARKER)) return join(dir, f);
    } catch {
      /* 读不了就跳过 */
    }
  }
  return null;
}

/** 一次性给出"当前将要编译的那份源码"的定位与哈希（给门禁/别的脚本用）。 */
export function sourceFingerprint({ lockPath, cargoHome, roots } = {}) {
  const pick = resolveSqlcipherSource({ lockPath, cargoHome, roots });
  const file = markerFileOf(pick.dir) ?? join(pick.dir, "sqlite3.c");
  if (!existsSync(file)) {
    const e = new Error(`找不到可哈希的文件：${file}`);
    e.code = "no-source-file";
    throw e;
  }
  return { ...pick, file, sha256: sha256OfFile(file), hasMarker: markerFileOf(pick.dir) !== null };
}

// ---------------------------------------------------------------------------
// `--require-static`：**单一口味要自包含**（2026-09-22，owner 拍板「就发国密单一口味」之后加）
// ---------------------------------------------------------------------------

/** 一个 OpenSSL 前缀的 `lib/`、`lib64/` 里，哪些名字算"共享版 libcrypto"。 */
export function sharedCryptoNames(names) {
  // ⚠️ 别只写 `libcrypto\.(dylib|so)`：**真实产物里版本号在中间** —— macOS 是 `libcrypto.3.dylib`、
  // Linux 是 `libcrypto.so.3` ⇒ 第一版正则漏掉了**最常见的那两个名字**（判据当场抓住，见测试）。
  return names.filter((n) => /^libcrypto(\.\d+)*\.(dylib|so)(\..*)?$/.test(n) || /^crypto\.dll$/.test(n));
}

/** 同目录下的静态版（有它才可能静态链接）。 */
export function staticCryptoNames(names) {
  return names.filter((n) => /^libcrypto\.a$/.test(n) || /^libcrypto\.lib$/.test(n));
}

/**
 * 纯函数：给一组 `lib/`、`lib64/` 的文件名，判断这个前缀**能不能给出自包含的产物**。
 *
 * 为什么要这条：`libsqlite3-sys` 打的是 `rustc-link-lib=dylib=crypto`，而链接器
 * **在没有共享库时会退到 `.a`** ⇒ "前缀里只有 `libcrypto.a`" 就等于静态链接；
 * **只要有 `.dylib`/`.so`，产物就会依赖构建机上的那份**（用户机器上要么找不到、
 * 要么用到另一份 OpenSSL）—— 那是"看起来是国密、其实取决于环境"的形态，发布链上必须拦。
 */
export function staticCryptoVerdict({ names = [], files = [] } = {}) {
  const shared = sharedCryptoNames(names);
  const statics = staticCryptoNames(names);
  const extra = files.flatMap((f) => sharedCryptoNames(f.names ?? []));
  const allShared = [...shared, ...extra];
  if (allShared.length > 0) {
    return {
      ok: false,
      why:
        `前缀里有共享版 libcrypto（${allShared.join("、")}）⇒ 产物会依赖**构建机上的那份**，` +
        `到用户机器上要么找不到、要么换用另一份 OpenSSL。\n` +
        `  ⇒ 要么把共享库挪走（只留 libcrypto.a），要么改用一个 no-shared 编出来的前缀。\n` +
        `  （` + "`libsqlite3-sys` 发的是 `rustc-link-lib=dylib=crypto`，没有共享库时链接器会取 .a）",
    };
  }
  if (statics.length === 0) {
    return { ok: false, why: `前缀里**没有** libcrypto.a/libcrypto.lib ⇒ 静态链接无从谈起（只给了：${names.join("、") || "(空)"}）` };
  }
  return { ok: true, found: statics.join("、") };
}

/** 读磁盘版：把 `<prefix>/lib`、`<prefix>/lib64` 的文件名列出来判（给 CLI 用）。 */
export function requireStaticCrypto(prefix, { readdir = readdirSync, exists = existsSync } = {}) {
  if (!prefix) return { ok: false, why: "没给 OPENSSL_DIR（--openssl-dir）⇒ 无法核对静态前缀" };
  const dirs = ["lib", "lib64"].map((d) => join(prefix, d)).filter((d) => exists(d));
  if (dirs.length === 0) return { ok: false, why: `${prefix} 下没有 lib/ 或 lib64/ ⇒ 不像一个 OpenSSL 前缀` };
  const files = dirs.map((d) => ({ dir: d, names: readdir(d) }));
  const names = files.flatMap((f) => f.names);
  const v = staticCryptoVerdict({ names, files });
  if (!v.ok) return { ok: false, why: `${prefix}：${v.why}` };
  return { ok: true, found: `${prefix} ⇒ ${v.found}` };
}
