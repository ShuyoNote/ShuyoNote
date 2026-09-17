// `scripts/fetch-pdfium.mjs` 的跨平台路径判据。
//
// 为什么需要它（2026-09-17 在 Mac 上实测到的真 bug）：
// 脚本里原本是 `join(outDir, spec.lib.replace(/\//g, "\\"))` —— 把**包内**的 POSIX 路径
// （`lib/libpdfium.dylib`）里的斜杠换成反斜杠。Windows 上恰好是对的，于是这个写法一路跟着过：
//   · macOS/Linux 上得到的是带**字面反斜杠**的路径 `…/mac-univ/lib\libpdfium.dylib`；
//   · `existsSync` 恒假 ⇒ 收尾打印「完成：…（0 字节）」（真实文件 15,219,824 字节）；
//   · `--check` 更糟：会直接报"缺少 … 先跑一次 fetch"，把已经就位的环境判成没装。
// 这类"只在一个平台上露头的路径 bug"必须由**判据**钉住，而不是靠谁记得。

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(root, "scripts", "fetch-pdfium.mjs");
const src = readFileSync(scriptPath, "utf8");

describe("fetch-pdfium：包内路径不许被改写成 Windows 分隔符", () => {
  it("脚本里不出现 `replace(/\\//g, \"\\\\\")` 这种把 / 换成 \\ 的写法", () => {
    expect(src).not.toMatch(/replace\(\/\\\/\/g,\s*"\\\\\\\\"\s*\)/);
    // 反向确认：现在用的应当是 join(outDir, spec.lib)
    expect(src).toMatch(/join\(outDir,\s*spec\.lib\)/);
  });

  it("本机已取过 pdfium 时，`--check` 必须认得出来（而不是报「缺少」）", () => {
    // 这条在没取过 pdfium 的环境（例如干净的 CI）里跳过——它不是"必须联网"的测试，
    // 而是"一旦取了，就必须认得出来"的回归判据。
    const platform = process.platform === "darwin" ? "mac-univ" : process.platform === "linux" ? "linux-x64" : null;
    if (!platform) return;
    const lib = platform === "mac-univ" ? "lib/libpdfium.dylib" : "lib/libpdfium.so";
    const libPath = join(root, "src-tauri", "vendor", "pdfium", platform, lib);
    if (!existsSync(libPath)) return; // 没取过 ⇒ 跳过（见上面的说明）

    const out = execFileSync(process.execPath, ["scripts/fetch-pdfium.mjs", "--platform", platform, "--check"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(out).toContain(`就位：${libPath}`);
    expect(out).not.toMatch(/缺少/);
    // 顺带断言报出来的字节数与磁盘一致（0 字节就是那条 bug 的症状）
    const realSize = readFileSync(libPath).length;
    expect(out).toContain(`${realSize} 字节`);
    expect(realSize).toBeGreaterThan(1_000_000);
  });
});
