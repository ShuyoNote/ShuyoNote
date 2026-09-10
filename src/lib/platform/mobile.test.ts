// Mobile WebView shell bridge: detect `window.__SHUYONOTE_MOBILE__` and prefer it
// over browser-native equivalents in createWebPlatform.
import { describe, it, expect, afterEach } from "vitest";
import { getMobileBridge } from "./mobile";
import { createWebPlatform } from "./web";

function setWindow(obj: Record<string, unknown> | null) {
  (globalThis as Record<string, unknown>)["window"] = obj;
  return () => {
    delete (globalThis as Record<string, unknown>)["window"];
  };
}

describe("MobileBridge detection", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)["window"];
  });

  it("returns null when no window or no bridge", () => {
    setWindow({});
    expect(getMobileBridge()).toBeNull();
    expect(getMobileBridge()).toBeNull();
  });

  it("returns the bridge when window.__SHUYONOTE_MOBILE__ is present", () => {
    const bridge = { openUrl: async () => {}, convertFileSrc: (p: string) => p };
    setWindow({ __SHUYONOTE_MOBILE__: bridge });
    expect(getMobileBridge()).toBe(bridge);
  });

  it("treats a non-object bridge as absent", () => {
    setWindow({ __SHUYONOTE_MOBILE__: 123 });
    expect(getMobileBridge()).toBeNull();
  });
});

describe("createWebPlatform bridge preference", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)["window"];
  });

  it("openUrl uses bridge.openUrl when present", async () => {
    const opened: string[] = [];
    const bridge = { openUrl: async (u: string) => { opened.push(u); }, convertFileSrc: (p: string) => p };
    setWindow({ __SHUYONOTE_MOBILE__: bridge });
    const p = createWebPlatform();
    await p.opener.openUrl("https://example.com");
    expect(opened).toEqual(["https://example.com"]);
  });

  it("convertFileSrc uses bridge.convertFileSrc when present", () => {
    const bridge = { convertFileSrc: (p: string) => `mobile://${p}` };
    setWindow({ __SHUYONOTE_MOBILE__: bridge });
    const p = createWebPlatform();
    expect(p.asset.convertFileSrc("/att/foo.bin")).toBe("mobile:///att/foo.bin");
  });

  it("openUrl falls back to window.open when no bridge", async () => {
    const calls: string[] = [];
    setWindow({ open: (u: string) => { calls.push(u); return null; } });
    const p = createWebPlatform();
    await p.opener.openUrl("https://example.com");
    expect(calls).toEqual(["https://example.com"]);
  });
});
