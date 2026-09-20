// `check-changelog-version-parity` 的**自测**：把"这条判据到底抓什么、不抓什么"变成机器可查的。
//
// 为什么要它（这仓的既有教训）：判据本身写错方向比没写更坏 —— 它会让"真弄红的人"也学会绕。
// 所以这里既要**正向**（只改已发布标题 ⇒ 必须红），也要**反向**（只动 Unreleased ⇒ 必须绿，
// 否则日常开发每次加一行 CHANGELOG 都会被挡住），还要**merge 的那条路**（`git diff-tree`
// 对 merge 默认什么都不列 ⇒ 不处理就会对正确的合并沉默、或用错参数变成误报）。
//
// 另外留了一条**真事故回归**的说明：这条判据在本仓历史上那笔上跑过（见文件末注释），
// 但那笔不在本仓历史里可复现 ⇒ 单测里用**合成等价形状**，真事故读数写在提交信息与信箱里。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { check, firstPublishedVersion, violatesParity, VERSION_FILES } from "./check-changelog-version-parity.mjs";

const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** 造一个**最小的**仓库：只放这条判据看得见的那几个文件。 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "shuyo-changelog-parity-"));
  dirs.push(dir);
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  write("package.json", JSON.stringify({ name: "x", version: "1.0.0" }, null, 2) + "\n");
  write("src-tauri/Cargo.toml", '[package]\nname = "x"\nversion = "1.0.0"\n');
  write("src-tauri/tauri.conf.json", JSON.stringify({ version: "1.0.0" }, null, 2) + "\n");
  write("CHANGELOG.md", "# 更新日志\n\n## [Unreleased]\n\n- 起手\n");
  return { dir, git, write, commit, head: () => git("rev-parse", "HEAD") };

  function write(rel, text) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  }
  function commit(msg) {
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  }
}

/** 跑判据，拿 `[退出码, stderr 全文]` —— 不 spawn，直接调，快且好断言。 */
function run(args) {
  const errs = [];
  const logs = [];
  const code = check({ ...args, log: (m) => logs.push(String(m)), err: (m) => errs.push(String(m)) });
  return { code, errs: errs.join("\n"), logs: logs.join("\n") };
}

describe("firstPublishedVersion", () => {
  it("取首个**已发布**版本标题（Unreleased 不算）", () => {
    expect(firstPublishedVersion("# c\n\n## [Unreleased]\n\n- a\n\n## [1.2.3] - 2026-01-01\n")).toBe("1.2.3");
    expect(firstPublishedVersion("## [1.2.3] - x\n\n## [1.2.2]\n")).toBe("1.2.3");
  });

  it("只有 Unreleased / 空文本 ⇒ null（⇒ 判据不管它）", () => {
    expect(firstPublishedVersion("## [Unreleased]\n\n- a\n")).toBeNull();
    expect(firstPublishedVersion("")).toBeNull();
    expect(firstPublishedVersion(null)).toBeNull();
  });
});

describe("violatesParity（纯函数四条）", () => {
  const files = (f) => [{ files: f, versionBefore: "1.0.0", versionAfter: "1.1.0" }][0];
  it("已发布标题变了 ＋ 没动版本文件 ⇒ 违规", () => {
    expect(violatesParity(files(["CHANGELOG.md"]))).toBe(true);
  });
  it("已发布标题变了 ＋ 动了版本文件之一 ⇒ 不违规", () => {
    expect(violatesParity(files(["CHANGELOG.md", VERSION_FILES[0]]))).toBe(false);
    expect(violatesParity(files(["CHANGELOG.md", VERSION_FILES[2]]))).toBe(false);
  });
  it("已发布标题**没变**（只动 Unreleased）⇒ 不违规", () => {
    expect(violatesParity({ files: ["CHANGELOG.md"], versionBefore: "1.0.0", versionAfter: "1.0.0" })).toBe(false);
  });
  it("这一笔根本没有已发布标题（例如仓库刚起）⇒ 不违规", () => {
    expect(violatesParity({ files: ["CHANGELOG.md"], versionBefore: null, versionAfter: null })).toBe(false);
  });
});

describe("仓库里跑（判据 ①② 的实测）", () => {
  it("基线（只有 Unreleased）⇒ 绿", () => {
    const { dir, commit } = makeRepo();
    const base = commit("chore: 起手");
    expect(run({ commit: base, cwd: dir }).code).toBe(0);
  });

  it("★ 反向：只往 Unreleased 追加一行 ⇒ **必须绿**（否则日常开发全被挡住）", () => {
    const r = makeRepo();
    const base = r.commit("chore: 起手");
    r.write("CHANGELOG.md", "# 更新日志\n\n## [Unreleased]\n\n- 起手\n- 新功能一行\n");
    const tip = r.commit("feat: 往 Unreleased 加一行");
    expect(run({ range: `${base}..${tip}`, cwd: r.dir }).code).toBe(0);
  });

  it("★ 正向：只改已发布标题、不动版本文件 ⇒ **必须红**，且点名那一笔", () => {
    const r = makeRepo();
    const base = r.commit("chore: 起手");
    r.write("CHANGELOG.md", "# 更新日志\n\n## [Unreleased]\n\n- 起手\n\n## [1.0.0] - 2026-01-01\n\n- 首个版本\n");
    const tip = r.commit("release: 写 1.0.0 那一节（忘了动版本文件）");
    const { code, errs } = run({ range: `${base}..${tip}`, cwd: r.dir });
    expect(code).toBe(1);
    expect(errs).toContain(tip.slice(0, 7));
    expect(errs).toContain("1.0.0");
  });

  it("正向的**配对**：同样的标题变化 ＋ 同时动 package.json ⇒ 绿", () => {
    const r = makeRepo();
    const base = r.commit("chore: 起手");
    // ⚠️ 版本文件必须**真的变**：把 1.0.0 原样再写一遍时 git 看不到改动 ⇒ 判据**仍然红**，
    //    这是对的（它问"动作做没做"，不是"文件在不在"）—— 第一版自测就是这么红的。
    r.write("CHANGELOG.md", "# 更新日志\n\n## [Unreleased]\n\n- 起手\n\n## [1.1.0] - 2026-01-02\n\n- 第二个版本\n");
    r.write("package.json", JSON.stringify({ name: "x", version: "1.1.0" }, null, 2) + "\n");
    const tip = r.commit("release: 写 1.1.0 那一节 + 版本文件");
    expect(run({ range: `${base}..${tip}`, cwd: r.dir }).code).toBe(0);
  });

  it("★ 版本文件**没真的变**（同一内容重写一遍）⇒ 仍然红（判据问的是「动作做没做」）", () => {
    const r = makeRepo();
    const base = r.commit("chore: 起手");
    r.write("CHANGELOG.md", "# 更新日志\n\n## [Unreleased]\n\n- 起手\n\n## [1.0.0] - 2026-01-01\n\n- 首个版本\n");
    r.write("package.json", JSON.stringify({ name: "x", version: "1.0.0" }, null, 2) + "\n"); // 同内容
    const tip = r.commit("release: 标题变了但版本文件内容没变");
    expect(run({ range: `${base}..${tip}`, cwd: r.dir }).code).toBe(1);
  });

  it("★ merge：违规藏在被合进来的分支里 ⇒ 查 **merge 那一笔**也要红（口径 ②）", () => {
    const r = makeRepo();
    const base = r.commit("chore: 起手");
    r.git("checkout", "-q", "-b", "release-line");
    r.write("CHANGELOG.md", "# 更新日志\n\n## [Unreleased]\n\n- 起手\n\n## [1.0.0] - 2026-01-01\n\n- 首个版本\n");
    r.commit("release: 只写 CHANGELOG");
    r.git("checkout", "-q", "main");
    r.git("merge", "-q", "--no-ff", "-m", "merge: release-line -> main", "release-line");
    const merge = r.head();
    const { code, errs } = run({ commit: merge, cwd: r.dir });
    expect(code).toBe(1);
    expect(errs).toContain(merge.slice(0, 7));
    // 顺带钉住："基线..merge" 这一段也看得见它（范围模式与单笔模式结论一致）
    expect(run({ range: `${base}..${merge}`, cwd: r.dir }).code).toBe(1);
  });

  it("merge 但**没碰** CHANGELOG ⇒ 绿（别把正常合并判红）", () => {
    const r = makeRepo();
    r.commit("chore: 起手");
    r.git("checkout", "-q", "-b", "feature");
    r.write("src-tauri/src/lib.rs", "// 无关改动\n");
    r.commit("feat: 无关改动");
    r.git("checkout", "-q", "main");
    r.git("merge", "-q", "--no-ff", "-m", "merge: feature -> main", "feature");
    expect(run({ commit: r.head(), cwd: r.dir }).code).toBe(0);
  });

  it("判不了要显式（不是 git 仓库 ⇒ 3，不许当通过）", () => {
    const dir = mkdtempSync(join(tmpdir(), "shuyo-not-a-repo-"));
    dirs.push(dir);
    expect(run({ commit: "HEAD", cwd: dir }).code).toBe(3);
  });

  it("认不出的 commit ⇒ 3（判不了 ≠ 通过）", () => {
    const r = makeRepo();
    r.commit("chore: 起手");
    expect(run({ commit: "deadbeefdeadbeef", cwd: r.dir }).code).toBe(3);
  });

  it("★ 浅克隆（CI 的 checkout 默认）⇒ 空范围也必须**判不了**（3），不许假绿", () => {
    // 来由：macOS 认为浅克隆会 exit 3（`HEAD^` 不存在）；我按那条加提示时自己一验，
    // 发现**更坏**的一种：浅克隆里 `origin/main` **是存在的**（指向被取到的那一个提交）
    // ⇒ `origin/main..HEAD` 为空 ⇒ 原来会打印"✓ 这 0 笔……"并 exit 0 —— 那就是假绿。
    const r = makeRepo();
    r.commit("chore: 第 1 笔");
    r.write("CHANGELOG.md", "# 更新日志\n\n## [Unreleased]\n\n- 第 2 次\n");
    r.commit("chore: 第 2 笔");

    const shallow = mkdtempSync(join(tmpdir(), "shuyo-shallow-"));
    dirs.push(shallow);
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${r.dir}`, shallow], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const { code, errs, logs } = run({ cwd: shallow, env: {} });
    expect(code).toBe(3);
    expect(errs).toContain("浅克隆");
    expect(errs).toContain("fetch-depth: 0");
    expect(logs).not.toContain("✓");
  });

  it("非浅克隆 + 空范围 ⇒ 0，但措辞必须是「没东西可查」而不是「通过」", () => {
    const r = makeRepo();
    r.commit("chore: 起手");
    const { code, logs } = run({ range: "HEAD..HEAD", cwd: r.dir, env: {} });
    expect(code).toBe(0);
    expect(logs).toContain("没有提交");
    expect(logs).toContain("不是");
  });
});

// 真事故回归（读数是**人工跑的**，因为那笔不在本仓可复现的历史里）：
//   `node scripts/check-changelog-version-parity.mjs --commit 9dfa5a5c`
//   ⇒ 退出 1，点名"已发布标题 1.91.3 ⇒ 1.91.10；本笔改的文件：CHANGELOG.md,
//      src-tauri/capabilities/default.json, src-tauri/src/lib.rs"
//   —— 与 macOS 手工查出来的那笔**逐字一致**（信箱 `2026-09-20-check-versions-red-on-dev.reply-3` §二）。
