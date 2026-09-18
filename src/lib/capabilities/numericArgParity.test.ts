// 数值型参数（`limit` / `offset`）的**跨语言口径**判据：与 Rust 侧读**同一份夹具**
// （`tests/numeric-arg-parity.json`，Rust 侧在 `src-tauri/src/plugins.rs`）。
//
// 为什么必须共用一份（2026-09-18）：这一天里同一族分歧连着出现五次 —— `blocks.list` 参数不兑现、
// `pages.search` 默认值 20 vs 8、四个适配器把 `0` 当成"没传"、`intArg` 取地板、
// **整数值浮点**（`2.0`）。它们共同点是：**两侧都跑得通、都返回"合理"结果、各自测试全绿**，
// 只有把两边的值摆在一起才看得见。门禁（`check-capabilities`）能比的是**字面默认值**与
// 「声明了就得两侧都读」，比不了"取到什么值"——那一层只能靠这份夹具。
//
// ★ 夹具里 `rawArgs` 存的是**原始 JSON 文本**，不是解析后的值：JS 的 `JSON.parse` 会把 `2.0`
//   折成 `2`（语言层面分不出），只有保住原始 token，Rust 侧才可能在"线上写的是 2.0"这个情形上
//   与 Web 侧对齐。也正因为这个折叠，**只能 Rust 侧让步**（接受小数部分为 0 的浮点），
//   TS 侧无论怎么写都看不到 `2.0` 与 `2` 的区别。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

interface Case {
  name: string;
  rawArgs: string;
  expectLimit: number;
  expectOffset: number;
}
interface Fixture {
  capability: string;
  defaultLimit: number;
  limitMax: number;
  cases: Case[];
}

// 夹具路径按 vitest 的工作目录（仓库根）解析：`import.meta.url` 在 Vite 转换后不是 file: URL。
const fixture: Fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "tests", "numeric-arg-parity.json"), "utf8"),
) as Fixture;

const PAGE_ID = "p1";
const getPage = api.getPage as unknown as ReturnType<typeof vi.fn>;

describe("数值参数：与 Rust 侧共用同一份夹具", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPage.mockResolvedValue({ id: PAGE_ID, title: "T", content_text: "甲".repeat(3000) });
  });

  it("夹具本身非空，且与注册表/实现的默认值与上限一致", () => {
    expect(fixture.capability).toBe("pages.get");
    expect(fixture.cases.length).toBeGreaterThanOrEqual(15);
    // 默认值与上限改了就这里先红（两侧夹具 + 注册表 desc 三处必须同源）
    expect(fixture.defaultLimit).toBe(6000);
    expect(fixture.limitMax).toBe(20000);
  });

  it("★ 每个边界值：Web 侧取到的 limit / offset 必须等于夹具期望（Rust 侧读同一份）", async () => {
    const adapter = FRONTEND_ADAPTERS["pages.get"]!;
    for (const c of fixture.cases) {
      const args = JSON.parse(c.rawArgs.replace("ID", PAGE_ID)) as Record<string, unknown>;
      const out = (await adapter(args, undefined as never)) as {
        ok: boolean;
        page?: { limit?: unknown; offset?: unknown };
        error?: string;
      };
      expect(out.ok, `${c.name}：${out.error ?? ""}`).toBe(true);
      expect(out.page?.limit, `${c.name}（limit）`).toBe(c.expectLimit);
      expect(out.page?.offset, `${c.name}（offset）`).toBe(c.expectOffset);
    }
  });

  it("反例：`2.5` 与 `2.0` 必须区分开（前者回落默认、后者就是 2）", async () => {
    const adapter = FRONTEND_ADAPTERS["pages.get"]!;
    const of = async (raw: string) => {
      const out = (await adapter(JSON.parse(`{"id":"${PAGE_ID}","offset":0,"limit":${raw}}`), undefined as never)) as {
        page?: { limit?: unknown };
      };
      return out.page?.limit;
    };
    expect(await of("2.5")).toBe(6000);
    expect(await of("2.0")).toBe(2);
    expect(await of("2")).toBe(2);
  });
});
