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
import { execFileSync, spawnSync } from "node:child_process";
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

// 命令行那一层：`android.yml` / `release.yml` 写的是**位置形式**，
// 旧版只认 `--platform` ⇒ 参数被静默吃掉、回落成 runner 的当前平台
// ⇒ 取回 linux-x64，直到下一步 stage 才报「vendor 里没有 android-arm64 的那份库」（2026-09-20 安卓 CI 实红）。
// 这两条钉住"位置形式认得出"与"写错了当场死"，不必联网（都走 `--check` 或解析阶段就退出）。
describe("fetch-pdfium：位置形式的平台名（CI 里那个写法）", () => {
  // ⚠️ `ELECTRON_RUN_AS_NODE=1` 不能省：本仓的测试跑在 Electron 里，`process.execPath` 是
  //    electron 而不是 node —— 少了这个变量，子进程会以"加载 Electron 主进程模块"的方式起来并崩，
  //    表现成"脚本自己 exit 1"，很容易误读成判据真的红了。
  const run = (args) =>
    spawnSync(process.execPath, ["scripts/fetch-pdfium.mjs", ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });

  it("★ `android-arm64 --check` 认的就是 android-arm64，绝不回落成本机平台", () => {
    const r = run(["android-arm64", "--check"]);
    const out = `${r.stdout}${r.stderr}`;
    // 本机取过就是 0（就位），没取过就是 1（缺少）——两种都算"认出来了"
    expect([0, 1]).toContain(r.status);
    expect(out).toContain("android-arm64");
    // ★ 这条是判据的核心：回落的话打印的是本机平台（CI 上就是 linux-x64）
    expect(out).not.toContain("linux-x64");
    expect(out).not.toContain("win-x64");
  });

  it("★ 认不出的平台名 ⇒ exit 2（不许静默换成当前平台）", () => {
    const r = run(["android-arm"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("不支持的平台");
    expect(r.stderr).toContain("android-arm64"); // 可选值列在报错里
  });
});
