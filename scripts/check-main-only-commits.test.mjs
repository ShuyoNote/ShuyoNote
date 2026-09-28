// `check-main-only-commits` 的**自测**：把"这条判据到底抓什么、不抓什么"变成机器可查的。
//
// 为什么要有它：这条判据的**豁免**比判据本身更容易写坏 ——
//   · 豁免写太松（"凡 merge 都放过"）⇒ 谁把一条开发线没有的分支合进 main 都不会红；
//   · 豁免写太紧（"凡动过非源码文件就红"）⇒ 每次正常发布都被挡住，很快没人看它。
// 所以这里正向、反向、以及两条"判不了"的路都要断言。
//
// 另外钉住一张**会漂的表**：`RELEASE_ARTIFACTS` 必须覆盖 `check-versions.mjs` 认的每一处
// （它加了第 8 处而这里没同步 ⇒ 正常发布会开始假红，且没人知道为什么）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { check, foreignFiles, isReleaseOnly, RELEASE_ARTIFACTS } from "./check-main-only-commits.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * 造一个最小的双线仓库：`main`（发布线）＋ `dev`（开发线），共用起点 A。
 * 默认形状：dev 比 main 多一笔源码提交；main 比 dev 多一笔**纯发布**提交。
 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "shuyo-main-only-"));
  dirs.push(dir);
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (rel, text) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  const commit = (msg) => {
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };

  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  write("package.json", JSON.stringify({ name: "x", version: "1.0.0" }, null, 2) + "\n");
  write("CHANGELOG.md", "# 更新日志\n\n## [Unreleased]\n\n- 起手\n\n## [1.0.0] - 2026-01-01\n");
  write("src/app.ts", "export const a = 1;\n");
  commit("chore: 起点");
  git("branch", "dev");

  // 开发线：一笔源码改动（main 永远拿不到，除非回合）
  git("checkout", "-q", "dev");
  write("src/app.ts", "export const a = 2;\n");
  commit("feat: 开发线的活");

  // 发布线：一笔**只动发布产物**的提交
  git("checkout", "-q", "main");
  write("package.json", JSON.stringify({ name: "x", version: "1.0.1" }, null, 2) + "\n");
  write("CHANGELOG.md", "# 更新日志\n\n## [Unreleased]\n\n## [1.0.1] - 2026-01-02\n\n## [1.0.0] - 2026-01-01\n");
  commit("release: 1.0.1");

  return { dir, git, write, commit };
}

function run(args) {
  const errs = [];
  const logs = [];
  const code = check({ ...args, log: (m) => logs.push(String(m)), err: (m) => errs.push(String(m)) });
  return { code, errs: errs.join("\n"), logs: logs.join("\n") };
}

describe("foreignFiles / isReleaseOnly（纯函数）", () => {
  it("只动发布产物 ⇒ 是发布动作", () => {
    expect(isReleaseOnly(["package.json", "CHANGELOG.md", "README.md"])).toBe(true);
    expect(foreignFiles(["package.json", "CHANGELOG.md"])).toEqual([]);
  });

  it("动了任何非发布产物 ⇒ 不是", () => {
    expect(isReleaseOnly(["package.json", "src/app.ts"])).toBe(false);
    expect(foreignFiles(["package.json", "src/app.ts", "docs/plans/x.md"])).toEqual(["src/app.ts", "docs/plans/x.md"]);
  });

  it("**空文件集不算发布动作**（空提交不该被当成「干净的发布」蒙过去）", () => {
    expect(isReleaseOnly([])).toBe(false);
  });
});

describe("RELEASE_ARTIFACTS（这张表不许漂）", () => {
  it("覆盖 check-versions.mjs 认的**每一处**（它加了第 8 处而这里没同步 ⇒ 正常发布会开始假红）", () => {
    const src = readFileSync(resolve(here, "check-versions.mjs"), "utf8");
    const places = [...src.matchAll(/read\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(places.length, "没扫到 check-versions 的版本落点，正则可能失效了").toBeGreaterThanOrEqual(7);
    expect(places.filter((p) => !RELEASE_ARTIFACTS.includes(p)), "check-versions 认的落点没进 RELEASE_ARTIFACTS").toEqual([]);
  });

  it("就是实测的那 8 个（不许被悄悄删项）", () => {
    expect([...RELEASE_ARTIFACTS].sort()).toEqual(
      [
        "CHANGELOG.md",
        "README.md",
        "docs/README.md",
        "docs/SHUYONOTE_STATE.md",
        "package.json",
        "src-tauri/Cargo.lock",
        "src-tauri/Cargo.toml",
        "src-tauri/tauri.conf.json",
      ].sort(),
    );
  });
});

describe("check（真仓库上跑）", () => {
  it("只多一笔**纯发布**提交 ⇒ 0", () => {
    const { dir } = makeRepo();
    const r = run({ cwd: dir, main: "main", dev: "dev" });
    expect(r.code).toBe(0);
    expect(r.logs).toContain("纯发布动作");
  }, 30000);

  it("**发布线上落了一笔内容改动 ⇒ 1**（`a3cbd44a` / `64a415a1` 的形状）", () => {
    const { dir, write, commit } = makeRepo();
    write("src/leak.ts", "export const oops = 1;\n");
    commit("fix: 直接提交在发布线上的修复");
    const r = run({ cwd: dir, main: "main", dev: "dev" });
    expect(r.code).toBe(1);
    expect(r.errs).toContain("src/leak.ts");
  }, 30000);

  it("**标题写着 `release:` 但夹带了源码 ⇒ 照样 1**（`686d0480` 的形状：别只看标题判）", () => {
    const { dir, write, commit } = makeRepo();
    write("src/lib/mdPreview.ts", "export const nodes = [];\n");
    write("package.json", JSON.stringify({ name: "x", version: "1.0.2" }, null, 2) + "\n");
    commit("release: 1.0.2（版本号 bump + 顺手修一个 bug）");
    const r = run({ cwd: dir, main: "main", dev: "dev" });
    expect(r.code).toBe(1);
    expect(r.errs).toContain("src/lib/mdPreview.ts");
  }, 30000);

  it("**把开发线合进发布线 ⇒ 0**（这是发布线该承接的动作）", () => {
    const { dir, git } = makeRepo();
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "merge: dev -> main", "dev");
    const r = run({ cwd: dir, main: "main", dev: "dev" });
    expect(r.code).toBe(0);
    expect(r.logs).toContain("合并 1 笔");
  }, 30000);

  it("**合进一条开发线没有的分支 ⇒ 1**（merge 豁免不是「凡 merge 都放过」）", () => {
    const { dir, git, write, commit } = makeRepo();
    // `side` 只动发布产物 ⇒ 它自己那笔会被放行，能**单独**暴露 merge 那条规则。
    // ⚠️ 必须挑一个 main 那笔发布**没碰过**的发布产物（这里是 README.md）：
    //    两边都改 package.json 的话会**真冲突**，那测的就是 git 的冲突处理，不是这条判据了。
    git("checkout", "-q", "-b", "side", "main~1");
    write("README.md", "# x\n\nversion-1.0.9-\n");
    commit("release: 1.0.9（在旁支上）");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "merge: side -> main", "side");
    const r = run({ cwd: dir, main: "main", dev: "dev" });
    expect(r.code).toBe(1);
    expect(r.errs).toContain("合并进来了开发线上没有的分支");
  }, 30000);

  it("**浅克隆 ⇒ 3（判不了），不是 0** —— 残缺的祖先图上 `rev-list A..B` 会静默给偏少的答案", () => {
    const { dir, write, commit } = makeRepo();
    write("x.txt", "after\n");
    commit("after");
    const shallow = mkdtempSync(join(tmpdir(), "shuyo-main-only-shallow-"));
    dirs.push(shallow);
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${dir}`, shallow], { stdio: ["ignore", "pipe", "pipe"] });
    const r = run({ cwd: shallow, main: "origin/main", dev: "origin/dev" });
    expect(r.code).toBe(3);
    expect(r.errs).toContain("浅克隆");
    expect(r.errs).toContain("--unshallow");
  }, 30000);

  it("缺 ref ⇒ 3（「没查到违规」不是证据）", () => {
    const { dir } = makeRepo();
    const r = run({ cwd: dir, main: "origin/main", dev: "origin/dev" });
    expect(r.code).toBe(3);
    expect(r.errs).toContain("判不了");
  }, 30000);

  it("不是 git 仓库 ⇒ 3", () => {
    const dir = mkdtempSync(join(tmpdir(), "shuyo-main-only-nogit-"));
    dirs.push(dir);
    const r = run({ cwd: dir, main: "main", dev: "dev" });
    expect(r.code).toBe(3);
  }, 30000);
});
