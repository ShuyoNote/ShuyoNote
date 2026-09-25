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
//   其实是"这一步的 stdout 不干净"。同一类形态在本仓 2026-09-12 已经出现过一次（非法 YAML ⇒ 0 个 job 的红 run）：
//   **把人的可读输出喂给机器**。
//
// 为什么要在**夹具**里跑真 CLI（而不是只测那个守卫函数）：
//   "守卫装上了没有"是这次真正的载重点 —— 只测函数的话，谁把 `if (envOut) process.stdout.write = …`
//   那两行删掉，判据照样全绿（假绿）。夹具自带 Cargo.lock 与假 registry（用假 `HOME`），
//   所以这条判据**不依赖本机有没有 cargo/Tongsuo**，CI 里也跑得动。
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCKED = "0.38.2";
/** `$GITHUB_ENV` 吃得下的行：`KEY=value`。 */
const ENV_LINE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * 搭一个"看起来像本仓"的夹具：CLI 与它的 lib 是**真文件**（复制），
 * Cargo.lock 与 registry 源码是**假的**（让它在不碰本机任何东西的前提下走完整条日志路径）。
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
  const sc = join(home, ".cargo", "registry", "src", "index.fixture", `libsqlite3-sys-${LOCKED}`, "sqlcipher");
  mkdirSync(sc, { recursive: true });
  writeFileSync(join(sc, "sqlite3.c"), "/* 夹具：原版 sqlite3.c 的占位 */\n");
  return { dir, repo, home };
}

/** 跑夹具里的真 CLI；`--no-apply` ⇒ 连夹具的假源码也不改。 */
function runCli(fx, args) {
  try {
    const stdout = execFileSync("node", [join("scripts", "sm-library-build.mjs"), ...args], {
      cwd: fx.repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: fx.home, CARGO_HOME: join(fx.home, ".cargo") },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("sm-library-build.mjs：stdout 是数据、stderr 是日志", () => {
  it("`--print-env`：stdout 里除了 `KEY=value` 什么都不许有（否则 `>> $GITHUB_ENV` 必红）", () => {
    const fx = makeFixture();
    try {
      // 故意给一个**不存在的后端**：这样它一定在"只打印日志"之后、构建之前停下（不看本机的 Tongsuo）。
      const r = runCli(fx, ["--print-env", "--no-apply", "--openssl-dir", join(fx.dir, "no-such-openssl")]);
      expect(r.code).not.toBe(0); // 后端不存在 ⇒ 如实非 0（不是"静默放过"）
      // ★ 先断言**纯净性**（这条红出来就是真缺陷本身，不该被别的断言抢先）
      const lines = r.stdout.split("\n").filter((l) => l !== "");
      expect(lines.filter((l) => !ENV_LINE.test(l))).toEqual([]);
      // 再断言**非空过**：日志路径真的跑到了（否则"stdout 干净"毫无意义）
      expect(r.stderr).toContain("sm-library-build: 源码 =");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it("同一条命令**不带** `--print-env` 时，那些给人看的行仍在 stdout（只是换了道，没把日志删掉）", () => {
    const fx = makeFixture();
    try {
      const r = runCli(fx, ["--no-apply", "--openssl-dir", join(fx.dir, "no-such-openssl")]);
      expect(r.code).not.toBe(0);
      expect(r.stdout).toContain("sm-library-build: 源码 =");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});
