#!/usr/bin/env node
// 国密版的**三段自证**：一条命令把"这版到底有没有国密"讲清楚，而不是靠人记得跑哪几条。
//
// 三格（分工见 docs/SM-CRYPTO-DELIVERY.md §四/§六）：
//   ① **后端是谁** —— `check-crypto-backend` 读构建产物：编进去的是 OpenSSL/Tongsuo 还是 Apple CommonCrypto
//      （后者只有 AES ⇒ 连国密 provider 都进不去）；
//   ② **补丁在不在** —— 同一门禁读我们 build.rs 打的产物标记（`SHUYONOTE_EXPECT_SM_PATCH`）；
//   ③ **跨实现对拍** —— `check-gm-conformance`：GM/T 0002/0004 标准向量 ＋ RustCrypto↔Tongsuo 双向互解
//      ＋ 两侧密文逐字节相同 ＋ PBKDF2 与拆 key 口径（用 `SHUYONOTE_TONGSUO_OPENSSL` 点名真 Tongsuo）。
//   ④ **运行期"真的生效没有"**（`--with-tests` 时追加）—— `cargo test --lib gm_provider::`：在**打过补丁
//      的那份构建**上，回显必须是 `HMAC_SM3`/`PBKDF2_HMAC_SM3`，并守着"静默降级"那条。
//      ⚠️ 它证明的是**这一份构建**（本机、本次）真的生效；`--with-tests` 的第 3.5 段（应用层单测）管的是
//      另一件事（`--features sm-crypto` 的算法链路），两段都留着，别把一段读成另一段。
//
// 为什么要有它：三格分别属于不同文件/不同人（后端＝构建配置、补丁＝AMD 的 provider 补丁、
// 对拍＝跨实现），而"国密版"是一个**整体交付物**。没有单一入口时，最容易发生的失败是
// **只跑了其中一条就宣布"国密版好了"** —— 那正是这一路反复吃的"绿得不是它声称的那件事"。
//
// 用法：
//   node scripts/gm-version-selfcheck.mjs --openssl-dir <Tongsuo 前缀> [--expect-patch applied|absent]
//                                        [--with-tests] [--with-build] [--print]
// 退出码：0 = 三格全过；1 = 有格没过或前置不满足；其它 = 被委托命令的退出码。
//
// ⚠️ 前提（会说在报错里，不靠人记）：`--with-build` 才会去构建；不带它时本脚本**只核对已有产物**
//    （没编过 ⇒ 第①格会如实报"未找到本平台产物"，而不是装绿）。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] || "" : "";
};
const has = (name) => argv.includes(name);

export const LEG_IDS = ["backend-and-patch", "cross-impl"];

/**
 * 纯函数：三段自证要跑什么（便于单测与 `--print` 检视）。
 * 注意第 ① 与第 ② 格是**同一次门禁调用**里判两个期望 —— 它们读的是同一批产物（后端标记与补丁标记），
 * 分两次跑只会让"两次之间产物变了"这种事变得可能，反而更差。
 */
export function legPlan({ opensslDir, expectPatch, tauriDir, withTests, withBuild }) {
  const legs = [];
  if (withBuild) {
    legs.push({
      id: "build",
      label: "构建（先清 libsqlite3-sys，再带 OPENSSL_DIR 编）",
      cmd: "node",
      args: [join("scripts", "sm-library-build.mjs"), "--openssl-dir", opensslDir],
      env: {},
      optional: false,
    });
  }
  legs.push({
    id: "backend-and-patch",
    label: "①后端是谁 ＋ ②补丁在不在（读产物，不看环境变量）",
    cmd: "node",
    args: [join("scripts", "check-crypto-backend.mjs")],
    env: {
      SHUYONOTE_EXPECT_CRYPTO_BACKEND: "openssl",
      ...(expectPatch ? { SHUYONOTE_EXPECT_SM_PATCH: expectPatch } : {}),
    },
    optional: false,
  });
  legs.push({
    id: "cross-impl",
    label: "③跨实现对拍（GM/T 向量 ＋ 双向互解 ＋ 逐字节相同）",
    cmd: "node",
    args: [join("scripts", "check-gm-conformance.mjs")],
    env: { SHUYONOTE_TONGSUO_OPENSSL: join(opensslDir, "bin", "openssl") },
    optional: false,
  });
  if (withTests) {
    // ★ ④ 运行期那一格（2026-09-20 补）：`gm_provider::` 判据跑在**打过补丁的那份构建**上，
    //   它才是"标签真的被 C 层接受了"的直接证据。此前一条命令只覆盖到"产物里有补丁标记"，
    //   "运行期真的生效"仍靠人记得单独跑 —— 而这正是 AMD 那条 `check-sm-provider-live` 要补的缝。
    //   ⚠️ **不进默认门禁**：它需要一个打过补丁 ＋ 配了后端的构建，CI 上不存在（放进去只会自报跳过，
    //      而"自报跳过"看多了就没人再看）。
    legs.push({
      id: "gm-provider",
      label: "运行期第三格：打过补丁的构建上跑 gm_provider 判据",
      cmd: "cargo",
      args: ["test", "--lib", "gm_provider::", "--manifest-path", join(tauriDir, "Cargo.toml")],
      env: {},
      optional: false,
    });
    legs.push({
      id: "sm-tests",
      label: "应用层国密单测（--features sm-crypto）",
      cmd: "cargo",
      args: ["test", "--lib", "--features", "sm-crypto", "--manifest-path", join(tauriDir, "Cargo.toml")],
      env: {},
      optional: false,
    });
  }
  return legs;
}

/**
 * `cargo` 可能不在 PATH 上（rustup 装在 `~/.cargo/bin`，而某些环境不把它带进 PATH）。
 * 不处理的话，第③格会以"**夹具编不过 / spawnSync cargo ENOENT**"的形式失败 —— 看起来像夹具坏了，
 * 其实是找不到 cargo（2026-09-19 我自己在这台机器上就这么被误导过一次）。
 * 这里只在"PATH 上确实没有、但 rustup 默认位置有"时兜一下，并把这件事**打出来**（不静默改环境）。
 */
function cargoPathWithRustupFallback() {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return { path: process.env.PATH || "", notice: null };
  } catch {
    const bin = join(homedir(), ".cargo", "bin");
    const exe = join(bin, process.platform === "win32" ? "cargo.exe" : "cargo");
    if (!existsSync(exe)) return { path: process.env.PATH || "", notice: null };
    return {
      path: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}`,
      notice: `cargo 不在 PATH 上 ⇒ 本次为子进程补上 ${bin}（否则第③格会报成"夹具编不过/spawnSync cargo ENOENT"）`,
    };
  }
}

function commitShort() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "(未知)";
  }
}

function main() {
  const opensslDir = argValue("--openssl-dir") || process.env.OPENSSL_DIR || "";
  const expectPatch = (argValue("--expect-patch") || process.env.SHUYONOTE_EXPECT_SM_PATCH || "").trim();
  const tauriDir = join(root, "src-tauri");
  const withTests = has("--with-tests");
  const withBuild = has("--with-build");

  // 前置：没有显式后端就别往下走 —— 与 build.rs / sm-library-build.mjs 同一条纪律。
  // "不给后端也能跑完"这件事本身就是当初那个坑（Apple 上安静地编出只有 AES 的库）。
  if (!opensslDir) {
    console.error(
      "gm-version-selfcheck: ❌ 没给 `--openssl-dir`（或环境变量 `OPENSSL_DIR`）。\n" +
        "  国密版**必须显式指定后端**：不给的话 SQLCipher 在 Apple 上会落回 CommonCrypto（只有 AES），\n" +
        "  而它**编得过**、只是安静地没有国密算法。Tongsuo 的编法见 docs/SM-CRYPTO-DELIVERY.md §六。",
    );
    process.exit(1);
  }
  const opensslBin = join(opensslDir, "bin", "openssl");
  if (!existsSync(opensslBin)) {
    console.error(
      `gm-version-selfcheck: ❌ \`${opensslBin}\` 不存在。\n` +
        "  第③格要**点名一份真 Tongsuo**（跨实现对拍的另一方）；指错了地方就会退化成'跳过'，\n" +
        "  而那份跳过会被读成'对拍过了'。先把 Tongsuo 编到该前缀（macOS 装到 <p>/lib）。",
    );
    process.exit(1);
  }

  const legs = legPlan({ opensslDir, expectPatch, tauriDir, withTests, withBuild });
  const head = commitShort();
  const cargoPath = cargoPathWithRustupFallback();
  const baseEnv = { ...process.env, PATH: cargoPath.path };

  console.log(`国密版三段自证　被验 commit=${head}　Tongsuo=${opensslDir}`);
  if (cargoPath.notice) console.log(`! ${cargoPath.notice}`);
  if (expectPatch) console.log(`补丁期望：${expectPatch}（不设则只报告不判定）`);
  console.log("─".repeat(72));
  if (has("--print")) {
    for (const leg of legs) {
      const env = Object.entries(leg.env)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      console.log(`[${leg.id}] ${leg.label}\n    ${env ? env + " " : ""}${leg.cmd} ${leg.args.join(" ")}`);
    }
    process.exit(0);
  }

  const results = [];
  for (const leg of legs) {
    console.log(`\n▶ [${leg.id}] ${leg.label}`);
    const env = { ...baseEnv, ...leg.env };
    let ok = true;
    try {
      execFileSync(leg.cmd, leg.args, { cwd: root, env, stdio: "inherit" });
    } catch (e) {
      ok = false;
      if (e?.status != null) console.error(`  （${leg.cmd} 退出码 ${e.status}）`);
    }
    results.push({ id: leg.id, ok });
  }

  console.log("\n" + "─".repeat(72));
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"}  ${r.id}`);
  const bad = results.filter((r) => !r.ok);
  if (bad.length) {
    console.error(
      `\ngm-version-selfcheck: ❌ ${bad.length} 格没过（${bad.map((b) => b.id).join(", ")}）—— 别把这一版当国密版发。`,
    );
    process.exit(1);
  }
  // ⚠️ 收尾这句必须**按声明说**：不能一律写"补丁在场" —— 那正是这套东西存在的理由（绿得像它声称的那件事）。
  const patchClause =
    expectPatch === "applied"
      ? "补丁在场"
      : expectPatch === "absent"
        ? "补丁**未**打（本版只有应用层国密；库级页加密仍是 AES，属 P2/P3）"
        : "补丁状态**未声明**（门禁只报告、未判定）";
  console.log(
    `\ngm-version-selfcheck: ✅ ${results.length} 段全过（commit ${head}）—— 编进去的是 Tongsuo/OpenSSL、${patchClause}、` +
      "且两套 SM4 实现互解得开。⚠️ 边界：它证明的是**算法链路**（应用层 ＋ 对拍）" +
      (has("--with-tests")
        ? "**＋ 运行期接线真的生效**（第 ④ 段 `gm_provider`，只在 `--with-tests` 时跑）"
        : "；**运行期那一格没跑** —— 要看它加 `--with-tests`（第 ④ 段 `gm_provider::`）") +
      "；**『页加密确为 SM4』仍属 P3**，那是另一件事（需要 provider 落地）。",
  );
}

if (isMain(import.meta.url)) main();
