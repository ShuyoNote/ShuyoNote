// 「记住每页滚动位置」的存取那一半 —— 纯函数、本机全量可跑（DOM 那一半见 `hooks/useScrollMemory.ts`）。
//
// 来由（owner 2026-10-06）：「刷新页面，当前页面位置丢失了」。
// 这里钉三件容易写错的事：① 没记录 ⇒ 读出来是 0（调用方据此**显式回顶部** ✓，不然会继承上一页的位置 ✗）；
// ② 位置为 0 ⇒ **把那条删掉**（别在 localStorage 里留一堆 `"0"` ✗）；
// ③ 条目有**上限**且按写入时刻丢最旧的（否则这条键会一直长 ✗）。
import { beforeEach, describe, expect, it } from "vitest";
import { SCROLL_KEY_PREFIX, SCROLL_MAX_ENTRIES, pruneScrolls, readScroll, writeScroll } from "./scrollMemory";

describe("scrollMemory：按页面记滚动位置", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("没记录 / 记的是 0 ⇒ 读出来就是 0（调用方据此回顶部）", () => {
    expect(readScroll("p1")).toBe(0);
    writeScroll("p1", 0);
    expect(readScroll("p1")).toBe(0);
    expect(localStorage.getItem(SCROLL_KEY_PREFIX + "p1")).toBeNull(); // ② 不留 "0"
  });

  it("写进去再读出来是同一个数（取整）", () => {
    writeScroll("p1", 812.7);
    expect(readScroll("p1")).toBe(813);
  });

  it("负数 / NaN ⇒ 当成 0 处理（不写脏值）", () => {
    writeScroll("p1", -5);
    expect(readScroll("p1")).toBe(0);
    writeScroll("p1", Number.NaN);
    expect(readScroll("p1")).toBe(0);
  });

  it("★ 超过上限 ⇒ 按写入时刻丢最旧的（`keep` 必须留下）", () => {
    for (let i = 0; i < SCROLL_MAX_ENTRIES + 5; i++) {
      // 用递增的"伪时间"确定顺序：pruneScrolls 里写的是 Date.now()，这里靠调用顺序即可
      writeScroll(`p${i}`, 100 + i);
    }
    const kept = Array.from({ length: SCROLL_MAX_ENTRIES + 5 }, (_, i) => i).filter(
      (i) => readScroll(`p${i}`) > 0,
    );
    expect(kept.length).toBeLessThanOrEqual(SCROLL_MAX_ENTRIES);
    // 最新的那个一定还在
    expect(readScroll(`p${SCROLL_MAX_ENTRIES + 4}`)).toBeGreaterThan(0);
    // 最旧的已被丢掉
    expect(readScroll("p0")).toBe(0);
  });

  it("剪枝不会把不相关的键删掉", () => {
    localStorage.setItem("shuyonote:lastPageId", "keep-me");
    for (let i = 0; i < SCROLL_MAX_ENTRIES + 3; i++) writeScroll(`q${i}`, 10);
    expect(localStorage.getItem("shuyonote:lastPageId")).toBe("keep-me");
  });

  it("`pruneScrolls` 单独调用也安全（空输入不炸）", () => {
    expect(() => pruneScrolls("only")).not.toThrow();
    writeScroll("only", 5);
    expect(readScroll("only")).toBe(5);
  });
});
