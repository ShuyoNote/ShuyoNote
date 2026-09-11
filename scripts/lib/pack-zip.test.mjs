// 插件包（zip）打包的**跨平台**门禁。
//
// 为什么值得单独一个测试文件：这里踩过的两个坑，**表现都离原因很远**——
//
//   1. 原来 shell out 到命令行 `zip`：在 macOS/Linux 好好的，**Windows 上没有这个命令**，
//      于是工具直接崩（`spawnSync zip ENOENT`）。而它连带让 `plugin-fragment.test.mjs`
//      里三条用例红，其中「找不到插件目录」那条最坑：它期待的是"没找到插件目录"的提示，
//      实际先死在 zip 上，于是**那条断言永远测不到它本该测的东西**；
//   2. 同一类问题的第二次出现：`expand()` 里还有一处 `ls -1`，同一个 ENOENT 形状。
//
// 所以这里钉的不是"zip 打得好不好"（那由 `plugin-fragment.test.mjs` 与应用真正的
// 解析器在管），而是**"不许再依赖系统命令"**与两条影响 `sha256` 的口径。
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { FIXED_MTIME, packDirToZip } from "./pack-zip.mjs";

/** 造一个插件目录现场（含子目录、`.DS_Store`、一个中文文件名）。 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "packzip-"));
  const plugin = join(dir, "my-plugin");
  mkdirSync(join(plugin, "lib"), { recursive: true });
  writeFileSync(join(plugin, "manifest.json"), JSON.stringify({ id: "my-plugin", version: "1.0.0" }), "utf8");
  writeFileSync(join(plugin, "main.js"), "register({});\n", "utf8");
  writeFileSync(join(plugin, "lib", "util.js"), "export const a = 1;\n", "utf8");
  writeFileSync(join(plugin, "说明.txt"), "中文文件名\n", "utf8");
  // macOS 的目录元数据：不该进发布包（等价于原来 `zip -x '*.DS_Store'`）
  writeFileSync(join(plugin, ".DS_Store"), "junk", "utf8");
  return { dir, plugin, zipPath: join(dir, "out.zip") };
}

describe("packDirToZip（跨平台打包）", () => {
  it("包内根目录是插件目录名，条目名一律用 `/`（Windows 上不能是反斜杠）", () => {
    const { plugin, zipPath } = fixture();
    packDirToZip(plugin, zipPath);

    const entries = Object.keys(unzipSync(readFileSync(zipPath)));
    expect(entries.sort()).toEqual(
      ["my-plugin/.DS_Store", "my-plugin/lib/util.js", "my-plugin/main.js", "my-plugin/manifest.json", "my-plugin/说明.txt"]
        .filter((e) => !e.includes(".DS_Store"))
        .sort(),
    );
    // 这条是最容易在 Windows 上悄悄坏掉的：`path.relative()` 给的是 `\`，
    // 直接写进 zip 会变成"文件名里带反斜杠"的条目，在别的平台上解不出来。
    for (const e of entries) {
      expect(e).not.toContain("\\");
    }
  });

  it("跳过 .DS_Store（macOS 元数据不该进发布包）", () => {
    const { plugin, zipPath } = fixture();
    packDirToZip(plugin, zipPath);
    expect(Object.keys(unzipSync(readFileSync(zipPath)))).not.toContain("my-plugin/.DS_Store");
  });

  it("**可复现**：同样的输入两次打包字节完全相同（sha256 才能当防篡改用）", () => {
    // 这条盯的是 mtime：若把"打包那一刻"写进 zip，两次之间就会差一字节，
    // 而索引里的 size/sha256 是给用户端逐字节校验的（对不上直接拒装）。
    const a = fixture();
    const b = fixture();
    packDirToZip(a.plugin, a.zipPath);
    packDirToZip(b.plugin, b.zipPath);
    // 两个现场在不同目录下建的同名插件：包内路径一致 ⇒ 字节应当一致。
    expect(readFileSync(a.zipPath).equals(readFileSync(b.zipPath))).toBe(true);
  });

  it("mtime 是**固定常量**（不是当下），且不早于 zip 能表示的 1980-01-01", () => {
    // 传 0 / new Date(0) 会被 fflate 以 `date not in range 1980-2099` 拒掉（踩过一次），
    // 所以这里钉住"它是一个固定且合法的时刻"，免得有人顺手改成 0。
    expect(FIXED_MTIME).toBeInstanceOf(Date);
    expect(FIXED_MTIME.getTime()).toBe(Date.UTC(2020, 0, 1, 0, 0, 0));
    expect(FIXED_MTIME.getTime()).toBeGreaterThan(Date.UTC(1980, 0, 1));
    // 与"现在"无关：这正是可复现的前提。
    expect(Math.abs(Date.now() - FIXED_MTIME.getTime())).toBeGreaterThan(365 * 24 * 3600 * 1000);
  });

  it("空目录会被拒（不产出一个空包当成插件发出去）", () => {
    const dir = mkdtempSync(join(tmpdir(), "packzip-empty-"));
    mkdirSync(join(dir, "empty-plugin"));
    expect(() => packDirToZip(join(dir, "empty-plugin"), join(dir, "o.zip"))).toThrow(/空/);
  });

  it("产出的是**能被 fflate 解开**的正常 zip（不是空文件/半截文件）", () => {
    const { plugin, zipPath } = fixture();
    packDirToZip(plugin, zipPath);
    expect(statSync(zipPath).size).toBeGreaterThan(0);
    const got = unzipSync(readFileSync(zipPath));
    expect(new TextDecoder().decode(got["my-plugin/manifest.json"])).toContain("my-plugin");
  });
});
