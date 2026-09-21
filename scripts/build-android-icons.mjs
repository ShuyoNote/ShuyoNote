// 从 `design/logo/android-icon.json` **重新生成** Android 图标产物（`src-tauri/icons/android/**`）。
//
// 为什么要有这一步（2026-09-21，owner：「安卓的应用图标中间的书本太大了，小一点」）：
//   `src-tauri/icons/android/**` 原来是一次性手跑 `tauri icon` 出来的，**没有任何可复现的入口** ——
//   想改一下书的大小/留白，只能靠人肉重跑命令 + 手工拷贝，于是没人敢动、也没人知道当前那份是怎么来的。
//   现在把"源"（三层 SVG ＋ 一份 manifest）和"生成"（本脚本）都入库：改 SVG 里的 transform 就行。
//
// 三层为什么这么分：Android 自适应图标会被启动器按**它自己的形状**裁切（圆形/圆角方/水滴），
// 只有中间约 66–72% 是安全区 ⇒ **背景满幅、内容待在安全区**。原来前景里画着整个蓝底，
// 书跟着蓝底一起顶满，裁完就显得更大。
//
// 用法：node scripts/build-android-icons.mjs            # 生成并写进 src-tauri/icons/android/
//       node scripts/build-android-icons.mjs --dry-run  # 只生成到临时目录、打印清单，不落库
// 退出码：0 = 就位；1 = 生成/拷贝失败；2 = **没验**（缺 tauri CLI 或源文件）
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_REL = join("design", "logo", "android-icon.json");
export const DEST_REL = join("src-tauri", "icons", "android");

/** 递归列出目录里的文件（相对路径，稳定排序）。 */
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

export function buildAndroidIcons({ root: repoRoot = root, dryRun = false, log = console.log, err = console.error } = {}) {
  const manifest = join(repoRoot, MANIFEST_REL);
  const cli = join(repoRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
  if (!existsSync(manifest)) {
    err(`✗ 没验：没有 ${MANIFEST_REL}`);
    return 2;
  }
  if (!existsSync(cli)) {
    err(`✗ 没验：找不到 tauri CLI（${cli}）—— 先 pnpm install`);
    return 2;
  }

  const staging = mkdtempSync(join(tmpdir(), "android-icons-"));
  try {
    execFileSync(process.execPath, [cli, "icon", manifest, "-o", staging], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const produced = join(staging, "android");
    if (!existsSync(produced)) {
      err(`✗ 生成结果里没有 android/ 目录：${produced}`);
      return 1;
    }
    const files = listFiles(produced);
    log(`✓ tauri icon 生成 ${files.length} 个 Android 图标文件（源：${MANIFEST_REL}）`);

    if (dryRun) {
      for (const f of files) log(`   · ${f}`);
      log(`（--dry-run：没写进 ${DEST_REL}）`);
      return 0;
    }

    const dest = join(repoRoot, DEST_REL);
    // **先清空再拷**：这套产物是"重新生成"的，留着上一版多出来的文件（例如旧版那个
    // `values/ic_launcher_background.xml` 的 `#fff` 颜色）会在包里留下一份没人引用的歧义资源。
    rmSync(dest, { recursive: true, force: true });
    cpSync(produced, dest, { recursive: true });
    const after = listFiles(dest);
    log(`✓ 已写进 ${DEST_REL}（现共 ${after.length} 个文件）`);
    const fg = after.find((f) => f.includes("ic_launcher_foreground.png") && f.includes("xxxhdpi"));
    if (fg) log(`   前景（xxxhdpi）：${fg}  ${statSync(join(dest, fg)).size} 字节`);
    log("   ⚠️ `src-tauri/gen/android` 是 init 现场生成的 ⇒ 还要跑 `node scripts/android-app-icon.mjs` 把它铺进工程。");
    return 0;
  } catch (e) {
    err(`✗ 生成失败：${e?.message ?? e}`);
    if (e?.stderr) err(String(e.stderr).trim().split("\n").slice(-4).join("\n"));
    return 1;
  } finally {
    if (!dryRun) rmSync(staging, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  process.exit(buildAndroidIcons({ dryRun: process.argv.slice(2).includes("--dry-run") }));
}
