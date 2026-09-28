// `scripts/check-android-crypto.mjs` 的判据：三条断言（②③ 是**否定**形态、③ 是**肯定**形态）
// ＋ 纯解析 ＋ "没验"的各条路。
//
// 为什么这里**不造假 APK**：造一份 zip 夹具只能证明"我这份夹具能过"，而这条判据真正要咬的是
// **真 APK 里的 ELF**（DT_NEEDED 是真的动态段）。真 APK 那条路由 CI 的 `pnpm check:android-crypto`
// 覆盖（android.yml 里就在 `check:android-bundle` 之后一步）—— 那是**产物级读数**，不是夹具。
// 这里钉的是**解析与三态**：给一段真的 `readelf -d` 输出能不能挑对 → 决定了产物那条路会不会误报。

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  APP_LIB,
  SM_PATCH_FILE,
  SM_PROVIDER_LITERALS,
  cryptoLibEntries,
  appLibEntries,
  cryptoNeeded,
  patchDeclaresLiterals,
  readDynamic,
  smProviderEvidence,
} from "./check-android-crypto.mjs";

/** 一段**真的** `readelf -d` 输出（取自一次普通 Android .so 的形态，裁剪到相关行）。 */
const DYN_OK = `
Dynamic section at offset 0x1a2b0 contains 31 entries:
  Tag        Type                         Name/Value
 0x0000000000000001 (NEEDED)             Shared library: [liblog.so]
 0x0000000000000001 (NEEDED)             Shared library: [libm.so]
 0x0000000000000001 (NEEDED)             Shared library: [libdl.so]
 0x0000000000000001 (NEEDED)             Shared library: [libc.so]
 0x000000000000000e (SONAME)             Library soname: [libshuyonote_lib.so]
`;

const DYN_BAD = `
 0x0000000000000001 (NEEDED)             Shared library: [libcrypto.so.3]
 0x0000000000000001 (NEEDED)             Shared library: [libc.so]
`;

describe("条目名解析：该挑的挑、该忽略的忽略", () => {
  it("★ 挑出 `lib/<abi>/libcrypto.so*`（含 .so.3），忽略深一层与别的 ABI 目录名", () => {
    const entries = [
      "lib/arm64-v8a/libcrypto.so.3",
      "lib/arm64-v8a/libcrypto.so",
      "lib/arm64-v8a/resources/libcrypto.so.3", // 深一层：Gradle 不收
      "lib/not-an-abi/libcrypto.so",
      "lib/arm64-v8a/libshuyonote_lib.so",
      "classes.dex",
    ];
    expect(cryptoLibEntries(entries)).toEqual(["lib/arm64-v8a/libcrypto.so.3", "lib/arm64-v8a/libcrypto.so"]);
  });

  it("★ 挑应用自己的 .so（名字来自 Cargo.toml 的 `[lib] name`，写错就永远挑不到 ⇒ 会报「没验」而不是假绿）", () => {
    expect(APP_LIB).toBe("libshuyonote_lib.so");
    const apps = appLibEntries(["lib/arm64-v8a/libshuyonote_lib.so", "lib/x86_64/libshuyonote_lib.so"]);
    expect(apps.map((a) => a.abi)).toEqual(["arm64-v8a", "x86_64"]);
    expect(appLibEntries(["lib/arm64-v8a/libother.so"])).toEqual([]);
  });
});

describe("DT_NEEDED 解析（这条决定产物那条判据会不会误报）", () => {
  it("★ 没有 crypto 依赖 ⇒ 空（`libm.so`/`libc.so` 这些都不算）", () => {
    expect(cryptoNeeded(DYN_OK)).toEqual([]);
  });

  it("★ 有 ⇒ 连版本号一起挑出来（报错信息里要能看到是哪一个）", () => {
    expect(cryptoNeeded(DYN_BAD)).toEqual(["libcrypto.so.3"]);
  });

  it("空/畸形输入不炸，也不误报", () => {
    expect(cryptoNeeded("")).toEqual([]);
    expect(cryptoNeeded(null)).toEqual([]);
    expect(cryptoNeeded("(NEEDED) Shared library: [libcrypto_extra.so]")).toEqual([]); // 前缀像但不是它
  });
});

describe("readelf 拿不到 ⇒ 如实「没验」（不许当成「没有依赖」）", () => {
  it("★ 两个工具都没有 ⇒ null", () => {
    expect(readDynamic("/x/libshuyonote_lib.so", { run: () => null })).toBeNull();
  });

  it("readelf 没有、llvm-readelf 有 ⇒ 用后者（NDK 里只有 llvm- 前缀那种）", () => {
    const run = (cmd) => (cmd === "llvm-readelf" ? DYN_OK : null);
    expect(readDynamic("/x/libshuyonote_lib.so", { run })).toBe(DYN_OK);
  });

  it("readelf 有就直接用（不求 llvm-）", () => {
    const calls = [];
    const run = (cmd) => {
      calls.push(cmd);
      return cmd === "readelf" ? DYN_OK : null;
    };
    expect(readDynamic("/x/libshuyonote_lib.so", { run })).toBe(DYN_OK);
    expect(calls).toEqual(["readelf"]);
  });
});

// ---------------------------------------------------------------------------
// ③ 正向那一半（2026-09-25 加）：**补丁字面量**在不在产物里
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

describe("③ 补丁字面量：找得到才算「打过国密补丁的那份 SQLCipher 编进来了」", () => {
  it("★ 两个都在 ⇒ 都进 found、missing 为空", () => {
    const so = Buffer.from("\x7fELF\x02\x01.......PBKDF2_HMAC_SM3....HMAC_SM3....\x00\x00", "latin1");
    expect(smProviderEvidence(so)).toEqual({ found: ["PBKDF2_HMAC_SM3", "HMAC_SM3"], missing: [] });
  });

  it("★ 只找到一个 ⇒ 另一个必须进 missing（**一条够了就判绿**是这个门禁最坏的形态）", () => {
    const so = Buffer.from("...HMAC_SM3...", "latin1");
    expect(smProviderEvidence(so)).toEqual({ found: ["HMAC_SM3"], missing: ["PBKDF2_HMAC_SM3"] });
  });

  it("★ 空/缺字节 ⇒ **全部 missing**（不许把「读不到」当成「有」）", () => {
    expect(smProviderEvidence(Buffer.alloc(0))).toEqual({ found: [], missing: SM_PROVIDER_LITERALS });
    expect(smProviderEvidence(null)).toEqual({ found: [], missing: SM_PROVIDER_LITERALS });
  });

  it("本机注册表里那份**未打补丁**的源码不含这两个字面量（⇒ 命中即补丁独有，判据不是空话）", () => {
    // 这条不是"文件存在性检查"，是**判据成立的前提**：若上游 SQLCipher 哪天自带这两个字符串，
    // ③ 就会在原版产物上判绿 —— 那才是真正的假绿。这里钉住前提（拿不到源码就跳过，不判红）。
    const roots = [];
    const home = process.env.CARGO_HOME ?? join(process.env.USERPROFILE ?? "", ".cargo");
    const srcRoot = join(home, "registry", "src");
    try {
      for (const d of readdirSyncEmu(srcRoot)) roots.push(join(srcRoot, d));
    } catch {
      return; // 本机没有 registry ⇒ 跳过（CI 的本机单元判据不该依赖别人机器的 registry）
    }
    let checked = 0;
    for (const r of roots) {
      for (const pkg of readdirSyncEmu(r)) {
        if (!pkg.startsWith("libsqlite3-sys-")) continue;
        try {
          const text = readFileSync(join(r, pkg, "sqlcipher", "sqlite3.c"), "latin1");
          checked++;
          for (const l of SM_PROVIDER_LITERALS) expect(text.includes(l)).toBe(false);
        } catch {
          /* 没这份源码就跳过 */
        }
      }
    }
    // `checked === 0` = 本机/CI 没有可读的 registry 源码 ⇒ 这条**前提**在这台机器上没核到。
    // 这里**不判红**：它核的是"上游有没有自带这两个字符串"，而不是"我们有没有装依赖"。
  });
});

describe("③ 判据自身的新鲜度：清单与补丁文件脱节 ⇒ 报「没验」，不是继续判", () => {
  it("★ 真补丁文件里确实写着这两条（补丁改了标签而这里没跟着改，这条会先红）", () => {
    const text = readFileSync(join(repoRoot, SM_PATCH_FILE), "utf8");
    expect(patchDeclaresLiterals(text)).toEqual({ declared: SM_PROVIDER_LITERALS, missing: [] });
  });

  it("★ 补丁文本里少一条 ⇒ 那条进 missing（调用方据此返回 2）", () => {
    expect(patchDeclaresLiterals('#define SQLCIPHER_HMAC_SM3_LABEL "HMAC_SM3"')).toEqual({
      declared: ["HMAC_SM3"],
      missing: ["PBKDF2_HMAC_SM3"],
    });
    expect(patchDeclaresLiterals("")).toEqual({ declared: [], missing: SM_PROVIDER_LITERALS });
  });
});

/** `readdirSync` 的薄壳：目录不存在/读不了 ⇒ 返回空（上面那条判据要能在任何机器上跳过而不是炸）。 */
function readdirSyncEmu(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
