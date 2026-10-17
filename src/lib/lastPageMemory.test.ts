// 判据：「每个空间上次看的那一页」记得住、且**空间之间互不覆盖**（owner 2026-10-18 提的 ✓）。
//
// 纯存取层（localStorage 是真的，没有 store/React）。「接到 notes store 之后真的会还原」
// 在 `src/store/notes.test.ts` 里钉 ✓。
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLastPage,
  LAST_PAGE_KEY,
  LAST_PAGE_KEY_PREFIX,
  readLastPage,
  writeLastPage,
} from "./lastPageMemory";

beforeEach(() => {
  localStorage.clear();
});

describe("lastPageMemory —— 按空间记住「上次看的那一页」", () => {
  it("① 写进去、读得出来；同时**照写老键**（老版本/老记忆兼容 ✓）", () => {
    writeLastPage("page-b", "ws-1");
    expect(readLastPage("ws-1")).toBe("page-b");
    expect(localStorage.getItem(LAST_PAGE_KEY_PREFIX + "ws-1")).toBe("page-b");
    expect(localStorage.getItem(LAST_PAGE_KEY), "老键也要写（降级不丢 ✓）").toBe("page-b");
  });

  it("② **空间之间互不覆盖**：A 记得 a、B 记得 b，各自读各自的 ✓", () => {
    writeLastPage("page-a", "ws-A");
    writeLastPage("page-b", "ws-B");

    expect(readLastPage("ws-A")).toBe("page-a");
    expect(readLastPage("ws-B")).toBe("page-b");
    // 老键会被最后写的那次覆盖 ✓ —— 但**按空间读**不受影响 ✓（这正是本条的目的）
    expect(localStorage.getItem(LAST_PAGE_KEY)).toBe("page-b");
  });

  it("③ **迁移**：只有老键、这个空间还没有记录 ⇒ 退回老键的值 ✓", () => {
    localStorage.setItem(LAST_PAGE_KEY, "legacy-page");
    expect(readLastPage("ws-new")).toBe("legacy-page");
  });

  it("④ 按空间键**优先**于老键（老键是别的空间的旧值，不许盖掉本空间的 ✓）", () => {
    localStorage.setItem(LAST_PAGE_KEY, "旧空间的页");
    writeLastPage("本空间的页", "ws-1");
    expect(readLastPage("ws-1")).toBe("本空间的页");
  });

  it("⑤ 没有空间 id / 没记录 ⇒ 空串（调用方走自己的兜底 ✓）", () => {
    expect(readLastPage()).toBe("");
    expect(readLastPage(null)).toBe("");
    expect(readLastPage("ws-空")).toBe("");
  });

  it("⑥ 空 pageId ⇒ 不写（⛔ 别把空串当一页记下来 ✗）", () => {
    writeLastPage("", "ws-1");
    expect(localStorage.length).toBe(0);
  });

  it("⑦ localStorage 坏了 / 写不进去 ⇒ 读回空串、写不抛（隐私模式 ✓）", () => {
    // ⚠️ 用**实例上的方法**打桩（happy-dom 的 localStorage 方法不是 Storage.prototype 上那两个）；
    //    打原型的话桩不会生效 ⇒ 这条判据会变成"假装验过"✗。
    const setSpy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => writeLastPage("page-a", "ws-1")).not.toThrow();
    setSpy.mockRestore();

    const getSpy = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readLastPage("ws-1")).toBe("");
    getSpy.mockRestore();
  });

  it("⑧ `clearLastPage` 只清指定空间（不给空间 ⇒ 只清老键 ✓）", () => {
    writeLastPage("page-a", "ws-A");
    writeLastPage("page-b", "ws-B");
    clearLastPage("ws-A");
    expect(readLastPage("ws-A"), "A 清掉后**退回老键**（老键是 B 那笔）").toBe("page-b");
    expect(readLastPage("ws-B")).toBe("page-b");
  });
});
