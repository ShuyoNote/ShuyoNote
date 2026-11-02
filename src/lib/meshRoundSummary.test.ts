// 同步面板「本轮进度 / 摘要」的纯函数判据（owner 2026-10-29：A+C）。
import { describe, expect, it } from "vitest";
import { meshProgressText, meshRoundSummaryText } from "./meshRoundSummary";

describe("meshRoundSummaryText：只补 rep.note 没说的那一格", () => {
  it("收了页 ⇒ 补「本轮收下 N 页」", () => {
    expect(meshRoundSummaryText(3)).toBe("（本轮收下 3 页）");
  });

  it("一页没收到 ⇒ 空串（⛔ 不补「收下 0 页」的废话）", () => {
    expect(meshRoundSummaryText(0)).toBe("");
  });
});

describe("meshProgressText：同步中的那行真话", () => {
  it("有附近设备时说台数；秒数从 0 起", () => {
    expect(meshProgressText("工作", 2, 0)).toBe("正在同步「工作」… 附近 2 台 · 已 0s");
    expect(meshProgressText("工作", 2, 3400)).toBe("正在同步「工作」… 附近 2 台 · 已 3s");
  });

  it("附近 0 台时不编台数；空名字如实说「这个空间」", () => {
    expect(meshProgressText("  ", 0, 1200)).toBe("正在同步「这个空间」… 已 1s");
  });
});
