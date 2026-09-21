// 把 `src-tauri/icons/android/**` 的**品牌图标**铺进 Tauri 生成的 Android 工程（`gen/…/res/`）。
//
// 为什么需要这一步（2026-09-21，owner：「安卓版的桌面图标更换成 logo」）：
//   `src-tauri/gen` 是**不進 git** 的（`tauri android init` 现场生成），而 init 会把
//   **Tauri 自带的默认图标**（那团蓝橙色漩涡）写进 `res/mipmap-*/` 与两个 drawable。
//   仓库里其实**早就有一套品牌图标**（`src-tauri/icons/android/**`，17 个文件、已入库、
//   含 `mipmap-anydpi-v26/ic_launcher.xml` 自适应图标），但**没有任何步骤把它铺过去**
//   ⇒ 装出来的 APK 桌面图标一直是 Tauri 默认图（owner 截图看到的就是它）。
//   手工往 `gen/…` 里拷的做法在**下一次 `android init` 之后就没了** ⇒ 必须脚本化，
//   并在打包前显式跑一次 —— 与 `stage-android-pdfium.mjs` 同一条理由、同一套做法。
//
// 用法：
//   node scripts/android-app-icon.mjs            # 铺图标（幂等）
//   node scripts/android-app-icon.mjs --check    # 只核对：每个文件都在、且与源逐字节相同
// 退出码：0 = 就位/一致；1 = 铺不进去或核对不一致；2 = **没验**（源图标或目标工程不存在）。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 源图标目录（相对仓库根；**入库**）与目标 res 目录（相对仓库根；`android init` 生成）。 */
export const ICONS_SRC_REL = join("src-tauri", "icons", "android");
export const RES_DEST_REL = join("src-tauri", "gen", "android", "app", "src", "main", "res");

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** 递归列出源目录里的所有文件，返回**相对源目录**的路径（排序稳定）。 */
export function listIconFiles(srcRoot) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(srcRoot, p));
    }
  };
  walk(srcRoot);
  return out;
}

/**
 * 铺图标 / 核对图标。
 * @param {{root?:string, check?:boolean, log?:Function, err?:Function}} [opts]
 */
export function stageAppIcon({ root: repoRoot = root, check = false, log = console.log, err = console.error } = {}) {
  const srcRoot = join(repoRoot, ICONS_SRC_REL);
  const destRoot = join(repoRoot, RES_DEST_REL);

  if (!existsSync(srcRoot)) {
    err(`✗ 没验：源图标目录不存在 ${srcRoot}`);
    err(`  ⇒ 它是**入库**的那套品牌图标（mipmap-*/ic_launcher*.png + anydpi 自适应图标）；缺了就没法铺。`);
    return 2;
  }
  if (!existsSync(destRoot)) {
    err(`✗ 没验：Android 工程不存在 ${destRoot}`);
    err("  ⇒ 先跑 `pnpm tauri android init`（它生成 gen/android；该目录不进 git），再跑本脚本。");
    return 2;
  }

  const files = listIconFiles(srcRoot);
  if (files.length === 0) {
    err(`✗ 没验：${srcRoot} 里一个图标都没有`);
    return 2;
  }

  let staged = 0;
  let same = 0;
  const problems = [];
  for (const rel of files) {
    const from = join(srcRoot, rel);
    const to = join(destRoot, rel);
    const srcHash = sha256(from);
    const destExists = existsSync(to) && statSync(to).isFile();
    const destHash = destExists ? sha256(to) : null;
    if (destHash === srcHash) {
      same += 1;
      continue;
    }
    if (check) {
      problems.push(`${rel}：${destExists ? "内容与源不同" : "不存在"}`);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    staged += 1;
  }

  if (check) {
    if (problems.length > 0) {
      err(`✗ 桌面图标没铺对（${problems.length}/${files.length} 个文件）：`);
      for (const p of problems.slice(0, 8)) err(`   · ${p}`);
      if (problems.length > 8) err(`   …还有 ${problems.length - 8} 个`);
      err("  ⇒ 跑 `node scripts/android-app-icon.mjs` 铺一遍（每次 `android init` 之后都要）。");
      return 1;
    }
    log(`✓ Android 桌面图标已就位（${files.length} 个文件与 ${ICONS_SRC_REL} 逐字节相同）`);
    return 0;
  }

  const sample = join(srcRoot, "mipmap-xxxhdpi", "ic_launcher.png");
  log(`✓ 品牌图标已铺进 Android 工程（新写 ${staged} 个，本就一致 ${same} 个，共 ${files.length} 个）`);
  if (existsSync(sample)) log(`   192×192 那张 sha256 ${sha256(sample).slice(0, 16)}…（源：${ICONS_SRC_REL}）`);
  log("   ⚠️ `gen/android` 不进 git：**每次 `tauri android init` 之后都要再跑一次这一步**" +
    "（CI 里是 init 之后紧跟着跑；见 .github/workflows/release.yml / android.yml）。");
  return 0;
}

if (isMain(import.meta.url)) {
  process.exit(stageAppIcon({ check: process.argv.slice(2).includes("--check") }));
}
