// `files.search` / `files.read` 的**数值参数边界**判据（默认值 / 夹取 / 非法值）。
//
// 为什么单开一个文件（2026-09-18）：对着注册表核对时发现同一个坑在四个适配器上各犯了一遍 ——
// 「`limit` 不是正数就当成没传」：
//   · `files.search`：`limit=0` ⇒ TS 给 10，而 Rust `clamp(1,100)` 给 **1**；
//   · `files.read`  ：`limit=0` ⇒ TS 给 200，而 Rust `clamp(1,1000)` 给 **1**；
//   （`pages.get` / `blocks.list` / `pages.search` 是同一类，已在各自的判据里钉住。）
// 这类分歧两边都能跑、都返回合理结果，只能靠"三处摆一起"或机器判据发现。
// 现在两侧共用同一个读法（TS 的 `intArg` ↔ Rust 的 `arg_i64` + `clamp`），这里钉住它的边界行为。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  api: {
    search: vi.fn(),
    getPage: vi.fn(),
    getPageBlocks: vi.fn(),
    getBacklinks: vi.fn(),
    listPageAttachments: vi.fn(),
    createPage: vi.fn(),
    searchChunks: vi.fn(),
    readAttachmentText: vi.fn(),
  },
}));

import { api } from "../api";
import { FRONTEND_ADAPTERS } from "./frontend";

const CTX = { currentPageId: "p1", pages: [] } as never;

// 不用 `Array.prototype.at`（本仓的 lib 目标是 ES2021，`tsc` 会报 TS2550）。
const lastCall = (fn: unknown): unknown[] | undefined => {
  const calls = (fn as ReturnType<typeof vi.fn>).mock.calls;
  return calls.length ? calls[calls.length - 1] : undefined;
};

describe("files.search：limit 边界", () => {
  const call = (args: Record<string, unknown>) => FRONTEND_ADAPTERS["files.search"]!(args, CTX);
  const seen = () => lastCall(api.searchChunks)?.[1];

  beforeEach(() => {
    vi.clearAllMocks();
    (api.searchChunks as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it("默认 10（注册表 `default: 10`）", async () => {
    await call({ query: "甲" });
    expect(seen()).toBe(10);
  });

  it("**0 与负数 ⇒ 1**（不是「当成没传」=10；Rust 侧 `clamp(1,100)` 就是 1）", async () => {
    await call({ query: "甲", limit: 0 });
    expect(seen()).toBe(1);
    await call({ query: "甲", limit: -7 });
    expect(seen()).toBe(1);
  });

  it("超上限 ⇒ 100（Rust `clamp(1,100)`）", async () => {
    await call({ query: "甲", limit: 9999 });
    expect(seen()).toBe(100);
  });

  it("非法值 ⇒ 默认 10（别把 NaN 传下去）", async () => {
    await call({ query: "甲", limit: Number.NaN });
    expect(seen()).toBe(10);
    await call({ query: "甲", limit: "abc" });
    expect(seen()).toBe(10);
  });
});

describe("files.read：offset/limit 边界", () => {
  const call = (args: Record<string, unknown>) => FRONTEND_ADAPTERS["files.read"]!(args, CTX);
  const seen = () =>
    lastCall(api.readAttachmentText)?.slice(1, 3);

  beforeEach(() => {
    vi.clearAllMocks();
    (api.readAttachmentText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      segments: [],
      total: 0,
      truncated: false,
    });
  });

  it("默认 offset 0 / limit 200（注册表 `default: 0 / 200`）", async () => {
    await call({ id: "a1" });
    expect(seen()).toEqual([0, 200]);
  });

  it("**limit=0 ⇒ 1**、`offset` 负数 ⇒ 0（Rust 侧 `limit.clamp(1,1000)` + `offset.max(0)`）", async () => {
    await call({ id: "a1", offset: -5, limit: 0 });
    expect(seen()).toEqual([0, 1]);
  });

  it("超上限 ⇒ 1000（Rust `MAX_ATT_TEXT_LIMIT`）", async () => {
    await call({ id: "a1", limit: 99999 });
    expect(seen()).toEqual([0, 1000]);
  });

  it("小数 ⇒ **回落默认值**（Rust 的 `arg_i64` 用 `as_i64()`，`2.5` 拿不到值 ⇒ 默认；取地板会让两端不同）", async () => {
    await call({ id: "a1", offset: 2.7, limit: 3.9 });
    expect(seen()).toEqual([0, 200]);
  });

  it("整数字符串可以（`\"7\"` ⇒ 7，与 Rust 的 `parse()` 一致，也接受前置 `+`）", async () => {
    await call({ id: "a1", offset: "5", limit: "+7" });
    expect(seen()).toEqual([5, 7]);
  });

  it("附件不存在 ⇒ `file: null`（与「还没抽过」的 `segments: []` 分开，这条是既有语义）", async () => {
    (api.readAttachmentText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = (await call({ id: "nope" })) as unknown as { ok: boolean; file: unknown };
    expect(r.ok).toBe(true);
    expect(r.file).toBeNull();
  });
});
