// 判据：`--print-env` 的 **stdout 只许有 `$GITHUB_ENV` 能吃的东西**。
//
// 来历（2026-09-25，真 CI，run 36096199288 的 step 23 —— 「把私有 CARGO_HOME 交给构建步骤」）：
// 国密隔离之后两条 android job 都把 `--print-env` 的 stdout **整体**重定向进 `$GITHUB_ENV`，
// 而 CLI 那时把「源码 = …」「隔离 ✓ 补丁打在私有副本 …」这些**给人看的行**也打在 stdout 上 ⇒ runner 报
//
//   Invalid format 'sm-library-build: 隔离 ✓ 补丁打在私有副本 /home/runner/…'
//   Unable to process file command 'env' successfully.
//
// ⇒ **交接这一步自己红**，紧随其后的 `Build APK` 被 skip —— 现场看着像"补丁没打完"，
//   其实是"这一步的 stdout 不干净"。同一形态在本仓 2026-09-12 出现过一次（非法 YAML ⇒ 0 个 job 的红 run）：
//   **把人的可读输出喂给机器**。
//
// ★ 为什么必须**踩到数据路径**（第一版这条判据就栽在这里）：
//   第一版夹具故意用"后端目录不存在"，于是 CLI 在 `--print-env` 的 emit 之前就失败退出 ——
//   "stdout 干净"是**空过**；而当时守卫里 `stdout.write` 是**调用时**才取的，装到真流上必然无限递归，
//   这条判据却全绿（假绿比红更坏）。现在夹具自带**假 openssl 前缀**（`lib/libcrypto.a`）与
//   **带补丁标记的假源码**，所以它能一路走到 emit，并断言 `OPENSSL_DIR=` 真的出现在 stdout 里。
//
// 为什么在夹具里跑**真 CLI**（而不是只测守卫函数）："守卫装上了没有"才是载重点 —— 只测函数的话，
// 谁把那两行装配删掉，判据照样全绿。夹具用假 `HOME` ＋ 假 registry，**不依赖本机 cargo/Tongsuo**。
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MARKER } from "./lib/sm-library-source.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCKED = "0.38.2";
/** `$GITHUB_ENV` 吃得下的行：`KEY=value`。 */
const ENV_LINE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * 搭一个"看起来像本仓"的夹具：CLI 与它的 lib 是**真文件**（复制），
 * Cargo.lock、registry 源码、OpenSSL 前缀是**假的** —— 让它走完整条数据路径而不碰本机任何东西。
 */
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "sm-build-fixture-"));
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  cpSync(join(repoRoot, "scripts", "lib"), join(repo, "scripts", "lib"), { recursive: true });
  cpSync(join(repoRoot, "scripts", "sm-library-build.mjs"), join(repo, "scripts", "sm-library-build.mjs"));
  cpSync(join(repoRoot, "patches"), join(repo, "patches"), { recursive: true });
  mkdirSync(join(repo, "src-tauri"), { recursive: true });
  writeFileSync(
    join(repo, "src-tauri", "Cargo.lock"),
    `version = 4\n\n[[package]]\nname = "libsqlite3-sys"\nversion = "${LOCKED}"\n`,
  );
  // 假 registry 源码：**带上补丁标记** ⇒ `--no-apply` 也能过"标记在场"那一关，从而走到 emit
  const sc = join(home, ".cargo", "registry", "src", "index.fixture", `libsqlite3-sys-${LOCKED}`, "sqlcipher");
  mkdirSync(sc, { recursive: true });
  writeFileSync(join(sc, "sqlite3.c"), `/* 夹具占位（不是真 sqlite3.c） */\n#define ${MARKER} 1\n`);
  // 假 OpenSSL 前缀：`opensslEnvFor` 只要求 `lib/` 里有 `libcrypto.*`（这样 `--print-env` 才走得到 emit）
  const prefix = join(dir, "openssl-prefix");
  mkdirSync(join(prefix, "lib"), { recursive: true });
  mkdirSync(join(prefix, "include"), { recursive: true });
  writeFileSync(join(prefix, "lib", "libcrypto.a"), "");
  return { dir, repo, home, prefix };
}

/** 跑夹具里的真 CLI；`--no-apply` ⇒ 连夹具的假源码也不改。 */
function runCli(fx, args) {
  // ⚠️ 用 `spawnSync` 而不是 `execFileSync`：后者在**成功**路径上拿不到 stderr（我第一版就因此写了个
  // "stderr 为空"的假断言），而这条判据恰恰要同时看两条流。
  const r = spawnSync("node", [join("scripts", "sm-library-build.mjs"), ...args], {
    cwd: fx.repo,
    encoding: "utf8",
    env: { ...process.env, HOME: fx.home, CARGO_HOME: join(fx.home, ".cargo") },
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("sm-library-build.mjs：stdout 是数据、stderr 是日志", () => {
  it("`--print-env`：stdout 里除了 `KEY=value` 什么都不许有（否则 `>> $GITHUB_ENV` 必红）", () => {
    const fx = makeFixture();
    try {
      const r = runCli(fx, ["--print-env", "--no-apply", "--openssl-dir", fx.prefix]);
      // ★ 先断言**纯净性**（这条红出来就是真缺陷本身，不该被别的断言抢先）
      const lines = r.stdout.split("\n").filter((l) => l !== "");
      expect(lines.filter((l) => !ENV_LINE.test(l))).toEqual([]);
      // 再断言**两侧都非空过**：
      // ① 数据路径真的跑到了（没有它，"stdout 干净"只是空过）；② 日志真的挪到了 stderr
      expect(r.code).toBe(0);
      expect(lines).toContain(`OPENSSL_DIR=${fx.prefix}`);
      expect(r.stderr).toContain("sm-library-build: 源码 =");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it("同一条命令**不带** `--print-env` 时，日志与数据都仍在 stdout（只是换了道，没把日志删掉）", () => {
    const fx = makeFixture();
    try {
      // `--print-source-sha256`：在"环境核对"之前就退出（不会去跑 cargo），正好当"非 print-env 模式"的样本
      const r = runCli(fx, ["--print-source-sha256", "--no-apply", "--openssl-dir", fx.prefix]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("sm-library-build: 源码 =");
      expect(r.stdout).toMatch(/^[0-9a-f]{64} /m);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});
