// isMobileViewport: pure viewport check (<=768px). Test the pure function with a
// mocked window.matchMedia, without invoking React hooks.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isMobileOverlayViewport,
  isMobileViewport,
  isNarrowViewport,
  isShortViewport,
  subscribeOverlayViewport,
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

// 2026-09-15：PDF 阅读器的目录/批注栏在真机上把正文挤出屏幕，根因是它只在**挂载时**
// 判了一次视口。修法是"跟着视口变化"——而这里最容易犯的错是**只订阅窄屏那一条**：
// 手机竖屏转横屏（360 → 792 宽）回调不触发，阅读器就一直留着桌面三栏。
// 这条不变量必须钉住，否则下次"顺手简化"又会掉回去。
describe("浮层视口的订阅：两条查询都要盯", () => {
  it("订阅**窄**与**矮**两条查询，任一变化都会回调", () => {
    const listeners = new Map<string, () => void>();
    const mm = vi.fn((q: string) => ({
      addEventListener: (_t: string, fn: EventListenerOrEventListenerObject) => {
        listeners.set(q, fn as unknown as () => void);
      },
      removeEventListener: () => {},
    }));
    const onChange = vi.fn();

    const off = subscribeOverlayViewport(mm, onChange);
    expect(mm).toHaveBeenCalledTimes(2);
    expect(mm.mock.calls.map((c) => c[0])).toEqual(["(max-width: 768px)", "(max-height: 520px)"]);
    expect(listeners.size).toBe(2);

    // 横屏（矮）那一条变了也要回调——这就是真机上漏掉的那次更新
    listeners.get("(max-height: 520px)")?.();
    expect(onChange).toHaveBeenCalledTimes(1);
    listeners.get("(max-width: 768px)")?.();
    expect(onChange).toHaveBeenCalledTimes(2);

    off();
  });

  it("取消订阅时两条都要摘掉（漏一条就是常驻监听 + 卸载后 setState）", () => {
    const removed: string[] = [];
    const mm = (q: string) => ({
      addEventListener: (_t: string, _fn: EventListenerOrEventListenerObject) => {},
      removeEventListener: (_t: string, _fn: EventListenerOrEventListenerObject) => {
        removed.push(q);
      },
    });
    const off = subscribeOverlayViewport(mm);
    off();
    expect(removed).toEqual(["(max-width: 768px)", "(max-height: 520px)"]);
  });
});
