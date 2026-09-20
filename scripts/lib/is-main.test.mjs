// `is-main.mjs` 的判据：它守的是"门禁**静默空转**"这类失败（脚本什么都没做、退出码 0）。
//
// ⚠️ **本仓（应用仓）`scripts/**/*.test.mjs` 一律 vitest 风格**（`describe/it/expect from "vitest"`）；
//    另有 `node --test` 风格的那套在**信箱仓**（`shuyo-collab/tools/*.test.mjs`）。
//    2026-09-20 我第一版写成 `node:test` ⇒ vitest **收不到用例**（文件 0 test）⇒ 门禁红。
//    两个仓两套 runner，写测试前先看**这个仓**的邻居文件。
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalPath, isMain } from "./is-main.mjs";

describe("isMain：同一路径 / 不同文件 / 没有 argv[1]", () => {
  const url = pathToFileURL(resolve("scripts/lib/is-main.mjs")).href;

  it("相对路径与绝对路径都认得出来", () => {
    expect(isMain(url, "scripts/lib/is-main.mjs")).toBe(true);
    expect(isMain(url, resolve("scripts/lib/is-main.mjs"))).toBe(true);
  });

  it("别的文件 ⇒ false", () => {
    expect(isMain(url, "scripts/check-versions.mjs")).toBe(false);
  });

  it("没有 argv[1]（被 import 时）⇒ false", () => {
    expect(isMain(url, undefined)).toBe(false);
    expect(isMain(url, "")).toBe(false);
  });
});

describe("isMain：路径经过符号链接", () => {
  // ★ 承重判据：老写法 `resolve(argv1) === resolve(fileURLToPath(metaUrl))` 在这里**恒为假**
  //   ⇒ 脚本静默空转、退出码 0（2026-09-20 实测：macOS `/tmp` → `/private/tmp`；
  //   同一份门禁，真实路径调用会打印"未实查"，符号链接绝对路径调用则**零输出**）。
  it("符号链接路径指向同一个文件 ⇒ 仍然 true", () => {
    const dir = mkdtempSync(join(tmpdir(), "ismain-"));
    const real = join(dir, "real");
    const link = join(dir, "link");
    let linked = true;
    try {
      mkdirSync(real);
      symlinkSync(real, link, "dir");
    } catch {
      linked = false; // 平台不允许建符号链接（Windows 无权限）：自报跳过，不假装通过
    }
    if (!linked) {
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    const viaReal = join(real, "mod.mjs");
    const viaLink = join(link, "mod.mjs");
    // ⚠️ 文件必须**真的存在**：`realpathSync` 只能解析存在的路径（运行时它当然存在）。
    writeFileSync(viaReal, "// 占位\n");
    expect(isMain(pathToFileURL(viaReal).href, viaLink)).toBe(true);
    expect(canonicalPath(viaLink)).toBe(canonicalPath(viaReal));
    rmSync(dir, { recursive: true, force: true });
  });
});
