// ⭐ P3-1a 第五刀（task-58）＋ 收尾（task-69）：Core vs 前端定时器的决策表判据。
import { describe, expect, it } from "vitest";
import { decideSyncAutoMode, shouldEnableRustCore, shouldScheduleFrontendTimer } from "./syncCoreMode";

describe("decideSyncAutoMode：哪种节拍跑（桌面不再看前端闸门）", () => {
  it("桌面 ＋ 间隔>0 ⇒ 一律 core（1/30s/300s；网络闸门在 Rust Core 内每轮判）", () => {
    for (const autoSyncMs of [1, 5_000, 30_000, 300_000]) {
      const input = { isDesktop: true, autoSyncMs };
      expect(decideSyncAutoMode(input), `desktop/${autoSyncMs}`).toBe("core");
      expect(shouldEnableRustCore(input)).toBe(true);
      expect(shouldScheduleFrontendTimer(input)).toBe(false);
    }
  });

  it("移动端 ⇒ 一律 timer（Core 不接管移动端）", () => {
    for (const autoSyncMs of [1, 5_000, 30_000]) {
      const input = { isDesktop: false, autoSyncMs };
      expect(decideSyncAutoMode(input)).toBe("timer");
      expect(shouldEnableRustCore(input)).toBe(false);
      expect(shouldScheduleFrontendTimer(input)).toBe(true);
    }
  });

  it("间隔 0（同步方式关闭）⇒ off：Core 不开、定时器也不排（桌面/移动都一样）", () => {
    for (const isDesktop of [true, false]) {
      const input = { isDesktop, autoSyncMs: 0 };
      expect(decideSyncAutoMode(input)).toBe("off");
      expect(shouldEnableRustCore(input)).toBe(false);
      expect(shouldScheduleFrontendTimer(input)).toBe(false);
    }
  });
});
