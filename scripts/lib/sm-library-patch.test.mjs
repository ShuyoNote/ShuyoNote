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

import { PATCH_MARKER, ensurePatch, revertPatch } from "./sm-library-patch.mjs";

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
  it("干净源码 ⇒ applied，且**逐字节**等于期望（顺带钉住「git apply 不许改行尾」）", () => {
    const { dir, patch } = fixture(PRISTINE, PATCH);
    const r = ensurePatch(dir, patch);
    expect(r.status).toBe("applied");
    expect(r.tool).toBe("git apply -p1");
    const after = readFileSync(join(dir, "sqlite3.c"), "utf8");
    expect(after).toContain(PATCH_MARKER);
    // ⚠️ 这条是**逐字节**断言：Windows 上 `core.autocrlf=true` 时 `git apply` 会把输出写成 CRLF，
    //    那会让同一份源码在三平台**哈希不同**（`src_sha256` 的跨机比对就废了）——2026-09-20 实测抓到过。
    expect(after).toBe(`int x = 2; /* ${PATCH_MARKER} */\n`);
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

// `revertPatch` 的判据（mac 2026-09-20 提的第 2 条修法：胶水要能撤回）。
// 为什么值得有：那份源码在 cargo registry 里是**全机共享**的一份 —— "能一键回到原版"是做 A/B、
// 以及判"这条红是不是补丁引起的"的前提；而"撤回了"同样要**复扫标记**才算数。
describe("revertPatch", () => {
  it("打上之后能撤回，且标记**真的消失**（不是只看退出码）", () => {
    const { dir, patch } = fixture(PRISTINE, PATCH);
    expect(ensurePatch(dir, patch).status).toBe("applied");
    const r = revertPatch(dir, patch);
    expect(r.status).toBe("reverted");
    expect(r.tool).toBe("git apply -R -p1");
    expect(readFileSync(join(dir, "sqlite3.c"), "utf8")).toBe(PRISTINE);
  });

  it("本来就没打 ⇒ absent（不是错误，也不动文件）", () => {
    const { dir, patch } = fixture(PRISTINE, PATCH);
    const r = revertPatch(dir, patch);
    expect(r.status).toBe("absent");
    expect(readFileSync(join(dir, "sqlite3.c"), "utf8")).toBe(PRISTINE);
  });

  it("打 → 撤 → 再打：**幂等往返**（撤回之后 `ensurePatch` 还能再打上）", () => {
    const { dir, patch } = fixture(PRISTINE, PATCH);
    ensurePatch(dir, patch);
    revertPatch(dir, patch);
    expect(ensurePatch(dir, patch).status).toBe("applied");
    expect(readFileSync(join(dir, "sqlite3.c"), "utf8")).toContain(PATCH_MARKER);
  });
});
