// `pages.get` 截断行为的判据。
//
// 为什么单独立一个文件而不是塞进 `tools.test.ts`：那份文件是**多人协作在改的**，
// 把这条放进去平白增加冲突面（今天已经因为共用检出吃过两次亏）。
//
// 这条判据要钉的原则与抽取层的 `ExtractCoverage`（方案 §15.10）是同一条：
// **"成功"不等于"读全了"** —— 只是这次发生在 AI 工具面而不是抽取层。

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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
  offset: number;
  limit: number;
  note?: string;
}

/** 参照口径：按**码点**切窗口（Rust 侧是 `chars().skip().take()`，同一条）。 */
const cpSlice = (s: string, off: number, lim: number) => Array.from(s).slice(off, off + lim).join("");

/** 有没有不成对的代理码元（写成码点比较，免得判据自己踩转义坑）。 */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
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

// ── 分页（2026-09-18 加）：`offset`/`limit` 让"读全一页"变成**可达**，而不是只报一句"已截断"。
describe("pages.get：分页口径", () => {
  beforeEach(() => vi.clearAllMocks());

  it("`offset=6000&limit=6000` 必须**逐字**等于 `slice(6000,12000)`（不能差一）", async () => {
    const body = Array.from({ length: 20000 }, (_, i) => String.fromCharCode(0x4e00 + (i % 200))).join("");
    mockPage("长", body);
    const r = (await run()({ id: "p1", offset: 6000, limit: 6000 }, CTX)) as unknown as { page: PageOut };
    expect(r.page.content_text).toBe(cpSlice(body, 6000, 6000));
    expect(r.page.offset).toBe(6000);
    expect(r.page.chars_total).toBe(20000);
    expect(r.page.chars_returned).toBe(6000);
    expect(r.page.truncated).toBe(true);
    // 接着读的**下一步**必须是可执行的：note 里给的 offset 就是真正的下一段起点
    expect(r.page.note).toContain("offset=12000");
  });

  it("**按码点**切：emoji 不会被切成孤立代理，也不会被算成 2 个字", async () => {
    const body = "😀".repeat(100); // 100 个码点 / 200 个 UTF-16 码元
    mockPage("T", body);
    const r = (await run()({ id: "p1", offset: 10, limit: 5 }, CTX)) as unknown as { page: PageOut };
    expect(r.page.content_text).toBe("😀".repeat(5));
    expect(r.page.chars_total).toBe(100); // 不是 200
    expect(r.page.chars_returned).toBe(5);
    // 孤立代理的判据：不许出现没有配对的 \uD800-\uDFFF 码元
    expect(hasLoneSurrogate(r.page.content_text)).toBe(false);
    expect(cpSlice(body, 6000, 6000)).toBe(""); // 顺带钉住参照实现的越界行为
  });

  it("`offset` 翻过头 ⇒ **空串 + 真实总数**，不是报错（调用方要能区分「翻完了」和「这页是空的」）", async () => {
    mockPage("T", "甲".repeat(100));
    const r = (await run()({ id: "p1", offset: 500, limit: 6000 }, CTX)) as unknown as { ok: boolean; page: PageOut };
    expect(r.ok).toBe(true);
    expect(r.page.content_text).toBe("");
    expect(r.page.chars_total).toBe(100); // 真实总数仍然给
    expect(r.page.chars_returned).toBe(0);
    expect(r.page.truncated).toBe(false); // 没有"还没读完"这回事
    expect(r.page.note).toContain("已到正文末尾");
  });

  it("翻到**最后一页**时 `truncated:false`（否则模型会以为还有内容、无限翻）", async () => {
    mockPage("T", "乙".repeat(6500));
    const r = (await run()({ id: "p1", offset: 6000, limit: 6000 }, CTX)) as unknown as { page: PageOut };
    expect(r.page.chars_returned).toBe(500);
    expect(r.page.truncated).toBe(false);
    expect(r.page.note).toContain("已到正文末尾");
  });

  it("`limit` 超过上限 ⇒ 夹到 MAX（一次几十万字会把上下文撑爆）", async () => {
    mockPage("T", "丙".repeat(30000));
    const r = (await run()({ id: "p1", limit: 999999 }, CTX)) as unknown as { page: PageOut };
    expect(r.page.limit).toBe(20000);
    expect(r.page.chars_returned).toBe(20000);
  });

  it("**不做 trim**：窗口起点锚在原文上，与桌面路径（Rust）切的是同一个字符串", async () => {
    // trim 会让 `offset=6000` 在两条路径上指向不同字符 ⇒ 漏字/重字，只在首尾有空白时出现
    const body = "  " + "丁".repeat(10) + "  ";
    mockPage("T", body);
    const r = (await run()({ id: "p1", offset: 0, limit: 4 }, CTX)) as unknown as { page: PageOut };
    expect(r.page.content_text).toBe(body.slice(0, 4)); // 前两个空格必须原样保留
    expect(r.page.chars_total).toBe(14);
  });
});

// ── 跨语言一致性：TS 适配器与 Rust `cap_pages_get` 读**同一份夹具**（`tests/pages-get-window-parity.json`）。
// 为什么值得单开一条：同一个页面在 web 路径与桌面路径上会被分窗口读取，两侧口径漂移
// **没有任何编译期信号**（比如有人把 TS 侧的 `Array.from` 换回 `slice`），而症状只是
// emoji/生僻字处偶尔漏一个字——等到有人发现时已经没人记得改过什么了。
describe("pages.get：与 Rust 侧共用的分页夹具", () => {
  beforeEach(() => vi.clearAllMocks());

  interface Case {
    name: string;
    unit: number[];
    repeat: number;
    offset: number;
    limit: number;
    expectOffset: number;
    expectLimit: number;
    expectTotal: number;
    expectReturned: number;
    expectTruncated: boolean;
    expectMissing?: boolean;
    idProbe?: string;
  }
  const fixture: { defaultLimit: number; limitMax: number; cases: Case[] } = JSON.parse(
    readFileSync(join(root, "tests", "pages-get-window-parity.json"), "utf8"),
  );

  it("夹具本身非空（别让一条空循环假装通过）", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(6);
    expect(fixture.defaultLimit).toBe(6000);
    expect(fixture.limitMax).toBe(20000);
  });

  for (const c of fixture.cases) {
    it(c.name, async () => {
      // `expectMissing`：这条用例验的是**参数原样传下去**（不 trim/不归一），不是窗口 ——
      // 所以让 page 查不到（mock 返回 null），断言"查不到"这件事本身。
      if (c.expectMissing) {
        (api.getPage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        const r = (await run()({ id: c.idProbe, offset: 0, limit: 10 }, CTX)) as unknown as {
          ok: boolean;
          error: string;
        };
        expect(r.ok).toBe(false);
        // 关键：**原样**把 id 传给了下层（首尾空格 / 大小写都没被改写）
        expect((api.getPage as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(c.idProbe);
        return;
      }
      const text = c.unit.map((cp) => String.fromCodePoint(cp)).join("").repeat(c.repeat);
      mockPage("夹具", text);
      const r = (await run()({ id: "p1", offset: c.offset, limit: c.limit }, CTX)) as unknown as {
        ok: boolean;
        page: PageOut;
      };
      expect(r.ok).toBe(true);
      expect(r.page.chars_total).toBe(c.expectTotal);
      expect(r.page.chars_returned).toBe(c.expectReturned);
      expect(r.page.truncated).toBe(c.expectTruncated);
      expect(r.page.offset).toBe(c.expectOffset);
      expect(r.page.limit).toBe(c.expectLimit);
      // 参照实现**独立**写一遍（不用 src 里的 `sliceByCodePoints`），否则就是拿实现验实现。
      const reference = [...text].slice(c.expectOffset, c.expectOffset + c.expectLimit).join("");
      expect(r.page.content_text).toBe(reference);
      expect(hasLoneSurrogate(r.page.content_text)).toBe(false);
    });
  }
});
