// isMobileViewport: pure viewport check (<=768px). Test the pure function with a
// mocked window.matchMedia, without invoking React hooks.
import { describe, it, expect, vi, afterEach } from "vitest";
import { isMobileViewport } from "./useMobile";

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
