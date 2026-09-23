// `scripts/check-android-crypto.mjs` 的判据：两条否定断言（**不该有**动态 crypto 库）＋ 纯解析 ＋ "没验"的三条路。
//
// 为什么这里**不造假 APK**：造一份 zip 夹具只能证明"我这份夹具能过"，而这条判据真正要咬的是
// **真 APK 里的 ELF**（DT_NEEDED 是真的动态段）。真 APK 那条路由 CI 的 `pnpm check:android-crypto`
// 覆盖（android.yml 里就在 `check:android-bundle` 之后一步）—— 那是**产物级读数**，不是夹具。
// 这里钉的是**解析与三态**：给一段真的 `readelf -d` 输出能不能挑对 → 决定了产物那条路会不会误报。

import { describe, expect, it } from "vitest";

import { APP_LIB, cryptoLibEntries, appLibEntries, cryptoNeeded, readDynamic } from "./check-android-crypto.mjs";

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
