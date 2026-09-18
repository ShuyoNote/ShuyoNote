// `blocks.list` 的**两侧一致性**判据。
//
// 为什么单开一个文件（2026-09-18）：对着注册表逐条核对时发现这条适配器有两处分歧，
// 而它们**不会让任何测试变红**、也**没有编译期信号**：
//   ① 注册表声明 `pageId` 可选（省略 = 当前打开的页面），TS 侧却当必填直接报错
//      —— 桌面路径（Rust `cap_blocks_list` → `target_page_or_current`）是支持省略的
//      ⇒ 同一段插件代码在桌面能用、在 Web 报错；
//   ② 注册表声明 `limit`（默认 100、上限 500），TS 侧**根本没读** ⇒ Web 上"传了也没用"，
//      而 Rust 侧 `limit.clamp(1, 500).take(limit)` 是兑现的。
//
// 另一条同类判据在 `scripts/check-capabilities.mjs`（**机器**比对注册表与两侧参数口径）；
// 这里钉的是**行为**：值真的生效、默认值与上限与 Rust 相同、边界（0/负数/超上限）不跑偏。

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
const run = () => FRONTEND_ADAPTERS["blocks.list"]!;

const mockBlocks = (n: number) =>
  (api.getPageBlocks as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    Array.from({ length: n }, (_, i) => ({ block_id: `b${i}`, text: `t${i}` })),
  );

interface ListOut {
  ok: boolean;
  error?: string;
  blocks: Array<{ blockId: string; text: string }>;
}

describe("blocks.list：注册表声明的东西必须真的生效", () => {
  beforeEach(() => vi.clearAllMocks());

  it("`limit` 兑现：传 2 就只返回前 2 块（修前是「传了也没用」）", async () => {
    mockBlocks(5);
    const r = (await run()({ pageId: "p1", limit: 2 }, CTX)) as unknown as ListOut;
    expect(r.ok).toBe(true);
    expect(r.blocks.map((b) => b.blockId)).toEqual(["b0", "b1"]);
  });

  it("默认 100（与注册表 `default: 100` 一致）", async () => {
    mockBlocks(150);
    const r = (await run()({ pageId: "p1" }, CTX)) as unknown as ListOut;
    expect(r.blocks).toHaveLength(100);
  });

  it("上限 500（与 Rust 的 `limit.clamp(1, 500)` 一致，不能各夹各的）", async () => {
    mockBlocks(600);
    const r = (await run()({ pageId: "p1", limit: 99999 }, CTX)) as unknown as ListOut;
    expect(r.blocks).toHaveLength(500);
  });

  it("**边界 `limit=0` 夹到 1**（写 `args.limit || 100` 会把它当成没传 ⇒ 与 Rust 分道扬镳）", async () => {
    mockBlocks(5);
    const r = (await run()({ pageId: "p1", limit: 0 }, CTX)) as unknown as ListOut;
    expect(r.blocks).toHaveLength(1);
    const neg = (await run()({ pageId: "p1", limit: -3 }, CTX)) as unknown as ListOut;
    expect(neg.blocks).toHaveLength(1);
  });

  it("`pageId` **可以省略**：用当前打开的页面（与注册表 desc、Rust 侧一致）", async () => {
    mockBlocks(2);
    const r = (await run()({}, { currentPageId: "p9", pages: [] } as never)) as unknown as ListOut;
    expect(r.ok).toBe(true);
    expect(api.getPageBlocks).toHaveBeenCalledWith("p9");
  });

  it("既没传 pageId、也没有当前页 ⇒ `ok:false`（这是真的缺参数，不是「页面不存在」）", async () => {
    mockBlocks(2);
    const r = (await run()({}, { currentPageId: "", pages: [] } as never)) as unknown as ListOut;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("pageId");
  });
});
