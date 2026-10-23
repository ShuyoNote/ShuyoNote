#!/usr/bin/env node
// iOS 打包（可复现）—— 把 2026-10-20 手工打通的那条链固化成一条命令。
//
// 配方出处：`docs/plans/mobile/2026-10-20-ios-packaging-recipe.md`（先读它再改本脚本）。
//
// ⛔ 本脚本**不做**的三件事（都是配方里明写的坑）：
//   ① ⛔ 不跑 `tauri ios init`（会重新生成 `src-tauri/gen/apple`，覆盖 project.yml 的定制）；
//   ② ⛔ 不手改 `project.pbxproj`（定制只写 `src-tauri/gen/apple/project.yml`，
//      pbxproj 由 `xcodegen generate` 从它重新生成 —— 这与"手改生成物"是两件事）；
//   ③ ⛔ 不往 `Externals/ios-sim-swift/`、`build/`、`release/` 里写任何东西（只允许构建覆盖）。
//
// ## 这条链为什么是这几步
//   Swift 侧（Tauri / SwiftRs / dialog / opener）的 .o 是 **cargo 构建 tauri 系列 crate 时**由
//   swift-rs 用 xcodebuild 编出来的，落在
//     `src-tauri/target/<target>/<profile>/build/<crate>-<hash>/out/swift-rs/<包>/out/
//      Intermediates.noindex/<Pkg>.build/Release-<sdk>/<Pkg>-t.build/Objects-normal/arm64/*.o`
//   而 **4 个 .a 没有任何一步会自动生成**（配方 §1②）⇒ 必须在这里用 `ar rcs` 手工打。
//   ⛔ 不能拿"合并版 `Tauri.o`"单独打库 —— 那个成员只有 `Tauri.o` 单文件，
//      缺 `Invoke.o` ⇒ 链接必缺 `Tauri.Invoke.sendResponse` 一类符号（配方逐字）。
//   ✅ 本脚本打的 `libTauriSwiftPM.a` 恰好是 **8 个 .o**，与参照物
//      `Externals/ios-sim-swift/libTauriSwiftPM.a` 的成员表逐字一致。
//
// ## 产物路径（仓内稳定路径，取代 2026-10-20 的 `/tmp/ios-swiftpm-libs`）
//   device : `src-tauri/target/ios-swiftpm-libs/*.a`
//   sim    : `src-tauri/target/ios-swiftpm-libs/sim/*.a`
//   ⇒ `project.yml` 的两条 `OTHER_LDFLAGS[sdk=...]` 用 `$(PROJECT_DIR)/../../target/...` 指过来
//     （`$(PROJECT_DIR)` = `src-tauri/gen/apple`），因此**与机器/用户名无关**、`/tmp` 被清也不影响。
//
// ## 用法
//   node scripts/ios-build.mjs                    # device：cargo → 归档 → project.yml → xcodegen → IPA → 校验
//   node scripts/ios-build.mjs --sim              # simulator：同上（用 Release-iphonesimulator 的 .o）→ .app
//   node scripts/ios-build.mjs --archives-only    # 只做 cargo + 归档 + project.yml + xcodegen
//   node scripts/ios-build.mjs --skip-cargo       # 复用已有 .o（不想等 cargo 时）
//   node scripts/ios-build.mjs --no-xcodegen      # pbxproj 已对时跳过 xcodegen
//   node scripts/ios-build.mjs --run-sim          # --sim 之后再起模拟器：装 → 启 → 截图
//   node scripts/ios-build.mjs --target aarch64-sim   # 等价于 --sim
//   node scripts/ios-build.mjs --sim --frontend-dist /tmp/dist-probe
//                                                 # 诊断用：拿一份现成的 dist（跳过 beforeBuildCommand）
//
// ## 签名（2026-10-23 起：**公司优先、env 驱动**）
//   node scripts/ios-build.mjs                      # 默认 --sign company ⇒ App Store 分发档（Apple Distribution）
//   node scripts/ios-build.mjs --sign company --dev # 公司 team 的**开发**档（Apple Development；需要已注册真机）
//   node scripts/ios-build.mjs --sign personal      # 仅显式指定才走：个人 team（M3UZLB6XK6）的本机调试档
//   IOS_SIGN=personal node scripts/ios-build.mjs    # 等价的环境变量入口
//   node scripts/ios-build.mjs --signing-probe      # 只做签名探测（即便证书缺失也继续走构建，取 xcodebuild 的原话）
//   ⛔ 公司档在公司证书缺失时**不会**静默回退个人 —— 要么构建时由 `-allowProvisioningUpdates` 自动建，
//      要么以 `BLOCKED:` + 非 0 退出码收场（错误原文一起打印）。（见 `stepSigning` / `signingFailure`）
//
// 退出码：0 成功 ／ 1 失败 ／ 2 **阻塞**（代理/网络/SwiftPM 缓存/工具缺失 —— 不是"通过"）
//
// ⚠️ 代理：swift-rs 要从 GitHub 拉 SwiftPM 依赖（配方 §1①）。本机 FlClash 是**代理模式**不是全局路由
//    ⇒ `https_proxy` 必须显式给。本脚本会先探 `127.0.0.1:7890`：
//      · 通 ⇒ 自动把它注入子进程环境（并打印读数）；
//      · 不通 ⇒ **不自己起代理、不改网络**（越界），仅在 cargo 因网络失败时记 `阻塞` 并给出人话。
//    已有 `https_proxy` 环境变量时以它为优先（不覆盖用户显式给的值）。

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, copyFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GEN_APPLE = join(ROOT, "src-tauri", "gen", "apple");
const PROJECT_YML = join(GEN_APPLE, "project.yml");
const TAURI_CONF = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const APP_VERSION = String(TAURI_CONF.version || "");
const LOG_DIR = join(ROOT, "src-tauri", "target", "ios-build-logs");
const LIB_DIR_DEVICE = join(ROOT, "src-tauri", "target", "ios-swiftpm-libs");
const LIB_DIR_SIM = join(LIB_DIR_DEVICE, "sim");
const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 7890;

// ── 命令行 ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i > -1 ? argv[i + 1] : undefined;
};
const TARGET_PLATFORM = has("--sim") || val("--target") === "aarch64-sim" ? "sim" : "device";
const ARCHIVES_ONLY = has("--archives-only");
const SKIP_CARGO = has("--skip-cargo");
const NO_XCODEGEN = has("--no-xcodegen");
const RUN_SIM = has("--run-sim");
const FRONTEND_DIST = val("--frontend-dist");
// ── 签名：默认 company（公司主体），个人签名只有显式指定才走 ──────────────────
const SIGN = String(val("--sign") || process.env.IOS_SIGN || "company").toLowerCase();
const SIGN_DEV = has("--dev");
const SIGN_TEAM_OVERRIDE = val("--team") || process.env.IOS_TEAM || null;
const SIGNING_PROBE = has("--signing-probe");
const COMPANY_TEAM = "D53949JLS2";
const PERSONAL_TEAM = "M3UZLB6XK6";
/** iOS 能用的证书类型（`Developer ID *` 是 macOS 分发/公证用，**不能签 iOS**）。 */
const IOS_IDENTITY_TYPES = ["Apple Development", "Apple Distribution", "iPhone Developer", "iPhone Distribution"];
const RUST_TARGET = TARGET_PLATFORM === "sim" ? "aarch64-apple-ios-sim" : "aarch64-apple-ios";
const XCODE_SDK_TAG = TARGET_PLATFORM === "sim" ? "iphonesimulator" : "iphoneos";
const LIB_DIR = TARGET_PLATFORM === "sim" ? LIB_DIR_SIM : LIB_DIR_DEVICE;
const TAURI_CLI_TARGET = TARGET_PLATFORM === "sim" ? "aarch64-sim" : "aarch64";

const startedAt = new Date();
/** 公司分发档的产物（手工 `xcodebuild -exportArchive` 导出）；verify 用它而不是 tauri 自己那份 */
let LAST_EXPORT = null;
const report = { startedAt: startedAt.toISOString(), platform: TARGET_PLATFORM, steps: [] };

function section(title) {
  const line = "─".repeat(6);
  console.log(`\n${line} ${title} ${line}`);
}
function record(step, data) {
  report.steps.push({ step, ...data });
  console.log(`[读数] ${step}: ${JSON.stringify(data)}`);
}
function fatal(msg, code = 1) {
  console.error(`\n⛔ ${msg}`);
  process.exit(code);
}
function blocked(msg) {
  console.error(`\n🚧 BLOCKED: ${msg}`);
  console.error("（这不是通过 —— 按任务纪律如实记阻塞项，不绕过网络/代理）");
  process.exit(2);
}

// ── 子进程：流式输出 + 落盘日志（长构建不至于丢证据）────────────────────────────
function runStream(cmd, args, opts = {}) {
  const logPath = join(LOG_DIR, `${opts.logName || "run"}.log`);
  mkdirSync(LOG_DIR, { recursive: true });
  const fd = openSync(logPath, "w");
  const header = `$ ${cmd} ${args.join(" ")}\n# cwd=${opts.cwd || ROOT}\n# ${new Date().toISOString()}\n`;
  writeFileSync(fd, header);
  return new Promise((done) => {
    let out = "";
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd || ROOT, env: opts.env || process.env });
    } catch (err) {
      closeSync(fd);
      return done({ code: -1, out: String(err), logPath });
    }
    const push = (d) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s);
      writeFileSync(fd, s);
    };
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    child.on("error", (err) => {
      out += String(err);
      writeFileSync(fd, String(err));
    });
    child.on("close", (code) => {
      closeSync(fd);
      done({ code: code ?? -1, out, logPath });
    });
  });
}
function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd || ROOT, env: opts.env || process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: `${r.stdout || ""}${r.stderr || ""}` };
}

// ── ① 代理探测 ───────────────────────────────────────────────────────────────
function probeTcp(host, port, timeoutMs = 800) {
  return new Promise((done) => {
    const sock = createConnection({ host, port });
    const finish = (ok) => {
      sock.destroy();
      done(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => finish(true));
    sock.on("timeout", () => finish(false));
    sock.on("error", () => finish(false));
  });
}
async function stepProxy() {
  section("① 代理探测（swift-rs 需要它拉 GitHub；配方 §1①）");
  const envHas = process.env.https_proxy || process.env.HTTPS_PROXY;
  const open = await probeTcp(PROXY_HOST, PROXY_PORT);
  const env = { ...process.env };
  let mode;
  if (envHas) {
    mode = `env:${envHas}`;
  } else if (open) {
    mode = `injected:http://${PROXY_HOST}:${PROXY_PORT}`;
    env.https_proxy = `http://${PROXY_HOST}:${PROXY_PORT}`;
    env.http_proxy = `http://${PROXY_HOST}:${PROXY_PORT}`;
  } else {
    mode = "absent";
  }
  record("proxy", { probe: `tcp ${PROXY_HOST}:${PROXY_PORT}`, open, env: envHas || null, mode });
  if (mode === "absent") {
    console.log(
      "⚠️ 代理 7890 不通且没有 https_proxy。若 cargo 构建阶段没重新跑 swift-rs（SwiftPM 已缓存），\n" +
        "   这条链**仍然能过**；只有 SwiftPM 真的需要联网时才会失败 —— 那时会记为 BLOCKED，不自己起代理。",
    );
  }
  return env;
}

// ── ①.5 签名探测（⛔ 公司证书缺失时**不许静默回退个人**）──────────────────────
/** 读钥匙串里的代码签名身份：`security find-identity -v -p codesigning` 的逐行解析。 */
function listSigningIdentities() {
  const r = capture("security", ["find-identity", "-v", "-p", "codesigning"]);
  const out = [];
  for (const line of r.out.split("\n")) {
    const m = line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"\s*$/);
    if (!m) continue;
    const name = m[2];
    const team = (name.match(/\(([A-Z0-9]{10})\)\s*$/) || [])[1] || null;
    const type = IOS_IDENTITY_TYPES.find((t) => name.startsWith(t)) || (name.startsWith("Developer ID") ? "Developer ID (macOS only)" : name.split(":")[0]);
    out.push({ hash: m[1], name, team, type, ios: IOS_IDENTITY_TYPES.includes(type) });
  }
  return { all: out, found: (r.out.match(/(\d+) valid identities found/) || [])[1] || "0" };
}

function stepSigning() {
  section("①.5 签名档位（默认 company；个人签名必须显式指定）");
  if (TARGET_PLATFORM === "sim") {
    // 模拟器不需要 Apple 签名（ad-hoc `-` 即可），但照样要**打印**档位，免得误以为出的是可交付包。
    const s = { sign: "none(simulator)", team: null, identity: "-", style: "Automatic", exportMethod: "debugging" };
    record("signing", { ...s, note: "模拟器构建用 ad-hoc 签名；与公司/个人无关" });
    return s;
  }
  if (!["company", "personal"].includes(SIGN)) fatal(`--sign 只接受 company｜personal（收到 ${JSON.stringify(SIGN)}）`, 1);
  const id = listSigningIdentities();
  const companyIOS = id.all.filter((x) => x.ios && x.team === COMPANY_TEAM);
  // ⚠️ 个人那张证书名字里的括注是 **6GL2GRPTUW**（证书 OU），而工程里用的 team 是 **M3UZLB6XK6**
  //    （描述文件的团队）⇒ 不能拿"名字里的 OU == PERSONAL_TEAM"来判"个人证书有没有"。
  //    判据改成：**任何一条非公司 team 的 iOS 证书**都算个人侧可用证书。
  const personalIOS = id.all.filter((x) => x.ios && x.team !== COMPANY_TEAM);
  const companyMac = id.all.filter((x) => !x.ios && x.team === COMPANY_TEAM);
  const team = SIGN_TEAM_OVERRIDE || (SIGN === "company" ? COMPANY_TEAM : PERSONAL_TEAM);
  // 档位：personal 只有开发档；company 默认**分发档**（App Store），`--dev` 才走开发档。
  const distribution = SIGN === "company" && !SIGN_DEV;
  // ⚠️ **archive 阶段的 identity 必须是 `Apple Development`，不是 `Apple Distribution`** ——
  //    实测（2026-10-23 19:41，逐字）：
  //      `shuyonote_iOS has conflicting provisioning settings. shuyonote_iOS is automatically signed
  //       for development, but a conflicting code signing identity Apple Distribution has been manually
  //       specified. … Set the code signing identity value to "Apple Development" …`
  //    原因：automatic 签名在**归档**时按 development 解析 provision；分发身份是 **export 阶段**
  //    由 `-exportArchive -method app-store-connect` 重新签上去的（那一步才需要 Apple Distribution）。
  const identity = "Apple Development";
  const exportMethod = distribution ? "app-store-connect" : "debugging"; // tauri CLI 的取值（对应 xcodebuild 的 app-store-connect / debugging）
  const signing = { sign: SIGN, team, identity, style: "Automatic", exportMethod, distribution, probe: SIGNING_PROBE };
  const counts = {
    [`company iOS (team ${COMPANY_TEAM})`]: companyIOS.length,
    [`personal/其它 iOS（非公司 team，含 OU=6GL2GRPTUW 那张）`]: personalIOS.length,
    "company Developer ID (macOS，⛔不能签 iOS)": companyMac.length,
    "valid identities total": id.found,
  };
  console.log("  证书读数（security find-identity -v -p codesigning）：");
  for (const [k, v] of Object.entries(counts)) console.log(`    · ${k}: ${v}`);
  for (const x of id.all.filter((y) => y.ios || y.team === COMPANY_TEAM)) console.log(`    - ${x.name}${x.ios ? "" : "  ← macOS-only"}`);
  record("signing", { ...signing, counts, identities: id.all.map(({ name, team: t, ios }) => ({ name, team: t, ios })) });

  if (SIGN === "personal" && personalIOS.length === 0) {
    blocked(`个人 team（${PERSONAL_TEAM}）没有可用的 iOS 证书（Apple Development / Apple Distribution）`);
  }
  if (SIGN === "company" && companyIOS.length === 0) {
    // ⚠️ 不在这里就判死：owner 已在 Xcode 登录公司账号（Admin）⇒ 证书/描述文件可由
    //    `xcodebuild -allowProvisioningUpdates` 在**构建时**自动创建（tauri CLI 已带这个参数）。
    console.log(
      "\n  ⚠️ 公司 team 的 iOS 证书当前是 **0 个**（只有 Developer ID Application = macOS 用，⛔ 不能签 iOS）。\n" +
        "     按 2026-10-23 的口径：交给构建期的 `-allowProvisioningUpdates` 自动创建（owner 已在 Xcode 登录公司账号）；\n" +
        "     ⛔ 若构建仍失败，会打印 xcodebuild 的**原话**并以 `BLOCKED:` 收场 —— 不静默回退个人签名。",
    );
  }
  return signing;
}

// ── ② cargo 构建（产出 Swift 侧 .o）──────────────────────────────────────────
function findCargo() {
  const candidates = [process.env.CARGO, join(process.env.HOME || "", ".cargo", "bin", "cargo"), "/usr/local/bin/cargo", "cargo"].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return { path: c, version: `${r.stdout || ""}`.trim() };
  }
  return null;
}
/** project.yml 里 Xcode 侧的 `RUSTFLAGS`（配方 §3 第 7 行：iOS 上必须让 Rust 库把 Swift 符号留给 App 运行时）。 */
function rustflagsFromProjectYml() {
  try {
    const m = readFileSync(PROJECT_YML, "utf8").match(/^\s*RUSTFLAGS:\s*"([^"]*)"/m);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

async function stepCargo(env) {
  section(`② cargo build --lib --target ${RUST_TARGET} --release`);
  const cargo = findCargo();
  if (!cargo) blocked("找不到 cargo（本机 ~/.cargo/bin/cargo 不在 PATH 上；请显式给 CARGO=/abs/path/cargo）");
  record("cargo", { path: cargo.path, version: cargo.version });
  if (SKIP_CARGO) {
    console.log("（--skip-cargo：跳过 cargo，直接复用已有 .o）");
    record("cargoBuild", { skipped: true });
    return;
  }
  // ⚠️ **必须带 RUSTFLAGS**（配方 §3 第 7 行）：`[lib] crate-type = ["staticlib","cdylib","rlib"]`
  //    ⇒ `cargo build --lib` 会**额外**去链 cdylib，而 iOS 上那一步必然缺
  //    `_release_object` / `_retain_object` / `_string_from_bytes`（实测 exit 101、
  //    `Undefined symbols for architecture arm64`）⇒ 不补 `-Wl,-undefined,dynamic_lookup` 就到不了第 ③ 步。
  //    取的是 **project.yml 里 Xcode 侧那个值**（同一处事实源）⇒ 也让 tauri ios build 能复用这批产物。
  const rustflags = env.RUSTFLAGS ?? rustflagsFromProjectYml();
  const cargoEnv = { ...env };
  if (rustflags) cargoEnv.RUSTFLAGS = rustflags;
  record("cargoEnv", { RUSTFLAGS: rustflags ?? null });

  let res = await runStream(cargo.path, ["build", "--lib", "--target", RUST_TARGET, "--release"], {
    cwd: join(ROOT, "src-tauri"),
    env: cargoEnv,
    logName: `cargo-${TARGET_PLATFORM}`,
  });
  record("cargoBuild", { exit: res.code, log: res.logPath, RUSTFLAGS: rustflags ?? null });

  if (res.code !== 0) {
    const netish = /Failed to clone|error sending request|Connection refused|Could not resolve host|network|couldn't connect/i.test(res.out);
    const swiftLinkOnly =
      /Undefined symbols for architecture arm64/.test(res.out) &&
      /_release_object|_retain_object|_string_from_bytes/.test(res.out) &&
      /libshuyonote_lib\.dylib|dynamiclib/.test(res.out);
    console.error(`\n--- cargo 输出末尾 80 行 ---\n${res.out.split("\n").slice(-80).join("\n")}`);
    if (netish) {
      blocked(
        "cargo 构建红了，且输出里出现网络字样 ⇒ SwiftPM 拉不到 GitHub，" +
          "而本机代理 7890 不通（BLOCKED: 需要 owner 启动 FlClash 代理）。完整日志见 " + res.logPath,
      );
    }
    if (swiftLinkOnly) {
      // 只有"给 dylib 补 Swift 符号"这一步缺 RUSTFLAGS —— 依赖与 swift-rs 的 .o **已经编好了**。
      // 退一步只编"会产出 Swift 产物的那几个 crate"（不带 app 的 cdylib ⇒ 没有这一步链接）。
      console.log(
        "\n⚠️ 上面的失败只发生在 **app 的 cdylib 链接**（缺 3 个 Swift 符号，= 配方 §3 第 7 行那个坑）；" +
          "\n   SwiftPM 的 .o 在那之前已经产出。改用等价的子集命令补齐（⛔ 不是绕过网络）：" +
          "\n   cargo build --lib -p tauri -p tauri-plugin-dialog -p tauri-plugin-opener …",
      );
      const fallback = await runStream(
        cargo.path,
        ["build", "--lib", "--target", RUST_TARGET, "--release", "-p", "tauri", "-p", "tauri-plugin-dialog", "-p", "tauri-plugin-opener"],
        { cwd: join(ROOT, "src-tauri"), env: cargoEnv, logName: `cargo-${TARGET_PLATFORM}-fallback` },
      );
      record("cargoBuildFallback", { exit: fallback.code, log: fallback.logPath, why: "app cdylib 链接缺 Swift 符号（配方 §3 第 7 行）" });
      if (fallback.code !== 0) fatal(`子集 cargo 构建也失败（exit ${fallback.code}），日志：${fallback.logPath}`, 1);
      console.log("✓ 子集构建通过（Swift 侧 .o 已就绪）；app 的最终链接由 ⑥ 里 xcodebuild 那条链完成。");
      return;
    }
    fatal(`cargo build 失败（exit ${res.code}），日志：${res.logPath}`, 1);
  }
}

// ── ③ 从 swift-rs 的 Intermediates.noindex 组装 4 个归档 ─────────────────────
const TAURI_OBJECTS = ["Channel.o", "Invoke.o", "JSTypes.o", "JsonValue.o", "Logger.o", "Plugin.o", "Tauri.o", "UiUtils.o"];

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}

// 扫 `<target>/release/build/<crate>/out/swift-rs/<pkg>/out/Intermediates.noindex` 下的 .o，按包取最新一份。
function discoveryObjectRoots() {
  const buildRoot = join(ROOT, "src-tauri", "target", RUST_TARGET, "release", "build");
  if (!existsSync(buildRoot)) fatal(`构建目录不存在：${buildRoot}（先跑 cargo 构建，别加 --skip-cargo）`);
  const byPkg = new Map();
  for (const crateDir of readdirSync(buildRoot, { withFileTypes: true })) {
    if (!crateDir.isDirectory()) continue;
    const swiftRs = join(buildRoot, crateDir.name, "out", "swift-rs");
    if (!existsSync(swiftRs)) continue;
    for (const pkgDir of readdirSync(swiftRs, { withFileTypes: true })) {
      if (!pkgDir.isDirectory()) continue;
      const intermediate = join(swiftRs, pkgDir.name, "out", "Intermediates.noindex");
      if (!existsSync(intermediate)) continue;
      const objs = walk(intermediate).filter(
        (f) => f.endsWith(".o") && f.includes("/Objects-normal/arm64/") && f.includes(`/Release-${XCODE_SDK_TAG}/`),
      );
      if (!objs.length) continue;
      const newest = Math.max(...objs.map((f) => statSync(f).mtimeMs));
      const prev = byPkg.get(pkgDir.name);
      if (!prev || newest > prev.newest) byPkg.set(pkgDir.name, { pkg: pkgDir.name, intermediate, objs, newest });
    }
  }
  return byPkg;
}

function objectsIn(root, marker) {
  return root.objs.filter((f) => f.includes(marker));
}

function buildArchive(name, objects, outDir) {
  const staging = join(LIB_DIR, ".staging", name.replace(/\.a$/, ""));
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  if (!objects.length) fatal(`归档 ${name} 没有任何 .o —— 说明第 ③ 步取源失败`);
  for (const o of objects) copyFileSync(o, join(staging, o.split("/").pop()));
  const members = objects.map((o) => o.split("/").pop());
  const r = capture("ar", ["rcs", name, ...members], { cwd: staging });
  if (r.code !== 0) fatal(`ar rcs ${name} 失败：${r.out}`);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, name);
  rmSync(outPath, { force: true });
  copyFileSync(join(staging, name), outPath);
  return outPath;
}

function nmSymbols(archive) {
  const r = capture("nm", ["-arch", "arm64", "-gU", archive]);
  const lines = r.out.split("\n").filter(Boolean);
  const defined = [];
  for (const line of lines) {
    const m = line.match(/^[0-9a-fA-F]+\s+([A-Za-z])\s+(.+)$/);
    if (m) defined.push({ type: m[1], name: m[2].trim() });
  }
  // C ABI 符号：**只认 C 标识符形状**的全局定义（`_log_stdout` / `_register_plugin` …）。
  // ⚠️ 不能用"排除 `$s` 开头"那种写法 —— nm 里的名字带前导下划线（`_$s5Tauri…`），
  //    写成 `^$s` 一条都排不掉，于是"少 C 符号"的判定会把整堆 Swift 修饰名当成 C 符号（本脚本踩过）。
  const cSymbols = defined.map((d) => d.name).filter((n) => /^_[A-Za-z][A-Za-z0-9_]*$/.test(n));
  return { raw: r.out, defined, cSymbols, code: r.code };
}

function arMembers(archive) {
  const r = capture("ar", ["t", archive]);
  return r.out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function verifyArchives(archives) {
  section("③ 归档校验（ar t / nm -arch arm64 -gU）");
  const results = [];
  for (const a of archives) {
    const members = arMembers(a.path);
    const size = statSync(a.path).size;
    const nm = nmSymbols(a.path);
    const info = {
      lib: a.name,
      path: a.path.replace(ROOT + "/", ""),
      bytes: size,
      members,
      definedSymbols: nm.defined.length,
      cSymbols: nm.cSymbols,
      expectedCSymbols: a.expectCSymbols,
      missingCSymbols: a.expectCSymbols.filter((s) => !nm.cSymbols.includes(s)),
    };
    console.log(
      `  ${a.name}: ${size} B · members=[${members.join(" ")}] · 定义符号 ${info.definedSymbols} · C 符号 ${nm.cSymbols.length} [${nm.cSymbols.join(" ")}]`,
    );
    if (info.missingCSymbols.length) {
      fatal(`${a.name} 缺 C 符号：${info.missingCSymbols.join(" ")} —— 归档不完整，别继续构建`);
    }
    if (a.mustHaveMembers) {
      const missing = a.mustHaveMembers.filter((m) => !members.includes(m));
      if (missing.length) fatal(`${a.name} 缺成员：${missing.join(" ")}（配方 §1② 的"必须 8 个 .o"没满足）`);
    }
    results.push(info);
  }
  // 与参照物（模拟器版，2026-10-10 产物）比 C 符号集合：配方说这里是"命中 6 个"
  const refPath = join(GEN_APPLE, "Externals", "ios-sim-swift", "libTauriSwiftPM.a");
  if (existsSync(refPath)) {
    const ref = nmSymbols(refPath);
    const built = results.find((r) => r.lib === "libTauriSwiftPM.a");
    const missing = ref.cSymbols.filter((s) => !built.cSymbols.includes(s));
    const extra = built.cSymbols.filter((s) => !ref.cSymbols.includes(s));
    const cmp = { ref: refPath.replace(ROOT + "/", ""), refCSymbols: ref.cSymbols, missing, extra };
    record("tauriCSymbolDiffVsSimReference", cmp);
    if (missing.length) fatal(`libTauriSwiftPM.a 比参照物少 C 符号：${missing.join(" ")}`);
  }
  record("archives", results);
  return results;
}

async function stepArchives() {
  section(`③ 组装 4 个 SwiftPM 归档 → ${LIB_DIR.replace(ROOT + "/", "")}`);
  console.log(`   取源：src-tauri/target/${RUST_TARGET}/release/build/*/out/swift-rs/<包>/out/Intermediates.noindex/**/Objects-normal/arm64/*.o\n` +
    `   SDK 标记：Release-${XCODE_SDK_TAG}`);
  const byPkg = discoveryObjectRoots();
  const needed = ["Tauri", "tauri-plugin-dialog", "tauri-plugin-opener"];
  const missingPkgs = needed.filter((p) => !byPkg.has(p));
  if (missingPkgs.length) {
    fatal(
      `swift-rs 产物里找不到这些包：${missingPkgs.join(", ")}。\n` +
        `   ⇒ 多半是 SwiftPM 没拉到依赖（配方 §1①：需要 https_proxy=http://127.0.0.1:7890）\n` +
        `   ⇒ 那就是 BLOCKED，不是脚本问题。当前发现的包：${[...byPkg.keys()].join(", ") || "(无)"}`,
      2,
    );
  }
  for (const [pkg, root] of byPkg) record(`objects:${pkg}`, { dir: root.intermediate.replace(ROOT + "/", ""), count: root.objs.length, names: root.objs.map((f) => f.split("/").pop()).sort() });

  const tauriRoot = byPkg.get("Tauri");
  const tauriBuildObjs = objectsIn(tauriRoot, "/Tauri.build/");
  const tauriNames = tauriBuildObjs.map((f) => f.split("/").pop());
  const missingTauri = TAURI_OBJECTS.filter((n) => !tauriNames.includes(n));
  if (missingTauri.length) fatal(`Tauri.build 里缺这些 .o：${missingTauri.join(" ")}（现有：${tauriNames.join(" ")}）`);
  const extras = tauriNames.filter((n) => !TAURI_OBJECTS.includes(n));
  if (extras.length) console.log(`  ⚠️ Tauri.build 里还有非预期 .o（未打入，留证据）：${extras.join(" ")}`);
  // ⛔ 顺序按配方显式写死（不靠 readdir 顺序）；成员表要与参照物一致
  const tauriObjs = TAURI_OBJECTS.map((n) => tauriBuildObjs[tauriNames.indexOf(n)]);

  const swiftRsObjs = objectsIn(tauriRoot, "/SwiftRs.build/");
  const dialogRoot = byPkg.get("tauri-plugin-dialog");
  const openerRoot = byPkg.get("tauri-plugin-opener");
  const dialogObjs = objectsIn(dialogRoot, "/tauri-plugin-dialog.build/");
  const openerObjs = objectsIn(openerRoot, "/tauri-plugin-opener.build/");

  const archives = [
    {
      name: "libTauriSwiftPM.a",
      path: buildArchive("libTauriSwiftPM.a", tauriObjs, LIB_DIR),
      expectCSymbols: ["_log_stdout", "_on_webview_created", "_register_plugin", "_run_plugin_command"],
      mustHaveMembers: TAURI_OBJECTS,
    },
    {
      name: "libSwiftRsSwiftPM.a",
      path: buildArchive("libSwiftRsSwiftPM.a", swiftRsObjs, LIB_DIR),
      expectCSymbols: ["_data_from_bytes", "_release_object", "_retain_object", "_string_from_bytes"],
    },
    {
      name: "libtauri-plugin-dialog-plugino.a",
      path: buildArchive("libtauri-plugin-dialog-plugino.a", dialogObjs, LIB_DIR),
      expectCSymbols: ["_init_plugin_dialog"],
    },
    {
      name: "libtauri-plugin-opener-plugino.a",
      path: buildArchive("libtauri-plugin-opener-plugino.a", openerObjs, LIB_DIR),
      expectCSymbols: ["_init_plugin_opener"],
    },
  ];
  rmSync(join(LIB_DIR, ".staging"), { recursive: true, force: true });
  return verifyArchives(archives);
}

// ── ④ 改 project.yml（唯一允许的定制点）──────────────────────────────────────
function stepPatchProjectYml(signing) {
  section("④ project.yml：归档路径 → 仓内稳定路径 + 版本号/签名与事实源对齐");
  if (!APP_VERSION) fatal("tauri.conf.json 里没有 version");
  let yml = readFileSync(PROJECT_YML, "utf8");
  const before = yml.slice();
  const changes = [];

  // 4.1 版号：project.yml 是**生成物**，它硬编码的 CFBundle* 会过期（实测 1.91.26）。
  //     事实源只有一个：tauri.conf.json 的 version（与桌面同一个号）。
  const verRe1 = /(CFBundleShortVersionString:\s*)([^\s"']+)/;
  const verRe2 = /(CFBundleVersion:\s*)("?)([^"\n]+)("?)/;
  if (verRe1.test(yml)) {
    const cur = yml.match(verRe1)[2];
    yml = yml.replace(verRe1, (_, p) => `${p}${APP_VERSION}`);
    if (cur !== APP_VERSION) changes.push(`CFBundleShortVersionString: ${cur} → ${APP_VERSION}`);
  }
  if (verRe2.test(yml)) {
    const m = yml.match(verRe2);
    const cur = m[3];
    yml = yml.replace(verRe2, `$1"${APP_VERSION}"`);
    if (cur !== APP_VERSION) changes.push(`CFBundleVersion: ${cur} → "${APP_VERSION}"`);
  }

  // 4.2 device 四行 OTHER_LDFLAGS：把 /tmp/ios-swiftpm-libs/ 换成仓内稳定路径
  //     ⚠️ 只改 device 那条；sim 那条在 4.3 单独处理（它原是 Externals/ios-sim-swift）。
  const deviceLineRe = /("OTHER_LDFLAGS\[sdk=iphoneos\*\]":\s*")([^"\n]*)(")/;
  if (deviceLineRe.test(yml)) {
    const cur = yml.match(deviceLineRe)[2];
    const next = cur
      .replace(/\/tmp\/ios-swiftpm-libs\//g, "$(PROJECT_DIR)/../../target/ios-swiftpm-libs/")
      .replace(/\$\(PROJECT_DIR\)\/\.\.\/\.\.\/target\/\.\.\/\.\.\/target\//g, "$(PROJECT_DIR)/../../target/");
    if (next !== cur) {
      yml = yml.replace(deviceLineRe, (_, p1, _p2, p3) => `${p1}${next}${p3}`);
      changes.push("OTHER_LDFLAGS[sdk=iphoneos*]: /tmp/ios-swiftpm-libs/ → $(PROJECT_DIR)/../../target/ios-swiftpm-libs/");
    }
  } else {
    fatal("project.yml 里找不到 OTHER_LDFLAGS[sdk=iphoneos*] 那一行 —— 配方变了？先读 project.yml");
  }

  // 4.3 sim 四行：Externals/ios-sim-swift → 仓内稳定路径（只在 sim 归档存在时才改，
  //     否则保持原样，免得把"还没生成 sim 归档"变成"必红"）
  const simArchiveNames = ["libTauriSwiftPM.a", "libSwiftRsSwiftPM.a", "libtauri-plugin-dialog-plugino.a", "libtauri-plugin-opener-plugino.a"];
  const simLibsReady = simArchiveNames.every((n) => existsSync(join(LIB_DIR_SIM, n)));
  const simLineRe = /("OTHER_LDFLAGS\[sdk=iphonesimulator\*\]":\s*")([^"\n]*)(")/;
  if (simLibsReady && simLineRe.test(yml)) {
    const cur = yml.match(simLineRe)[2];
    const next = cur.replace(
      /\$\(PROJECT_DIR\)\/Externals\/ios-sim-swift\//g,
      "$(PROJECT_DIR)/../../target/ios-swiftpm-libs/sim/",
    );
    if (next !== cur) {
      yml = yml.replace(simLineRe, (_, p1, _p2, p3) => `${p1}${next}${p3}`);
      changes.push("OTHER_LDFLAGS[sdk=iphonesimulator*]: Externals/ios-sim-swift/ → $(PROJECT_DIR)/../../target/ios-swiftpm-libs/sim/");
    }
  }

  // 4.4 卫生：`sources: Externals` 没排除掉的中间产物会被当**资源**整批拷进 app 包
  //     （实测 10-20 的 IPA 里：12 个 .o ＋ SwiftRs.swiftmodule/.swiftdoc/.swiftsourceinfo 等）。
  //     排除清单是**只删多余**：.a 本来就被排除（它们靠 OTHER_LDFLAGS 链接，不走资源）。
  //     ⚠️ 写成"整段规范化"而不是"往字符串里塞一行" —— 后者第二遍跑就不再匹配（本脚本踩过）。
  const REQUIRED_EXTERNAL_EXCLUDES = ['"**/*.a"', '"**/*.o"', '"**/*.swiftmodule"', '"**/*.swiftdoc"', '"**/*.swiftsourceinfo"'];
  const extBlockRe = /(      - path: Externals\n        excludes:\n)((?:          - [^\n]*\n)+)/;
  const extMatch = yml.match(extBlockRe);
  if (extMatch) {
    const current = extMatch[2].split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
    const merged = [...current.filter((v) => !REQUIRED_EXTERNAL_EXCLUDES.includes(v)), ...REQUIRED_EXTERNAL_EXCLUDES];
    const block = extMatch[1] + merged.map((v) => `          - ${v}\n`).join("");
    if (block !== extMatch[0]) {
      yml = yml.replace(extMatch[0], block);
      const added = REQUIRED_EXTERNAL_EXCLUDES.filter((v) => !current.includes(v));
      if (added.length) changes.push(`Externals sources excludes: + ${added.join(" ")}（IPA 里的残留中间产物）`);
    }
  }
  // `shuyonote_iOS` 整个目录也是资源来源 ⇒ 那里面的 `.bak-*` 备份 plist 会被原样装进 app 包
  // （10-20 的 IPA 里真有一个 `Payload/ShuyoNote.app/Info.plist.bak-noscene`）。
  const iosSrc = `      - path: shuyonote_iOS\n`;
  const iosFixed = `      - path: shuyonote_iOS\n        excludes:\n          - "*.bak-*"\n`;
  if (yml.includes(iosSrc) && !yml.includes('"*.bak-*"')) {
    yml = yml.replace(iosSrc, iosFixed);
    changes.push('shuyonote_iOS sources excludes: "*.bak-*"（IPA 里那个 Info.plist.bak-noscene）');
  }

  // 4.5 签名三件套：DEVELOPMENT_TEAM / CODE_SIGN_STYLE / CODE_SIGN_IDENTITY
  //     ⚠️ 默认 **company**（Puyang Shuyou / team D53949JLS2）；个人签名只有 `--sign personal` 才写进来。
  //     这里写**解析后的字面值**（不是 `${ENV}` 占位）—— XcodeGen 的 `${VAR}` 在变量没设时**会原样留下**，
  //     那会变成一个看不懂的签名错误；脚本是唯一的生成入口，字面值更稳。
  if (signing && signing.team) {
    const want = { DEVELOPMENT_TEAM: signing.team, CODE_SIGN_STYLE: signing.style, CODE_SIGN_IDENTITY: signing.identity };
    const note = {
      DEVELOPMENT_TEAM: `DEVELOPMENT_TEAM → ${signing.team}（--sign ${signing.sign}）`,
      CODE_SIGN_STYLE: `CODE_SIGN_STYLE → ${signing.style}`,
      CODE_SIGN_IDENTITY: `CODE_SIGN_IDENTITY → ${signing.identity}（${signing.distribution ? "分发档" : "开发档"}）`,
    };
    for (const [key, value] of Object.entries(want)) {
      const re = new RegExp(`(\\n[ \\t]*${key}:[ \\t]*)([^\\n]*)`);
      const m = yml.match(re);
      if (m) {
        if (m[2].trim() !== value) {
          yml = yml.replace(re, `$1${value}`);
          changes.push(note[key]);
        }
      } else if (key !== "CODE_SIGN_IDENTITY") {
        fatal(`project.yml 里找不到 ${key} —— 签名档位无从落地，先读 project.yml`, 1);
      } else {
        // 没有 CODE_SIGN_IDENTITY 这一行时，插在 DEVELOPMENT_TEAM 之后
        yml = yml.replace(/(\n[ \t]*DEVELOPMENT_TEAM:[^\n]*)/, `$1\n        CODE_SIGN_IDENTITY: ${value}`);
        changes.push(note[key]);
      }
    }
  }

  if (yml !== before) writeFileSync(PROJECT_YML, yml);
  if (!changes.length) console.log("  （project.yml 已是目标形态，未改）");
  for (const c of changes) console.log(`  ✓ ${c}`);
  record("projectYml", { path: PROJECT_YML.replace(ROOT + "/", ""), changed: changes });
}

// ── ⑤ xcodegen（从 project.yml 重新生成 pbxproj —— ⛔ 不是 tauri ios init）──────
function findXcodegen() {
  const candidates = [process.env.XCODEGEN, join(process.env.HOME || "", "homebrew", "bin", "xcodegen"), "/opt/homebrew/bin/xcodegen", "/usr/local/bin/xcodegen", "xcodegen"].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return { path: c, version: `${r.stdout || ""}`.trim() };
  }
  return null;
}
function stepXcodegen() {
  section("⑤ xcodegen generate（project.yml → project.pbxproj）");
  if (NO_XCODEGEN) {
    console.log("（--no-xcodegen：跳过；⚠️ 若 project.yml 改过而 pbxproj 没重生成，链接参数不会生效）");
    record("xcodegen", { skipped: true });
    return;
  }
  const xg = findXcodegen();
  if (!xg) fatal("找不到 xcodegen（本机 ~/homebrew/bin/xcodegen）—— 没有它 project.yml 的改动进不了 pbxproj", 2);
  record("xcodegen", { path: xg.path, version: xg.version });
  const res = capture(xg.path, ["generate"], { cwd: GEN_APPLE });
  const tail = res.out.split("\n").slice(-20).join("\n");
  console.log(tail);
  record("xcodegenRun", { exit: res.code });
  if (res.code !== 0) fatal(`xcodegen generate 失败（exit ${res.code}）`, 1);
  // 回验：pbxproj 里必须真的出现新路径
  const pbx = readFileSync(join(GEN_APPLE, "shuyonote.xcodeproj", "project.pbxproj"), "utf8");
  const must = "$(PROJECT_DIR)/../../target/ios-swiftpm-libs/";
  const ok = pbx.includes(must);
  record("pbxprojVerify", { containsRepoStableLibPath: ok, containsTmpPath: pbx.includes("/tmp/ios-swiftpm-libs") });
  if (!ok) fatal("xcodegen 跑完了，但 project.pbxproj 里没有仓内稳定路径 —— project.yml 的改动没进去");
}

// ── ⑥ tauri ios build ────────────────────────────────────────────────────────
/**
 * 公司**分发档**的最后一步：拿 tauri 归档出来的（未签名）xcarchive，用
 * `xcodebuild -exportArchive -allowProvisioningUpdates` **重新按 App Store 分发签名**并导出 IPA。
 *
 * 为什么由脚本自己做而不交给 tauri CLI：tauri 的 device 构建会先做一次 **development** 签名的 `build`，
 * 而开发档描述文件要求至少 1 台注册设备（公司 team 当前 0 台）⇒ 必败；分发档不需要设备。
 */
async function stepExportDistribution() {
  section("⑥.5 公司分发导出：xcodebuild -exportArchive -allowProvisioningUpdates");
  const archive = join(GEN_APPLE, "build", "shuyonote_iOS.xcarchive");
  if (!existsSync(archive)) fatal(`分发导出需要 xcarchive，但不存在：${archive}`);
  const exportDir = join(LOG_DIR, `export-dist-${Date.now()}`);
  rmSync(exportDir, { recursive: true, force: true });
  mkdirSync(exportDir, { recursive: true });
  const optsPath = join(LOG_DIR, "ExportOptions-distribution.plist");
  writeFileSync(
    optsPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>destination</key><string>export</string>
\t<key>method</key><string>app-store-connect</string>
\t<key>signingStyle</key><string>automatic</string>
\t<key>stripSwiftSymbols</key><true/>
\t<key>teamID</key><string>${COMPANY_TEAM}</string>
\t<key>thinning</key><string>&lt;none&gt;</string>
</dict>
</plist>
`,
  );
  const res = await runStream(
    "xcodebuild",
    ["-exportArchive", "-archivePath", archive, "-exportOptionsPlist", optsPath, "-exportPath", exportDir, "-allowProvisioningUpdates"],
    { cwd: GEN_APPLE, logName: "xcodebuild-export-distribution" },
  );
  const signError = signingFailure(res.out);
  const ipa = join(exportDir, "ShuyoNote.ipa");
  record("distributionExport", {
    exit: res.code,
    log: res.logPath,
    exportOptions: optsPath.replace(ROOT + "/", ""),
    ipa: existsSync(ipa) ? ipa.replace(ROOT + "/", "") : null,
    signError: signError || null,
  });
  if (res.code !== 0 || !existsSync(ipa)) {
    if (signError) console.error(`\n--- 签名相关原话 ---\n${signError}`);
    blocked(
      `公司分发导出失败（xcodebuild -exportArchive exit ${res.code}）` +
        (signError ? `：${signError.split("\n")[0]}` : "") +
        `\n  命令：xcodebuild -exportArchive -archivePath ${archive} -exportOptionsPlist ${optsPath} -exportPath ${exportDir} -allowProvisioningUpdates` +
        `\n  日志：${res.logPath}`,
    );
  }
  // 把分发档 IPA 放到 tauri 的常规产物位置，后面 ⑦ 的校验与报告都读这一份
  const canonical = join(GEN_APPLE, "build", "arm64", "ShuyoNote.ipa");
  mkdirSync(dirname(canonical), { recursive: true });
  copyFileSync(ipa, canonical);
  const summaryPath = join(exportDir, "DistributionSummary.plist");
  LAST_EXPORT = {
    ipaPath: canonical,
    exportDir,
    distributionSummaryPath: existsSync(summaryPath) ? summaryPath : null,
    summary: existsSync(summaryPath) ? plistJson(summaryPath) : null,
  };
  record("distributionExportSummary", LAST_EXPORT.summary ? { certificates: Object.values(LAST_EXPORT.summary)[0]?.[0]?.certificate, profile: Object.values(LAST_EXPORT.summary)[0]?.[0]?.profile, team: Object.values(LAST_EXPORT.summary)[0]?.[0]?.team } : null);
  console.log(`  ✓ 分发档 IPA → ${canonical.replace(ROOT + "/", "")}`);
}

/** 从构建输出里摘出**签名类**错误的原话（找不到就返回 null）。 */
function signingFailure(out) {
  const patterns = [
    /No account for team[^\n]*/i,
    /No signing certificate[^\n]*/i,
    /no profiles for [^\n]*/i,
    /Provisioning profile[^\n]*/i,
    /requires a development team[^\n]*/i,
    /Signing for \"[^"]+\" requires a development team[^\n]*/i,
    /Failed to find a valid App ID[^\n]*/i,
    /the user is not associated with[^\n]*/i,
    /Unable to launch (?:.*?) because it has an invalid code signature[^\n]*/i,
  ];
  const lines = [];
  for (const p of patterns) {
    const m = out.match(p);
    if (m) lines.push(m[0].trim());
  }
  if (!lines.length) return null;
  return [...new Set(lines)].join("\n");
}

async function stepTauriBuild(env, signing) {
  const exportMethod = (signing && signing.exportMethod) || "debugging";
  section(`⑥ pnpm tauri ios build --target ${TAURI_CLI_TARGET} --export-method ${exportMethod}`);
  // ⚠️ 模拟器构建前必须删掉**上一轮 device 构建留下的 xcarchive**：
  //    tauri CLI 打包那步要把 `…/Products/Applications/ShuyoNote.app` 改名到 xcarchive 里，
  //    而 device 那份已经占了同名目录 ⇒ 逐字报
  //      `failed to rename app …: Directory not empty (os error 66)`（10-10 的笔记也记了这条）。
  //    device 构建本身不需要这个清理（它自己覆盖）。
  {
    const staleList = [join(GEN_APPLE, "build", "shuyonote_iOS.xcarchive")];
    if (TARGET_PLATFORM === "sim") staleList.push(join(GEN_APPLE, "build", "arm64-sim"));
    for (const stale of staleList) {
      if (existsSync(stale)) {
        rmSync(stale, { recursive: true, force: true });
        console.log(`  已删掉上一轮的模拟器产物（否则 CLI 会报 \`Directory not empty\`）：${stale.replace(ROOT + "/", "")}`);
      }
    }
  }
  const startedMs = Date.now();
  const buildArgs = ["tauri", "ios", "build", "--target", TAURI_CLI_TARGET, "--export-method", exportMethod];
  // ⭐ 公司**分发档**（App Store）走的是：tauri 只**归档且不签名**（`--no-sign --archive-only`），
  //    然后由本脚本自己跑 `xcodebuild -exportArchive -allowProvisioningUpdates` 重新签名导出。
  //    为什么必须这样（2026-10-23 逐字读数）：
  //      · tauri 的 device 构建第一步是 `xcodebuild … build`（**development** 签名）——
  //        公司 team 目前 **0 台注册设备** ⇒ 逐字报
  //          `Your team has no devices from which to generate a provisioning profile`
  //          `No profiles for 'cn.shuyo.shuyonote' were found … iOS App Development provisioning profiles`
  //        ⇒ 走不通（App Store 分发本来就不需要设备，是**开发档**才需要）。
  //      · 而 `xcodebuild -exportArchive -allowProvisioningUpdates` 会**按分发档**重新签名，
  //        并在公司账号下自动创建 **Cloud Managed Apple Distribution 证书 + iOS Team Store 描述文件**（实测成功）。
  const noSignDistribution = !!(signing && signing.distribution);
  if (noSignDistribution) {
    buildArgs.push("--no-sign", "--archive-only");
  }
  if (FRONTEND_DIST) {
    // 诊断用：拿一份**已经建好的**前端目录（例如加了临时探针的 dist），跳过 beforeBuildCommand。
    // ⚠️ 只用于排查（`--frontend-dist`），正常出包不给它 ⇒ 走 `beforeBuildCommand` 的正常链。
    const conf = JSON.stringify({ build: { beforeBuildCommand: "", frontendDist: resolve(FRONTEND_DIST) } });
    buildArgs.push("-c", conf);
    console.log(`⚠️ --frontend-dist=${resolve(FRONTEND_DIST)}（跳过 beforeBuildCommand）`);
  }
  const res = await runStream("pnpm", buildArgs, {
    cwd: ROOT,
    env,
    logName: `tauri-ios-build-${TARGET_PLATFORM}`,
  });
  const count = (re) => (res.out.match(re) || []).length;
  const metrics = {
    exit: res.code,
    log: res.logPath,
    buildSucceeded: count(/\*\* BUILD SUCCEEDED \*\*/g),
    undefinedSymbols: count(/Undefined symbols/g),
    duplicateSymbol: count(/duplicate symbol/g),
    elapsedSec: Math.round((Date.now() - startedMs) / 1000),
  };
  metrics.exportMethod = exportMethod;
  metrics.archiveOnly = noSignDistribution;
  metrics.usesAllowProvisioningUpdates = /-allowProvisioningUpdates/.test(res.out);
  record("tauriIosBuild", metrics);
  if (res.code === 0 && noSignDistribution && !ARCHIVES_ONLY) {
    await stepExportDistribution();
  }
  if (res.code !== 0) {
    console.error(`\n--- 构建输出末尾 120 行 ---\n${res.out.split("\n").slice(-120).join("\n")}`);
    // 签名类失败 ⇒ 明确记为 BLOCKED（附 xcodebuild 原话），⛔ 绝不静默回退个人签名。
    const signError = signingFailure(res.out);
    if (signError) {
      console.error(`\n--- 签名相关原话 ---\n${signError}`);
      if (signing && signing.sign === "company" && !SIGNING_PROBE) {
        blocked(
          `公司签名不可用（team ${signing.team}）：xcodebuild 报「${signError.split("\n")[0]}」。\n` +
            `  需要 owner：Xcode → Settings → Accounts 登录公司 Apple ID 并完成 2FA；\n` +
            `  或提供 Apple Distribution 证书(.p12) + App Store 描述文件。\n` +
            `  再次尝试：node scripts/ios-build.mjs --sign company`,
        );
      }
      fatal(`签名失败（详见上方原话 / 日志 ${res.logPath}）`, 1);
    }
    fatal(`tauri ios build 失败（exit ${res.code}），日志：${res.logPath}`, 1);
  }
  return metrics;
}

// ── ⑦ 校验产物 ───────────────────────────────────────────────────────────────
function plistJson(pathOrFile) {
  const r = capture("plutil", ["-convert", "json", "-o", "-", pathOrFile]);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}
function stepVerifyIpa(buildMetrics, signing) {
  section("⑦ 校验产物");
  const out = {};
  if (TARGET_PLATFORM === "device") {
    const ipa = LAST_EXPORT ? LAST_EXPORT.ipaPath : join(GEN_APPLE, "build", "arm64", "ShuyoNote.ipa");
    if (!existsSync(ipa)) fatal(`IPA 不存在：${ipa}`);
    const st = statSync(ipa);
    const sha = capture("shasum", ["-a", "256", ipa]).out.trim().split(/\s+/)[0];
    // Info.plist：从 IPA 里取（不是工程目录里那份 —— 那份可能已被别的步骤覆盖）
    // ⚠️ 必须让 unzip **直接落盘**再 plutil：app 包里的 Info.plist 是**二进制** plist，
    //    用 spawnSync 的 utf8 stdout 接会把字节解坏（本脚本踩过一次：读出来 version=undefined）。
    const plistOutDir = join(LOG_DIR, "ipa-inspect");
    rmSync(plistOutDir, { recursive: true, force: true });
    mkdirSync(plistOutDir, { recursive: true });
    const un = capture("unzip", ["-q", "-o", ipa, "Payload/ShuyoNote.app/Info.plist", "-d", plistOutDir]);
    const tmpPlist = join(plistOutDir, "Payload", "ShuyoNote.app", "Info.plist");
    if (un.code !== 0 || !existsSync(tmpPlist)) fatal(`从 IPA 里取 Info.plist 失败（exit ${un.code}）：${un.out}`);
    const info = plistJson(tmpPlist);
    const listing = capture("unzip", ["-l", ipa]).out;
    const entries = listing.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("Archive:") && !l.startsWith("Length") && !l.startsWith("---"));
    const strayO = entries.filter((l) => /\s\.o$|\/[^/]*\.o$/.test(l) || /\.o$/.test(l.split(/\s+/).pop() || ""));
    const countO = (listing.match(/\.o$/gm) || []).length;
    const countSwiftmodule = (listing.match(/\.swiftmodule$/gm) || []).length;
    const countSwiftdoc = (listing.match(/\.swiftdoc$/gm) || []).length;
    const countSwiftsourceinfo = (listing.match(/\.swiftsourceinfo$/gm) || []).length;
    const strayNames = listing
      .split("\n")
      .map((l) => l.trim().split(/\s+/).pop() || "")
      .filter((n) => /\.(o|swiftmodule|swiftdoc|swiftsourceinfo)$/.test(n))
      .sort();
    // 签名：**从 IPA 里的 app 二进制读**（分发档时 xcarchive 里那份是"未签名"的归档体，
    //       真正被签的是导出后的这个 app —— 读错就会把"公司签名"读成"无签名"）。
    const appOutDir = join(LOG_DIR, "ipa-inspect-app");
    rmSync(appOutDir, { recursive: true, force: true });
    mkdirSync(appOutDir, { recursive: true });
    const unApp = capture("unzip", ["-q", "-o", ipa, "Payload/ShuyoNote.app/ShuyoNote", "Payload/ShuyoNote.app/embedded.mobileprovision", "-d", appOutDir]);
    const binary = join(appOutDir, "Payload", "ShuyoNote.app", "ShuyoNote");
    let codesign = null;
    if (unApp.code === 0 && existsSync(binary)) {
      const cs = capture("codesign", ["-dv", "--verbose=4", binary]);
      const auth = (cs.out.match(/Authority=([^\n]+)/g) || []).map((s) => s.replace("Authority=", "").trim());
      const ident = (cs.out.match(/Identifier=([^\n]+)/) || [])[1];
      const flags = (cs.out.match(/flags=([^\n]+)/) || [])[1];
      const teamFromCert = (cs.out.match(/TeamIdentifier=([^\n]+)/) || [])[1];
      codesign = { authorities: auth, identifier: ident?.trim(), flags: flags?.trim(), teamIdentifier: teamFromCert?.trim() ?? null };
    }
    const distSummaryPath = LAST_EXPORT?.distributionSummaryPath || join(GEN_APPLE, "build", "DistributionSummary.plist");
    const dist = existsSync(distSummaryPath) ? plistJson(distSummaryPath) : null;
    const distEntry = dist ? Object.values(dist)[0]?.[0] : null;
    // 导出 method / 团队：**以 `build/ExportOptions.plist` 为准**。
    // ⚠️ `DistributionSummary.plist` 里**没有** method 键（新 Xcode 格式）——本脚本一开始读它，
    //    结果读出个 `"?"`；真正决定怎么导出的是 tauri CLI 传给 xcodebuild 的 ExportOptions.plist。
    // ⚠️ 分发档的 ExportOptions **不是** tauri 写的那份（`build/ExportOptions.plist` 会留着上一轮
    //    个人构建的 method=debugging/teamID=M3UZLB6XK6）⇒ 分发档要从导出目录里读**实际用的**那份。
    const exportOptsPath = LAST_EXPORT
      ? join(LAST_EXPORT.exportDir, "ExportOptions.plist")
      : join(GEN_APPLE, "build", "ExportOptions.plist");
    const exportOpts = existsSync(exportOptsPath) ? plistJson(exportOptsPath) : null;
    out.ipa = {
      path: ipa.replace(ROOT + "/", ""),
      bytes: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      mtimeAfterStart: st.mtimeMs >= startedAt.getTime(),
      sha256: sha,
      CFBundleIdentifier: info?.CFBundleIdentifier,
      CFBundleShortVersionString: info?.CFBundleShortVersionString,
      CFBundleVersion: info?.CFBundleVersion,
      MinimumOSVersion: info?.MinimumOSVersion,
      versionMatchesTauriConf: info?.CFBundleShortVersionString === APP_VERSION,
      entryCount: entries.length,
      strayObjectFiles: countO,
      straySwiftmodule: countSwiftmodule,
      straySwiftdoc: countSwiftdoc,
      straySwiftsourceinfo: countSwiftsourceinfo,
      strayNames,
      codesign,
      exportMethod: exportOpts?.method ?? null,
      signingStyle: exportOpts?.signingStyle ?? null,
      teamID: exportOpts?.teamID ?? null,
      provisioningProfile: distEntry?.profile?.name ?? distEntry?.provisioningProfile?.name ?? null,
      provisioningProfileExpires: distEntry?.profile?.dateExpires ?? null,
      distributionCertificate: distEntry?.certificate || null,
      appStoreEntitlements: distEntry?.entitlements ?? null,
    };
    if (signing && signing.team) {
      // ⚠️ 2026-10-23（真踩过）：team **不能**从证书 CN 的括号里取 —— 那是 Apple 给这张证书的
      //    UID（如 `Apple Development: Zhi yong Zhai (XSCGZ4DA8U)`），不是 Team ID ⇒ 会把
      //    **公司 team 签的包误判成个人**（构建 exit 0、ipa 却是对的，脚本自己红 ✗）。
      //    唯一权威来源是 `codesign -dv` 的 `TeamIdentifier=`（= 描述文件里的 team）。
      const certTeams = [out.ipa.codesign?.teamIdentifier].filter(Boolean);
      out.ipa.signingTeamExpected = signing.team;
      out.ipa.signingTeamFound = certTeams[0] || null;
      out.ipa.signingMatchesRequested = certTeams.includes(signing.team);
      console.log(`[签名核对] 期望 team=${signing.team}（--sign ${signing.sign}）· 签名 TeamIdentifier=${certTeams.join(",") || "(空)"} · match=${out.ipa.signingMatchesRequested}`);
      if (!out.ipa.signingMatchesRequested) {
        fatal(
          `IPA 的签名主体与请求的档位不一致：期望 team=${signing.team}，实际=${certTeams.join(",") || "(空)"}。` +
            `⛔ 不接受"个人签名冒充公司"的包`,
          2,
        );
      }
    }
    console.log(JSON.stringify(out.ipa, null, 2));
    if (!out.ipa.mtimeAfterStart) fatal("IPA 的 mtime 早于本次开始 —— 这是**旧包**，不能当本轮产物");
    if (!out.ipa.versionMatchesTauriConf) fatal(`IPA 版本 ${out.ipa.CFBundleShortVersionString} ≠ tauri.conf ${APP_VERSION}`);
    if (buildMetrics) {
      // ⚠️ 公司分发档走的是 `--archive-only --no-sign`：归档产物由 ⑥.5 的 export 成功来保证，
      //    日志里**不一定**有 `** BUILD SUCCEEDED **`（实测 exit 0 但该标记 0 次）⇒ 只在非归档档要求它。
      if (buildMetrics.buildSucceeded < 1 && !buildMetrics.archiveOnly) fatal("tauri ios build 输出里没有 `** BUILD SUCCEEDED **`");
      if (buildMetrics.undefinedSymbols > 0) fatal("构建输出里有 `Undefined symbols`");
      if (buildMetrics.duplicateSymbol > 0) fatal("构建输出里有 `duplicate symbol`");
    }
  } else {
    const app = join(GEN_APPLE, "build", "arm64-sim", "ShuyoNote.app");
    if (!existsSync(app)) fatal(`模拟器 app 不存在：${app}`);
    const info = plistJson(join(app, "Info.plist"));
    const exe = join(app, "ShuyoNote");
    out.simApp = {
      path: app.replace(ROOT + "/", ""),
      mtime: new Date(statSync(app).mtimeMs).toISOString(),
      mtimeAfterStart: statSync(app).mtimeMs >= startedAt.getTime(),
      CFBundleShortVersionString: info?.CFBundleShortVersionString,
      CFBundleVersion: info?.CFBundleVersion,
      executable: existsSync(exe) ? { bytes: statSync(exe).size } : null,
      codesign: existsSync(exe) ? capture("codesign", ["-dv", app]).out.split("\n").filter((l) => /Authority|Identifier=|flags=/.test(l)).map((s) => s.trim()) : null,
    };
    console.log(JSON.stringify(out.simApp, null, 2));
  }
  record("artifacts", out);
  return out;
}

// ── ⑧（可选）模拟器：装 → 启 → 截图 ─────────────────────────────────────────
function stepRunSim() {
  section("⑧ 模拟器：boot → install → launch → screenshot");
  if (TARGET_PLATFORM !== "sim") fatal("--run-sim 只跟 --sim / --target aarch64-sim 一起用");
  const app = join(GEN_APPLE, "build", "arm64-sim", "ShuyoNote.app");
  const udidPreferred = process.env.IOS_SIM_UDID;
  let udid = udidPreferred;
  if (!udid) {
    const list = capture("xcrun", ["simctl", "list", "devices", "available"]);
    const line = list.out.split("\n").find((l) => /iPhone 17 \(/.test(l)) || list.out.split("\n").find((l) => /iPhone \d+.*\([0-9A-F-]{36}\)/.test(l));
    udid = line?.match(/\(([0-9A-F-]{36})\)/)?.[1];
  }
  if (!udid) fatal("没找到可用 iPhone 模拟器（用 IOS_SIM_UDID 显式指定）");
  record("simulator", { udid, boot: capture("xcrun", ["simctl", "boot", udid]).out.trim() });
  capture("xcrun", ["simctl", "bootstatus", udid, "-b"]);
  const inst = capture("xcrun", ["simctl", "install", udid, app]);
  record("simInstall", { exit: inst.code, out: inst.out.trim() });
  if (inst.code !== 0) fatal(`simctl install 失败：${inst.out}`);
  const launch = capture("xcrun", ["simctl", "launch", udid, "cn.shuyo.shuyonote"]);
  record("simLaunch", { exit: launch.code, out: launch.out.trim() });
  // 等它把 WebView 画出来（冷启动 + release 包首次解包）
  spawnSync("sleep", ["8"]);
  const shot = "/tmp/ios-sim.png";
  const ss = capture("xcrun", ["simctl", "io", udid, "screenshot", shot]);
  record("screenshot", { path: shot, exit: ss.code, out: ss.out.trim(), bytes: existsSync(shot) ? statSync(shot).size : null });
  if (ss.code !== 0) fatal(`screenshot 失败：${ss.out}`);
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  mkdirSync(LOG_DIR, { recursive: true });
  const head = capture("git", ["rev-parse", "HEAD"]).out.trim();
  const headShort = capture("git", ["rev-parse", "--short", "HEAD"]).out.trim();
  const headSubject = capture("git", ["log", "-1", "--pretty=%s"]).out.trim();
  const pkgVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  record("git", { HEAD: head, short: headShort, subject: headSubject, packageVersion: pkgVersion, tauriConfVersion: APP_VERSION, dirty: capture("git", ["status", "--porcelain"]).out.trim().split("\n").filter(Boolean) });
  console.log(`iOS 打包脚本 · 平台=${TARGET_PLATFORM} · rust target=${RUST_TARGET} · 版本=${APP_VERSION}`);
  console.log(`仓根：${ROOT}`);
  console.log(`HEAD：${headShort} · ${headSubject}`);
  const env = await stepProxy();
  // ⚠️ **cargo 必须在 PATH 上**：不只本脚本用 —— `tauri ios build` 自己要跑 `cargo metadata`，
  //    而 Xcode 的 `Build Rust Code` 阶段（`tauri ios xcode-script`）也是从 PATH 找 cargo。
  //    本机实测：cargo 只在 `~/.cargo/bin`（不在非交互 shell 的 PATH 里）⇒ 不补这一行，
  //    `pnpm tauri ios build` 会直接报 `failed to run 'cargo metadata' … No such file or directory`（exit 1）。
  const cargoProbe = findCargo();
  if (cargoProbe) {
    const cargoDir = dirname(cargoProbe.path);
    env.PATH = `${cargoDir}:${env.PATH ?? ""}`;
    console.log(`PATH += ${cargoDir}（cargo / rustc）`);
  }
  const signing = await stepSigning();
  if (!SKIP_CARGO) await stepCargo(env);
  else record("cargoBuild", { skipped: true });
  const archives = await stepArchives();
  stepPatchProjectYml(signing);
  stepXcodegen();
  let buildMetrics = null;
  if (!ARCHIVES_ONLY) {
    buildMetrics = await stepTauriBuild(env, signing);
    stepVerifyIpa(buildMetrics, signing);
    if (RUN_SIM) stepRunSim();
  } else {
    console.log("\n（--archives-only：只做归档 + project.yml + xcodegen，不跑 xcodebuild）");
  }
  section("完成");
  const summary = {
    platform: TARGET_PLATFORM,
    version: APP_VERSION,
    head: headShort,
    signing,
    archives: archives.map((a) => ({ lib: a.lib, bytes: a.bytes, cSymbols: a.cSymbols })),
    build: buildMetrics,
  };
  console.log(JSON.stringify(summary, null, 2));
  writeFileSync(join(LOG_DIR, `summary-${TARGET_PLATFORM}.json`), JSON.stringify(report, null, 2));
  console.log(`\n✅ 全链通过（读数落盘：${join(LOG_DIR, `summary-${TARGET_PLATFORM}.json`).replace(ROOT + "/", "")}）`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
