// `pages.get` 截断行为的判据。
//
// 为什么单独立一个文件而不是塞进 `tools.test.ts`：那份文件是**多人协作在改的**，
// 把这条放进去平白增加冲突面（今天已经因为共用检出吃过两次亏）。
//
// 这条判据要钉的原则与抽取层的 `ExtractCoverage`（方案 §15.10）是同一条：
// **"成功"不等于"读全了"** —— 只是这次发生在 AI 工具面而不是抽取层。

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
const run = () => FRONTEND_ADAPTERS["pages.get"]!;

function mockPage(title: string, content_text: string) {
  (api.getPage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "p1",
    title,
    content_text,
  });
}

interface PageOut {
  content_text: string;
  truncated: boolean;
  chars_total: number;
  chars_returned: number;
  note?: string;
}

describe("pages.get：截断必须**说清楚**", () => {
  beforeEach(() => vi.clearAllMocks());

  it("短页面：不标截断、返回全文字数、**不给 note**（别用噪声干扰模型）", async () => {
    mockPage("T", "短正文");
    const r = (await run()({ id: "p1" }, CTX)) as unknown as { ok: boolean; page: PageOut };
    expect(r.ok).toBe(true);
    expect(r.page).toMatchObject({ truncated: false, chars_total: 3, chars_returned: 3 });
    expect(r.page.content_text).toBe("短正文");
    expect(r.page.note).toBeUndefined();
  });

  it("长页面：`truncated:true` + 总字数 + **告诉模型下一步怎么办**", async () => {
    mockPage("长制度", "甲".repeat(9000));
    const r = (await run()({ id: "p1" }, CTX)) as unknown as { ok: boolean; page: PageOut };
    expect(r.page.truncated).toBe(true);
    expect(r.page.chars_total).toBe(9000);
    expect(r.page.chars_returned).toBe(6000);
    expect(r.page.content_text).toHaveLength(6000);
    // 只说"已截断"是不够的：模型得知道**该去做什么**
    expect(r.page.note).toContain("9000");
    expect(r.page.note).toContain("pages.search");
    expect(r.page.note).toContain("blocks.list");
  });

  it("**不再自作主张补 `…`**：返回的必须是原文的**忠实前缀**", async () => {
    const body = "乙".repeat(9000);
    mockPage("T", body);
    const r = (await run()({ id: "p1" }, CTX)) as unknown as { page: PageOut };
    // 补了省略号就**不是**前缀 —— 原文本身可能就以省略号结尾，模型分不清哪个是我们加的
    expect(r.page.content_text).toBe(body.slice(0, 6000));
    expect(r.page.content_text.endsWith("…")).toBe(false);
  });

  it("**恰好等于上限**不算截断（边界不能差一）", async () => {
    mockPage("T", "丙".repeat(6000));
    const r = (await run()({ id: "p1" }, CTX)) as unknown as { page: PageOut };
    expect(r.page.truncated).toBe(false);
    expect(r.page.chars_returned).toBe(6000);
    expect(r.page.note).toBeUndefined();
  });

  it("缺 id / 页面不存在 ⇒ `ok:false`（与既有行为一致，没顺手改掉）", async () => {
    const noId = (await run()({}, CTX)) as unknown as { ok: boolean; error: string };
    expect(noId.ok).toBe(false);
    expect(noId.error).toContain("id");

    (api.getPage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const missing = (await run()({ id: "nope" }, CTX)) as unknown as { ok: boolean; error: string };
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("nope");
  });
});
