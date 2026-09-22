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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = join(root, "src-tauri", "Cargo.toml");
const MIN_PASSED = 380;

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
  if (!opensslDir) {
    console.log(
      "! 跳过（自报跳过，不装绿）：本机没有可用的 SM 版 OpenSSL 前缀。\n" +
        "  macOS 没有系统 OpenSSL ⇒ 想跑这一格请给 `OPENSSL_DIR=<Tongsuo/OpenSSL 前缀>`；\n" +
        "  Linux 会自动用 `/usr`（系统 OpenSSL 3 自带 SM3/SM4）。",
    );
    process.exit(0);
  }
  console.log(`库级国密接线门禁：OPENSSL_DIR=${opensslDir}`);

  const env = { ...process.env, OPENSSL_DIR: opensslDir };
  let applied = false;
  let exitCode = 0;
  // ⚠️ 所有失败路径都用**返回值**而不是 `process.exit()`：`process.exit` 不会走 `finally`
  //    ⇒ 会把补丁留在共享 registry 上（这正是本仓反复防的混态）。第一版就写错了这一步。
  const checks = () => {
    console.log("① 打补丁 ＋ 清两个 crate × 两个 profile");
    run("node", ["scripts/sm-library-build.mjs", "--openssl-dir", opensslDir, "--prepare"], env);
    applied = true;

    console.log("② `--features sm-library` 下跑全量单测（接线那段的直接证据）");
    let output = "";
    let ok = true;
    try {
      // ⚠️ **不能加 `--lib`**：`plugins::tests` 要 `target/debug/shuyonote`（宿主二进制，生产路径是
      //   同二进制 re-exec），而 `--lib` 只编测试二进制 ⇒ 那一组会红 34 条（本门禁第一版就是这么红的，
      //   判据自己抓到了 —— 它的报错原文就写着"不要用 `cargo test --lib`"）。
      output = run("cargo", ["test", "--features", "sm-library", "--manifest-path", manifest], env);
    } catch (e) {
      ok = false;
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    const counts = parseTestResult(output);
    for (const l of output.split("\n").filter((l) => /^test .* FAILED/.test(l)).slice(0, 8)) console.error(`   ${l}`);
    if (!counts) {
      console.error("❌ 拿不到 `test result:` 行 —— 这一格等于没跑（空跑即红）");
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
