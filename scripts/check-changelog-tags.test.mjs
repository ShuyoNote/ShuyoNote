// `check-changelog-tags` 的**自测**：把"这条判据到底抓什么、不抓什么"变成机器可查的。
//
// 为什么要有它：这条判据的**基线**极容易写错方向 —— 我第一版就是拿"当前 checkout 的 CHANGELOG"
// 去比 tag，结果报出 4 个假缺失（真因：发布提交切在 `main`、`dev` 台账本来就落后。
// 详见 `check-changelog-tags.mjs` 头部）。所以这里两类断言都要有：
//   · **正向**：tag 打在台账陈旧的提交上 ⇒ 必须红（这正是 2026-08-31 `v1.64.10…16` 的形状）；
//   · **反向**：台账齐全 ⇒ 必须绿；`latest` 这类**浮标 tag** 不许被当成违规；
//   · **判不了**：一个版本 tag 都看不见（浅克隆 / 没取 tag）⇒ 必须是 **3**，**不是 0** ——
//     "什么都没看见" 与 "查过并全部通过" 在输出上不许长得一样；
//   · **豁免名单不许腐烂**：名单里的 tag 不见了、或它其实已经自带段头 ⇒ 红，逼人回去删那一条。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { check, hasEntry, KNOWN_GAPS, RELEASE_TAG, topVersion } from "./check-changelog-tags.mjs";

const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** 造一个**最小的**仓库：只放这条判据看得见的东西（一个 `CHANGELOG.md` ＋ 若干 tag）。 */
function makeRepo({ tags = true, init = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shuyo-changelog-tags-"));
  dirs.push(dir);
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (rel, text) => {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  };
  if (init) {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    write("CHANGELOG.md", "# 更新日志\n\n## [Unreleased]\n\n- 起手\n\n## [1.0.0] - 2026-01-01\n\n- 首版\n");
    git("add", "-A");
    git("commit", "-q", "-m", "release: 1.0.0");
    // ★ 关键形状：`v1.0.0` 打在一个**确实自带 1.0.0 段头**的提交上。
    if (tags) git("tag", "v1.0.0");
  }
  return { dir, git, write };
}

/** 跑判据，拿 `{code, errs, logs}` —— 不 spawn，直接调，快且好断言。
 *
 * ⚠️ 默认把豁免名单**换成空的**：本仓那份 `KNOWN_GAPS` 里的 8 个 tag 在合成仓库里一个都不存在，
 *    不换的话每条断言都会被"豁免名单里的 tag 不见了"顶成 1（真实理由，不是测试噪声）。
 *    本仓那份名单本身由最后一组用例单独钉。 */
function run({ knownGaps = new Map(), ...args }) {
  const errs = [];
  const logs = [];
  const code = check({ ...args, knownGaps, log: (m) => logs.push(String(m)), err: (m) => errs.push(String(m)) });
  return { code, errs: errs.join("\n"), logs: logs.join("\n") };
}

describe("hasEntry（段头判定）", () => {
  it("认得行首的 `## [x.y.z]`", () => {
    expect(hasEntry("# c\n\n## [1.2.3] - 2026-01-01\n\n- a\n", "1.2.3")).toBe(true);
    expect(hasEntry("# c\n\n##   [1.2.3]\n", "1.2.3")).toBe(true); // 空档无所谓
  });

  it("**不**把正文里提到版本号当成段头", () => {
    expect(hasEntry("# c\n\n- 参见 `## [1.2.3]` 那段\n", "1.2.3")).toBe(false);
    expect(hasEntry("# c\n\n### [1.2.3]\n", "1.2.3")).toBe(false); // 三级标题不是版本节
  });

  it("**不**把前缀相同的版本号误判成命中（1.2.3 vs 1.2.30）", () => {
    expect(hasEntry("# c\n\n## [1.2.30] - 2026-01-01\n", "1.2.3")).toBe(false);
    expect(hasEntry("# c\n\n## [1.2.3] - 2026-01-01\n", "1.2.3")).toBe(true);
  });

  it("空文本 ⇒ false（tag 的树里没有这个文件时走的就是这条路）", () => {
    expect(hasEntry(null, "1.2.3")).toBe(false);
    expect(hasEntry("", "1.2.3")).toBe(false);
  });
});

describe("topVersion（树顶格读数）", () => {
  it("取首个**已发布**版本段头，`Unreleased` 不算", () => {
    expect(topVersion("## [Unreleased]\n\n- a\n\n## [1.64.10] - 2026-08-31\n")).toBe("1.64.10");
  });

  it("没有已发布节 ⇒ null（不是空串、不是 0）", () => {
    expect(topVersion("## [Unreleased]\n\n- a\n")).toBeNull();
    expect(topVersion(null)).toBeNull();
  });
});

describe("RELEASE_TAG（哪些 tag 参与审计）", () => {
  it("`v1.2.3` 是；`latest`（浮标）不是", () => {
    expect(RELEASE_TAG.test("v1.2.3")).toBe(true);
    expect(RELEASE_TAG.test("latest")).toBe(false);
    expect(RELEASE_TAG.test("v1.2")).toBe(false);
    expect(RELEASE_TAG.test("v1.2.3-rc1")).toBe(false);
    expect(RELEASE_TAG.test("1.2.3")).toBe(false);
  });
});

describe("check（真仓库上跑）", () => {
  it("台账齐全 ⇒ 0", () => {
    const { dir } = makeRepo();
    const r = run({ cwd: dir });
    expect(r.code).toBe(0);
    expect(r.logs).toContain("自带本版台账段头");
  }, 30000);

  it("**tag 打在台账陈旧的提交上 ⇒ 1**（2026-08-31 `v1.64.10…16` 的形状：版本号 bump 了、段没写）", () => {
    const { dir, git } = makeRepo();
    git("tag", "v1.0.1"); // 树顶格还停在 1.0.0
    const r = run({ cwd: dir });
    expect(r.code).toBe(1);
    expect(r.errs).toContain("v1.0.1");
    expect(r.errs).toContain("树顶格是 `1.0.0`");
  }, 30000);

  it("**`latest` 这类浮标 tag 不算违规**（它跟着最新发布走，不是版本）", () => {
    const { dir, git } = makeRepo();
    git("tag", "latest");
    const r = run({ cwd: dir });
    expect(r.code).toBe(0);
    expect(r.logs).toContain("`latest`");
  }, 30000);

  it("**一个版本 tag 都没有 ⇒ 3（判不了），不是 0** —— 浅克隆/没取 tag 时最危险的那条", () => {
    const { dir } = makeRepo({ tags: false });
    const r = run({ cwd: dir });
    expect(r.code).toBe(3);
    expect(r.errs).toContain("判不了");
  }, 30000);

  it("不是 git 仓库 ⇒ 3", () => {
    const { dir } = makeRepo({ init: false });
    const r = run({ cwd: dir });
    expect(r.code).toBe(3);
  }, 30000);

  it("浅克隆（`--depth 1`）⇒ 3，且把 `fetch-depth: 0` 这条出路说出来", () => {
    const { dir, git, write } = makeRepo();
    // ⚠️ 必须让 **tip 不带 tag**：`git clone --depth 1` 仍会取来"指向被下载对象"的 tag，
    //    所以若 HEAD 恰好就是 `v1.0.0`，浅克隆里会有 1 个 tag ⇒ 走的就不是"零 tag"那条路。
    //    真实 CI 正是本测试的形状：被检出的那个 tip（dev 的 HEAD）没有 tag。
    write("x.txt", "after\n");
    git("add", "-A");
    git("commit", "-q", "-m", "after");
    const shallow = mkdtempSync(join(tmpdir(), "shuyo-changelog-tags-shallow-"));
    dirs.push(shallow);
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${dir}`, shallow], { stdio: ["ignore", "pipe", "pipe"] });
    const r = run({ cwd: shallow });
    expect(r.code).toBe(3);
    expect(r.errs).toContain("浅克隆");
    expect(r.errs).toContain("fetch-depth: 0");
  }, 30000);

  it("登记进豁免名单 ⇒ 0（历史遗留只登记、**不补写**）", () => {
    const { dir, git } = makeRepo();
    git("tag", "v1.0.1");
    const r = run({ cwd: dir, knownGaps: new Map([["1.0.1", "测试用：当时读数 1.0.0"]]) });
    expect(r.code).toBe(0);
    expect(r.logs).toContain("历史豁免");
  }, 30000);

  it("**豁免名单不许腐烂 —— 条目已自带段头 ⇒ 1**", () => {
    const { dir } = makeRepo();
    const r = run({ cwd: dir, knownGaps: new Map([["1.0.0", "早就不成立了"]]) });
    expect(r.code).toBe(1);
    expect(r.errs).toContain("已经自带段头");
  }, 30000);

  it("**豁免名单不许腐烂 —— 条目指向的 tag 不存在 ⇒ 1**", () => {
    const { dir } = makeRepo();
    const r = run({ cwd: dir, knownGaps: new Map([["9.9.9", "这个 tag 根本没有"]]) });
    expect(r.code).toBe(1);
    expect(r.errs).toContain("没有这个 tag");
  }, 30000);
});

describe("本仓的豁免名单（防止它被悄悄改坏）", () => {
  it("记的是 2026-08-31 那一批 ＋ `1.0.0`，且**不含**后来那些已发布版本", () => {
    expect([...KNOWN_GAPS.keys()]).toEqual([
      "1.0.0",
      "1.64.10",
      "1.64.11",
      "1.64.12",
      "1.64.13",
      "1.64.14",
      "1.64.15",
      "1.64.16",
    ]);
    // 这个名单**不许长大**：加一条等于承认"又发生了一次"。
    // 2026-09-25 那次误报（1.85.2 / 1.91.4 / 1.91.25 / 1.91.26）**一个都不许**进这里 ——
    // 它们本来就是好的，进名单等于把判据的错方向固化下来。
    for (const v of ["1.85.2", "1.91.4", "1.91.25", "1.91.26"]) {
      expect(KNOWN_GAPS.has(v)).toBe(false);
    }
  });
});
