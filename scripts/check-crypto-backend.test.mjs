// scripts/check-crypto-backend.mjs 的单测。
//
// 为什么给**门禁自己**写判据：它的分类逻辑里有一条**只在 Windows 上才会暴露**的坑 ——
// `libsqlite3-sys` 在 Windows 上打的库名是 `libcrypto`（不是 `crypto`），
// 所以"只认 `dylib=crypto`"的写法在 Windows 上**必然漏判**、把正常构建报成红。
// 本机（macOS）跑不出这条差异 ⇒ 只能靠夹具把四种**真实产物形状**钉住。
//
// 夹具取自真实 `target/*/build/libsqlite3-sys-*/output` 的节选（不是手写简化版）。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  classifyOutput,
  collect,
  collectPatchMarkers,
  patchMarkerOf,
  selectForHost,
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

/**
 * ★ Windows + `OPENSSL_DIR`：**真产物形状**（Windows 侧 2026-09-19 贴的原文，逐字）。
 * 两处让第一版漏判的细节都在这里：① 库名是 `libcrypto`；② OpenSSL 那条是**裸** `rustc-link-search=`，
 * 且路径**含空格**、**不以 lib 结尾**（以 `MD` 结尾）；同一文件里 SQLCipher 那条是 `native=`。
 */
const OUT_WINDOWS = [
  "cargo:include=C:\\Users\\w\\.cargo\\registry\\src\\…\\libsqlite3-sys-0.38.2\\sqlcipher",
  "cargo:rerun-if-changed=sqlcipher/sqlite3.c",
  "cargo:rustc-link-lib=dylib=libcrypto",
  "cargo:rustc-link-search=C:\\Program Files\\OpenSSL-Win64\\lib\\VC\\x64\\MD",
  "cargo:rustc-link-lib=static=sqlcipher",
  "cargo:rustc-link-search=native=D:\\tree\\target\\debug\\build\\libsqlite3-sys-a382a6e5\\out",
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

  it("★ Windows 真产物 ⇒ openssl，且 link-search 取到**含空格的完整路径**（第一版在这里取不到）", () => {
    const c = classifyOutput(OUT_WINDOWS);
    expect(c.kind).toBe("openssl");
    // 完整路径（不能只拿到 "C:\Program"）；且要挑**外部**那个目录，不是我们自己的 OUT_DIR
    expect(c.searchDir).toBe("C:\\Program Files\\OpenSSL-Win64\\lib\\VC\\x64\\MD");
    expect(c.tongsuo).toBe(false);
  });

  it("★ 两种 link-search 并存时，挑**外部**那个（`native=` 那条是我们自己的 OUT_DIR）", () => {
    // 反例守卫：这条用例存在的意义是防止"取最后一条"退回成"取到 target 下的 OUT_DIR"
    const c = classifyOutput(OUT_UNIX_TONGSUO);
    expect(c.searchDir).toBe("/Users/x/tongsuo-macos/install/lib");
    // 而 Windows 真产物里最后一条恰恰是 OUT_DIR ⇒ 必须仍然给出 OpenSSL 那条
    expect(classifyOutput(OUT_WINDOWS).searchDir).not.toContain("target");
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
    // ⚠️ **不能写死 POSIX 字面量**（2026-09-19 AMD 在 Windows 上跑到这条时红的）：
    //    `targetDirOf` 走 `resolve()`，Windows 上 `resolve("/home/tester/x")` = `C:\home\tester\x`
    //    ⇒ 断言"归一化后就是它"（与实现同一口径），下面两处也把分隔符归一化后再比子串。
    //    这条判据的**意图**是"环境变量压过仓库默认"，平台路径形态不该参与。
    const norm = (s) => s.replace(/\\/g, "/");
    const p = "/home/tester/shuyonote-target";
    expect(norm(targetDirOf({ CARGO_TARGET_DIR: p }))).toBe(norm(resolve(p)));
    expect(norm(targetDirOf({}))).toContain("src-tauri/target");
    // 空白当未设（不能把空值当目录）
    expect(norm(targetDirOf({ CARGO_TARGET_DIR: "   " }))).toContain("src-tauri/target");
  });
});

describe("★ 走过真文件路径：从 target 目录读产物（夹具不只是字符串）", () => {
  /** 把一段 output 文本按 target 形状写进临时目录，然后走 collect()/selectForHost() 的真实路径。 */
  const writeOutput = (text, { profile = "debug", hash = "h1" } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "crypto-backend-"));
    const d = join(dir, profile, "build", `libsqlite3-sys-${hash}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "output"), text);
    return dir;
  };

  it("Windows 真产物落成文件后：collect + win32 过滤 ⇒ openssl，且路径完整", () => {
    const dir = writeOutput(OUT_WINDOWS);
    try {
      const all = selectForHost(collect(dir), "win32");
      expect(all).toHaveLength(1);
      expect(all[0].kind).toBe("openssl");
      expect(all[0].searchDir).toBe("C:\\Program Files\\OpenSSL-Win64\\lib\\VC\\x64\\MD");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("★ 同一棵树里 unix 与 win32 并存 ⇒ 各自只挑自己那份（这就是 AMD 抓过我的那条）", () => {
    const dir = writeOutput(OUT_WINDOWS, { profile: "debug", hash: "win" });
    try {
      const d2 = join(dir, "release", "build", "libsqlite3-sys-nix");
      mkdirSync(d2, { recursive: true });
      writeFileSync(join(d2, "output"), OUT_MACOS_CC);
      const win = selectForHost(collect(dir), "win32");
      const nix = selectForHost(collect(dir), "darwin");
      expect(win.map((x) => x.kind)).toEqual(["openssl"]);
      expect(nix.map((x) => x.kind)).toEqual(["commoncrypto"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("★ 第三格：补丁在不在（读 AMD 的 build.rs 打在产物里的标记）", () => {
  // AMD 的形态（真实行）：
  //   warning: shuyonote@1.91.3: shuyonote: sm3/sm4 provider patch applied (patch=v1 target=macos marker=sqlite3.c)
  const REAL = "warning: shuyonote@1.91.3: shuyonote: sm3/sm4 provider patch applied (patch=v1 target=macos marker=sqlite3.c)\n";
  const NONE = "cargo:rerun-if-changed=build.rs\ncargo:rustc-cdylib-link-arg=-Wl,-install_name\n";

  it("认出真实标记并解析出各字段（旧形状没有新鲜度三个字段 ⇒ 给空串，不 undefined）", () => {
    expect(patchMarkerOf(REAL)).toEqual({
      found: true,
      patch: "v1",
      target: "macos",
      marker: "sqlite3.c",
      srcSha256: "",
      libsqlite3Sys: "",
      via: "",
    });
  });

  it("没有标记时 found=false（不能把别的 warning 当标记）", () => {
    expect(patchMarkerOf(NONE).found).toBe(false);
    expect(patchMarkerOf("warning: something else: sm3 related but not the marker").found).toBe(false);
  });

  const cand = (kind) => ({ profile: "debug", entry: "libsqlite3-sys-x", kind, platform: "unix", mtime: 1 });
  const mk = (over = {}) => ({ profile: "debug", entry: "shuyonote-x", patch: "v1", target: "macos", marker: "sqlite3.c", mtime: 1, ...over });

  it("声明 applied ＋ 标记在 ⇒ 不红", () => {
    const r = decide({ all: [cand("openssl")], expected: "openssl", patch: { expected: "applied", markers: [mk()] } });
    expect(r.problems).toEqual([]);
  });

  it("★ 声明 applied ＋ 标记不在 ⇒ 红，且报错要含 `cargo clean -p shuyonote`（重放坑的处置）", () => {
    const r = decide({ all: [cand("openssl")], expected: "openssl", patch: { expected: "applied", markers: [] } });
    expect(r.problems.length).toBe(2);
    expect(r.problems.join("\n")).toContain("cargo clean -p shuyonote");
    // 后端那一格是对的 ⇒ 红的只能是补丁这一格（两格独立，别合起来判）
    expect(r.problems.join("\n")).toContain("补丁已应用");
  });

  it("★ 声明 absent ＋ 标记在 ⇒ 红（配置漂移；这正是我在实验里踩到的形态）", () => {
    const r = decide({ all: [cand("openssl")], expected: "openssl", patch: { expected: "absent", markers: [mk()] } });
    expect(r.problems.join("\n")).toContain("配置漂移");
  });

  it("不声明期望 ⇒ 只提示'产物里有标记'，不判红", () => {
    const r = decide({ all: [cand("openssl")], expected: "openssl", patch: { expected: null, markers: [mk()] } });
    expect(r.problems).toEqual([]);
    expect(r.notices.join("\n")).toContain("补丁已应用");
  });

  it("没声明也没有标记 ⇒ 两边都安静", () => {
    const r = decide({ all: [cand("commoncrypto")], expected: "commoncrypto", patch: { expected: null, markers: [] } });
    expect(r.problems).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it("★ 标记解析要带上新鲜度证据（`src_sha256` / 版本 / 解析途径）", () => {
    const line =
      "warning: shuyonote@1.91.3: shuyonote: sm3/sm4 provider patch applied " +
      "(patch=v1 target=macos libsqlite3-sys=0.38.2 via=cargo.lock marker=sqlite3.c src_sha256=" +
      "a".repeat(64) + ")\n";
    const m = patchMarkerOf(line);
    expect(m.found).toBe(true);
    expect(m.srcSha256).toBe("a".repeat(64));
    expect(m.libsqlite3Sys).toBe("0.38.2");
    expect(m.via).toBe("cargo.lock");
  });

  // ── 新鲜度：比哈希，不比时间（AMD 2026-09-19 的方案）──────────────────────────
  const cur = { sha256: "b".repeat(64), file: "/reg/libsqlite3-sys-0.38.2/sqlcipher/sqlite3.c", via: "cargo.lock" };
  const withHash = (h) => mk({ srcSha256: h });

  it("★ 哈希与当前源码一致 ⇒ 不红（新鲜度**可证**，不看时间）", () => {
    const r = decide({
      all: [cand("openssl")],
      expected: "openssl",
      patch: { expected: "applied", markers: [withHash(cur.sha256)], current: cur },
    });
    expect(r.problems).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it("★★ 哈希不等 ⇒ 红（「过期标记」），且报错要带两条清库命令", () => {
    const r = decide({
      all: [cand("openssl")],
      expected: "openssl",
      patch: { expected: "applied", markers: [withHash("c".repeat(64))], current: cur },
    });
    expect(r.problems.join("\n")).toContain("过期标记");
    expect(r.problems.join("\n")).toContain("cargo clean -p shuyonote");
    expect(r.problems.join("\n")).toContain("cargo clean -p libsqlite3-sys");
  });

  it("旧产物没有 `src_sha256` 字段 ⇒ **未实查**（只提示，不判红——缺失不等于补丁不在）", () => {
    const r = decide({
      all: [cand("openssl")],
      expected: "openssl",
      patch: { expected: "applied", markers: [mk()], current: cur }, // mk() 默认不带 srcSha256
    });
    expect(r.problems).toEqual([]);
    expect(r.notices.join("\n")).toContain("未实查");
  });

  it("拿不到当前指纹（registry 被清/锁文件读不到）⇒ 也是**未实查**，并说明原因", () => {
    const r = decide({
      all: [cand("openssl")],
      expected: "openssl",
      patch: {
        expected: "applied",
        markers: [withHash("d".repeat(64))],
        current: null,
        currentError: "找不到可哈希的文件：…",
      },
    });
    expect(r.problems).toEqual([]);
    expect(r.notices.join("\n")).toContain("未实查");
    expect(r.notices.join("\n")).toContain("找不到可哈希的文件");
  });

  it("collectPatchMarkers 的导出存在（真跑时读 target/*/build/shuyonote-*/output）", () => {
    expect(typeof collectPatchMarkers).toBe("function");
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
