// isMobileViewport: pure viewport check (<=768px). Test the pure function with a
// mocked window.matchMedia, without invoking React hooks.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isMobileOverlayViewport,
  isMobileViewport,
  isNarrowViewport,
  isShortViewport,
  SHORT_VIEWPORT_MAX_PX,
} from "./useMobile";

function mockWindowWithMedia(matches: boolean) {
  const mql = {
    matches,
    media: "(max-width: 768px)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  (globalThis as Record<string, unknown>)["window"] = { matchMedia: vi.fn(() => mql) };
}

describe("isMobileViewport", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)["window"];
    delete (globalThis as Record<string, unknown>)["matchMedia"];
  });

  it("is true when matchMedia matches (<=768px)", () => {
    mockWindowWithMedia(true);
    expect(isMobileViewport()).toBe(true);
  });

  it("is false when matchMedia does not match", () => {
    mockWindowWithMedia(false);
    expect(isMobileViewport()).toBe(false);
  });

  it("is false when matchMedia is unavailable", () => {
    (globalThis as Record<string, unknown>)["window"] = {};
    expect(isMobileViewport()).toBe(false);
  });

  it("is false when there is no window", () => {
    delete (globalThis as Record<string, unknown>)["window"];
    expect(isMobileViewport()).toBe(false);
  });
});

// 2026-09-15：**布局看宽度、浮层看宽度和高度**。这两条口径必须各有断言，
// 否则"横屏手机（792×360）"这种既不窄又不高的情况又会掉到桌面分支上
// ——实测症状是 `.set-dialog` 高 420、底边 444，**底部 84px 被裁在屏外**。
describe("窄 / 矮两条轴", () => {
  it("横屏手机 792×360：不窄（布局仍两列），但算矮（浮层必须整屏）", () => {
    expect(isNarrowViewport(792)).toBe(false);
    expect(isShortViewport(360)).toBe(true);
    expect(isMobileOverlayViewport(792, 360)).toBe(true);
  });

  it("竖屏手机 390×844：窄但不矮", () => {
    expect(isNarrowViewport(390)).toBe(true);
    expect(isShortViewport(844)).toBe(false);
    expect(isMobileOverlayViewport(390, 844)).toBe(true);
  });

  it("桌面 1280×800：既不窄也不矮 ⇒ 仍是锚定浮层", () => {
    expect(isMobileOverlayViewport(1280, 800)).toBe(false);
  });

  it("桌面窗口被拖矮（1280×480）⇒ 浮层也要收敛", () => {
    expect(isMobileOverlayViewport(1280, 480)).toBe(true);
  });

  it("矮视口断点的边界：520 算矮、521 不算（与 CSS 的 max-height:520px 同源）", () => {
    expect(SHORT_VIEWPORT_MAX_PX).toBe(520);
    expect(isShortViewport(520)).toBe(true);
    expect(isShortViewport(521)).toBe(false);
  });
});
