// macOS .app 的**显式签名**（先 nested、再外层）—— 这是 P4 里"签名/公证"那一格的可做部分。
//
// ## 为什么需要它（2026-09-19 认领、2026-09-22 落地）
// `tauri build` 产出的 .app **没有任何一步在做这件事**：实测（本机，`bundle/macos/ShuyoNote.app`）
// 只有工具链给的 **linker 签名**，于是
//     codesign --verify --deep --strict ShuyoNote.app
//     ⇒ `code has no resources but signature indicates they must be present`（**红**）
// —— 主可执行文件带着一份"声称有资源槽位"的 CodeDirectory，而包里没有 `_CodeSignature/CodeResources`。
// Gatekeeper／公证都要求**由内到外**签：嵌套的 Mach-O 先签，外层 bundle 最后签（Apple 的
// `--deep` 只适合**校验**，不适合签名）。这一步就是把那条顺序显式做出来。
//
// ## 凭什么说"库没被改坏"
// 签名**会改变字节**（要写入 CodeDirectory）。实测（本机，ad-hoc）：
//   · 源 `vendor/pdfium/mac-univ/lib/libpdfium.dylib` 15,219,824 B sha256 `3858ed6a…`
//   · 签后 15,274,928 B sha256 `e4a3a51f…`（+55,104 B）
// ⇒ 所以本脚本在**签之前**先断言"包内那份与 vendor **逐字节相同**"，并把两个哈希都打出来 ——
// 那一刻是内容一致性的**唯一可证明时刻**（签完之后只能证明"签名有效"，证明不了"码没换"）。
// ⚠️ `codesign --remove-signature` **不能**还原成 vendor 的字节（实测 15,176,104 B ≠ 15,219,824 B：
//    原文件那份 linker 签名带自己的填充）⇒ 别拿"去掉签名再比哈希"当证据。
//
// ## 用法
//   node scripts/sign-macos-app.mjs                 # ad-hoc（`-s -`）签本机产物并严格校验
//   node scripts/sign-macos-app.mjs --identity "Developer ID Application: …"
//   node scripts/sign-macos-app.mjs --app <path> --dry-run
// 退出码：0 = 签完且 `--verify --deep --strict` 通过；非 0 = 有问题（逐条打印）。
//
// ## 边界（不冒领）
// · **公证（notarytool）需要真实凭据**（owner 手上），本脚本不做；凭据到位后拿同一套判据复跑即可。
// · `-s -` 是 **ad-hoc** 签名：它能过 `codesign --verify --deep --strict`，但**过不了 Gatekeeper**
//   （那是身份的差别，不是"签得对不对"的差别）。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isMain } from "./lib/is-main.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 包内需要单独先签的嵌套二进制：Frameworks 下的库、MacOS 下的辅助可执行文件。 */
export const NESTED_DIRS = ["Contents/Frameworks", "Contents/MacOS"];

/** Mach-O 的魔数：32/64 位、大小端，**外加 fat/universal 容器**。
 *
 * ⚠️ 第一版漏了 `0xcafebabe` ⇒ `Contents/Frameworks/libpdfium.dylib`（**universal**，x86_64＋arm64）
 * 被判成"不是 Mach-O"，于是"嵌套二进制 0 个"—— 这正是"绿得像它声称的那件事"的形态：
 * 判据会说"签完了"，而实际上**一个嵌套库都没签**。真实读数抓到了它（dry-run 打印 0 个）。 */
const MACHO_MAGICS = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, // 单架构
  0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca, // fat / fat64（universal）
]);

/** 这个文件是不是 Mach-O（只看前 4 字节）。读不到/太短 ⇒ false。 */
export function isMachO(path) {
  try {
    if (statSync(path).size < 4) return false;
    const head = readFileSync(path).subarray(0, 4);
    return MACHO_MAGICS.has(head.readUInt32BE(0)) || MACHO_MAGICS.has(head.readUInt32LE(0));
  } catch {
    return false;
  }
}

/**
 * 纯函数：**签名顺序**（Apple 的要求：由内到外）。
 *
 * 输入是"包内所有 Mach-O 的相对路径"，输出是**应当被签名的顺序**（不含最后的 bundle 本身）：
 *   · 先深后浅（嵌套的 dylib／helper 先于直接躺在 MacOS 下的主可执行文件）；
 *   · 同一层按路径排序（可复现，别依赖 readdir 顺序）；
 *   · **主可执行文件（`Contents/MacOS/<CFBundleExecutable>`）不在这里**：它由最后那一步
 *     "签整个 bundle"覆盖（bundle 签名的对象就是它 + `_CodeSignature/CodeResources`）。
 */
export function signingOrder(paths, mainExecutable = null) {
  const norm = (p) => p.replace(/\\/g, "/");
  const rest = paths.map(norm).filter((p) => p !== mainExecutable);
  const depth = (p) => p.split("/").length;
  return [...rest].sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
}

/** 纯函数：签名的**判定**（单测用；不做 IO）。`problems` 为空才算过。 */
export function signOutcome({ preSignIdentical, libSha, vendorSha, verifyDeepStrictPassed, verifyOutput, signedCount }) {
  const problems = [];
  if (!preSignIdentical) {
    problems.push(
      `签名**之前**包内的 libpdfium.dylib 就与 vendor 不一致（${String(libSha).slice(0, 12)}… vs ${String(vendorSha).slice(0, 12)}…）` +
        `—— 先查拷贝那一步（tauri.macos.conf.json 的 files 映射），别在签名上找原因`,
    );
  }
  if (signedCount === 0) problems.push("包内**一个嵌套二进制都没找到**（签名链等于没做）—— 检查 contents 布局");
  if (!verifyDeepStrictPassed) {
    problems.push(
      `\`codesign --verify --deep --strict\` 没过 —— 这正是这一步要治的病。原文：\n${verifyOutput ?? "(没有输出)"}`,
    );
  }
  return problems;
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function sha256Of(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const dryRun = argv.includes("--dry-run");
  const identity = flag("--identity") ?? "-";
  const appPath = resolve(flag("--app") ?? join(root, "src-tauri", "target", "release", "bundle", "macos", "ShuyoNote.app"));

  if (!existsSync(appPath)) {
    console.error(`[sign-macos-app] ❌ 找不到 ${appPath} —— 先打包（pnpm tauri build --bundles app）`);
    process.exit(2);
  }

  // 主可执行文件名取自 Info.plist（别写死大小写：本机实测 `MacOS/ShuyoNote`，而 codesign 报的是 `shuyonote`）
  const plist = readFileSync(join(appPath, "Contents", "Info.plist"), "utf8");
  const mainExe = (/<key>CFBundleExecutable<\/key>\s*<string>([^<]*)<\/string>/.exec(plist) ?? [])[1] ?? null;

  const found = [];
  for (const dir of NESTED_DIRS) {
    const abs = join(appPath, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      const p = join(abs, name);
      if (!statSync(p).isFile()) continue;
      if (!isMachO(p)) continue;
      found.push(`${dir}/${name}`);
    }
  }
  const order = signingOrder(found, mainExe ? `Contents/MacOS/${mainExe}` : null);

  const libRel = join("Contents", "Frameworks", "libpdfium.dylib");
  const bundleLib = join(appPath, libRel);
  const vendorLib = join(root, "src-tauri", "vendor", "pdfium", "mac-univ", "lib", "libpdfium.dylib");
  const libSha = existsSync(bundleLib) ? sha256Of(bundleLib) : null;
  const vendorSha = existsSync(vendorLib) ? sha256Of(vendorLib) : null;
  // ★ 签之前的那一刻：内容一致性的**唯一可证明时刻**（签完只能证明签名有效）
  const preSignIdentical = libSha !== null && libSha === vendorSha;

  console.log(`[sign-macos-app] app=${appPath}`);
  console.log(`  身份：${identity === "-" ? "ad-hoc（`-s -`；过得了 codesign，过不了 Gatekeeper）" : identity}`);
  console.log(`  主可执行文件：Contents/MacOS/${mainExe ?? "(读不到 CFBundleExecutable)"}`);
  console.log(`  嵌套二进制 ${order.length} 个，签名顺序（由内到外）：`);
  for (const p of order) console.log(`    · ${p}`);
  console.log(
    `  libpdfium.dylib：包内 ${libSha ? libSha.slice(0, 12) + "…" : "(不在包里)"}` +
      ` · vendor ${vendorSha ? vendorSha.slice(0, 12) + "…" : "(缺)"}` +
      ` ⇒ ${preSignIdentical ? "逐字节相同 ✅（这是签之前的读数）" : "**不一致 ❌**"}`,
  );

  if (dryRun) {
    console.log("[sign-macos-app] --dry-run：到此为止（没有改动任何文件）");
    process.exit(preSignIdentical ? 0 : 1);
  }

  let signedCount = 0;
  for (const rel of order) {
    const abs = join(appPath, rel);
    try {
      run("codesign", ["--force", "--sign", identity, "--timestamp=none", abs]);
      signedCount += 1;
      console.log(`  ✅ 已签 ${rel}`);
    } catch (e) {
      console.error(`[sign-macos-app] ❌ 签 ${rel} 失败：${String(e.stderr || e.message).trim()}`);
      process.exit(1);
    }
  }

  // 最后：签整个 bundle（这一步同时覆盖主可执行文件与 `_CodeSignature/CodeResources`）
  try {
    run("codesign", ["--force", "--sign", identity, "--timestamp=none", appPath]);
    console.log("  ✅ 已签 bundle（含主可执行文件与 _CodeSignature/CodeResources）");
  } catch (e) {
    console.error(`[sign-macos-app] ❌ 签 bundle 失败：${String(e.stderr || e.message).trim()}`);
    process.exit(1);
  }

  let verifyOutput = "";
  let passed = true;
  try {
    verifyOutput = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  } catch (e) {
    passed = false;
    verifyOutput = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || String(e.message);
  }
  const afterSha = existsSync(bundleLib) ? sha256Of(bundleLib) : null;
  console.log(
    `  签后 libpdfium.dylib：${afterSha.slice(0, 12)}…（与 vendor 的差异**只应是签名**；` +
      `见文件头实测：+55,104 B）`,
  );

  const problems = signOutcome({
    preSignIdentical,
    libSha,
    vendorSha,
    verifyDeepStrictPassed: passed,
    verifyOutput,
    signedCount,
  });
  if (problems.length > 0) {
    console.error("[sign-macos-app] ❌ 不通过：");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("[sign-macos-app] ✅ 签完，且 `codesign --verify --deep --strict` 通过");
  if (identity === "-") {
    console.log("   ⚠️ 边界：这是 ad-hoc 签名 —— `spctl -a -vv` 仍会拒（Gatekeeper 要真实身份）。");
  }
}

if (isMain(import.meta.url)) main();
