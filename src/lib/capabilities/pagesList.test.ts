// `pages.list` 的口径判据（2026-10-17 进 AI/MCP 面）。
//
// 为什么要单独钉：它是外部 agent **搜索之外的唯一发现通路**（搜不到时靠它知道"这个空间有什么"），
// 两件事错一件就等于没给：① `limit` 的默认 50 / 上限 200（与注册表、Rust `cap_pages_list`
// 的 `clamp(1, 200)` 逐值一致）；② **按 `updated_at` 倒序**——`api.listPages()` 给的是侧栏树的
// `sort_order/created_at` 顺序，直接截断会让 agent 看到的是"最早建的 50 页"而不是"最近改过的"。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  api: { listPages: vi.fn(), listWorkspacePages: vi.fn() },
}));

import { api } from "../api";
import { FRONTEND_ADAPTERS } from "./frontend";

const CTX = { currentPageId: "p1", pages: [] } as never;
const run = () => FRONTEND_ADAPTERS["pages.list"]!;
const listMock = () => api.listPages as unknown as ReturnType<typeof vi.fn>;

/** `api.listPages()` 的最小形状（PageMeta）；这里只关心 id / updated_at 与映射字段。 */
const page = (id: string, updatedAt: number) =>
  ({
    id,
    workspace_id: "s1",
    parent_id: null,
    title: `标题 ${id}`,
    icon: "",
    kind: "page",
    sort_order: 0,
    created_at: 1,
    updated_at: updatedAt,
    deleted_at: null,
  }) as never;

describe("pages.list：limit 口径 + 按更新时间倒序", () => {
  beforeEach(() => vi.clearAllMocks());

  it("默认 50 条（与注册表 `default: 50` 一致）", async () => {
    listMock().mockResolvedValue(Array.from({ length: 300 }, (_, i) => page(`p${i}`, i)));
    const out = (await run()({}, CTX)) as { pages: unknown[] };
    expect(out.pages.length).toBe(50);
  });

  it("超过上限 ⇒ 夹到 200（与 Rust 的 `limit.clamp(1, 200)` 一致）", async () => {
    listMock().mockResolvedValue(Array.from({ length: 300 }, (_, i) => page(`p${i}`, i)));
    const out = (await run()({ limit: 999 }, CTX)) as { pages: unknown[] };
    expect(out.pages.length).toBe(200);
  });

  it("`limit=0`/负数 ⇒ 夹到 1（不是「当成没传」=50）", async () => {
    listMock().mockResolvedValue(Array.from({ length: 300 }, (_, i) => page(`p${i}`, i)));
    expect(((await run()({ limit: 0 }, CTX)) as { pages: unknown[] }).pages.length).toBe(1);
    expect(((await run()({ limit: -3 }, CTX)) as { pages: unknown[] }).pages.length).toBe(1);
  });

  it("按 updated_at 倒序，且只给四格字段（不带 workspace_id 这类内部列）", async () => {
    listMock().mockResolvedValue([page("a", 10), page("b", 30), page("c", 20)]);
    const out = (await run()({}, CTX)) as { pages: Array<Record<string, unknown>> };
    expect(out.pages.map((p) => p.id)).toEqual(["b", "c", "a"]);
    expect(Object.keys(out.pages[0]).sort()).toEqual(
      ["created_at", "id", "title", "updated_at"].sort(),
    );
  });

  // ⭐ 2026-10-18：`spaceId` —— 列别的空间走 `listWorkspacePages`（只读、不动活动空间 ✓）。
  it("给了 spaceId ⇒ 走 listWorkspacePages（不是 listPages）", async () => {
    const bySpace = api.listWorkspacePages as unknown as ReturnType<typeof vi.fn>;
    bySpace.mockResolvedValue([page("x", 5), page("y", 9)]);
    const out = (await run()({ spaceId: "s2" }, CTX)) as { pages: Array<{ id: string }> };
    expect(bySpace).toHaveBeenCalledWith("s2");
    expect(listMock()).not.toHaveBeenCalled();
    expect(out.pages.map((p) => p.id)).toEqual(["y", "x"]);
  });
});

