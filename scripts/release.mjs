// ShuyoNote 发版脚本（gitcode）：桌面三平台安装包 + Android APK + Web 整包。
//
// 完整流水线：校验签名密钥/公钥 → `pnpm tauri build`（签名）→ 收集安装包+.sig（+ `--android-apk` 给的 APK）
//           → 逐项校验（版本号整词匹配 / 同平台歧义 / 缺签名 / .sig 与字节互验 /
//             缺 Android 发版件 / 线上 latest.json 的平台覆盖）→ 生成并校验 latest.json（Tauri updater 清单）
//           → 发布到 gitcode：建 release v<version>、上传 installer/.sig/APK/latest.json、
//             更新「latest」auto-update 通道。
// 检查明细见 docs/RELEASING.md ⑥；纯逻辑与单测在 scripts/lib/releaseArtifacts.mjs。
//
// 用法：
//   GITCODE_TOKEN=<令牌> TAURI_SIGNING_PRIVATE_KEY=<...> \
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<...> RELEASE_NOTES="ShuyoNote v1.64.x" \
//   node scripts/release.mjs [--dry-run] [--body <文件.md>] [--artifacts a.exe,b.deb]
//
// 可选参数：
//   --dry-run               只收集/校验/写清单，不发布
//   --no-build              跳过 `pnpm tauri build`（产物已就绪时用）
//   --artifacts <名字,…>    显式指定要发布的产物（替代「文件名含版本号」自动挑选）
//   --android-apk <路径>    Android 发版 APK（本机出不了，从 CI artifact / Release 取；缺失即失败）
//   --no-android            明确接受本次不带 Android 发版件（Android 用户本轮收不到更新）
//   --no-web                不打包/上传 Web 版（dist-web/）
//   --no-plugins            不产出第一方插件索引片段（默认：配了发布者私钥就产出）
//   --allow-platform-drop   允许本次清单丢掉线上已有的平台键（默认禁止）
//   --skip-sig-verify       跳过「.sig 确实是这些字节的签名」校验（不建议）
//
// ⚠️ Android 条目与桌面走**同一个** `platforms`：apk 没有 minisign `.sig`，所以它的
//    `signature` 写成 `sha256:<hex>`（完整性在本脚本里算）。这一点不能省——只要有一个平台
//    条目缺 `signature`，`tauri-plugin-updater` 对**整份 latest.json** 的解析就会失败，
//    桌面更新通道跟着一起挂（写盘前由 validateManifest 硬拦）。
//
// 密钥一次性生成（保密）：pnpm tauri signer generate -w ~/.tauri/shuyonote.key
// 公钥写入 src-tauri/tauri.conf.json → plugins.updater.pubkey。
import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANDROID_PLATFORM_KEY,
  INSTALLER_DIRS,
  androidApkProblems,
  coverageProblems,
  fmtSize,
  fmtTime,
  isApk,
  manifestPicks,
  selectArtifacts,
  sha256File,
  validateManifest,
  verifyArtifactSignature,
} from "./lib/releaseArtifacts.mjs";
import { packDirToZip } from "./lib/pack-zip.mjs";

/** 放进 Web 版压缩包里的一页说明：自托管时最容易踩的两个坑都在这里。 */
const WEB_HOSTING_NOTE = `ShuyoNote Web 版（纯静态，自己托管即可）

这是一个**静态站点**：把本目录里的全部文件原样放到任意静态服务器/对象存储上就行
（放在子路径也可以，构建时用的是相对路径）。

两件必须注意的事：

1) **不要把文件漏掉**。目录里有几个文件不在 index.html 的静态引用里，是运行时才加载的：
   · assets/sql-wasm-*.wasm   （sql.js 的 WebAssembly，数据库就是它）
   · assets/pdf.worker.min-*.mjs（PDF 预览的 worker）
   只按 index.html 里出现的文件名去挑选，会漏掉它们 —— 表现是"页面能打开、但数据库初始化
   失败、所有操作报错"。**按本压缩包的全量清单同步**最稳妥。

2) **.wasm 要以 application/wasm 提供**（有些服务器默认给 application/octet-stream，
   这时 WebAssembly.instantiateStreaming 会失败）。Nginx 里加一行即可：
     types { application/wasm wasm; }

另外：数据全部存在**浏览器本地**（IndexedDB），服务器上不留任何笔记内容；换浏览器/清站点数据
等于换一份数据，重要内容请用应用内的备份导出。多设备同步与磁盘插件需要桌面版。
`;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const TAG = "v" + version;
const DRY = process.argv.includes("--dry-run");
const NO_BUILD = process.argv.includes("--no-build");
const NO_WEB = process.argv.includes("--no-web");
const NO_PLUGINS = process.argv.includes("--no-plugins");
const NO_ANDROID = process.argv.includes("--no-android");

// ---- 前置：git tag vX.Y.Z 必须已存在并推到远程 ----
//
// ⚠️ **`--skip-tag-guard`（只在 `--dry-run` 下有效）**：跳过下面两道 tag 守卫。
// 两个真实用途：
//   ① **预演**：tag 还没建，先看看清单会长什么样；
//   ② **干净检出里跑端到端门禁**（`scripts/release-manifest.test.mjs`）—— CI 的 `actions/checkout`
//      不带 tag，于是那道守卫把**测试自己**挡在门外，现象是"门禁在 CI(Linux) 恒红、在本机（有 tag）恒绿"。
//      2026-09-17 实测：vitest 门禁在 Linux 上连红三次，根因就是这条（CI 注解点出了用例名与这句报错）。
// 真发布（不带 `--dry-run`）**永远照旧拦** —— 两道守卫都是有原因的（tag 不存在会静默失败/不触发构建）。
const SKIP_TAG_GUARD_REQUESTED = process.argv.includes("--skip-tag-guard") || process.env.SHUYONOTE_SKIP_TAG_GUARD === "1";
if (SKIP_TAG_GUARD_REQUESTED && !DRY) {
  console.error("[release] --skip-tag-guard 只在 --dry-run 下有效：真发布必须有 tag（两道守卫都是有原因的）。");
  process.exit(1);
}
const SKIP_TAG_GUARD = SKIP_TAG_GUARD_REQUESTED && DRY;
// gitcode 的 release 创建 API 用 tag_name 定位 tag；tag 不存在会「静默失败」
// （release 未建、latest.json 不更新，客户端就查不到更新——曾实际踩坑）。
// ⚠️ tag 必须**两个远端都推**：`origin`(gitcode) 是应用内「检查更新」与下载通道，
// 而 `.github/workflows/release.yml` 是 **GitHub Actions** 的工作流，只有 **`github`
// 那个仓库收到 `v*` tag** 才会跑——只推 origin，多平台构建（含 Android 发版件）
// **根本不会开始**（详见 docs/RELEASING.md ④）。下面只按 origin 做前置校验，
// 因为它是发布这一步的必需条件；github 缺 tag 不阻断发布本身，但会让发版件一个都不产出。
// 这里在发布前尽早拦住，而不是等发布后才发现查不到更新。
if (SKIP_TAG_GUARD) {
  console.warn(`[release] ⚠️ --dry-run --skip-tag-guard：跳过 tag 守卫（${TAG}）。这只用于预演与端到端门禁。`);
} else {
  try {
    execSync(`git rev-parse --verify --quiet refs/tags/${TAG}`, { stdio: "ignore" });
  } catch {
    console.error(`[release] 本地缺少 git tag ${TAG}。请先：git tag ${TAG} && git push origin ${TAG} && git push github ${TAG} 再发布。`);
    process.exit(1);
  }
  try {
    const remote = execSync(`git -c http.proxy= -c https.proxy= ls-remote --tags origin ${TAG}`, { encoding: "utf8" }).trim();
    if (!remote) {
      console.error(`[release] 远程缺少 git tag ${TAG}。请先：git push origin ${TAG} && git push github ${TAG} 再发布。`);
      process.exit(1);
    }
  } catch {
    console.error(`[release] 无法确认远程 tag ${TAG}（网络/认证）。请先：git push origin ${TAG} && git push github ${TAG} 再发布。`);
    process.exit(1);
  }
}


// ---- 前置：签名私钥 + 公钥 ----
// 私钥只在**本机构建并签名**时才用得到（`pnpm tauri build` 从 env 读它）。
// `--no-build` 走的正是 docs/RELEASING.md ⑤/⑥ 那条路：产物已由 GitHub Actions
// （或 Windows 机器）用同一把密钥签好，本机只负责「发布」——此时本机没有私钥是正常的，
// 不该因此拦住发布。缺私钥 + 需要构建 = 真问题；缺私钥 + 不构建 = 正常。
const key = process.env.TAURI_SIGNING_PRIVATE_KEY;
if (!key && !NO_BUILD) {
  console.error("[release] 缺 TAURI_SIGNING_PRIVATE_KEY（保密私钥）。");
  process.exit(1);
}
if (!key && NO_BUILD) {
  console.log("[release] --no-build：本机不签名，跳过私钥检查（产物必须自带 .sig）。");
}
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const pubKey = conf?.plugins?.updater?.pubkey ?? "";
if (!pubKey) { console.error("[release] tauri.conf.json 缺 plugins.updater.pubkey。"); process.exit(1); }
if (pubKey.includes("RWQxMjM0NTY3")) console.warn("[release] ⚠️ pubkey 仍是占位符，请替换为真实公钥。");

const token = process.env.GITCODE_TOKEN;
if (!token && !DRY) { console.error("[release] 发布需 GITCODE_TOKEN（--dry-run 可跳过）。"); process.exit(1); }
const OWNER = process.env.GITCODE_OWNER ?? "shuyo-cn";
const REPO = process.env.GITCODE_REPO ?? "ShuyoNote";
const API = `https://gitcode.com/api/v5/repos/${OWNER}/${REPO}`;
const GH = { "PRIVATE-TOKEN": token, Authorization: `Bearer ${token}` };
const J = { ...GH, "Content-Type": "application/json; charset=utf-8" };

async function apiFetch(method, url, body) {
  const opts = { method, headers: method === "GET" ? GH : J };
  if (body !== undefined) opts.body = body;
  const r = await fetch(url, opts);
  // 错误里**只带状态码与方法/URL**：token 走在请求头里，任何把 headers 或整个
  // 请求对象塞进 message 的写法都会把它带进日志（同类事故见 scripts/lib/redact.mjs 的头注）。
  if (!r.ok) throw new Error(`${r.status} ${method} ${url}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// ---- 构建 + 签名 ----
console.log(`[release] ${NO_BUILD ? "跳过构建（--no-build，产物须已就绪）" : `构建 v${version}（签名）`}…`);
if (!DRY && !NO_BUILD) execSync(`pnpm tauri build`, { stdio: "inherit", env: process.env });

// ---- 收集候选产物 ----
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const explicit = (argOf("--artifacts") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SKIP_SIG = process.argv.includes("--skip-sig-verify");
const ALLOW_DROP = process.argv.includes("--allow-platform-drop");

const bundleDir = join(root, "src-tauri", "target", "release", "bundle");
const entries = [];
for (const dir of INSTALLER_DIRS) {
  const d = join(bundleDir, dir);
  if (!existsSync(d)) continue;
  for (const name of readdirSync(d)) {
    const file = join(d, name);
    const st = statSync(file);
    if (!st.isFile()) continue; // AppDir/、解包目录等中间产物
    const sigPath = file + ".sig";
    const hasSig = existsSync(sigPath);
    entries.push({
      dir,
      name,
      file,
      size: st.size,
      mtimeMs: st.mtimeMs,
      sigPath: hasSig ? sigPath : null,
      sigText: hasSig ? readFileSync(sigPath, "utf8") : null,
    });
  }
}

const { picked, problems, warnings } = selectArtifacts({ entries, version, explicit });
for (const w of warnings) console.warn(`[release] ⚠️ ${w}`);
// 一次列全所有问题再中止（歧义/缺签名/什么都没找到），不用反复试
if (problems.length > 0) {
  console.error(`[release] 产物检查未通过（${problems.length} 项）：`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("[release] 未做任何发布。");
  process.exit(1);
}
console.log(`[release] 选中 ${picked.length} 个桌面产物：${picked.map((a) => a.name).join("、") || "(无)"}`);

// ---- Android 发版件（APK）：**必须显式提供**，缺了就失败 ----
//
// 为什么它不像桌面产物那样从 bundle 目录里扫：本机（Windows）**出不了** Android 包
// （卡在 OpenSSL 源码构建与 mupdf 的 Makefile 假设上，见 docs/RELEASING.md §9 开头），
// 所以 apk 一律是 CI 产出后再拿过来的一**个外部文件**。
//
// 为什么缺包要硬失败：一旦本次清单里没有 android-aarch64，Android 用户的更新通道就
// **静默消失**（发布时毫无征兆，用户点「检查更新」才发现）；而线上已经有这个键时，
// 下面的平台覆盖检查会再拦一次。要明确跳过只能写 --no-android。
//
// 下面把它 push 进 `picked`：于是"签名互验（跳过）、指纹、清单挑选、上传"这几步都自动
// 覆盖到它，不需要第二套并行逻辑。
let androidApk = null;
const androidArg = argOf("--android-apk");
if (NO_ANDROID) {
  console.warn(
    androidArg
      ? `[release] ⚠️ --no-android：忽略 --android-apk ${androidArg}，本次清单不含 android-aarch64。`
      : "[release] ⚠️ --no-android：本次清单不含 android-aarch64（Android 用户本轮收不到更新）。",
  );
} else {
  // resolve（不是 join）：apk 是外部文件，允许给**绝对路径**（`join` 会把 `C:\…` 拼在仓库根后面）。
  const apkPath = androidArg ? resolve(root, androidArg) : null;
  const apkName = apkPath ? basename(apkPath) : null;
  const apkStat = apkPath && existsSync(apkPath) ? statSync(apkPath) : null;
  const apkCheck = androidApkProblems({
    name: apkName,
    version,
    exists: apkStat !== null,
    statIsFile: apkStat ? apkStat.isFile() : undefined,
  });
  for (const w of apkCheck.warnings) console.warn(`[release] ⚠️ ${w}`);
  if (apkCheck.problems.length > 0) {
    console.error("[release] Android 发版件检查未通过：");
    for (const p of apkCheck.problems) console.error(`  ✗ ${p}`);
    console.error("[release] 未做任何发布。");
    process.exit(1);
  }
  // sigPath: null 是**有意**的：apk 没有 minisign `.sig`（签名在包内，由 apksigner 打上、
  // 安装时由系统安装器强制校验），所以它不参与 `.sig` 互验、也不上传 `.sig`；
  // 清单里用 sha256 记录本次发布的字节指纹。selectArtifacts 已为 apk 开了显式例外。
  androidApk = { name: apkName, file: apkPath, size: apkStat.size, mtimeMs: apkStat.mtimeMs, sigPath: null, sigText: null };
  console.log(`[release] Android 发版件：${apkName}（${fmtSize(androidApk.size)}）`);
  console.log(
    "[release] 说明：apk 没有 minisign `.sig`（它的签名在包内，由 apksigner 打上、安装时由系统安装器强制校验），" +
      "所以它不参与 `.sig` 互验、也不上传 `.sig`；清单里用 sha256 记录本次发布的字节指纹。",
  );
  picked.push(androidApk);
  console.log(`[release] 本次共 ${picked.length} 个产物：${picked.map((a) => a.name).join("、")}`);
}

// ---- 校验 .sig 确实是这些字节的签名（Tauri 更新器做的就是这件事）----
// 拦的是「安装包与 .sig 不是同一次构建的一对」——这种事故发布时毫无征兆，
// 只在用户点「检查更新」时才炸。Tauri 用 minisign 预哈希模式：BLAKE2b-512 + ed25519。
// **apk 跳过**：它没有 `.sig`（见上）。
if (!SKIP_SIG) {
  console.log("[release] 校验签名…");
  const bad = [];
  for (const a of picked) {
    if (isApk(a.name)) {
      console.log(`  — ${a.name}：apk 无 minisign .sig，跳过（完整性由清单里的 sha256 记录，安装签名由系统安装器强制）`);
      continue;
    }
    const r = await verifyArtifactSignature({ filePath: a.file, sigText: a.sigText, publicKey: pubKey });
    if (r.status === "ok") console.log(`  ✓ ${a.name}`);
    else if (r.status === "unsupported") console.warn(`  ⚠️ ${a.name}：${r.detail}（跳过校验，不阻断）`);
    else {
      console.error(`  ✗ ${a.name}：${r.detail}`);
      bad.push(a.name);
    }
  }
  if (bad.length > 0) {
    console.error(`[release] ${bad.length} 个产物的签名校验失败，已中止（发布出去会让用户更新时报校验错误）。`);
    process.exit(1);
  }
} else {
  console.warn("[release] ⚠️ --skip-sig-verify：跳过签名校验（发布风险自负）。");
}

// ---- 指纹（事后可与 CI 产物逐个比对）----
console.log("[release] 产物指纹（sha256）：");
for (const a of picked) {
  a.sha256 = await sha256File(a.file);
  console.log(`  ${a.sha256}  ${fmtSize(a.size).padStart(9)}  ${fmtTime(a.mtimeMs)}  ${a.name}`);
}

// ---- Web 版：一起发布（自己托管用得上，也省得别人为了自部署去构建一遍）----
//
// 它**不进 latest.json**（不是 updater 产物、也没有 `.sig`）：更新的那套东西只认真实安装包。
// 但"发布物里带上 Web 版"是有意义的——Web 版是纯静态文件，任何人都能自己托管一份；
// 而这些静态资源里有 sql.js 的 wasm 与 pdf worker 这类**运行时才加载**的文件，
// 让发布者去猜该传哪些文件，正是 v1.84.1 那类事故的来源。
const webDir = join(root, "dist-web");
let webZip = null;
if (!NO_WEB && existsSync(join(webDir, "index.html"))) {
  const webVersion = existsSync(join(webDir, "version.json"))
    ? JSON.parse(readFileSync(join(webDir, "version.json"), "utf8")).version
    : null;
  if (webVersion !== version) {
    console.error(
      `[release] dist-web 的 version.json 是 ${webVersion ?? "(缺失)"}，而本次发的是 ${version}。` +
        `
          先跑 pnpm build:web（或加 --no-web 明确跳过 Web 版）。`,
    );
    process.exit(1);
  }
  const zipName = `ShuyoNote_${version}_web.zip`;
  const zipPath = join(root, "src-tauri", "target", "release", zipName);
  // 先在临时目录里铺一份副本，再往里放一份"怎么自托管"的说明——
  // 说明只进 zip，不进 dist-web（Pages 线上不该多出这么个文件）。
  const stage = join(root, "src-tauri", "target", "release", `web-stage-${version}`);
  rmSync(stage, { recursive: true, force: true });
  cpSync(webDir, stage, { recursive: true });
  // 文件名用 ASCII：macOS 的 zip 不给非 ASCII 名字打 UTF-8 标记，中文名到 Windows 上
  // 解出来就是乱码（实测过一次）。内容照旧是中文。
  writeFileSync(join(stage, "SELF-HOST.txt"), WEB_HOSTING_NOTE, "utf8");
  rmSync(zipPath, { force: true });
  // 用仓库里的跨平台打包器，**不要**调系统的 `zip`。
  //
  // 这里原先写的是「用系统的 zip：它到处都有」——那个假设是错的：Windows 上根本没有
  // `zip`（实测：`'zip' is not recognized as an internal or external command`），
  // 于是**从 Windows 发版就会在这里崩掉**，而 macOS 侧一切正常，所以一直没人发现。
  // 同一个坑在 `plugin-fragment.mjs` 里已经踩过一次（Windows 上 3 条测试红），
  // 当时的修法就是把打包收敛到 `scripts/lib/pack-zip.mjs`——这里是同一处的另一半。
  //
  // `flat: true` 才是原来 `cd <stage> && zip -qr out.zip .` 的形状：条目平铺在包根，
  // 用户解开就是站点根（多一层 web-stage-x/ 会让"解压到静态服务器"直接出错）。
  const packed = packDirToZip(stage, zipPath, { flat: true });
  rmSync(stage, { recursive: true, force: true });
  webZip = { name: zipName, path: zipPath, size: statSync(zipPath).size };
  console.log(
    `[release] Web 版打包 → ${zipName}（${fmtSize(webZip.size)}，${packed.fileCount} 个文件）`,
  );
} else if (!NO_WEB) {
  console.log("[release] 没找到 dist-web/：跳过 Web 版（要带上就先 pnpm build:web）。");
}

// ---- 第一方插件 → 索引片段（给社区合并用）----
//
// 为什么放在发布流程里：社区侧只做"合并片段 + 签索引 + 托管"，**不写条目、不碰包字节、
// 也不持有我们的发布者私钥**。所以供给侧的片段必须在发版时产出，字段齐全
// （downloadUrl / size / sha256 / publisherKey / signature / permissions / minAppVersion）。
//
// **私钥不进仓库、也不进 CI 的普通变量**：只从环境变量读一个**路径**。
// 没配就明确跳过并说清后果（这一版的第一方插件不进社区索引）——不做"静默跳过"。
const PUBLISHER_KEY = process.env.SHUYONOTE_PUBLISHER_KEY ?? "";
let pluginPackages = [];
let fragmentPath = null;
if (NO_PLUGINS) {
  console.log("[release] --no-plugins：跳过第一方插件片段。");
} else if (!PUBLISHER_KEY) {
  console.log(
    "[release] 未配置 SHUYONOTE_PUBLISHER_KEY（发布者私钥路径）：跳过第一方插件片段 —— " +
      "这一版的第一方插件不进社区索引（社区索引里不会有它们的条目）。",
  );
} else {
  const minisign = process.env.SHUYONOTE_MINISIGN ?? "minisign";
  const pub = process.env.SHUYONOTE_PUBLISHER_PUB ?? PUBLISHER_KEY.replace(/\.key$/, ".pub");
  const fragOut = join(root, "src-tauri", "target", "release", "plugin-fragment");
  rmSync(fragOut, { recursive: true, force: true });
  console.log(`[release] 打包第一方插件 → 索引片段（minisign: ${minisign}）…`);
  // 失败要说人话：`execSync` 默认把一整个栈丢出来，看起来像"发布脚本自己坏了"，
  // 而真实原因通常是"这台机器没装 minisign"。所以这里接住并给两条出路。
  const fragmentCmd = (() => { try { execSync(
    [
      "node",
      JSON.stringify(join(root, "scripts", "plugin-fragment.mjs")),
      "--plugins",
      JSON.stringify(join(root, "examples", "plugins")),
      "--out",
      JSON.stringify(fragOut),
      "--version",
      version,
      "--url-base",
      `https://gitcode.com/${OWNER}/${REPO}/releases/download/${TAG}`,
      "--minisign",
      JSON.stringify(minisign),
      "--key",
      JSON.stringify(PUBLISHER_KEY),
      "--pub",
      JSON.stringify(pub),
    ].join(" "),
    { stdio: "inherit" },
  ); } catch (e) {
    console.error(
      [
        "[release] 第一方插件片段产出失败，已中止。真实原因见上面那几行。",
        "  装了 minisign 再发，或明确加 --no-plugins 跳过（那样这一版的第一方插件不进社区索引）。",
      ].join("\n"),
    );
    process.exit(1);
  } })();
  fragmentPath = join(fragOut, "plugin-index.fragment.json");
  const fragment = JSON.parse(readFileSync(fragmentPath, "utf8"));
  pluginPackages = fragment.plugins.map((e) => {
    const zipPath = join(fragOut, `${e.id}-${e.version}.zip`);
    return { name: `${e.id}-${e.version}.zip`, path: zipPath, sigPath: `${zipPath}.minisig`, size: statSync(zipPath).size };
  });
  console.log(`[release] 插件片段 → ${fragmentPath}（${pluginPackages.length} 个包）`);
  console.log(
    "[release] 交出去之前请用应用真正的解析器验一遍：\n" +
      `  SHUYONOTE_INDEX_FIXTURE=${join(fragOut, "plugin-index.preview.json")} cargo test --lib external_index -- --ignored --nocapture`,
  );
}

// ---- 生成 latest.json（updater 清单）----
// 同一平台键只能留一个 url：取哪个由 manifestPicks 写死偏好，不靠遍历顺序。
// apk 也走这里（platformKeyFor 把它归到 android-aarch64），于是 Android 与桌面在
// **同一份清单、同一套结构**里，客户端不需要第二条通道。
const { picks, notes } = manifestPicks(picked);
for (const n of notes) console.log(`[release] ${n}`);
const notes_ = process.env.RELEASE_NOTES ?? `ShuyoNote v${version}`;
const platforms = {};
for (const [key, a] of picks) {
  // apk 没有 minisign `.sig`：signature 写 `sha256:<hex>`（字节指纹在上面指纹那一步算过）。
  // 千万别为了"省事"省略 signature —— 见 validateManifest 的注释（会让整份清单解析失败）。
  platforms[key] = {
    signature: isApk(a.name) ? `sha256:${a.sha256}` : a.sigText.trim(),
    url: `https://gitcode.com/${OWNER}/${REPO}/releases/download/${TAG}/${a.name}`,
  };
}

// ---- 平台覆盖检查：别把线上已有的平台键悄悄砍掉 ----
// 少一个键 = 该平台用户从此收不到更新，而且没有任何报错。
//
// ⚠️ 下面这个环境变量是**仅测试注入**（test-only）：`SHUYONOTE_PREV_MANIFEST_JSON=<文件路径>` 时读本地
// 那份当"线上清单"，不发请求、不管 `--dry-run`。**生产发布不要设置它**（设置了就等于把"线上真实状态"
// 换成一份本地文件，覆盖检查会以那份文件为基准）。
//
// 理由（为什么需要这个注入点）：覆盖检查拦的是"线上已有 android-aarch64、本次却没有"这类事故，
// 而线上在 Android 通道上线前**本来就没有**这个键——那就没有任何真实输入能证明这条检查真的会拦
// （一条不会被触发的门禁等于没有）。给它一个注入点，才能用真脚本跑出"该红就红"。
//
// ⚠️ 它**不削弱**门禁：注入点只替换**比较基准**（输入数据），检查逻辑本身一个字都没改——
// 下面照样走 `coverageProblems()`，该 `exit(1)` 还是 `exit(1)`（要放行只能显式写
// `--allow-platform-drop`）。设置时会在下面打印一条醒目警告，日志里也留下用的是哪份文件、有哪几个键。
const prevManifestUrl = `https://gitcode.com/${OWNER}/${REPO}/releases/download/latest/latest.json`;
/** ⚠️ **仅测试注入**（test-only）：模拟"线上已有的平台键"，用来验证覆盖检查门禁真的会拦。
 *  **生产发布不要设置**——真实发布必须让脚本自己去读线上 `latest.json`。 */
const prevFixture = process.env.SHUYONOTE_PREV_MANIFEST_JSON ?? "";
if (prevFixture) {
  // 醒目警告：这条一旦被带进真实发布，覆盖检查的基准就不是线上真实状态了。
  console.warn(
    `[release] ⚠️ SHUYONOTE_PREV_MANIFEST_JSON 已设置（${prevFixture}）：` +
      "本次只用于测试覆盖检查，不代表线上真实状态（生产发布不要设置）。",
  );
}
let prevKeys = [];
try {
  if (prevFixture) {
    const prev = JSON.parse(readFileSync(prevFixture, "utf8"));
    prevKeys = Object.keys(prev.platforms ?? {});
    console.log(`[release] 用注入的「线上清单」做覆盖检查：${prevFixture}（v${prev.version}：${prevKeys.join(", ") || "(无平台)"}）`);
  } else {
    const r = await fetch(prevManifestUrl, { headers: { "User-Agent": "ShuyoNote-release" } });
    if (r.status === 404) {
      console.log("[release] 线上还没有 latest 清单（首次发布），跳过平台覆盖检查。");
    } else if (!r.ok) {
      throw new Error(`${r.status} GET latest.json`);
    } else {
      const prev = JSON.parse(await r.text());
      prevKeys = Object.keys(prev.platforms ?? {});
      console.log(`[release] 线上清单 v${prev.version}：${prevKeys.join(", ") || "(无平台)"}`);
    }
  }
} catch (e) {
  if (DRY) console.warn(`[release] ⚠️ 读不到线上 latest.json（${e.message}），--dry-run 下跳过覆盖检查。`);
  else {
    console.error(`[release] 读不到线上 latest.json（${e.message}）：无法确认不会砍掉某个平台的更新通道。`);
    console.error("[release] 网络确实不通时可用 --allow-platform-drop 明确接受风险。");
    process.exit(1);
  }
}
// --no-android 是**显式**接受"本轮不带 Android"：那就把 android 键从比较基准里摘掉，
// 免得到时候还得再叠一个 --allow-platform-drop（两个逃生口叠在一起才发得出去，
// 反而会让人干脆两个都加上）。摘掉这一条本身会打日志、且写进产物清单，可事后审计。
if (NO_ANDROID && prevKeys.includes(ANDROID_PLATFORM_KEY)) {
  console.warn(`[release] ⚠️ --no-android：本轮有意不带 ${ANDROID_PLATFORM_KEY}（线上有，Android 用户本轮收不到更新）。`);
  prevKeys = prevKeys.filter((k) => k !== ANDROID_PLATFORM_KEY);
}
const dropped = coverageProblems({ previousKeys: prevKeys, nextKeys: Object.keys(platforms) });
if (dropped.length > 0) {
  if (ALLOW_DROP) for (const d of dropped) console.warn(`[release] ⚠️ --allow-platform-drop：${d}`);
  else {
    for (const d of dropped) console.error(`  ✗ ${d}`);
    console.error(`[release] 本次清单只有 ${Object.keys(platforms).join(", ")}，已中止；确认要这样发就加 --allow-platform-drop。`);
    process.exit(1);
  }
}

// ---- 写盘前的清单门禁 ----
// 每个平台条目必须同时有 url（绝对 https）与 signature（非空）。少任何一个都会让
// tauri-plugin-updater 解析**整份** latest.json 失败 ⇒ 桌面更新通道一起挂。
// 放在写盘前，是为了"失败的清单一个字节都不落盘"。
const manifest = { version, notes: notes_, pub_date: new Date().toISOString(), platforms };
const manifestCheck = validateManifest(manifest);
for (const w of manifestCheck.warnings) console.warn(`[release] ⚠️ ${w}`);
if (manifestCheck.problems.length > 0) {
  console.error(`[release] latest.json 校验未通过（${manifestCheck.problems.length} 项）：`);
  for (const p of manifestCheck.problems) console.error(`  ✗ ${p}`);
  console.error("[release] 未写盘、未发布。");
  process.exit(1);
}
console.log(`[release] latest.json 校验通过：${Object.keys(platforms).join(", ")}（每项均有 https url 与非空 signature）`);

const manifestPath = join(root, "src-tauri", "target", "release", "latest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`[release] latest.json → ${manifestPath}（${Object.keys(platforms).join(", ")}）`);
const auditPath = join(root, "src-tauri", "target", "release", "release-artifacts.json");
writeFileSync(
  auditPath,
  JSON.stringify(
    {
      version,
      tag: TAG,
      at: new Date().toISOString(),
      artifacts: picked.map(({ name, size, sha256, dir }) => ({ name, dir, size, sha256 })),
      // Web 版单独列：它不参与更新清单，但发布物里有它，事后要能核对
      web: webZip ? { name: webZip.name, size: webZip.size, sha256: await sha256File(webZip.path) } : null,
      // 第一方插件包同样单独列：它们不进更新清单，但社区索引会长期引用它们的 sha256
      plugins: pluginPackages.length
        ? await Promise.all(
            pluginPackages.map(async (p) => ({ name: p.name, size: p.size, sha256: await sha256File(p.path) })),
          )
        : null,
      pluginFragment: fragmentPath ? basename(fragmentPath) : null,
    },
    null,
    2,
  ) + "\n",
);
console.log(`[release] 产物指纹清单 → ${auditPath}`);

// ---- 发布到 gitcode ----
if (DRY) {
  console.log("[release] --dry-run：跳过发布。产物与清单已就绪。");
  console.log(`  平台：${Object.keys(platforms).join(", ")}`);
  process.exit(0);
}
async function uploadFile(releaseTag, name, path) {
  const up = await apiFetch("GET", `${API}/releases/${releaseTag}/upload_url?file_name=${encodeURIComponent(name)}`);
  const r = await fetch(up.url, { method: "PUT", headers: up.headers ?? {}, body: readFileSync(path) });
  if (!r.ok) throw new Error(`${r.status} PUT ${name}`);
  console.log(`  上传 ${name}`);
  await new Promise((res) => setTimeout(res, 500)); // 等 OBS 回调
}
async function deleteAttach(releaseTag, name) {
  const rel = await apiFetch("GET", `${API}/releases/tags/${releaseTag}`);
  for (const a of rel.assets ?? []) {
    if (a.type === "attach" && a.name === name) {
      await apiFetch("DELETE", `${API}/releases/${releaseTag}/attach_files/${a.id}`);
      console.log(`  删除 ${name}@${releaseTag}`);
      return;
    }
  }
}
const bi = process.argv.indexOf("--body");
const body = bi >= 0 && process.argv[bi + 1]
  ? readFileSync(process.argv[bi + 1], "utf8")
  : `# ShuyoNote v${version}\n\n${notes_}\n\n## 安装（Windows x64）\n下载 \`ShuyoNote_${version}_x64-setup.exe\` 运行即可。`;

try {
  await apiFetch("GET", `${API}/releases/tags/${TAG}`);
} catch {
  await apiFetch("POST", `${API}/releases`, JSON.stringify({ tag_name: TAG, name: `ShuyoNote v${version}`, body, prerelease: false }));
  console.log(`  创建 release ${TAG}`);
}
for (const a of picked) {
  await uploadFile(TAG, a.name, a.file);
  // apk 没有独立的 `.sig` 文件（签名在包内），上传它只会 404/空文件。
  if (isApk(a.name)) continue;
  await uploadFile(TAG, a.name + ".sig", a.sigPath);
}
if (webZip) {
  await deleteAttach(TAG, webZip.name);
  await uploadFile(TAG, webZip.name, webZip.path);
}
// 第一方插件包与片段：包要能被社区索引长期引用（名字带版本号，资源不可覆盖重传）。
for (const p of pluginPackages) {
  await uploadFile(TAG, p.name, p.path);
  await uploadFile(TAG, `${p.name}.sig`, p.sigPath);
}
if (fragmentPath) {
  await uploadFile(TAG, basename(fragmentPath), fragmentPath);
}
await uploadFile(TAG, "latest.json", manifestPath);
// 确保 `latest`（auto-update 通道）release 存在：首次发布时 gitcode 可能只有
// `latest` 这个 git tag、尚无对应 release，`GET /releases/tags/latest` 会 404，
// 导致 deleteAttach 报错中断。不存在则先创建，再更新其 latest.json。
try {
  await apiFetch("GET", `${API}/releases/tags/latest`);
} catch {
  await apiFetch("POST", `${API}/releases`, JSON.stringify({ tag_name: "latest", name: "ShuyoNote latest", body: "最新版本（auto-update 通道）", prerelease: false }));
  console.log("  创建 release latest");
}
await deleteAttach("latest", "latest.json");
await uploadFile("latest", "latest.json", manifestPath);
await apiFetch("PATCH", `${API}/releases/${TAG}`, JSON.stringify({ name: `ShuyoNote v${version}`, body }));
console.log(`[release] 完成 ✅ v${version}（含 latest 通道）`);
if (fragmentPath) {
  console.log(
    [
      "[release] 别忘了最后一步：把 plugin-index.fragment.json 交给索引托管方（先传包、后传索引）。",
      `  片段：${fragmentPath}`,
      "  交出去之前两边各验一遍：托管方跑 pnpm check:plugin-hosting --url <索引地址>；我们这边 CI 已在跑。",
    ].join("\n"),
  );
}

// tag 与分支都要推**两个远端**：`github` 收到 `v*` tag 才会跑
// `.github/workflows/release.yml`（桌面三平台 + Android 发版件都从那儿产出），
// `origin`(gitcode) 是应用内「检查更新」的下载通道与镜像——少推任一个都缺一半
// （见 docs/RELEASING.md ④）。
console.log("\n发布后：git tag v" + version + " && git push origin v" + version + " && git push github v" + version + " && git push origin main && git push github main");
