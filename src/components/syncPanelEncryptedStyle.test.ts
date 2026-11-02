import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **2026-10-28（owner：「同步面板适配一下视觉体系」）**：
 * 「加密空间同步」那一块**必须用面板既有的零件**（段标题＋数量胶囊、`sync-nearby-row` 卡片、
 * 状态点、`sync-chip`），⛔ 不许另起一套视觉语言（蓝条＋一行灰字）✗。
 *
 * 这条是**源码形状**判据（DOM 级那条靠真机读数收口）：它挡的是"以后又把它改回一行灰字"。
 */
const SRC = readFileSync("src/components/SyncPanel.tsx", "utf8");

describe("SyncPanel：加密空间同步块要用既有视觉零件", () => {
  it("有段标题＋数量胶囊（不是蓝条标题）", () => {
    expect(SRC).toContain('className="sync-hint sync-nearby-group"');
    expect(SRC).toContain('className="sync-nearby-group-count"');
  });

  it("每一条是 sync-nearby-row 卡片 ＋ 头像 ＋ 状态胶囊", () => {
    expect(SRC).toContain('"sync-nearby-row sync-enc-row"');
    expect(SRC).toContain('className="sync-nearby-avatar"');
    expect(SRC).toMatch(/sync-chip" \+ \(s\.unlocked \? " is-on" : ""\)/);
  });

  it("状态点用既有三档（ok/info/warn），锁着走 is-locked 的警示底色", () => {
    expect(SRC).toContain("sync-nearby-dot is-${tone}");
    expect(SRC).toContain('(s.unlocked ? "" : " is-locked")');
  });

  it("⛔ 不再用 set-section 那套（那是设置页的语言，同步面板不用）", () => {
    const start = SRC.indexOf('data-testid="encrypted-sync-state"');
    expect(start).toBeGreaterThan(0);
    const block = SRC.slice(start, start + 2600);
    expect(block).not.toContain("set-section");
  });
});
