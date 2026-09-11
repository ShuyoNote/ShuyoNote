import { describe, expect, it } from "vitest";
import { pdfPlacement } from "./pdfPlacement";

// PDF 阅读器的落点：桌面端在内容区里（和 Markdown 阅读器一样，侧边栏留着），窄屏才是全屏浮层。
//
// 为什么值得单独测：它**以前是全屏浮层**（`position: fixed; inset: 0`），会把左竖条、页面树、
// 右栏一起盖住；改回内容区之后，"顺手改回去"的代价又恰好是看不见的那种（面板照样能开、
// 什么都对，只是把侧边栏盖住了）。所以这条规则写成可测的一行。
describe("PDF 阅读器落在哪里", () => {
  it("没打开时哪儿都不渲染", () => {
    expect(pdfPlacement(false, false)).toBe("none");
    expect(pdfPlacement(false, true)).toBe("none");
  });

  it("桌面端：内容区里（不是浮层）——侧边栏与右栏都要留着", () => {
    expect(pdfPlacement(true, false)).toBe("inline");
  });

  it("窄屏：全屏浮层（那时侧边栏本来就是抽屉）", () => {
    expect(pdfPlacement(true, true)).toBe("overlay");
  });
});
