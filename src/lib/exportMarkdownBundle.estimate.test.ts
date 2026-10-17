// 导出前"预估"那句话的判据（2026-10-17；C 弹窗的前置 ✓）—— 纯函数，不起宿主 ✓。
//
// 关键口径：**未知不许当 0 又不说话** ✗（给出一个"看起来精确"却少算的体积，是这一摊最讨厌的假读数 ✓）。
import { describe, expect, it } from "vitest";
import { estimateBundleText } from "./exportMarkdownBundle";

describe("estimateBundleText —— 导出前预估（2026-10-17 加）", () => {
  it("① 全知道 ⇒ 篇数 · 附件数 · 体积 三样都有 ✓", () => {
    const s = estimateBundleText(18, 32, 1.1 * 1024 * 1024 * 1024, 0);
    expect(s).toContain("18 篇");
    expect(s).toContain("32 个附件");
    expect(s).toContain("1126 MB");
    expect(s).not.toContain("未知");
  });

  it("② 有大小未知的 ⇒ **必须另说一句** ⛔ 不把它们算成 0 又不提 ✗", () => {
    const s = estimateBundleText(3, 5, 1024 * 1024, 2);
    expect(s).toContain("3 篇");
    expect(s).toContain("5 个附件");
    expect(s).toContain("已知约 1 MB");
    expect(s).toContain("另有 2 个大小未知");
  });

  it("③ 一个字节都不知 ⇒ 只说数量（⛔ 不编一个 0 MB ✗）", () => {
    const s = estimateBundleText(1, 1, 0, 1);
    expect(s).toContain("1 篇");
    expect(s).not.toContain("0 MB");
    expect(s).toContain("另有 1 个大小未知");
  });
});
