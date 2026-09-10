// AI 工具层现在只是「注册表元数据 + 前端适配表」的组合；这里钉住它没在重构中走形。
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
import { aiTools, aiToolSummaries, getAiTool } from "./tools";

const CTX = { currentPageId: "p1", pages: [] };

const EXPECTED = [
  "backlinks.list",
  "blocks.append",
  "blocks.list",
  "files.list",
  "pages.create",
  "pages.get",
  "pages.search",
];

describe("AI 工具层 = 能力注册表（元数据）+ 前端适配表（实现）", () => {
  beforeEach(() => vi.resetAllMocks());

  it("工具清单与注册表一致：id 齐全、读写标记正确、描述非空", () => {
    expect(aiTools.map((t) => t.id).sort()).toEqual([...EXPECTED].sort());
    const byId = Object.fromEntries(aiTools.map((t) => [t.id, t]));
    expect(byId["pages.create"].isWrite).toBe(true);
    expect(byId["blocks.append"].isWrite).toBe(true);
    expect(byId["pages.search"].isWrite).toBe(false);
    // 系统提示就是靠这些描述让模型选工具的
    const summaries = aiToolSummaries();
    for (const id of EXPECTED) expect(summaries).toContain(id);
  });

  it("读取类：参数按注册表命名映射到既有 api，返回形状保持不变", async () => {
    vi.mocked(api.search).mockResolvedValue([{ id: "p1", title: "T", snippet: "S" }] as never);

    const r = (await getAiTool("pages.search")!.run({ q: "关键词", limit: 3 }, CTX)) as Record<string, any>;

    expect(api.search).toHaveBeenCalledWith("关键词", 3, false);
    expect(r.ok).toBe(true);
    expect(r.pages[0]).toEqual({ id: "p1", title: "T", snippet: "S" });
  });

  it("写入类：只产出草稿，绝不直接落库", async () => {
    const r = (await getAiTool("pages.create")!.run({ title: "周报", content: "正文" }, CTX)) as Record<string, any>;

    expect(r.draft).toBe(true);
    expect(r.summary).toContain("周报");
    expect(r.payload.kind).toBe("create_page");
    expect(api.createPage).not.toHaveBeenCalled();
  });

  it("缺必填参数时明确报错，且不触碰 api", async () => {
    const r = (await getAiTool("pages.search")!.run({}, CTX)) as Record<string, any>;

    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("pages.search");
    expect(api.search).not.toHaveBeenCalled();
  });
});

describe("省略 pageId 时用宿主的当前页（与插件侧同一语义）", () => {
  beforeEach(() => vi.resetAllMocks());

  it("backlinks.list 不传 pageId → 用 ctx.currentPageId", async () => {
    vi.mocked(api.getBacklinks).mockResolvedValue([{ id: "p2", title: "来源" }] as never);

    const r = (await getAiTool("backlinks.list")!.run({}, { currentPageId: "p9", pages: [] })) as Record<string, any>;

    expect(api.getBacklinks).toHaveBeenCalledWith("p9");
    expect(r.backlinks[0]).toEqual({ id: "p2", title: "来源" });
  });
});
