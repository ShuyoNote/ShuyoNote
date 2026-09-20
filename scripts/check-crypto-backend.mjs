// 断言「**实际编进 SQLCipher 的加密后端**」与**声明**一致。
//
// ## 为什么必须有一条这样的门禁
//
// SQLCipher 的页加密后端是**编译期**决定的（见方案 §3）：
//   · Apple 默认 ⇒ `SQLCIPHER_CRYPTO_CC` + `Security.framework`，而 **CommonCrypto 只有 AES**；
//   · 显式给 `OPENSSL_DIR` ⇒ 链 `libcrypto`（Tongsuo 就是这一支才有 SM4）。
// 所以「**能编过**」与「**真的换了后端**」是两件事 —— 而后者一旦判断错，后果是
// **国密 provider 根本没被编进去**，或者更糟：**换后端之后用户的旧库打不开**。
//
// ## 作者本人踩过的那一脚（本脚本存在的直接理由）
//
// 2026-09-19 我按方案 §3 第 5 条设了 `OPENSSL_DIR=<Tongsuo>` 跑 `cargo test`，编译通过、
// 测试全绿 —— 但产物的 `output` 里**仍然是 `framework=Security`**。原因：
// **`libsqlite3-sys` 的 build.rs 没有为 `OPENSSL_DIR` 声明 `rerun-if-env-changed`**
// （它只声明了 `SQLITE_MAX_*` / `LIBSQLITE3_FLAGS` / `SQLCIPHER_{INCLUDE,LIB}_DIR` 这些），
// 于是 cargo 认为"环境没变" ⇒ **构建脚本根本没重跑** ⇒ 后端保持原样。
// ⇒ "设了环境变量" ≠ "换了后端"；必须 `cargo clean -p libsqlite3-sys` 逼它重跑。
//
// ## 判据口径（三种状态分得清清楚楚，别混）
//
//   · **没有构建产物** ⇒ `!` 自报跳过（还没编过，不是失败）；
//   · **最新产物 ≠ 声明**（且认得出后端）⇒ **红**（真问题：你以为编进去的是 A，实际是 B）；
//   · **认不出后端**（如 vendored-openssl 分支不打印任何标记）⇒ `!` 自报"未实查"，**不冒充通过**；
//   · **存在更旧、且分类不同的产物** ⇒ `!` 提示（这正是"沉默不换后端"的现场痕迹）。
//
// ## ★ 第二个坑（AMD 2026-09-19 在 WSL 上实测把我抓出来的，比第一个更隐蔽）
//
// 第一版把 target 目录**写死**成 `<root>/src-tauri/target`，并且"最新 mtime 胜出"。AMD 那台把 WSL 的
// 构建放在 `CARGO_TARGET_DIR=/home/tester/shuyonote-target`（ext4，避免与 Windows 共用目标目录），
// 于是这条门禁**去读了仓库里那份 Windows 产物**，报出 `✓ openssl`（link-search 还是
// `Files\OpenSSL-Win64\lib`）—— 而它真正该读的 Linux 产物**一个字都没读**。
// ⇒ **"绿得不是它声称的那件事"**：它说"编译期实查"，实际查的是**另一个平台**的构建。
//
// 修法（三条，都是 AMD 建议的）：
//   ① 认 `CARGO_TARGET_DIR`（没设才回落到 `<root>/src-tauri/target`）；
//   ② 按**当前平台**过滤候选（Windows 产物的 `output` 里是 `C:\…` 这种路径）；
//   ③ 过滤后**只剩别的平台的候选** ⇒ 报「未实查」，**不是** ✓。
//
// ## ★ 第三格（2026-09-19 补）：**补丁在不在**
//
// AMD 的 `src-tauri/build.rs` 在 `sm-library` 构建时会往产物打一行标记：
//   `cargo:warning=shuyonote: sm3/sm4 provider patch applied (patch=v1 target=<os> marker=<file>)`
// ⇒ 本门禁用 `SHUYONOTE_EXPECT_SM_PATCH=applied|absent` 断言它：
// **后端是谁 → 补丁在不在 → 真的生效没有**（第三格是 AMD 的运行期 `check-sm-provider-live`）。
//
// ⚠️ **前提（AMD 实测，必须写在这里）**：**构建脚本不重跑时，cargo 会重放上一次的 `cargo:warning`**
// ⇒ 那行标记只有在**构建脚本真的跑过**时才可信（他把"没补丁却打出补丁标记"真踩了一次）。
// 所以：① 断言 `applied` 时，本门禁会把**输出文件与它的 mtime** 一起打出来，供人复核新鲜度；
// ② 判据红了要 `cargo clean -p shuyonote`（只清 libsqlite3-sys 不够：标记是我们自己 build.rs 打的）。
//
// ## ★ 第三格的**新鲜度**：比 `src_sha256`，不比时间（2026-09-19，AMD 的方案）
//
// 标记行里有 `src_sha256=<64hex>`（AMD 2026-09-19 加，见 `scripts/lib/sm-library-source.mjs`）。
// **mtime 与源码之间没有因果链**（clean/checkout/stash/复制 registry 都会打乱先后），所以：
//
// | 产物里的 `src_sha256` | 与"当前将要编译的那份源码"的哈希 | 结论 |
// |---|---|---|
// | 相等 | — | ✓ **标记与源码同一份**（新鲜度可证，不看时间） |
// | 不等 | — | **过期标记**（源码变过/换了版本）⇒ `EXPECT=applied` 时**红**，否则报「未实查」 |
// | 字段缺失（旧产物） | — | 报「未实查」＋提示 `cargo clean -p shuyonote`（**不假装能证**） |
//
// 当前哈希由 **AMD 那侧的纯函数** `sourceFingerprint()` 给出（我 `import` 它，**不写第三份解析实现**）。
//
// 声明来源：`SHUYONOTE_EXPECT_CRYPTO_BACKEND`（`commoncrypto` / `openssl`）＋
// `SHUYONOTE_EXPECT_SM_PATCH`（`applied` / `absent`）；不设则只报告不判定。
// 分类与判定都是导出的纯函数，单测见 `scripts/check-crypto-backend.test.mjs`。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// ⚠️ 源码定位/哈希**只有一份实现**（AMD 的纯函数库）——我不再写第三份，免得两侧漂移。
import { sourceFingerprint } from "./lib/sm-library-source.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** target 目录：**认 `CARGO_TARGET_DIR`**（AMD 那台就是这么重定向的），没设才回落到仓库内那份。 */
export function targetDirOf(env) {
  const raw = (env.CARGO_TARGET_DIR || "").trim();
  return raw ? resolve(raw) : join(root, "src-tauri", "target");
}

// 各平台**默认**会编出什么（不是我们希望的，是实测的）：
//   · darwin：无 OPENSSL_DIR ⇒ CommonCrypto（只有 AES）。**这是刻意的、且已拍板**（owner 2026-09-19，
//     选项 A）：默认包不背 Tongsuo 的构建链与发行链，库级国密走"国密版"——那次构建显式给
//     `OPENSSL_DIR`，并用 `SHUYONOTE_EXPECT_CRYPTO_BACKEND=openssl` 让本门禁进严格模式。
//     ⚠️ **不要**因为"provider 补丁还没落地"就把这里改成 "openssl"：改判有明确触发条件（客户要"装机即国密"、
//     或重启路径 3 TLCP），写在 docs/SM-CRYPTO-DELIVERY.md §五 与方案 §7；改之前那一整套发行链工作要先做完。
//   · linux：build.rs 的最后一支是 `link-lib=dylib=crypto`（系统 OpenSSL）⇒ openssl。
//   · win32：release.yml 已经显式设 OPENSSL_DIR ⇒ openssl（打的库名是 `libcrypto`）。
export const PLATFORM_DEFAULT = { darwin: "commoncrypto", linux: "openssl", win32: "openssl" };

/** 从环境/平台推出"应该是什么"。空字符串与未设都当"未设"。 */
export function expectedFromEnv(env, platform) {
  const raw = (env.SHUYONOTE_EXPECT_CRYPTO_BACKEND || "").trim();
  if (raw) return raw;
  return PLATFORM_DEFAULT[platform] ?? null;
}

/**
 * 把一个 libsqlite3-sys 的 `output` **分类**（纯函数）。返回 `null` 表示这不是 SQLCipher 那份产物。
 *
 * ⚠️ **可移植性是被实测教训过的**：第一版只认 `rustc-link-lib=dylib=crypto`，
 * 而 Windows 上 build.rs 打的是 `dylib=libcrypto`（`lib_name = if is_windows {"libcrypto"} else {"crypto"}`）
 * ⇒ 那条正则在 Windows 上**必然漏判**，门禁会对着一个完全正常的构建喊红。
 * 所以四种真实形状（CC / Linux-macOS OpenSSL / Windows OpenSSL / vendored 无标记）都有夹具。
 */
export function classifyOutput(text) {
  if (typeof text !== "string" || !/libsqlite3|sqlcipher/i.test(text)) return null;
  const cc = /SQLCIPHER_CRYPTO_CC|framework=Security/.test(text);
  // `libcrypto`（Windows）/ `crypto`（Unix）都要认。
  const openssl = /SQLCIPHER_CRYPTO_OPENSSL|rustc-link-lib=dylib=(?:lib)?crypto/.test(text);
  if (cc && openssl) return { kind: "ambiguous", detail: "同时出现 CommonCrypto 与 OpenSSL 的标记" };
  if (cc) return { kind: "commoncrypto" };
  if (openssl) {
    // 取 `rustc-link-search` 的**整行剩余部分**（Windows 真产物的教训，见下），再挑"外部的那个目录"。
    //
    // ⚠️ **第一版在这里错了两处**（Windows 侧拿真产物跑出来的，2026-09-19）：
    //   ① 真产物里 **两种形状并存**：`rustc-link-search=<path>`（裸等号，OpenSSL 那条）
    //      与 `rustc-link-search=native=<path>`（SQLCipher 自己的 OUT_DIR）。
    //      只认一种就会漏掉 OpenSSL 那条；
    //   ② **路径里有空格**（`C:\Program Files\OpenSSL-Win64\lib\VC\x64\MD`）⇒ 用 `(\S+)` 只会拿到
    //      `C:\Program`，于是"认不出"。而且那条路径**不以 lib/lib64 结尾**（以 `MD` 结尾），
    //      所以"按 lib 后缀找"这条思路在真 Windows 布局上从一开始就不成立。
    //   ⇒ 改成：抓整行（允许空格）→ 排除我们自己 target 下的 OUT_DIR → 剩下的就是外部后端目录。
    const dirs = [...text.matchAll(/^cargo:rustc-link-search=(?:native=)?(.*)$/gm)]
      .map((m) => m[1].trim())
      .filter(Boolean);
    const external = dirs.filter((d) => !/[\\/]target[\\/]/.test(d));
    const dir = external.at(-1) ?? dirs.at(-1) ?? "";
    return { kind: "openssl", tongsuo: /tongsuo/i.test(dirs.join(" ")), searchDir: dir };
  }
  // 有 sqlcipher 的编译痕迹、但没有任何后端标记：典型是
  // `bundled-sqlcipher-vendored-openssl`（后端由 openssl-sys 去链，这个 build.rs 不打印任何标记）。
  // ⇒ **不猜**：报"没标记"，由调用处自报未实查，绝不冒充通过。
  return { kind: "no-marker", detail: "没有任何后端标记（vendored-openssl 分支就是这样）" };
}

/**
 * 从 `output` 的内容猜**这份产物是哪个平台编的**（纯函数）。
 *
 * 判据只用一件事：路径形态。Windows 的 `cc`/cargo 会打出 `C:\…` 这种带盘符的反斜杠路径，
 * Unix 侧是 `/…`。⚠️ 我们**不**试图区分 darwin 与 linux（同一份 output 分不出来，也没必要 ——
 * 它们的分类口径相同）；这里要挡的只是"**在 Linux 上读到 Windows 的产物**"那种最隐蔽的错。
 */
export function platformOfOutput(text) {
  if (/[A-Za-z]:[\\/]/.test(text)) return "win32";
  if (/cargo:(?:include|rustc-link-search|rerun-if-changed)=\//.test(text)) return "unix";
  return "unknown";
}

/**
 * 挑出**属于当前平台**的候选（AMD 的 ②③ 两条）。
 * `hostPlatform` 用 `process.platform`；Windows ⇒ 只要 win32 那份，其余平台 ⇒ 只要 unix 那份。
 * 过滤后为空 ⇒ 由 `main` 报「未实查」，**绝不**拿别的平台的产物冒充 ✓。
 */
export function selectForHost(all, hostPlatform) {
  const want = hostPlatform === "win32" ? "win32" : "unix";
  return all.filter((x) => x.platform === want);
}

/**
 * 从**我们自己的构建产物**里读"补丁在不在"标记（纯函数）。
 * AMD 的 `build.rs` 打的形态：`shuyonote: sm3/sm4 provider patch applied (patch=v1 target=macos marker=sqlite3.c)`。
 */
export function patchMarkerOf(text) {
  if (typeof text !== "string") return { found: false };
  const m = /shuyonote:\s*sm3\/sm4 provider patch applied(?<rest>[^\n]*)/.exec(text);
  if (!m) return { found: false };
  const rest = m.groups?.rest ?? "";
  const field = (k) => new RegExp(`${k}=([^)\\s]+)`).exec(rest)?.[1] ?? "";
  return {
    found: true,
    patch: field("patch"),
    target: field("target"),
    marker: field("marker"),
    // 新鲜度证据（AMD 2026-09-19 加）：这份标记对应哪份源码的哪个版本
    srcSha256: field("src_sha256"),
    libsqlite3Sys: field("libsqlite3-sys"),
    via: field("via"),
  };
}

/** 收集我们自己 build script 的产物（标记在那里，不在 libsqlite3-sys 的产物里）。 */
export function collectPatchMarkers(dir) {
  const out = [];
  for (const profile of ["debug", "release"]) {
    const buildDir = join(dir, profile, "build");
    if (!existsSync(buildDir)) continue;
    for (const entry of readdirSync(buildDir)) {
      if (!entry.startsWith("shuyonote-")) continue;
      const p = join(buildDir, entry, "output");
      if (!existsSync(p)) continue;
      let text;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      const mk = patchMarkerOf(text);
      if (mk.found) out.push({ profile, entry, outputPath: p, mtime: statSync(p).mtimeMs, ...mk });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 给人看的描述。 */
export function describe(x) {
  return (
    `${x.profile}/${x.entry}${x.platform ? `[${x.platform}]` : ""} ⇒ **${x.kind}**` +
    (x.kind === "openssl"
      ? `（link-search=${x.searchDir || "(未解析出)"}${x.tongsuo ? "，路径含 tongsuo" : ""}）`
      : "") +
    (x.detail ? `（${x.detail}）` : "")
  );
}

/**
 * 判定（纯函数）：返回 `{ problems, notices }`。
 * 三种状态分得清 —— 没产物/没标记 ⇒ 只提示；**认得出的产物 ≠ 声明 ⇒ 红**；旧产物分类不同 ⇒ 提示。
 */
export function decide({ all, expected, patch = { expected: null, markers: [] } }) {
  const problems = [];
  const notices = [];
  // ★ 第三格：补丁在不在（独立于后端那一格 —— 后端对了、补丁没打，仍然没有国密算法）
  const newestMarker = patch.markers?.[0] ?? null;
  const describeMarker = (m) =>
    m ? `${m.profile}/${m.entry}（patch=${m.patch || "?"} target=${m.target || "?"} marker=${m.marker || "?"}，output mtime=${new Date(m.mtime).toISOString()}）` : "(无)";
  if (patch.expected === "applied" && !newestMarker) {
    problems.push(
      "声明要**补丁已应用**，但产物里没有那行标记（`shuyonote: sm3/sm4 provider patch applied …`）",
    );
    problems.push(
      "⚠️ 两个常见成因：① 补丁确实没打；② **`cargo:warning` 被重放**——构建脚本没重跑时 cargo 会把上一次的输出再放一遍，" +
        "所以「这次没跑」与「这次跑了但没找到补丁」在这里长得一样。两种都先清再编：\n" +
        "      cargo clean -p shuyonote && cargo clean -p libsqlite3-sys --manifest-path src-tauri/Cargo.toml",
    );
  } else if (patch.expected === "applied" && newestMarker) {
    // ★ 新鲜度：比哈希，不比时间。字段缺失 ⇒ 未实查（旧产物不能自证），不当成"补丁不在"。
    const cur = patch.current ?? null;
    const recorded = newestMarker.srcSha256 || "";
    if (!recorded) {
      notices.push(
        `产物里的标记**没有** \`src_sha256=\` 字段（旧构建产物）⇒ **未实查**：无法判断这份标记对应哪份源码；` +
          "要重新拿到可自证的标记：`cargo clean -p shuyonote` 后再编",
      );
    } else if (!cur) {
      notices.push(
        `产物里的 \`src_sha256=${recorded.slice(0, 12)}…\` 无法与"当前将要编译的源码"比对` +
          `（拿不到当前指纹：${patch.currentError || "未知原因"}）⇒ **未实查**`,
      );
    } else if (recorded !== cur.sha256) {
      // ★ 哈希不等，但**成因有两类**，必须先分开说（AMD 2026-09-20 提醒：否则会把"这次根本没打补丁"
      //   误读成"补丁过期"= 假红）。判据用 `sourceFingerprint().hasMarker` 区分：
      const cause = cur.hasMarker
        ? "**过期标记**：源码在构建之后**变过**（换了补丁/换了 libsqlite3-sys 版本/registry 被替换）"
        : "**当前源码里就没有补丁标记**（`--no-apply`、或补丁被撤）⇒ 产物那行标记对应的是**另一次**构建";
      problems.push(
        `产物里的 \`src_sha256\` 与当前将要编译的源码**不是同一份**（产物 ${recorded.slice(0, 12)}… ` +
          `vs 当前 ${cur.sha256.slice(0, 12)}…，当前 = ${cur.file} via=${cur.via}；hasMarker=${cur.hasMarker}）`,
      );
      problems.push(
        `成因：${cause} ⇒ 那行「补丁已应用」不能当证据。重来一遍：\n` +
          "      cargo clean -p shuyonote && cargo clean -p libsqlite3-sys --manifest-path src-tauri/Cargo.toml",
      );
    }
  } else if (patch.expected === "absent" && newestMarker) {
    problems.push(
      `声明要**补丁未应用**，但产物里有"补丁已应用"标记：${describeMarker(newestMarker)}（配置漂移？）`,
    );
  } else if (patch.expected == null && newestMarker) {
    notices.push(`产物里有"补丁已应用"标记（未声明期望，只报告）：${describeMarker(newestMarker)}`);
  }
  if (!all.length) return { problems, notices };

  const newest = all[0];
  const stale = all.filter((x) => x !== newest && x.kind !== newest.kind);
  if (stale.length) {
    notices.push(
      `有 ${stale.length} 份**更旧**、分类不同的产物（同一次构建里它们不会同时生效，但会让人误判「我换过后端」）：` +
        stale.map(describe).join("；") +
        " —— 想看清当前状态就跑 `cargo clean -p libsqlite3-sys` 再编一次",
    );
  }

  if (expected === null) {
    notices.push(`平台没有默认声明 ⇒ 只报告不判定：${describe(newest)}`);
    return { problems, notices };
  }
  // ★ 第四格（2026-09-20，AMD 要求加）：**源码带补丁，但这份构建的后端不是 OpenSSL**。
  //   这一格必须是 notice 而不是红：v2 起补丁的能力门按"本次请求的算法"探测 ⇒
  //   在没有 SM3 的 provider（Apple 的 CommonCrypto 正是）上补丁是**行为中性**的
  //   （实测：v2 ＋ CommonCrypto ⇒ `security::` 19 passed / 0 failed，与不打补丁一致）。
  //   但"产物里有补丁标记"很容易被读成"国密已生效" ⇒ 必须**明说这次用不上**，
  //   并把两边的证据都摆出来（patch=… 标记 + 后端判定依据）。
  if (newestMarker && patch.expected !== "absent" && newest.kind === "commoncrypto") {
    notices.push(
      `源码带补丁（patch=${newestMarker.patch || "?"} target=${newestMarker.target || "?"} ` +
        `marker=${newestMarker.marker || "?"}），但**这份构建的后端是 CommonCrypto**（${describe(newest)}）：` +
        "补丁自 v2 起是**行为中性**的 ⇒ 这**不是错误**，但也**别读成「国密已生效」** —— " +
        "CommonCrypto 只有 AES，SM3 标签在这条路径上**用不上**（要真生效：给 `OPENSSL_DIR` 编 `sm-library`）",
    );
  }
  if (newest.kind === "commoncrypto" || newest.kind === "openssl") {
    if (newest.kind !== expected) {
      problems.push(`声明要 **${expected}**，但**最新**产物是 ${describe(newest)}`);
      problems.push(
        "⚠️ 最常见的成因不是「参数写错」，而是**构建脚本没重跑**：`libsqlite3-sys` 没有为 `OPENSSL_DIR` " +
          "声明 `rerun-if-env-changed` ⇒ 改环境变量对 cargo 是「不可见」的。强制重跑：\n" +
          "      cargo clean -p libsqlite3-sys --manifest-path src-tauri/Cargo.toml\n" +
          "    （`cargo clean -p` 之后**必须**在带着目标环境变量的那次调用里重新构建，否则还是原样）",
      );
    }
  } else {
    // 认不出后端 ⇒ **不判红也不装绿**，如实说"未实查"（判据的名字不能比它能证明的多）。
    notices.push(
      `最新产物认不出后端（${describe(newest)}）⇒ **未实查**：这条门禁只对认得出的形状下结论，` +
        "认不出的形状一律自报，不冒充通过",
    );
  }
  return { problems, notices };
}

/** 收集所有 profile 下的产物，按 `output` 的 mtime 从新到旧。 */
export function collect(dir) {
  const found = [];
  for (const profile of ["debug", "release"]) {
    const buildDir = join(dir, profile, "build");
    if (!existsSync(buildDir)) continue;
    for (const entry of readdirSync(buildDir)) {
      if (!entry.startsWith("libsqlite3-sys-")) continue;
      const outputPath = join(buildDir, entry, "output");
      if (!existsSync(outputPath)) continue;
      let text;
      try {
        text = readFileSync(outputPath, "utf8");
      } catch {
        continue;
      }
      const cls = classifyOutput(text);
      if (!cls) continue;
      const platform = platformOfOutput(text);
      found.push({ profile, entry, outputPath, mtime: statSync(outputPath).mtimeMs, platform, ...cls });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

export function main() {
  const expected = expectedFromEnv(process.env, process.platform);
  const dir = targetDirOf(process.env);
  const raw = collect(dir);
  const all = selectForHost(raw, process.platform);
  const skipped = raw.length - all.length;

  if (all.length === 0) {
    console.error(
      `! 未找到**本平台（${process.platform}）**的 SQLCipher 构建产物 ⇒ 未实查` +
        (skipped ? `（略过了 ${skipped} 份别的平台的产物 —— 它们证明不了本平台的构建）` : "") +
        `；target=${dir}（认 CARGO_TARGET_DIR）；先跑一次 ` +
        "`cargo build --manifest-path src-tauri/Cargo.toml` —— 本机没编过、或只编了别的平台，都等于没查",
    );
    process.exit(0);
  }
  if (skipped) {
    console.error(
      `! 略过 ${skipped} 份**别的平台**的产物（它们的分类与本平台无关；不略过就会报出"绿得不是它声称的那件事"）`,
    );
  }

  const patchExpected = (process.env.SHUYONOTE_EXPECT_SM_PATCH || "").trim() || null;
  const markers = collectPatchMarkers(dir);
  // 「当前将要编译的那份源码」的指纹 —— 用 AMD 的纯函数（唯一实现），拿不到就带上原因（判"未实查"，不判红）
  let current = null;
  let currentError = "";
  try {
    current = sourceFingerprint({ lockPath: join(root, "src-tauri", "Cargo.lock") });
  } catch (e) {
    currentError = String(e?.message || e).split("\n")[0];
  }
  const { problems, notices } = decide({
    all,
    expected,
    patch: { expected: patchExpected, markers, current, currentError },
  });
  for (const n of notices) console.error(`! ${n}`);
  if (patchExpected === "applied" && !problems.length) {
    const m = markers[0];
    const hashLine =
      m.srcSha256 && current && m.srcSha256 === current.sha256
        ? `src_sha256=${m.srcSha256.slice(0, 12)}… **与当前源码一致**（新鲜度可证，不看时间；源码=${current.file} via=${current.via}）`
        : `src_sha256=${m.srcSha256 ? m.srcSha256.slice(0, 12) + "…" : "(缺字段)"} —— ⚠️ 见上面的"未实查"说明`;
    console.log(
      `  补丁标记 ✓ patch=${m.patch || "?"} target=${m.target || "?"} marker=${m.marker || "?"}` +
        `（${m.profile}/${m.entry}）\n    ${hashLine}`,
    );
  }
  if (problems.length) {
    console.error("check-crypto-backend: ❌ 不通过");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `✓ 加密后端与声明一致：${expected}（${describe(all[0])}；候选产物 ${all.length} 份，` +
      `${expected === "openssl" ? "OpenSSL/Tongsuo 支" : "CommonCrypto 支"}）`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
