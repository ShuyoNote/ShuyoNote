// macOS 打包产物的自检门禁（**不需要任何签名密钥**，可在本机与 CI 上跑）。
//
// 为什么需要它：macOS 从这一版起成为发布平台，而"签名/公证"那条链只有 release.yml 里才有密钥。
// 于是**没有密钥的地方**（每次 push、本机）就只剩一个能问的问题：**打包这一步过没过、产物对不对**。
// 这个问题值得单独守，因为这一仓库已经吃过两次"本机绿 ≠ 干净环境绿"的教训
// （Android 的 NDK ranlib 与 bindgen target 都只在 Linux runner 上暴露）。
//
// 它断言什么（都是"错了会很晚才发现"的那种）：
//   1. `bundle/macos/ShuyoNote.app` 真的存在，且是**目录**（不是 tar.gz 之类）；
//   2. Info.plist 里 `CFBundleIdentifier` 与 `tauri.conf.json` 的 `identifier` **一致**
//      （不一致 = 用户端的钥匙串/权限/更新身份全变，而打包不会报错）；
//   3. `CFBundleShortVersionString` 与 `package.json` 的版本**一致**
//      （不一致 = 装上去的版本号是错的，更新通道会做错误的比较）；
//   4. `CFBundleURLTypes` 里**注册了 `shuyonote` 协议** —— macOS 的深链就靠它。
//      判据不止"写了"，还会真的去问系统：可用 `--lsregister` 时核对 LaunchServices 认领的 scheme；
//   5. `bundle/dmg/` 下有本版本的 dmg（人工下载安装用；**更新通道用的是 .app.tar.gz**，
//      那需要签名私钥，所以不在这里断言，见 scripts/lib/releaseArtifacts.mjs）。
//
// 用法：
//   node scripts/check-macos-bundle.mjs                # 用默认 src-tauri/target/release/bundle
//   node scripts/check-macos-bundle.mjs <bundle 目录>
// 退出码：0 = 全部通过；非 0 = 有问题（逐条打印原因）。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 从 XML plist 文本里取 `<key>k</key><类型>v</类型>` 的字符串值（Tauri 写的是 XML plist）。 */
export function plistString(xml, key) {
  const re = new RegExp(`<key>${key}</key>\\s*<(string|integer)>([^<]*)</\\1>`);
  const m = re.exec(xml);
  return m ? m[2] : null;
}

/**
 * 从 XML plist 文本里取注册的全部 URL scheme。
 *
 * ⚠️ 不要写成"先匹配 CFBundleURLTypes 的 `<array>`、再在里面找 schemes"：那层数组里嵌着
 * **另一个**数组（schemes 自己的），惰性匹配会停在**内层**的 `</array>` 上，于是解析出空列表——
 * 而真实产物是有 scheme 的（`lsregister -dump` 里能看到 `claimed schemes: shuyonote:`）。
 * 这个 bug 在本脚本第一版里真的发生过：它把"有 scheme"误报成"没有"。
 * （产物里的缩进是 **Tab**，所以正则一律用 `\s`，不要写死空格。）
 */
export function plistSchemes(xml) {
  return [...xml.matchAll(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g)].flatMap((m) =>
    [...m[1].matchAll(/<string>([^<]*)<\/string>/g)].map((s) => s[1]),
  );
}

/**
 * 纯函数形式的断言（便于单测；不做任何 IO）。
 * @returns {string[]} problems，空数组表示通过
 */
export function checkBundle({ appExists, isDirectory, plistXml, expectedIdentifier, expectedVersion, dmgNames }) {
  const problems = [];
  if (!appExists) {
    problems.push("没有找到 ShuyoNote.app —— 打包这一步根本没产出 .app（`--bundles` 里漏了 app？）");
    return problems;
  }
  if (!isDirectory) problems.push("ShuyoNote.app 不是目录（看起来是别的产物被放到了这个位置）");
  if (!plistXml) {
    problems.push("读不到 ShuyoNote.app/Contents/Info.plist");
    return problems;
  }

  const id = plistString(plistXml, "CFBundleIdentifier");
  if (id !== expectedIdentifier) {
    problems.push(`Info.plist 的 CFBundleIdentifier=${id ?? "(缺失)"}，与 tauri.conf.json 的 identifier=${expectedIdentifier} 不一致`);
  }

  const ver = plistString(plistXml, "CFBundleShortVersionString");
  if (ver !== expectedVersion) {
    problems.push(`Info.plist 的 CFBundleShortVersionString=${ver ?? "(缺失)"}，与 package.json 的版本=${expectedVersion} 不一致`);
  }

  const schemes = plistSchemes(plistXml);
  if (!schemes.includes("shuyonote")) {
    problems.push(
      `Info.plist 没有注册 shuyonote 深链协议（当前是 [${schemes.join(", ")}]）——macOS 上点 shuyonote:// 链接不会被路由到本应用`,
    );
  }

  if (!dmgNames || dmgNames.length === 0) {
    problems.push("bundle/dmg 下没有 dmg —— 人工下载安装的那份产物没了（`--bundles` 里漏了 dmg？）");
  } else if (!dmgNames.some((n) => n.includes(expectedVersion))) {
    problems.push(`dmg 文件名里没有版本号 ${expectedVersion}：${dmgNames.join("、")}（拿到的是上一次构建的产物？）`);
  }

  return problems;
}

/** 问系统：LaunchServices 认领了哪些 scheme（仅 macOS 可用；其它平台返回 null）。 */
export function lsregisterSchemes(appPath) {
  if (process.platform !== "darwin") return null;
  const tool =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  if (!existsSync(tool)) return null;
  try {
    execFileSync(tool, ["-f", appPath], { stdio: "ignore" });
    const dump = execFileSync(tool, ["-dump"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    // 只看我们那个 app 那一段（从 `path:` 行到下一个分隔线），避免被别的 app 的 scheme 干扰。
    const idx = dump.indexOf(appPath);
    if (idx < 0) return null;
    const seg = dump.slice(idx, idx + 40000);
    const m = /claimed schemes:\s*([^\n]*)/.exec(seg);
    if (!m) return [];
    return m[1].split(",").map((s) => s.trim().replace(/:$/, "")).filter(Boolean);
  } catch {
    return null;
  }
}

function main() {
  const arg = process.argv[2];
  const bundleDir = arg ? resolve(arg) : join(root, "src-tauri", "target", "release", "bundle");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const version = arg ? pkg.version : conf.version; // tauri.conf 的 version 是发布真源
  const appPath = join(bundleDir, "macos", "ShuyoNote.app");
  const plistPath = join(appPath, "Contents", "Info.plist");
  const dmgDir = join(bundleDir, "dmg");

  const dmgNames = existsSync(dmgDir) ? readdirSync(dmgDir).filter((n) => n.endsWith(".dmg")) : [];
  const problems = checkBundle({
    appExists: existsSync(appPath),
    isDirectory: existsSync(appPath) && statSync(appPath).isDirectory(),
    plistXml: existsSync(plistPath) ? readFileSync(plistPath, "utf8") : null,
    expectedIdentifier: conf.identifier,
    expectedVersion: version,
    dmgNames,
  });

  // 再问一次系统（能问就问；问不了不算失败，但要如实说明）。
  const claimed = lsregisterSchemes(appPath);
  if (claimed && !claimed.includes("shuyonote")) {
    problems.push(`LaunchServices 没有把 shuyonote 认领给这个 app（认领的是 [${claimed.join(", ")}]）`);
  }

  console.log(`[check-macos-bundle] bundle=${bundleDir}`);
  console.log(`  版本 ${version} · identifier ${conf.identifier} · dmg ${dmgNames.join("、") || "(无)"}`);
  console.log(`  系统认领的 scheme：${claimed === null ? "(本机问不到，跳过)" : claimed.join("、") || "(无)"}`);
  if (problems.length > 0) {
    console.error("[check-macos-bundle] ❌ 不通过：");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("[check-macos-bundle] ✅ 通过");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
