// 落库层（applyDraft）的行为：草稿 → 确认 → 落库这条边界只有这一处。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  api: { createPage: vi.fn(), getPage: vi.fn(), savePage: vi.fn() },
}));

import { api } from "../api";
import { applyDraft } from "./apply";

describe("applyDraft（落库层）", () => {
  beforeEach(() => vi.resetAllMocks());

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
