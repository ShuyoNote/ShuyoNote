// 把 vendor 里的 **Android 版** `libpdfium.so` 放进 Tauri 生成的 Android 工程（`jniLibs/`）。
//
// 为什么要有这一步（2026-09-20，P4 的安卓缺口）：
// `src-tauri/gen` 是 **gitignore** 的（`tauri android init` 现场生成），仓库里也**没有任何地方提到
// `jniLibs`** ⇒ 安卓包里一直没有 `lib/<abi>/libpdfium.so`，PDF 走的是 pdf.js 回退。
// 手工拷进 `gen/...` 的做法在下一次 `android init` 后就没了 ⇒ 必须**脚本化**，并在打包前显式跑一次。
//
// 用法：
//   node scripts/stage-android-pdfium.mjs            # 默认 arm64-v8a
//   node scripts/stage-android-pdfium.mjs --abi arm64-v8a
// 退出码：0 = 就位；1 = 放不进去（目标目录不存在等）；2 = **没验**（vendor 里没有那份库 ⇒ 先取库）。
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** fetch-pdfium 的平台名 → Gradle 的 ABI 目录名。**目前只随包 arm64**（`PLATFORMS` 里也只钉了这一份）。 */
export const ABI_BY_PLATFORM = { "android-arm64": "arm64-v8a" };

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

export function stage({ abi = "arm64-v8a", log = console.log, err = console.error } = {}) {
  const platform = Object.keys(ABI_BY_PLATFORM).find((k) => ABI_BY_PLATFORM[k] === abi);
  if (!platform) {
    err(`✗ 不认识的 ABI：${abi}（可选：${Object.values(ABI_BY_PLATFORM).join(", ")}）`);
    return 1;
  }
  const src = join(root, "src-tauri", "vendor", "pdfium", platform, "lib", "libpdfium.so");
  if (!existsSync(src)) {
    err(`✗ 没验：vendor 里没有 ${platform} 的那份库：${src}`);
    err(`  ⇒ 先取库：node scripts/fetch-pdfium.mjs ${platform}`);
    err("    （本机到 github.com 不通时，让取得到的那台机器把 tgz 传过来，按 fetch-pdfium 的 sha256 核对后解开）");
    return 2;
  }

  const genRoot = join(root, "src-tauri", "gen", "android", "app", "src", "main");
  if (!existsSync(genRoot)) {
    err(`✗ 目标工程不存在：${genRoot}`);
    err("  ⇒ 先跑 `pnpm tauri android init`（它生成 gen/android；该目录不进 git）");
    return 1;
  }

  const destDir = join(genRoot, "jniLibs", abi);
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, "libpdfium.so");
  copyFileSync(src, dest);

  const size = statSync(dest).size;
  const digest = sha256(dest);
  log(`✅ ${platform} → jniLibs/${abi}/libpdfium.so`);
  log(`   ${size} 字节  sha256 ${digest}`);
  log(`   源：${src}`);
  log("   ⚠️ `gen/android` 是 gitignore 的：**每次 `android init` 之后都要再跑一次这一步**" +
    "（或把它挂在打包命令前面，见 docs/TESTING.md 的安卓一节）。");
  return 0;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--abi");
  process.exit(stage({ abi: i >= 0 ? argv[i + 1] : "arm64-v8a" }));
}
