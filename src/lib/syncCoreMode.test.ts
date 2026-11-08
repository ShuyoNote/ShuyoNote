// ⭐ P3-1a 第五刀（task-58）：Core vs 前端定时器的决策表判据。
import { describe, expect, it } from "vitest";
import { decideSyncAutoMode, shouldEnableRustCore, shouldScheduleFrontendTimer } from "./syncCoreMode";

describe("decideSyncAutoMode：哪种节拍跑", () => {
  it("桌面 ＋ 闸门放行 ＋ 间隔>0 ⇒ core（前端定时器停排）", () => {
    const input = { isDesktop: true, autoSyncMs: 5000, gateAllowed: true };
    expect(decideSyncAutoMode(input)).toBe("core");
    expect(shouldEnableRustCore(input)).toBe(true);
    expect(shouldScheduleFrontendTimer(input)).toBe(false);
  });

  it("桌面 ＋ 闸门拒绝（蜂窝/仅 Wi-Fi）⇒ 回退 timer（旧行为）", () => {
    const input = { isDesktop: true, autoSyncMs: 5000, gateAllowed: false };
    expect(decideSyncAutoMode(input)).toBe("timer");
    expect(shouldEnableRustCore(input)).toBe(false);
    expect(shouldScheduleFrontendTimer(input)).toBe(true);
  });

  it("移动端 ⇒ 一律 timer（Core 不接管移动端；闸门放不放行都一样）", () => {
    for (const gateAllowed of [true, false]) {
      const input = { isDesktop: false, autoSyncMs: 5000, gateAllowed };
      expect(decideSyncAutoMode(input)).toBe("timer");
      expect(shouldEnableRustCore(input)).toBe(false);
      expect(shouldScheduleFrontendTimer(input)).toBe(true);
    }
  });

  it("间隔 0（同步方式关闭）⇒ off：Core 不开、定时器也不排", () => {
    for (const isDesktop of [true, false]) {
      for (const gateAllowed of [true, false]) {
        const input = { isDesktop, autoSyncMs: 0, gateAllowed };
        expect(decideSyncAutoMode(input)).toBe("off");
        expect(shouldEnableRustCore(input)).toBe(false);
        expect(shouldScheduleFrontendTimer(input)).toBe(false);
      }
    }
  });
});
