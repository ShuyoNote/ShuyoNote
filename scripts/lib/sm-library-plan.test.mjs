// `scripts/lib/sm-library-plan.mjs` 的判据。
//
// 来历（2026-09-22，真实事故）：发版链按改动前的写法跑出来的是**非国密**包 ——
// 因为 `--prepare` 只清 dev profile，而 `tauri build` 是 release ⇒ release 的旧 SQLCipher
// 被**原样复用**（`libsqlite3-sys` 没为 `OPENSSL_DIR` 声明 rerun-if-env-changed）。
// 本机把发版链原样跑一遍时，`check-crypto-backend` 的三条断言把它抓住了。
// ⇒ 这两条判据钉住"两个 profile 都必须清"，避免下一个人再把 `--release` 去掉。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { cleanCommands, envFileLines, opensslEnvFor, shouldBuild } from "./sm-library-plan.mjs";

const manifest = "/repo/src-tauri/Cargo.toml";

describe("sm-library-plan：清产物必须覆盖**两个 profile**", () => {
  it("★ 每个包都有 debug 与 release 两条（少 release ⇒ 发非国密包）", () => {
    const steps = cleanCommands({ manifest });
    for (const pkg of ["libsqlite3-sys", "shuyonote"]) {
      const forPkg = steps.filter((s) => s.args.includes(pkg));
      expect(forPkg.length).toBe(2);
      const flags = forPkg.map((s) => (s.args.includes("--release") ? "release" : "debug"));
      expect(flags.sort()).toEqual(["debug", "release"]);
    }
  });

  it("★ release 那一条的说明必须点出后果（「少了它会怎样」写给人看）", () => {
    const release = cleanCommands({ manifest }).filter((s) => s.args.includes("--release"));
    expect(release.length).toBe(2);
    for (const s of release) expect(s.label).toMatch(/非国密|原样复用/);
  });

  it("命令形状对：`cargo clean -p <pkg> [--release] --manifest-path <路径>`", () => {
    for (const s of cleanCommands({ manifest })) {
      expect(s.cmd).toBe("cargo");
      expect(s.args.slice(0, 3)).toEqual(["clean", "-p", s.args[2]]);
      expect(s.args).toContain("--manifest-path");
      expect(s.args[s.args.length - 1]).toBe(manifest);
    }
  });
});

describe("sm-library-plan：--prepare 不构建", () => {
  it("prepare ⇒ 不构建；默认 ⇒ 构建", () => {
    expect(shouldBuild({ prepare: true })).toBe(false);
    expect(shouldBuild({ prepare: false })).toBe(true);
    expect(shouldBuild({})).toBe(true);
  });
});

// ★ 2026-09-22（CI 真跑抓出来的）：Ubuntu 的开发文件在**多架构目录**里，而 `openssl-sys` 只看
//   `<OPENSSL_DIR>/lib|lib64` ⇒ 单给 `OPENSSL_DIR=/usr` 会在编译期炸：
//   `OpenSSL libdir at ["/usr/lib64","/usr/lib"] does not contain the required files…`。
//   两个 crate 都接受的形态是 `OPENSSL_DIR` ＋ `OPENSSL_LIB_DIR` ＋ `OPENSSL_INCLUDE_DIR`。
// ⚠️ 假 FS 的匹配与**期望值**都必须与生产同口径：生产用 `node:path.join`（Windows 上是 `\`），
//   第一版按字面 `/lib`、`x86_64-linux-gnu` 匹配、期望值也写成 POSIX 字面量 ⇒ Windows 上**假红**
//   （2026-09-22 实测：`join('/usr','lib')` = `"\\usr\\lib"`，`endsWith('/lib')` = false）。
//   ⇒ 假 FS 按 `basename` 匹配，期望值用 `join` 拼；另加一条**真磁盘**判据兜底。
describe("sm-library-plan：OpenSSL 前缀 → 两个 crate 都认的环境变量", () => {
  const multiarch = (p) =>
    ["lib", "lib64"].includes(basename(p))
      ? ["x86_64-linux-gnu", "python3"]
      : basename(p) === "x86_64-linux-gnu"
        ? ["libcrypto.so", "libcrypto.a"]
        : [];

  it("★ ubuntu 多架构（`/usr/lib/x86_64-linux-gnu/libcrypto.so`）⇒ 给出 LIB_DIR 指到那一层", () => {
    const env = opensslEnvFor("/usr", { exists: () => true, readdir: multiarch });
    expect(env).toEqual({
      OPENSSL_DIR: "/usr",
      OPENSSL_LIB_DIR: join("/usr", "lib", "x86_64-linux-gnu"),
      OPENSSL_INCLUDE_DIR: join("/usr", "include"),
    });
  });

  it("普通前缀（`lib/libcrypto.a`）⇒ LIB_DIR 就是 lib/", () => {
    const libDir = join("/opt/tongsuo", "lib");
    const env = opensslEnvFor("/opt/tongsuo", { exists: (p) => p === libDir, readdir: () => ["libcrypto.a", "libssl.a"] });
    expect(env.OPENSSL_LIB_DIR).toBe(libDir);
    expect(env.OPENSSL_DIR).toBe("/opt/tongsuo");
  });

  it("找不到 crypto 开发文件 ⇒ null（调用方据此**响亮跳过**，而不是让 cargo 去炸）", () => {
    expect(opensslEnvFor("/usr", { exists: () => true, readdir: () => ["libcrypto.so.3"] })).toBe(null);
    expect(opensslEnvFor("")).toBe(null);
  });

  it("★ 真磁盘（**不喂假 FS**）：`join` 建出来的多架构前缀能被翻成 LIB_DIR（这一类假红的兜底判据）", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-plan-"));
    try {
      const multi = join(dir, "lib", "x86_64-linux-gnu");
      mkdirSync(multi, { recursive: true });
      writeFileSync(join(multi, "libcrypto.so"), "");
      const env = opensslEnvFor(dir);
      expect(env?.OPENSSL_LIB_DIR).toBe(multi);
      expect(env?.OPENSSL_DIR).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("envFileLines：渲染成 `KEY=value`（丢掉 undefined，给 `$GITHUB_ENV` 用）", () => {
    expect(envFileLines({ A: "1", B: undefined, C: "/x" })).toBe("A=1\nC=/x");
    expect(envFileLines(null)).toBe("");
  });
});
