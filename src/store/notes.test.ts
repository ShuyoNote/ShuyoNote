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
import { beforeEach, describe, expect, it } from "vitest";
import { useNotes } from "./notes";
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
