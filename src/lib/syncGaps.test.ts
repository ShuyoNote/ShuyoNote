import { describe, expect, it } from "vitest";

import { gapCount, gapNoticeText, gapRangeText } from "./syncGaps";

// ⭐ 2026-11-20：界面那行「永久缺失」的判据。三件必须钉住：
// ① 没有缺口 ⇒ **null**（⛔ 不渲染"0 条缺口"）；
// ② 文案**不许**暗示"会自动补"（F2-0 只报不修）；
// ③ 闭区间计数要准（`238..240` 是 3 条，不是 2 条）。
describe("syncGaps · 界面那行「永久缺失」", () => {
  it("gapCount：闭区间要 +1；坏数据 ⇒ 0（⛔ 不返回负数）", () => {
    expect(gapCount({ from: 238, to: 240 })).toBe(3);
    expect(gapCount({ from: 7, to: 7 })).toBe(1);
    expect(gapCount({ from: 9, to: 3 })).toBe(0);
    expect(gapCount({ from: Number.NaN, to: 3 })).toBe(0);
  });

  it("gapRangeText：单条只写一个数，多写 `a..b`；坏数据写破折号", () => {
    expect(gapRangeText({ from: 238, to: 240 })).toBe("238..240");
    expect(gapRangeText({ from: 300, to: 300 })).toBe("300");
    expect(gapRangeText({ from: 9, to: 3 })).toBe("—");
  });

  it("没有缺口 ⇒ null（空数组 / 全是坏数据 / null 都一样）", () => {
    expect(gapNoticeText([])).toBeNull();
    expect(gapNoticeText(null)).toBeNull();
    expect(gapNoticeText(undefined)).toBeNull();
    expect(gapNoticeText([{ from: 9, to: 3 }])).toBeNull();
  });

  it("一段：条数与区间都要对，且**必须**说「补不回来」", () => {
    const t = gapNoticeText([{ from: 238, to: 240 }]);
    expect(t).toContain("3 条永久缺失");
    expect(t).toContain("238..240");
    expect(t).toContain("已经补不回来了");
    // ⛔ 不许出现"会自动补"这类承诺
    expect(t).not.toContain("自动补");
  });

  it("多段：写段数＋合计条数；超过 3 段只列前三并写「等 N 段」", () => {
    const two = gapNoticeText([
      { from: 238, to: 240 },
      { from: 300, to: 300 },
    ]);
    expect(two).toContain("2 段永久缺失");
    expect(two).toContain("共 4 条");
    expect(two).toContain("238..240、300");

    const five = gapNoticeText([
      { from: 1, to: 2 },
      { from: 5, to: 5 },
      { from: 9, to: 9 },
      { from: 20, to: 21 },
      { from: 40, to: 40 },
    ]);
    expect(five).toContain("5 段永久缺失");
    expect(five).toContain("共 7 条");
    expect(five).toContain("等 5 段");
    // 只列前三段的区间
    expect(five).toContain("1..2、5、9");
    expect(five).not.toContain("20..21");
  });
});
