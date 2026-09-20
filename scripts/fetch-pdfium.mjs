// 按「钉死的版本 + 校验和」拉取 PDFium 动态库，解到 src-tauri/vendor/pdfium/<平台>/。
//
// 为什么要有这个脚本（P0，见 docs/plans/2026-09-16-pdfium-engine-plan.md）：
//   · `pdfium-render` 运行时用 libloading 加载 `pdfium.dll`/`.so`/`.dylib`，**库不在包里**；
//   · 商用交付不许"下载了就塞进安装包"——版本与校验和必须可查、可复现、可校验。
//
// 钉死的版本：**Chromium 151.0.7881.0（BUILD=7881）**，与 `pdfium-render` 的 `pdfium_7881` feature 对齐。
// 该构建的 args.gn：`pdf_enable_v8=false`、`pdf_enable_xfa=false`、`pdf_is_standalone=true`、`is_debug=false`
// —— 即**不带 JS 引擎的独立 release 构建**，正是本项目（只做光栅化）需要的。
//
// 用法：
//   node scripts/fetch-pdfium.mjs                  # 取当前平台
//   node scripts/fetch-pdfium.mjs --platform win-x64
//   node scripts/fetch-pdfium.mjs android-arm64    # 位置形式，与 `--platform` 等价（workflow 里用的就是它）
//   node scripts/fetch-pdfium.mjs --check          # 只校验已解出的库是否与记录一致（CI 用）
//   node scripts/fetch-pdfium.mjs --print-sha256 <文件>   # 算某平台包的 sha256（补 SHA256 表用）
//
// ⚠️ 平台名**认不出就当场 exit 2**（`scripts/lib/pdfium-target.mjs` 里那条判据）：
//   写错的名字不许静默回落成"当前平台"——那正是 2026-09-20 安卓 CI 变红的原因
//   （工作流写的是 `… android-arm64`，只认 `--platform` 的旧版把它当没写）。
//
// ⚠️ DNS 被污染的环境（本机就是）：GitHub 的 release 资产走 objects.githubusercontent.com，
//   直连会卡死。先解析真实 IP，再让脚本用 curl 带 --resolve：
//     node -e "fetch('https://dns.alidns.com/resolve?name=objects.githubusercontent.com&type=1').then(r=>r.json()).then(j=>console.log(j.Answer.map(a=>a.data).join(',')))"
//     $env:PDFIUM_RESOLVE = "github.com:20.205.243.166,objects.githubusercontent.com:185.199.108.133"
//   （实测：Fastly 的 .111 不通、.108 通——换一个 IP 往往就好了。）
//
// 交付前建议改为**自建**（Chromium 工具链）并更新本文件的校验和；预编译包仅用于开发期验证。

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePlatform } from "./lib/pdfium-target.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = join(root, "src-tauri", "vendor", "pdfium");

/** Chromium/PDFium 构建号。改这里 = 换 PDFium 版本（必须同时改 pdfium-render 的对应 feature）。 */
const PDFIUM_BUILD = "7881";
const PDFIUM_VERSION = "151.0.7881.0";

const RELEASE_BASE = `https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F${PDFIUM_BUILD}`;

/**
 * 平台 → { asset, sha256 }。
 * `sha256` 必须由**实测**填入（`--print-sha256`），为 null 时脚本**硬失败**——
 * 宁可让人补一次校验和，也不要"悄悄下载一个来路不明的二进制"。
 *
 * ⚠️ **补校验和的正确取法（2026-09-17 实测踩出来的，别再按"下载完就记哈希"做）**：
 * 本机网络下 curl 会被 `--max-time` 截断，而**截断的文件照样算得出哈希**——
 * 直接记下去就等于把一个**错的校验和**写进仓库，之后所有人都会"校验通过"地拿到坏包。
 * 正确顺序是**先拿权威哈希，再校验下载**：
 *   1) 取同 release 里的 `pdfium-attestation.json`（Sigstore/DSSE 信封）；
 *   2) 解开 `dsseEnvelope.payload`（base64 → in-toto Statement v1），
 *      `subject[].digest.sha256` **就是权威哈希表**（含全部平台）；
 *   3) 下载后与之比对，不符就删掉重下。
 * 实测：`android-arm64` / `mac-univ` 首取即一致；**`linux-x64` / `win-arm64` 首取被截断**
 * （1,144,208 / 1,898,626 字节，都是残缺文件），重下才对；`win-x64` 的既有值也与溯源一致
 * ⇒ **这套核对本身是可靠的**，四个平台的哈希都经它验证过。
 */
const PLATFORMS = {
  "win-x64": {
    asset: "pdfium-win-x64.tgz",
    // 2026-09-16 实测 3,733,154 字节（与 GitHub release API 报告的资产大小一致）
    sha256: "73cc0de638ac2095e7445bf56a38200a5b7c7ca0e9f4ba144598f2457377ac08",
    lib: "bin/pdfium.dll",
  },
  "win-arm64": {
    asset: "pdfium-win-arm64.tgz",
    // 2026-09-17 实测 3,522,432 字节（经 attestation 交叉核对）
    sha256: "d3035d4d2cacac6ecd1a2ece197a3d702a1b2a58466276b9f870b8cb278a9d84",
    lib: "bin/pdfium.dll",
  },
  "linux-x64": {
    asset: "pdfium-linux-x64.tgz",
    // 2026-09-17 实测 3,644,759 字节（经 attestation 交叉核对）
    sha256: "1470e21b8b4a3b4ad7f85684e2da11d94f3b69a86d81dee11b9b6709d927ac1d",
    lib: "lib/libpdfium.so",
  },
  "mac-univ": {
    asset: "pdfium-mac-univ.tgz",
    // 2026-09-17 实测 7,006,774 字节（经 attestation 交叉核对）
    sha256: "df451a413c3609585e84a4a91110a9bc889cff05fe3b2db0ed817c9e90c3f7d3",
    lib: "lib/libpdfium.dylib",
  },
  "android-arm64": {
    asset: "pdfium-android-arm64.tgz",
    // 2026-09-17 实测 3,321,706 字节（经 attestation 交叉核对）
    sha256: "16d23bb86c4188d59326dc509938f59df3c417ecfdd3d2ca2f160dc5bd49a839",
    lib: "lib/libpdfium.so",
  },
};

function detectPlatform() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "win32") return arch === "arm64" ? "win-arm64" : "win-x64";
  if (process.platform === "darwin") return "mac-univ";
  if (process.platform === "linux") return "linux-x64";
  return null;
}

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** 用 curl（可选 --resolve 绕 DNS）下载。返回落盘路径。 */
function download(url, outFile) {
  const args = ["-L", "-sS", "--fail", "--connect-timeout", "15", "--max-time", "600"];
  const resolveList = (process.env.PDFIUM_RESOLVE ?? "").trim();
  if (resolveList) {
    for (const pair of resolveList.split(",")) {
      const [host, ip] = pair.split(":").map((s) => s.trim());
      if (host && ip) args.push("--resolve", `${host}:443:${ip}`);
    }
  }
  args.push("-o", outFile, url);
  console.log(`[fetch-pdfium] curl ${args.filter((a) => a !== "-sS").join(" ")}`);
  execFileSync("curl", args, { stdio: "inherit" });
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

if (flag("--print-sha256")) {
  const f = valueOf("--print-sha256");
  if (!f || !existsSync(f)) {
    console.error("用法: node scripts/fetch-pdfium.mjs --print-sha256 <已下载的 .tgz>");
    process.exit(2);
  }
  console.log(`size   : ${readFileSync(f).length}`);
  console.log(`sha256 : ${sha256File(f)}`);
  process.exit(0);
}

// 平台来自 `--platform <名>` **或**位置参数（`fetch-pdfium.mjs android-arm64`），两者等价。
// ⚠️ 这一步必须由 `resolvePlatform` 判：2026-09-20 之前只认 `--platform`，
//    而两个 workflow 里写的都是位置形式 ⇒ 参数被**静默吃掉**、回落成"当前平台"，
//    ubuntu runner 上取回 linux-x64，直到下一步 stage 才报"vendor 里没有 android-arm64 的那份库"。
//    现在**认不出的名字当场 exit 2**，不再有"写错了还跑得下去"这个状态。
const resolved = resolvePlatform(argv, { detect: detectPlatform, known: PLATFORMS });
if (resolved.error) {
  console.error(resolved.error);
  process.exit(2);
}
const platform = resolved.platform;
const spec = PLATFORMS[platform];
const outDir = join(OUT_ROOT, platform);
// ⚠️ **不要**把 `spec.lib` 里的 `/` 换成 `\`：`lib` 是**包内**的 POSIX 路径
// （`lib/libpdfium.dylib` / `lib/libpdfium.so`），`node:path` 的 `join` 会按当前平台处理分隔符。
// 2026-09-17 在 macOS 上实测到后果：原来那版 `join(outDir, spec.lib.replace(/\//g, "\\"))`
// 在 POSIX 上会得到一个**带字面反斜杠**的路径 `…/mac-univ/lib\libpdfium.dylib` ⇒ `existsSync` 恒假
// ⇒ 收尾那行打印「完成：…（0 字节）」（其实文件有 15,219,824 字节），`--check` 也会误报"缺少"。
// Windows 上因为反斜杠恰好是对的，所以这个 bug 只在 macOS/Linux 露头。
const libPath = join(outDir, spec.lib);

if (flag("--check")) {
  if (!existsSync(libPath)) {
    console.error(`[fetch-pdfium] 缺少 ${libPath} —— 先跑一次 node scripts/fetch-pdfium.mjs`);
    process.exit(1);
  }
  console.log(`[fetch-pdfium] ${platform} 就位：${libPath}（${readFileSync(libPath).length} 字节）`);
  console.log(`[fetch-pdfium] PDFium ${PDFIUM_VERSION}（build ${PDFIUM_BUILD}）`);
  process.exit(0);
}

if (!spec.sha256) {
  console.error(
    `[fetch-pdfium] ${platform} 的 sha256 尚未实测记录 —— 拒绝下载。\n` +
      `  先人工取回并核对，再把哈希填进本脚本的 PLATFORMS["${platform}"].sha256：\n` +
      `  1) 下载 ${RELEASE_BASE}/${spec.asset}\n` +
      `  2) node scripts/fetch-pdfium.mjs --print-sha256 <文件>\n` +
      `  3) 与 release 页披露的构建溯源（pdfium-attestation.json）交叉核对后再填入。`,
  );
  process.exit(1);
}

const url = `${RELEASE_BASE}/${spec.asset}`;
const tgz = join(OUT_ROOT, spec.asset);
mkdirSync(OUT_ROOT, { recursive: true });

console.log(`[fetch-pdfium] target: PDFium ${PDFIUM_VERSION} (build ${PDFIUM_BUILD}) / ${platform}`);
download(url, tgz);

const got = sha256File(tgz);
if (got !== spec.sha256) {
  rmSync(tgz, { force: true });
  console.error(
    `[fetch-pdfium] 校验和不符，已删除下载物：\n  期望 ${spec.sha256}\n  实际 ${got}\n` +
      `  —— 要么版本/资产变了，要么下载被篡改/损坏。**不要**跳过这一步。`,
  );
  process.exit(1);
}
console.log(`[fetch-pdfium] 校验和一致：${got}`);

// 解包到 <outDir>（tar 在 Win10+ 与 POSIX 都有）
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
execFileSync("tar", ["-xzf", tgz, "-C", outDir], { stdio: "inherit" });

// 记录版本与构建参数，便于交付时溯源
const versionFile = join(outDir, "VERSION");
const argsFile = join(outDir, "args.gn");
writeFileSync(
  join(outDir, "SOURCE.txt"),
  [
    `PDFium ${PDFIUM_VERSION}（build ${PDFIUM_BUILD}）`,
    `asset   : ${spec.asset}`,
    `sha256  : ${spec.sha256}`,
    `source  : ${url}`,
    `fetched : ${new Date().toISOString()}`,
    ``,
    `VERSION: ${existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim().replace(/\n/g, " ") : "(无)"}`,
    `args.gn: ${existsSync(argsFile) ? readFileSync(argsFile, "utf8").trim().replace(/\n/g, " | ") : "(无)"}`,
    ``,
    `注意：预编译包仅用于开发期验证；商用交付前建议自建并更新本记录。`,
    `该包自带 licenses/（第三方许可原文），可直接并入 THIRD-PARTY-NOTICES。`,
    ``,
  ].join("\n"),
);

const size = existsSync(libPath) ? readFileSync(libPath).length : 0;
console.log(`[fetch-pdfium] 完成：${libPath}（${size} 字节）`);
console.log(`[fetch-pdfium] 溯源记录：${join(outDir, "SOURCE.txt")}`);
