// 取**随包中文字体**（OFL-1.1）到 `src-tauri/vendor/fonts/`。
//
// 为什么要它（2026-09-20，P4 的 Linux 缺口）：
// 那份预编译 `libpdfium.so` **没有字体后端**（`ldd` 无 fontconfig、`FcInit` 0 个）⇒
// **非嵌入字体**的文档（国标中文 `STSong-Light`+`UniGB-UCS2-H` 这种，中文办公软件常见写法）
// 在 Linux 上**整行不显示**。治法已在 dev（`pdfium_native.rs` 的随包字体 provider：库目录旁有字体就用它），
// 缺的就是**这份字体文件**。本脚本按本仓"取物料"的老规矩办：**钉版本 + 核哈希 + 不把二进制入库**（与 `fetch-pdfium.mjs` 一致）。
//
// 为什么走 npm 而不是直接抓 Google Fonts：`@expo-google-fonts/*` 就是 Google Fonts 的官方打包
// （同一份 TTF ＋ OFL 原文），而 npm 会自动用**各人/CI 自己配的 registry**（本机是 npmmirror）——
// 不把某个镜像地址写死在仓库里。哈希是把"同一个版本"钉死的唯一办法（`@0.4.3` 只钉了包版本）。
//
// 用法：
//   node scripts/fetch-font.mjs            # 取回 `src-tauri/vendor/fonts/`（已存在且哈希对 ⇒ 直接过）
//   node scripts/fetch-font.mjs --check    # 只核对本地那份，不下载
// 退出码：0 = 就位；1 = 哈希不符/取不到（**不把坏文件留在盘上**）；2 = 环境不认（没有 npm / tar）。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 钉死的包版本（Google Fonts 的官方打包）。 */
export const FONT_PACKAGE = "@expo-google-fonts/noto-sans-sc@0.4.3";
/** 包内那份 TTf 的相对路径。 */
export const FONT_IN_PACKAGE = join("package", "400Regular", "NotoSansSC_400Regular.ttf");
/** 包内 OFL 原文（要与字体一起随包，许可要求）。 */
export const LICENSE_IN_PACKAGE = join("package", "LICENSE_FONT");
/**
 * ★ 钉死的哈希（2026-09-20 实测：10.07 MB = 10,558,200 字节上下，见脚本输出）。
 * 换版本 = 换这一行 + 换 `FONT_TARGET`（如果文件名也变了），别只改版本号。
 */
export const FONT_SHA256 = "d45f67f0a7c0ca3f256950777ce6a61cc7ce5f9696d02900cbbaac25f8aa7d16";
/**
 * 落到 `assets/fonts/` 里的文件名 —— **必须与 `pdfium_native.rs::BUNDLED_FONT_CANDIDATES` 里的候选名一致**。
 *
 * ⚠️ 为什么是 `src-tauri/assets/fonts/` 而不是 `vendor/`：`vendor/` 整片在 `.gitignore` 里，
 * 而 `tauri.linux.conf.json` 那条 `"assets/fonts/*": "./"` 映射**必须至少匹配到一个文件**，
 * 否则 tauri 构建期直接红（实测：`glob pattern … didn't match any files` ＋ `cargo check` 101）。
 * ⇒ 这个目录里**常驻一个 README.md**（入库存，占位），字体本体仍不入库。
 */
export const FONT_TARGET = "NotoSansSC-Regular.ttf";
export const LICENSE_TARGET = "LICENSE-OFL.txt";

/** 字体目录（**不是** vendor：见 `FONT_TARGET` 那条注释）。 */
export const FONT_DIR = join("src-tauri", "assets", "fonts");

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** 本地那份在不在、对不对。 */
export function localStatus() {
  const file = join(root, FONT_DIR, FONT_TARGET);
  if (!existsSync(file)) return { ok: false, reason: "本地还没有这份字体" };
  const got = sha256(file);
  if (got !== FONT_SHA256) return { ok: false, reason: `哈希不符（得到 ${got}）`, file };
  return { ok: true, file, size: statSync(file).size };
}

export function fetchFont({ check = false, log = console.log, err = console.error } = {}) {
  const local = localStatus();
  if (local.ok) {
    log(`✅ 已就位：${join(FONT_DIR, FONT_TARGET)}（${local.size} 字节，sha256 ${FONT_SHA256.slice(0, 16)}…）`);
    return 0;
  }
  if (check) {
    err(`✗ ${local.reason} ⇒ 没验（别当成通过）`);
    err(`  取回：node scripts/fetch-font.mjs`);
    return 1;
  }

  let tmp;
  try {
    tmp = mkdtempSync(join(tmpdir(), "shuyo-font-"));
    try {
      execFileSync("npm", ["pack", FONT_PACKAGE, "--pack-destination", tmp], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const code = e && e.code === "ENOENT" ? 2 : 1;
      err(`✗ 取不到字体：\`npm pack ${FONT_PACKAGE}\` 失败${code === 2 ? "（本机没有 npm？）" : ""}`);
      err(`  ${String(e && e.stderr ? e.stderr : e.message).split("\n")[0]}`);
      return code;
    }
    const tgz = readdirSync(tmp).find((n) => n.endsWith(".tgz"));
    if (!tgz) {
      err("✗ 取不到字体：npm pack 没产出 .tgz");
      return 1;
    }
    try {
      execFileSync("tar", ["-xzf", join(tmp, tgz), "-C", tmp], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      err("✗ 取不到字体：解不开那个 .tgz（本机没有 tar？）");
      return 2;
    }

    const src = join(tmp, FONT_IN_PACKAGE);
    if (!existsSync(src)) {
      err(`✗ 取不到字体：包里没有 ${FONT_IN_PACKAGE}（包结构变了？请更新本脚本的路径常量）`);
      return 1;
    }
    const got = sha256(src);
    if (got !== FONT_SHA256) {
      err(`✗ **哈希不符，已拒绝**（不把来路不明的字体放进 vendor）：`);
      err(`   期望 ${FONT_SHA256}`);
      err(`   得到 ${got}`);
      return 1;
    }

    const dir = join(root, FONT_DIR);
    mkdirSync(dir, { recursive: true });
    copyFileSync(src, join(dir, FONT_TARGET));
    const lic = join(tmp, LICENSE_IN_PACKAGE);
    if (existsSync(lic)) copyFileSync(lic, join(dir, LICENSE_TARGET));
    log(`✅ 取回：${join(FONT_DIR, FONT_TARGET)}（${statSync(src).size} 字节）`);
    log(`   许可：${FONT_TARGET} 是 OFL-1.1（Source Han / Noto 系）⇒ ${LICENSE_TARGET} 要**与它一起随包**`);
    log(`   下一步：Linux 打包时它会被 tauri.linux.conf.json 的 vendor/fonts/* 映射带到库旁边（见施工单 §4）`);
    return 0;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  process.exit(fetchFont({ check: process.argv.includes("--check") }));
}
