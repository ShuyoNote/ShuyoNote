// Android 打包产物的自检门禁（runner 或本机都能跑，**不需要任何密钥**）。
//
// 为什么要有它（与 `check-linux-bundle.mjs` / `check-macos-bundle.mjs` 同一族理由，2026-09-20 加）：
// `libpdfium.so` 是 `libloading` **运行时**加载的 ⇒ **包不在时"装完不会立刻报错"**，
// 只有用户切到 PDFium（P5 之后是默认）才变成「找不到 PDFium 动态库」。
// Android 上它的位置是 APK 里的 `lib/<abi>/libpdfium.so`（Gradle 从 `jniLibs` 收进去）。
// ⚠️ 2026-09-20 之前仓库里**没有任何地方提到 `jniLibs`**（`gen/android` 是 gitignore 的、
// 打包步骤也没有这一步）⇒ 安卓一直**没有随包库**、PDF 走 pdf.js 回退。
// 这条门禁把"到底带没带、带的是不是同一份字节"变成读数，而不是靠发布说明里的一句话。
//
// 断言（从"晚才发现"到"更晚才发现"排）：
//   1. 找得到 APK（默认在 `src-tauri/gen/android/app/build/outputs/apk/**/*.apk` 里取最新的）；
//   2. 它当 zip 能列（**纯 Node 解析**，见 `readZipEntries` 那条注释：原来用 `tar -tf`，而
//      CI 的 ubuntu 上是 GNU tar、**读不了 zip** ⇒ 那一步在 CI 上恒 exit 2"没验"）；
//   3. 包里有 `lib/<abi>/libpdfium.so`（至少一个 ABI）；
//   4. 它那份与 `vendor/pdfium/android-arm64/lib/libpdfium.so` 的 **sha256 一致**（没人在中间换过库）；
//   5. 把"带了哪些 ABI"打出来 —— 只带 arm64 就**明说**只带 arm64，不假装全带。
//
// 退出码：0 = 通过；1 = 有问题（逐条打印原因）；2 = **没验**（找不到 APK / 读不了 zip / vendor 里没那份库
// ⇒ sha256 那一半没验）—— 按本仓惯例，"没验"必须与"通过"分开。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import { isMain } from "./lib/is-main.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** APK 里的库文件名。 */
export const PDFIUM_LIB = "libpdfium.so";
/** Gradle 约定的 ABI 目录名（`lib/<abi>/…`）。 */
export const ABI_DIRS = ["arm64-v8a", "armeabi-v7a", "x86_64", "x86"];
/** 我们随包发的那份（`fetch-pdfium.mjs` 的 `android-arm64` 资产解出来的）。 */
export const VENDOR_LIB = join("src-tauri", "vendor", "pdfium", "android-arm64", "lib", PDFIUM_LIB);

/** 从 `tar -tf` 的输出里挑出 `lib/<abi>/libpdfium.so`（纯函数，便于判据）。 */
export function apkLibEntries(entries) {
  const out = [];
  for (const raw of entries) {
    const entry = String(raw).trim().replace(/^\.\//, "");
    const parts = entry.split("/");
    if (parts.length === 3 && parts[0] === "lib" && ABI_DIRS.includes(parts[1]) && parts[2] === PDFIUM_LIB) {
      out.push({ abi: parts[1], entry });
    }
    // ⚠️ 深一层（`lib/<abi>/<子目录>/libpdfium.so`）**不算**：Gradle 不会把它装进 `nativeLibraryDir`，
    //    与 Linux 那边"resource_dir 那一层"是同一个道理。
  }
  return out.sort((a, b) => ABI_DIRS.indexOf(a.abi) - ABI_DIRS.indexOf(b.abi));
}

/** 找 APK：显式路径 > 默认产物目录里最新的那个。返回 `{ path }` 或 `{ reason }`。 */
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

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * 纯 Node 读 zip（APK 就是 zip）的**中央目录** ⇒ 条目数组。
 *
 * ⚠️ **为什么不用 `tar`**（2026-09-20 实测踩出来的，CI 上真红）：
 *   本机 Windows / macOS 的 `tar` 是 **bsdtar**，它认 zip，所以本地一切正常；
 *   而 **CI 的 ubuntu runner 上 `tar` 是 GNU tar，根本读不了 zip** ⇒ 那一步恒报
 *   「`tar -tf` 读不了这个文件」，exit 2（"没验"）—— 一条**产物判据**被一个环境差异
 *   变成了永远不生效的摆设（而且它只是"没验"，不会有人以为是自己的包坏了）。
 *   ⇒ 现在三个平台同一份纯 JS 实现，零外部依赖；也顺手去掉了"有没有 tar/unzip/7z"这种运气。
 *
 * 只做 APK 需要的那点事：EOCD（含 zip64）→ 中央目录 → 条目名/压缩方式/大小/本地头偏移。
 * 读不了（不是 zip、被截断）⇒ `null`：调用方**如实报"没验"**，不许当成通过。
 */
export function readZipEntries(buf) {
  try {
    const eocd = findEocd(buf);
    if (!eocd) return null;
    const entries = [];
    let p = eocd.cdOffset;
    for (let i = 0; i < eocd.count; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) return null; // 中央目录头签名不对
      const method = buf.readUInt16LE(p + 10);
      let compressedSize = buf.readUInt32LE(p + 20);
      let uncompressedSize = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      let localOffset = buf.readUInt32LE(p + 42);
      const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
      // zip64：这几个字段为 0xffffffff 时真值在 0x0001 扩展字段里（按出现顺序补位）
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
        const z = readZip64Extra(buf, p + 46 + nameLen, extraLen, {
          uncompressedSize,
          compressedSize,
          localOffset,
        });
        uncompressedSize = z.uncompressedSize;
        compressedSize = z.compressedSize;
        localOffset = z.localOffset;
      }
      entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } catch {
    return null;
  }
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    let count = buf.readUInt16LE(i + 10);
    let cdOffset = buf.readUInt32LE(i + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) {
      // zip64 EOCD locator 就贴在 EOCD 前面（20 字节）
      const loc = i - 20;
      if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
        const z64 = Number(buf.readBigUInt64LE(loc + 8));
        if (buf.readUInt32LE(z64) === 0x06064b50) {
          count = Number(buf.readBigUInt64LE(z64 + 32));
          cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
        }
      }
    }
    return { count, cdOffset };
  }
  return null;
}

function readZip64Extra(buf, extraStart, extraLen, cur) {
  const out = { ...cur };
  let p = extraStart;
  const end = extraStart + extraLen;
  while (p + 4 <= end) {
    const id = buf.readUInt16LE(p);
    const size = buf.readUInt16LE(p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      // zip64 扩展字段只放"上面对应字段是 0xffffffff 的那些"，顺序固定
      if (cur.uncompressedSize === 0xffffffff) {
        out.uncompressedSize = Number(buf.readBigUInt64LE(q));
        q += 8;
      }
      if (cur.compressedSize === 0xffffffff) {
        out.compressedSize = Number(buf.readBigUInt64LE(q));
        q += 8;
      }
      if (cur.localOffset === 0xffffffff) {
        out.localOffset = Number(buf.readBigUInt64LE(q));
        q += 8;
      }
      return out;
    }
    p += 4 + size;
  }
  return out;
}

/** APK 的条目名列表（与 `tar -tf` 同口径；读不了 ⇒ `null` = 没验，不是"没有库"）。 */
export function listApk(apk) {
  const entries = readZipEntries(readFileSync(apk));
  return entries === null ? null : entries.map((e) => e.name);
}

/** 把 APK 里某个条目**解成 Buffer**（不落盘）：方法 0 直取、方法 8 走 `inflateRawSync`。 */
export function readApkEntry(apk, entry) {
  const buf = readFileSync(apk);
  const entries = readZipEntries(buf);
  if (entries === null) return null;
  const found = entries.find((e) => e.name === entry || e.name === `./${entry}`);
  if (!found) return null;
  // 本地头：签名(4) + …名字长度在 +26、扩展长度在 +28 ⇒ 数据从 +30+名字+扩展 开始
  const lo = found.localOffset;
  if (buf.readUInt32LE(lo) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + found.compressedSize);
  if (found.method === 0) return Buffer.from(raw);
  if (found.method === 8) return inflateRawSync(raw);
  return null; // 别的压缩方式（APK 不会用）
}

export function check({ apk, log = console.log, err = console.error } = {}) {
  const found = findApk(apk);
  if (found.reason) {
    err(`✗ 没验：${found.reason}`);
    return 2;
  }
  log(`APK：${found.path}`);

  const entries = listApk(found.path);
  if (entries === null) {
    err("✗ 没验：读不了这个 APK 的 zip 结构（不是 zip？被截断？）—— 别当成通过");
    return 2;
  }
  log(`包内条目 ${entries.length} 个`);

  const libs = apkLibEntries(entries);
  if (libs.length === 0) {
    err("✗ 包里**没有** `lib/<abi>/libpdfium.so` ⇒ 安卓上 PDFium 用不了（会静默退到 pdf.js）");
    err("  修法：把 vendor 里那份 android 库放进 `gen/android/app/src/main/jniLibs/<abi>/`，");
    err("        或用 `node scripts/stage-android-pdfium.mjs`（把这一步脚本化，别手工拷）。");
    return 1;
  }

  const hasVendor = existsSync(join(root, VENDOR_LIB));
  let bad = 0;
  for (const lib of libs) {
    const buf = readApkEntry(found.path, lib.entry);
    if (buf === null) {
      err(`✗ ${lib.entry}：解不出来（包里在、展开失败）`);
      bad++;
      continue;
    }
    const got = sha256Buffer(buf);
    const size = buf.length;
    if (!hasVendor) {
      log(`~ ${lib.entry.padEnd(34)} ${size} 字节  sha256 ${got.slice(0, 16)}…（vendor 里没有 android 那份 ⇒ 没比）`);
      continue;
    }
    const want = sha256File(join(root, VENDOR_LIB));
    if (got === want) log(`✅ ${lib.entry.padEnd(34)} ${size} 字节  与 vendor **逐字节相同**`);
    else {
      err(`✗ ${lib.entry}：sha256 与 vendor 不一致（有人换过库？）`);
      err(`   包内 ${got}`);
      err(`   vendor ${want}`);
      bad++;
    }
  }
  log(`带的 ABI：${libs.map((l) => l.abi).join(", ")}（共 ${libs.length} 个；**没带的 ABI 就是没带**）`);

  if (bad) return 1;
  if (!hasVendor) {
    err(`✗ 没验全：vendor 里没有 ${VENDOR_LIB} ⇒ **sha256 那一半没验**`);
    err("  （先 `node scripts/fetch-pdfium.mjs android-arm64`，或从取到库的那台机器拷过来）");
    return 2;
  }
  log("✓ Android 包里带了我们那份 libpdfium.so");
  return 0;
}

if (isMain(import.meta.url)) {
  process.exit(check({ apk: process.argv[2] }));
}
