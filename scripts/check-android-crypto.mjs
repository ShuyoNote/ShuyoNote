// Android 包里**「库级国密」是不是静态随包**那条判据（owner 2026-09-23 拍「做」）。
//
// 为什么在**产物**上判，而不是看 CI 里写没写 `--features sm-library`：
// 「编的时候带了」与「包里真的是那个形状」是两件事 —— 本仓在 pdfium 上吃过两次
// （"装包里没有 pdfium.dll" / "包里有但位置不对"），所以同类问题一律落到产物判据上。
//
// 判什么（三条）：
//   ① 包里**不该**出现 `lib/<abi>/libcrypto.so*`：静态随包 ⇒ 没有独立的动态 crypto 库；
//   ② 应用自己的 `.so`（`lib<name>.so`）的 **DT_NEEDED 里不该有** `libcrypto.so*`：
//      有的话用户机器得能自己找到那份库，而 Android 系统**不带** OpenSSL。
//   ③ ★ **正向那一半**：应用 `.so` 里必须找得到**补丁引入的字面量**（`PBKDF2_HMAC_SM3`/`HMAC_SM3`）
//      ⇒ "随包的这份 SQLCipher **真的打过国密补丁**"。挡住的是"编的时候带了
//      `--features sm-library`、库里却是原版 SQLCipher"那种**看起来是国密**的形态。
//
//   ③ 为什么成立（2026-09-25 在真产物上实测，推翻了本文件原来那句"验不了"）：
//   原来写的是"release 包被 `strip = true` 剥了符号 ⇒ 数不了 SM3/SM4 符号"—— **strip 剥掉的是
//   符号表（`.symtab`/`.dynsym`），不是 `.rodata` 里的字符串字面量**。真产物上数了一遍：
//     `PBKDF2_HMAC_SM3` ×3、`HMAC_SM3` ×6、`sqlcipher_openssl_hmac` ×11、`EVP_sm3` ×1
//   （52.9 MB 的 `app-universal-release-unsigned.apk`，`lib/arm64-v8a/libshuyonote_lib.so`）
//   而这三个字面量在**未打补丁**的那份 registry 源码里出现 **0** 次
//   （`.cargo/registry/src/*/libsqlite3-sys-0.38.2/sqlcipher/sqlite3.c`，`SHUYONOTE-GM` 命中 0）
//   ⇒ 它们是**补丁独有**的：出现 ⇔ "打过补丁的那份源码被编进来了"。
//
//   ⚠️ ③ 证不到的还剩一层，仍属**人手**：字面量在库里 ≠ **运行期 provider 真的支持 SM3**
//   （SQLCipher 的后端能力门与 OpenSSL provider 支持是两件事）。最终证据还是真机跑一次
//   （口令→加密→重启解锁→读写）。绝不把"没验"写成"通过"。
//
// 退出码：0 = 通过；1 = 有问题（动态 crypto 库随包 / 应用 .so 依赖它 / **补丁字面量不在**）；
//   2 = **没验**（找不到 APK / 包里的 app .so 不在 / 本机没有 readelf 或 llvm-readelf /
//   **判据自身的字面量清单已与补丁文件脱节**）。与 `check-android-bundle`
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

/**
 * ③ 用的字面量：由 `patches/0001-sqlcipher-sm3-provider.patch` 引入、**上游没有**的字符串。
 *
 * 挑的是"补丁改了它、上游一定没有"这两个条件同时成立的：
 *   · `PBKDF2_HMAC_SM3` —— `SQLCIPHER_PBKDF2_HMAC_SM3_LABEL` 的值，PRAGMA `cipher_kdf_algorithm` 回的就是它；
 *   · `HMAC_SM3`        —— `SQLCIPHER_HMAC_SM3_LABEL` 的值。
 * 两个都在 `.rodata` ⇒ 与符号表无关，`strip = true` 也留得住（实测见文件头）。
 */
export const SM_PROVIDER_LITERALS = ["PBKDF2_HMAC_SM3", "HMAC_SM3"];
/** 判据自身的新鲜度靠它：清单与补丁文件脱节时**报「没验」**，而不是继续判（见 `patchDeclaresLiterals`）。 */
export const SM_PATCH_FILE = "patches/0001-sqlcipher-sm3-provider.patch";

/**
 * 纯函数：这些字面量在字节里各有没有。**空输入 ⇒ 全部 missing**（不拿"空"当"有"）。
 *
 * 为什么用 latin1 逐字节找（而不是先转字符串）：`.so` 是二进制，`toString("utf8")` 会把
 * 非 UTF-8 序列替换成 U+FFFD，可能**跨过**本该命中的边界；逐字节 `includes` 没有这层解释。
 */
export function smProviderEvidence(bytes, literals = SM_PROVIDER_LITERALS) {
  const hay = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  const found = [];
  const missing = [];
  for (const l of literals) {
    if (hay.length > 0 && hay.includes(Buffer.from(l, "latin1"))) found.push(l);
    else missing.push(l);
  }
  return { found, missing };
}

/**
 * 纯函数：补丁文件里**还写着**这些字面量吗？
 *
 * 为什么需要：③ 的两条字面量是**抄**进本文件的。哪天补丁把标签改了（或改成分片拼接），
 * ③ 就会对着一份**打过补丁**的产物报红 —— 那种假红会把这门禁训练成"可以忽略"。
 * ⇒ 每次判之前先在补丁文件里核对一遍；对不上就报「没验」（2），并点名是哪一条。
 */
export function patchDeclaresLiterals(patchText, literals = SM_PROVIDER_LITERALS) {
  const t = String(patchText ?? "");
  return { declared: literals.filter((l) => t.includes(l)), missing: literals.filter((l) => !t.includes(l)) };
}

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

  // ③ 正向那一半：补丁引入的字面量必须在这个 .so 里（`buf` 就是它，不用再解一次）
  const patchPath = join(root, SM_PATCH_FILE);
  let patchText = null;
  try {
    patchText = readFileSync(patchPath, "utf8");
  } catch (e) {
    err(`✗ 没验：读不了判据自己的补丁文件 ${SM_PATCH_FILE}：${String(e?.message ?? e).slice(0, 120)}`);
    return 2;
  }
  const fresh = patchDeclaresLiterals(patchText);
  if (fresh.missing.length > 0) {
    err(
      `✗ 没验：③ 的字面量清单已与补丁脱节 —— ${fresh.missing.join("、")} 在 ${SM_PATCH_FILE} 里找不到。` +
        `\n  ⇒ 要么补丁改了标签（那就要同步改 SM_PROVIDER_LITERALS），要么清单抄错了。` +
        `\n  这**不是**产物有问题，是判据自己过期；不许当成通过。`,
    );
    return 2;
  }
  const ev = smProviderEvidence(buf);
  if (ev.missing.length > 0) {
    err(`✗ ${apps[0].entry} 里找不到补丁字面量：${ev.missing.join("、")}（找到的是：${ev.found.join("、") || "（无）"}）`);
    err("  ⇒ 随包的这份 SQLCipher **不是**打过国密补丁的那份（典型成因：编译时没用私有 CARGO_HOME，");
    err("    于是 [patch.crates-io] 没生效、编的是 registry 里的原版）。这是「看起来是国密」的形态。");
    return 1;
  }
  log(`✓ ${apps[0].entry} 里有补丁字面量 ${ev.found.join("、")}（⇒ 打过补丁的那份 SQLCipher 真的编进来了）`);

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

  log("✓ 库级国密：三条都过 —— ① 无动态 crypto 库 ② 无 DT_NEEDED 依赖 ③ 补丁字面量在包里");
  log("! 仍未验的那一层：运行期 provider 真的支持 SM3（字面量在库里 ≠ 算法可用）；");
  log("  最终证据是真机跑一次（口令→加密→重启解锁→读写），属人手。");
  return 0;
}

if (isMain(import.meta.url)) {
  process.exit(check({ apk: process.argv[2] }));
}
