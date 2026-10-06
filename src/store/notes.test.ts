// `patchPageMeta`：保存路径的**就地更新**语义。
//
// 背景（2026-09-25）：编辑器每停 600ms 就可能保存一次，而保存原本要 `loadPages()`
// **全量重拉**整张 page 表 —— 那是两次全量广播（`set(loading)` + `set(pages)`），
// 而 `pages` 的订阅者里既有「每个可见树节点一个」的 `TreeItem`，也有 `DatabaseView`
// / `FileManagerView` 这种千行组件。保存只可能改动 `PageMeta` 里的少数几个字段
// （标题 / `updated_at`），所以改成就地改那一条。
//
// 这里钉住三条不能退化的性质：
//   1. 真的变了 ⇒ 只换被改的那一条（其余条目引用不变，React 才能跳过）；
//   2. **一个字段都没变 ⇒ 连 `pages` 的引用都不换**（订阅者一次都不重渲染）——
//      这是这套改法唯一的性能承诺，写错了它，"就地更新"就退化成"每次都广播"；
//   3. 列表里没有这一条 ⇒ 返回 false，让调用方回退到 `loadPages()`（不许静默吞掉）。
import { beforeEach, describe, expect, it, vi } from "vitest";

// `loadPages` / `openPage` 会碰 `api`；这一组用例只需要"列表"和"取一页"两个方法。
// ⚠️ `vi.mock` 会被提升到 import 之前 ⇒ 用 `vi.hoisted` 拿桩函数（否则解析时是 undefined）。
const mocks = vi.hoisted(() => ({ listPages: vi.fn(), getPage: vi.fn() }));
vi.mock("../lib/api", () => ({ api: { listPages: mocks.listPages, getPage: mocks.getPage } }));

import { useNotes } from "./notes";
import { useViewStore } from "./view";
import type { PageMeta } from "../types";

const meta = (id: string, over: Partial<PageMeta> = {}): PageMeta => ({
  id,
  workspace_id: "ws1",
  parent_id: null,
  title: id,
  icon: "",
  kind: "page",
  sort_order: 0,
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
  ...over,
});

describe("notes store · patchPageMeta（保存路径的就地更新）", () => {
  beforeEach(() => {
    useNotes.setState({ pages: [meta("a"), meta("b", { title: "B" })], current: null });
  });

  it("就地更新标题与 updated_at，且只换被改的那一条", () => {
    const before = useNotes.getState().pages;

    useNotes.getState().patchPageMeta({ id: "a", title: "新标题", updated_at: 2000 });

    const after = useNotes.getState().pages;
    expect(after[0].title).toBe("新标题");
    expect(after[0].updated_at).toBe(2000);
    expect(after).not.toBe(before); // 列表本身换了引用
    expect(after[1]).toBe(before[1]); // 没动的那条引用不变 ⇒ React 能跳过它
  });

  it("一个字段都没变时**不换 pages 引用**（否则每次保存都是全量广播）", () => {
    const before = useNotes.getState().pages;

    // 同值：等价于"内容保存"（只改了正文，元数据一个字没动）
    expect(useNotes.getState().patchPageMeta({ id: "a", title: "a", updated_at: 1000 })).toBe(true);

    expect(useNotes.getState().pages).toBe(before);
  });

  it("列表里没有这一条 ⇒ 返回 false，且 state 一点没动（调用方要回退 loadPages）", () => {
    const before = useNotes.getState().pages;

    expect(useNotes.getState().patchPageMeta({ id: "不在列表里" })).toBe(false);

    expect(useNotes.getState().pages).toBe(before);
  });

  it("只合并 PageMeta 真的有的字段（正文不许泄进列表条目）", () => {
    // 调用方传的实际是 save_page 回来的整个 PageDetail
    const detail = { ...meta("a"), content_json: '{"root":1}', content_text: "正文" };

    useNotes.getState().patchPageMeta({ ...detail, title: "改过的标题" });

    const row = useNotes.getState().pages[0] as unknown as Record<string, unknown>;
    expect(row.title).toBe("改过的标题");
    expect("content_json" in row).toBe(false);
    expect("content_text" in row).toBe(false);
  });

  it("身份字段（id / workspace_id / created_at）不被一次保存改写", () => {
    useNotes
      .getState()
      .patchPageMeta({ id: "a", workspace_id: "别的空间", created_at: 999, title: "t" } as Partial<PageMeta> & { id: string });

    const row = useNotes.getState().pages[0];
    expect(row.workspace_id).toBe("ws1");
    expect(row.created_at).toBe(1000);
    expect(row.title).toBe("t");
  });

  it("移动（parent_id → null）与软删除（deleted_at）也在可改字段里", () => {
    useNotes.setState({ pages: [meta("a", { parent_id: "p", sort_order: 3 })] });

    useNotes.getState().patchPageMeta({ id: "a", parent_id: null, sort_order: 9, deleted_at: 555 });

    const row = useNotes.getState().pages[0];
    expect(row.parent_id).toBeNull();
    expect(row.sort_order).toBe(9);
    expect(row.deleted_at).toBe(555);
  });
});

// ── 「刷新之后还记得当前文档」────────────────────────────────────────────────────
// 2026-10-05 owner 实测报的：「页面刷新后，忘记了当前文档」。
// 存的是 localStorage（**这台设备的界面状态**，与本仓其它界面记忆一致），所以这里用真的
// localStorage + 桩 `api` 来钉四条：还原、失效不还原、**只还原一次**、打开即记住。
describe("notes store · 记住并还原当前文档", () => {
  const LIST = [meta("a"), meta("b"), meta("c")];

  beforeEach(() => {
    localStorage.clear();
    mocks.listPages.mockReset();
    mocks.getPage.mockReset();
    mocks.listPages.mockResolvedValue(LIST);
    mocks.getPage.mockImplementation(async (id: string) => ({ ...meta(id), content_json: "{}", content_text: "" }));
    useNotes.setState({ pages: [], currentId: null, current: null, lastPageRestored: false, startupSettled: false, error: null });
    useViewStore.setState({ view: "notes" });
  });

  it("★ 启动第一次加载：记住的那一页**还在列表里** ⇒ 直接打开它", async () => {
    localStorage.setItem("shuyonote:lastPageId", "b");

    await useNotes.getState().loadPages();

    expect(useNotes.getState().currentId).toBe("b");
    expect(mocks.getPage).toHaveBeenCalledWith("b");
  });

  it("★ 那一页已经不在列表里（删了 / 记住的是别的空间）⇒ **兜底打开第一页**（不留空白，也不报错）", async () => {
    // ⚠️ 2026-10-06 改口径：兜底从 `App.tsx` 那个 effect **搬进了这里**（见 `loadPages` 注释）——
    //    留在那边会让两个 `openPage` 赛跑、并把记忆改写成第一页 ✗。
    //    所以「记住的不在了」的**用户可见行为**仍然是「打开第一页」 ✓，只是决定权收口了 ✓。
    localStorage.setItem("shuyonote:lastPageId", "zzz");

    await useNotes.getState().loadPages();

    expect(useNotes.getState().currentId).toBe("a");
    expect(useNotes.getState().error).toBeNull();
    expect(mocks.getPage).toHaveBeenCalledWith("a");
  });

  it("★ 记住的那一页**优先于**兜底（不许被第一页顶掉）", async () => {
    localStorage.setItem("shuyonote:lastPageId", "c");

    await useNotes.getState().loadPages();

    expect(useNotes.getState().currentId).toBe("c");
    expect(mocks.getPage).not.toHaveBeenCalledWith("a");
    // 记住的仍是 c —— 兜底那次没把记忆改写掉 ✓（这就是用户报的"不能持久"的那条）
    expect(localStorage.getItem("shuyonote:lastPageId")).toBe("c");
  });

  it("★ 不在「笔记」视图时不兜底（去文件/看板/关系图不该被拽回页面）", async () => {
    useViewStore.setState({ view: "files" });

    await useNotes.getState().loadPages();

    expect(useNotes.getState().currentId).toBeNull();
    expect(mocks.getPage).not.toHaveBeenCalled();
  });

  it("★ `startupSettled`：首次加载前 false、落定后 true（组件那个兜底 effect 靠它让位）", async () => {
    localStorage.setItem("shuyonote:lastPageId", "b");
    expect(useNotes.getState().startupSettled).toBe(false);

    await useNotes.getState().loadPages();

    expect(useNotes.getState().startupSettled).toBe(true);
  });

  it("★ **只还原一次**：之后再 loadPages（选择被清空）不许把人拉回去", async () => {
    localStorage.setItem("shuyonote:lastPageId", "b");
    await useNotes.getState().loadPages();
    expect(useNotes.getState().currentId).toBe("b");

    useNotes.setState({ currentId: null, current: null }); // 例如刚把当前页删了
    await useNotes.getState().loadPages();

    expect(useNotes.getState().currentId).toBeNull();
  });

  it("★ 打开任何一页都会记住它（刷新之后要还原的就是这一页）", async () => {
    await useNotes.getState().openPage("c");

    expect(localStorage.getItem("shuyonote:lastPageId")).toBe("c");
  });
});
