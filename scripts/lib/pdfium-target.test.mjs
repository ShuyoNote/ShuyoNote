// `scripts/lib/pdfium-target.mjs` 的判据：**"取哪个平台"这件事不许静默猜**。
//
// 由来（2026-09-20，安卓 CI 实红）：
//   `android.yml` / `release.yml` 写的是位置形式 `node scripts/fetch-pdfium.mjs android-arm64`，
//   旧版脚本只认 `--platform`，于是位置参数被**静默忽略**、回落成 runner 的当前平台
//   ⇒ 取回 linux-x64，直到下一步 stage 才报「vendor 里没有 android-arm64 的那份库」。
//   下面这一组就是钉住"这件事以后只能当场报错"。
import { describe, expect, it } from "vitest";

import { resolvePlatform } from "./pdfium-target.mjs";

/** 与 `fetch-pdfium.mjs` 的 PLATFORMS 同形的替身：本模块只用到它的**键**（白名单）。 */
const KNOWN = { "win-x64": {}, "win-arm64": {}, "linux-x64": {}, "mac-univ": {}, "android-arm64": {} };
/** 替身"当前系统"：故意选 linux-x64 —— 好让"回落了没有"一眼可辨。 */
const detect = () => "linux-x64";

const run = (argv) => resolvePlatform(argv, { detect, known: KNOWN });

describe("resolvePlatform：位置参数与 --platform 等价", () => {
  it("位置形式 `android-arm64`（两个 workflow 里那个写法）", () => {
    expect(run(["android-arm64"])).toEqual({ platform: "android-arm64" });
  });

  it("`--platform` 形式仍然可用（既有口径不许破）", () => {
    expect(run(["--platform", "win-x64"])).toEqual({ platform: "win-x64" });
  });

  it("两种写法给同一个值时不算冲突", () => {
    expect(run(["--platform", "android-arm64", "android-arm64"])).toEqual({ platform: "android-arm64" });
  });

  it("别的开关不影响解析：`--check` 与 `--print-sha256` 的值都不算平台名", () => {
    expect(run(["android-arm64", "--check"])).toEqual({ platform: "android-arm64" });
    // `--print-sha256` 的值是**文件路径**，绝不能被当成平台名
    expect(run(["--print-sha256", "pdfium-android-arm64.tgz"])).toEqual({ platform: "linux-x64" });
  });

  it("一个都不给 ⇒ 才轮到「当前系统」这个兜底", () => {
    expect(run([])).toEqual({ platform: "linux-x64" });
  });
});

describe("resolvePlatform：★ 认不出的一律硬失败，不许静默回落", () => {
  it("★ 写错的平台名 ⇒ error（这就是那次 CI 的根因所在）", () => {
    const r = run(["android-arm"]);
    expect(r.platform).toBeUndefined();
    expect(r.error).toMatch(/不支持的平台：android-arm/);
    expect(r.error).toMatch(/android-arm64/); // 顺带把可选值列出来，省一次翻文档
  });

  it("★ 写错的 `--platform` 值同样硬失败", () => {
    expect(run(["--platform", "linux-arm64"]).error).toMatch(/不支持的平台：linux-arm64（来自--platform）/);
  });

  it("★ 两个来源冲突 ⇒ error（不许「后者覆盖前者」）", () => {
    const r = run(["--platform", "win-x64", "android-arm64"]);
    expect(r.platform).toBeUndefined();
    expect(r.error).toMatch(/不一致|只能给一个/);
  });

  it("平台给两次（位置形式重复）⇒ error", () => {
    expect(run(["android-arm64", "linux-x64"]).error).toMatch(/平台只能给一个|不一致/);
  });

  it("`--platform` 后面没值 ⇒ error，而不是当成没给", () => {
    expect(run(["--platform"]).error).toMatch(/缺少值/);
  });

  it("没给平台、当前系统也认不出 ⇒ error（不瞎猜一个）", () => {
    const r = resolvePlatform([], { detect: () => null, known: KNOWN });
    expect(r.platform).toBeUndefined();
    expect(r.error).toMatch(/没给平台/);
  });
});
