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
  targetDirOf,
  normalizeDir,
  opensslDirMatches,
  looksLikeCargoOutDir,
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
      // 旧形状（没有 `page_cipher=`）⇒ 给空串，**不 undefined**：调用方据此判"这一格未实查"
      pageCipher: "",
      // 同一条口径：旧形状也没有 `sm_crypto=`（2026-09-22 加）⇒ 空串
      smCrypto: "",
    });
  });

  // ★ 页加密那一格（2026-09-20，补丁 v3 起）：产物标记里要能读出"这份构建是 SM4 页还是 AES 页"。
  //   为什么重要：`cipher_settings` 回显里**没有** algorithm 字段 ⇒ 构建期唯一能读到的地方就是这里；
  //   而 v3 把 `OPENSSL_CIPHER` 无条件换成 `EVP_sm4_cbc()`，"我说不出自己是什么"是不可接受的。
  it("★ 新形状带 `page_cipher=` ⇒ 解析出来；缺这一格 ⇒ 空串（调用方判「未实查」）", () => {
    const w = (pc) =>
      `warning: shuyonote@1.91.10: shuyonote: sm3/sm4 provider patch applied (patch=040387ab target=macos ` +
      `libsqlite3-sys=0.38.2 via=cargo.lock marker=sqlite3.c${pc} src_sha256=${"a".repeat(64)})\n`;
    expect(patchMarkerOf(w(" page_cipher=sm4")).pageCipher).toBe("sm4");
    expect(patchMarkerOf(w(" page_cipher=aes")).pageCipher).toBe("aes");
    expect(patchMarkerOf(w("")).pageCipher).toBe("");
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

  // ★ 第四格（2026-09-20，AMD 要求加）：源码带补丁、后端不是 OpenSSL ⇒ **notice，不是红**。
  //   要两件事同时成立：① 不判红（v2 起这种组合合法且行为中性）；② 明说"这次用不上"，
  //   别让"产物里有补丁标记"被读成"国密已生效"。
  it("★ 补丁在 + 后端是 CommonCrypto ⇒ 不判红，但必须明说这次用不上 SM3", () => {
    const r = decide({
      all: [cand("commoncrypto")],
      expected: "commoncrypto",
      patch: { expected: "applied", markers: [mk({ srcSha256: "a".repeat(64) })], current: { sha256: "a".repeat(64), hasMarker: true, file: "sqlite3.c", via: "cargo.lock" } },
    });
    expect(r.problems).toEqual([]);
    const n = r.notices.join("\n");
    expect(n).toContain("CommonCrypto");
    expect(n).toContain("用不上");
    expect(n).toContain("patch=v1");        // 标记证据
    expect(n).toContain("OPENSSL_DIR");     // 下一步
  });

  it("补丁在 + 后端是 OpenSSL ⇒ **不**打这条提示（那条路才是国密真生效）", () => {
    const r = decide({
      all: [cand("openssl")],
      expected: "openssl",
      patch: { expected: "applied", markers: [mk({ srcSha256: "a".repeat(64) })], current: { sha256: "a".repeat(64), hasMarker: true, file: "sqlite3.c", via: "cargo.lock" } },
    });
    expect(r.problems).toEqual([]);
    expect(r.notices.join("\n")).not.toContain("用不上");
  });

  it("声明 absent + CommonCrypto ⇒ 那条提示不重复（drift 已经判红了）", () => {
    const r = decide({ all: [cand("commoncrypto")], expected: "commoncrypto", patch: { expected: "absent", markers: [mk()] } });
    expect(r.problems.join("\n")).toContain("配置漂移");
    expect(r.notices.join("\n")).not.toContain("用不上");
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
  const cur = {
    sha256: "b".repeat(64),
    file: "/reg/libsqlite3-sys-0.38.2/sqlcipher/sqlite3.c",
    via: "cargo.lock",
    hasMarker: true, // 默认代表"当前源码里**有**补丁标记"（即真的属于"源码变过"那一类）
  };
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

  it("★ 哈希不等且当前源码**没有**补丁标记 ⇒ 成因要写成「这次根本没打补丁」，不许写成「过期」", () => {
    const r = decide({
      all: [cand("openssl")],
      expected: "openssl",
      patch: {
        expected: "applied",
        markers: [withHash("c".repeat(64))],
        current: { ...cur, hasMarker: false },
      },
    });
    expect(r.problems.length).toBe(2);
    const text = r.problems.join("\n");
    expect(text).toContain("当前源码里就没有补丁标记");
    expect(text).not.toContain("过期");
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

// ★ 2026-09-22（owner 拍板「就发国密单一口味」）：**发出去的包必须是 SM4 页** —— 声明不合就红。
//   为什么必须有这一格：`cipher_settings` 回显里没有 algorithm 字段（方案 §3.2 事实 3），
//   页加密只有产物标记能回答 ⇒ 不这么断言，"这一版是国密"就只是一句声明。
describe("check-crypto-backend：页加密那一格（单一口味）", () => {
  const marker = (pageCipher) => [{ profile: "release", entry: "shuyonote", patch: "72df3f9a", target: "macos", marker: "sqlite3.c", pageCipher, mtime: 0 }];
  const base = { all: [{ kind: "openssl" }], expected: "openssl", patch: { expected: "applied", markers: marker("sm4"), current: null, currentError: "" } };

  it("声明 sm4 而标记就是 sm4 ⇒ 通过（并记一条一致）", () => {
    const { problems, notices } = decide({ ...base, pageCipher: { expected: "sm4" } });
    expect(problems).toEqual([]);
    expect(notices.join()).toMatch(/页加密与声明一致/);
  });

  it("★ 声明 sm4 而标记是 aes ⇒ **红**（这一份不是国密包，别发出去）", () => {
    const { problems } = decide({ ...base, patch: { ...base.patch, markers: marker("aes") }, pageCipher: { expected: "sm4" } });
    expect(problems.join()).toMatch(/页加密是 \*\*aes\*\*/);
    expect(problems.join()).toMatch(/别发出去/);
  });

  it("没有标记 ⇒ **未实查**（notice，不判红：别把「没编过」读成「过了」，也别读成「不是国密」）", () => {
    const { problems, notices } = decide({ ...base, patch: { expected: "applied", markers: [] }, pageCipher: { expected: "sm4" } });
    expect(problems.some((p) => /页加密/.test(p))).toBe(false);
    expect(notices.join()).toMatch(/未实查/);
  });

  it("旧产物标记里没有 page_cipher 字段 ⇒ 也未实查", () => {
    const { problems, notices } = decide({
      ...base,
      patch: { ...base.patch, markers: [{ ...marker(undefined), pageCipher: undefined }] },
      pageCipher: { expected: "sm4" },
    });
    expect(problems).toEqual([]);
    expect(notices.join()).toMatch(/未实查/);
  });
});

// ★ 2026-09-22：**应用层国密也必须进产物标记**。动机是一次实测 ——
//   `tauri dev` 发的是 `--no-default-features --features sm-crypto`，而
//   `tauri build --features sm-library` 发的是 `--features sm-library,tauri/custom-protocol`（**defaults 仍在**）。
//   两条路不同 ⇒ "发版包一定带 sm-crypto"不能只靠 CLI 行为不变；它一旦变，包会**静默退回 v1 写路径**。
describe("check-crypto-backend：应用层国密那一格（sm_crypto=）", () => {
  const marker = (smCrypto) => [
    { profile: "release", entry: "shuyonote", patch: "72df3f9a", target: "macos", marker: "sqlite3.c", pageCipher: "sm4", smCrypto, mtime: 0 },
  ];
  const base = (smCrypto) => ({
    all: [{ kind: "openssl" }],
    expected: "openssl",
    patch: { expected: "applied", markers: marker(smCrypto), current: null, currentError: "" },
    pageCipher: { expected: "sm4" },
  });

  it("声明 on 且标记 on ⇒ 通过（并记一条一致）", () => {
    const { problems, notices } = decide({ ...base("on"), smCrypto: { expected: "on" } });
    expect(problems).toEqual([]);
    expect(notices.join()).toMatch(/应用层国密与声明一致/);
  });

  it("★ 声明 on 而标记 off ⇒ **红**（发出去的包退回 v1 写路径，没有国密）", () => {
    const { problems } = decide({ ...base("off"), smCrypto: { expected: "on" } });
    expect(problems.join()).toMatch(/应用层国密/);
    expect(problems.join()).toMatch(/退回 v1 写路径/);
  });

  it("旧产物没有 sm_crypto 字段 ⇒ 未实查（不判红，也别读成通过）", () => {
    const { problems, notices } = decide({ ...base(undefined), smCrypto: { expected: "on" } });
    expect(problems.some((p) => /应用层国密/.test(p))).toBe(false);
    expect(notices.join()).toMatch(/未实查/);
  });
});

// ★ 2026-09-22（Windows 侧彩排后点名要的）：**产物实际链的是哪个 OpenSSL 目录**必须能断言。
//   动机是他们的实测：`OPENSSL_LIB_DIR`/`OPENSSL_INCLUDE_DIR` **优先于** `OPENSSL_DIR`，
//   而他们那台机器**用户级环境变量里本来就写着**另一个动态前缀 ⇒ 只钉 `OPENSSL_DIR` 时
//   `--require-static` 绿、`backend=openssl` 也绿，产物却链了**厂商那份动态 OpenSSL**。
describe("check-crypto-backend：产物实际链的 OpenSSL 目录", () => {
  it("归一：末尾分隔符 / 反斜杠算同一个；大小写**只在 Windows 那侧**折叠", () => {
    expect(normalizeDir("C:\\Program Files\\OpenSSL-Win64\\")).toBe("C:/Program Files/OpenSSL-Win64");
    expect(normalizeDir("C:\\Program Files\\OpenSSL-Win64\\", { caseInsensitive: true })).toBe("c:/program files/openssl-win64");
    expect(opensslDirMatches("C:\\Vcpkg\\prefix", "c:/vcpkg/prefix/", { caseInsensitive: true })).toBe(true);
  });

  it("★ Unix 上大小写不同就是**另一个目录** ⇒ 不匹配（默认不折叠，避免假绿）", () => {
    expect(opensslDirMatches("/opt/ssl", "/opt/SSL/lib")).toBe(false);
  });

  it("子目录也算（Linux 的 `/usr` ↔ `/usr/lib/x86_64-linux-gnu` 同族）", () => {
    expect(opensslDirMatches("/usr", "/usr/lib/x86_64-linux-gnu")).toBe(true);
    expect(opensslDirMatches("/usr/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu")).toBe(true);
  });

  it("★ 另一个前缀 ⇒ **不匹配**（这条就是「链了别的 OpenSSL」要拦的情形）", () => {
    expect(opensslDirMatches("/tmp/tongsuo-static", "C:/Program Files/OpenSSL-Win64/lib/VC/x64/MD")).toBe(false);
  });

  it("没给/没解析出 ⇒ null（未实查，不判红）", () => {
    expect(opensslDirMatches("", "/usr/lib")).toBe(null);
    expect(opensslDirMatches("/usr", "")).toBe(null);
  });

  it("★ decide：声明的前缀与实际不符 ⇒ 红，且理由要点到 `OPENSSL_LIB_DIR` 覆盖 `OPENSSL_DIR`", () => {
    const { problems } = decide({
      all: [{ kind: "openssl", searchDir: "C:/Program Files/OpenSSL-Win64/lib/VC/x64/MD" }],
      expected: "openssl",
      patch: { expected: null, markers: [] },
      opensslDir: { expected: "C:/vcpkg/installed/x64-windows-static-md", actual: "C:/Program Files/OpenSSL-Win64/lib/VC/x64/MD" },
    });
    expect(problems.join()).toMatch(/OPENSSL_LIB_DIR/);
    expect(problems.join()).toMatch(/另一个 OpenSSL/);
  });

  it("★ decide：解析到的是 cargo 产物目录 ⇒ 红，但理由要指向**构建没走发现路径**，不能误报成 OPENSSL_LIB_DIR 覆盖", () => {
    // 2026-09-22 从**真 CI 日志**读到的第二种形态（Linux `--group rust`，没设 OPENSSL_DIR）：
    // 真读数 = `…/target/debug/build/libsqlite3-sys-2a9f05b01f82195b/out`。
    const outDir = "/home/runner/work/ShuyoNote/ShuyoNote/src-tauri/target/debug/build/libsqlite3-sys-2a9f05b01f82195b/out";
    expect(looksLikeCargoOutDir(outDir)).toBe(true);
    expect(looksLikeCargoOutDir("/usr/lib/x86_64-linux-gnu")).toBe(false);
    expect(looksLikeCargoOutDir("C:/vcpkg/installed/x64-windows-static-md/lib")).toBe(false);
    expect(looksLikeCargoOutDir("")).toBe(true);

    const { problems } = decide({
      all: [{ kind: "openssl", searchDir: outDir }],
      expected: "openssl",
      patch: { expected: null, markers: [] },
      opensslDir: { expected: "/usr", actual: outDir },
    });
    expect(problems.join()).toMatch(/没有 OpenSSL 的 link-search 行/);
    expect(problems.join()).toMatch(/--print-env/);
    expect(problems.join()).not.toMatch(/OPENSSL_LIB_DIR/); // 不许把第二种形态误报成第一种
  });

  it("decide：一致 ⇒ 通过并记一条", () => {
    const { problems, notices } = decide({
      all: [{ kind: "openssl", searchDir: "/tmp/tongsuo-static/lib" }],
      expected: "openssl",
      patch: { expected: null, markers: [] },
      opensslDir: { expected: "/tmp/tongsuo-static", actual: "/tmp/tongsuo-static/lib" },
    });
    expect(problems).toEqual([]);
    expect(notices.join()).toMatch(/实际链的 OpenSSL 目录与声明一致/);
  });
});
