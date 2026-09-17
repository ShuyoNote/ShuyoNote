// `check-sys-deps` 门禁的**自测**：把"这张表凭什么这么写"变成机器可查，并且**逐条做变异**。
//
// 为什么需要它（2026-09-17，两道真实的坎）：
//   ① AMD 侧的原型（协作邮箱 `proposed-gates/check-sys-deps.mjs`）在"未登记的 *-sys crate"上
//      **只打印警告、exit 保持 0**。我复现过：往 `Cargo.lock` 里塞一个 `acme-native-sys`，
//      它照样打印「全部就位」。而"新依赖进来了、映射没更新"正是这张表要挡的事故
//      ⇒ 本文件第 3 个用例把它钉死（必须 exit 3 且点名）。
//   ② 原型的硬判据是手抄的 deb 表：它要求 `libsqlite3-dev`，而本仓 CI 不装它、构建也不用它
//      （桌面走 `bundled-sqlcipher`）⇒ 照抄进仓第一条 push 就会红。所以本门禁的硬判据
//      **只能来自 CI 配方本身**；第 1 个用例在进程内校验这条不变量（硬判据 ⊆ CI 配方里的包）。
//
// 变异注入（都写在脚本头部，生产环境不要设）：
//   `SHUYONOTE_SYSDEPS_FAKE_DPKG`      —— 用一个假 dpkg 脚本替掉 `dpkg-query`，
//                                        让"deb 实查"这条路在 macOS 上也能跑起来
//   `SHUYONOTE_SYSDEPS_FAKE_MISSING`   —— 指定某个包"就算装了也当没装"（复现 2026-09-17 事故）
//   `SHUYONOTE_SYSDEPS_FAKE_PROBE_FAIL`—— 强制某条 macOS 工具链探针失败

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { CI_RECIPE, DARWIN_PROBES, MAP, parseLock, readCiRecipe } from "./check-sys-deps.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "check-sys-deps.mjs");
const lockPath = join(root, "src-tauri", "Cargo.lock");
const scanned = parseLock(readFileSync(lockPath, "utf8")).filter((p) => p.name.endsWith("-sys"));

const tmp = mkdtempSync(join(tmpdir(), "shuyonote-sysdeps-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// 假 dpkg：`--version` 要能答（门禁靠它判断"这台机器能不能实查"），查询一律答"已装"。
const fakeDpkg = join(tmp, "fake-dpkg.mjs");
writeFileSync(
  fakeDpkg,
  [
    "const args = process.argv.slice(2);",
    'if (args.includes("--version")) { console.log("dpkg-query 1.22.0 (fake)"); process.exit(0); }',
    'console.log("install ok installed");',
    "",
  ].join("\n"),
);

function runWith(env, ...args) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || ""), stderr: String(err.stderr || "") };
  }
}

function run(...args) {
  return runWith({ SHUYONOTE_SYSDEPS_FAKE_DPKG: fakeDpkg }, ...args);
}

describe("check-sys-deps 判据表的不变量（进程内，不跑任何命令）", () => {
  it("硬判据只能来自 CI 配方：MAP 里每个硬包都必须能在 ci.yml 的 Linux system deps 步里找到", () => {
    const recipe = readCiRecipe();
    expect(recipe.ok, recipe.reason).toBe(true);
    expect(recipe.debs.length).toBeGreaterThanOrEqual(CI_RECIPE.minDebs);
    const bogus = [];
    for (const [crate, entry] of Object.entries(MAP)) {
      expect(entry.why, `${crate} 没写 why`).toBeTruthy();
      for (const deb of entry.debs || []) {
        if (!recipe.debs.includes(deb)) bogus.push(`${crate} → ${deb}`);
      }
      for (const [deb, why] of Object.entries(entry.soft || {})) {
        expect(why, `${crate} 的弱判据 ${deb} 没写理由`).toBeTruthy();
        if ((entry.debs || []).includes(deb)) bogus.push(`${crate} 的 ${deb} 同时算硬判据和弱判据`);
      }
    }
    // 这条断言挡的是 AMD 原型那版的第一条 push 就红：它要求的 libsqlite3-dev 本仓 CI 根本不装。
    expect(bogus, `这些硬判据在 CI 配方里找不到，要么补依据、要么标成 soft：${bogus.join(", ")}`).toEqual([]);
  });

  it("本仓锁文件里每个 *-sys crate 都已登记（新依赖进来必须补表）", () => {
    const missing = scanned.filter((c) => !MAP[c.name]).map((c) => `${c.name} ${c.version}`);
    expect(missing, `未登记：${missing.join(", ")}`).toEqual([]);
  });

  it("「本仓不走系统库」的声明带机器可查依据，且依据仍然成立", () => {
    const withCitation = Object.entries(MAP).filter(([, e]) => e.citation);
    expect(withCitation.length).toBeGreaterThan(0);
    for (const [crate, entry] of withCitation) {
      const text = readFileSync(join(root, entry.citation.file), "utf8");
      expect(text.includes(entry.citation.pattern), `${crate} 的 citation 已过期：${entry.citation.file} 里没有 ${entry.citation.pattern}`).toBe(true);
      expect(entry.citation.why).toBeTruthy();
    }
  });

  it("macOS 工具链探针表非空、id 唯一、每条都写了理由", () => {
    expect(DARWIN_PROBES.length).toBeGreaterThan(0);
    expect(new Set(DARWIN_PROBES.map((p) => p.id)).size).toBe(DARWIN_PROBES.length);
    for (const p of DARWIN_PROBES) {
      expect(p.cmd[0], `${p.id} 没有命令`).toBeTruthy();
      expect(p.why, `${p.id} 没写理由`).toBeTruthy();
    }
  });
});

describe("check-sys-deps 端到端（真脚本、真锁文件、假 dpkg）", () => {
  it("本仓默认跑：登记齐全 + deb 实查（假 dpkg 说全装了）+ 本机工具链探针 ⇒ exit 0", () => {
    const r = run();
    expect(r.stdout).toContain(`已登记 ${scanned.length} 个`);
    // 关键：走了**实查**这条路，而不是被静默跳过
    expect(r.stdout).toContain("✅ Linux deb 实查：全部就位");
    expect(r.stdout).not.toContain("⏭ Linux deb 实查");
    expect(r.stdout).toContain("✅ 全部通过（exit=0）");
    expect(r.code).toBe(0);
  });

  it("变异①：未登记的 *-sys crate ⇒ exit 3 并点名（原型在这里是绿的）", () => {
    const mutated = join(tmp, "lock-with-stranger.lock");
    writeFileSync(
      mutated,
      `${readFileSync(lockPath, "utf8")}\n[[package]]\nname = "acme-native-sys"\nversion = "0.1.0"\n`,
    );
    const r = run("--checks", "registration", "--lock", mutated);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("acme-native-sys");
    expect(r.stdout).toContain("未登记的 *-sys crate");
  });

  it("变异②：把 libssl-dev 当成没装 ⇒ exit 1、点名 openssl-sys、给出 apt 命令（复现 2026-09-17 事故）", () => {
    const r = runWith(
      { SHUYONOTE_SYSDEPS_FAKE_DPKG: fakeDpkg, SHUYONOTE_SYSDEPS_FAKE_MISSING: "libssl-dev" },
      "--checks",
      "registration,deb",
    );
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("openssl-sys");
    expect(r.stdout).toContain("apt-get install -y libssl-dev");
    expect(r.stdout).toContain("缺系统包（exit=1）");
  });

  it("变异③：强制一条 macOS 工具链探针失败 ⇒ exit 4（复现 Xcode 27 许可未接受那次）", () => {
    const r = runWith({ SHUYONOTE_SYSDEPS_FAKE_PROBE_FAIL: "notarytool" }, "--checks", "toolchain");
    // 探针表按平台分派：非 macOS 上这里会打印"未做"，那就不该有 exit 4。
    if (process.platform === "darwin") {
      expect(r.code).toBe(4);
      expect(r.stdout).toContain("❌ notarytool");
      expect(r.stdout).toContain("❌ 工具链探针失败（exit=4）");
    } else {
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("⏭ macOS 工具链探针");
    }
  });

  it("--json 报告可解析，且带机器可读的 exit 与行数", () => {
    const r = run("--json");
    const report = JSON.parse(r.stdout);
    expect(report.exit).toBe(0);
    expect(report.rows.length).toBe(scanned.length);
    expect(report.platform).toBe(process.platform);
  });
});
