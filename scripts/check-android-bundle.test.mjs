// `check-android-bundle` 的判据自测（纯函数那半；端到端那半需要真 APK，见门禁文件头的读数）。
//
// 这一组的价值全在"哪些条目才算**随包的库**"这一步上：
//   · 认太宽（把 `lib/<abi>/<子目录>/libpdfium.so` 也算）⇒ 门禁会给一个**加载不到**的包发绿；
//   · 认太窄（漏掉某个 ABI）⇒ 安卓真机上仍然是"找不到动态库"。
import { describe, expect, it } from "vitest";

import { apkLibEntries, ABI_DIRS } from "./check-android-bundle.mjs";

describe("apkLibEntries：只认 Gradle 会装进 nativeLibraryDir 的那一层", () => {
  it("`lib/<abi>/libpdfium.so` 算（三层）", () => {
    expect(apkLibEntries(["lib/arm64-v8a/libpdfium.so"])).toEqual([
      { abi: "arm64-v8a", entry: "lib/arm64-v8a/libpdfium.so" },
    ]);
  });

  it("★ 深一层**不算** —— 包里在、但 Gradle 不会把它当 native library", () => {
    expect(apkLibEntries(["lib/arm64-v8a/resources/libpdfium.so"])).toEqual([]);
  });

  it("★ 认不出的 ABI 目录**不算**（别把别的目录名当 ABI）", () => {
    expect(apkLibEntries(["lib/not-an-abi/libpdfium.so"])).toEqual([]);
  });

  it("别的 .so 不算；带 `./` 前缀的要能认出来", () => {
    expect(apkLibEntries(["lib/arm64-v8a/libc++_shared.so"])).toEqual([]);
    expect(apkLibEntries(["./lib/x86_64/libpdfium.so"]).map((e) => e.abi)).toEqual(["x86_64"]);
  });

  it("多个 ABI 时按 `ABI_DIRS` 的顺序稳定输出（报告里那行才不会抖动）", () => {
    const got = apkLibEntries([
      "lib/x86_64/libpdfium.so",
      "lib/arm64-v8a/libpdfium.so",
      "lib/armeabi-v7a/libpdfium.so",
    ]);
    expect(got.map((e) => e.abi)).toEqual(["arm64-v8a", "armeabi-v7a", "x86_64"]);
    // 顺序来自常量表，不是硬编码在这条判据里
    expect(got.map((e) => e.abi)).toEqual(ABI_DIRS.filter((a) => got.some((g) => g.abi === a)));
  });

  it("空输入 ⇒ 空结果（门禁自己不许把「没扫到」当绿）", () => {
    expect(apkLibEntries([])).toEqual([]);
  });
});
