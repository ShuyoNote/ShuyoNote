// 「社区帖子 → 笔记」的落库那一半：**建页 → 真标签 → 属性**，以及"哪一步没成"怎么说。
//
// owner 2026-09-21 拍板的口径（A 混合）：正文保原帖 + 最前面保留一行纯文本来源（幂等/导出靠它）、
// 标签落成**真标签**、来源/作者/发布于/存于落成**属性**。这里钉的就是这三样的顺序、取值与失败话术。
import { describe, expect, it, vi } from "vitest";
import { NOTE_ATTR_SPECS, communityDateTime, localNow, savePostAsNote } from "./communitySaveNote";
import type { CommunityPost } from "./communityPost";
import { usePropertyUiStore } from "../store/propertyUi";

const post: CommunityPost = {
  id: "55",
  title: "企业知识库的两条路",
  bodyMarkdown: "### 一、前提\n\n正文",
  author: "cnzen",
  createdAt: "2026-09-20 11:29:02",
  updatedAt: "",
  tags: ["数据主权", "企业知识库"],
  url: "https://community.shuyo.cn/post/abc",
};

const ATTRS = [
  { id: "a-src", name: "来源", attr_type: "text", options: [] },
  { id: "a-author", name: "作者", attr_type: "text", options: [] },
  { id: "a-pub", name: "发布于", attr_type: "datetime", options: [] },
  { id: "a-saved", name: "存于", attr_type: "datetime", options: [] },
];

/** 一个记账用的假执行器：`over` 可以覆盖某条命令（造失败）。 */
function fakeInvoke(over: Record<string, (args?: unknown) => unknown> = {}) {
  const calls: Array<{ cmd: string; args?: unknown }> = [];
  const invoke = vi.fn(async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    if (over[cmd]) return over[cmd](args);
    if (cmd === "list_attr_defs") return ATTRS;
    if (cmd === "create_attr") return { id: "new-attr", name: "x", attr_type: "text", options: [] };
    return undefined;
  });
  return { invoke: invoke as never, calls };
}

const deps = (invoke: unknown, createPage?: unknown, now?: Date) => ({
  createPage: (createPage ?? (async () => "page-1")) as never,
  invoke: invoke as never,
  now,
});

describe("savePostAsNote —— 建页 → 真标签 → 属性", () => {
  it("建页带来源行；标签走 add_tag；四个属性按顺序写（含取值）", async () => {
    const { invoke, calls } = fakeInvoke();
    const now = new Date("2026-09-21T05:06:07");
    const r = await savePostAsNote(post, deps(invoke, undefined, now));

    expect(r).toEqual({ pageId: "page-1", error: "", warnings: [] });
    // ① 建页：正文最前面是来源行（纯文本地址 —— 幂等靠它）
    expect(calls[0].cmd).toBe("add_tag"); // createPage 不在 calls 里（它是另一条依赖）
    const tags = calls.filter((c) => c.cmd === "add_tag").map((c) => (c.args as { name: string }).name);
    expect(tags).toEqual(["数据主权", "企业知识库"]);
    // ② 属性：先问定义（已有就不再建），再按 来源/作者/发布于/存于 写值
    expect(calls.some((c) => c.cmd === "create_attr")).toBe(false);
    const props = calls
      .filter((c) => c.cmd === "set_page_prop")
      .map((c) => (c.args as { args: { attr_id: string; value: string } }).args);
    expect(props.map((p) => p.attr_id)).toEqual(["a-src", "a-author", "a-pub", "a-saved"]);
    expect(props.map((p) => p.value)).toEqual([
      "https://community.shuyo.cn/post/abc",
      "cnzen",
      // 社区的时间戳**原样**进属性（站点页面也是这么显示的；换时区会让两边对不上）
      "2026-09-20 11:29:02",
      // 「存于」是你收下它的时间 ⇒ 用本地时钟
      "2026-09-21 05:06:07",
    ]);
  });

  it("第一次保存：属性定义不存在 ⇒ 按规格建四个（名字 + 类型）", async () => {
    const created: Array<{ name: string; attr_type: string }> = [];
    const { invoke, calls } = fakeInvoke({
      list_attr_defs: () => [],
      create_attr: (args) => {
        const a = (args as { args: { name: string; attr_type: string } }).args;
        created.push(a);
        return { id: `new-${a.name}`, name: a.name, attr_type: a.attr_type, options: [] };
      },
    });
    const r = await savePostAsNote(post, deps(invoke));
    expect(r.warnings).toEqual([]);
    expect(created).toEqual(NOTE_ATTR_SPECS.map((s) => ({ name: s.name, attr_type: s.attr_type })));
    // 建完就用新建的 id 写值
    const ids = calls
      .filter((c) => c.cmd === "set_page_prop")
      .map((c) => (c.args as { args: { attr_id: string } }).args.attr_id);
    expect(ids).toEqual(["new-来源", "new-作者", "new-发布于", "new-存于"]);
  });

  it("标签没写上 ⇒ 笔记照旧算存下，但**如实带回**哪几个没写上", async () => {
    const { invoke } = fakeInvoke({
      add_tag: (args) => {
        if ((args as { name: string }).name === "数据主权") throw new Error("标签名太长");
        return undefined;
      },
    });
    const r = await savePostAsNote(post, deps(invoke));
    expect(r.pageId).toBe("page-1");
    expect(r.error).toBe("");
    expect(r.warnings).toEqual(["标签「数据主权」没写上（标签名太长）"]);
    // 一个标签失败**不该**挡住属性那一步
    expect(r.warnings.length).toBe(1);
  });

  it("属性那一步整段失败 ⇒ 只报这一条，笔记仍然算存下", async () => {
    const { invoke } = fakeInvoke({ list_attr_defs: () => { throw new Error("库锁住了"); } });
    const r = await savePostAsNote(post, deps(invoke));
    expect(r.pageId).toBe("page-1");
    expect(r.warnings).toEqual(["属性没写上（库锁住了）"]);
  });

  it("社区时间认不出 ⇒ 不写「发布于」（宁缺一个属性，也不写个坏值）", async () => {
    const { invoke, calls } = fakeInvoke();
    await savePostAsNote({ ...post, createdAt: "昨天" }, deps(invoke));
    const ids = calls
      .filter((c) => c.cmd === "set_page_prop")
      .map((c) => (c.args as { args: { attr_id: string } }).args.attr_id);
    expect(ids).toEqual(["a-src", "a-author", "a-saved"]);
  });

  it("正文为空也**照样能存**（正文里至少还有来源行）—— 来源行就是「来路」那一半", async () => {
    const { invoke } = fakeInvoke();
    const r = await savePostAsNote({ ...post, bodyMarkdown: "   " }, deps(invoke));
    expect(r.pageId).toBe("page-1");
    expect(r.error).toBe("");
  });

  // ★ 2026-09-23 用户实测：「社区文章存进笔记后，属性区不能及时看到，需重新打开才有」。
  //   属性区是**自己拉** `getPageProps` 的（本地 state），而这里写属性走的是绕过它的命令
  //   ⇒ 写完必须通知它重拉（否则页面是"先建后写属性"，属性区挂载时拿到的还是空的那一份）。
  it("写完属性要**通知属性区重拉**（否则得重新打开这一页才看得到）", async () => {
    const { invoke } = fakeInvoke();
    const before = usePropertyUiStore.getState().propsRev;
    await savePostAsNote(post, deps(invoke));
    expect(usePropertyUiStore.getState().propsRev).toBe(before + 1);
  });

  it("属性一个都没写成 ⇒ **不**通知（别让属性区白重拉一次）", async () => {
    const { invoke } = fakeInvoke({ list_attr_defs: () => { throw new Error("库锁住了"); } });
    const before = usePropertyUiStore.getState().propsRev;
    const r = await savePostAsNote(post, deps(invoke));
    expect(r.warnings.length).toBe(1);
    expect(usePropertyUiStore.getState().propsRev).toBe(before);
  });
});

describe("时间取值", () => {
  it("社区时间戳 → 应用存储格式（秒级；只到分的补 :00；ISO 的 T 也认）", () => {
    expect(communityDateTime("2026-09-20 11:29:02")).toBe("2026-09-20 11:29:02");
    expect(communityDateTime("2026-09-20 11:29")).toBe("2026-09-20 11:29:00");
    expect(communityDateTime("2026-09-20T11:29:02")).toBe("2026-09-20 11:29:02");
    // ISO 的毫秒 + 末尾 Z（别的部署/老数据可能是这个形状）：只当记号，**不换算时区**
    expect(communityDateTime("2026-09-11T11:00:00Z")).toBe("2026-09-11 11:00:00");
    expect(communityDateTime("2026-09-11T11:00:00.000Z")).toBe("2026-09-11 11:00:00");
    expect(communityDateTime("")).toBe("");
    expect(communityDateTime("昨天")).toBe("");
  });

  it("存于 = 本地时钟，格式与应用的时间属性一致（YYYY-MM-DD HH:MM:SS）", () => {
    expect(localNow(new Date("2026-01-02T03:04:05"))).toBe("2026-01-02 03:04:05");
  });
});
