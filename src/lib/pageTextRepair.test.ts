// 阶段 1 · 正文文本本地修复的判据（纯函数，不需要编辑器/DOM/数据库）。
//
// 这一段容易写松：只要"不同就写库"写错，要么**漏修**（FTS 一直搜不到），要么**每次都写库**
// （每开一页一次写，纯浪费）。所以四条边界逐个钉。

import { describe, expect, it, vi } from "vitest";

import { repairPageTextIfStale } from "./pageTextRepair";

function deps() {
  const refresh = vi.fn<(pageId: string, text: string) => void>();
  return { refresh };
}

describe("repairPageTextIfStale", () => {
  it("库里那份与算出来的不同 ⇒ 写回去，并报告「修了」", () => {
    const d = deps();
    expect(repairPageTextIfStale(d, "p1", "旧文本（合并前那一份）", "新文本")).toBe(true);
    expect(d.refresh).toHaveBeenCalledTimes(1);
    expect(d.refresh).toHaveBeenCalledWith("p1", "新文本");
  });

  it("两边相同 ⇒ **一次写库都没有**（绝大多数页面走这条）", () => {
    const d = deps();
    expect(repairPageTextIfStale(d, "p1", "一样", "一样")).toBe(false);
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it("拿不到库里那份（undefined）⇒ **不修**（不猜）", () => {
    const d = deps();
    expect(repairPageTextIfStale(d, "p1", undefined, "算出来的")).toBe(false);
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it("空页（两边都是空串）⇒ 不修；没有 pageId ⇒ 也不修", () => {
    const d = deps();
    expect(repairPageTextIfStale(d, "p1", "", "")).toBe(false);
    expect(repairPageTextIfStale(d, "", "", "有内容")).toBe(false);
    expect(d.refresh).not.toHaveBeenCalled();
  });
});
