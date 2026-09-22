// 门禁：**库级国密「接线」构建**（打补丁 → `--features sm-library` 下跑全量单测 → 还原）。
//
// ## 为什么需要它（2026-09-22，被自己一次事故逼出来）
// 应用接线（`security.rs::apply_gm_page_settings`）整段在 `#[cfg(feature = "sm-library")]` 后面，
// 而 CI 现有的 rust 门禁**全部跑默认特性** ⇒ **没有任何 CI 门禁碰过它**。
// 于是下面这类失败只能在"发版那一刻"或"人肉在本机按发版链跑"时暴露：
//   · 只清 dev profile ⇒ release 的旧 SQLCipher 被原样复用（我在本机按发版链跑时踩到，靠 release.yml
//     的产物断言才抓住）；
//   · `tauri build` 忘了带 `--features sm-library`（编译期信号为零，只有产物标记/断言能发现）；
//   · 接线路径本身写坏（回显校验、能力探针、备份目标端参数……）。
// ⇒ 本门禁把它变成**常开**：能拿到 SM 版 OpenSSL 前缀的机器上真跑，拿不到的**自报跳过**（不装绿）。
//
// ## 做法与边界
// · 前缀：`OPENSSL_DIR` 环境变量；没给时 Linux 用 `/usr`（系统 OpenSSL 3 自带 SM3/SM4）；
//   macOS **没有系统 OpenSSL** ⇒ 没给就自报跳过（本机想跑：`OPENSSL_DIR=$HOME/tongsuo-macos/install`）。
// · 补丁：先 `--prepare` 打上（幂等）＋ 清两个 crate × 两个 profile；**跑完在 finally 里还原**，
//   并把**默认特性**重新编一遍 —— 否则共享 registry 会带着补丁、且最新产物变成 openssl，
//   把同一 job 里后面的 `check-crypto-backend`（按平台默认声明）顶红。
// · 下限：`passed >= 380 && failed == 0`（"空跑即红"：整段被删/被跳过照样红）。
//
// 用法：node scripts/check-gm-wired.mjs

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";
import { opensslEnvFor } from "./lib/sm-library-plan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = join(root, "src-tauri", "Cargo.toml");
const MIN_PASSED = 380;

/**
 * 纯函数：这个前缀**能不能真的链接**（有开发用的库文件，不只是运行时 .so.N）。
 *
 * 为什么单独一步：Linux 的 `/usr` 常被当成"当然能用"，但链接需要 `libcrypto.so`（**开发符号链接**，
 * 由 `libssl-dev` 提供）；只有运行时 `libcrypto.so.3` 的机器上 `-lcrypto` 会直接失败。
 * 第一版就是假设了 `/usr` 一定可用 —— CI（ubuntu runner）真跑时才发现要看这一条。
 */
export function prefixLooksLinkable(dir, { exists = existsSync, readdir = readdirSync } = {}) {
  if (!dir) return false;
  const devLib = (names) => names.some((n) => /^libcrypto\.(a|so|dylib|lib)$/i.test(n));
  const libDirs = ["lib", "lib64"]
    .map((sub) => join(dir, sub))
    .filter((d) => exists(d));
  // ★ Linux 多架构：开发文件常在 `/usr/lib/x86_64-linux-gnu/` 这种**一层子目录**里
  //   （第一版只看 `/usr/lib` 本身 ⇒ 在 ubuntu runner 上会误判"不可链接"⇒ 门禁静默跳过，
  //    而那正是它唯一该跑的平台）。判据见 `check-gm-wired.test.mjs`。
  for (const d of libDirs) {
    let names = [];
    try {
      names = readdir(d);
    } catch {
      continue;
    }
    if (devLib(names)) return true;
    for (const entry of names) {
      const sub = join(d, entry);
      let subNames = null;
      try {
        subNames = exists(sub) ? readdir(sub) : null;
      } catch {
        subNames = null; // 不是目录（普通文件）⇒ 跳过
      }
      if (subNames && devLib(subNames)) return true;
    }
  }
  return false;
}

/**
 * 纯函数：把「准备步骤失败」的原始输出翻成**可操作**的提示（而不是每次都念同一条）。
 *
 * 为什么加（2026-09-22 AMD 在 Windows 上真踩到）：这条原先只印一句「最常见：`cargo` 不在 PATH」。
 * 而那次真因是 `cargo clean` 碰到**正在运行的 `shuyonote.exe`**
 * （`error: failed to remove ... shuyonote.exe` / `Caused by: 拒绝访问。 (os error 5)`）——
 * 提示把人引去查 PATH，方向完全错了，白跑一轮。两类原因的可操作修法完全不同 ⇒ 按**输出里的证据**分类。
 */
export function explainPrepareFailure(output = "") {
  const t = String(output);
  const hints = [];
  if (/os error 5|拒绝访问|Access is denied|being used by another process|另一个程序正在使用/i.test(t)) {
    hints.push(
      "有进程占着 `target/` —— 最常见的正是**开发实例还在跑**（`shuyonote.exe` 让 `cargo clean` 删不掉自己）。" +
        "先停掉它再跑本门禁：`Get-Process shuyonote,cargo -ErrorAction SilentlyContinue | Stop-Process -Force`（Windows）",
    );
  }
  if (/not recognized|不是内部或外部命令|command not found|ENOENT/i.test(t)) {
    hints.push("`cargo` 不在 PATH（POSIX：`export PATH=\"$HOME/.cargo/bin:$PATH\"`；Windows：把 `%USERPROFILE%\\.cargo\\bin` 加进 PATH）");
  }
  if (hints.length === 0) {
    hints.push("看上面那 8 行原始输出（本函数认得的两类：`target/` 被占 / `cargo` 不在 PATH）");
  }
  return hints;
}

/**
 * 纯函数：把**测试 exe 运行时**要找的 OpenSSL 目录并进 PATH（只在 win32 上做）。
 *
 * 为什么需要（2026-09-22 AMD 在 Windows 上真踩到，两跳才定位到）：
 *   本机全局 `OPENSSL_DIR` 是**动态**前缀（`lib\libcrypto.lib` 是**导入库** ＋ `bin\libcrypto-3-x64.dll`）
 *   ⇒ 测试 exe 编得出来，但**加载时**找不到 `libcrypto-3-x64.dll`，进程直接以
 *   `0xC0000135 STATUS_DLL_NOT_FOUND` 退出，而 cargo 只报一句 `test failed`（看不出是缺 DLL）。
 *   `scripts/start-desktop-dev.ps1` 本来就把 `<前缀>\bin` 放进 PATH（所以 app 跑得起来），门禁没放
 *   ⇒ 这一格在 Windows 上**根本跑不起来**（"Windows 侧无独立库级读数"的真正原因之一）。
 *   POSIX 靠 rpath/install_name，不需要这一步。
 */
/**
 * 纯函数：这次 `cargo test` 的参数。
 *
 * ★ **win32 上显式 `--skip plugins::`**（2026-09-22，AMD 在 Windows 上第一次真跑逼出来的）：
 * 那 34 条 `plugins::` 要**真宿主进程**（生产路径是同二进制 re-exec），Windows 本机的 `cargo test`
 * 跑不了那一组；实测（`--features sm-library`，打补丁，同一次单进程全量）：
 * **455 passed / 34 failed / 18 ignored**，34 条**全在** `plugins::`，而我们关心的国密各组
 * （`gm_provider::` / `security::` / `sm3` / `sm4` / `cipher`）**失败 0 条**。
 *
 * ⚠️ 三个刻意的取舍（都是"不许装绿"那一类）：
 *   1. **显式 skip，不是"允许失败 N 条"** —— 数字豁免（例如 `failed ≤ 34 且名字以 plugins:: 开头`）
 *      会在插件测试增减时**悄悄改变含义**，而且它把"这一组没跑"伪装成"跑过了"；
 *   2. **只在 win32 上 skip**，且模式**必须精确是** `plugins::`（判据里对两个平台都做**整数组相等**断言
 *      ⇒ 谁要把模式放宽成空/通配，判据当场红）；
 *   3. **其余集合仍要求 `failed === 0`** —— 不放宽通过标准，只排除那一组明确跑不了的。
 * 那一组的权威读数归 CI / WSL2（`rust-plugins-alone` 门禁）与 Windows 自己的 `win-cargo-test.ps1`。
 */
export function cargoTestArgs({ platform = process.platform, manifest, skipModules = ["plugins::"] } = {}) {
  const args = ["test", "--features", "sm-library", "--manifest-path", manifest];
  if (platform === "win32") args.push("--", "--skip", skipModules[0]);
  return args;
}

export function testPathFor(pathValue, opensslDir, platform = process.platform) {
  if (platform !== "win32" || !opensslDir) return pathValue;
  const bin = join(opensslDir, "bin");
  const parts = String(pathValue ?? "").split(";").filter(Boolean);
  if (parts.some((p) => p.toLowerCase() === bin.toLowerCase())) return pathValue;
  return [bin, ...parts].join(";");
}

/** 纯函数：挑这次要用哪个 OpenSSL 前缀（没得用就 null ⇒ 自报跳过）。 */
export function pickOpensslDir({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const fromEnv = (env.OPENSSL_DIR || "").trim();
  if (fromEnv) return exists(fromEnv) ? fromEnv : null;
  if (platform === "linux") return exists("/usr") ? "/usr" : null;
  return null;
}

/** 纯函数：`cargo test` 输出里那句 `test result: ok. N passed; M failed; …`。 */
export function parseTestResult(output) {
  const hits = [...output.matchAll(/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed;/g)];
  if (!hits.length) return null;
  return hits.reduce(
    (acc, m) => ({ passed: acc.passed + Number(m[2]), failed: acc.failed + Number(m[3]) }),
    { passed: 0, failed: 0 },
  );
}

function run(cmd, args, env, { quiet = false } = {}) {
  return execFileSync(cmd, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  });
}

function main() {
  const opensslDir = pickOpensslDir();
  if (opensslDir && !prefixLooksLinkable(opensslDir)) {
    console.log(
      `! 跳过（自报跳过，不装绿）：${opensslDir} 里没有**开发用**的 crypto 库文件` +
        `（链接需要 \`libcrypto.so\` 这个**开发符号链接**，只有运行时 \`libcrypto.so.3\` 是不够的）。\n` +
        "  Linux 上装 `libssl-dev` 即可（CI 的 rust-tests job 里已有这一条）。",
    );
    process.exit(0);
  }
  if (!opensslDir) {
    console.log(
      "! 跳过（自报跳过，不装绿）：本机没有可用的 SM 版 OpenSSL 前缀。\n" +
        "  macOS 没有系统 OpenSSL ⇒ 想跑这一格请给 `OPENSSL_DIR=<Tongsuo/OpenSSL 前缀>`；\n" +
        "  Linux 会自动用 `/usr`（系统 OpenSSL 3 自带 SM3/SM4）。",
    );
    process.exit(0);
  }
  console.log(`库级国密接线门禁：OPENSSL_DIR=${opensslDir}`);

  // ★ 报出去的 env 必须让**两个** crate 都认：`openssl-sys` 只看 `<OPENSSL_DIR>/lib|lib64`，
  //   而 Ubuntu 的开发文件在 `/usr/lib/x86_64-linux-gnu/` ⇒ 只给 `OPENSSL_DIR=/usr` 会在编译期炸
  //   （CI 日志逐字：`OpenSSL libdir at ["/usr/lib64","/usr/lib"] does not contain the required files…`）。
  //   `libsqlite3-sys` 同时认 `OPENSSL_LIB_DIR` ＋ `OPENSSL_INCLUDE_DIR` 这一对 ⇒ 三个都给。
  const sslEnv = opensslEnvFor(opensslDir);
  if (!sslEnv) {
    console.log(
      `! 跳过（自报跳过，不装绿）：${opensslDir} 里找不到 OpenSSL 的开发文件（libcrypto.so / .a / .lib）——\n` +
        "  链接需要**开发符号链接**（Linux 上由 libssl-dev 提供；只有运行时 libcrypto.so.3 不够）。",
    );
    process.exit(0);
  }
  // ★ Windows 上还要让**测试 exe 运行时**找得到 OpenSSL 的 DLL：本机全局前缀是动态的
  //   （参见 `testPathFor` 的注释——没有这一步，测试 exe 会以 0xC0000135 直接退出）。
  const env = { ...process.env, ...sslEnv, PATH: testPathFor(process.env.PATH, sslEnv.OPENSSL_DIR) };
  console.log(`（OPENSSL_DIR=${sslEnv.OPENSSL_DIR}／LIB_DIR=${sslEnv.OPENSSL_LIB_DIR}／INCLUDE_DIR=${sslEnv.OPENSSL_INCLUDE_DIR}）`);
  let applied = false;
  let exitCode = 0;
  // ⚠️ 所有失败路径都用**返回值**而不是 `process.exit()`：`process.exit` 不会走 `finally`
  //    ⇒ 会把补丁留在共享 registry 上（这正是本仓反复防的混态）。第一版就写错了这一步。
  const checks = () => {
    console.log("① 打补丁 ＋ 清两个 crate × 两个 profile");
    // ⚠️ 这一步也要包起来：`--prepare` 内部会调 `cargo`，而"cargo 不在 PATH"是很常见的一步之遥
    //   （本机 2026-09-22 又踩了一次）。第一版没包 ⇒ Node 直接把 execFileSync 的错误对象倒出来，
    //   栈里只有 `stderr: ''`，看不出是哪一步。
    try {
      run("node", ["scripts/sm-library-build.mjs", "--openssl-dir", opensslDir, "--prepare"], env);
    } catch (e) {
      const detail = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim().split("\n").slice(-8).join("\n   | ");
      console.error(`❌ 准备步骤失败（打补丁/清产物）。原始输出尾部：\n   | ${detail || e.message}`);
      for (const h of explainPrepareFailure(`${detail}\n${e.message ?? ""}`)) console.error(`   · ${h}`);
      return 1;
    }
    applied = true;

    console.log("② `--features sm-library` 下跑全量单测（接线那段的直接证据）");
    let output = "";
    let ok = true;
    try {
      // ⚠️ **不能加 `--lib`**：`plugins::tests` 要 `target/debug/shuyonote`（宿主二进制，生产路径是
      //   同二进制 re-exec），而 `--lib` 只编测试二进制 ⇒ 那一组会红 34 条（本门禁第一版就是这么红的，
      //   判据自己抓到了 —— 它的报错原文就写着"不要用 `cargo test --lib`"）。
      if (process.platform === "win32") {
        // 自报"排除了什么"：跳过必须**看得见**，否则读日志的人会以为这一组也跑过了。
        console.log(
          "   ⚠️ win32：显式 `--skip plugins::`（那一组要真宿主进程，本机 cargo test 跑不了；" +
            "权威读数归 CI/WSL2 的 `rust-plugins-alone` 与 win-cargo-test.ps1）——其余集合仍要求 0 failed",
        );
      }
      output = run("cargo", cargoTestArgs({ manifest }), env);
    } catch (e) {
      ok = false;
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    const counts = parseTestResult(output);
    for (const l of output.split("\n").filter((l) => /^test .* FAILED/.test(l)).slice(0, 8)) console.error(`   ${l}`);
    if (!counts) {
      // ★ 必须把 cargo 的原话带出来：CI 上第一版这里只写"拿不到 test result 行"，于是**没有任何线索**
      //   知道是编译不过、链接不过、还是 build.rs 的 fail-fast（诊断信息被自己吞掉了）。
      const tail = output.split("\n").filter((l) => l.trim()).slice(-25);
      console.error("❌ 拿不到 `test result:` 行 —— 这一格等于没跑（空跑即红）。cargo 输出尾部：");
      for (const l of tail) console.error(`   | ${l}`);
      return 1;
    }
    console.log(`   ${counts.passed} passed / ${counts.failed} failed（下限 ${MIN_PASSED} passed、0 failed）`);
    if (!ok || counts.failed > 0 || counts.passed < MIN_PASSED) {
      console.error("❌ 库级国密接线构建不过：见上面的失败行");
      return 1;
    }
    console.log("✓ 库级国密接线构建：全量单测在 `--features sm-library` 下通过");
    return 0;
  };

  try {
    exitCode = checks();
  } finally {
    if (applied) {
      // 收尾**必须**做：① 共享 registry 不能带着补丁（否则同一 job 里后面的门禁跑在补丁态上）；
      // ② 最新产物要回到**平台默认**（否则 `check-crypto-backend` 会按平台声明判红）。
      try {
        // ⚠️⚠️ 收尾必须**显式摘掉 OPENSSL_DIR**：调用方常常是 `OPENSSL_DIR=<前缀> node scripts/check-gm-wired.mjs`
        //   ⇒ `process.env` 里就带着它 ⇒ 恢复用的 `cargo build` 又编回 OpenSSL，`output` 仍是 openssl
        //   ⇒ 同一 job 里后面的 `check-crypto-backend` 按平台默认判红。（本门禁第三个自己抓到的坑。）
        const restoreEnv = { ...process.env };
        delete restoreEnv.OPENSSL_DIR;
        run("node", ["scripts/sm-library-build.mjs", "--revert"], restoreEnv);
        run("cargo", ["clean", "-p", "libsqlite3-sys", "--manifest-path", manifest], restoreEnv);
        run("cargo", ["clean", "-p", "shuyonote", "--manifest-path", manifest], restoreEnv);
        // ⚠️ **`cargo clean -p` 不够**：它删产物，而**构建脚本的 `output`（标记文件）会活下来** ⇒
        //   「这一份是哪个后端」的读数还是旧的（本门禁第一版收尾后 `check-crypto-backend` 当场红：
        //   "声明要 commoncrypto，但最新产物 ⇒ openssl"）。⇒ 显式删掉这两个 crate 的 build 目录，
        //   逼构建脚本重跑（`libsqlite3-sys` 没为 `OPENSSL_DIR` 声明 rerun-if-env-changed —— 同一个坑第三次现身）。
        for (const profile of ["debug", "release"]) {
          const dir = join(root, "src-tauri", "target", profile, "build");
          if (!existsSync(dir)) continue;
          for (const entry of readdirSync(dir)) {
            if (entry.startsWith("libsqlite3-sys-") || entry.startsWith("shuyonote-")) {
              rmSync(join(dir, entry), { recursive: true, force: true });
            }
          }
        }
        run("cargo", ["build", "--lib", "--manifest-path", manifest], restoreEnv);
        console.log("③ 已还原补丁，并把默认特性重新编好（不留混态给后面的门禁）");
      } catch (e) {
        console.error(`⚠️ 收尾失败（下一格门禁可能读到混态）：${e.message}`);
        if (exitCode === 0) exitCode = 1;
      }
    }
  }
  process.exit(exitCode);
}

if (isMain(import.meta.url)) main();
