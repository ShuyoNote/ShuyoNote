// `scripts/lib/sm-library-patch.mjs` 的判据（**用真的 `git apply`**，但补丁与源码都是临时目录里的小夹具）。
//
// 为什么这些判据存在：这条胶水有三种状态，而**三种都曾被读错**——
//   ① 已经打过补丁时必须 `already`（再打一次 `git apply` 会失败，那是重复动作不是故障）；
//   ② 打完必须**复扫标记**（"退出码 0" ≠ "文件里有那行"，这正是我们一路上在防的那类假绿）；
//   ③ `--no-apply` 时必须 `absent` **且一个字节都不改**（否则"未打补丁的读数"是假的）。
// 真实尺寸的补丁（`patches/0001-…`）不在这里验：它由 `src-tauri/build.rs` 的标记判据 ＋ WSL 上的
// 真实构建读数守着（"能不能编过"不是单测能回答的）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PATCH_MARKER, ensurePatch } from "./sm-library-patch.mjs";

const dirs = [];
function fixture(sourceText, patchText) {
  const dir = mkdtempSync(join(tmpdir(), "sm-patch-test-"));
  dirs.push(dir);
  writeFileSync(join(dir, "sqlite3.c"), sourceText);
  const patch = join(dir, "0001-fixture.patch");
  if (patchText) writeFileSync(patch, patchText);
  return { dir, patch };
}

const PRISTINE = "int x = 1;\n";
const PATCH = [
  "--- a/sqlite3.c",
  "+++ b/sqlite3.c",
  "@@ -1 +1 @@",
  "-int x = 1;",
  `+int x = 2; /* ${PATCH_MARKER} */`,
  "",
].join("\n");

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("ensurePatch", () => {
  it("干净源码 ⇒ applied，且**复扫**确认标记真的落进文件（不只看退出码）", () => {
    const { dir, patch } = fixture(PRISTINE, PATCH);
    const r = ensurePatch(dir, patch);
    expect(r.status).toBe("applied");
    expect(r.tool).toBe("git apply -p1");
    const after = readFileSync(join(dir, "sqlite3.c"), "utf8");
    expect(after).toContain(PATCH_MARKER);
    expect(after).not.toBe(PRISTINE);
  });

  it("已经打过 ⇒ already，**幂等**（第二次不再调用 git，也不报错）", () => {
    const { dir, patch } = fixture(PRISTINE, PATCH);
    expect(ensurePatch(dir, patch).status).toBe("applied");
    const second = ensurePatch(dir, patch);
    expect(second.status).toBe("already");
    expect(second.tool).toBe(null);
  });

  it("apply:false ⇒ absent，且源码**一个字节都没改**（否则'未打补丁的读数'是假的）", () => {
    const { dir, patch } = fixture(PRISTINE, PATCH);
    const r = ensurePatch(dir, patch, { apply: false });
    expect(r.status).toBe("absent");
    expect(readFileSync(join(dir, "sqlite3.c"), "utf8")).toBe(PRISTINE);
  });

  it("源码不是补丁对应的那一份 ⇒ 抛错，且错误里说清是'打不上'（不是静默跳过）", () => {
    const { dir, patch } = fixture("int y = 1;\n", PATCH);
    expect(() => ensurePatch(dir, patch)).toThrow(/打不上/);
    expect(readFileSync(join(dir, "sqlite3.c"), "utf8")).toBe("int y = 1;\n");
  });

  it("补丁文件不存在 ⇒ 抛错（不静默当成 absent）", () => {
    const { dir } = fixture(PRISTINE, null);
    expect(() => ensurePatch(dir, join(dir, "nope.patch"))).toThrow(/找不到补丁文件/);
  });

  it("打上了但**标记不在**（补丁与判据不对应）⇒ 抛错 —— 这条让'复扫标记'成为**承重**判据", () => {
    // 没有这条，"打完复扫标记"就只是句口号：前面几条夹具里标记都真的落进去了，删掉复扫也不会红。
    const patchWithoutMarker = [
      "--- a/sqlite3.c",
      "+++ b/sqlite3.c",
      "@@ -1 +1 @@",
      "-int x = 1;",
      "+int x = 3; /* 一个与判据无关的改动 */",
      "",
    ].join("\n");
    const { dir, patch } = fixture(PRISTINE, patchWithoutMarker);
    expect(() => ensurePatch(dir, patch)).toThrow(/仍然没有/);
    // 文件**确实被改了**（git apply 成功了）—— 所以这条红的不是"补丁没打上"，而是"打上的不是判据要的那份"
    expect(readFileSync(join(dir, "sqlite3.c"), "utf8")).toContain("int x = 3;");
  });
});
