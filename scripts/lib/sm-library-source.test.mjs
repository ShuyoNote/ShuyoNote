// `scripts/lib/sm-library-source.mjs` 的判据（纯函数，不需要真 registry）。
//
// 为什么这些判据存在：这套解析 2026-09-19 被 macOS 侧用一个受控实验证明**第一版是错的**
// （按 mtime 最新挑 ⇒ 挑到陈旧副本，假阴性 ＋ 假阳性都成立），而那一版**没有任何判据**。
// 这一版把"挑哪份"变成可单测的纯函数，并把那条回归钉住。
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { lockVersion, markerFileOf, resolveSqlcipherSource, sha256OfFile, sourceFingerprint } from "./sm-library-source.mjs";

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
