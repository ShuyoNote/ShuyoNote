// Android 包里**「库级国密」是不是静态随包**那条判据（owner 2026-09-23 拍「做」）。
//
// 为什么在**产物**上判，而不是看 CI 里写没写 `--features sm-library`：
// 「编的时候带了」与「包里真的是那个形状」是两件事 —— 本仓在 pdfium 上吃过两次
// （"装包里没有 pdfium.dll" / "包里有但位置不对"），所以同类问题一律落到产物判据上。
//
// 判什么（两条）：
//   ① 包里**不该**出现 `lib/<abi>/libcrypto.so*`：静态随包 ⇒ 没有独立的动态 crypto 库；
//   ② 应用自己的 `.so`（`lib<name>.so`）的 **DT_NEEDED 里不该有** `libcrypto.so*`：
//      有的话用户机器得能自己找到那份库，而 Android 系统**不带** OpenSSL。
//
// ⚠️ **正向那一半（"SM provider 真的编进去了"）这里验不了**，如实报「没验」：
//   `src-tauri/Cargo.toml` 的 `[profile.release] strip = true` ⇒ release 包的符号表被剥掉，
//   数不了 SM3/SM4 符号；而"没被 strip 的包"又不是我们要发的那个。**最终证据是真机跑一次**
//   （口令→加密→重启解锁→读写），属**人手**。绝不把"没验"写成"通过"。
//
// 退出码：0 = 通过；1 = 有问题（动态 crypto 库随包 / 应用 .so 依赖它）；2 = **没验**
//   （找不到 APK / 包里的 app .so 不在 / 本机没有 readelf 或 llvm-readelf）。与 `check-android-bundle`
//   分开成两个脚本，正是因为两件事的"没验"不该互相污染。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";
import { listZipEntries, readZipEntryByName } from "./lib/zip.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 应用自己的动态库名（Tauri 的 `[lib] name = "shuyonote_lib"` ⇒ `libshuyonote_lib.so`）。 */
export const APP_LIB = "libshuyonote_lib.so";
/** Gradle 约定的 ABI 目录名。 */
export const ABI_DIRS = ["arm64-v8a", "armeabi-v7a", "x86_64", "x86"];
/** 动态 crypto 库的形态（`libcrypto.so` / `libcrypto.so.3`）。 */
export const CRYPTO_SHARED_RE = /^libcrypto\.so(\.\d+)*$/;

/** 从 APK 条目名里挑出 `lib/<abi>/libcrypto.so*`（**不该有**）。纯函数，判据直接钉它。 */
export function cryptoLibEntries(entries) {
  const out = [];
  for (const raw of entries) {
    const parts = String(raw).trim().replace(/^\.\//, "").split("/");
    if (parts.length === 3 && parts[0] === "lib" && ABI_DIRS.includes(parts[1]) && CRYPTO_SHARED_RE.test(parts[2])) {
      out.push(parts.join("/"));
    }
  }
  return out;
}

/** 从 APK 条目名里挑出应用自己的 `.so`（`lib/<abi>/lib<name>.so`）。纯函数。 */
export function appLibEntries(entries) {
  const out = [];
  for (const raw of entries) {
    const parts = String(raw).trim().replace(/^\.\//, "").split("/");
    if (parts.length === 3 && parts[0] === "lib" && ABI_DIRS.includes(parts[1]) && parts[2] === APP_LIB) {
      out.push({ abi: parts[1], entry: parts.join("/") });
    }
  }
  return out.sort((a, b) => ABI_DIRS.indexOf(a.abi) - ABI_DIRS.indexOf(b.abi));
}

/** 从 `readelf -d` 的输出里挑出 DT_NEEDED 的 crypto 动态库名。纯函数（判据直接钉它）。 */
export function cryptoNeeded(readelfDyn) {
  const names = [];
  for (const line of String(readelfDyn ?? "").split("\n")) {
    const m = /\(NEEDED\)\s+Shared library: \[([^\]]+)\]/.exec(line);
    if (m && CRYPTO_SHARED_RE.test(m[1].trim())) names.push(m[1].trim());
  }
  return names;
}

/** 找 `readelf`/`llvm-readelf` 并跑 `-d`；拿不到返回 null（调用方如实报"没验"）。 */
export function readDynamic(soPath, { run } = {}) {
  const exec = run ?? ((cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  });
  for (const tool of ["readelf", "llvm-readelf"]) {
    const out = exec(tool, ["-d", soPath]);
    if (out) return out;
  }
  return null;
}

/** 找 APK：显式路径 > 默认产物目录里最新的那个（与 `check-android-bundle` 同一口径）。 */
export function findApk(input) {
  if (input && existsSync(input) && statSync(input).isFile() && input.endsWith(".apk")) return { path: resolve(input) };
  const base = input ? resolve(input) : join(root, "src-tauri", "gen", "android", "app", "build", "outputs", "apk");
  if (!existsSync(base)) return { reason: `没有产物目录：${base}（先跑 \`pnpm tauri android build --apk\`）` };
  const found = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (p.endsWith(".apk")) found.push({ p, t: st.mtimeMs });
    }
  };
  walk(base);
  if (found.length === 0) return { reason: `${base} 下没有 .apk` };
  found.sort((a, b) => b.t - a.t);
  return { path: found[0].p };
}

export function check({ apk, log = console.log, err = console.error, run } = {}) {
  const found = findApk(apk);
  if (found.reason) {
    err(`✗ 没验：${found.reason}`);
    return 2;
  }
  log(`APK：${found.path}`);

  let entries;
  try {
    entries = listZipEntries(readFileSync(found.path)).map((e) => e.name);
  } catch {
    err("✗ 没验：读不了这个 APK 的 zip 结构（不是 zip？被截断？）—— 别当成通过");
    return 2;
  }

  // ① 不该有独立的动态 crypto 库
  const cryptoLibs = cryptoLibEntries(entries);
  if (cryptoLibs.length > 0) {
    err(`✗ 包里带了动态 crypto 库：${cryptoLibs.join(", ")}`);
    err("  ⇒ 「静态随包」那一格不成立：Android 系统不带 OpenSSL，这份库得由我们保证在位。");
    return 1;
  }
  log("✓ 包里没有 `lib/<abi>/libcrypto.so*`（静态随包的第一个必要条件）");

  // ② 应用 .so 的 DT_NEEDED 里不该有它
  const apps = appLibEntries(entries);
  if (apps.length === 0) {
    err(`✗ 没验：包里没有应用自己的 ${APP_LIB} ⇒ DT_NEEDED 那一半没验`);
    return 2;
  }
  // 用**共享**的"按名字取条目"（2026-09-25：这里原先写成一个并不存在的 `readApkEntry(...)`，
  // 单元判据测不到、本机没 APK 也走不到 ⇒ 一直到真产物上才以 `ReferenceError` 崩出来。
  // 教训：两个安卓门禁都要这一步 ⇒ 它只能有一份实现，见 `lib/zip.mjs::readZipEntryByName`。）
  let apkBuf;
  try {
    apkBuf = readFileSync(found.path);
  } catch (e) {
    err(`✗ 没验：读不了 APK：${String(e?.message ?? e).slice(0, 120)}`);
    return 2;
  }
  const buf = readZipEntryByName(apkBuf, apps[0].entry);
  if (buf === null) {
    err(`✗ 没验：${apps[0].entry} 解不出来`);
    return 2;
  }

  const tmp = mkdtempSync(join(tmpdir(), "android-crypto-"));
  try {
    const soPath = join(tmp, APP_LIB);
    writeFileSync(soPath, buf);
    const dyn = readDynamic(soPath, { run });
    if (dyn === null) {
      err("✗ 没验：本机没有 `readelf`/`llvm-readelf` ⇒ DT_NEEDED 读不出来（CI 的 ubuntu runner 有 binutils）");
      return 2;
    }
    const needed = cryptoNeeded(dyn);
    if (needed.length > 0) {
      err(`✗ ${apps[0].entry} 的 DT_NEEDED 里有 ${needed.join(", ")} ⇒ 动态依赖，用户机器上可能找不到`);
      return 1;
    }
    log(`✓ ${apps[0].entry}（${apps[0].abi}，${buf.length} 字节）的 DT_NEEDED 里没有 libcrypto.so`);
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* 清不掉不影响判定 */
    }
  }

  log("✓ 库级国密的「静态随包」两条件都过");
  log("! 没验的那一半：SM provider 是否真的编进去了 —— release 包被 strip，符号不可读；");
  log("  最终证据是真机跑一次（口令→加密→重启解锁→读写），属人手。");
  return 0;
}

if (isMain(import.meta.url)) {
  process.exit(check({ apk: process.argv[2] }));
}
