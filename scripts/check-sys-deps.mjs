#!/usr/bin/env node
// check-sys-deps —— 「构建期依赖 / 工具链」事故门禁
//
// 原型来自 AMD 侧（协作邮箱 `proposed-gates/check-sys-deps.mjs`，2026-09-17 信，自带变异验证：
// 把 `libssl-dev` 的查询强制成"没装" ⇒ 必须红）。本文件在原型上改了三处，每一处都先做了变异复现：
//
//   1. **未登记的 `*-sys` 原来是"打印警告但 exit 0"**。我先复现：往 `Cargo.lock` 里塞一个
//      `acme-native-sys 0.1.0`，原型照样打印「全部就位」、exit=0 —— 而"新依赖进来了、映射没更新"
//      正是这张表要挡的那类事故 ⇒ 现在**未登记就是红**（exit 3）。
//   2. **硬判据原来是手抄的一张 deb 表**。原型把 `libsqlite3-dev` 当硬判据，但本仓 CI 不装它、
//      构建也不需要它（桌面/Android 都走 `bundled-sqlcipher`，SQLCipher 源码自带）——
//      ⇒ 照抄进仓，第一条 push 就会红，而且红得没道理。现在硬判据**读 CI 配方本身**
//      （`.github/workflows/ci.yml` 的 `Linux system deps` 步）：**只有 CI 真的会装的包才算硬判据**，
//      表里声明了配方之外的包 ⇒ 红（要么补依据，要么标成弱判据）。配方解析不出来也红
//      （避免"配方变空集 ⇒ 判据全绿"这种最坏情况）。
//   3. **原来只在 Linux 上有判据**：macOS 上 `isLinux=false ⇒ missing 恒为空 ⇒ 永远全绿` ——
//      "什么也没查却显示通过"。现在按平台分派，并且**把"哪些判据没做"打出来**：
//      Linux 实查 deb（`dpkg`）；macOS 探工具链（2026-09-17 本机 15:51 那类事故：Xcode 27 装完
//      许可未接受 ⇒ `git`/`python3`/`cc`/`xcrun` 全线不可用）；Windows 判据表**待 Windows 侧补**
//      （缺表要说出来，不能装成绿）。
//
// 为什么 macOS 不能照搬 deb 概念：本机实测 `pkg-config` **根本不存在**（exit 127），而 macOS 的
// Rust 构建照常跑通 —— 判据必须按平台分开写，不能把 Linux 的包名表搬过来。
//
// 用法：
//   node scripts/check-sys-deps.mjs [--checks registration,toolchain,deb] [--lock <Cargo.lock>] [--json]
// 退出码：
//   0 通过 ｜ 1 缺系统包（Linux deb 实查） ｜ 2 用法/读文件失败
//   3 登记或证据失效（未登记 crate / 声明无依据 / CI 配方读不到 / citation 过期）
//   4 工具链探针失败（macOS）

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// CI 配方：硬判据的唯一来源。步骤名写在这里，解析失败即红（不做静默兜底）。
const CI_RECIPE = { file: ".github/workflows/ci.yml", step: "Linux system deps", minDebs: 5 };

// ---------------------------------------------------------------------------
// 映射表：`-sys` crate → 它要什么。
//   debs    —— **硬判据**，必须逐条出现在 CI 配方里，且本机（Linux）已装，缺 ⇒ 红
//   soft    —— **弱判据**，{ 包名: 为什么它只是弱判据 }，打印但不拦（通常是走依赖链带上的）
//   why     —— 必填：这个 crate 为什么需要它
//   citation—— 可选：声明"本仓不走系统库"的**机器可查依据**（file + 正则 + 理由），
//              依据不匹配 ⇒ 红（否则这种声明会悄悄腐烂成假话）
// ---------------------------------------------------------------------------
const MAP = {
  "openssl-sys": {
    debs: ["libssl-dev"],
    soft: { "pkg-config": "openssl-sys 的构建脚本优先用 pkg-config 定位 OpenSSL；CI 镜像预装，但配方里没直接列它" },
    why: "桌面/社区端 SQLCipher 需要加密后端：Linux 上走系统 OpenSSL（Android 那条线自带，见 libsqlite3-sys 的 citation）",
    incident: "2026-09-17：发布机把 libssl-dev 当「客户端专用」清掉 ⇒ 社区端 openssl-sys 构建失败",
  },
  "libsqlite3-sys": {
    debs: [],
    why: "本仓两条线都自带 SQLCipher 源码 ⇒ 不需要系统 sqlite 开发包",
    citation: {
      file: "src-tauri/Cargo.toml",
      pattern: "bundled-sqlcipher",
      why: "桌面 features = [\"bundled-sqlcipher\"]、Android = [\"bundled-sqlcipher-vendored-openssl\"]；这条一旦消失，本行必须改回需要 libsqlite3-dev",
    },
  },
  "libclang-sys": { debs: ["libclang-dev"], why: "bindgen 需要 libclang" },
  "clang-sys": { debs: ["libclang-dev"], why: "bindgen 需要 libclang" },
  "mupdf-sys": { debs: ["libclang-dev"], why: "mupdf 的 bindgen 只需要 libclang（CI 配方里没有 clang 二进制也构建通过）" },
  "libz-sys": {
    debs: [],
    soft: { "zlib1g-dev": "Linux 上通常随 GTK/WebKit 依赖链装上；缺了会编译失败，但 CI 配方没直接列它" },
    why: "zlib 开发包",
  },
  "zstd-sys": { debs: [], why: "自带源码（bundled），不需要系统包" },
  "aws-lc-sys": { debs: [], why: "自带源码 + cmake，不需要系统包" },
  "libbz2-rs-sys": { debs: [], why: "纯 Rust 实现（默认不链系统 bzip2）" },
  "gtk-sys": { debs: ["libwebkit2gtk-4.1-dev"], why: "Tauri Linux 前置（GTK 随 WebKit 依赖链装上）" },
  "webkit2gtk-sys": { debs: ["libwebkit2gtk-4.1-dev"], why: "Tauri Linux 前置" },
  "soup3-sys": { debs: ["libwebkit2gtk-4.1-dev"], why: "Tauri Linux 前置（libsoup3 随 WebKit 依赖链装上）" },
  "gdk-sys": { debs: ["libwebkit2gtk-4.1-dev"], why: "Tauri Linux 前置（GTK 随 WebKit 依赖链装上）" },
  "javascriptcore-rs-sys": { debs: ["libwebkit2gtk-4.1-dev"], why: "Tauri Linux 前置（随 WebKit 依赖链装上）" },
  "atk-sys": { debs: ["libwebkit2gtk-4.1-dev"], why: "Tauri Linux 前置（GTK a11y，随 WebKit 依赖链装上）" },
  "gdk-pixbuf-sys": { debs: ["libwebkit2gtk-4.1-dev"], why: "Tauri Linux 前置（随 WebKit 依赖链装上）" },
  "gio-sys": { debs: ["libwebkit2gtk-4.1-dev"], why: "Tauri Linux 前置（GLib，随 WebKit 依赖链装上）" },
  "glib-sys": { debs: ["libwebkit2gtk-4.1-dev"], why: "Tauri Linux 前置（GLib，随 WebKit 依赖链装上）" },
  "gobject-sys": { debs: ["libwebkit2gtk-4.1-dev"], why: "Tauri Linux 前置（GLib，随 WebKit 依赖链装上）" },
  "pango-sys": { debs: ["libwebkit2gtk-4.1-dev"], why: "Tauri Linux 前置（随 WebKit 依赖链装上）" },
  "gdkwayland-sys": { debs: ["libwebkit2gtk-4.1-dev"], why: "随 GTK 一起（Wayland 后端）" },
  "gdkx11-sys": { debs: ["libwebkit2gtk-4.1-dev"], why: "随 GTK 一起（X11 后端）" },
  "libdbus-sys": { debs: ["libwebkit2gtk-4.1-dev"], why: "D-Bus 开发包（随 GTK 依赖链装上）" },
  "libappindicator-sys": { debs: ["libayatana-appindicator3-dev"], why: "托盘图标" },
  // 平台专属：在本仓 CI 的 Linux 上不需要 deb，显式登记为"无需系统包"，免得它们淹没"未登记"告警
  "windows-sys": { debs: [], why: "Windows 专属" },
  "webview2-com-sys": { debs: [], why: "Windows 专属" },
  "vswhom-sys": { debs: [], why: "Windows 专属" },
  "core-foundation-sys": { debs: [], why: "macOS 专属" },
  "security-framework-sys": { debs: [], why: "macOS 专属" },
  "system-configuration-sys": { debs: [], why: "macOS 专属" },
  "ndk-sys": { debs: [], why: "Android 专属" },
  "jni-sys": { debs: [], why: "Android/JNI 专属" },
  "dirs-sys": { debs: [], why: "纯 Rust 包装，无系统依赖" },
  "linux-raw-sys": { debs: [], why: "纯 Rust 定义，无系统依赖" },
  "js-sys": { debs: [], why: "wasm 绑定，无系统依赖" },
  "web-sys": { debs: [], why: "wasm 绑定，无系统依赖" },
};

// macOS 工具链探针：**每一条都对应一次真事故或一次真需求**，不是凑数的。
// `kind: path` ⇒ 退出 0 且输出是存在的路径；`kind: exit` ⇒ 只要退出 0（输出当信息打出来）。
const DARWIN_PROBES = [
  { id: "xcode-select", cmd: ["xcode-select", "-p"], kind: "path", why: "命令行工具链根目录（找不到 ⇒ 什么都编译不了）" },
  {
    id: "macosx-sdk",
    cmd: ["xcrun", "--sdk", "macosx", "--show-sdk-path"],
    kind: "path",
    why: "macOS SDK 路径",
    incident: "2026-09-17 15:51：Xcode 27 装完但许可未接受 ⇒ xcrun 全线失败（git/python3/cc 都走它）",
  },
  {
    id: "notarytool",
    cmd: ["xcrun", "notarytool", "--version"],
    kind: "exit",
    why: "公证工具可用 —— 许可未接受时这一条就会红，是那次事故最省事的单条探针",
  },
  { id: "codesign", cmd: ["xcrun", "--find", "codesign"], kind: "path", why: "签名工具（发版要靠它）" },
  { id: "clang", cmd: ["xcrun", "--find", "clang"], kind: "path", why: "Rust 的链接器/编译驱动 cc 走它" },
];

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const asJson = argv.includes("--json");
const checksArg = argValue("--checks");
const wantCheck = (name) => (checksArg ? checksArg.split(",").map((s) => s.trim()).includes(name) : true);

function parseLock(text) {
  const pkgs = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const m = /^name = "(.+)"$/.exec(line.trim());
    if (m) {
      if (cur) pkgs.push(cur);
      cur = { name: m[1], version: null };
      continue;
    }
    const v = /^version = "(.+)"$/.exec(line.trim());
    if (v && cur && !cur.version) cur.version = v[1];
  }
  if (cur) pkgs.push(cur);
  return pkgs;
}

// CI 配方里的 Linux 包清单 —— 硬判据的来源。解析不出来就报错（绝不静默变空集）。
function readCiRecipe() {
  const path = join(ROOT, CI_RECIPE.file);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, reason: `读不到 ${CI_RECIPE.file}：${err.message}` };
  }
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.includes(`name: ${CI_RECIPE.step}`));
  if (start < 0) return { ok: false, reason: `在 ${CI_RECIPE.file} 里找不到步骤「${CI_RECIPE.step}」` };
  const body = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && /^\s*- (name|uses|run):/.test(lines[i])) break;
    body.push(lines[i]);
  }
  const joined = body.join("\n").replace(/\\\s*\n/g, " ");
  const seg = /apt-get\s+install([^\n]*)/.exec(joined);
  if (!seg) return { ok: false, reason: `步骤「${CI_RECIPE.step}」里没有 apt-get install` };
  const debs = seg[1]
    .split(/\s+/)
    .filter((t) => /^[a-z0-9][a-z0-9.+-]*$/i.test(t));
  if (debs.length < CI_RECIPE.minDebs) {
    return { ok: false, reason: `步骤「${CI_RECIPE.step}」只解析出 ${debs.length} 个包（< ${CI_RECIPE.minDebs}）⇒ 判据失效` };
  }
  return { ok: true, debs };
}

// `SHUYONOTE_SYSDEPS_FAKE_DPKG=<脚本路径>` 是**测试专用注入**：让"缺包"这条路在任何机器上都能复现
// （scripts/check-sys-deps.test.mjs 用它做变异）。生产环境不要设它。
function dpkgCmd(pkgOrFlag) {
  const fake = process.env.SHUYONOTE_SYSDEPS_FAKE_DPKG;
  return fake
    ? { file: process.execPath, args: [fake, ...pkgOrFlag] }
    : { file: "dpkg-query", args: pkgOrFlag };
}

// 探针可能"没跑起来"（并发下 fork 失败、二进制不存在、卡住），这**不是**"缺包"。
// 2026-09-17：Windows 那边全量并发跑门禁时复现过一次 —— 表现是"缺 vitals 包"式的假红。
// 门禁假红比没有门禁更糟（人的第一反应是"又抖了，重跑一次"，真红的信号随之被忽略），
// 所以这里把三种结果分开：installed / missing / unknown，unknown 一律按"判据不可用"报（exit 4）。
const PROBE_TIMEOUT_MS = 20000;

function runProbe({ file, args }) {
  try {
    const out = execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PROBE_TIMEOUT_MS,
    });
    return { ok: true, out: String(out).trim(), status: 0 };
  } catch (err) {
    return {
      ok: false,
      out: String(err.stdout || "").trim(),
      err: String(err.stderr || err.message).trim(),
      status: typeof err.status === "number" ? err.status : null,
      spawnCode: err.code && typeof err.code === "string" ? err.code : "",
      signal: err.signal || "",
    };
  }
}

/** `dpkg-query` 在这台机器上能不能用。
 *
 * 三种结果要分开（否则会静默变绿）：
 *  - 二进制不存在（ENOENT）⇒ **正常跳过**（macOS/Windows 上就是这样）；
 *  - 能跑 ⇒ 实查；
 *  - 存在但跑不起来/退出非 0 ⇒ **判据不可用**（不能当成"没 dpkg 所以跳过"，那正是"没查却显示绿"）。 */
function dpkgAvailability() {
  const r = runProbe(dpkgCmd(["--version"]));
  if (r.ok) return { available: true };
  if (r.spawnCode === "ENOENT") return { available: false };
  return { available: false, broken: `dpkg-query --version 没跑起来（status=${r.status}${r.spawnCode ? ` code=${r.spawnCode}` : ""}）：${r.err || "无输出"}` };
}

/** `installed` / `missing` / `unknown`（unknown = 探针本身没跑起来，不能当成"缺包"）。 */
function debState(pkg) {
  const fake = process.env.SHUYONOTE_SYSDEPS_FAKE_MISSING;
  if (fake && fake.split(",").map((s) => s.trim()).includes(pkg)) return { state: "missing" };
  const r = runProbe(dpkgCmd(["-W", "-f=${Status}", pkg]));
  if (r.ok) return { state: r.out.includes("install ok installed") ? "installed" : "missing" };
  // dpkg-query 对"没装的包"的**正常**答复就是退出码 1；其它情况（ENOENT/EAGAIN/超时/信号）
  // 都是"探针没跑起来" ⇒ unknown。
  if (r.status === 1) return { state: "missing" };
  return {
    state: "unknown",
    reason: `探针未跑起来（status=${r.status}${r.spawnCode ? ` code=${r.spawnCode}` : ""}${r.signal ? ` signal=${r.signal}` : ""}）：${r.err || "无输出"}`,
  };
}

function probeDarwin(probe) {
  const forced = (process.env.SHUYONOTE_SYSDEPS_FAKE_PROBE_FAIL || "").split(",").map((s) => s.trim());
  if (forced.includes(probe.id)) return { ok: false, out: "", err: "（测试注入：强制失败）" };
  const r = runProbe({ file: probe.cmd[0], args: probe.cmd.slice(1) });
  if (!r.ok) return { ok: false, out: r.out, err: r.err };
  if (probe.kind === "path" && !existsSync(r.out)) return { ok: false, out: r.out, err: `路径不存在：${r.out}` };
  return { ok: true, out: r.out };
}

function main() {
  const lockPath = resolve(argValue("--lock") || join(ROOT, "src-tauri/Cargo.lock"));
  let lockText;
  try {
    lockText = readFileSync(lockPath, "utf8");
  } catch (err) {
    console.error(`读不到 ${lockPath}：${err.message}`);
    console.error("用法：node scripts/check-sys-deps.mjs [--checks registration,toolchain,deb] [--lock <Cargo.lock>] [--json]");
    process.exit(2);
  }

  const platform = process.platform;
  const sysCrates = parseLock(lockText).filter((p) => p.name.endsWith("-sys"));
  const recipe = readCiRecipe();

  const rows = [];
  const unregistered = [];
  const unjustified = [];
  const staleCitations = [];
  const missingHard = [];
  const missingSoft = [];
  const probeFailures = [];

  // ---- 判据 1：登记完整性 + 声明依据（平台无关，任何机器上都能查） ----
  const doRegistration = wantCheck("registration");
  if (doRegistration) {
    for (const c of sysCrates) {
      const entry = MAP[c.name];
      if (!entry) {
        unregistered.push(c);
        continue;
      }
      if (!entry.why) unjustified.push({ crate: c.name, deb: null, reason: "表里没写 why" });
      if (entry.citation) {
        let target = "";
        try {
          target = readFileSync(join(ROOT, entry.citation.file), "utf8");
        } catch {
          /* 读不到就按失配处理 */
        }
        if (!target.includes(entry.citation.pattern)) {
          staleCitations.push({ crate: c.name, ...entry.citation });
        }
      }
      const debs = entry.debs || [];
      const soft = entry.soft || {};
      // 证据规则：硬判据必须能在 CI 配方里找到同名包；弱判据必须写清"为什么它只是弱判据"
      for (const d of debs) {
        if (recipe.ok && !recipe.debs.includes(d)) {
          unjustified.push({ crate: c.name, deb: d, reason: `不在 CI 配方（${CI_RECIPE.step}）里 —— 要么补依据，要么标成 soft` });
        }
      }
      for (const d of Object.keys(soft)) {
        if (!soft[d]) unjustified.push({ crate: c.name, deb: d, reason: "弱判据没写理由" });
      }
      rows.push({ crate: c.name, version: c.version, debs, soft, why: entry.why, missing: [], softMissing: [] });
    }
  }

  // ---- 判据 2：Linux deb 实查（只有 Linux 有 dpkg 才能查） ----
  const doDeb = wantCheck("deb");
  let debSkipped = null;
  if (doDeb) {
    // 判据是"**这台机器上有 dpkg 才能实查**"，不是"是不是 Linux"：这样在 WSL/容器/带 dpkg 的
    // 任何机器上都能查，而 macOS（本机常态）与 Windows 会**显式打出"没查"**，不装成绿。
    const dpkg = dpkgAvailability();
    if (dpkg.broken) {
      probeFailures.push({ deb: "dpkg-query", reason: dpkg.broken });
    } else if (!dpkg.available) {
      debSkipped = `本机没有 dpkg-query（${platform} 上是常态）⇒ 未实查；Debian/Ubuntu 上才会实查`;
    } else {
      // **去重后再探测**：`libwebkit2gtk-4.1-dev` 被十几个 crate 声明，逐个 crate 探测会把
      // 子进程数放大一个量级（2026-09-17 那次并发假红就与"探针太多"有关）。
      const wanted = new Map(); // deb → { hard: [crate], soft: [crate] }
      for (const r of rows) {
        const entry = MAP[r.crate];
        for (const d of r.debs) {
          const w = wanted.get(d) ?? { hard: [], soft: [] };
          w.hard.push(r.crate);
          wanted.set(d, w);
        }
        for (const d of Object.keys(entry.soft || {})) {
          const w = wanted.get(d) ?? { hard: [], soft: [] };
          w.soft.push({ crate: r.crate, why: entry.soft[d] });
          wanted.set(d, w);
        }
      }
      for (const [d, w] of wanted) {
        const st = debState(d);
        if (st.state === "unknown") {
          probeFailures.push({ deb: d, reason: st.reason });
          continue;
        }
        if (st.state === "installed") continue;
        if (w.hard.length) {
          missingHard.push({ crate: w.hard.join("/"), deb: d });
          for (const r of rows) if (r.debs.includes(d)) r.missing.push(d);
        } else {
          missingSoft.push({ crate: w.soft.map((s) => s.crate).join("/"), deb: d, why: w.soft[0]?.why ?? "" });
          for (const r of rows) if (d in (MAP[r.crate].soft || {})) r.softMissing.push(d);
        }
      }
    }
  }

  // ---- 判据 3：macOS 工具链探针 ----
  const probes = [];
  let probeSkipped = null;
  if (wantCheck("toolchain")) {
    if (platform === "darwin") {
      for (const p of DARWIN_PROBES) {
        const r = probeDarwin(p);
        probes.push({ ...p, ok: r.ok, out: r.out, err: r.err });
      }
    } else {
      probeSkipped = `本机是 ${platform}：macOS 工具链探针未做（Windows 侧的判据表待 Windows 侧补：MSVC / WebView2 / NSIS）`;
    }
  }
  const probeFailed = probes.filter((p) => !p.ok);

  const ctx = {
    lock: lockPath,
    platform,
    recipe: { file: CI_RECIPE.file, step: CI_RECIPE.step, ok: recipe.ok, debs: recipe.ok ? recipe.debs : [], reason: recipe.reason },
    scanned: sysCrates.length,
    registered: rows.length,
    rows,
    unregistered,
    unjustified,
    staleCitations,
    missingHard,
    missingSoft,
    probeFailures,
    probes: probes.map((p) => ({ id: p.id, ok: p.ok, out: p.out, why: p.why, incident: p.incident || "" })),
    debSkipped,
    probeSkipped,
  };

  // ⚠️ `probeFailures`（探针没跑起来）**优先于**缺包判断：探针坏了要说"判据不可用"，
  // 不能把"没查到"冒充成"缺包"——2026-09-17 并发下那次假红就是这么来的。
  const exit = probeFailures.length
    ? 4
    : missingHard.length
      ? 1
      : !recipe.ok || unregistered.length || unjustified.length || staleCitations.length
        ? 3
        : probeFailed.length
          ? 4
          : 0;

  if (asJson) {
    console.log(JSON.stringify({ ...ctx, exit }, null, 2));
    process.exit(exit);
  }

  const line = "─".repeat(76);
  console.log(`构建期依赖 / 工具链检查  platform=${platform}  lock=${lockPath}`);
  console.log(line);
  if (doRegistration) {
    console.log(`扫描到 ${sysCrates.length} 个 *-sys crate，已登记 ${rows.length} 个`);
    for (const r of rows) {
      const mark = r.missing.length ? "❌" : r.softMissing.length ? "⚠️ " : "✅";
      const debs = [...r.debs, ...Object.keys(r.soft).map((d) => `${d}(弱)`)];
      console.log(`${mark} ${r.crate.padEnd(24)} ${String(r.version).padEnd(12)} → ${debs.length ? debs.join(",") : "（无需系统包）"}`);
      if (r.missing.length) console.log(`     ↳ 缺：${r.missing.join(", ")}（${r.why}）`);
      if (r.softMissing.length) console.log(`     ↳ 弱判据缺：${r.softMissing.join(", ")}（不拦，但记下来）`);
    }
    if (unregistered.length) {
      console.log(line);
      console.log(`❌ 未登记的 *-sys crate（${unregistered.length} 个）—— 新依赖进来了而映射没更新，正是这张表要挡的事故；请在 MAP 里补一行：`);
      for (const c of unregistered) console.log(`   ${c.name} ${c.version}`);
    }
    if (unjustified.length) {
      console.log(line);
      console.log(`❌ 声明没有依据（${unjustified.length} 条）—— 硬判据必须在 CI 配方里能找到，否则就是"凭空要求的包"（会误红）：`);
      for (const u of unjustified) console.log(`   ${u.crate} → ${u.deb || "(缺 why)"}：${u.reason}`);
    }
    if (staleCitations.length) {
      console.log(line);
      console.log(`❌ citation 过期（${staleCitations.length} 条）—— 声明"本仓不走系统库"的依据已经不成立了，请改映射：`);
      for (const s of staleCitations) console.log(`   ${s.crate}：${s.file} 里已找不到 ${s.pattern}（${s.why}）`);
    }
  }
  console.log(line);
  console.log(
    `CI 配方（${CI_RECIPE.file} → ${CI_RECIPE.step}）：${recipe.ok ? `${recipe.debs.length} 个包` : `❌ 解析失败：${recipe.reason}`}`,
  );
  if (doDeb) {
    if (debSkipped) {
      console.log(`⏭ Linux deb 实查：${debSkipped}`);
    } else if (probeFailures.length) {
      console.log(`❌ 判据不可用：${probeFailures.length} 个包的探针没跑起来（**这不是"缺包"**，别照着装）：`);
      for (const f of probeFailures) console.log(`   ${f.deb}：${f.reason}`);
      console.log("   常见原因：并发下 fork 失败 / 超时 / dpkg 数据库被占用。先重跑一次；稳定复现再查环境。");
    } else if (missingHard.length) {
      console.log(`❌ 缺 ${missingHard.length} 个系统包：`);
      console.log(`   Debian/Ubuntu：apt-get install -y ${[...new Set(missingHard.map((m) => m.deb))].join(" ")}`);
      console.log("   （这条判据的来源：2026-09-17 发布机清掉 libssl-dev ⇒ 社区端 openssl-sys 构建失败）");
    } else if (missingSoft.length) {
      console.log(`✅ 硬判据全部就位（dpkg 实查）；⚠️ 弱判据缺 ${missingSoft.length} 个：${[...new Set(missingSoft.map((m) => m.deb))].join(", ")}`);
    } else {
      console.log("✅ Linux deb 实查：全部就位（dpkg 实查）");
    }
  }
  if (wantCheck("toolchain")) {
    if (probeSkipped) {
      console.log(`⏭ macOS 工具链探针：${probeSkipped}`);
    } else {
      for (const p of probes) {
        console.log(`${p.ok ? "✅" : "❌"} ${p.id.padEnd(16)} ${p.out || p.err || ""}`);
        if (!p.ok && p.incident) console.log(`     ↳ ${p.incident}`);
      }
    }
  }
  console.log(line);
  const verdict = probeFailures.length
    ? "判据不可用（探针没跑起来）"
    : { 0: "全部通过", 1: "缺系统包", 3: "登记/证据失效", 4: "工具链探针失败" }[exit];
  console.log(`${exit === 0 ? "✅" : "❌"} ${verdict}（exit=${exit}）`);
  process.exit(exit);
}

// 只有被当作命令直接跑时才执行；被测试 import 时只导出判据表与纯函数
// （`scripts/check-sys-deps.test.mjs` 用它**在进程内**校验"硬判据都有 CI 依据"这条不变量）。
export { MAP, DARWIN_PROBES, CI_RECIPE, ROOT, parseLock, readCiRecipe };

const isEntry = isMain(import.meta.url);
if (isEntry) main();
