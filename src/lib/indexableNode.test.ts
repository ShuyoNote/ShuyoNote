// `isIndexableNode` 判据（2026-10-18）：**只排除 `folder`** —— 其余（`page`/`database`/未知）
// 都该进索引。用排除法而不是白名单，是因为 kind 缺失（老载荷/夹具）在运行时不该被静默丢掉。

import { describe, expect, it } from "vitest";
import { isIndexableNode } from "./indexableNode";

describe("isIndexableNode", () => {
  it("page / database 可索引", () => {
    expect(isIndexableNode("page")).toBe(true);
    expect(isIndexableNode("database")).toBe(true);
  });

  it("folder 不可索引（没有正文，get_page 会拒）", () => {
    expect(isIndexableNode("folder")).toBe(false);
  });

  it("kind 缺失（老载荷/夹具）⇒ 当作可索引（⛔ 不静默丢页）", () => {
    expect(isIndexableNode(undefined)).toBe(true);
    expect(isIndexableNode(null)).toBe(true);
    expect(isIndexableNode("")).toBe(true);
  });
});
