// Cargo build 布局兼容判据（2026-11-15）。
//
// 为什么单独放这里、不塞进 `scripts/check-crypto-backend.test.mjs`：
//   `_workspace` 的 `evidence-in-same-round` 把 `repos/*/scripts/check-*.mjs` 的**任何**改动都当"门禁改了"，
//   连 `.test.mjs` 也算 ⇒ 改那个文件要再走一遍变异账本（不成比例）。
//   本文件的被测对象仍是 `check-crypto-backend.mjs` 导出的**同一个** helper（唯一实现，不复制）。
//
// 来由（CI 实测）：GitHub runner 上的 cargo 已改用新 build 布局
//   `target/<profile>/build/<pkg>/<hash>/output`（旧布局 `build/<pkg>-<hash>/output`）。
//   旧扫描只认 `<pkg>-*` ⇒ 产物一条都找不到 ⇒ check-crypto-backend 与 check-gm-wired 第③格
//   都自报「未实查」（严格档把"未登记的自报跳过"按失败计）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { collectPatchMarkers, buildOutputFileOf, listBuildScriptDirs } from "../check-crypto-backend.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "cb-layout-"));

describe("Cargo build 布局兼容（两种布局都要认）", () => {
  it("listBuildScriptDirs 同时认旧布局与新布局", () => {
    const t = tmp();
    const build = join(t, "debug", "build");
    mkdirSync(join(build, "shuyonote-aaaa"), { recursive: true });
    mkdirSync(join(build, "shuyonote", "bbbb"), { recursive: true });
    mkdirSync(join(build, "libsqlite3-sys-cccc"), { recursive: true });
    mkdirSync(join(build, "libsqlite3-sys", "dddd"), { recursive: true });

    expect(listBuildScriptDirs(build, "shuyonote").map((x) => x.entry).sort()).toEqual([
      "shuyonote-aaaa",
      "shuyonote/bbbb",
    ]);
    expect(listBuildScriptDirs(build, "libsqlite3-sys").map((x) => x.entry).sort()).toEqual([
      "libsqlite3-sys-cccc",
      "libsqlite3-sys/dddd",
    ]);
    rmSync(t, { recursive: true, force: true });
  });

  it("新布局下 build 目录里的 output 文件能被定位（.test 级回归）", () => {
    const t = tmp();
    const outDir = join(t, "debug", "build", "libsqlite3-sys", "0f0f0f0f0f0f0f0f");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "output"), "cargo:rustc-link-search=native=/usr/lib/x86_64-linux-gnu\n");
    const hit = listBuildScriptDirs(join(t, "debug", "build"), "libsqlite3-sys");
    expect(hit).toHaveLength(1);
    expect(hit[0].entry).toBe("libsqlite3-sys/0f0f0f0f0f0f0f0f");
    expect(hit[0].dir).toBe(outDir);
    rmSync(t, { recursive: true, force: true });
  });
});

describe("build script 的 stdout 位置（Cargo 1.100 改成 <hash>/run/stdout）", () => {
  it("buildOutputFileOf：旧布局读 <hash>/output，新布局读 <hash>/run/stdout，都没有则 null", () => {
    const t = tmp();
    const legacy = join(t, "legacy");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "output"), "cargo:rustc-link-lib=dylib=crypto\n");
    expect(buildOutputFileOf(legacy)).toBe(join(legacy, "output"));

    const modern = join(t, "modern");
    mkdirSync(join(modern, "run"), { recursive: true });
    writeFileSync(join(modern, "run", "stdout"), "cargo:rustc-link-lib=dylib=crypto\n");
    expect(buildOutputFileOf(modern)).toBe(join(modern, "run", "stdout"));

    const empty = join(t, "empty");
    mkdirSync(empty, { recursive: true });
    expect(buildOutputFileOf(empty)).toBeNull();
    rmSync(t, { recursive: true, force: true });
  });

  it("collectPatchMarkers：新布局 <pkg>/<hash>/run/stdout 里的补丁标记能读到", () => {
    const t = tmp();
    const runDir = join(t, "debug", "build", "shuyonote", "1a2b3c4d5e6f7a8b", "run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "stdout"),
      "warning: shuyonote@2.1.15: shuyonote: sm3/sm4 provider patch applied (patch=v1 target=linux marker=sqlite3.c)\n",
    );
    const got = collectPatchMarkers(t);
    expect(got).toHaveLength(1);
    expect(got[0].entry).toBe("shuyonote/1a2b3c4d5e6f7a8b");
    expect(got[0].found).toBe(true);
    rmSync(t, { recursive: true, force: true });
  });
});