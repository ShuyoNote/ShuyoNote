// 侧栏拖拽的三个数字与一个判断。写歪了不会报错，只会"手感不对"（拖到底收不起来、
// 或者手一抖侧栏就没了），所以钉住。
import { describe, expect, it } from "vitest";
import {
  SIDEBAR_COLLAPSE_AT,
  SIDEBAR_MAX_W,
  SIDEBAR_MIN_W,
  clampSidebarWidth,
  dragOutcome,
  normalizeStoredWidth,
} from "./sidebarDrag";

describe("clampSidebarWidth", () => {
  it("夹在最小/最大之间", () => {
    expect(clampSidebarWidth(300)).toBe(300);
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_W);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_W);
  });

  it("非数字退回最小宽（不是 NaN 传进样式）", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_MIN_W);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_MIN_W);
  });

  it("取整：拖拽时的 clientX 是小数，别把 240.6px 写进样式与存档", () => {
    expect(clampSidebarWidth(240.6)).toBe(241);
  });
});

describe("dragOutcome", () => {
  it("拖到阈值以下 = 收起；阈值以上 = 正常改宽", () => {
    expect(dragOutcome(SIDEBAR_COLLAPSE_AT - 1)).toBe("collapse");
    expect(dragOutcome(SIDEBAR_COLLAPSE_AT)).toBe("resize");
    expect(dragOutcome(300)).toBe("resize");
  });

  it("阈值要比最小宽更低：留出余量，免得手抖（想拖 250、滑到 238）就把侧栏收掉", () => {
    expect(SIDEBAR_COLLAPSE_AT).toBeLessThan(SIDEBAR_MIN_W);
    // 最小宽那个位置仍是"改宽"，只有继续往左拖才收起
    expect(dragOutcome(SIDEBAR_MIN_W)).toBe("resize");
    expect(dragOutcome(230)).toBe("resize");
    expect(dragOutcome(120)).toBe("collapse");
  });
});

describe("normalizeStoredWidth", () => {
  it("正常值原样用（含上限夹取）", () => {
    expect(normalizeStoredWidth("300")).toBe(300);
    expect(normalizeStoredWidth("9999")).toBe(SIDEBAR_MAX_W);
  });

  it("过窄/非法/缺失都退回默认，而不是把它当成“要收起”", () => {
    expect(normalizeStoredWidth("120")).toBe(SIDEBAR_MIN_W);
    expect(normalizeStoredWidth("abc")).toBe(SIDEBAR_MIN_W);
    expect(normalizeStoredWidth(null)).toBe(SIDEBAR_MIN_W);
    expect(normalizeStoredWidth(undefined)).toBe(SIDEBAR_MIN_W);
    expect(normalizeStoredWidth("")).toBe(SIDEBAR_MIN_W);
  });
});
