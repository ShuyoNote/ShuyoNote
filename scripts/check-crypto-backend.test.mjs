// scripts/check-crypto-backend.mjs 的单测。
//
// 为什么给**门禁自己**写判据：它的分类逻辑里有一条**只在 Windows 上才会暴露**的坑 ——
// `libsqlite3-sys` 在 Windows 上打的库名是 `libcrypto`（不是 `crypto`），
// 所以"只认 `dylib=crypto`"的写法在 Windows 上**必然漏判**、把正常构建报成红。
// 本机（macOS）跑不出这条差异 ⇒ 只能靠夹具把四种**真实产物形状**钉住。
//
// 夹具取自真实 `target/*/build/libsqlite3-sys-*/output` 的节选（不是手写简化版）。

import { describe, expect, it } from "vitest";
import {
  classifyOutput,
  decide,
  expectedFromEnv,
  PLATFORM_DEFAULT,
  platformOfOutput,
  selectForHost,
  targetDirOf,
} from "./check-crypto-backend.mjs";

/** macOS 默认（Apple）后端：CommonCrypto + Security.framework。 */
const OUT_MACOS_CC = [
  "cargo:include=/Users/x/.cargo/registry/src/…/libsqlite3-sys-0.38.2/sqlcipher",
  "cargo:rerun-if-changed=sqlcipher/sqlite3.c",
  "cargo:rustc-link-lib=framework=Security",
  "cargo:rustc-link-lib=framework=CoreFoundation",
  "cargo:rustc-link-lib=static=sqlcipher",
].join("\n");

/** Unix + `OPENSSL_DIR=<Tongsuo>`：动态链 libcrypto，且 link-search 指向 Tongsuo 的 lib。 */
const OUT_UNIX_TONGSUO = [
  "cargo:include=/Users/x/.cargo/registry/src/…/libsqlite3-sys-0.38.2/sqlcipher",
  "cargo:rerun-if-changed=sqlcipher/sqlite3.c",
  "cargo:rustc-link-lib=dylib=crypto",
  "cargo:rustc-link-search=/Users/x/tongsuo-macos/install/lib",
  "cargo:rustc-link-search=native=/tmp/target/debug/build/libsqlite3-sys-abc/out",
  "cargo:rustc-link-lib=static=sqlcipher",
].join("\n");

/** ★ Windows + `OPENSSL_DIR`：库名是 **libcrypto**，路径是反斜杠 —— 第一版就在这里会漏判。 */
const OUT_WINDOWS = [
  "cargo:include=C:\\Users\\x\\.cargo\\registry\\src\\…\\libsqlite3-sys-0.38.2\\sqlcipher",
  "cargo:rerun-if-changed=sqlcipher/sqlite3.c",
  "cargo:rustc-link-lib=dylib=libcrypto",
  "cargo:rustc-link-search=C:\\tongsuo\\lib",
  "cargo:rustc-link-lib=static=sqlcipher",
].join("\n");

/** `bundled-sqlcipher-vendored-openssl`（Android/静态链）：后端由 openssl-sys 去链，这里**不打标记**。 */
const OUT_VENDORED = [
  "cargo:include=/tmp/openssl-src/include",
  "cargo:rerun-if-changed=sqlcipher/sqlite3.c",
  "cargo:rustc-link-lib=static=sqlcipher",
].join("\n");

/** 不是 SQLCipher 那份产物（别的 crate）。 */
const OUT_OTHER = "cargo:rustc-link-lib=framework=Security\ncargo:include=/tmp/other";

const cand = (kind, entry = "libsqlite3-sys-abc") => ({ profile: "debug", entry, kind, mtime: 1 });

describe("classifyOutput：四种真实产物形状", () => {
  it("macOS 默认 ⇒ commoncrypto", () => {
    expect(classifyOutput(OUT_MACOS_CC)).toEqual({ kind: "commoncrypto" });
  });

  it("Unix + Tongsuo ⇒ openssl，并认出 link-search 里那份 Tongsuo", () => {
    const c = classifyOutput(OUT_UNIX_TONGSUO);
    expect(c.kind).toBe("openssl");
    expect(c.tongsuo).toBe(true);
    expect(c.searchDir).toBe("/Users/x/tongsuo-macos/install/lib");
  });

  it("★ Windows ⇒ openssl（`libcrypto` 与反斜杠路径都要认，否则会把正常构建报成红）", () => {
    const c = classifyOutput(OUT_WINDOWS);
    expect(c.kind).toBe("openssl");
    expect(c.searchDir).toBe("C:\\tongsuo\\lib");
    // 反斜杠路径里的 tongsuo 也要认出来
    expect(c.tongsuo).toBe(true);
  });

  it("vendored-openssl（无标记）⇒ no-marker，**不猜**成 openssl", () => {
    expect(classifyOutput(OUT_VENDORED).kind).toBe("no-marker");
  });

  it("别的 crate 的 output ⇒ null（不参与判定）", () => {
    expect(classifyOutput(OUT_OTHER)).toBeNull();
  });

  it("同时出现两种标记 ⇒ ambiguous（不静默选一个）", () => {
    const both = OUT_MACOS_CC + "\ncargo:rustc-link-lib=dylib=crypto";
    expect(classifyOutput(both).kind).toBe("ambiguous");
  });
});

describe("decide：三种状态分得清", () => {
  it("没有产物 ⇒ 既不红也不提示（由 main 打「未实查」）", () => {
    expect(decide({ all: [], expected: "openssl" })).toEqual({ problems: [], notices: [] });
  });

  it("最新产物 = 声明 ⇒ 绿", () => {
    const r = decide({ all: [cand("openssl")], expected: "openssl" });
    expect(r.problems).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it("★ 最新产物 ≠ 声明 ⇒ 红，且报错要带 `cargo clean -p libsqlite3-sys`（这正是作者踩的那一脚）", () => {
    const r = decide({ all: [cand("commoncrypto")], expected: "openssl" });
    expect(r.problems.length).toBe(2);
    expect(r.problems.join("\n")).toContain("cargo clean -p libsqlite3-sys");
  });

  it("认不出后端 ⇒ 只自报未实查，**不判红**（判据不能比它能证明的多）", () => {
    const r = decide({ all: [cand("no-marker")], expected: "openssl" });
    expect(r.problems).toEqual([]);
    expect(r.notices.join("\n")).toContain("未实查");
  });

  it("平台没有默认声明 ⇒ 只报告不判定", () => {
    const r = decide({ all: [cand("commoncrypto")], expected: null });
    expect(r.problems).toEqual([]);
    expect(r.notices.length).toBe(1);
  });

  it("更旧产物分类不同 ⇒ 提示（「沉默不换后端」的现场痕迹），但不判红", () => {
    const r = decide({
      all: [cand("openssl", "libsqlite3-sys-new"), cand("commoncrypto", "libsqlite3-sys-old")],
      expected: "openssl",
    });
    expect(r.problems).toEqual([]);
    expect(r.notices.join("\n")).toContain("更旧");
  });
});

describe("★ 平台过滤（AMD 2026-09-19 在 WSL 上抓到的「绿得不是它声称的那件事」）", () => {
  it("认平台：Windows 产物（盘符+反斜杠）⇒ win32；Unix 产物 ⇒ unix", () => {
    expect(platformOfOutput(OUT_WINDOWS)).toBe("win32");
    expect(platformOfOutput(OUT_MACOS_CC)).toBe("unix");
    expect(platformOfOutput(OUT_UNIX_TONGSUO)).toBe("unix");
  });

  it("在 Linux 上只挑 unix 那份 ——**不许**拿 Windows 的产物报 ✓", () => {
    const win = { profile: "release", entry: "libsqlite3-sys-win", kind: "openssl", platform: "win32", mtime: 99 };
    const nix = { profile: "debug", entry: "libsqlite3-sys-nix", kind: "commoncrypto", platform: "unix", mtime: 1 };
    // 注意：Windows 那份 mtime 更新 —— 旧版就是被"最新胜出"带偏的
    const picked = selectForHost([win, nix], "linux");
    expect(picked.map((x) => x.entry)).toEqual(["libsqlite3-sys-nix"]);
    expect(selectForHost([win, nix], "win32").map((x) => x.entry)).toEqual(["libsqlite3-sys-win"]);
  });

  it("只有别的平台的产物 ⇒ 过滤后为空（main 会报「未实查」，不是 ✓）", () => {
    const win = { profile: "release", entry: "libsqlite3-sys-win", kind: "openssl", platform: "win32", mtime: 99 };
    expect(selectForHost([win], "linux")).toEqual([]);
  });

  it("认 `CARGO_TARGET_DIR`（目标是重定向过的机器上，旧版会去读仓库里那份错的）", () => {
    expect(targetDirOf({ CARGO_TARGET_DIR: "/home/tester/shuyonote-target" })).toBe(
      "/home/tester/shuyonote-target",
    );
    expect(targetDirOf({})).toContain("src-tauri/target");
    // 空白当未设（不能把空值当目录）
    expect(targetDirOf({ CARGO_TARGET_DIR: "   " })).toContain("src-tauri/target");
  });
});

describe("expectedFromEnv：显式 > 平台默认", () => {
  it("显式设置优先", () => {
    expect(expectedFromEnv({ SHUYONOTE_EXPECT_CRYPTO_BACKEND: "openssl" }, "darwin")).toBe("openssl");
  });
  it("空字符串当未设（不能把空值当声明）", () => {
    expect(expectedFromEnv({ SHUYONOTE_EXPECT_CRYPTO_BACKEND: "  " }, "darwin")).toBe("commoncrypto");
  });
  it("平台默认表与文档一致：macOS 今天仍是 commoncrypto（P2/P3 落地时才改）", () => {
    expect(PLATFORM_DEFAULT.darwin).toBe("commoncrypto");
    expect(PLATFORM_DEFAULT.linux).toBe("openssl");
    expect(PLATFORM_DEFAULT.win32).toBe("openssl");
  });
});
