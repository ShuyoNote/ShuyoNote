// Windows 构建机自检：把"本机能不能出 Windows 发版件"需要的**硬前置**逐条问一遍。
//
// 为什么单独写一条：这些前置**漏了都不会给出清楚的报错**——
//   · 没有 OpenSSL ⇒ rusqlite(bundled-sqlcipher) 在链接期报一堆 `LNK2019 无法解析的外部符号`；
//   · 没有更新器签名密钥 ⇒ 构建能过，但**产不出 `.sig`**，而更新通道没它就等于该平台收不到更新；
//   · 没有 MSVC 链接器 ⇒ 报 `link.exe not found`，而它其实只是没进 PATH；
//   · Node/pnpm 版本不对 ⇒ 各种稀奇古怪的解析错。
// 所以这里主动问，并明确写出"缺了会怎样"。
//
// 用法：node scripts/check-windows-build-env.mjs
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const WIN = process.platform === "win32";
const home = process.env.USERPROFILE ?? process.env.HOME ?? "";

const rows = [];
const add = (name, ok, detail, consequence) => rows.push({ name, ok, detail, consequence });

function tryRun(cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim() };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? e.message ?? "").trim() };
  }
}

// ---- 平台 ----
add("平台", WIN, process.platform, "本脚本针对 Windows 构建机（macOS/Linux 走各自系统自带的 OpenSSL）");

// ---- Node / pnpm ----
const node = tryRun("node", ["-v"]);
const major = node.ok ? Number(node.out.replace(/^v/, "").split(".")[0]) : 0;
add("Node ≥ 20", major >= 20, node.out || "找不到 node", "前端构建与所有仓库脚本都跑不起来");
const pnpm = tryRun("pnpm", ["-v"]);
add("pnpm", pnpm.ok, pnpm.out || "找不到 pnpm", "`pnpm build` / `pnpm tauri build` 都跑不了（可 `corepack enable`）");

// ---- Rust / MSVC target ----
const rustc = tryRun("rustc", ["--version"]);
add("rustc", rustc.ok, rustc.out || "找不到 rustc", "出不了桌面包；装 rustup 后 `rustup default stable-msvc`");
const targets = tryRun("rustup", ["target", "list", "--installed"]);
const hasMsvc = targets.ok && targets.out.includes("x86_64-pc-windows-msvc");
add(
  "rust 目标 x86_64-pc-windows-msvc",
  hasMsvc,
  targets.ok ? targets.out.split("\n").join(", ") : "找不到 rustup",
  "Windows 上必须用 MSVC 目标（GNU 目标在 Tauri 下问题多）",
);

// ---- MSVC 链接器 ----
const link = tryRun("where", ["link.exe"]);
add(
  "MSVC 链接器（link.exe）",
  link.ok,
  link.ok ? link.out.split("\n")[0] : "PATH 里没有",
  "缺了报 `link.exe not found`。装 VS 2022 Build Tools 的「使用 C++ 的桌面开发」；命令行里需先跑 vcvars64.bat",
);

// ---- OpenSSL（rusqlite bundled-sqlcipher 要链接它） ----
// ⚠️ 2026-09-16 实测踩到：`libsqlite3-sys` 的 build.rs **不会**去猜默认安装路径，它**直接读
// `OPENSSL_DIR` 环境变量**，没设就 panic：
//     Missing environment variable OPENSSL_DIR or OPENSSL_DIR is not set
// 所以判据必须是"**环境变量设了、且指向有效安装**"，不能只看到 `C:\Program Files\OpenSSL-Win64`
// 存在就打勾（第一版就是这么写的，结果自检通过、真构建两分钟后炸在上面那行 panic）。
const opensslEnv = (process.env.OPENSSL_DIR ?? "").trim();
const opensslValid = opensslEnv !== "" && existsSync(opensslEnv) && existsSync(join(opensslEnv, "include"));
const defaultInstall = ["C:\\Program Files\\OpenSSL-Win64", "C:\\OpenSSL-Win64"].find((p) => existsSync(p));
add(
  "OPENSSL_DIR（环境变量，必须显式设）",
  opensslValid,
  opensslValid
    ? opensslEnv
    : opensslEnv === ""
      ? defaultInstall
        ? `没设，但本机有 ${defaultInstall}（装上不等于设上）`
        : "没设，也没找到默认安装"
      : `设成了 ${opensslEnv}，但那里没有 include/`,
  `缺了当场炸在 libsqlite3-sys 的 build.rs：\`Missing environment variable OPENSSL_DIR\`。` +
    (defaultInstall
      ? `本机已有 ${defaultInstall} ⇒ 只要设 \$env:OPENSSL_DIR = "${defaultInstall}" 即可。`
      : "两条装法：① 装 OpenSSL-Win64 到默认路径再设 OPENSSL_DIR；② 像 CI 那样 vcpkg 装 openssl:x64-windows-static-md 并把 OPENSSL_DIR 指过去"),
);

// ---- 更新器签名密钥（产出 .sig） ----
const key = join(home, ".tauri", "shuyonote.key");
const pw = join(home, ".tauri", "shuyonote.key.pw");
add(
  "更新器签名密钥 ~/.tauri/shuyonote.key (+ .pw)",
  existsSync(key) && existsSync(pw),
  `${existsSync(key) ? "有" : "缺"} key / ${existsSync(pw) ? "有" : "缺"} pw`,
  "缺了构建能过但**产不出 .sig**；更新通道里该平台没 signature ⇒ 用户端「检查更新」整份清单解析失败（桌面的更新一起挂）。密钥要**带外**从现有机器拷，别进仓库",
);

// ---- 可选：第一方插件片段的发布者私钥 ----
const pub = join(home, ".minisign", "shuyonote.key");
add(
  "（可选）发布者私钥 ~/.minisign/shuyonote.key",
  existsSync(pub),
  existsSync(pub) ? "有" : "没有",
  "没有则发版时**明确跳过**第一方插件片段（不是静默跳过），这一版的插件不进社区索引",
);

// ---- 可选：Android 侧（本机出不了 APK） ----
const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;
add(
  "（可选）Android SDK",
  !!sdk && existsSync(sdk),
  sdk ?? "未设置",
  "本机**不需要**：Android 发版件一律从 CI 取（Windows 本机出不了 APK，见 docs/RELEASING.md §9 开头）",
);

// ---- 输出 ----
const hard = rows.filter((r) => !r.name.startsWith("（可选）"));
const missing = hard.filter((r) => !r.ok);
console.log("Windows 构建机自检\n");
for (const r of rows) {
  console.log(`  ${r.ok ? "✓" : r.name.startsWith("（可选）") ? "·" : "✗"} ${r.name}：${r.detail}`);
  if (!r.ok) console.log(`      ⇒ 缺了会怎样：${r.consequence}`);
}
console.log("");
if (missing.length === 0) {
  console.log("[结果] 硬前置齐了：可以跑 `pnpm tauri build --bundles nsis`（记得先设 TAURI_SIGNING_PRIVATE_KEY / _PASSWORD）");
  process.exit(0);
}
console.log(`[结果] 还缺 ${missing.length} 项硬前置：${missing.map((m) => m.name).join("、")}`);
process.exit(1);
