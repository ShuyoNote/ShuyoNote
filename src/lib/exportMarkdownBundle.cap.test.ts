// 体积上限判据（2026-10-17）—— 纯函数，不起宿主、不碰网络 ✓。
//
// 为什么要它：`packBundle` 用 `fflate::zipSync`（**同步** ✗）⇒ 大空间会把主线程冻住，
// 用户看到的是"点了没反应"✗（最坏的一种失败：看起来像卡死 ✓）。
// 这组只钉**判定与措辞**：能说出"这次多大""上限多少""一件都没开始打包""建议分批"✓。
import { describe, expect, it } from "vitest";
import { BUNDLE_BYTE_CAP, bundleTooLargeMessage } from "./exportMarkdownBundle";

describe("bundleTooLargeMessage —— 一键导出的体积上限（2026-10-17 加）", () => {
  it("① 在上限内 ⇒ 不拦（null ✓；边界值也不拦 ✓）", () => {
    expect(bundleTooLargeMessage(0)).toBeNull();
    expect(bundleTooLargeMessage(BUNDLE_BYTE_CAP)).toBeNull();
  });

  it("② 超过上限 ⇒ 一句能照做的描述（含上限、'没有开始打包'、建议分批 ✓）", () => {
    const msg = bundleTooLargeMessage(BUNDLE_BYTE_CAP + 1);
    expect(msg).toBeTruthy();
    expect(msg).toContain("300 MB"); // 上限要能读出来
    expect(msg).toContain("没有"); // ⭐ 明确"一件都没开始打包" ⇒ 用户不会以为打到一半
    expect(msg).toContain("分批");
  });

  it("③ 报的是**这次**的真实体积（⛔ 不是魔法数 ✗）", () => {
    expect(bundleTooLargeMessage(400 * 1024 * 1024)).toContain("400 MB");
    expect(bundleTooLargeMessage(1024 * 1024 * 1024)).toContain("1024 MB");
  });
});
