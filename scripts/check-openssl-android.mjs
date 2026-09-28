// **Android 库级国密**那份静态 Tongsuo 的"在不在、是不是我们要的形状、给谁用"（owner 2026-09-23 拍「做」）。
//
// 与 `fetch-pdfium.mjs` 同一个形状（同一套 vendor 机制）：**二进制不入库**（`.gitignore`），
// 仓库里只留**判据**与**记录值**。但判据的口径不同，这一点是被实测逼出来的：
//
// ⚠️ **为什么不拿 sha256 当门禁**（2026-09-23，三遍实测）：
//   pdfium 是**下载**来的权威资产（有上游权威哈希），而这份是**交叉编译**出来的。
//   实测：**同一台机、同一个工作目录、同一份源码 commit、同一套 Configure 参数**连编三遍，得到
//   **三个不同的 sha256**（大小完全相同 10,931,686）：
//     4146eef0…（第一遍，源码目录在仓内） / 39b7efd2…（第二遍） / 19e2541a…（第三遍）
//   ⇒ 「自编产物按字节钉」这条路**被实测否掉**（真因未定：最可能是归档成员序 / 并行 make 的次序，
//     或某个生成物带了时间；已排除 OPENSSLDIR 与 `buildinf.h` 的 `DATE`，也确认库里没有日期样式串）。
//   ⇒ 正确做法：**钉输入**（源码 commit ＋ NDK 修订 ＋ Configure 参数，都在 `build-tongsuo-android.sh` 里）
//     ＋ **判属性**（静态、大小在合理带、headers 在、SM 符号够多）；
//     sha256 **只作为读数**打印并与记录值对照 —— 不同就**提示**（不是红）。
//     这比"钉一个只有我这台编得出来的哈希"诚实，也比"什么都不钉"有牙（属性能抓住换错版本/编成动态）。
//
// 退出码：0 = 属性全过；1 = 属性不符（例如居然产出了 `libcrypto.so`）；2 = **没验**（vendor 里没有那份）。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 钉**输入**（改这里 = 换版本；换完在本机重编并更新 `recordedSha256` 这条读数）。 */
export const PINNED = {
  /** 上游源码（Gitee 镜像）的 commit —— 与 Linux / macOS 侧同一个 commit。 */
  sourceCommit: "540603a3",
  /** 编它时的 NDK 修订；⚠️ 仓库 pin 的 NDK 是 29.0.13846066，差一个补丁号（r29 同大版本）。 */
  ndkRevision: "29.0.14206865",
  abi: "arm64-v8a",
  api: 24,
  /** Configure 用的固定安装前缀（决定编进库里的 `OPENSSLDIR`）。 */
  prefixFixed: "/opt/shuyonote/openssl-android",
  /** **读数**（不是门禁）：本机最近一次编出来的 sha256/大小；每编一次都会变（见文件头三遍实测）。 */
  recordedSha256: "19e2541af8fa3041ef7e0f6d8466705f9780f610f1395039f476fd45d6affd00",
  recordedSize: 10931686,
  /** 大小合理带（静态 libcrypto.a 是 MB 级；跑出个 0 字节或 100 MB 都说明构建坏了）。 */
  sizeBand: [8_000_000, 16_000_000],
  /** SM 符号数的下界（本机实测 190：sm3+sm4 的公开符号）。 */
  minSmSymbols: 100,
};

/** vendor 里的安装前缀（`OPENSSL_DIR` 就指它）。 */
export const PREFIX = join("src-tauri", "vendor", "openssl", "android-arm64");

/** 数 SM 符号（`llvm-nm`/`nm` 拿不到就返回 null ⇒ 调用方如实报"这一项没验"）。 */
export function countSmSymbols(libPath, { run } = {}) {
  const exec = run ?? (() => null);
  for (const tool of ["llvm-nm", "nm"]) {
    const out = exec(tool, ["--defined-only", libPath]);
    if (out) return out.split("\n").filter((l) => /sm3|sm4/i.test(l)).length;
  }
  return null;
}

/**
 * 按**属性**核对一份安装前缀（纯函数：期望值/文件系统都可注入 ⇒ 判据不用真的编一次）。
 *
 * @returns {{status: 0|1|2, ok: boolean, lines: string[]}}
 */
export function verifyVendor(prefix, {
  recordedSha256 = PINNED.recordedSha256,
  recordedSize = PINNED.recordedSize,
  sizeBand = PINNED.sizeBand,
  exists = existsSync,
  readdir = readdirSync,
  size = (p) => statSync(p).size,
  hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex"),
} = {}) {
  const lib = join(prefix, "lib", "libcrypto.a");
  const include = join(prefix, "include", "openssl", "evp.h");
  const lines = [];
  if (!exists(lib)) {
    lines.push(`没验：vendor 里没有那份静态库：${lib}`);
    lines.push("  ⇒ 先编：ANDROID_NDK_ROOT=<ndk> sh scripts/build-tongsuo-android.sh");
    return { status: 2, ok: false, lines };
  }

  const bytes = size(lib);
  const sha = hash(lib);
  lines.push(`读数：${bytes} 字节 · sha256 ${sha}`);
  lines.push(
    sha === recordedSha256
      ? "  （与记录值相同）"
      : `  （与记录值不同：记录 ${recordedSha256.slice(0, 12)}… —— **正常**，自编产物随构建路径变，见文件头注释）`,
  );

  let bad = false;
  if (bytes < sizeBand[0] || bytes > sizeBand[1]) {
    lines.push(`✗ 大小 ${bytes} 不在合理带 [${sizeBand[0]}, ${sizeBand[1]}] ⇒ 构建可能坏了`);
    bad = true;
  }
  const soLibs = readdir(join(prefix, "lib")).filter((n) => /^libcrypto\.so/.test(n));
  if (soLibs.length > 0) {
    lines.push(`✗ 居然有动态库：${soLibs.join(", ")} ⇒ 「静态」那一格不成立（APK 里会变成动态依赖）`);
    bad = true;
  }
  if (!exists(include)) {
    lines.push(`✗ 缺 headers（${include}）⇒ 构建那条链拿不到 include 目录`);
    bad = true;
  }
  if (bad) return { status: 1, ok: false, lines };
  lines.push("属性全过：静态 ✓ 大小合理 ✓ headers 齐 ✓");
  return { status: 0, ok: true, lines };
}

/** 构建那条链要的环境变量（CI 里写进 `$GITHUB_ENV`）。第四格是**链到哪一份**的核对键。 */
export function envLines(prefix) {
  const p = resolve(prefix);
  return [
    `OPENSSL_DIR=${p}`,
    `OPENSSL_LIB_DIR=${p}/lib`,
    `OPENSSL_INCLUDE_DIR=${p}/include`,
    `SHUYONOTE_EXPECT_OPENSSL_DIR=${p}`,
  ];
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const prefix = join(root, PREFIX);

  if (argv.includes("--print-sha256")) {
    const f = argv[argv.indexOf("--print-sha256") + 1];
    if (!f || !existsSync(f)) {
      console.error("用法: node scripts/check-openssl-android.mjs --print-sha256 <libcrypto.a>");
      process.exit(2);
    }
    const buf = readFileSync(f);
    console.log(`size   : ${buf.length}`);
    console.log(`sha256 : ${createHash("sha256").update(buf).digest("hex")}`);
    process.exit(0);
  }

  if (argv.includes("--print-env")) {
    // ⚠️ **不校验存在性**：它的用途正是"把环境指过去"，缺文件由构建那条链自己报。
    for (const line of envLines(prefix)) console.log(line);
    process.exit(0);
  }

  const r = verifyVendor(prefix);
  for (const line of r.lines) console.log(`check-openssl-android: ${line}`);

  // SM 符号那一项要 llvm-nm/nm：拿不到就**如实说没验**，而不是跳过不提。
  if (r.status === 0) {
    const { execFileSync } = await import("node:child_process");
    const n = countSmSymbols(join(prefix, "lib", "libcrypto.a"), {
      run: (cmd, args) => {
        try {
          return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        } catch {
          return null;
        }
      },
    });
    if (n === null) console.log("check-openssl-android: SM 符号数 = 没验（本机没有 llvm-nm/nm）");
    else console.log(`check-openssl-android: SM 符号数 = ${n}（下界 ${PINNED.minSmSymbols}）${n < PINNED.minSmSymbols ? " ✗ 太少" : " ✓"}`);
  }
  process.exit(r.status);
}
