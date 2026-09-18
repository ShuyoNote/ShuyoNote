// `pages.search` 的 `limit` 口径判据（默认 8、夹到 1..100）。
//
// 为什么单开一条（2026-09-18）：机器比对注册表与 **Rust** 的字面默认值时发现
// `pages.search.limit` 注册表写 8、Rust dispatch 却是 `arg_i64("limit", 20)`
// ⇒ 桌面上默认返回 20 条、Web 上 8 条，而模型看到的工具说明（生成物）写的是 8。
// 这类分歧**两边都能跑、都返回合理结果**，只有把三处摆在一起才看得见
// （`scripts/check-capabilities.mjs` 现在比对注册表↔Rust；这里钉 Web 侧的值与夹取）。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  api: {
    search: vi.fn(),
    getPage: vi.fn(),
    getPageBlocks: vi.fn(),
    getBacklinks: vi.fn(),
    listPageAttachments: vi.fn(),
    createPage: vi.fn(),
  },
}));

import { api } from "../api";
import { FRONTEND_ADAPTERS } from "./frontend";

const CTX = { currentPageId: "p1", pages: [] } as never;
const run = () => FRONTEND_ADAPTERS["pages.search"]!;
const searchMock = () => api.search as unknown as ReturnType<typeof vi.fn>;

describe("pages.search：limit 默认值与上限", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchMock().mockResolvedValue([]);
  });

  it("不传 limit ⇒ 8（与注册表 `default: 8` 一致）", async () => {
    await run()({ q: "甲" }, CTX);
    expect(searchMock().mock.calls[0][1]).toBe(8);
  });

  it("超过上限 ⇒ 夹到 100（与 Rust 的 `limit.clamp(1, 100)` 一致）", async () => {
    await run()({ q: "甲", limit: 999 }, CTX);
    expect(searchMock().mock.calls[0][1]).toBe(100);
  });

  it("`limit=0`/负数 ⇒ 夹到 1（不是「当成没传」=8）", async () => {
    await run()({ q: "甲", limit: 0 }, CTX);
    expect(searchMock().mock.calls[0][1]).toBe(1);
    await run()({ q: "甲", limit: -3 }, CTX);
    expect(searchMock().mock.calls[1][1]).toBe(1);
  });

  it("非法值（`\"abc\"`/`NaN`）⇒ 回到默认 8，而不是把 NaN 传下去", async () => {
    await run()({ q: "甲", limit: "abc" }, CTX);
    expect(searchMock().mock.calls[0][1]).toBe(8);
    await run()({ q: "甲", limit: Number.NaN }, CTX);
    expect(searchMock().mock.calls[1][1]).toBe(8);
  });
});
