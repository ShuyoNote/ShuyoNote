// 「补丁只打在私有副本上」这一格的判据（2026-09-23，owner 点名的 G 格）。
//
// 核心不变量只有一条，但要**用真目录**验：
//   **跑完隔离，共享 registry 那份源码一个字节都没变** —— 残留"不可能发生"（而不是"被发现"）。
// 其余是几条纯函数（路径层数 / TOML / 链接类型），它们各自对应一次真实踩坑。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  cargoHomeOfRegistrySrc,
  gmConfigPath,
  gmConfigToml,
  gmCopyDir,
  gmCargoHome,
  isolateSqlcipherSource,
  registryLinkType,
  removeIsolation,
} from "./sm-library-isolate.mjs";

/** 造一份"像 registry"的目录：`<cargoHome>/registry/src/<index>/libsqlite3-sys-<ver>/sqlcipher/sqlite3.c`。 */
function fakeRegistry({ cargoHome, index = "rsproxy.cn-abc", version = "0.38.2", marker = false }) {
  const src = join(cargoHome, "registry", "src", index, `libsqlite3-sys-${version}`, "sqlcipher");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "sqlite3.c"), marker ? "-- SQLCIPHER_HMAC_SM3_LABEL\n" : "-- 原版\n", "utf8");
  // crate 根要有 Cargo.toml（`[patch]` 指向的是 crate 根，不是 sqlcipher/）
  writeFileSync(join(src, "..", "Cargo.toml"), `[package]\nname = "libsqlite3-sys"\nversion = "${version}"\n`, "utf8");
  return src;
}

describe("sm-library-isolate：路径推导（含我第一版数错的那一层）", () => {
  it("★ 从 sqlcipher 目录反推 CARGO_HOME 要走**五**层（数四层会把镜像配置丢掉）", () => {
    const cargoHome = join(tmpdir(), "ch");
    const src = fakeRegistry({ cargoHome });
    expect(cargoHomeOfRegistrySrc(src)).toBe(cargoHome);
    // 真实形态再钉一遍：`<home>/registry/src/<index>/<crate>/sqlcipher`
    expect(cargoHomeOfRegistrySrc("/h/.cargo/registry/src/idx/libsqlite3-sys-0.38.2/sqlcipher")).toBe("/h/.cargo");
  });

  it("私有目录三件：副本 crate 根 / CARGO_HOME / config", () => {
    const repo = join(tmpdir(), "repo");
    expect(gmCopyDir(repo, "0.38.2")).toBe(join(repo, ".gm-build", "libsqlite3-sys-0.38.2"));
    expect(gmCargoHome(repo)).toBe(join(repo, ".gm-build", "cargo-home"));
    expect(gmConfigPath(repo)).toBe(join(repo, ".gm-build", "cargo-home", "config.toml"));
  });

  it("Windows 用 junction（不需要管理员），其它平台用 dir", () => {
    expect(registryLinkType("win32")).toBe("junction");
    expect(registryLinkType("darwin")).toBe("dir");
    expect(registryLinkType("linux")).toBe("dir");
  });
});

describe("sm-library-isolate：config.toml", () => {
  it("★ 真实 config（镜像！）必须**逐字继承** —— 丢了它，新 CARGO_HOME 会去连真正的 crates.io", () => {
    const real = "[source.crates-io]\nreplace-with = 'rsproxy'\n";
    const toml = gmConfigToml({ realConfigText: real, copyDir: "/repo/.gm-build/libsqlite3-sys-0.38.2" });
    expect(toml).toContain("replace-with = 'rsproxy'");
    expect(toml).toContain("[patch.crates-io]");
    expect(toml).toContain("libsqlite3-sys = { path = '/repo/.gm-build/libsqlite3-sys-0.38.2' }");
    // 没有真实 config 时也要能生成（干净机器）
    expect(gmConfigToml({ copyDir: "/x" })).toContain("[patch.crates-io]");
  });

  it("路径用 TOML **字面串**（单引号）：Windows 的 `C:\\a\\b` 不用转义反斜杠", () => {
    const toml = gmConfigToml({ copyDir: "C:\\repo\\.gm-build\\libsqlite3-sys-0.38.2" });
    expect(toml).toContain("path = 'C:\\repo\\.gm-build\\libsqlite3-sys-0.38.2'");
    expect(toml).not.toContain("C:\\\\repo");
  });
});

describe("sm-library-isolate：真目录下的隔离（核心不变量）", () => {
  it("★ 跑完隔离：**共享 registry 一个字节都没变**，补丁只打在副本上，config 与链接都建好", () => {
    const root = mkdtempSync(join(tmpdir(), "iso-"));
    const repo = join(root, "repo");
    const cargoHome = join(root, "cargo-home");
    mkdirSync(repo, { recursive: true });
    // 真实 config（带镜像）也造出来，验证"继承"
    mkdirSync(cargoHome, { recursive: true });
    writeFileSync(join(cargoHome, "config.toml"), "[source.crates-io]\nreplace-with = 'rsproxy'\n", "utf8");
    const src = fakeRegistry({ cargoHome });
    const before = readFileSync(join(src, "sqlite3.c"), "utf8");
    const seen = [];
    const fakeEnsurePatch = (dir, patchFile, opts) => {
      seen.push({ dir, patchFile, apply: opts.apply });
      writeFileSync(join(dir, "sqlite3.c"), "-- SQLCIPHER_HMAC_SM3_LABEL（副本）\n", "utf8");
      return { status: "applied", file: join(dir, "sqlite3.c"), tool: "fake", bytes: 1 };
    };

    const iso = isolateSqlcipherSource({
      repoRoot: repo,
      srcDir: src,
      version: "0.38.2",
      patchFile: join(repo, "patches", "0001.patch"),
      ensurePatch: fakeEnsurePatch,
    });

    // ① 补丁只打在**副本的 sqlcipher/** 上
    expect(seen).toHaveLength(1);
    expect(seen[0].dir).toBe(join(iso.copyDir, "sqlcipher"));
    expect(seen[0].apply).toBe(true);
    // ①b `[patch]` 指向的是**crate 根**（有 Cargo.toml 的那层），不是 sqlcipher/
    expect(existsSync(join(iso.copyDir, "Cargo.toml"))).toBe(true);
    // ② ★ 不变量：共享那份**逐字未变**
    expect(readFileSync(join(src, "sqlite3.c"), "utf8")).toBe(before);
    expect(before).not.toContain("SQLCIPHER_HMAC_SM3_LABEL");
    // ③ config 继承了镜像 ＋ 带上 patch 段；④ registry 挂进来了
    const cfg = readFileSync(iso.configPath, "utf8");
    expect(cfg).toContain("replace-with = 'rsproxy'");
    expect(cfg).toContain("[patch.crates-io]");
    expect(lstatSync(join(iso.cargoHome, "registry")).isSymbolicLink()).toBe(true);
    expect(iso.linked).toContain("registry");
    // ⑤ 再跑一次是**幂等**的（每次都重拷，绝不复用上次那份）
    const iso2 = isolateSqlcipherSource({
      repoRoot: repo,
      srcDir: src,
      version: "0.38.2",
      patchFile: join(repo, "patches", "0001.patch"),
      ensurePatch: fakeEnsurePatch,
    });
    expect(iso2.copyDir).toBe(iso.copyDir);
    expect(readFileSync(join(src, "sqlite3.c"), "utf8")).toBe(before);
    // ⑥ `--revert` 的语义 = 删这个目录
    expect(removeIsolation(repo)).toBe(true);
    expect(existsSync(join(repo, ".gm-build"))).toBe(false);
    expect(removeIsolation(repo)).toBe(false); // 幂等
    rmSync(root, { recursive: true, force: true });
  });

  it("crate 目录名对不上（版本漂了）⇒ 当场拒绝，不做「差不多」的隔离", () => {
    const root = mkdtempSync(join(tmpdir(), "iso-bad-"));
    const cargoHome = join(root, "ch");
    const src = fakeRegistry({ cargoHome, version: "0.30.1" });
    expect(() =>
      isolateSqlcipherSource({
        repoRoot: join(root, "repo"),
        srcDir: src,
        version: "0.38.2",
        patchFile: "x.patch",
        ensurePatch: () => ({ status: "applied" }),
      }),
    ).toThrow(/libsqlite3-sys-0.38.2/);
    rmSync(root, { recursive: true, force: true });
  });
});
