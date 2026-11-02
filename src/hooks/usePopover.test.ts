// P1-A 判据：浮层水平 clamp 必须能避开右侧停靠目录（`--toc-w`）。
//
// 来由（2026-11-01 owner 截图）：版本历史浮层右半边被「目录」盖住；层叠修复（`--z-popover`）
// 只解决"谁盖谁"，没解决"浮层在哪"——旧 clamp 只看 `window.innerWidth`，不知道目录占
// 240–560px ⇒ 浮层右缘被顶到窗口右缘、必然压住目录。这里钉住纯函数：
//   · 没有目录（inset=0）⇒ 与旧行为逐字相同；
//   · 目录打开（inset>0）⇒ 浮层右缘 ≤ 视口宽 - inset；
//   · 编辑区窄到放不下 ⇒ 退化为左边距 8px（不产生负数坐标）。
import { describe, expect, it } from "vitest";

import { clampPopoverLeft } from "./usePopover";

describe("浮层水平 clamp：可用右边界", () => {
  it("① 无目录（inset=0）：与旧行为一致（只夹视口）", () => {
    expect(clampPopoverLeft(1000, 320, 1280)).toBe(960);
    expect(clampPopoverLeft(0, 320, 1280)).toBe(8);
  });

  it("② 目录 300px：浮层右缘不得越过分隔线（<= 980）", () => {
    expect(clampPopoverLeft(1000, 320, 1280, 300)).toBe(660);
    expect(clampPopoverLeft(660, 320, 1280, 300)).toBe(660);
  });

  it("③ 目录 560px：右缘 <= 720，浮层仍从 8px 起", () => {
    expect(clampPopoverLeft(660, 320, 1280, 560)).toBe(400);
    expect(clampPopoverLeft(-100, 320, 1280, 560)).toBe(8);
  });

  it("④ 可用区窄到放不下：退化为左边距 8（不出现负坐标）", () => {
    expect(clampPopoverLeft(999, 320, 400, 300)).toBe(8);
  });
});
