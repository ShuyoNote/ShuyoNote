// inset → CSS 变量。
//
// 这里钉的是那条**最容易被写错、错了就顶两遍**的规则：
// `--kb` 是"键盘额外盖住、而视口还没缩掉的那部分高度"。
import { describe, it, expect } from "vitest";
import {
  keyboardExtra,
  insetsToCssVars,
  normalizeInsets,
  ZERO_INSETS,
} from "../lib/viewportInsets";

describe("keyboardExtra", () => {
  it("视口没缩（Android edge-to-edge 实测形态）⇒ 键盘高度全额计入", () => {
    // 真机实测：键盘弹起后 innerHeight 与 visualViewport.height 都不变。
    expect(
      keyboardExtra(320, { innerHeight: 792, visualHeight: 792, visualOffsetTop: 0 }),
    ).toBe(320);
  });

  it("视口已经缩掉同样多（resizes-content 真的生效）⇒ 不再重复计算，返回 0", () => {
    // 否则弹层会被顶两遍：视口缩了 320，再由 --kb 顶 320。
    expect(
      keyboardExtra(320, { innerHeight: 792, visualHeight: 472, visualOffsetTop: 0 }),
    ).toBe(0);
  });

  it("部分缩放 ⇒ 只补差额", () => {
    expect(
      keyboardExtra(320, { innerHeight: 792, visualHeight: 692, visualOffsetTop: 0 }),
    ).toBe(220);
  });

  it("视觉视口被平移（offsetTop>0）时，被遮住的仍是 innerHeight − offsetTop − visualHeight", () => {
    // 布局视口 [0,792]，可视 [100,692] ⇒ 底部被遮 792-100-592 = 100，仍需补 320-100。
    expect(
      keyboardExtra(320, { innerHeight: 792, visualHeight: 592, visualOffsetTop: 100 }),
    ).toBe(220);
  });

  it("没有壳层报送（浏览器 / 桌面）⇒ 恒为 0", () => {
    expect(keyboardExtra(0, { innerHeight: 800, visualHeight: 800, visualOffsetTop: 0 })).toBe(0);
    expect(keyboardExtra(-5, { innerHeight: 800, visualHeight: 800, visualOffsetTop: 0 })).toBe(0);
    expect(keyboardExtra(NaN, { innerHeight: 800, visualHeight: 800, visualOffsetTop: 0 })).toBe(0);
  });

  it("视口比 innerHeight 还大（视觉视口未就绪）时不许算出负数", () => {
    expect(
      keyboardExtra(100, { innerHeight: 800, visualHeight: 900, visualOffsetTop: 0 }),
    ).toBe(100);
  });
});

describe("insetsToCssVars", () => {
  it("四个方向 + 键盘各写一个变量", () => {
    expect(insetsToCssVars({ top: 41, right: 0, bottom: 24, left: 3, ime: 300 }, 300)).toEqual({
      "--sat": "41px",
      "--sar": "0px",
      "--sab": "24px",
      "--sal": "3px",
      "--kb": "300px",
    });
  });

  it("负数/小数不会写进非法值", () => {
    const v = insetsToCssVars({ top: -1, right: 2.345, bottom: 0, left: 0, ime: 0 }, -3);
    expect(v["--sat"]).toBe("0px");
    expect(v["--sar"]).toBe("2.35px");
    expect(v["--kb"]).toBe("0px");
  });
});

describe("normalizeInsets", () => {
  it("壳层传来的是**不可信输入**：缺字段 / 垃圾值一律当 0", () => {
    expect(normalizeInsets(undefined)).toEqual(ZERO_INSETS);
    expect(normalizeInsets({})).toEqual(ZERO_INSETS);
    expect(normalizeInsets({ top: "41", bottom: "abc", left: null, ime: {} })).toEqual({
      top: 41,
      right: 0,
      bottom: 0,
      left: 0,
      ime: 0,
    });
    expect(normalizeInsets({ top: -10 })).toEqual(ZERO_INSETS);
  });
});
