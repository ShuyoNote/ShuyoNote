// 判据：「一个空间里哪些节点展开 / 折叠」**记得住、且按空间分开**（owner 2026-10-18 提的 ✓）。
//
// 这一层只测**纯存取**（localStorage 是真的；没有 DOM/React）。「真的渲染成一棵树之后
// 折叠/重挂载还记不记得」在 `src/components/treeExpansionMemory.test.ts` 里钉 ✓。
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTreeMemory,
  isNodeExpanded,
  rememberNodeExpanded,
  TREE_MEMORY_KEY_PREFIX,
  TREE_MEMORY_MAX_ENTRIES,
} from "./treeMemory";

const WS = "ws-1";
const KEY = TREE_MEMORY_KEY_PREFIX + WS;

beforeEach(() => {
  localStorage.clear();
});

describe("treeMemory —— 展开/折叠按空间记住", () => {
  it("① 没记录 ⇒ **默认展开**（老行为不变 ✓，⛔ 不因为没记忆就把树折起来 ✗）", () => {
    expect(isNodeExpanded(WS, "folder-a")).toBe(true);
    expect(isNodeExpanded(WS, "一些页面")).toBe(true);
  });

  it("② 折叠过 ⇒ 再问是折叠；再展开 ⇒ 又回到展开 ✓", () => {
    rememberNodeExpanded(WS, "folder-a", false);
    expect(isNodeExpanded(WS, "folder-a")).toBe(false);

    rememberNodeExpanded(WS, "folder-a", true);
    expect(isNodeExpanded(WS, "folder-a")).toBe(true);
  });

  it("③ **按空间分键**：A 空间折起来不影响 B 空间 ✓", () => {
    rememberNodeExpanded("ws-A", "folder-a", false);
    expect(isNodeExpanded("ws-A", "folder-a")).toBe(false);
    expect(isNodeExpanded("ws-B", "folder-a"), "别的空间要按自己的记忆（没记录 ⇒ 展开）").toBe(true);
  });

  it("④ 同一节点只留**最后一笔**（不累积历史 ✓）", () => {
    rememberNodeExpanded(WS, "folder-a", false);
    rememberNodeExpanded(WS, "folder-a", true);
    rememberNodeExpanded(WS, "folder-a", false);
    const rows = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown[];
    expect(rows).toHaveLength(1);
    expect(isNodeExpanded(WS, "folder-a")).toBe(false);
  });

  it("⑤ 坏数据 / 形状不认识 ⇒ 当没有记录（默认展开），⛔ 不抛 ✗", () => {
    localStorage.setItem(KEY, "{不是 JSON");
    expect(isNodeExpanded(WS, "folder-a")).toBe(true);

    localStorage.setItem(KEY, JSON.stringify([["ok", 1], ["bad", "x"], ["缺一项"], 42, null]));
    expect(isNodeExpanded(WS, "ok")).toBe(true);
    expect(isNodeExpanded(WS, "bad"), "值不是 0/1 ⇒ 丢弃这一条").toBe(true);
  });

  it("⑥ 空间 id 还没到位时：回 fallback（展开），⛔ 不写半个键 ✗", () => {
    expect(isNodeExpanded(null, "folder-a")).toBe(true);
    expect(isNodeExpanded(undefined, "folder-a", false)).toBe(false);
    rememberNodeExpanded(null, "folder-a", false);
    expect(localStorage.length).toBe(0);
  });

  // ⚠️ 显式 20s 超时（2026-10-31 实测）：这条要写 `MAX_ENTRIES+1` 次、每次把整条数组 JSON 化，
  //    单独跑 ~0.5s，但全量 410 个文件并行时会撞 5s 默认超时 ⇒ 假红（不是产品问题，也不是断言问题）。
  it("⑦ 有上限：超过 MAX 条 ⇒ 丢**最旧**的，键不会无限长 ✓", () => {
    for (let i = 0; i <= TREE_MEMORY_MAX_ENTRIES; i += 1) rememberNodeExpanded(WS, `node-${i}`, false);
    const rows = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown[];
    expect(rows.length).toBeLessThanOrEqual(TREE_MEMORY_MAX_ENTRIES);
    expect(isNodeExpanded(WS, "node-0"), "最早那笔该被剪掉").toBe(true);
    expect(isNodeExpanded(WS, `node-${TREE_MEMORY_MAX_ENTRIES}`), "最新的必须还在").toBe(false);
  }, 20_000);

  it("⑧ localStorage 写不进去（隐私模式/配额）⇒ 静默放弃，⛔ 不抛 ✗", () => {
    // ⚠️ 打**实例**方法（happy-dom 的 localStorage 不走 Storage.prototype ⇒ 打原型等于没打 ✗）
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => rememberNodeExpanded(WS, "folder-a", false)).not.toThrow();
    spy.mockRestore();
  });

  it("⑨ `clearTreeMemory` 只清这个空间 ✓", () => {
    rememberNodeExpanded(WS, "folder-a", false);
    rememberNodeExpanded("ws-2", "folder-a", false);
    clearTreeMemory(WS);
    expect(isNodeExpanded(WS, "folder-a")).toBe(true);
    expect(isNodeExpanded("ws-2", "folder-a")).toBe(false);
  });
});
