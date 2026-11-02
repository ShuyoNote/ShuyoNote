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

  it("⭐ R150：append_block 必须把文本**真的**追加进去（不是写回原样 ✗）", async () => {
    // 现场（owner 2026-10-08 实测）：MCP 连发 20 次 blocks_append ⇒ 每次回 auto_apply:true ✓
    // 而页里**一个字都没多** ✗（content_text 长度不变 ✓）⇒ 这条判据就是钉它的 ✓。
    const onePara = JSON.stringify({
      root: {
        type: "root", version: 1, direction: "ltr", format: "", indent: 0,
        children: [{
          blockId: "b1", type: "paragraph", version: 1, direction: "ltr", format: "", indent: 0, style: "",
          children: [{ type: "text", text: "原有的一段", format: "", style: "", mode: "normal", detail: 0, version: 1 }],
        }],
      },
    });
    vi.mocked(api.getPage).mockResolvedValue({ id: "p1", title: "演示", content_json: onePara, content_text: "原有的一段" } as never);
    vi.mocked(api.savePage).mockResolvedValue({ id: "p1", title: "演示" } as never);

    const r = await applyDraft({ kind: "append_block", pageId: "p1", text: "R150 追加的一行" });

    expect(r.ok, r.message).toBe(true);
    const arg = vi.mocked(api.savePage).mock.calls[0][0];
    expect(String(arg.content_text), "追加的文本必须出现在落库内容里 ✗").toContain("R150 追加的一行");
    const json = JSON.parse(String(arg.content_json));
    expect(json.root.children.length, "块数必须变多（原 1 块 ⇒ 追加后 ≥2 ✓）").toBeGreaterThan(1);
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

describe("applyDraft（属性 / 标签写）", () => {  it("set_page_prop：写属性并回读页面（供界面刷新）", async () => {
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
    expect(api.addTag).toHaveBeenCalledWith("p1", "工作", undefined);
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

// ⭐ pages.update（2026-10-17）：MCP / 插件要把**整页替换**成新正文时走这条路。
//   判据：目标页必须已存在（不偷偷新建 ✗）、Markdown 要真的转成块再落库（不是原文塞进去 ✗）、
//   标题可选、纯文本与 Markdown 二选一。
describe("applyDraft（pages.update 整页替换）", () => {
  it("Markdown 正文：转成块再写回**同一页**，标题可选更新", async () => {
    vi.mocked(api.getPage).mockResolvedValue({
      id: "p1",
      title: "旧标题",
      content_json: "{}",
      content_text: "",
    } as never);
    vi.mocked(api.savePage).mockResolvedValue({ id: "p1", title: "新标题" } as never);

    const r = await applyDraft({
      kind: "update_page",
      pageId: "p1",
      title: "新标题",
      markdown: "# 新标题\n\n第一段正文\n\n- 列表项一\n- 列表项二",
    });

    expect(r.ok, r.message).toBe(true);
    const arg = vi.mocked(api.savePage).mock.calls[0][0];
    expect(arg.id, "必须写回同一页（⛔ 不是新建 ✗）").toBe("p1");
    expect(arg.title).toBe("新标题");
    expect(String(arg.content_text)).toContain("第一段正文");
    const json = JSON.parse(String(arg.content_json));
    expect(json.root.children.length, "Markdown 的标题/段落/列表要各自落块 ✓").toBeGreaterThan(1);
    // ⭐ 2026-10-17：落库前必须补块身份（CRDT 播种明确不造身份；缺了会 R155-SEED FAIL ✗）
    for (const child of json.root.children) {
      expect(typeof child.blockId, "顶层块必须有 blockId（否则播种会失败）").toBe("string");
      expect(String(child.blockId).length).toBeGreaterThan(0);
    }
    expect(vi.mocked(api.createPage)).not.toHaveBeenCalled();
  });

  it("纯文本正文：按行分段写回，不给标题就保留原标题（不传 title）", async () => {
    vi.mocked(api.getPage).mockResolvedValue({ id: "p2", title: "原标题" } as never);
    vi.mocked(api.savePage).mockResolvedValue({ id: "p2", title: "原标题" } as never);

    const r = await applyDraft({ kind: "update_page", pageId: "p2", plain: "A 段\n\nB 段" });

    expect(r.ok, r.message).toBe(true);
    const arg = vi.mocked(api.savePage).mock.calls[0][0];
    expect(arg.title, "没给标题 ⇒ 不该写 title（免得把原标题清空）").toBeUndefined();
    expect(String(arg.content_text)).toContain("A 段");
    expect(String(arg.content_text)).toContain("B 段");
  });

  it("目标页不存在 / 没有新正文 ⇒ 明确失败，且一次写库都不发生", async () => {
    vi.mocked(api.getPage).mockResolvedValue(null as never);
    const r1 = await applyDraft({ kind: "update_page", pageId: "p404", plain: "新正文" });
    expect(r1.ok).toBe(false);
    expect(r1.message).toContain("不存在");
    expect(api.savePage).not.toHaveBeenCalled();

    const r2 = await applyDraft({ kind: "update_page", pageId: "p1", markdown: "  ", plain: "" });
    expect(r2.ok).toBe(false);
    expect(api.savePage).not.toHaveBeenCalled();
  });
});
