// `scripts/lib/sm-library-source.mjs` 的判据（纯函数，不需要真 registry）。
//
// 为什么这些判据存在：这套解析 2026-09-19 被 macOS 侧用一个受控实验证明**第一版是错的**
// （按 mtime 最新挑 ⇒ 挑到陈旧副本，假阴性 ＋ 假阳性都成立），而那一版**没有任何判据**。
// 这一版把"挑哪份"变成可单测的纯函数，并把那条回归钉住。
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  lockVersion,
  requireStaticCrypto,
  markerFileOf,
  resolveSqlcipherSource,
  sha256OfFile,
  sourceFingerprint,
  staticCryptoVerdict,
} from "./sm-library-source.mjs";

const LOCK = `
version = 4

[[package]]
name = "rusqlite"
version = "0.40.0"

[[package]]
name = "libsqlite3-sys"
version = "0.38.2"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "serde"
version = "1.0.200"

[metadata]
checksum = "abc"
`;

const made = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造一个临时"仓库"：lock 文件 ＋ 一个假 registry（含指定版本目录）。 */
function fixture({ lock = LOCK, versions = ["0.38.2"], markerIn = null, markerFile = "sqlite3.c" }) {
  const dir = mkdtempSync(join(tmpdir(), "sm-src-"));
  made.push(dir);
  const lockPath = join(dir, "Cargo.lock");
  writeFileSync(lockPath, lock, "utf8");
  const reg = join(dir, "registry-src", "fake-registry");
  for (const v of versions) {
    const sc = join(reg, `libsqlite3-sys-${v}`, "sqlcipher");
    mkdirSync(sc, { recursive: true });
    writeFileSync(join(sc, "sqlite3.c"), `/* amalgamation ${v} */\n`, "utf8");
    if (markerIn === v) writeFileSync(join(sc, markerFile), "/* SQLCIPHER_HMAC_SM3_LABEL */\n", "utf8");
  }
  return { lockPath, roots: [reg] };
}

describe("lockVersion：只认那个包，且不靠行位置", () => {
  it("从真实形状的 Cargo.lock 里读出 libsqlite3-sys 的版本", () => {
    const { lockPath } = fixture({});
    expect(lockVersion(lockPath)).toMatchObject({ version: "0.38.2" });
  });

  it("没有这个包 ⇒ version:null（让调用方去报错，而不是瞎猜一个）", () => {
    const { lockPath } = fixture({ lock: '[[package]]\nname = "serde"\nversion = "1"\n' });
    expect(lockVersion(lockPath).version).toBeNull();
  });
});

describe("resolveSqlcipherSource：挑哪份源码", () => {
  it("★ 陈旧副本 mtime 更新时，仍然挑 Cargo.lock 锁的那个版本（macOS 侧那条回归）", () => {
    const { lockPath, roots } = fixture({ versions: ["0.30.1", "0.38.2"] });
    // 把陈旧副本的目录 mtime 弄新（macOS 侧那台的真实排列）
    const stale = join(roots[0], "libsqlite3-sys-0.30.1", "sqlcipher");
    const now = new Date();
    utimesSync(stale, now, now);
    const pick = resolveSqlcipherSource({ lockPath, roots });
    expect(pick.version).toBe("0.38.2");
    expect(pick.dir).toMatch(/libsqlite3-sys-0\.38\.2[\\/]sqlcipher$/);
  });

  it("★ registry 里没有锁定版本 ⇒ 抛 version-mismatch，**绝不挑别的版本**", () => {
    const { lockPath, roots } = fixture({ versions: ["0.30.1"] });
    let err = null;
    try {
      resolveSqlcipherSource({ lockPath, roots });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("version-mismatch");
    expect(err.found).toEqual(["0.30.1"]);
  });

  it("拿不到锁版本 ⇒ 抛 no-locked-version（不猜）", () => {
    const { lockPath, roots } = fixture({ lock: '[[package]]\nname = "serde"\nversion = "1"\n' });
    let err = null;
    try {
      resolveSqlcipherSource({ lockPath, roots });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("no-locked-version");
  });
});

describe("markerFileOf / sha256OfFile / sourceFingerprint", () => {
  it("标记扫的是 .c/.h，且**没有标记**时回落 sqlite3.c（判'过期标记'要的正是这个值）", () => {
    const { lockPath, roots } = fixture({ versions: ["0.38.2"] });
    const pick = resolveSqlcipherSource({ lockPath, roots });
    expect(markerFileOf(pick.dir)).toBeNull();
    const fp = sourceFingerprint({ lockPath, roots });
    expect(fp.hasMarker).toBe(false);
    expect(fp.file.endsWith("sqlite3.c")).toBe(true);
    expect(fp.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("★ 打了标记之后，指纹指向**带标记的那个文件**（与 build.rs 那行 src_sha256 同一对象）", () => {
    const { lockPath, roots } = fixture({ versions: ["0.38.2"], markerIn: "0.38.2", markerFile: "crypto_openssl.c" });
    const fp = sourceFingerprint({ lockPath, roots });
    expect(fp.hasMarker).toBe(true);
    expect(fp.file.endsWith("crypto_openssl.c")).toBe(true);
    expect(fp.sha256).toBe(sha256OfFile(fp.file));
  });

  it("标记只认内容、不认文件名（一个 .c 里有字面量就算）", () => {
    const { lockPath, roots } = fixture({ versions: ["0.38.2"], markerIn: "0.38.2", markerFile: "zzz.c" });
    expect(sourceFingerprint({ lockPath, roots }).hasMarker).toBe(true);
  });
});

// ★ 2026-09-22（owner 拍板「就发国密单一口味」后加）：**发布链上必须能证明"自包含"**。
//   机制：`libsqlite3-sys` 发 `rustc-link-lib=dylib=crypto`，链接器在**没有共享库时退到 .a**
//   ⇒ "前缀里只有 libcrypto.a"＝静态链接；"前缀里有 .dylib/.so"＝产物依赖**构建机**那份。
//   实测（本机）：只放 libcrypto.a 的前缀 ⇒ `otool -L` 里**没有**任何 libcrypto/libssl。
describe("sm-library-source：静态前缀守卫（单一口味要自包含）", () => {
  it("只有 libcrypto.a ⇒ 通过，并报出它", () => {
    const v = staticCryptoVerdict({ names: ["libcrypto.a", "libssl.a", "pkgconfig"] });
    expect(v.ok).toBe(true);
    expect(v.found).toContain("libcrypto.a");
  });

  it("★ 有 libcrypto.dylib（或 .so / 版本化 .so）⇒ **不通过**，且理由要点到「依赖构建机」", () => {
    for (const names of [
      ["libcrypto.a", "libcrypto.dylib"],
      ["libcrypto.so", "libcrypto.a"],
      ["libcrypto.so.3", "libcrypto.a"],
      ["libcrypto.3.dylib", "libcrypto.a"],
    ]) {
      const v = staticCryptoVerdict({ names });
      expect(v.ok).toBe(false);
      expect(v.why).toMatch(/共享版 libcrypto/);
      expect(v.why).toMatch(/构建机/);
      expect(v.why).toMatch(/libcrypto\.a/);
    }
  });

  it("lib64 里的共享库也算（只看 lib/ 会漏）", () => {
    const v = staticCryptoVerdict({ names: ["libcrypto.a"], files: [{ names: ["libcrypto.so.3"] }] });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/libcrypto\.so\.3/);
  });

  it("没有 .a ⇒ 不通过（静态链接无从谈起，别静默变成动态）", () => {
    const v = staticCryptoVerdict({ names: ["libssl.dylib", "pkgconfig"] });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/没有.*libcrypto\.a/);
  });
});

  // ★ 这一条走**磁盘版**（`requireStaticCrypto`）—— 上面那条只喂纯函数，抓不住"只看 lib/、漏 lib64"的变异
  //   （实测：把 lib64 那支删掉，纯函数那条照样绿 ⇒ 必须有一条走目录扫描的）。
  //   ⚠️ 它**名字里就写着"磁盘版"，第一版却喂了假 FS** —— 而假 FS 按字面 `/lib64` 匹配，生产用的是
  //   `node:path.join`（Windows 上是 `\`）⇒ 在 Windows 上永远匹配不上（**假红**，2026-09-22 实测）。
  //   ⇒ 真的走磁盘：目录用 `join` 建，判据自动跨平台，也比假 FS 更接近真前缀。
  it("磁盘版必须**同时看** lib/ 与 lib64/（只扫 lib/ 会漏掉真实前缀）", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-static-"));
    made.push(dir);
    mkdirSync(join(dir, "lib"), { recursive: true });
    mkdirSync(join(dir, "lib64"), { recursive: true });
    writeFileSync(join(dir, "lib", "libcrypto.a"), "");
    writeFileSync(join(dir, "lib64", "libcrypto.so.3"), "");
    const v = requireStaticCrypto(dir);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/libcrypto\.so\.3/);
    // 反向：lib64 里也放 .a ⇒ 通过
    rmSync(join(dir, "lib64", "libcrypto.so.3"));
    writeFileSync(join(dir, "lib64", "libcrypto.a"), "");
    expect(requireStaticCrypto(dir).ok).toBe(true);
  });

// ★ Windows 那一支（2026-09-22，Windows 侧点名要）：OpenSSL 的 **Windows 安装版是动态的**，
//   DLL 叫 `bin\libcrypto-3-x64.dll`（**连字符**），而它同时在 `lib\` 放一份**导入库** `libcrypto.lib`
//   ⇒ 只看 `lib/` 会被骗过（看着像"有 .lib 就能静态"），实际是"链接期解析到导入库、运行时去找 DLL"。
//   动机不是理论：Windows 那台机器的全局 `OPENSSL_DIR` 正指着这样一个动态前缀。
describe("sm-library-source：静态前缀守卫（Windows 的那一支）", () => {
  it("★ 动态前缀：`lib/libcrypto.lib`（导入库）＋ `bin/libcrypto-3-x64.dll` ⇒ **不通过**", () => {
    const v = staticCryptoVerdict({
      names: ["libcrypto.lib"],
      files: [{ names: ["libcrypto.lib"] }, { names: ["libcrypto-3-x64.dll", "libssl-3-x64.dll"] }],
    });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/libcrypto-3-x64\.dll/);
  });

  it("vcpkg 那种静态前缀（只有 libcrypto.lib、bin 里没有 crypto DLL）⇒ 通过", () => {
    const v = staticCryptoVerdict({
      names: ["libcrypto.lib", "libssl.lib"],
      files: [{ names: ["libcrypto.lib"] }, { names: [] }],
    });
    expect(v.ok).toBe(true);
  });

  it("★ 磁盘版必须扫 `bin/`（只扫 lib/ 会漏掉 Windows 那个坑）", () => {
    // 同上：这条是"磁盘版"，就走真磁盘（假 FS 的字面 `/bin` 在 Windows 上匹配不上 ⇒ 假红）。
    // 本机全局 `OPENSSL_DIR=C:\Program Files\OpenSSL-Win64` 正长这样：
    // `lib\libcrypto.lib`（导入库）＋ `bin\libcrypto-3-x64.dll`。
    const dir = mkdtempSync(join(tmpdir(), "sm-static-win-"));
    made.push(dir);
    mkdirSync(join(dir, "lib"), { recursive: true });
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "lib", "libcrypto.lib"), "");
    writeFileSync(join(dir, "bin", "libcrypto-3-x64.dll"), "");
    const v = requireStaticCrypto(dir);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/libcrypto-3-x64\.dll/);
  });
});

describe("★ 隔离副本优先（2026-09-23「消灭补丁残留」）", () => {
  it("有 `.gm-build/libsqlite3-sys-<ver>/sqlcipher` ⇒ 用它（否则每次国密构建都会被判成「标记过期」= 假红）", () => {
    const { lockPath, roots } = fixture({});
    const repoRoot = join(lockPath, ".."); // fixture 的 dir 就是"仓库根"
    // 没有副本 ⇒ 走 registry
    expect(resolveSqlcipherSource({ lockPath, roots }).via).toBe("cargo.lock");
    expect(resolveSqlcipherSource({ lockPath, roots, repoRoot }).via).toBe("cargo.lock");
    // 造副本 ⇒ 优先它（`repoRoot` 必须传，且 `sourceFingerprint` 也要转发）
    const iso = join(repoRoot, ".gm-build", "libsqlite3-sys-0.38.2", "sqlcipher");
    mkdirSync(iso, { recursive: true });
    writeFileSync(join(iso, "sqlite3.c"), "/* patched (isolation) */\n", "utf8");
    expect(resolveSqlcipherSource({ lockPath, roots, repoRoot })).toMatchObject({ via: "isolation", dir: iso });
    // `sourceFingerprint` 那条路也要能选中它（我第一版忘了转发 repoRoot ⇒ 表现为"标记过期"假红）
    expect(sourceFingerprint({ lockPath, roots, repoRoot }).via).toBe("isolation");
  });

  it("副本目录在、但里面没有 sqlite3.c（半成品）⇒ **不**当副本，退回 registry", () => {
    const { lockPath, roots } = fixture({});
    const repoRoot = join(lockPath, "..");
    mkdirSync(join(repoRoot, ".gm-build", "libsqlite3-sys-0.38.2", "sqlcipher"), { recursive: true });
    expect(resolveSqlcipherSource({ lockPath, roots, repoRoot }).via).toBe("cargo.lock");
  });
});
