// 落库层（applyDraft）的行为：草稿 → 确认 → 落库这条边界只有这一处。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  api: {
    createPage: vi.fn(),
    getPage: vi.fn(),
    savePage: vi.fn(),
    setPageProp: vi.fn(),
    addTag: vi.fn(),
  },
}));

import { api } from "../api";
import { applyDraft } from "./apply";

// 顶层：两个 describe 都要清 mock，否则第二个里的"未被调用"断言会被上一个测试污染。
beforeEach(() => vi.resetAllMocks());

describe("applyDraft（落库层）", () => {

  it("create_page 只给纯文本时，在落库这一刻才构造 content_json", async () => {
    // 插件侧（Rust）只知道纯文本，Lexical 的块结构只该在 TS 这一层被构造。
    vi.mocked(api.createPage).mockResolvedValue({ id: "p1", title: "周报" } as never);

    const r = await applyDraft({
      kind: "create_page",
      args: { title: "周报", content_text: "第一段\n\n第二段" },
    });

    expect(r.ok).toBe(true);
    const arg = vi.mocked(api.createPage).mock.calls[0][0];
    expect(arg.title).toBe("周报");
    const json = JSON.parse(String(arg.content_json));
    expect(json.root.children).toHaveLength(2);
    expect(arg.content_text).toContain("第一段");
  });

  it("空内容也要给一个合法的空 root（不能塞空串）", async () => {
    vi.mocked(api.createPage).mockResolvedValue({ id: "p2", title: "空页" } as never);

    await applyDraft({ kind: "create_page", args: { title: "空页", content_text: "" } });

    const arg = vi.mocked(api.createPage).mock.calls[0][0];
    const json = JSON.parse(String(arg.content_json));
    expect(json.root.type).toBe("root");
    expect(json.root.children).toEqual([]);
  });

  it("显式给了 content_json 就用它，不再重建", async () => {
    vi.mocked(api.createPage).mockResolvedValue({ id: "p3", title: "自定义" } as never);
    const given = '{"root":{"children":[{"type":"paragraph"}],"type":"root","version":1}}';

    await applyDraft({ kind: "create_page", args: { title: "自定义", content_json: given, content_text: "x" } });

    expect(vi.mocked(api.createPage).mock.calls[0][0].content_json).toBe(given);
  });

  it("未知草稿类型明确失败，而不是静默什么都不做", async () => {
    const r = await applyDraft({ kind: "nope" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("未知草稿类型");
  });
});

describe("applyDraft（属性 / 标签写）", () => {
  it("set_page_prop：写属性并回读页面（供界面刷新）", async () => {
    vi.mocked(api.setPageProp).mockResolvedValue(undefined as never);
    vi.mocked(api.getPage).mockResolvedValue({ id: "p1", title: "页", content_json: "{}", content_text: "" } as never);

    const r = await applyDraft({ kind: "set_page_prop", pageId: "p1", attrId: "attr1", value: "进行中" });

    expect(r.ok).toBe(true);
    expect(api.setPageProp).toHaveBeenCalledWith({ page_id: "p1", attr_id: "attr1", value: "进行中" });
    expect(r.page?.id).toBe("p1");
  });

  it("add_tag：按名字加标签（不存在时由后端新建）", async () => {
    vi.mocked(api.addTag).mockResolvedValue(undefined as never);
    vi.mocked(api.getPage).mockResolvedValue({ id: "p1", title: "页" } as never);

    const r = await applyDraft({ kind: "add_tag", pageId: "p1", name: "工作" });

    expect(r.ok).toBe(true);
    expect(api.addTag).toHaveBeenCalledWith("p1", "工作");
    expect(r.message).toContain("工作");
  });

  it("参数不完整时明确失败，不做半截写入", async () => {
    const r1 = await applyDraft({ kind: "set_page_prop", pageId: "p1" });
    expect(r1.ok).toBe(false);
    expect(api.setPageProp).not.toHaveBeenCalled();

    const r2 = await applyDraft({ kind: "add_tag", pageId: "p1", name: "   " });
    expect(r2.ok).toBe(false);
    expect(api.addTag).not.toHaveBeenCalled();
  });
});
