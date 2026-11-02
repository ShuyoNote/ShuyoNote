// ⭐ 回归判据（2026-10-30）：跨空间 apply 传给命令的**空间参数键名**必须对。
//
// 背景：Tauri 的 `args` struct（SavePageArgs/SetPagePropArgs/CreatePageArgs/MovePageArgs）
// 字段是 **snake_case**；以前 apply 用驼峰 `spaceId` ⇒ serde 忽略 ⇒ 跨空间写实际落在当前空间。
// 命令的**平参数**（如 delete_page/remove_tag/restore_page）在 Tauri 里是 camelCase ⇒ 必须传 `spaceId`。
// 本文件逐一钉住这两类，防止回潮。
import { beforeEach, describe, expect, it, vi } from "vitest";

const DOC = JSON.stringify({
  root: { type: "root", children: [{ type: "paragraph", blockId: "b1", children: [{ type: "text", text: "正文" }] }] },
});

vi.mock("./api", () => ({
  api: {
    getPage: vi.fn(async () => ({ id: "p1", title: "页", kind: "page", content_json: DOC, content_text: "正文" })),
    savePage: vi.fn(async (a: Record<string, unknown>) => ({ id: a.id, title: "页", content_json: DOC })),
    movePage: vi.fn(async () => undefined),
    addTag: vi.fn(async () => ({ id: "t1", name: "x" })),
    removeTag: vi.fn(async () => undefined),
    listTags: vi.fn(async () => []),
    setPageProp: vi.fn(async () => undefined),
    removePageProp: vi.fn(async () => undefined),
    restorePage: vi.fn(async () => undefined),
    restoreVersion: vi.fn(async () => ({ id: "p1", title: "页", content_json: DOC })),
    createPage: vi.fn(async () => ({ id: "new-row", title: "行", content_json: DOC })),
    deletePage: vi.fn(async () => undefined),
    createFolder: vi.fn(async () => ({ id: "f1", title: "夹" })),
  },
}));

import { api } from "./api";
import { applyDraft } from "./ai/apply";

const TARGET = "s2";
const fn = (name: keyof typeof api) => api[name] as unknown as ReturnType<typeof vi.fn>;

function structArgCalls(): Array<Record<string, unknown>> {
  // 这些 API 的入参是 Rust 的 args struct ⇒ 空间键必须是 snake `space_id`
  const names = ["savePage", "setPageProp", "movePage", "createPage", "createFolder"] as const;
  const out: Array<Record<string, unknown>> = [];
  for (const n of names) for (const c of fn(n).mock.calls) out.push(c[0] as Record<string, unknown>);
  return out;
}

describe("跨空间 apply · space_id / spaceId 键名回归", () => {
  beforeEach(() => vi.clearAllMocks());

  it("A2：move_node ⇒ movePage 的 args.space_id；update_page ⇒ savePage 的 args.space_id", async () => {
    expect((await applyDraft({ kind: "move_node", id: "p2", newParentId: null, spaceId: TARGET })).ok).toBe(true);
    expect(fn("movePage").mock.calls[0][0].space_id).toBe(TARGET);
    expect((await applyDraft({ kind: "update_page", pageId: "p1", markdown: "新正文", spaceId: TARGET })).ok).toBe(true);
    expect(fn("savePage").mock.calls[0][0].space_id).toBe(TARGET);
  });

  it("A3：add_tag/remove_tag 平参数 spaceId；set/unset_page_prop 分别 args.space_id / 平参数 spaceId", async () => {
    expect((await applyDraft({ kind: "add_tag", pageId: "p1", name: "x", spaceId: TARGET })).ok).toBe(true);
    expect(fn("addTag").mock.calls[0]).toEqual(["p1", "x", TARGET]);
    expect((await applyDraft({ kind: "remove_tag", pageId: "p1", tagId: "t1", spaceId: TARGET })).ok).toBe(true);
    expect(fn("removeTag").mock.calls[0]).toEqual(["p1", "t1", TARGET]);
    expect(
      (await applyDraft({ kind: "set_page_prop", pageId: "p1", attrId: "a1", value: "1", spaceId: TARGET })).ok,
    ).toBe(true);
    expect(fn("setPageProp").mock.calls[0][0].space_id).toBe(TARGET);
    expect((await applyDraft({ kind: "unset_page_prop", pageId: "p1", attrId: "a1", spaceId: TARGET })).ok).toBe(true);
    expect(fn("removePageProp").mock.calls[0]).toEqual(["p1", "a1", TARGET]);
    // 回读也必须带目标空间
    expect(fn("getPage").mock.calls.every((c) => c[1] === TARGET)).toBe(true);
  });

  it("A4：restore_page/revert_page/db_rows_delete 平参数 spaceId；db_rows_write 的 createPage args.space_id", async () => {
    expect((await applyDraft({ kind: "restore_page", id: "p1", spaceId: TARGET })).ok).toBe(true);
    expect(fn("restorePage").mock.calls[0]).toEqual(["p1", TARGET]);
    expect(
      (await applyDraft({ kind: "revert_page", pageId: "p1", versionId: "v1", spaceId: TARGET })).ok,
    ).toBe(true);
    expect(fn("restoreVersion").mock.calls[0]).toEqual(["v1", TARGET]);
    expect(
      (
        await applyDraft({
          kind: "db_rows_write",
          pageId: "db1",
          rows: [{ title: "行", values: {} }],
          spaceId: TARGET,
        })
      ).ok,
    ).toBe(true);
    expect(fn("createPage").mock.calls[0][0].space_id).toBe(TARGET);
    expect(
      (await applyDraft({ kind: "db_rows_delete", pageId: "db1", rowIds: ["r1"], spaceId: TARGET })).ok,
    ).toBe(true);
    expect(fn("deletePage").mock.calls[0]).toEqual(["r1", TARGET]);
  });

  it("负向：args-struct 的调用里**不许**出现驼峰 spaceId（防止回潮）", async () => {
    await applyDraft({ kind: "move_node", id: "p2", newParentId: null, spaceId: TARGET });
    await applyDraft({ kind: "update_page", pageId: "p1", markdown: "x", spaceId: TARGET });
    await applyDraft({ kind: "set_page_prop", pageId: "p1", attrId: "a1", value: "1", spaceId: TARGET });
    await applyDraft({ kind: "db_rows_write", pageId: "db1", rows: [{ title: "行", values: {} }], spaceId: TARGET });
    for (const args of structArgCalls()) {
      expect(args).not.toHaveProperty("spaceId");
      expect(args.space_id).toBe(TARGET);
    }
  });
});
